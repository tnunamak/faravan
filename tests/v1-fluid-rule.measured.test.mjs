import './helpers/no-browser.mjs';
import {settleAdapterAtBound} from './helpers/lending-settle-at-bound.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {decide,protection,COLD_START_CAP} from '../lib/v1/rules/fluid-protection.mjs';
const state=(dial=.75)=>({now_h:1,dial,windows:[{id:'week',length_h:168,reset_h:168,used_lo:0,used_hi:0,borrower_used:0,inflight_gross:0}],history:[],job:{gross:{week:1.2296},duration_h:4/15}});
const hist=(n,end=10)=>Array.from({length:n},()=>({window_id:'week',trace:[[0,0],[168,end]]}));
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Adapter} from '../lib/v1/lending-pace50-adapter.mjs';
import {createEstimatedPace50State} from '../lib/v1/lending-policy.mjs';
import {ordinaryInput, request, NOW, ACCOUNT, WEEK, MICRO as M} from './helpers/pace50-fixtures.mjs';

// Entirely synthetic evidence and effect handlers. No provider, browser, or network.
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
  // This synthetic world declares the whole roster and its authored conversion.
  p.objective.job.nativeCostBounds={unit:'usd',lower:0,upper:p.objective.job.requestedUsdMicro/M};
  p.objective.ruleEvidence.quotaRegistry={version:'synthetic/1',complete:true,
    limits:p.windows.map(w=>({id:w.id,provider,unit:'quota_percent',capacity:100,
      durationMs:w.duration_ms,reset:{kind:'first-use'},scope:{kind:'account'},
      weights:{version:'synthetic/1',nativeUnit:'usd',byModel:{[model]:w.kappa_micro/M}}}))};
  return p;
}
function open(t,p) {
  const directory=fs.mkdtempSync(join(tmpdir(),'rule-durable-'));
  const calls=[], ruleCalls=[];
  const effects=Object.fromEntries(['arm_cessation_deadline','launch_chunk','open_short_window',
    'cancel_pending_attempt','request_cessation','request_fresh_complete_reconciliation']
    .map(type=>[type,async e=>{calls.push({type,e});return type==='arm_cessation_deadline'?()=>{}:undefined;}]));
  const instances=[];
  const reopen=()=>{
    const adapter=createPace50Adapter({postingLagBoundMs:120000,directory,account:ACCOUNT,account_week_id:WEEK,
      now:()=>NOW,buildInput:()=>p,decide:s=>{ruleCalls.push(s);return decide(s);},effects});
    instances.push(adapter);return adapter;
  };
  t.after(async()=>{for(const a of instances)await a.close();fs.rmSync(directory,{recursive:true,force:true});});
  return {adapter:reopen(),reopen,calls,ruleCalls,directory};
}

test('a job the owner approves by hand is decided on measured spare, not by the injected rule',async t=>{
  const p=fixture();
  p.objective.automatic=false;
  const directory=fs.mkdtempSync(join(tmpdir(),'rule-manual-'));
  let ruleCalls=0;
  const adapter=createPace50Adapter({postingLagBoundMs:120000,directory,account:ACCOUNT,account_week_id:WEEK,now:()=>NOW,buildInput:()=>p,
    decide:s=>{ruleCalls++;return {...decide(s),admit:false};},
    effects:Object.fromEntries(['arm_cessation_deadline','launch_chunk','open_short_window','cancel_pending_attempt',
      'request_cessation','request_fresh_complete_reconciliation'].map(type=>[type,async()=>type==='arm_cessation_deadline'?()=>{}:undefined]))});
  t.after(async()=>{await adapter.close();fs.rmSync(directory,{recursive:true,force:true});});
  const preview=await adapter.preview({request:p.request});
  assert.equal(preview.admitted,true,JSON.stringify({reason:preview.reason,code:preview.objective?.reasonCode}));
  assert.equal(ruleCalls,0,'the injected rule does not decide a manual request');
  assert.match(preview.objective.reasonText,/after your approval/);
});
// These acceptance tests intentionally stay red for known candidate/seam gaps.
// Unit/lifecycle passes above are not product acceptance.
// Reuse the unchanged M1 experiment; target assertions are deliberately not
// relaxed to the research candidate's own envelope.
import {milestoneResults,heavyOwnerResult} from './v1-rule-seam-acceptance.test.mjs';
// Explicit paired quota-only counterexamples, not prevalence estimates or real traces.
for (const family of ['elastic owner', 'late burst']) {
  // A known impossibility, kept visible as todo: with no setup signal, no rule can tell
  // these owners from a light owner on this prefix (setup-signal.md, charter 3.3).
  test(`fluid ${family}: preserves paired owner service on an indistinguishable prefix`,
    {todo:'cold-start obstruction: needs the setup signal (stream Q)'}, t => {
    const s=state(.75), r=decide(s);
    assert.equal(r.admit,true);
    const lent=s.job.gross.week;
    const baselineOwner=100, owner=Math.min(100,100-lent), harm=baselineOwner-owner;
    t.diagnostic(JSON.stringify({family,lent,owner,baselineOwner,harm,dial:s.dial}));
    assert.equal(harm,0,'known candidate shortfall, not hidden by changing rule or oracle');
  });
}

// Measured bound: the same journey, closed by its durable deadline. The rule provenance survives cleanup and the reopen, and is
// still on the resources once the deadline has released the hold.
test('injected provenance survives cleanup_proven and a reopen, and is kept when the deadline closes the hold',async t=>{
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
  assert.ok(resumed.state().attempts[0].resources.every(r=>r.protection_source==='injected_rule'&&r.held_micro>0));
  await settleAdapterAtBound(resumed,()=>{});
  const final=resumed.state();
  assert.equal(final.attempts[0].process_state,'ceased');
  assert.ok(final.attempts[0].resources.every(r=>r.held_micro===0&&r.protection_source==='injected_rule'));
});

test('recent owner burn protects a margin and lends only the remaining weekly room', () => {
  const now = 50;
  const decision = rate => decide({now_h:now,dial:.10,
    windows:[{id:'week',length_h:168,reset_h:168,used_lo:39,used_hi:39,
      borrower_used:0,inflight_gross:0,recentMeterRate:rate}],
    history:[],
    job:{gross:{week:1},duration_h:1}});
  assert.equal(decision(.3).admit,true);
  assert.equal(decision(.6).admit,false);
});
