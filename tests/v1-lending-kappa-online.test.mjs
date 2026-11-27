import './helpers/no-browser.mjs';
import {tempDir} from './helpers/temp-dir.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {certifiedKappa,createRealPace50Source} from './helpers/real-source.mjs';
import {createLendingLedger} from '../lib/v1/lending-ledger.mjs';
import {createLendingProbe, createLendingReadings} from '../lib/v1/lending-probe.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {initialObservationFixture} from './helpers/initial-observation-fixture.mjs';

test('initial admission controls: busy with missing evidence cannot authorize a launch', async t=>{
  const f=await initialObservationFixture(t,{busy:true});
  const observed=await f.candidate.refreshObservation(f.args);
  assert.equal(observed.refresh_succeeded,false);
  assert.equal(observed.probe?.reason,'account_busy');
  assert.equal(f.runs(),0,'busy guard runs before any guest probe');
  const reserved=await f.reserve();
  assert.equal(reserved.ok,false);
  assert.equal(f.candidate.registry.entry('initial').authorized,false);
  assert.equal(f.adapter.state().attempts.length,0);
});

test('initial admission controls: cached evidence aged past headroom cannot authorize a launch while busy', async t=>{
  const f=await initialObservationFixture(t,{utilization:95});
  const original=await f.candidate.observe(f.args);
  assert.equal(original.refresh_succeeded,true);
  assert.equal((await f.preview()).admitted,true,
    'the same quota fits while fresh; only plausible unseen spend makes it short');
  f.advance(16*60000);
  f.busy(true);
  const observed=await f.candidate.refreshObservation(f.args);
  assert.equal(observed.refresh_succeeded,false);
  assert.equal(observed.probe?.reason,'account_busy');
  const reserved=await f.reserve();
  assert.equal(reserved.ok,false);
  assert.notEqual(reserved.policyReason,'refresh_failed');
  assert.equal(f.runs(),1,'no guest retry while busy');
  assert.equal(f.candidate.registry.entry('initial').authorized,false);
  assert.equal(f.adapter.state().attempts.length,0);
});

test('initial admission controls: fresh exhausted quota is not a refresh failure', async t=>{
  const f=await initialObservationFixture(t,{utilization:100});
  const observed=await f.candidate.refreshObservation(f.args);
  assert.equal(observed.refresh_succeeded,true);
  assert.equal(observed.complete,true);
  assert.ok(observed.resources.some(r=>r.used_micro===100e6));
  assert.notEqual(observed.probe?.reason,'account_busy');
  const reserved=await f.reserve();
  assert.equal(reserved.ok,false);
  assert.notEqual(reserved.reason,'refresh_failed');
  assert.equal(f.runs(),1);
  assert.equal(f.candidate.registry.entry('initial').authorized,false);
});

test('initial admission controls: healthy fresh original evidence admits without another probe', async t=>{
  const f=await initialObservationFixture(t);
  const observed=await f.candidate.observe(f.args);
  assert.equal(observed.refresh_succeeded,true);
  assert.equal(observed.complete,true);
  const reserved=await f.reserve();
  assert.equal(reserved.ok,true);
  assert.equal(f.runs(),1);
  assert.equal(f.candidate.registry.entry('initial').authorized,true);
  assert.ok(f.adapter.state().attempts[0].resources.every(r=>r.held_micro>0));
});

