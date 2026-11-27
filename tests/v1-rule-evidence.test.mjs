import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildRuleEvidence} from '../lib/v1/lending-rule-evidence.mjs';
import {lagBoundsFor} from '../lib/v1/lending-rule-defaults.mjs';
import {buildLendingRuleState} from '../lib/v1/lending-rule-seam.mjs';
import {createPace50Adapter} from '../lib/v1/lending-pace50-adapter.mjs';
import {decide} from '../lib/v1/rules/fluid-protection.mjs';
import {ACCOUNT, WEEK, HOUR_MS as H, MICRO as M, ordinaryInput, weekly, short, request} from './helpers/pace50-fixtures.mjs';

import medianWeek from './fixtures/lending/codex-median-week.json' with {type:'json'};

const START = 1_800_000_000_000;
const IDS = ['seven_day','five_hour'];
// Same workload as v1-rule-seam-acceptance; revised threshold below, but real settings map only to .10/.25/.50.
// Assignment provenance: 'ship bar, the product owner approved 2026-10-27'.
const MIN_SPARE_FRACTION=.80;
const KEEP_MORE_ADMISSION_HOUR=.5;
const CODEX_RATE={weekly:.0732,short:.4364,source:'Codex ratio of sums, 8 weeks'};
const ORDINARY_ADMISSION_HOUR=.5;
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

async function admission(t, settings={}) {
  const f=fixture(settings), directory=fs.mkdtempSync(join(tmpdir(),'rule-evidence-'));
  const calls=[];let mapped;
  const handlers=Object.fromEntries(['arm_cessation_deadline','launch_chunk','open_short_window','cancel_pending_attempt','request_cessation','request_fresh_complete_reconciliation']
    .map(type=>[type,async()=>{calls.push(type);if(type==='arm_cessation_deadline')return()=>{};}]));
  const adapter=createPace50Adapter({directory,account:ACCOUNT,account_week_id:WEEK,now:()=>f.now,decide,effects:handlers,
    buildInput:({state})=>{mapped=buildRuleEvidence({...f.options,evidence:{...f.options.evidence,state}});
      if(mapped.refuse)return mapped;return {...f.input,objective:{...f.input.objective,...mapped}};}});
  t.after(async()=>{await adapter.close();fs.rmSync(directory,{recursive:true,force:true});});
  const out=await adapter.admit({expectedRevision:0,request:f.req});
  return {out,calls,mapped,durable:adapter.state()};
}


test('weekly replay mutation reaches admission deadline and mapped completed entries',async t=>{
  const settings={hours:4.5,owner:0,borrowed:.1,fiveHourOwner:0,fiveHourBorrowed:.1,
    fiveHourAnchorH:0,gross:2.89,worst:.1,position:'share_more',lag:600000,
    historicalRate:10/168,rate:3,pastWeeks:LIGHT_WEEKS,pastFiveHours:LIGHT_FIVE_HOURS};
  const ordinary=await admission(t,settings);
  assert.equal(ordinary.mapped.refuse,undefined,JSON.stringify(ordinary.mapped));
  assert.equal(ordinary.out.admitted,true,JSON.stringify(ordinary.out));
  assert.ok(ordinary.calls.includes('launch_chunk'));

  // Same completed-job reconstruction and duration supplied by replayWeek.
  const entries=IDS.map(id=>({account:ACCOUNT,window_id:id,
    resets_at:START+(id==='seven_day'?168:5)*H,
    started_at:START+H,ended_at:START+H+59*60_000,
    represented_at:START+H+59*60_000,attribution:'exact',
    lent_pts:.1,lent_lower_pts:.1}));
  const weekly=await admission(t,{...settings,mutate:f=>{
    f.req.wall_ms=59*60_000;
    f.options.entries=entries;
  }});
  assert.equal(weekly.mapped.refuse,undefined,JSON.stringify(weekly.mapped));
  assert.deepEqual(weekly.mapped.ruleEvidence.entries,entries);
  // 60s fits before the short reset at h5; 59min (+stop/uncertainty) does not.
  // Ignoring mutate would admit the same request as the control above.
  assert.equal(weekly.out.admitted,false,JSON.stringify(weekly.out));
  assert.equal(weekly.calls.includes('launch_chunk'),false);
});

