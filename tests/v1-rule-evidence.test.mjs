import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {buildRuleEvidence} from '../lib/v1/lending-rule-evidence.mjs';
import {lagBoundsFor} from '../lib/v1/lending-rule-defaults.mjs';
import {buildLendingRuleState} from '../lib/v1/lending-rule-seam.mjs';

import {decide} from '../lib/v1/rules/fluid-protection.mjs';
import {ACCOUNT, HOUR_MS as H, MICRO as M, ordinaryInput, weekly, short, request} from "./helpers/pace50-fixtures.mjs";

const START = 1_800_000_000_000;
const IDS = ['seven_day','five_hour'];
// Same workload as v1-rule-seam-acceptance; revised threshold below, but real settings map only to .10/.25/.50.
// Assignment provenance: 'ship bar, the owner approved 2026-10-27'.

const LIGHT_OWNER=10, CHUNK=3, DURATION=60_000;
// A light owner is defined by its completed weeks (the r1check light case): 8 weeks at 9-11% of the window.
// Without completed weeks the rule cannot tell a light owner from a new one; those cases pass pastWeeks=[].
const LIGHT_WEEKS=[9,10,11,9,10,11,9,10];
const completedWeeks=used=>used.map((u,i)=>{const start=START-(i+1)*168*H;
  return {window_id:'seven_day',start_at:start,resets_at:start+168*H,length_ms:168*H,complete:true,censored:false,source:'import',
    rounding_points:0,metadata:{measurement:'exact'},trace:[[start,0],[start+84*H,u/2],[start+168*H,u]]};});
// The same owner's completed five-hour windows, cut from the same weekly use (spread evenly), so the
// five-hour history inside a past week never sums to more than that week.
const fiveHoursOf=weeks=>Array.from({length:40},(_,i)=>weeks[Math.floor((i*5+2.5)/168)]*5/168);
const LIGHT_FIVE_HOURS=fiveHoursOf(LIGHT_WEEKS);
const completedFiveHours=used=>used.map((u,i)=>{const start=START-(i+1)*5*H;
  return {window_id:'five_hour',start_at:start,resets_at:start+5*H,length_ms:5*H,complete:true,censored:false,source:'import',
    rounding_points:0,metadata:{measurement:'exact'},trace:[[start,0],[start+5*H,u]]};});