test('98% weekly usage keeps real reserve math held through the short reset, then previews at the weekly reset', async t=>{
  const now=Date.parse('2026-10-30T00:00:00Z');
  const weeklyReset=Date.parse('2026-10-31T07:00:00Z');
  const shortReset=Date.parse('2026-10-30T01:30:00Z');
  const f=await initialObservationFixture(t,{startAt:now,weeklyResetAt:weeklyReset,shortResetAt:shortReset,
    weeklyUtilization:98,shortUtilization:4,maxJobUsd:2,
    kappaForUsage:({provider,window,model})=>({...certifiedKappa({provider,plan:'max20',window,model}),
      binding:{account_sha256_16:'1111222233334444'}})});
  await f.candidate.observe(f.args); // The background path populates admission's cache.
  const held=await f.reserve();
  assert.equal(held.ok,false,JSON.stringify(held));
  assert.notEqual(held.policyReason,'refresh_failed');
  assert.equal(f.runs(),1);
  assert.equal(f.adapter.state().attempts.length,0,'a held quote creates no durable reservation');
  assert.equal(f.candidate.registry.entry('initial').authorized,false,'a held quote cannot start a job');

  f.advance(shortReset-f.time()+1000);
  f.rollShortWindow();
  await f.candidate.observe(f.args);
  const stillHeld=await f.reserve();
  assert.equal(stillHeld.ok,false,JSON.stringify(stillHeld));
  assert.notEqual(stillHeld.policyReason,'refresh_failed');
  assert.notEqual(stillHeld.policyReason,'resource_reset_margin','the short window has reset and the job fits before its new reset');
  assert.equal(f.runs(),2);
  assert.equal(f.adapter.state().attempts.length,0,'the earlier five-hour reset does not release weekly capacity');

  f.advance(weeklyReset-f.time()+1000);
  f.rollWeeklyWindow();
  f.rollShortWindow();
  await f.candidate.observe(f.args);
  const afterWeeklyReset=await f.preview();
  assert.equal(afterWeeklyReset.admitted,true,JSON.stringify(afterWeeklyReset.reason));
  assert.equal(f.runs(),3,'the weekly window is checked again before previewing capacity');
  assert.equal(f.adapter.state().attempts.length,0,'the post-reset preview does not reserve or charge a launch');
});

test('initial admission diagnostics: sanitized HTTP failure reason and class reach the reading boundary', async t=>{
  const f=await initialObservationFixture(t,{status:503});
  const direct=await f.probe.probe('claude');
  assert.deepEqual(direct,{ok:false,reason:'provider_error',status_class:'5xx',usage_status:503});
  const reading=await f.readings('claude',{forceRefresh:true});
  assert.deepEqual(reading.probe,{reason:'provider_error',status_class:'5xx',provider:'claude',failure_class:'usage_http_503'});
  assert.equal(reading.refresh_succeeded,false);
  const observed=await f.candidate.refreshObservation(f.args);
  assert.equal(observed.refresh_succeeded,false);
  assert.notEqual(observed.probe?.reason,'account_busy');
  assert.equal(observed.probe?.reason,'provider_error');
  assert.equal(observed.probe?.status_class,'5xx');
  const reserved=await f.reserve();
  assert.equal(reserved.ok,false);
  assert.equal(f.candidate.registry.entry('initial').authorized,false);
});

// Real durable candidate + live re-check; only provider readings and owner evidence are synthetic.
test('3x rate: first chunk admitted at estimate, live recheck stops repriced remainder before protected share', async t => {
  const now=Date.UTC(2026,9,28), directory=tempDir('kappa-online-');
  const source=createSyntheticPace50Source({start:now,used:{weekly:80e6,short:0},kappa:{weekly:73200,short:436400}});
  const original=source.objectiveInputFor;
  source.objectiveInputFor=args=>{
    const out=original(args);out.band.forecasts=out.band.forecasts.map(w=>({...w,prediction:15}));return out;
  };
  const opened=createPace50Candidate({directory,account:'synthetic-account',account_week_id:'synthetic-week-1',
    source,now:()=>now,contextFor:()=>({consent:true,ownerAbsent:true})});
  t.after(()=>opened.adapter.close());
  const {candidate}=opened;const {registry}=candidate;const stops=[];
  registry.bind('job',{stop:reason=>stops.push(reason)});
  const out=await candidate.reserve({attemptId:'job',jobId:'job',provider:'claude',model:'claude-haiku-5-5',ownerAbsent:true,
    job:{budget_v1:{max_list_usd:20},requirements:{limits:{wall_seconds:60}},expires_at:new Date(now+3600000).toISOString()}});
  assert.equal(out.ok,true,JSON.stringify(out));
  const before=opened.adapter.state().attempts[0];
  assert.equal(before.resources.find(w=>w.id==='seven_day').kappa_micro,73200);
  const usd=14;
  source.state.used.weekly+=Math.round(usd*.0732*3*1e6);
  source.state.used.short+=Math.round(usd*.4364*3*1e6);
  const check=registry.entry('job').liveCheck;
  const uncorrected=await opened.adapter.preview({request:{...check.request,requested_usd_micro:6e6},
    context:check.context,replacingAttemptId:'job'});
  assert.equal(uncorrected.admitted,true,'without correction the estimated remainder still fits');
  const checked=await candidate.recheck({attemptId:'job',usd});
  assert.equal(checked.admitted,false,JSON.stringify(checked));
  assert.deepEqual(stops,['provider_limit']);
  assert.ok(source.state.used.weekly < 85e6,'15 owner points remain when the live recheck stops');
  assert.ok(opened.adapter.state().attempts[0].resources[0].held_micro >= before.resources[0].held_micro,
    'the durable reservation is enlarged, never released by the replacement quote');
  const next=await candidate.preview({jobId:'next',provider:'claude',model:'claude-haiku-5-5',ownerAbsent:true,
    job:{budget_v1:{max_list_usd:20},requirements:{limits:{wall_seconds:60}},expires_at:new Date(now+3600000).toISOString()}});
  assert.equal(next.admitted,false,'a new quote still accounts for the outstanding reservation');
  console.log('scratch',directory);
});