test('actual adapter: fresh $20 Haiku/Sonnet/Opus workload with a 100% per-job cap at hour .5, real preset dials',async t=>{
  const results=[];
  for(const position of ['keep_more_for_me','balanced','share_more'])for(const [model,worst] of [['claude-haiku-5-5',1.32],['claude-sonnet-5-5',5.28],['claude-opus-5-5',10.56]]){
    const r=await admission(t,{hours:.5,owner:0,gross:20,worst,position,model,
      mutate:f=>{f.input.objective.strategyParams={perJobPct:100};}});
    assert.equal(r.mapped.refuse,undefined,JSON.stringify(r));
    results.push({position,model,admitted:r.out.admitted,reason:r.out.reason});
    assert.equal(r.out.admitted,position!=='keep_more_for_me',JSON.stringify(r.out));
    assert.equal(r.calls.includes('launch_chunk'),r.out.admitted);
    if(r.out.admitted){assert.equal(r.durable.attempts.length,1);assert.equal(r.out.objective.ruleReasonCode,'fluid_lend');assert.equal(typeof r.out.objective.reasonText,'string');}
  }
  console.log('ACTUAL_PRESET_C',JSON.stringify(results));
});

test('actual adapter: heavy owner 80 by42, then10 by84,10 by166, actual preset mapping',async t=>{
  const results=[];
  for(const position of ['keep_more_for_me','balanced','share_more']){
    let owner=0,borrowed=0;
    for(const [hours,demand]of [[42,80],[84,10],[166,10]]){
      owner+=Math.min(demand,100-owner-borrowed);
      const r=await admission(t,{hours,owner,borrowed,gross:2,position});
      assert.equal(r.mapped.refuse,undefined,JSON.stringify(r));if(r.out.admitted)borrowed+=r.out.objective.maximumExposureUsd;
    }
    results.push({position,owner,borrowed});
  }
  console.log('ACTUAL_PRESET_B',JSON.stringify(results));
  assert.ok(results.every(r=>r.owner===100&&r.borrowed===0));
});

test('actual adapter: owner with no completed weeks stays near the setting share (no-history limit)',async t=>{
  const results=[];
  for(const position of ['keep_more_for_me','balanced','share_more']){
    let borrowed=0;
    for(let i=0;i<30;i++){
      const r=await admission(t,{hours:165+i/12,owner:LIGHT_OWNER,borrowed,gross:CHUNK,position});
      assert.equal(r.mapped.refuse,undefined,JSON.stringify(r));
      if(r.out.admitted)borrowed+=r.out.objective.maximumExposureUsd;
    }
    results.push({position,borrowed,nominalSpare:90,minimumFraction:MIN_SPARE_FRACTION,acceptanceA:borrowed/90>=MIN_SPARE_FRACTION});
  }
  console.log('ACTUAL_PRESET_A',JSON.stringify(results));
  // This test records the incompatibility, not a passing product acceptance claim.
  assert.ok(results.every(r=>r.acceptanceA===false));
});

test('explicit owner-proposed estimates: 600000ms lag, 1.5x observed rate, a-d at all real preset dials',async t=>{
  const proposed={lag:600000,historicalRate:2,rate:1.5*2};
  const results=[];
  for(const position of ['keep_more_for_me','balanced','share_more']){
    let borrowed=0;
    for(let i=0;i<30;i++){
      const r=await admission(t,{...proposed,hours:165+i/12,owner:10,borrowed,gross:3,position});
      assert.equal(r.mapped.refuse,undefined);if(r.out.admitted)borrowed+=r.out.objective.maximumExposureUsd;
    }
    let heavyOwner=0,heavyBorrowed=0;
    for(const [hours,demand] of [[42,80],[84,10],[166,10]]){
      heavyOwner+=Math.min(demand,100-heavyOwner-heavyBorrowed);
      const r=await admission(t,{...proposed,hours,owner:heavyOwner,borrowed:heavyBorrowed,gross:2,position});
      assert.equal(r.mapped.refuse,undefined);if(r.out.admitted)heavyBorrowed+=r.out.objective.maximumExposureUsd;
    }
    const models=[];
    for(const [model,worst] of [['claude-haiku-5-5',1.32],['claude-sonnet-5-5',5.28],['claude-opus-5-5',10.56]]){
      const r=await admission(t,{...proposed,hours:.5,owner:0,gross:20,worst,position,model});
      assert.equal(r.mapped.refuse,undefined);models.push({model,admitted:r.out.admitted,
        ruleReasonCode:r.out.objective?.ruleReasonCode,reasonText:r.out.objective?.reasonText});
    }
    const cold=await admission(t,{hours:.5,owner:0,gross:20,position,lag:600000,rate:20,noHistory:true});
    assert.equal(cold.out.reason,'rule_evidence_rate_history_missing');assert.equal(cold.calls.length,0);
    results.push({position,proposedLagMs:600000,observedRate:2,proposedRate:3,borrowed,nominalSpare:90,
      acceptanceA:borrowed/90>=MIN_SPARE_FRACTION,heavyOwner,heavyBorrowed,models,
      noHistoryExplicit20Reason:cold.out.reason});
  }
  console.log('OWNER_PROPOSED_SCENARIOS',JSON.stringify(results));
  assert.ok(results.every(r=>!r.acceptanceA&&r.heavyOwner===100&&r.heavyBorrowed===0));
});

