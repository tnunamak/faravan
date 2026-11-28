import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {decide} from '../lib/v1/rules/fluid-protection.mjs';
import {buildLendingRuleState, evaluateLendingRule, lendingRuleErrorCode} from '../lib/v1/lending-rule-seam.mjs';
import {decideObjectiveLend} from '../lib/v1/lending-objective.mjs';
import {lendingStatus, ruleReasonLine, RULE_REASON_COPY, LINES} from '../lib/v1/lending-status-copy.mjs';
import {NATIVE_WINDOW_WEIGHTS} from '../lib/v1/quota-registry.mjs';

const H=3_600_000, M=1_000_000, model='claude-sonnet-5-5';
function fluidInput() {
  return {now_h:9,dial:.5,windows:[{id:'w',length_h:10,reset_h:10,used_lo:0,used_hi:0,
    borrower_used:0,inflight_gross:0}],history:[],job:{gross:{w:.1},duration_h:.01}};
}
function seamInput() {
  const now=1000*H, windows={}, rows=[];
  for (const id of ['a','b']) {
    windows[id]={durationMs:10*H,resetAtMs:now+H,usedMicro:0,committedMicro:0,pointsPerUsdMicro:M};
    rows.push({window_id:id,window_minutes:600,used_pct:0,resets_at:now+H,observed_at:now,
      state:'open',lent_pct:0,reserved_pct:0});
  }
  return {now,windows,ruleDial:.5,job:{provider:'claude',model,requestedUsdMicro:M,
    nativeCostBounds:{unit:'usd',lower:0,upper:1},wallMs:1,uncertaintyMs:0,stopMs:0},
    ruleEvidence:{quotaRegistry:{version:'reason-fixture/1',complete:true,limits:['a','b'].map(id=>({
      id,provider:'claude',unit:'quota_percent',capacity:100,durationMs:10*H,reset:{kind:'first-use'},
      scope:{kind:'account'},weights:{version:'reason-fixture/1',nativeUnit:'usd',byModel:{[model]:1}}}))},
      snapshot:{account:'account',windows:rows},entries:[],history:[],
      applicableResources:{account:'account',provider:'claude',model,complete:true,ids:['a','b']},
      roundingPoints:{a:0,b:0},lagBounds:Object.fromEntries(['a','b'].map(id=>[id,{
        providerLagMs:0,maxPointsPerHour:0,provenance:'Synthetic exact synchronous evidence.'}]))}};
}
test('native cost basis still needs positive allowance and time in every window', () => {
  function nativeInput() {
    const input=seamInput();
    for (const window of Object.values(input.windows)) {
      window.pointsPerUsdMicro=null;
      window.conversion='native_window';
    }
    for (const entry of input.ruleEvidence.quotaRegistry.limits)
      entry.weights={version:NATIVE_WINDOW_WEIGHTS,nativeUnit:'quota_percent',byModel:{}};
    return input;
  }
  const accepted=evaluateLendingRule(nativeInput(), decide);
  assert.equal(accepted.admitted,true,accepted.reasonCode);
  assert.deepEqual(accepted.state.job.gross,{a:0,b:0});
  assert.ok(Object.values(accepted.reservePointsMicro).every(points=>points>0));

  const late=nativeInput();
  late.job.wallMs=2*H;
  assert.equal(evaluateLendingRule(late,decide).reasonCode,'fluid_deadline');

  const exhausted=nativeInput();
  exhausted.windows.a.usedMicro=100*M;
  exhausted.ruleEvidence.snapshot.windows[0].used_pct=100;
  assert.equal(evaluateLendingRule(exhausted,decide).admitted,false);
});

const row=p=>p.ruleEvidence.snapshot.windows[0];
const entry=p=>{const e={account:'account',window_id:'a',started_at:p.now-2,ended_at:p.now-1,
  resets_at:p.windows.a.resetAtMs,lent_pts:0,lent_lower_pts:0,represented_at:p.now};
  p.ruleEvidence.entries=[e];return e;};
