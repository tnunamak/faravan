import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Adapter} from '../lib/v1/lending-pace50-adapter.mjs';
import {createEstimatedPace50State, evaluateEstimatedPace50, transitionEstimatedPace50State} from '../lib/v1/lending-policy.mjs';
import {ordinaryInput, request, NOW, ACCOUNT, WEEK, MICRO as M} from './helpers/pace50-fixtures.mjs';

// Entirely synthetic evidence and effect handlers. No provider, browser, or network.
const yes = s => ({admit:true, lendable:Object.fromEntries(s.windows.map(w => [w.id,100])), reason:'Synthetic spare.'});
function fixture({provider='claude', model='claude-sonnet-5-5', shortMinutes=300} = {}) {
  const p=ordinaryInput({now:NOW});
  if (shortMinutes !== 300) {
    const w=p.windows[1]; w.duration_ms=shortMinutes*60_000;
    w.resets_at=NOW+30*60_000; w.anchor_at=w.resets_at-w.duration_ms;
  }
  p.state=createEstimatedPace50State({account:ACCOUNT,account_week_id:WEEK});
  p.request=request({requested_usd_micro:3*M,provider,model});
  p.objective.ruleDial=.5;
  p.objective.job={...p.objective.job,provider,model,requestedUsdMicro:3*M};
  p.objective.ruleEvidence={
    snapshot:{account:ACCOUNT,windows:p.windows.map(w=>({window_id:w.id,
      window_minutes:w.duration_ms/60_000,used_pct:w.used_micro/M,resets_at:w.resets_at,
      observed_at:NOW,state:'open',lent_pct:0,reserved_pct:0}))},
    applicableResources:{account:ACCOUNT,provider,model,complete:true,ids:p.windows.map(w=>w.id)},
    entries:[],history:[],roundingPoints:Object.fromEntries(p.windows.map(w=>[w.id,0])),
    lagBounds:Object.fromEntries(p.windows.map(w=>[w.id,{providerLagMs:0,maxPointsPerHour:0,
      provenance:'Synthetic synchronous bounded account.'}]))};
  p.objective.job.nativeCostBounds={unit:'usd',lower:3,upper:3};
  p.objective.ruleEvidence.quotaRegistry={version:'synthetic/1',complete:true,
    limits:p.windows.map(w=>({id:w.id,provider,unit:'quota_percent',capacity:100,
      durationMs:w.duration_ms,reset:{kind:'first-use'},scope:{kind:'account'},
      weights:{version:'synthetic/1',nativeUnit:'usd',byModel:{[model]:w.kappa_micro/M}}}))};
  return p;
}
const quote = p => evaluateEstimatedPace50({...p,objective:{...p.objective,decide:yes}});
function open(t,p) {
  const directory=fs.mkdtempSync(join(tmpdir(),'rule-durable-'));
  const calls=[], ruleCalls=[];
  const effects=Object.fromEntries(['arm_cessation_deadline','launch_chunk','open_short_window',
    'cancel_pending_attempt','request_cessation','request_fresh_complete_reconciliation']
    .map(type=>[type,async e=>{calls.push({type,e});return type==='arm_cessation_deadline'?()=>{}:undefined;}]));
  const instances=[];
  const reopen=()=>{
    const adapter=createPace50Adapter({directory,account:ACCOUNT,account_week_id:WEEK,
      now:()=>NOW,buildInput:()=>p,decide:s=>{ruleCalls.push(s);return yes(s);},effects});
    instances.push(adapter);return adapter;
  };
  t.after(async()=>{for(const a of instances)await a.close();fs.rmSync(directory,{recursive:true,force:true});});
  return {adapter:reopen(),reopen,calls,ruleCalls,directory};
}