test('while the account is busy, the guard\'s live meter still stops a job that used its whole reservation', async t => {
  const now=Date.UTC(2026,9,29), directory=mkdtempSync(join(tmpdir(),'kappa-live-stop-'));
  let running=false, guestRuns=0;
  const ledger=createLendingLedger({file:join(directory,'ledger.json'),now:()=>now});
  const probe=createLendingProbe({ledger,now:()=>now,runGuest:async()=>{
    guestRuns++;
    return {stdout:JSON.stringify({faravan_probe:1,status:200,body:{five_hour:{utilization:20,resets_at:now+5*3600000},
      seven_day:{utilization:20,resets_at:now+7*86400000},extra_usage:{is_enabled:false}},
      identity:{status:200,account_sha256_16:'1111222233334444',email_sha256_16:'aaaa0000bbbb1111'},
      guest_auth:{loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}}),
      executor:{backend_id:'docker-sbx',sbx_version:'sbx version v0.49.2'},
      stop:{delivered:true,fallback:null,latency_ms:1,removed:true}};
  }});
  const readings=createLendingReadings({ledger,probe,plans:()=>({claude:'max20'}),jobRunning:()=>running,now:()=>now});
  const source=createRealPace50Source({readings,funding:provider=>probe.funding(provider),
    expectedIdentity:()=>({email_sha256_16:'aaaa0000bbbb1111'}),
    expectedExecutor:{backend_id:'docker-sbx',accepts:()=>true},stopBoundMs:35_000,
    windowOrigin:()=>new Map([['seven_day','owner'],['five_hour','owner']]),
    kappaForUsage:()=>({upper_micro:100000,binding:{account_sha256_16:'1111222233334444'},provenance:{method:'fixture'}})});
  const weekId=`1111222233334444:weekly:${now+7*86400000}`;
  const objective=createSyntheticPace50Source({start:now,used:{weekly:20e6,short:20e6},kappa:{weekly:100000,short:100000}});
  source.objectiveInputFor=objective.objectiveInputFor;
  const opened=createPace50Candidate({directory,account:'1111222233334444',account_week_id:weekId,source,now:()=>now,
    contextFor:()=>({consent:true,ownerAbsent:true,plan:'max20'})});
  t.after(async()=>{await opened.adapter.close();await probe.close();rmSync(directory,{recursive:true,force:true});});
  const {candidate,adapter}=opened, registry=candidate.registry, stops=[];
  registry.bind('job',{stop:reason=>stops.push(reason)});
  const job={budget_v1:{max_list_usd:10},requirements:{limits:{wall_seconds:60}},expires_at:new Date(now+3600000).toISOString()};
  await candidate.observe({provider:'claude',model:'claude-haiku-5-5',plan:'max20'});
  const reserved=await candidate.reserve({attemptId:'job',jobId:'job',provider:'claude',model:'claude-haiku-5-5',ownerAbsent:true,job});
  assert.equal(reserved.ok,true,JSON.stringify(reserved));
  await candidate.started('job',{ok:true});
  running=true;
  const [weekly]=adapter.state().attempts[0].resources;
  const pct=micro=>micro/1e6;
  const under=await candidate.recheck({attemptId:'job',usd:1,
    windows:[{window_id:weekly.id,used_pct:pct(weekly.baseline_used_micro+weekly.initial_micro-1000)}]});
  assert.deepEqual(under,{deferred:true,reason:'account_busy'},'below the reservation the busy recheck still only defers');
  assert.deepEqual(stops,[]);
  const over=await candidate.recheck({attemptId:'job',usd:1,
    windows:[{window_id:weekly.id,used_pct:pct(weekly.baseline_used_micro+weekly.initial_micro)}]});
  assert.deepEqual(over,{admitted:false,reason:'live_meter_reservation_spent'});
  assert.deepEqual(stops,['provider_limit']);
});