// One whole week through the real adapter, one hour at a time. The owner wants `demand(hours)` points each
// hour and gets what both meters leave; whatever it does not get is harm. One 2.89-point, 59-minute job is
// offered each hour; lent points are charged to the weekly and the current five-hour meter. The five-hour
// window resets every 5 h, so lending must spread across the week, as it would for real.
// 2.89/(59/60) + 10/168 <= 3, so the owner and the borrowers together stay inside the declared 3 points/hour.
async function replayWeek(t,{position,demand,offerUntil=167,pastWeeks=LIGHT_WEEKS}){
  let owner=0,borrowed=0,shortOwner=0,shortBorrowed=0,anchor=0,wanted=0;const jobs=[];
  const serve=want=>{const got=Math.min(want,100-owner-borrowed,100-shortOwner-shortBorrowed);wanted+=want;owner+=got;shortOwner+=got;};
  for(let hours=1;hours<=167;hours++){
    serve(demand(hours));
    const nextAnchor=Math.floor(hours/5)*5;if(nextAnchor!==anchor){anchor=nextAnchor;shortOwner=0;shortBorrowed=0;}
    if(hours>offerUntil)continue;
    const r=await admission(t,{hours,owner,borrowed,fiveHourOwner:shortOwner,fiveHourBorrowed:shortBorrowed,fiveHourAnchorH:anchor,
      gross:2.89,position,lag:600000,historicalRate:10/168,rate:3,pastWeeks,pastFiveHours:fiveHoursOf(pastWeeks),
      mutate:f=>{f.req.wall_ms=59*60_000;
        f.options.entries=jobs.flatMap(j=>IDS.map(id=>({account:ACCOUNT,window_id:id,resets_at:START+(id==='seven_day'?168:j.anchor+5)*H,
          started_at:START+j.hour*H,ended_at:START+j.hour*H+59*60_000,represented_at:START+j.hour*H+59*60_000,
          attribution:'exact',lent_pts:j.amount,lent_lower_pts:j.amount})));}});
    assert.equal(r.mapped.refuse,undefined,JSON.stringify(r.mapped));
    if(r.out.admitted){
      assert.ok(r.calls.includes('launch_chunk'));
      const amount=r.out.objective.maximumExposureUsd;jobs.push({hour:hours,anchor,amount});borrowed+=amount;shortBorrowed+=amount;
    }
  }
  serve(demand(168));
  return {position,owner,wanted,borrowed,harm:wanted-owner};
}

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
for(const position of ['keep_more_for_me','balanced','share_more']) {
  test(`REQUIRED acceptance a: light owner lends at least 80% of spare by reset at ${position}`,async t=>{
    const r=await replayWeek(t,{position,demand:()=>LIGHT_OWNER/168});
    console.log('LIGHT_WEEK',JSON.stringify(r));
    assert.ok(r.harm<1e-9,`owner left short: ${JSON.stringify(r)}`);
    assert.ok(r.borrowed/(100-r.owner)>=MIN_SPARE_FRACTION,
      `actual ${r.borrowed}; required >= ${(100-r.owner)*MIN_SPARE_FRACTION}`);
  });
  // Review 1027 F1: the owner bursts 3 points/hour (the declared bound) in the last hours of the week.
  test(`REQUIRED acceptance b: a late owner burst inside the declared rate is never short at ${position}`,async t=>{
    const r=await replayWeek(t,{position,demand:hours=>hours<=165?LIGHT_OWNER/168:3,offerUntil:164});
    console.log('LATE_BURST',JSON.stringify(r));
    assert.ok(r.harm<1e-9,`owner left short: ${JSON.stringify(r)}`);
  });
  // Review 1027 F3: eight full weeks of history; nothing is lent at the start of the week.
  test(`REQUIRED acceptance b: heavy completed weeks lend nothing at hour .5 at ${position}`,async t=>{
    const r=await admission(t,{hours:.5,owner:0,gross:3,position,lag:600000,historicalRate:1,rate:3,
      pastWeeks:Array(8).fill(100),pastFiveHours:fiveHoursOf(Array(8).fill(100))});
    assert.equal(r.mapped.refuse,undefined,JSON.stringify(r.mapped));assert.equal(r.out.admitted,false);assert.equal(r.calls.length,0);
  });
  test(`S3: Codex ratio of sums, 8 weeks: all $20 model workloads admitted at hour .5 at ${position}`,async t=>{
    const results=[];
    for(const [model,worst] of [['claude-haiku-5-5',1.32],['claude-sonnet-5-5',5.28],['claude-opus-5-5',10.56]]){
      const r=await admission(t,{hours:position==='keep_more_for_me'?KEEP_MORE_ADMISSION_HOUR:ORDINARY_ADMISSION_HOUR,owner:0,gross:20,worst,position,model,
        kappa:CODEX_RATE,lag:600000,historicalRate:2,rate:3,pastWeeks:LIGHT_WEEKS,pastFiveHours:LIGHT_FIVE_HOURS});
      assert.equal(r.mapped.refuse,undefined);results.push({model,admitted:r.out.admitted});
    }
    assert.ok(results.every(row=>row.admitted),JSON.stringify(results));
  });
}