const yes=s=>({admit:true,lendable:Object.fromEntries(s.windows.map(w=>[w.id,100])),reason:'Original candidate sentence.'});
const seen=new Set();
function copy(code) {
  seen.add(code);
  assert.ok(Object.hasOwn(RULE_REASON_COPY,code),code);
  const admitted=code==='fluid_lend'||code==='seam_lend';
  assert.equal(ruleReasonLine(code),RULE_REASON_COPY[code],code);
  assert.equal(lendingStatus({reasonCode:code,admitted}).line,RULE_REASON_COPY[code],code);
  assert.equal(lendingStatus({reason:code,admitted}).line,RULE_REASON_COPY[code],code);
}
const fluidCases=[
  ['fluid_lend',()=>{}],
  ['fluid_allowance',p=>p.job.gross.w=100],
  ['fluid_deadline',p=>p.job.duration_h=2],
  ['fluid_zero_gross',p=>p.job.gross.w=0],
  ['fluid_invalid_state',p=>p.dial=-1],
  ['fluid_invalid_identity',p=>p.windows[0].id=''],
  ['fluid_invalid_window',p=>p.windows[0].used_hi=NaN],
  ['fluid_invalid_bounds',p=>p.windows[0].used_hi=-1],
  ['fluid_missing_gross',p=>delete p.job.gross.w],
  ['fluid_unknown_gross_resource',p=>p.job.gross.extra=1],
  ['fluid_invalid_history',p=>p.history=[{window_id:'w',trace:[]}]],
  ['fluid_invalid_trace',p=>p.history=[{window_id:'w',trace:[[0,0],[10,101]]}]],
  ['fluid_invalid_reset_relative_trace',p=>p.history=[{window_id:'w',trace:[[0,0],[9,1]]}]],
  ['fluid_unexpected_error',p=>p.history=[null]],
  ['fluid_unsupported_contract',p=>{p.contract_version=2;p.windows=null;}],
];
for (const [code,edit] of fluidCases) test('real fluid input reaches '+code,()=>{
  const p=fluidInput();edit(p);const result=decide(p);
  assert.equal(result.reasonCode,code);assert.equal(result.admit,code==='fluid_lend');
  assert.equal(typeof result.reason,'string');copy(code);
});