function fixture({hours=165,owner=10,borrowed=0,gross=3,worst=.1,position='share_more',model='claude-haiku-5-5',lag=0,rate=0,historicalRate=0,noHistory=false,pastWeeks=[],pastFiveHours=[],fiveHourAnchorH=null,fiveHourBorrowed=borrowed,fiveHourOwner,kappa=null,mutate}={}) {
  const now=START+hours*H, reset=START+168*H;
  // Default: one five-hour window ending 3 h from now. A whole-week run passes the real 5 h anchor instead.
  // A five-hour window is independent of the weekly one: it may run past the weekly reset.
  const shortReset=fiveHourAnchorH===null?now+3*H:START+(fiveHourAnchorH+5)*H;
  // Unless given, the owner is assumed to use at a steady rate since the week started.
  fiveHourOwner??=hours>0?owner*Math.max(0,Math.min(5*H,now-(shortReset-5*H)))/(hours*H):0;
  const shortInstance=fiveHourAnchorH===null?{}:{instance:`short-${fiveHourAnchorH}`};
  const windows=[weekly(now,{id:'seven_day',anchor_at:START,resets_at:reset,used_micro:Math.round((owner+borrowed)*M),kappa_micro:M}),
    short(now,{id:'five_hour',anchor_at:shortReset-5*H,resets_at:shortReset,used_micro:Math.round((fiveHourOwner+fiveHourBorrowed)*M),kappa_micro:M,...shortInstance})];
  if(kappa){windows[0].kappa_micro=Math.round(kappa.weekly*M);windows[1].kappa_micro=Math.round(kappa.short*M);}
  const input=ordinaryInput({now,windows});input.weekly_resource_id='seven_day';
  const req=request({provider:'claude',model,requested_usd_micro:gross*M,wall_ms:DURATION,stop_ms:1000,uncertainty_ms:1000,expires_at:reset});
  const job={friendValue:1,estimateUsdMicro:gross*M,requestedUsdMicro:gross*M,worstCallUsdMicro:Math.round(worst*M),nativeCostBounds:{unit:'usd',lower:0,upper:gross}};
  input.objective={position,laterBurnCapacityMicro:0,job};
  const snapshot={account:ACCOUNT,windows:windows.map(w=>({window_id:w.id,window_minutes:w.duration_ms/60000,used_pct:w.used_micro/M,
    resets_at:w.resets_at,observed_at:now,state:'open',lent_pct:w.id==='five_hour'?fiveHourBorrowed:borrowed,reserved_pct:0}))};
  const entries=borrowed===0?[]:snapshot.windows.map(w=>({account:ACCOUNT,window_id:w.window_id,resets_at:w.resets_at,
    started_at:now-1000,ended_at:now,represented_at:now,attribution:'exact',
    ...(w.window_id==='five_hour'?{lent_pts:fiveHourBorrowed,lent_lower_pts:fiveHourBorrowed}:{lent_pts:borrowed,lent_lower_pts:borrowed})}));
  const registry={version:'synthetic-attested/1',complete:true,limits:windows.map(w=>({id:w.id,provider:'claude',unit:'quota_percent',capacity:100,
    durationMs:w.duration_ms,reset:{kind:'first-use'},scope:{kind:'account'},weights:{version:'synthetic-exact/1',nativeUnit:'usd',byModel:{[model]:w.kappa_micro/M}}}))};
  // Explicit prior zero-burn observation, separate from candidate training history.
  // No live provider guarantee is claimed by these synthetic synchronous fixtures.
  const rateHistory=windows.map(w=>({window_id:w.id,start_at:now-2*H,resets_at:now-2*H+w.duration_ms,length_ms:w.duration_ms,
    complete:false,censored:false,source:'probe',rounding_points:0,metadata:{measurement:'exact'},trace:[[now-2*H,0],[now-H,historicalRate]]}));
  // Known gap: the 'measured' class here is a fixture assumption. The simulated owner's true max rate equals the
  // declared bound, so the REQUIRED light-owner 80% goal holds only with a measured rate. Production builds the rate
  // as an estimate (lagBoundsFor, app.mjs:3280) and passes no class, so the goal is not met in production until
  // rate calibration lands (tracking issue #302). The production-path test below pins that current behaviour.
  const options={evidence:{now,input,request:req,state:{account:ACCOUNT,attempts:[]}},job,position,entries,history:[...completedWeeks(pastWeeks),...completedFiveHours(pastFiveHours)],rateHistory,
    ledgerSnapshot:snapshot,quotaRegistry:registry,registryProvenance:'Synthetic complete account roster and exact USD weights.',
    providerLagMs:lag,providerLagProvenance:'Synthetic explicit lag allowance.',maxPointsPerHour:rate,maxPointsPerHourEvidenceClass:'measured',
    rateProvenance:'Synthetic declared account-wide bound; not inferred from history.',roundingPoints:0,
    roundingProvenance:'Synthetic exact provider, plus actual parser endpoint allowance.'};
  if(noHistory)options.rateHistory=[];
  const result={options,input,req,now};
  mutate?.(result);
  return result;
}

test('unit mapping: exact registry, snapshot, history, epsilon and detached pure result',()=>{
  const {options}=fixture();const before=structuredClone(options);const out=buildRuleEvidence(options);
  assert.equal(out.refuse,undefined,JSON.stringify(out));assert.equal(out.ruleDial,.5);
  assert.deepEqual(out.ruleEvidence.applicableResources,{account:ACCOUNT,provider:'claude',model:'claude-haiku-5-5',complete:true,ids:IDS});
  assert.deepEqual(out.ruleEvidence.roundingPoints,{seven_day:.0005,five_hour:.0005});
  assert.equal(out.diagnostics.historicalRateIsFutureBound,false);
  out.ruleEvidence.snapshot.windows[0].used_pct=77;out.ruleEvidence.entries.push({});
  assert.deepEqual(options,before);
  for(const [position,dial] of [['keep_more_for_me',.1],['balanced',.25],['share_more',.5]])
    assert.equal(buildRuleEvidence({...options,position}).ruleDial,dial);
});

