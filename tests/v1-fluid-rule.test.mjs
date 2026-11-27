import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {decide,protection,COLD_START_CAP} from '../lib/v1/rules/fluid-protection.mjs';
const state=(dial=.75)=>({now_h:1,dial,windows:[{id:'week',length_h:168,reset_h:168,used_lo:0,used_hi:0,borrower_used:0,inflight_gross:0}],history:[],job:{gross:{week:1.2296},duration_h:4/15}});
const hist=(n,end=10)=>Array.from({length:n},()=>({window_id:'week',trace:[[0,0],[168,end]]}));
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
test('flat-prior exact two-stage solution, including endpoints',()=>{for(const d of [0,.1,.25,.75,.99,1])for(const a of [0,10,80,100])for(const C of [0,10,75,100]){const p=protection([],'week',168,d,{owner:a,later:C});near(p.optimum,d*Math.max(0,100-a-C));near(p.envelope,Math.min(100*d,Math.max(p.optimum,a===0?100*Math.min(d,COLD_START_CAP):0)));}});
test('positive first-hour cold lending for fitting job, no training prerequisite',()=>{assert.equal(decide(state()).admit,true);assert.equal(decide(state(.25)).admit,true);assert.equal(decide(state(0)).admit,false);near(decide(state()).lendable.week,20);});
test('cold-start startup reduces immediate exposure, but certain harm remains possible',()=>{near(decide(state()).lendable.week,20);assert.ok(20<75);});
test('no-history uniform result is Littlewood when later capacity is zero',()=>near(protection([],'week',168,.75).optimum,75));
test('history informs objective without rank sample-count gate',()=>{const p=protection(hist(1),'week',168,.25,{later:0});assert.ok(p.envelope>0);assert.equal(p.n,1);});
test('known full-use history reduces lending without claiming latent identification',()=>{assert.ok(protection(hist(4,100),'week',168,.75,{later:0}).optimum<protection([],'week',168,.75).optimum);});
test('imported open window consumed immediately as lower evidence, not training sample',()=>{const s=state();s.history=[{source:'import-open-window',window_id:'week',reset_h:168,trace:[[0,0],[1,80]]}];assert.equal(decide(s).admit,false);const p=protection(s.history,'week',168,.75,{reset_h:168,elapsed:1,later:100});assert.equal(p.n,0);assert.equal(p.imported,80);near(p.optimum,0);near(p.envelope,0);});
test('old-identity and future imported samples do not leak',()=>{for(const h of [{reset_h:0,trace:[[0,0],[1,90]]},{reset_h:168,trace:[[0,0],[2,90]]}]){const s=state();s.history=[{source:'import-open-window',window_id:'week',...h}];near(decide(s).lendable.week,20);assert.equal(protection(s.history,'week',168,.75,{reset_h:168,elapsed:1,later:100}).imported,0);}});
test('censor flag contributes upper endpoint not low served demand',()=>{const h=hist(1);h[0].censored=true;near(protection(h,'week',168,.25).optimum,0);});
test('continuous allowance on dial, time, observed lower use',()=>{for(const d of [.1,.25,.75,.99]){const s=state(d),t=structuredClone(s);t.dial+=1e-7;assert.ok(Math.abs(decide(s).lendable.week-decide(t).lendable.week)<1e-4);}const s=state();s.now_h=100;const t=structuredClone(s);t.now_h+=1e-7;assert.ok(Math.abs(decide(s).lendable.week-decide(t).lendable.week)<1e-4);});
test('partition invariance with fixed owner evidence and timing, reservations not fresh budget',()=>{const s=state();s.job.gross.week=20;assert.equal(decide(s).admit,true);for(let i=0;i<20;i++){s.job.gross.week=1;s.windows[0].inflight_gross=i;assert.equal(decide(s).admit,true);}s.windows[0].inflight_gross=20;assert.equal(decide(s).admit,false);});
test('settlement preserves budget when total meter and borrower debit move together',()=>{const s=state();s.windows[0].borrower_used=2;s.windows[0].used_lo=s.windows[0].used_hi=2;near(decide(s).lendable.week,18);});
test('both resource bounds and reset crossing enforced',()=>{const s=state();s.windows.push({id:'short',length_h:5,reset_h:5,used_lo:99,used_hi:99,borrower_used:0,inflight_gross:.5});s.job.gross.short=.6;assert.equal(decide(s).admit,false);s.job.duration_h=200;assert.equal(decide(s).admit,false);});
test('matching prefixes cannot distinguish late burst',()=>{const s=state();s.now_h=150;assert.deepEqual(decide(s),decide(structuredClone(s)));});
test('one-sentence reason contains no calibrated cold-start claim',()=>assert.match(decide(state()).reason,/cold-start probability uncertified/));
test('invalid state, gross, trace fail closed',()=>{for(const mutate of [s=>s.windows[0].used_hi=NaN,s=>s.windows.push(s.windows[0]),s=>delete s.job.gross.week,s=>s.job.gross.extra=1,s=>s.history=[{window_id:'week',trace:[[0,0],[167,10]]}]]){const s=state();mutate(s);assert.equal(decide(s).admit,false);}});
test('atom optimum brackets numerical objective without strict-CDF inequality mistake',()=>{const hs=[...hist(13,31),...hist(7,83)],d=.5,C=12,p=protection(hs,'week',168,d,{later:C});const loss=x=>{let sum=0;for(let i=0;i<10000;i++){const u=(i+.5)/100;sum+=(1-d)*Math.max(0,u+x-100)+d*Math.max(0,100-u-x-C);}sum/=10000;for(const h of hs){const u=h.trace[1][1];sum+=(1-d)*Math.max(0,u+x-100)+d*Math.max(0,100-u-x-C);}return sum/21;};for(let x=0;x<=100;x+=.25)assert.ok(loss(p.optimum)<=loss(x)+1e-6);});
test('dynamic optimum is NOT implied by static rule',()=>{const J=x=>.6*x+.3*Math.min(1,2-x)-.5*x;near(J(1),.4);near(J(2),.2);});
test('first-hour actual quoted Haiku gross fits BOTH windows for diagnostic dials',()=>{for(const d of [.25,.75]){const s=state(d);s.windows.push({id:'short',length_h:5,reset_h:5,used_lo:0,used_hi:0,borrower_used:0,inflight_gross:0});s.job.gross.short=3.6656;assert.equal(decide(s).admit,true);}});
test('rounded completed endpoint uses half-bin upward model correction',()=>{const h=hist(1,10);h[0].metadata={measurement:'rounded served use'};near(protection(h,'week',168,.5).optimum,89.5);});
test('duplicate imports use maximum, not sum; missing identity never applied',()=>{const s=state(),h={source:'import-open-window',window_id:'week',reset_h:168,trace:[[0,0],[1,.05]]};s.history=[h,h];near(decide(s).lendable.week,20);assert.equal(protection(s.history,'week',168,.75,{reset_h:168,elapsed:1,later:100}).imported,.05);delete h.reset_h;near(decide(s).lendable.week,20);assert.equal(protection(s.history,'week',168,.75,{reset_h:168,elapsed:1,later:100}).imported,0);});

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
    lagBounds:Object.fromEntries(p.windows.map(w=>[w.id,{providerLagMs:0,maxPointsPerHour:0,maxPointsPerHourEvidenceClass:'measured',
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
    const adapter=createPace50Adapter({directory,account:ACCOUNT,account_week_id:WEEK,
      now:()=>NOW,buildInput:()=>p,decide:s=>{ruleCalls.push(s);return decide(s);},effects});
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
  assert.equal(f.ruleCalls.length,1);assert.equal(preview.objective.reasonText,decide(f.ruleCalls[0]).reason);
  assert.equal(f.calls.length,0,'preview has no effects');
  const admitted=await f.adapter.admit({request:p.request,expectedRevision:0});
  assert.equal(admitted.admitted,true);assert.equal(admitted.effects_dispatched,true);
  assert.equal(f.calls.filter(c=>c.type==='launch_chunk').length,1);
  assert.equal(f.ruleCalls.length,2);
  assert.deepEqual(p,before,'builder evidence stays data-only and unchanged');
  const disk=JSON.parse(fs.readFileSync(join(f.directory,'lending-pace50-state.json'),'utf8'));
  assert.ok(disk.attempts[0].resources.every(r=>r.protection_source==='injected_rule'));
  assert.equal(JSON.stringify(disk).includes(decide(f.ruleCalls[0]).reason),false);
});

test('an injected rule admits a job sent with no friend value, as the app sends every job',async t=>{
  const p=fixture();
  delete p.objective.job.friendValue; delete p.objective.job.chunkCandidates;
  const f=open(t,p);
  const preview=await f.adapter.preview({request:p.request});
  assert.equal(preview.admitted,true,JSON.stringify({reason:preview.reason}));
  assert.equal(preview.objective.friendValue,null,'the value is shown as unknown, never invented');
});
test('a job the owner approves by hand is decided on measured spare, not by the injected rule',async t=>{
  const p=fixture();
  p.objective.automatic=false;
  const directory=fs.mkdtempSync(join(tmpdir(),'rule-manual-'));
  let ruleCalls=0;
  const adapter=createPace50Adapter({directory,account:ACCOUNT,account_week_id:WEEK,now:()=>NOW,buildInput:()=>p,
    decide:s=>{ruleCalls++;return {...decide(s),admit:false};},
    effects:Object.fromEntries(['arm_cessation_deadline','launch_chunk','open_short_window','cancel_pending_attempt',
      'request_cessation','request_fresh_complete_reconciliation'].map(type=>[type,async()=>type==='arm_cessation_deadline'?()=>{}:undefined]))});
  t.after(async()=>{await adapter.close();fs.rmSync(directory,{recursive:true,force:true});});
  const preview=await adapter.preview({request:p.request});
  assert.equal(preview.admitted,true,JSON.stringify({reason:preview.reason,code:preview.objective?.reasonCode}));
  assert.equal(ruleCalls,0,'the injected rule does not decide a manual request');
  assert.match(preview.objective.reasonText,/after your approval/);
});
test('injected provenance survives restart while a started zero-use claim stays held',async t=>{
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
  assert.ok(final.attempts[0].resources.every(r=>r.held_micro>0 && r.protection_source==='injected_rule'));
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
  assert.equal(before.attempts[0].cleanup_proven,true);
  await f.adapter.close();const resumed=f.reopen();
  const after=resumed.state();
  assert.deepEqual(after,before,'the proof and provenance survive the reopen unchanged');
  assert.ok(after.attempts[0].resources.every(r=>r.protection_source==='injected_rule'&&r.held_micro===r.initial_micro&&r.released_micro===0),
    'cleanup alone releases nothing and keeps the rule provenance');
  assert.notEqual(after.attempts[0].hold_closed,true);
});



// These acceptance tests intentionally stay red for known candidate/seam gaps.
// Unit/lifecycle passes above are not product acceptance.
// Reuse the unchanged M1 experiment; target assertions are deliberately not
// relaxed to the research candidate's own envelope.
import {milestoneResults,heavyOwnerResult} from './v1-rule-seam-acceptance.test.mjs';
test('fluid M1 light owner: lends at least 95% of nominal spare',async t=>{
  const r=await milestoneResults(decide);t.diagnostic(JSON.stringify(r));assert.equal(r.a,true);
});
test('fluid M1 typical atomic jobs: all named $20 workloads fit cold start',async t=>{
  const r=await milestoneResults(decide);t.diagnostic(JSON.stringify(r));assert.equal(r.c,true);
});
test('fluid M1 heavy owner: preserves baseline owner service',async t=>{
  const r=await heavyOwnerResult(decide);t.diagnostic(JSON.stringify(r));assert.equal(r.safe,true);
});

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