const seamCases=[
  ['seam_quota_windows_required',p=>p.windows={}],
  ['seam_unknown_rule_evidence',p=>delete p.ruleEvidence],
  ['seam_unknown_account',p=>p.ruleEvidence.snapshot.account=''],
  ['seam_unknown_applicable_resource_roster',p=>p.ruleEvidence.applicableResources.complete=false],
  ['seam_ambiguous_meter_identity',p=>p.ruleEvidence.snapshot.windows.push({...row(p)})],
  ['seam_incomplete_applicable_resource_roster',p=>p.ruleEvidence.applicableResources.ids.pop()],
  ['seam_incompatible_meter_snapshot',p=>p.windows.a.usedMicro=M],
  ['seam_incompatible_window_length',p=>p.windows.a.durationMs++],
  ['seam_unknown_meter_age',p=>row(p).observed_at=row(p).resets_at-row(p).window_minutes*60_000-1],
  ['seam_unknown_account_wide_lag_bound',p=>delete p.ruleEvidence.lagBounds.a],
  ['seam_unknown_ledger_interval',p=>entry(p).started_at=p.now],
  ['seam_ambiguous_ledger_reset',p=>delete entry(p).resets_at],
  ['seam_invalid_represented_time',p=>entry(p).represented_at=p.now-3],
  ['seam_inconsistent_ledger_snapshot',p=>row(p).lent_pct=1],
  ['seam_ledger_exceeds_meter',p=>{Object.assign(entry(p),{lent_pts:1,lent_lower_pts:1});row(p).lent_pct=1;}],
  ['seam_unknown_conversion',p=>p.windows.a.pointsPerUsdMicro=0],
  ['seam_unsafe_gross',p=>{p.windows.a.pointsPerUsdMicro=Number.MAX_SAFE_INTEGER;p.job.requestedUsdMicro=Number.MAX_SAFE_INTEGER;}],
  ['seam_unknown_now',p=>p.now=-1],
  ['seam_unknown_dial',p=>p.ruleDial=2],
  ['seam_unknown_gross_request',p=>p.job.requestedUsdMicro=-1],
  ['seam_unknown_meter',p=>{row(p).used=0;row(p).used_pct=NaN;}],
  ['seam_unknown_window_length',p=>row(p).window_minutes='600'],
  ['seam_unknown_observation',p=>row(p).observed_at=-1],
  ['seam_unknown_rounding_bound',p=>delete p.ruleEvidence.roundingPoints.a],
  ['seam_unknown_provider_lag_bound',p=>p.ruleEvidence.lagBounds.a.providerLagMs=-1],
  ['seam_unknown_account_wide_rate',p=>p.ruleEvidence.lagBounds.a.maxPointsPerHour=-1],
  ['seam_unknown_ledger_start',p=>entry(p).started_at=-1],
  ['seam_unknown_ledger_end',p=>entry(p).ended_at=-1],
  ['seam_unknown_borrower_spend',p=>entry(p).lent_pts=-1],
  ['seam_unknown_borrower_lower',p=>entry(p).lent_lower_pts=-1],
  ['seam_unknown_represented_time',p=>entry(p).represented_at=-1],
  ['seam_unknown_ledger_total',p=>row(p).lent_pct=-1],
  ['seam_unknown_inflight',p=>p.windows.a.committedMicro=-1],
  ['seam_unknown_ledger_reservations',p=>row(p).reserved_pct=-1],
  ['seam_unknown_wall',p=>p.job.wallMs=-1],
  ['seam_unknown_uncertainty',p=>p.job.uncertaintyMs=-1],
  ['seam_unknown_stop',p=>p.job.stopMs=-1],
  ['quota_registry_missing',p=>delete p.ruleEvidence.quotaRegistry],
  ['native_cost_bound_unknown',p=>delete p.job.nativeCostBounds],
  ['quota_registry_unsupported',p=>p.ruleEvidence.quotaRegistry.complete=false],
  ['rule_seam_quota_unit_unsupported',p=>{p.ruleEvidence.quotaRegistry.limits[0].capacity=200;}],
  ['rule_seam_rolling_unsupported',p=>p.ruleEvidence.quotaRegistry.limits[0].reset={kind:'rolling'}],
  ['quota_registry_charge_mismatch',p=>p.job.nativeCostBounds.upper=2],
  ['seam_unexpected_error',p=>p.windows=null],
];
for (const [code,edit] of seamCases) test('real seam evidence reaches '+code,()=>{
  const p=seamInput();edit(p);
  assert.throws(()=>buildLendingRuleState(p),error=>{assert.equal(error.code,code);return true;});copy(code);
});

test('an estimated burn rate cannot raise the allowance above the setting share',()=>{
  const lendable=cls=>{
    const p=seamInput(), bound=p.ruleEvidence.lagBounds.a;
    p.now=1000*H; p.job.requestedUsdMicro=M; p.job.nativeCostBounds.upper=1;
    bound.maxPointsPerHour=1;
    if (cls!==undefined) bound.maxPointsPerHourEvidenceClass=cls;
    const state=buildLendingRuleState(p);
    return {state:state.windows[0],rule:decide(state).lendable.a};
  };
  const measured=lendable('measured');
  assert.equal(typeof measured.state.owner_envelope_hi,'number');
  for (const cls of ['estimated','inferred',undefined]) {
    const r=lendable(cls);
    assert.equal(Object.hasOwn(r.state,'owner_envelope_hi'),false,String(cls));
    assert.ok(r.rule<=50,String(cls)+' lendable '+r.rule);
  }
  assert.ok(measured.rule>=lendable('estimated').rule);
});