for(const scale of [1,3]) for(const position of ['keep_more_for_me','balanced','share_more']) {
  test(`S2: owner protection at ${scale}x Codex measured rate, ${position}`,async t=>{
    const r=await admission(t,{hours:.5,owner:0,gross:20,position,lag:600000,historicalRate:1,rate:3,
      kappa:{weekly:CODEX_RATE.weekly*scale,short:CODEX_RATE.short*scale},
      pastWeeks:Array(8).fill(100),pastFiveHours:fiveHoursOf(Array(8).fill(100))});
    assert.equal(r.mapped.refuse,undefined);assert.equal(r.out.admitted,false);assert.equal(r.calls.length,0);
  });
}

for(const position of ['keep_more_for_me','balanced','share_more']) {
 test(`S3 real median Codex week: $20 Haiku/Sonnet/Opus at hour .5, ${position}`,async t=>{
   // The real data has no complete weekly meter traces. Do not manufacture completed history.
   // Replay the first half-hour's recorded USD at the measured conversion, labelled in the fixture.
   assert.equal(medianWeek.kappa.source,'Codex ratio of sums, 8 weeks');
   const dollars=medianWeek.hourly_usd[0]/2;
   for(const [model,worst] of [['claude-haiku-5-5',1.32],['claude-sonnet-5-5',5.28],['claude-opus-5-5',10.56]]) {
     const r=await admission(t,{hours:.5,owner:dollars*CODEX_RATE.weekly,fiveHourOwner:dollars*CODEX_RATE.short,
       gross:20,worst,position,model,kappa:CODEX_RATE});
     assert.equal(r.out.admitted,true,JSON.stringify(r.out));
   }
 });
}

for(const position of ['keep_more_for_me','balanced','share_more']) {
 test(`default estimate: no-log owner can lend without a conversion hold, ${position}`,async t=>{
   const r=await admission(t,{hours:.5,owner:0,gross:3,worst:1.32,position,
     kappa:{weekly:.5349,short:1.5831}});
   assert.equal(r.out.admitted,true,JSON.stringify(r.out));
 });
}

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