test('trusted rule dependency traverses real adapter preview and admission without serializing code',async t=>{
  const p=fixture(), f=open(t,p);
  const before=structuredClone(p);
  const preview=await f.adapter.preview({request:p.request});
  assert.equal(preview.admitted,true);
  assert.deepEqual(preview.objective.protectionSource,{weekly:'injected_rule',short:'injected_rule'});
  assert.equal(f.ruleCalls.length,1);assert.equal(preview.objective.reasonText,'Synthetic spare.');
  assert.equal(f.calls.length,0,'preview has no effects');
  const admitted=await f.adapter.admit({request:p.request,expectedRevision:0});
  assert.equal(admitted.admitted,true);assert.equal(admitted.effects_dispatched,true);
  assert.equal(f.calls.filter(c=>c.type==='launch_chunk').length,1);
  assert.equal(f.ruleCalls.length,2);
  assert.deepEqual(p,before,'builder evidence stays data-only and unchanged');
  const disk=JSON.parse(fs.readFileSync(join(f.directory,'lending-pace50-state.json'),'utf8'));
  assert.ok(disk.attempts[0].resources.every(r=>r.protection_source==='injected_rule'));
  assert.equal(JSON.stringify(disk).includes('Synthetic spare'),false);
});

test('injected provenance survives restart, and a started zero report keeps its hold',async t=>{
  const p=fixture(), f=open(t,p);
  const admitted=await f.adapter.admit({request:p.request,expectedRevision:0});
  assert.equal(admitted.admitted,true);
  assert.ok(f.adapter.state().attempts[0].resources.every(r=>r.protection_source==='injected_rule'));
  let rev=admitted.revision;
  const started=await f.adapter.transition({type:'launch_result',event_id:'started',attempt_id:'attempt-1',at:NOW,result:'started'}, {expectedRevision:rev});
  assert.equal(started.applied,true);rev=started.revision;
  await f.adapter.close();const resumed=f.reopen();
  assert.equal(resumed.state().revision,rev);
  const next=await resumed.preview({request:{...p.request,attempt_id:'attempt-2'}});
  assert.notEqual(next.reason,'state_unknown');
  for(const type of ['owner_return','stop']) {
    const out=await resumed.transition({type,event_id:type,at:NOW},{expectedRevision:rev});
    assert.equal(out.applied,true,type);assert.equal(out.effects_dispatched,true);rev=out.revision;
  }
  assert.ok(f.calls.some(c=>c.type==='request_cessation'));
  const ceased=await resumed.transition({type:'cessation_proven',event_id:'ceased',attempt_id:'attempt-1',at:NOW,
    authoritative_cessation:true,usage_reconciled:true,zero_use_attested:true},{expectedRevision:rev});
  assert.equal(ceased.applied,false);
  assert.equal(ceased.reason,'usage_uncovered');
  const final=resumed.state();assert.notEqual(final.attempts[0].hold_closed,true);
  assert.ok(final.attempts[0].resources.every(r=>r.held_micro===r.initial_micro && r.released_micro===0 &&
    r.protection_source==='injected_rule'));
});

test('injected provenance survives cleanup_proven and a reopen while the hold stays',async t=>{
  const p=fixture(), f=open(t,p);
  const admitted=await f.adapter.admit({request:p.request,expectedRevision:0});
  assert.equal(admitted.admitted,true);
  let rev=admitted.revision;
  const started=await f.adapter.transition({type:'launch_result',event_id:'started',attempt_id:'attempt-1',at:NOW,result:'started'},{expectedRevision:rev});
  assert.equal(started.applied,true);rev=started.revision;
  const proven=await f.adapter.transition({type:'cleanup_proven',event_id:'attempt-1:cleanup-proven:1',attempt_id:'attempt-1',at:NOW+1,cleanup_removed:true},{expectedRevision:rev});
  assert.equal(proven.applied,true,proven.reason);
  const before=f.adapter.state();
  await f.adapter.close();const resumed=f.reopen();
  assert.deepEqual(resumed.state(),before,'the proof and provenance survive the reopen unchanged');
  assert.ok(resumed.state().attempts[0].resources.every(r=>r.protection_source==='injected_rule'&&r.held_micro===r.initial_micro&&r.released_micro===0));
  assert.notEqual(resumed.state().attempts[0].hold_closed,true);
});