test('real candidate output reaches seam decision and validation codes',()=>{
  const p=seamInput();
  for (const [code,candidate] of [
    ['seam_rule_must_be_a_function',null],
    ['seam_invalid_rule_decision',()=>({admit:'yes'})],
    ['seam_unknown_rule_lendable',s=>({...yes(s),lendable:{a:NaN,b:100}})],
    ['seam_unexpected_error',()=>{throw new Error('Original exception.');}],
  ]) {
    assert.throws(()=>evaluateLendingRule(p,candidate),error=>{assert.equal(error.code,code);return true;});copy(code);
  }
  for (const [code,candidate] of [['seam_lend',yes],['seam_rule_hold',s=>({...yes(s),admit:false})]]) {
    const r=evaluateLendingRule(p,candidate);assert.equal(r.reasonCode,code);
    assert.equal(r.reason,'Original candidate sentence.');copy(code);
  }
});

test('independent caps produce specific hold codes without changing candidate reason',()=>{
  const cases=[
    ['seam_rule_allowance',()=>{},s=>({...yes(s),lendable:{a:0,b:100}})],
    ['seam_physical_room',p=>{p.windows.a.usedMicro=100*M;row(p).used_pct=100;},yes],
    ['seam_product_room',p=>p.windows.a.uncertaintyMicro=100*M,yes],
    ['seam_resource_fit',p=>p.windows.b.uncertaintyMicro=100*M,s=>({...yes(s),lendable:{a:0,b:100}})],
  ];
  for (const [code,edit,candidate] of cases) {
    const p=seamInput();edit(p);const r=evaluateLendingRule(p,candidate);
    assert.equal(r.reasonCode,code);assert.equal(r.admitted,false);assert.equal(r.fit,false);
    assert.equal(r.reason,'Original candidate sentence.');copy(code);
  }
});

test('fluid code crosses the seam, unknown codes use the original generic copy',()=>{
  const p=seamInput();const r=evaluateLendingRule(p,decide);
  assert.equal(r.admitted,true);assert.equal(r.reasonCode,'fluid_lend');
  assert.equal(lendingStatus({admitted:true,reasonCode:r.reasonCode}).line,RULE_REASON_COPY.fluid_lend);
  assert.equal(lendingStatus({admitted:true,active:true,reasonCode:r.reasonCode}).line,LINES.lend);
  for (const code of ['new_future_code','toString','__proto__'])
    assert.equal(lendingStatus({reasonCode:code}).line,LINES.proof);
  assert.equal(lendingStatus({reasonCode:'fluid_allowance',lendingOn:false}).line,LINES.stopped);
  assert.equal(lendingStatus({reasonCode:'fluid_allowance',intentOn:false}).line,LINES.paused);
});

test('a native-window seam with no room on one window holds by name',()=>{
  const p=seamInput();
  for (const w of Object.values(p.windows)) Object.assign(w,{conversion:'native_window',pointsPerUsdMicro:null});
  for (const l of p.ruleEvidence.quotaRegistry.limits) l.weights={version:NATIVE_WINDOW_WEIGHTS,nativeUnit:'quota_percent',byModel:{}};
  const ok=evaluateLendingRule(p,yes);
  assert.equal(ok.admitted,true);assert.ok(ok.reservePointsMicro.a>0&&ok.reservePointsMicro.b>0);
  const r=evaluateLendingRule(p,s=>({...yes(s),lendable:{a:0,b:100}}));
  assert.equal(r.admitted,false);assert.equal(r.reasonCode,'seam_native_no_room');copy(r.reasonCode);
});

test('every mapped code has real-input reachability',()=>{
  assert.deepEqual(Object.keys(RULE_REASON_COPY).filter(code=>!seen.has(code)),[]);
});

