import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createQuotaRegistry} from '../lib/v1/quota-registry.mjs';
import {buildLendingRuleState} from '../lib/v1/lending-rule-seam.mjs';
import {decideObjectiveLend} from '../lib/v1/lending-objective.mjs';

import {createLendingHistory} from '../lib/v1/lending-history.mjs';
import {adaptSeamV2, decide as fluidDecide, protection} from '../lib/v1/rules/fluid-protection.mjs';
import {ordinaryInput, NOW, ACCOUNT, MICRO as M, HOUR_MS as H} from "./helpers/pace50-fixtures.mjs";

const model='claude-sonnet-5-5';
const yes=s=>({admit:true,lendable:Object.fromEntries(s.windows.map(w=>[w.id,100])),reason:'Synthetic spare.'});
function input() {
  const p=ordinaryInput({now:NOW});
  const windows=Object.fromEntries(p.windows.map(w=>[w.id,{kind:w.kind,known:true,fresh:true,compatible:true,
    usedMicro:w.used_micro,committedMicro:0,pointsPerUsdMicro:w.kappa_micro,
    resetAtMs:w.resets_at,anchorAtMs:w.anchor_at,durationMs:w.duration_ms}]));
  // Authored synthetic complete roster, independent of what the meter happens to return.
  const quotaRegistry=createQuotaRegistry({version:'composition-fixture/1',complete:true,
    limits:[['weekly',168,.05],['short',5,.2]].map(([id,hours,weight])=>({
      id,provider:'claude',unit:'quota_percent',capacity:100,durationMs:hours*H,
      reset:{kind:'first-use'},scope:{kind:'account'},
      weights:{version:'composition-fixture/1',nativeUnit:'usd',byModel:{[model]:weight}}}))});
  return {...p.objective,now:NOW,observedAt:NOW,account:ACCOUNT,weeklyResource:'weekly',windows,
    gates:{consent:true,limits:true,funding:true,stopping:true},ruleDial:.5,
    job:{...p.objective.job,provider:'claude',model,requestedUsdMicro:3*M,
      nativeCostBounds:{unit:'usd',lower:0,upper:3},wallMs:300000,stopMs:60000,uncertaintyMs:30000},
    ruleEvidence:{quotaRegistry,snapshot:{account:ACCOUNT,windows:p.windows.map(w=>({
      window_id:w.id,window_minutes:w.duration_ms/60000,used_pct:w.used_micro/M,
      resets_at:w.resets_at,observed_at:NOW,state:'open',lent_pct:0,reserved_pct:0}))},
      entries:[],history:[],applicableResources:{account:ACCOUNT,provider:'claude',model,complete:true,ids:['weekly','short']},
      roundingPoints:{weekly:0,short:0},lagBounds:Object.fromEntries(['weekly','short'].map(id=>[id,{
        providerLagMs:0,maxPointsPerHour:0,provenance:'Synthetic synchronous bounded account.'}]))}};
}
const quote=p=>decideObjectiveLend({...p,decide:yes});
function registryEdit(p, edit) {
  const registry=structuredClone(p.ruleEvidence.quotaRegistry);edit(registry);
  p.ruleEvidence.quotaRegistry=createQuotaRegistry(registry);
}
function held(p, code) {
  let calls=0;
  const q=decideObjectiveLend({...p,decide:s=>{calls++;return yes(s);}});
  assert.equal(q.admitted,false);assert.equal(q.reasonCode,'rule_evidence_unknown');
  assert.match(q.reasonText,new RegExp('\\('+code+'\\)'));
  assert.equal(q.projection.reasonText,q.reasonText);assert.equal(q.reservePointsMicro,undefined);
  assert.equal(calls,0);
}

