import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {durableCessationBound,settlementEligibility} from '../../lib/v1/lending-policy.mjs';
import {createPace50Candidate} from '../../lib/v1/lender-pace50.mjs';
import {soakProviders,START,oldRows} from './lending-soak-providers.mjs';
import {DAY,HOUR,MINUTE} from './lending-soak.mjs';
import {createLiveness} from './lending-soak-liveness.mjs';
import {createRefusalAudit} from './lending-soak-refusals.mjs';

function appendStoppedHoldFixtures(snapshot,week) {
  const imported=Array.from({length:15},(_,i)=>{
    const template=oldRows[i===14?1:0];
    const row=JSON.parse(JSON.stringify(template).replaceAll(template.id,`upgrade-${i}`));
    row.account_week_id=week(i===14?'claude':'codex');row.late_ack_events=[];
    if(row.owner_stop===null)delete row.owner_stop;
    return row;
  });
  snapshot.attempts.push(...imported);
  snapshot.event_ids.push(...imported.flatMap(row=>[`${row.id}:cleanup-proven:old`,...(row.owner_stop?[row.owner_stop.event_id]:[])]));
  snapshot.revision+=imported.length*2;
  return imported;
}

function importedHoldProtection(readState,clock,imported) {
  const initial=readState();
  const obligations=imported.flatMap(original=>{
    const attempt=initial.attempts.find(row=>row.id===original.id);
    return original.resources.filter(r=>r.held_micro+r.unrepresented_micro>0).map(resource=>{
      const saved=attempt.resources.find(r=>r.id===resource.id);
      assert.equal(saved.held_micro+saved.unrepresented_micro,resource.held_micro+resource.unrepresented_micro,
        'early recovery cycles preserve every imported hold');
      assert.equal(saved.released_micro,resource.released_micro,'early recovery cycles refund nothing');
      const bound=settlementEligibility(attempt,saved,{state:initial,at:clock.at}).nextEligibleAt;
      assert.notEqual(bound,null,'imported cleanup supplies a durable bound');
      return {attemptId:attempt.id,resourceId:resource.id,protection:saved.held_micro+saved.unrepresented_micro,
        released:saved.released_micro,bound:Number(bound)};
    });
  });
  const check=()=>{
    const state=readState();
    for(const obligation of obligations){
      const resource=state.attempts.find(a=>a.id===obligation.attemptId).resources.find(r=>r.id===obligation.resourceId);
      if(clock.at<obligation.bound){
        assert.equal(resource.held_micro+resource.unrepresented_micro,obligation.protection,'no imported release before its bound');
        assert.equal(resource.released_micro,obligation.released);
      }else assert.equal(resource.held_micro+resource.unrepresented_micro,0,'the real held sweep closes at the resource bound');
    }
    for(const original of imported){
      const bound=Math.max(...obligations.filter(row=>row.attemptId===original.id).map(row=>row.bound));
      assert.equal(state.attempts.find(row=>row.id===original.id).hold_closed,clock.at>=bound,
        `${original.id} closes at its own bound ${bound}, never before it`);
    }
  };
  const times=[...new Set(obligations.flatMap(row=>[row.bound-1,row.bound]))].sort((a,b)=>a-b);
  const closed=()=>imported.every(row=>readState().attempts.find(saved=>saved.id===row.id).hold_closed===true);
  assert.ok(times.every(at=>at>clock.at),'early recovery precedes the imported resource bounds');
  check();return {times,check,closed,obligations};
}

async function recoverImportedAtBounds(pace,clock,refresh,imported) {
  const protection=importedHoldProtection(()=>pace.adapter.state(),clock,imported);
  for(const at of protection.times){
    clock.at=at;await refresh();await pace.candidate.probeHeld();protection.check();
  }
  const closed=protection.closed();
  assert.equal(closed,true,'all fifteen imported holds close through the real held sweep');
  return {closed,obligations:protection.obligations};
}