test('registry rejects non-finite observations before the seam rejects negative ones',()=>{
  const p=seamInput();row(p).observed_at=NaN;
  assert.throws(()=>buildLendingRuleState(p),error=>error.code==='quota_registry_unsupported');
});

test('optional code metadata cannot change admission or contradict lifecycle copy',()=>{
  const p=seamInput();
  const baseline=evaluateLendingRule(p,yes);
  const candidate=s=>Object.defineProperty(yes(s),'reasonCode',{get(){throw new Error('metadata unavailable');}});
  assert.deepEqual(evaluateLendingRule(p,candidate),baseline);
  p.job.wallMs=2*H;
  const overlong=evaluateLendingRule(p,yes);
  assert.equal(overlong.admitted,true); // This seam never added a deadline gate.
  assert.equal(lendingStatus({admitted:true,reasonCode:overlong.reasonCode}).line,LINES.ready);
  assert.equal(lendingStatus({admitted:false,reasonCode:'fluid_lend'}).line,LINES.proof);
  assert.equal(lendingStatus({admitted:true,reasonCode:'fluid_allowance'}).line,LINES.ready);
  assert.equal(ruleReasonLine('future_code'),LINES.proof);
});

test('objective and projection retain the code without replacing legacy reason fields',()=>{
  function objectiveInput() {
    const p=seamInput();Object.assign(p,{observedAt:p.now,weeklyResource:'a',laterBurnCapacityMicro:0,
      gates:{consent:true,limits:true,funding:true,stopping:true},decide});
    Object.assign(p.job,{estimateUsdMicro:M,worstCallUsdMicro:1,friendValue:1});
    for (const [id,w] of Object.entries(p.windows)) Object.assign(w,{kind:id==='a'?'weekly':'short',known:true,fresh:true,compatible:true});
    return p;
  }
  const p=objectiveInput(),lent=decideObjectiveLend(p);
  assert.equal(lent.admitted,true);assert.equal(lent.reasonCode,'objective_lend');
  assert.equal(lent.ruleReasonCode,'fluid_lend');assert.equal(lent.projection.ruleReasonCode,'fluid_lend');
  assert.equal(lendingStatus(lent).line,RULE_REASON_COPY.fluid_lend);
  p.ruleDial=0;
  const held=decideObjectiveLend(p);assert.equal(held.admitted,false);
  assert.equal(held.reasonCode,'rule_resource_fit');assert.equal(held.ruleReasonCode,'seam_rule_allowance');
  assert.equal(held.projection.ruleReasonCode,held.ruleReasonCode);
  assert.equal(lendingStatus(held).line,RULE_REASON_COPY.seam_rule_allowance);
  delete p.ruleEvidence.quotaRegistry;
  const missing=decideObjectiveLend(p);assert.equal(missing.reasonCode,'rule_evidence_unknown');
  assert.equal(missing.ruleReasonCode,'quota_registry_missing');
  assert.equal(lendingStatus(missing).line,RULE_REASON_COPY.quota_registry_missing);
  assert.deepEqual(lendingStatus({reason:'usage_unknown',reasonCode:'objective_usage_unknown'}),
    lendingStatus({reason:'usage_unknown'}));
});

test('arbitrary callback failures retain identity and obtain stable generic copy',()=>{
  const errors=[undefined,null,'private text',Object.freeze(new Error('private text')),
    {get code(){throw new Error('private getter');}},
    new Proxy({}, {getPrototypeOf(){throw new Error('private prototype');}})];
  for (const error of errors) {
    let caught=false;
    try {evaluateLendingRule(seamInput(),()=>{throw error;});}
    catch (actual) {caught=true;assert.equal(actual,error);assert.equal(lendingRuleErrorCode(actual),'seam_unexpected_error');}
    assert.equal(caught,true);
  }
});