const refusals=[
 ['rule_evidence_options_missing',()=>null],
 ['rule_evidence_boundary_missing',x=>{delete x.evidence;return x;}],
 ['rule_evidence_now_missing',x=>{x.evidence.now=null;return x;}],
 ['rule_evidence_request_identity_missing',x=>{delete x.evidence.request.model;return x;}],
 ['rule_evidence_account_mismatch',x=>{x.evidence.state.account='different';return x;}],
 ['rule_evidence_position_missing',x=>{delete x.position;return x;}],
 ['rule_evidence_windows_missing',x=>{x.evidence.input.windows=[];return x;}],
 ['rule_evidence_attempts_missing',x=>{delete x.evidence.state.attempts;return x;}],
 ['rule_evidence_entries_missing',x=>{delete x.entries;return x;}],
 ['rule_evidence_history_missing',x=>{delete x.history;return x;}],
 ['rule_evidence_rate_history_missing',x=>{x.rateHistory=[];return x;}],
 ['rule_evidence_registry_unattested',x=>{x.quotaRegistry.complete=false;return x;}],
 ['rule_evidence_snapshot_missing',x=>{delete x.ledgerSnapshot;return x;}],
 ['rule_evidence_provider_lag_provenance_missing',x=>{delete x.providerLagProvenance;return x;}],
 ['rule_evidence_rate_provenance_missing',x=>{delete x.rateProvenance;return x;}],
 ['rule_evidence_rounding_provenance_missing',x=>{delete x.roundingProvenance;return x;}],
 ['rule_evidence_native_cost_missing',x=>{delete x.job.nativeCostBounds;return x;}],
 ['rule_evidence_gross_mismatch',x=>{x.job.requestedUsdMicro++;return x;}],
 ['rule_evidence_window_identity',x=>{x.evidence.input.windows.push(x.evidence.input.windows[0]);return x;}],
 ['rule_evidence_window_vocabulary_unknown',x=>{x.evidence.input.windows[0].id='unknown';return x;}],
 ['rule_evidence_window_scope',x=>{delete x.evidence.input.windows[0].instance;return x;}],
 ['rule_evidence_attempt_resources_missing',x=>{x.evidence.state.attempts=[{}];return x;}],
 ['rule_evidence_commitments_unknown',x=>{const w=x.evidence.input.windows[0];x.evidence.state.attempts=[{resources:[{id:w.id,instance:w.instance,epoch:w.epoch,held_micro:null,unrepresented_micro:0}]}];return x;}],
 ['rule_evidence_window_fields_missing',x=>{delete x.evidence.input.windows[0].anchor_at;return x;}],
 ['rule_evidence_provider_lag_unknown',x=>{delete x.providerLagMs;return x;}],
 ['rule_evidence_rate_bound_unknown',x=>{delete x.maxPointsPerHour;return x;}],
 ['rule_evidence_provider_rounding_unknown',x=>{delete x.roundingPoints;return x;}],
 ['rule_evidence_rate_history_invalid',x=>{x.rateHistory[0].censored=true;return x;}],
 ['rule_evidence_rate_bound_below_history',x=>{x.rateHistory[0].trace[1][1]=1;return x;}],
 ['rule_evidence_history_invalid',x=>{x.history=[{}];return x;}],
];
for(const [code,edit] of refusals)test(`fail closed: ${code}`,()=>assert.equal(buildRuleEvidence(edit(fixture().options)).refuse,code));

test('seam validation refuses inconsistent ledger, stale/future data, missing roster and conversion',()=>{
  for(const edit of [x=>x.ledgerSnapshot.windows[0].lent_pct=1,x=>x.ledgerSnapshot.windows[0].observed_at-=8*24*60*60_000,
    x=>x.ledgerSnapshot.windows.pop(),x=>x.quotaRegistry.limits[0].weights.byModel['claude-haiku-5-5']=2]){
    const {options}=fixture();edit(options);assert.equal(typeof buildRuleEvidence(options).refuse,'string');
  }
});

