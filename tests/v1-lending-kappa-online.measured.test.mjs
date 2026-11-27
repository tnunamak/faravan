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

// Real durable candidate + live re-check; only provider readings and owner evidence are synthetic.
test('3x rate: first chunk admitted at estimate, live recheck stops repriced remainder before protected share', async t => {
  const now=Date.UTC(2026,9,28), directory=tempDir('kappa-online-');
  const source=createSyntheticPace50Source({start:now,used:{weekly:80e6,short:0},kappa:{weekly:73200,short:436400}});
  const original=source.objectiveInputFor;
  source.objectiveInputFor=args=>{
    const out=original(args);out.band.forecasts=out.band.forecasts.map(w=>({...w,prediction:15}));return out;
  };
  const opened=createPace50Candidate({postingLagBoundMs:120000,directory,account:'synthetic-account',account_week_id:'synthetic-week-1',
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
    expectedExecutor:{backend_id:'docker-sbx',accepts:()=>true},stopBoundMs:1000,stopAnswerMs:500,
    windowOrigin:()=>new Map([['seven_day','owner'],['five_hour','owner']]),
    kappaForUsage:()=>({upper_micro:100000,binding:{account_sha256_16:'1111222233334444'},provenance:{method:'fixture'}})});
  const weekId=`1111222233334444:weekly:${now+7*86400000}`;
  const objective=createSyntheticPace50Source({start:now,used:{weekly:20e6,short:20e6},kappa:{weekly:100000,short:100000}});
  source.objectiveInputFor=objective.objectiveInputFor;
  const opened=createPace50Candidate({postingLagBoundMs:120000,directory,account:'1111222233334444',account_week_id:weekId,source,now:()=>now,
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
    expectedExecutor:{backend_id:'docker-sbx',accepts:()=>true},stopBoundMs:1000,stopAnswerMs:500,
    windowOrigin:()=>new Map([['seven_day','owner'],['five_hour','owner']]),
    kappaForUsage:()=>({upper_micro:100000,binding:{account_sha256_16:'1111222233334444'},provenance:{method:'fixture'}})});
  const weekId=`1111222233334444:weekly:${now+7*86400000}`;
  const objective=createSyntheticPace50Source({start:now,used:{weekly:20e6,short:20e6},kappa:{weekly:100000,short:100000}});
  source.objectiveInputFor=objective.objectiveInputFor;
  const opened=createPace50Candidate({postingLagBoundMs:120000,directory,account:'1111222233334444',account_week_id:weekId,source,now:()=>now,
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
    const {candidate,adapter}=createPace50Candidate({postingLagBoundMs:120000,directory,account:'synthetic-account',account_week_id:'synthetic-week-1',source,now:()=>now,
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
   pace50:{postingLagBoundMs:0,account:'synthetic-account',account_week_id:'synthetic-week-1',source,contextFor:()=>({consent:true,ownerAbsent:true})}});
 t.after(()=>runtime.close());
 const stops=[];runtime.candidate.registry.bind('job',{stop:why=>stops.push(why)});
 const job={budget_v1:{max_list_usd:10},requirements:{limits:{wall_seconds:60}},expires_at:new Date(now+3600000).toISOString()};
 const reserve=()=>runtime.candidate.reserve({attemptId:'job',jobId:'job',provider:'claude',model:'claude-haiku-5-5',ownerAbsent:true,job});
 return {runtime,source,stops,reserve,now,job,directory};
}