test('pure injected admission produces valid durable provenance before any adapter wiring',()=>{
  const p=fixture(), out=quote(p);assert.equal(out.admitted,true);
  assert.equal(transitionEstimatedPace50State(out.proposed_state,{type:'owner_return',event_id:'back',at:NOW}).applied,true);
});

test('saturated omitted applicable Sonnet resource holds even if the supplied roster also omits it',()=>{
  const p=fixture();
  // An unrelated saturated Opus quota must not block a Sonnet job.
  const definition=p.objective.ruleEvidence.quotaRegistry.limits[0];
  p.objective.ruleEvidence.quotaRegistry.limits.push({...structuredClone(definition),
    id:'seven_day_opus',scope:{kind:'model_family',values:['opus']}});
  p.objective.ruleEvidence.snapshot.windows.push({...p.objective.ruleEvidence.snapshot.windows[0],
    window_id:'seven_day_opus',used_pct:100});
  assert.equal(quote(p).admitted,true);
  p.objective.ruleEvidence.quotaRegistry.limits.push({...structuredClone(definition),
    id:'seven_day_sonnet',scope:{kind:'model_family',values:['sonnet']}});
  p.objective.ruleEvidence.snapshot.windows.push({...p.objective.ruleEvidence.snapshot.windows[0],
    window_id:'seven_day_sonnet',used_pct:100});
  const d=quote(p);assert.equal(d.admitted,false);assert.equal(d.objective.reasonCode,'rule_evidence_unknown');
});

test('60-minute Codex short window admits with its own duration and anchor',()=>{
  const p=fixture({provider:'codex',model:'gpt-5',shortMinutes:60});
  assert.equal(quote(p).admitted,true);
});

test('account-wide rate is required at both positive and exactly zero total delay',()=>{
  for(const providerLagMs of [1,0]) {
    const p=fixture(), bound=p.objective.ruleEvidence.lagBounds.short;
    bound.providerLagMs=providerLagMs;delete bound.maxPointsPerHour;
    const d=quote(p);assert.equal(d.admitted,false,`delay=${providerLagMs}`);
    assert.equal(d.objective.reasonCode,'rule_evidence_unknown');
  }
});

test('injected roster binds account/provider/model, completeness and every snapshot identity',()=>{
  for (const edit of [
    p=>{delete p.objective.ruleEvidence.applicableResources;},
    p=>{p.objective.ruleEvidence.applicableResources.complete=false;},
    p=>{p.objective.ruleEvidence.applicableResources.provider='codex';},
    p=>{p.objective.ruleEvidence.applicableResources.model='claude-opus-5-5';},
    p=>{p.objective.ruleEvidence.applicableResources.account='other';},
    p=>{p.objective.ruleEvidence.snapshot.account='other';p.objective.ruleEvidence.applicableResources.account='other';},
    p=>{p.objective.ruleEvidence.applicableResources.ids=['weekly','weekly'];},
    p=>{p.objective.ruleEvidence.snapshot.windows.push({...p.objective.ruleEvidence.snapshot.windows[0],window_id:'unexplained_quota'});},
    p=>{p.objective.ruleEvidence.snapshot.windows.push({...p.objective.ruleEvidence.snapshot.windows[0]});},
  ]) {
    const p=fixture();edit(p);const d=quote(p);
    assert.equal(d.admitted,false);assert.equal(d.objective.reasonCode,'rule_evidence_unknown');
  }
});

test('actual objective duration must match the meter even with a standard duration label',()=>{
  const p=fixture();p.objective.ruleEvidence.snapshot.windows[1].window_minutes=60;
  // Keep an internally consistent five-hour objective: only the independently supplied meter differs.
  assert.equal(quote(p).admitted,false);
  // Conversely, a one-hour objective cannot use a five-hour meter snapshot.
  const q=fixture({provider:'codex',model:'gpt-5',shortMinutes:60});
  q.objective.ruleEvidence.snapshot.windows[1].window_minutes=300;
  assert.equal(quote(q).admitted,false);
});