test('historical rate uses only observed same-episode intervals wholly in trailing seven days',()=>{
  const {options}=fixture();options.rateHistory[0].trace[1][1]=2;options.maxPointsPerHour=3;
  const out=buildRuleEvidence(options);assert.equal(out.refuse,undefined);assert.equal(out.diagnostics.historicalMaxPointsPerHour.seven_day,2);
  options.rateHistory[0].trace[0][0]-=168*H;
  assert.equal(buildRuleEvidence(options).refuse,'rule_evidence_rate_history_invalid');
});

// Production path: lagBoundsFor (app.mjs:3280) -> buildRuleEvidence (app.mjs:3290). The builder declares no evidence
// class, so the seam emits no owner_envelope_hi and Automatic stays at the setting share. This pins the known gap:
// the light-owner 80% goal (REQUIRED acceptance a above) waits for measured rates.
test('production rate evidence is an estimate, so Automatic stays at the setting share (light-owner 80% goal waits for measured rates)',()=>{
  const {options,input,now}=fixture({hours:165,owner:10,gross:3,position:'share_more',pastWeeks:LIGHT_WEEKS,pastFiveHours:LIGHT_FIVE_HOURS});
  const bounds=lagBoundsFor({windows:input.windows,rows:options.rateHistory,liveRows:[],now});
  const built=buildRuleEvidence({...options,providerLagMs:bounds.providerLagMs,maxPointsPerHour:bounds.maxPointsPerHour,
    rateProvenance:bounds.rateProvenance,maxPointsPerHourEvidenceClass:bounds.maxPointsPerHourEvidenceClass});
  assert.equal(built.refuse,undefined,JSON.stringify(built));
  const {request}=options.evidence;
  const state=buildLendingRuleState({now,account:input.account,windows:built.windows,ruleEvidence:built.ruleEvidence,ruleDial:built.ruleDial,
    job:{...options.job,provider:request.provider,model:request.model,wallMs:request.wall_ms,stopMs:request.stop_ms,uncertaintyMs:request.uncertainty_ms}});
  for(const w of state.windows)assert.equal(Object.hasOwn(w,'owner_envelope_hi'),false,w.id);
  const lendable=decide(state).lendable;
  for(const w of state.windows)assert.ok(lendable[w.id]<=100*built.ruleDial,`${w.id} lendable ${lendable[w.id]} above share ${100*built.ruleDial}`);
});

// One whole week through the real adapter, one hour at a time. The owner wants `demand(hours)` points each
// hour and gets what both meters leave; whatever it does not get is harm. One 2.89-point, 59-minute job is
// offered each hour; lent points are charged to the weekly and the current five-hour meter. The five-hour
// window resets every 5 h, so lending must spread across the week, as it would for real.
// 2.89/(59/60) + 10/168 <= 3, so the owner and the borrowers together stay inside the declared 3 points/hour.

// Ship-bar acceptance (S1, S3) for an owner with light completed history. The no-history
// characterizations above stay as they are: with no completed weeks, lending stays near the setting's share.
test('fixture: five-hour history fits inside the week it came from',()=>{
  assert.ok(LIGHT_FIVE_HOURS.slice(0,33).reduce((a,b)=>a+b,0)<=LIGHT_WEEKS[0]+1e-9);
});
test('fixture: the five-hour meter charges the owner and is not clamped at the weekly reset',()=>{
  assert.equal(fixture({hours:4,owner:10*4/168,fiveHourAnchorH:0}).input.windows[1].used_micro,Math.round(10*4/168*M));
  const late=fixture({hours:165,fiveHourAnchorH:165}).input.windows[1];
  assert.equal(late.anchor_at,START+165*H);assert.equal(late.resets_at,START+170*H);
});

test('production rule evidence returns repriced retained commitments for objective windows',()=>{
 const {options}=fixture();const w=options.evidence.input.windows[0];
 w.kappa_micro=300000;
 options.quotaRegistry.limits[0].weights.byModel[options.evidence.request.model]=.3;
 options.evidence.state.attempts=[{resources:[{id:w.id,instance:w.instance,epoch:w.epoch,
   held_micro:1e6,unrepresented_micro:0,kappa_micro:100000}]}];
 const built=buildRuleEvidence(options);
 assert.equal(built.refuse,undefined);
 assert.equal(built.windows?.[w.id]?.committedMicro,3e6,'production must consume the 3-point liability, not the original 1');
});