test('self-busy refresh defers meter feedback without stopping the live job or changing its hold', async t => {
  const now=Date.UTC(2026,9,29), directory=mkdtempSync(join(tmpdir(),'kappa-self-busy-'));
  let running=false, guestRuns=0;
  const ledger=createLendingLedger({file:join(directory,'ledger.json'),now:()=>now});
  const probe=createLendingProbe({ledger,now:()=>now,runGuest:async()=>{
    guestRuns++;
    return {stdout:JSON.stringify({faravan_probe:1,status:200,body:{five_hour:{utilization:20,resets_at:now+5*3600000},
      seven_day:{utilization:20,resets_at:now+7*86400000},extra_usage:{is_enabled:false}},
      identity:{status:200,account_sha256_16:'1111222233334444',email_sha256_16:'aaaa0000bbbb1111'},
      guest_auth:{loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}}),
      executor:{backend_id:'docker-sbx',sbx_version:'sbx version v0.49.2'},
      stop:{delivered:true,fallback:null,latency_ms:1,removed:true}};
  }});
  const readings=createLendingReadings({ledger,probe,plans:()=>({claude:'max20'}),jobRunning:()=>running,now:()=>now});
  const source=createRealPace50Source({readings,funding:provider=>probe.funding(provider),
    expectedIdentity:()=>({email_sha256_16:'aaaa0000bbbb1111'}),
    expectedExecutor:{backend_id:'docker-sbx',accepts:()=>true},stopBoundMs:35_000,
    windowOrigin:()=>new Map([['seven_day','owner'],['five_hour','owner']]),
    kappaForUsage:()=>({upper_micro:100000,binding:{account_sha256_16:'1111222233334444'},provenance:{method:'fixture'}})});
  const weekId=`1111222233334444:weekly:${now+7*86400000}`;
  const objective=createSyntheticPace50Source({start:now,used:{weekly:20e6,short:20e6},kappa:{weekly:100000,short:100000}});
  source.objectiveInputFor=objective.objectiveInputFor;
  const opened=createPace50Candidate({directory,account:'1111222233334444',account_week_id:weekId,source,now:()=>now,
    contextFor:()=>({consent:true,ownerAbsent:true,plan:'max20'})});
  t.after(async()=>{await opened.adapter.close();await probe.close();rmSync(directory,{recursive:true,force:true});});
  const {candidate,adapter}=opened, registry=candidate.registry, stops=[];
  registry.bind('job',{stop:reason=>stops.push(reason)});
  const job={budget_v1:{max_list_usd:10},requirements:{limits:{wall_seconds:60}},expires_at:new Date(now+3600000).toISOString()};
  await candidate.observe({provider:'claude',model:'claude-haiku-5-5',plan:'max20'});
  const reserved=await candidate.reserve({attemptId:'job',jobId:'job',provider:'claude',model:'claude-haiku-5-5',ownerAbsent:true,job});
  assert.equal(reserved.ok,true,JSON.stringify(reserved));
  await candidate.started('job',{ok:true});
  const hold=adapter.state().attempts[0].resources.map(r=>r.held_micro);
  const snapshotArgs={provider:'claude',model:'claude-haiku-5-5',plan:'max20'};
  await candidate.observe(snapshotArgs);
  const prior=candidate.observeSnapshot(snapshotArgs);
  assert.ok(prior?.refresh_succeeded && prior.observed_at,JSON.stringify(prior));
  running=true;
  const checked=await candidate.recheck({attemptId:'job',usd:1});
  assert.deepEqual(stops,[],'a self-busy refresh alone must not stop the existing job');
  assert.deepEqual(checked,{deferred:true,reason:'account_busy'});
  assert.equal(guestRuns,1,'the busy recheck does not launch a second guest probe');
  // The admitted job keeps running. The cached status now shows the busy deferral, not the last good reading; admission still reads the ledger.
  assert.equal(candidate.observeSnapshot(snapshotArgs).refresh_outcome,'deferred','a busy response leaves the deferral, not the old reading');
  assert.deepEqual(adapter.state().attempts[0].resources.map(r=>r.held_micro),hold);
  assert.notEqual(adapter.state().rate_feedback?.blocked,true);
  const originalExposure=registry.entry('job').liveCheck.exposure;
  running=false;
  const rounded=await candidate.recheck({attemptId:'job',usd:1});
  assert.deepEqual(rounded,{deferred:true,reason:'meter_coverage_pending'},
    'a fresh rounded-flat reading also waits without turning missing movement into safer quota');
  assert.deepEqual(stops,[]);
  assert.equal(guestRuns,2,'the second attempt uses a genuinely fresh probe');
  assert.equal(registry.entry('job').liveCheck.exposure,originalExposure,'deferred checks do not replenish the original CLI cap');
  assert.deepEqual(adapter.state().attempts[0].resources.map(r=>r.held_micro),hold,
    'deferred readings retain the full original liability');
  assert.notEqual(adapter.state().rate_feedback?.blocked,true);
});