export async function importedRecoveryRun() {
  const directory=fs.mkdtempSync(join(tmpdir(),'lending-imported-recovery-')),clock={at:START+HOUR};
  const meter=soakProviders(directory,clock,{failure:new Set(),calls:[],extra:{claude:0,codex:0},fastMeter:true,native:true});
  const open=()=>createPace50Candidate({directory,now:()=>clock.at,account:'synthetic-account',account_week_id:meter.week('claude'),source:meter.source,
    io:{fsyncSync:()=>{},fsyncDirectory:()=>{}},effectOverrides:{arm_cessation_deadline:async()=>()=>{}},
    nativeGuard:{setTimer:()=>0,clearTimer:()=>{}}});
  let pace;
  try{
    await meter.refresh();pace=open();await pace.adapter.close();
    const stateFile=join(directory,'lending-pace50-state.json'),snapshot=JSON.parse(fs.readFileSync(stateFile));
    snapshot.updated_at=clock.at;
    const imported=appendStoppedHoldFixtures(snapshot,meter.week);
    fs.writeFileSync(stateFile,JSON.stringify(snapshot));pace=open();
    const earlyProtection=importedHoldProtection(()=>pace.adapter.state(),clock,imported);
    for(let cycle=0;cycle<2;cycle++){
      clock.at+=30_000;await meter.refresh();await pace.candidate.probeHeld();earlyProtection.check();
    }
    const recovery=await recoverImportedAtBounds(pace,clock,meter.refresh,imported);
    return {imported:imported.length,codex:imported.filter(row=>row.resources.some(r=>r.id.startsWith('codex:'))).length,...recovery};
  }finally{await pace?.candidate.cancelObservations();await pace?.adapter.close();await meter.probe.close();fs.rmSync(directory,{recursive:true,force:true});}
}