test('full versioned registry and gross native bound compose with v2 and admit',()=>{
  const p=input(),before=structuredClone(p),s=buildLendingRuleState(p),q=quote(p);
  assert.equal(q.admitted,true);assert.equal(s.contract_version,2);
  assert.deepEqual(s.job.gross,{weekly:.15,short:.6});
  assert.deepEqual(q.reservePointsMicro,{weekly:150000,short:600000});
  assert.equal(q.nativeBudgetUsdMicro,3*M-p.job.worstCallUsdMicro);
  for(const w of s.windows) {
    assert.equal(w.total_lo,p.windows[w.id].usedMicro/M);assert.equal(w.total_hi,w.total_lo);
    assert.equal(w.borrower_settled_hi,0);assert.equal(w.borrower_represented_lo,0);
    assert.equal(w.owner_lo,w.total_lo);assert.equal(w.owner_hi,w.total_hi);
  }
  assert.deepEqual(p,before);
});
test('missing registry holds with quota_registry_missing',()=>{
  const p=input();delete p.ruleEvidence.quotaRegistry;held(p,'quota_registry_missing');
});
test('untrusted callback exceptions cannot escape the fail-closed diagnostic boundary',()=>{
  for(const error of [undefined,null,'private callback text',new Error('private callback text'),
    {get code(){throw new Error('private getter text');}},
    {code:{toString(){throw new Error('private conversion text');}}}]) {
    const q=decideObjectiveLend({...input(),decide:()=>{throw error;}});
    assert.equal(q.admitted,false);assert.equal(q.reasonCode,'rule_evidence_unknown');
    assert.equal(q.reasonText,'Holding because the injected rule or its evidence is incomplete.');
    assert.equal(q.reservePointsMicro,undefined);
  }
});
test('missing native cost bound holds with native_cost_bound_unknown',()=>{
  const p=input();delete p.job.nativeCostBounds;held(p,'native_cost_bound_unknown');
});
test('non-percent unit and non-100 capacity hold with rule_seam_quota_unit_unsupported',()=>{
  for(const edit of [r=>{r.limits[0].unit='tokens';},r=>{r.limits[0].capacity=200;}]) {
    const p=input();registryEdit(p,edit);p.ruleEvidence.snapshot.windows[0].used=20;
    held(p,'rule_seam_quota_unit_unsupported');
  }
});
test('rolling window holds with rule_seam_rolling_unsupported',()=>{
  const p=input();registryEdit(p,r=>{r.limits[0].reset={kind:'rolling'};});
  held(p,'rule_seam_rolling_unsupported');
});
test('incomplete registry, missing applicable reading, and unknown model weight still hold',()=>{
  for(const edit of [
    p=>registryEdit(p,r=>{r.complete=false;}),
    p=>{p.ruleEvidence.snapshot.windows.pop();},
    p=>registryEdit(p,r=>{r.limits[0].weights.byModel={};}),
  ]) {const p=input();edit(p);held(p,'quota_registry_unsupported');}
});
test('native bound must include overshoot, not only the launch budget',()=>{
  const p=input();p.job.nativeCostBounds.upper=(p.job.requestedUsdMicro-p.job.worstCallUsdMicro)/M;
  held(p,'quota_registry_charge_mismatch');
});
test('decimal micro-boundaries are exact, never a floating-point tolerance',()=>{
  for(const upper of [3.0000000000000004,3.00002,3.00004,2.99]) {
    const p=input();p.job.nativeCostBounds.upper=upper;
    held(p,'quota_registry_charge_mismatch');
  }
  const p=input();p.job.nativeCostBounds={unit:'credits',lower:0,upper:1.5e6};
  registryEdit(p,r=>{for(const l of r.limits) {
    l.weights.nativeUnit='credits';l.weights.byModel[model]=l.id==='weekly'?1e-7:4e-7;
  }});
  assert.equal(quote(p).admitted,true,'exponent-form native weights use the same exact rounding');
});

test('real OPEN probe episode keeps source and tail; it is same-reset lower evidence, never a sample',t=>{
  const p=input(),w=p.windows.weekly,start=w.resetAtMs-w.durationMs;
  const home=mkdtempSync(join(tmpdir(),'seam-registry-probe-'));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const history=createLendingHistory({home,account:'claude',ledger:{entries:()=>[]},now:()=>NOW});
  for(const [at,used] of [[start,0],[NOW,80]])history.record({
    window_id:'weekly',window_minutes:10080,resets_at:w.resetAtMs,observed_at:at,used_pct:used,state:'open',
    source:'probe',rounding_points:0,metadata:{measurement:'exact'},
    // This synthetic world has no borrower spend, including active/unrecorded work.
    borrower_upper_bound:{complete:true,account:'claude',window_id:'weekly',
      resets_at:w.resetAtMs,observed_at:at,upper_points:0,provenance:'Synthetic borrower-free world.'},
    censoring:{complete:true,limit_reached:false,owner_refused:false,owner_deferred:false}});
  p.ruleEvidence.history=history.ownerTraces();
  const s=buildLendingRuleState(p),adapted=adaptSeamV2(s),h=adapted.history[0];
  assert.equal(h.source,'probe');assert.equal(h.complete,false);assert.equal(h.open,true);
  assert.equal(h.tail_unobserved_h,42);assert.deepEqual(h.trace,[[0,0],[126,80]]);
  const lower=protection(adapted.history,'weekly',168,.5,{reset_h:h.reset_h,elapsed:126,later:25});
  assert.equal(lower.n,0);assert.equal(lower.imported,80);
  const imported=structuredClone(s);imported.history[0].source='import-open-window';
  assert.deepEqual(fluidDecide(s),fluidDecide(imported));
  for(const history of [[{...h,reset_h:h.reset_h-168}],[{...h,trace:[[0,0],[127,80]]}]]) {
    const r=protection(history,'weekly',168,.5,{reset_h:h.reset_h,elapsed:126,later:25});
    assert.equal(r.n,0);assert.equal(r.imported,0);
  }
  const duplicate=protection([h,h],'weekly',168,.5,{reset_h:h.reset_h,elapsed:126,later:25});
  assert.equal(duplicate.n,0);assert.equal(duplicate.imported,80);
});
test('completed probe is still a sample, unsupported and wrong-duration probes are ignored',()=>{
  const s=buildLendingRuleState(input());
  const h={window_id:'weekly',supported:true,complete:true,open:false,censored:false,source:'probe',
    length_h:168,reset_h:s.now_h-1,rounding_points:0,metadata:{measurement:'exact'},trace:[[0,0],[168,10]]};
  s.history=[h];const history=adaptSeamV2(s).history;
  assert.equal(history.length,1);assert.equal(protection(history,'weekly',168,.5).n,1);
  for(const patch of [{supported:false},{length_h:5},{rounding_points:2},{source:'unknown',open:true,complete:false}]) {
    s.history=[{...h,...patch}];assert.deepEqual(adaptSeamV2(s).history,[]);
  }
});