for (const mode of ['funding_changed','new_exhausted_resource']) {
  test(`fresh ${mode} stops the job even when original windows are flat`, async t => {
    const now=Date.UTC(2026,9,29),directory=mkdtempSync(join(tmpdir(),'fresh-policy-'));
    let changed=false;
    const source=createSyntheticPace50Source({start:now,used:{weekly:20e6,short:20e6},kappa:{weekly:100000,short:100000},
      override:({base})=>{
        if(!changed)return base;
        if(mode==='funding_changed')return {...base,funding:{subscription_only:'unknown',reason:'extra_usage_enabled'}};
        return {...base,resources:[...base.resources,{...base.resources[1],id:'seven_day_sonnet',instance:'new-model-window',used_micro:100e6,owner_used_micro:100e6}]};
      }});
    const {candidate,adapter}=createPace50Candidate({directory,account:'synthetic-account',account_week_id:'synthetic-week-1',source,now:()=>now,
      contextFor:()=>({consent:true,ownerAbsent:true})});
    t.after(async()=>{await adapter.close();rmSync(directory,{recursive:true,force:true});});
    const stops=[];
    candidate.registry.bind('job',{stop:reason=>stops.push(reason)});
    const reserved=await candidate.reserve({attemptId:'job',jobId:'job',provider:'claude',model:'claude-haiku-5-5',ownerAbsent:true,
      job:{budget_v1:{max_list_usd:10},requirements:{limits:{wall_seconds:60}},expires_at:new Date(now+3600000).toISOString()}});
    assert.equal(reserved.ok,true,JSON.stringify(reserved));
    await candidate.started('job',{ok:true});
    const held=adapter.state().attempts[0].resources.map(row=>row.held_micro);
    changed=true;
    const checked=await candidate.recheck({attemptId:'job',usd:1});
    assert.equal(checked.admitted,false);
    assert.deepEqual(stops,['provider_limit'],'fresh refusal evidence must not be suppressed by rounded usage');
    assert.deepEqual(adapter.state().attempts[0].resources.map(row=>row.held_micro),held,'refusal retains unresolved liabilities');
  });
}

async function safetyFixture(t,{directory=tempDir('kappa-r2-'),source=null}={}) {
 const now=Date.UTC(2026,9,28);
 source??=createSyntheticPace50Source({start:now,used:{weekly:80e6,short:0},kappa:{weekly:100000,short:100000}});
 const original=source.objectiveInputFor;
 source.objectiveInputFor=args=>{const out=original(args);out.band.forecasts=out.band.forecasts.map(w=>({...w,prediction:15}));return out;};
 const {createLendingRuntime}=await import('../lib/v1/lending-runtime.mjs');
 const runtime=createLendingRuntime({directory,now:()=>now,settings:()=>({limits:{lendingPolicy:{}}}),
   pace50:{account:'synthetic-account',account_week_id:'synthetic-week-1',source,contextFor:()=>({consent:true,ownerAbsent:true})}});
 t.after(()=>runtime.close());
 const stops=[];runtime.candidate.registry.bind('job',{stop:why=>stops.push(why)});
 const job={budget_v1:{max_list_usd:10},requirements:{limits:{wall_seconds:60}},expires_at:new Date(now+3600000).toISOString()};
 const reserve=()=>runtime.candidate.reserve({attemptId:'job',jobId:'job',provider:'claude',model:'claude-haiku-5-5',ownerAbsent:true,job});
 return {runtime,source,stops,reserve,now,job,directory};
}