export async function persistentRun(t,seed) {
  const directory = fs.mkdtempSync(join(tmpdir(),'lending-persistent-soak-'));
  const clock = {at:START};
  let meter = soakProviders(directory,clock,{failure:new Set(),calls:[],extra:{claude:0,codex:0},fastMeter:true});
  const trace = [], rows = [], running = new Set(), counts = [];
  const stateFile = join(directory,'lending-pace50-state.json');
  const metric = createLiveness();
  const refusalAudit=createRefusalAudit();
  let pace, sequence = 0, completed = 0, restarts = 0, nativeBlindRefusedMs = 0;
  let precedingSample = null, horizon = START+4*DAY, importedProtection=null;
  let random = seed;
  const next = () => {random = (Math.imul(random,1664525)+1013904223) >>> 0;return random;};
  const args = (id,provider='claude') => ({attemptId:id,jobId:id,provider,
    model:provider === 'claude' ? 'claude-haiku-5-5' : 'gpt-6-sol',automatic:false,ownerAbsent:true,
    job:{budget_v1:{max_list_usd:2},requirements:{limits:{wall_seconds:60}},expires_at:new Date(clock.at+DAY).toISOString()}});
  const open = () => createPace50Candidate({directory,now:() => clock.at,account:'synthetic-account',
    account_week_id:meter.week('claude'),source:meter.source,
    // Keep this fault-recovery workload independent of the preview's per-job default.
    contextFor:()=>({strategyParams:{perJobPct:100}}),
    io:{fsyncSync:() => {},fsyncDirectory:() => {}},
    effectOverrides:{arm_cessation_deadline:async () => () => {}},
    nativeGuard:{setTimer:() => 1,clearTimer:() => {}},
    measurementHistory:{record(type,data) {rows.push({type,data});return `row-${rows.length}`;}}});
  const reopen = async () => {
    const before = pace.adapter.state();
    await pace.candidate.cancelObservations();await pace.adapter.close();await meter.probe.close();
    meter = soakProviders(directory,clock,meter.physical);await meter.refresh();
    pace = open();restarts++;
    assert.deepEqual(pace.adapter.state(),before,'I7 restart preserves the growing ledger');
  };
  const sample = async label => {
    // Durable holds do NOT exclude time. The independent backend inventory
    // proves idle; quota comes from the real cache plus physical age reserve.
    // Probe the Claude job a user would submit. Cross-provider blockage remains
    // visible here, rather than disappearing from the denominator.
    const eligible = running.size === 0 && meter.clearQuota('claude');
    const out = await pace.candidate.preview(args(`offer-${sequence}`));
    refusalAudit.record({kind:'offer',id:`offer-${sequence}`,at:clock.at,eligible,out,provider:'claude',
      state:out.admitted?null:pace.adapter.state()});
    trace.push([clock.at,label,out.admitted,out.reason]);
    if(precedingSample?.eligible && !precedingSample.allowed && precedingSample.reason==='native_attempt_in_flight')
      nativeBlindRefusedMs+=clock.at-precedingSample.at;
    precedingSample={at:clock.at,eligible,allowed:out.admitted,reason:out.reason};
    metric.sample(clock.at,eligible,out.admitted,out.reason,sequence++);
    return out;
  };
  const visitImportedBounds=async target=>{
    if(!importedProtection)return;
    for(const at of importedProtection.times.filter(at=>at>clock.at&&at<=target)){
      clock.at=at;await meter.refresh();await pace.candidate.probeHeld();
      importedProtection.check();await sample('imported-resource-bound');
    }
  };
  const tick = async (at,label) => {
    await visitImportedBounds(at);
    clock.at = at;
    await meter.refresh();await pace.candidate.probeHeld();
    importedProtection?.check();
    await sample(label);
  };
  const job = async (id,provider,unknown=false,late=false) => {
    const request = args(id,provider), grant = await pace.candidate.reserve(request);
    trace.push([clock.at,'reserve',id,grant.ok,grant.policyReason ?? null]);
    if (!grant.ok) {
      const refused=await pace.candidate.preview(request);
      assert.equal(refused.admitted,false,'the refused reservation and its read-only preview agree');
      assert.equal(refused.reason,grant.policyReason);
      refusalAudit.record({kind:'reserve',id,at:clock.at,eligible:running.size===0&&meter.clearQuota(provider),
        out:refused,provider,state:pace.adapter.state()});
      return false;
    }
    assert.equal((await pace.candidate.admitStart(id)).ok,true);
    await pace.candidate.started(id,{ok:true});running.add(id);
    if (late) {
      const ack = await pace.adapter.deliver({type:'late_ack',event_id:`${id}:late`,at:clock.at,attempt_id:id});
      assert.equal(ack.applied,true,'late acknowledgement is delivered through the durable adapter');
      assert.equal(pace.adapter.state().attempts.find(row => row.id === id).late_ack_unresolved,true);
      await meter.refresh();
    }
    if (meter.physical.native && provider === 'claude') {meter.extra.claude += 1;await meter.refresh();}
    await pace.candidate.recordCleanup(id,{removed:true});
    await pace.candidate.finish({...request,execution:{stdout:'',lending_meter:{final:!unknown,cost_usd:0}}});
    if (late) {
      const seen = await meter.source.observe({provider,model:request.model,admissionOnly:true});
      const proof = {type:'cessation_proven',at:clock.at,attempt_id:id,
        authoritative_cessation:true,usage_reconciled:true,zero_use_attested:true,
        complete:true,compatible:true,refresh_succeeded:true,
        resources:seen.resources.map(({id,instance,anchor_at,resets_at,used_micro}) => ({id,instance,anchor_at,resets_at,used_micro}))};
      const old = await pace.adapter.deliver({...proof,event_id:`${id}:old-proof`,observed_at:clock.at-3*MINUTE});
      assert.equal(old.applied,false,'a stale reading with a zero-use flag proves nothing and releases nothing');
      assert.equal(old.reason,'late_ack_reconciliation_incomplete');
      const stopped=pace.adapter.state().attempts.find(row=>row.id===id);
      assert.equal(stopped.cleanup_proof_persisted_at,clock.at);
      assert.equal(durableCessationBound(stopped,{state:pace.adapter.state()}),clock.at);
      assert.equal(stopped.late_ack_unresolved,true,'recording cessation cannot erase unresolved late-ack history');
      assert.ok(stopped.resources.some(resource=>resource.held_micro+resource.unrepresented_micro>0));
      const protection=stopped.resources.map(resource=>[resource.held_micro,resource.unrepresented_micro]);
      const fresh = await pace.adapter.deliver({...proof,event_id:`${id}:fresh-proof`,observed_at:clock.at});
      assert.equal(fresh.applied,false,'a fresh aggregate reading with a zero-use flag still releases nothing');
      assert.equal(fresh.reason,'usage_coverage_unavailable');
      const repeated=pace.adapter.state().attempts.find(row=>row.id===id);
      assert.equal(repeated.late_ack_unresolved,true,'a fresh repeated cessation cannot launder late exposure');
      assert.deepEqual(repeated.resources.map(resource=>[resource.held_micro,resource.unrepresented_micro]),protection);
      assert.ok(repeated.late_ack_events.some(event=>event.event_id===`${id}:late`));
    }
    running.delete(id);completed++;
    // Native finish leaves a durable hold. Count every uncovered idle interval, including time beyond the read delay.
    if (meter.physical.native && provider === 'claude' && !late) {
      await sample('native-meter-pending');

      const at=clock.at+2*MINUTE;await visitImportedBounds(at);clock.at=at;
      await meter.refresh();
    }
    await pace.candidate.probeHeld();
    importedProtection?.check();
    return true;
  };
  try {
    await meter.refresh();pace = open();
    await sample('initial');
    // Establish real history in this very store before the upgrade appends old
    // records. No phase, reset or restart ever replaces this state with genesis.
    assert.equal(await job('before-upgrade','claude'),true);
    await sample('baseline');
    await tick(START+MINUTE,'late-ack');
    assert.equal(await job('late-job','claude',false,true),true);
    await pace.candidate.probeHeld();
    await sample('late-ack-recovered');
    // A genuinely unknown run spans a failed probe and a five-hour reset.
    clock.at = START+HOUR-2*MINUTE;await meter.refresh();
    const crossing = args('cross-reset');
    assert.equal((await pace.candidate.reserve(crossing)).ok,true);
    await pace.candidate.started(crossing.attemptId,{ok:true});running.add(crossing.attemptId);
    await sample('cross-reset-started');
    meter.failure.add('claude');clock.at += 3*MINUTE;await meter.refresh();
    assert.equal(meter.probe.lastResult('claude').ok,false);
    await pace.candidate.recordCleanup(crossing.attemptId,{removed:true});
    await pace.candidate.finish({...crossing,execution:{stdout:'',lending_meter:{final:false,cost_usd:0}}});
    running.delete(crossing.attemptId);
    await sample('failed-probe-open-hold-across-reset');
    await reopen();meter.failure.delete('claude');meter.extra.claude += 2;
    await tick(clock.at+30_000,'combined-fault-recovery');
    const crossingState = pace.adapter.state(), crossingAttempt = crossingState.attempts.find(row => row.id === 'cross-reset');
    horizon = Math.max(horizon, ...crossingAttempt.resources.map(resource =>
      Number(settlementEligibility(crossingAttempt,resource,{state:crossingState,at:clock.at}).nextEligibleAt ?? 0))) + 30_000;
    // Load the old code's exact ledger-row shapes, preserving every prior row
    // and event. Only synthetic account-week identities and missing optional
    // fields are normalized; money, scope, time and cleanup evidence stay intact.
    await pace.adapter.close();
    const oldSnapshot = JSON.parse(fs.readFileSync(stateFile));
    const retained = structuredClone(oldSnapshot.attempts);
    const imported=appendStoppedHoldFixtures(oldSnapshot,meter.week);
    fs.writeFileSync(stateFile,JSON.stringify(oldSnapshot));
    // The upgraded app has the old exposure but no current Claude calibration,
    // exactly the native-window path that refuses behind an unclosed old hold.
    meter.physical.native = true;pace = open();
    importedProtection=importedHoldProtection(()=>pace.adapter.state(),clock,imported);
    assert.deepEqual(pace.adapter.state().attempts.slice(0,retained.length),retained,'upgrade must retain earlier days and active exposure');
    assert.equal(pace.adapter.state().attempts.length,retained.length+15);
    await sample('upgrade-loaded');
    // A subsequent provider reading covers the imported historical usage as
    // well as the already accepted aggregate from this same growing ledger.
    meter.extra.claude += 6;
    await tick(clock.at+30_000,'upgrade-recovery-1');
    await tick(clock.at+30_000,'upgrade-recovery-2');
    await reopen();
    const afterFaults = clock.at;
    // Four hundred offered jobs share one ledger. Every fourth opportunity
    // executes; the others exercise the same admission preview a waiting job
    // sees. Repeated idle samples do not create fake successful work.
    for (let i=0;i<400;i++) {
      const at = afterFaults+Math.floor(i*(horizon-afterFaults)/400);
      await tick(at,`offer-${i}`);
      if (i % 4 === 0) await job(`run-${i}`,(next() >>> 31) ? 'claude' : 'codex');
      if ([30,70,160].includes(i)) await meter.assertCachedFailure('claude');
      if (i % 40 === 0) await reopen();
      const count = pace.adapter.state().attempts.length;
      if (counts.length) assert.ok(count >= counts.at(-1),'ledger rows must grow, never rotate or prune');
      counts.push(count);
      if (i % 4 === 0) await sample(`after-${i}`);
    }
    await tick(horizon,'end');
    // Stop offering work before draining the ledger. Later idle time must not
    // dilute the refusal fraction measured over the offered-work schedule.
    const atHorizon=pace.adapter.state();
    const remaining=atHorizon.attempts.flatMap(attempt=>attempt.resources
      .filter(resource=>resource.held_micro+resource.unrepresented_micro>0)
      .map(resource=>{
        const bound=settlementEligibility(attempt,resource,{state:atHorizon,at:clock.at}).nextEligibleAt;
        assert.notEqual(bound,null,'every stopped soak resource has a durable cessation bound');
        assert.ok(Number(bound)>clock.at,'the offered-work horizon swept every already-due resource');
        return {attemptId:attempt.id,resourceId:resource.id,bound:Number(bound),
          protection:resource.held_micro+resource.unrepresented_micro,released:resource.released_micro};
      }));
    for(const at of [...new Set(remaining.flatMap(row=>[row.bound-1,row.bound]))].sort((a,b)=>a-b)){
      clock.at=at;await meter.refresh();await pace.candidate.probeHeld();
      const snapshot=pace.adapter.state();
      for(const obligation of remaining){
        const resource=snapshot.attempts.find(a=>a.id===obligation.attemptId).resources.find(r=>r.id===obligation.resourceId);
        if(at<obligation.bound){
          assert.equal(resource.held_micro+resource.unrepresented_micro,obligation.protection,'draining never releases protection before B');
          assert.equal(resource.released_micro,obligation.released,'draining never refunds before B');
        }else assert.equal(resource.held_micro+resource.unrepresented_micro,0,'the real held sweep closes every remaining resource at B');
      }
    }
    const allClosed=pace.adapter.state().attempts.every(row=>row.hold_closed===true&&
      row.resources.every(resource=>resource.held_micro+resource.unrepresented_micro===0));
    assert.equal(allClosed,true,'every row in the growing ledger closes after the last resource bound');
    const upgradedClosed=importedProtection.closed();
    const combinedRecovered = pace.adapter.state().attempts.find(row => row.id === 'cross-reset').hold_closed === true;
    const liveness = metric.report();
    assert.ok(liveness.availableMs > 3*DAY,'idle quota time must remain in the denominator despite sticky holds');
    const state = pace.adapter.state();
    assert.ok(state.attempts.some(row => row.id === 'before-upgrade'),'first job must survive four days');
    assert.ok(imported.every(row => state.attempts.some(saved => saved.id === row.id)),'upgrade rows must survive all restarts');
    assert.equal(rows.filter(row => row.type === 'admission_decided').length,
      trace.filter(row => row[1] === 'reserve').length+1,'every submission including crossing job is measured');
    return {...liveness,nativeBlindRefusedMs,refusals:refusalAudit.report(),holds:refusalAudit.holdSummary(),
      nativeResetBoundMs:Math.max(...state.attempts.flatMap(a=>a.resources.filter(r=>r.conversion==='native_window').map(r=>r.duration_ms))),
      completed,restarts,
      ledgerRows:state.attempts.length,opportunities:400,combinedRecovered,upgradedClosed,allClosed,recoveryHorizon:clock.at,
      hash:createHash('sha256').update(JSON.stringify(trace)).digest('hex')};
  } finally {
    await pace?.candidate.cancelObservations();await pace?.adapter.close();await meter.probe.close();
    fs.rmSync(directory,{recursive:true,force:true});
  }
}