test('delayed meter-only event at unchanged spend is rechecked and pending events are coalesced',async t=>{
 const f=await safetyFixture(t);assert.equal((await f.reserve()).ok,true);
 const observe=f.source.observe;let release,entered;const ready=new Promise(r=>entered=r);
 const gate=new Promise(r=>release=r);let reads=0;
 f.source.observe=async args=>{const snapshot=await observe(args);reads++;if(reads===1){entered();await gate;}return snapshot;};
 const first=f.runtime.candidate.recheck({attemptId:'job',usd:10});await ready;
 f.source.state.used.weekly+=3e6;f.source.state.used.short+=3e6;
 const second=f.runtime.candidate.recheck({attemptId:'job',usd:10});release();
 await Promise.all([first,second]);
 assert.ok(reads>=2,'a pending meter event must trigger another fresh read at unchanged spend');
 const resource=f.runtime.pace50.state().attempts[0].resources[0];
 assert.equal(resource.kappa_micro,300000,'the delayed 3x rate must be durable');
});

test('burst-before-refresh stops at covering feedback and freezes every outstanding runtime liability',async t=>{
 const f=await safetyFixture(t);assert.equal((await f.reserve()).ok,true);
 await f.runtime.candidate.started('job',{ok:true});
 const other=await f.runtime.candidate.reserve({attemptId:'other',jobId:'other',provider:'claude',model:'claude-haiku-5-5',ownerAbsent:true,job:f.job});
 assert.equal(other.ok,true,JSON.stringify(other));
 f.runtime.candidate.registry.bind('other',{stop:why=>f.stops.push(why)});
 f.source.state.used.weekly+=1.5e6;f.source.state.used.short+=1.5e6;
 await f.runtime.candidate.recheck({attemptId:'job',usd:5});
 const state=f.runtime.pace50.state();
 assert.equal(state.rate_feedback?.blocked,true);
 assert.ok(state.attempts.every(a=>a.resources.every(r=>r.held_micro===3e6)),'ALL holds, including the running budget, reprice 1 to 3');
 assert.ok(f.source.state.used.weekly<85e6,'the observed burst stops before the 15 protected owner points');
 assert.equal(f.stops.length,2,'both affected jobs are stopped with $5 still authorized on the running job');
 assert.ok(f.source.state.used.weekly+(5+10)*.3e6>85e6,
   'without Stop, the remaining running budget plus the other authorization crosses the protected share');
 const next=await f.runtime.previewAdmission({provider:'claude',model:'claude-haiku-5-5',job:f.job},{ownerAbsent:true});
 assert.equal(next.admitted,false,'retained runtime liabilities block a real runtime admission');
});

test('crash/retry retains the observed rate and freeze until covering evidence reconciles the hold',async t=>{
 const f=await safetyFixture(t);assert.equal((await f.reserve()).ok,true);await f.runtime.candidate.started('job',{ok:true});
 f.source.state.used.weekly+=3e6;f.source.state.used.short+=3e6;
 await f.runtime.candidate.recheck({attemptId:'job',usd:10});
 const before=f.runtime.pace50.state();await f.runtime.close();
 const reopened=await safetyFixture(t,{directory:f.directory,source:f.source});
 const state=reopened.runtime.pace50.state();
 assert.equal(state.rate_feedback?.blocked,true);
 assert.equal(state.attempts[0].resources[0].held_micro,3e6);
 const observed=await reopened.runtime.candidate.observe({provider:'claude',model:'claude-haiku-5-5',now:f.now});
 assert.equal(observed.resources[0].kappa_micro,300000,'restart must not revert the source to its old estimate');
 const event=state.event_ids.find(id=>id.includes('meter-feedback'));
 const retried=await reopened.runtime.pace50.deliver({type:'meter_feedback',event_id:event,at:f.now});
 assert.equal(retried.reason,'duplicate_event');
 assert.deepEqual(reopened.runtime.pace50.state(),before,'duplicate recovery cannot double-reprice or release the hold');
 const next=await reopened.runtime.previewAdmission({provider:'claude',model:'claude-haiku-5-5',job:f.job},{ownerAbsent:true});
 assert.equal(next.admitted,false);
 const cleared=await reopened.runtime.pace50.deliver({type:'meter_feedback_covered',event_id:'premature',at:f.now,observed_at:f.now,complete:true,refresh_succeeded:true,resources:[]});
 assert.equal(cleared.applied,false,'a fresh receipt alone cannot clear an unreconciled liability');
});

test('feedback fence is raised before Stop effects finish, and no admission can race the enlarged hold',async t=>{
 const f=await safetyFixture(t);assert.equal((await f.reserve()).ok,true);
 f.source.state.used.weekly+=3e6;f.source.state.used.short+=3e6;
 let release,entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 f.runtime.candidate.registry.bind('job',{stop:async()=>{entered();await gate;}});
 const checking=f.runtime.candidate.recheck({attemptId:'job',usd:10});await ready;
 assert.equal(f.runtime.pace50.state().attempts[0].resources[0].held_micro,3e6,'repricing persists before any Stop effect can finish');
 const next=await f.runtime.candidate.reserve({attemptId:'race',jobId:'race',provider:'claude',model:'claude-haiku-5-5',ownerAbsent:true,job:f.job});
 assert.equal(next.ok,false);release();await checking;
 assert.equal(f.runtime.pace50.state().attempts.length,1);
});

test('aggregate growth records spend but leaves exposure and its feedback fence unresolved',async t=>{
 const f=await safetyFixture(t);assert.equal((await f.reserve()).ok,true);await f.runtime.candidate.started('job',{ok:true});
 const originalHold=f.runtime.pace50.state().attempts[0].resources[0].held_micro;
 const pending=await f.runtime.candidate.recheck({attemptId:'job',usd:1});
 assert.equal(pending.deferred,true,'newly stamped zero movement is not usage coverage');
 assert.notEqual(f.runtime.pace50.state().rate_feedback?.blocked,true,'flat data alone does not create a feedback freeze');
 assert.equal(f.runtime.pace50.state().attempts[0].resources[0].held_micro,originalHold,
   'pending evidence keeps the full original liability');
 f.source.state.used.weekly+=3e6;f.source.state.used.short+=3e6;
 await f.runtime.candidate.recheck({attemptId:'job',usd:10});
 assert.equal(f.runtime.pace50.state().rate_feedback.blocked,true,'a fresh 3x rate surprise still creates the feedback fence');
 await f.runtime.candidate.refreshObservation({provider:'claude',model:'claude-haiku-5-5',now:f.now});
 assert.equal(f.runtime.pace50.state().rate_feedback.blocked,true,'positive quota receipt still cannot release unreconciled held exposure');
 await f.runtime.candidate.recordCleanup('job',{removed:true});
 const settled=await f.runtime.candidate.finish({attemptId:'job',provider:'claude',model:'claude-haiku-5-5',
   execution:{stdout:'',lending_meter:{model:'claude-haiku-5-5',final:true,cost_usd:10,tokens:{}}}});
 assert.equal(settled.cessation.applied,false,JSON.stringify(settled));
 assert.equal(settled.cessation.reason,'usage_unreconciled');
 const spent=f.runtime.pace50.state().attempts[0].resources[0].spent_micro;
 assert.equal(spent,3e6,'the enlarged budget can settle the observed burn without rejecting usage above the original hold');
 const unsettled=f.runtime.pace50.state().attempts[0];
 assert.equal(unsettled.hold_closed,false);
 assert.equal(unsettled.resources[0].unrepresented_micro,spent);
 assert.equal(unsettled.resources[0].held_micro+unsettled.resources[0].unrepresented_micro,
   unsettled.resources[0].initial_micro,'the unresolved envelope remains in admission accounting');
 assert.equal(unsettled.resources[0].released_micro,0);
 await f.runtime.candidate.refreshObservation({provider:'claude',model:'claude-haiku-5-5',now:f.now});
 assert.equal(f.runtime.pace50.state().rate_feedback.blocked,true,'an aggregate receipt cannot clear the unresolved liability fence');
 const observed=await f.runtime.candidate.observe({provider:'claude',model:'claude-haiku-5-5',now:f.now});
 assert.equal(observed.resources[0].kappa_micro,300000);
 assert.equal(f.runtime.pace50.state().attempts[0].resources[0].spent_micro,spent,'meter feedback never changes recorded spend');
 const renewed=await f.runtime.candidate.reserve({attemptId:'after-coverage',jobId:'after-coverage',provider:'claude',
   model:'claude-haiku-5-5',ownerAbsent:true,job:{...f.job,budget_v1:{max_list_usd:2}}});
 assert.equal(renewed.ok,false,'a follow-up request remains blocked while quota attribution is unresolved');
 assert.equal(f.runtime.pace50.state().attempts.length,1,'a blocked request creates no reservation');
});

test('unavailable quota freezes aggregate blind exposure durably instead of renewing the old budget',async t=>{
 const f=await safetyFixture(t);assert.equal((await f.reserve()).ok,true);
 const observe=f.source.observe;
 f.source.observe=async()=>{throw new Error('quota temporarily unavailable');};
 const out=await f.runtime.candidate.recheck({attemptId:'job',usd:1});
 assert.equal(out.admitted,false);
 assert.equal(f.runtime.pace50.state().rate_feedback.blocked,true);
 assert.equal(f.runtime.pace50.state().attempts[0].resources[0].held_micro,1e6,'unknown feedback never releases an existing hold');
 assert.deepEqual(f.stops,['provider_limit']);
 f.source.observe=observe;f.source.state.used.weekly+=3e6;f.source.state.used.short+=3e6;
 await f.runtime.candidate.recheck({attemptId:'job',usd:10});
 f.source.observe=async()=>{throw new Error('quota temporarily unavailable');};
 await f.runtime.candidate.recheck({attemptId:'job',usd:10});
 const rate=f.runtime.pace50.state().rate_feedback.rates.find(r=>r.id==='seven_day');
 assert.equal(rate.used_micro,83e6,'unavailable feedback cannot lower the known quota watermark');
 assert.equal(rate.kappa_micro,300000);
});

test('unrepresented burns retain their debits and their native exposure is included in the enlarged hold',async t=>{
 const f=await safetyFixture(t);assert.equal((await f.reserve()).ok,true);await f.runtime.candidate.started('job',{ok:true});
 const state=f.runtime.pace50.state(), attempt=state.attempts[0];
 const burn=await f.runtime.pace50.deliver({type:'usage',event_id:'partial',at:f.now,attempt_id:'job',burn_id:'partial',
   resources:attempt.resources.map(r=>({id:r.id,instance:r.instance,amount_micro:200000}))});
 assert.equal(burn.applied,true);
 f.source.state.used.weekly+=1.5e6;f.source.state.used.short+=1.5e6;
 await f.runtime.candidate.recheck({attemptId:'job',usd:5});
 const r=f.runtime.pace50.state().attempts[0].resources[0];
 assert.equal(r.spent_micro,200000,'a pending debit is not retroactively relabelled measured');
 assert.equal(r.burns[0].amount_micro,200000);
 assert.equal(r.unrepresented_micro,200000);
 assert.equal(r.held_micro,2800000,'0.8 held + 0.2 unrepresented at 3x needs 3 points total liability');
 assert.equal(r.initial_micro,3e6);
});

test('repriced debt beyond quota capacity remains durable rather than clipped or dropped',async t=>{
 const f=await safetyFixture(t);assert.equal((await f.reserve()).ok,true);
 f.source.state.used.weekly+=3e6;f.source.state.used.short+=3e6;
 await f.runtime.candidate.recheck({attemptId:'job',usd:.1});
 const before=f.runtime.pace50.state();
 assert.equal(before.rate_feedback.blocked,true);
 assert.equal(before.attempts[0].resources[0].held_micro,300e6);
 await f.runtime.close();
 const reopened=await safetyFixture(t,{directory:f.directory,source:f.source});
 assert.equal(reopened.runtime.pace50.state().attempts[0].resources[0].held_micro,300e6,
   'an account that cannot cover its debt must remain readable and frozen after restart');
});
