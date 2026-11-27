import './helpers/no-browser.mjs';
import {RESET_JITTER_MS} from '../lib/v1/quota-registry.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createEstimatedPace50State, evaluateEstimatedPace50 as evaluateEstimatedPace50Raw, evaluateLending,
 machineCapacity, normalizeLendingPolicy,
 transitionEstimatedPace50State} from '../lib/v1/lending-policy.mjs';
import {calibration, GATES, job, MICRO, NOW, OWNER_NONE, RESET, windows} from './helpers/lending-objective-fixtures.mjs';

const M=MICRO;
const policyObjective=({now=NOW,weeklyUsedMicro=10*M,shortUsedMicro=0,requestedUsdMicro=3*M,
 friendValue=3,worstCallUsdMicro=1*M,laterBurnCapacityMicro=0,band=calibration({weeks:3})}={})=>({
 now,observedAt:now,windows:windows({weeklyUsedMicro,shortUsedMicro,resetAtMs:RESET}),band,
 owner:OWNER_NONE,gates:GATES,laterBurnCapacityMicro,
 job:job({friendValue,requestedUsdMicro,worstCallUsdMicro,estimateUsdMicro:requestedUsdMicro??3*M}),
});
const micro=1000000, hourMs=3600000, dayMs=86400000;
const week=7*dayMs;
const paceNow=Date.UTC(2026,9,22,10,0,0), paceAccount='synthetic-account';
function paceControls(patch={}) {
 return {consent:true,people:true,agents:true,schedule:true,unexpired:true,
  on:true,paused:false,owner_absent:true,...patch};
}
function paceEvidence(ids,patch={}) {
 return {complete:true,refresh_succeeded:true,subscription_only:true,bounded_execution:true,
  single_executor:true,identity_compatible:true,no_unresolved_exposure:true,resource_ids:ids,
  ...patch};
}
function paceRequest(patch={}) {
 return {attempt_id:'attempt-1',job_id:'job-1',requested_usd_micro:5*micro,
  worst_call_usd_micro:micro,wall_ms:300000,stop_ms:60000,uncertainty_ms:30000,
  expires_at:paceNow+7*dayMs,resumable:true,...patch};
}
function weeklyWindow(now=paceNow,patch={}) {
 const duration=7*dayMs,reset=now+42*hourMs;
 return {id:'weekly',kind:'weekly',instance:'weekly-instance-1',account:paceAccount,epoch:'epoch-1',
  state:'open',anchor_at:reset-duration,resets_at:reset,duration_ms:duration,observed_at:now,
  used_micro:20*micro,kappa_micro:50000,...patch};
}
function shortWindow(now=paceNow,patch={}) {
 const duration=5*hourMs,reset=now+hourMs*1.25;
 return {id:'short',kind:'short',instance:'short-instance-1',account:paceAccount,epoch:'epoch-1',
  state:'open',origin:'owner',anchor_at:reset-duration,resets_at:reset,duration_ms:duration,
  observed_at:now,used_micro:40*micro,kappa_micro:200000,...patch};
}
function paceFixture({now=paceNow,weekly=weeklyWindow(now),short=shortWindow(now),
 accountWeekId='provider-week-1',state=null,request={},controls={},evidence={}}={}) {
 const windows=[weekly,...(short?[short]:[])],ids=windows.map(w=>w.id);
 return {now,account:paceAccount,account_week_id:accountWeekId,epoch:'epoch-1',
  weekly_resource_id:'weekly',windows,state:state??createEstimatedPace50State({
   account:paceAccount,account_week_id:accountWeekId}),
  request:paceRequest(request),controls:paceControls(controls),
  evidence:paceEvidence(ids,evidence)};
}
function objectiveFor(input) {
 const ids=input.windows.map(w=>w.id),domain=ids.map(id=>id+'@decision');
 const procedure='policy-test-objective/1',weekStart=input.now;
 const band={weekStart,epoch:'policy-test-history/1',procedure,domain,
  weeks:Array.from({length:3},(_,i)=>({id:'policy-week-'+i,end:weekStart-(3-i)*week,
   epoch:'policy-test-history/1',procedure,complete:true,
   upperScores:Object.fromEntries(domain.map(key=>[key,0]))})),
  forecasts:ids.map((id,i)=>({id,domain:domain[i],prediction:0,scale:1}))};
 const need=Object.fromEntries(ids.map(id=>[id,0]));
 return {position:'balanced',band,owner:{scenarios:[{probability:1,attempts:[{need,value:0,atomic:false}]}]},
  laterBurnCapacityMicro:0,weeklyResource:input.weekly_resource_id??'weekly',
  ownerMaxJobUsdMicro:input.request.owner_max_job_usd_micro??null,
  job:{friendValue:100,estimateUsdMicro:input.request.requested_usd_micro-
    input.request.worst_call_usd_micro,
   requestedUsdMicro:input.request.requested_usd_micro,
   worstCallUsdMicro:input.request.worst_call_usd_micro,
   wallMs:input.request.wall_ms,stopMs:input.request.stop_ms,
   uncertaintyMs:input.request.uncertainty_ms}};
}
function evaluateEstimatedPace50(input,{automatic=true,objective:patch={}}={}) {
 return evaluateEstimatedPace50Raw({...input,objective:{...objectiveFor(input),...patch,automatic}});
}
function retime(input,now) {
 input.now=now;
 for(const w of input.windows){
  w.observed_at=now;
 }
 input.request.expires_at=now+7*dayMs;
 return input;
}
function applyEvent(state,event) {
 const out=transitionEstimatedPace50State(state,event,{postingLagBoundMs:0});
 assert.equal(out.applied,true,event.type+': '+out.reason);
 return out.state;
}
function finalizeReading(state,attemptId,label,at,resources) {
 const attempt=state.attempts.find(a=>a.id===attemptId);
 if(!attempt.cleanup_proven)state=applyEvent(state,{type:'cleanup_proven',event_id:`${attemptId}:cleanup-proven:${label}`,
  at,attempt_id:attemptId,cleanup_removed:true});
 const event={attempt_id:attemptId,at,observed_at:at,account:state.account,account_week_id:attempt.account_week_id,
  epoch:attempt.epoch,complete:true,compatible:true,refresh_succeeded:true,resources};
 state=applyEvent(state,{...event,type:'usage_covered',event_id:label+'-covered'});
 return applyEvent(state,{...event,type:'usage_represented',event_id:label+'-represented',
  resources:resources.map(r=>({...r,used_micro:r.used_micro+micro}))});
}
function settleQuote(input,quote,label='settle') {
 assert.equal(quote.admitted,true);
 let state=quote.proposed_state,at=input.now;
 state=applyEvent(state,{type:'launch_result',event_id:label+'-started',at:at+1,
  attempt_id:input.request.attempt_id,result:'started'});
 state=applyEvent(state,{type:'usage',event_id:label+'-usage',at:at+2,
  attempt_id:input.request.attempt_id,burn_id:label+'-burn',
  resources:quote.windows.map(w=>({id:w.id,instance:w.instance,amount_micro:w.exposure_micro}))});
 const resources=quote.windows.map(w=>{
  const baseline=input.windows.find(current=>current.id===w.id);
  return {id:w.id,instance:w.instance,anchor_at:baseline.anchor_at,resets_at:baseline.resets_at,
   used_micro:baseline.used_micro+w.exposure_micro};
 });
 state=finalizeReading(state,input.request.attempt_id,label,at+3,resources);
 return state;
}

test('represented burn stays charged across an earlier aggregate read, then capacity can be reused',()=>{
 const duration=7*dayMs,elapsed=duration*17/32,reset=paceNow+(duration-elapsed);
 const weekly=weeklyWindow(paceNow,{anchor_at:paceNow-elapsed,resets_at:reset,used_micro:5*micro});
 const input=paceFixture({weekly,short:null}),first=evaluateEstimatedPace50(input);
 assert.equal(first.admitted,true);assert.equal(first.windows[0].exposure_micro,250000);
 const state=settleQuote(input,first,'watermark');
 input.state=JSON.parse(JSON.stringify(state));input.now=paceNow+5;
 input.request.attempt_id='after-watermark';input.request.job_id='after-watermark-job';
 input.request.expires_at=input.now+7*dayMs;
 input.windows[0].used_micro=5*micro;input.windows[0].observed_at=input.now-10;
 const regressed=evaluateEstimatedPace50(input);
 assert.equal(regressed.admitted,false);assert.equal(regressed.reason,'aggregate_observation_regressed');
 assert.deepEqual(regressed.effects,[{type:'request_fresh_complete_read',resource_id:'weekly'}]);
 input.windows[0].used_micro=6250000;input.windows[0].observed_at=input.now;
 const current=evaluateEstimatedPace50(input);
 assert.equal(current.admitted,true,current.reason);
 assert.equal(current.windows[0].exposure_micro,250000);
});
test('objective candidate requires exact account-week identity and a verified rollover',()=>{
 const input=paceFixture({short:null}),quote=evaluateEstimatedPace50(input);
 assert.equal(quote.admitted,true,quote.reason);
 let state=settleQuote(input,quote,'week-1');
 const nextNow=input.windows[0].resets_at+10;
 const nextReset=input.windows[0].resets_at+7*dayMs;
 const nextWeek=`${paceAccount}:weekly:${nextReset}`;
 const wrongWeek=paceFixture({short:null,state,accountWeekId:nextWeek,now:nextNow});
 retime(wrongWeek,paceNow+10);
 assert.equal(evaluateEstimatedPace50(wrongWeek).reason,'account_week_identity');
 const denied=transitionEstimatedPace50State(state,{type:'advance_account_week',
  event_id:'week-unverified',at:paceNow+10,account_week_id:nextWeek,
  account_week_mapping_known:false});
 assert.equal(denied.applied,false);assert.equal(denied.reason,'account_week_identity');
 state=applyEvent(state,{type:'advance_account_week',event_id:'week-verified',at:nextNow,
  account_week_id:nextWeek,account_week_mapping_known:true,account:paceAccount,weekly_account_id:paceAccount,
  weekly_resource_id:input.windows[0].id,weekly_resets_at:nextReset});
 assert.equal(state.account_week_id,nextWeek);
 const next=paceFixture({weekly:weeklyWindow(nextNow,{resets_at:nextReset,anchor_at:nextReset-7*dayMs}),short:null,state,accountWeekId:nextWeek,now:nextNow,
  request:{attempt_id:'week-2-attempt'}});
 retime(next,nextNow);
 assert.equal(evaluateEstimatedPace50(next).admitted,true);
});
test('usage moves represented holds into spent without double-subtracting the aggregate',()=>{
 const input=paceFixture(),quote=evaluateEstimatedPace50(input);
 let state=applyEvent(quote.proposed_state,{type:'launch_result',event_id:'started',at:paceNow+2,
  attempt_id:'attempt-1',result:'started'});
 state=applyEvent(state,{type:'usage',event_id:'burned',at:paceNow+3,
  attempt_id:'attempt-1',burn_id:'burn-1',resources:[
   {id:'weekly',instance:'weekly-instance-1',amount_micro:250000},
   {id:'short',instance:'short-instance-1',amount_micro:micro}]});
 state=finalizeReading(state,'attempt-1','burn-final',paceNow+4,state.attempts[0].resources.map(r=>({id:r.id,instance:r.instance,
  anchor_at:r.anchor_at,resets_at:r.resets_at,used_micro:r.baseline_used_micro+r.spent_micro})));
 const next=paceFixture({state,now:paceNow+5});
 next.windows[0].used_micro+=250000+micro;next.windows[1].used_micro+=2*micro;
 next.request.attempt_id='second';
 retime(next,paceNow+5);
 const out=evaluateEstimatedPace50(next);
 assert.equal(out.admitted,true,out.reason);
 assert.equal(out.windows[0].slack_micro,100*micro-next.windows[0].used_micro);
 assert.equal(out.proposed_state.attempts[0].resources[0].held_micro,0);
});
test('settled chunks can be lent again from released headroom in the same hour and task',()=>{
 const input=paceFixture({short:null,weekly:weeklyWindow(paceNow,{kappa_micro:micro}),
  request:{requested_usd_micro:5*micro,worst_call_usd_micro:micro}});
 const task=input.request.job_id;
 const runChunk=(attemptId,at)=>{
  input.request.attempt_id=attemptId;input.now=at;input.request.expires_at=at+7*dayMs;
  input.windows[0].observed_at=at;
  const quote=evaluateEstimatedPace50(input);
  assert.equal(quote.admitted,true,quote.reason);
  assert.equal(quote.windows[0].exposure_micro,5*micro);
  const previousUsed=input.windows[0].used_micro;
  input.state=settleQuote(input,quote,attemptId);
  input.windows[0].used_micro=previousUsed+quote.windows[0].exposure_micro+micro;
  assert.equal(input.request.job_id,task);
  return quote;
 };
 runChunk('same-task-1',paceNow);
 runChunk('same-task-2',paceNow+20*60000);
 runChunk('same-task-3',paceNow+40*60000);
 assert.equal(input.windows[0].used_micro,38*micro);
});
// Startup lane review (P1): the migrated policy reaches the allocator. The owner's per-job point cap (perJobPct) and the
// fixed_share and custom ceilings bound what one admitted job may reserve. Each ceiling is a USD cap on the job's gross
// spend, converted at the weekly window's own conversion (0.05 points per USD in this fixture: 0.1 points is 2 USD).
// Chunk candidates let the engine choose the largest chunk under a binding cap. Without them a binding cap holds the job
// (objective_exceeds_spare), which is the engine's rule that a partial job is refused.
// Each chunk is larger than the worst-case call (1.32 USD in this fixture), or the engine refuses it (a negative usdMicro throws).
const CHUNKS=[{id:'c1',usdMicro:1500000,friendValue:1},{id:'c2',usdMicro:2000000,friendValue:2},
 {id:'c3',usdMicro:3000000,friendValue:3},{id:'c4',usdMicro:4000000,friendValue:4}];
function quoteUnder(policy,{request={},weekly}={}) {
 const input=paceFixture({request,weekly}),objective=objectiveFor(input);
 return evaluateEstimatedPace50Raw({...input,objective:{...objective,strategy:policy.strategy,strategyParams:policy.strategyParams,
  job:{...objective.job,chunkCandidates:CHUNKS}}});
}
// The advertised defaults (fixedSharePct 20, keepPct 30) apply when the owner chooses fixed_share without numbers.
// The integrator throws 'expected loss unresolved' when its two panel resolutions disagree by more than the tolerance
// (v1-lending-expected-loss.test.mjs covers that throw). No state tried so far produces it: the largest error measured over 96
// binding states was 1.7e-8, against a tolerance of 1e-6. So this test raises the same error where it escapes the evaluation,
// from a read of the objective inside the policy's try, and checks the catch that names the hold.
function objectiveThrowingOnPosition(input,error) {
 return Object.defineProperty(objectiveFor(input),'position',{enumerable:true,get(){throw error;}});
}
// Measured bound (0 ms posting lag here): the reconciliation covers the burn, and a second cessation with a new id changes nothing.
test('at a measured bound, unrepresented burn stays held until attributed reconciliation; a duplicate settlement cannot refund twice',()=>{
 const input=paceFixture({short:null}),quote=evaluateEstimatedPace50(input);
 let state=applyEvent(quote.proposed_state,{type:'launch_result',event_id:'start-weekly',
  at:paceNow+1,attempt_id:'attempt-1',result:'started'});
 state=applyEvent(state,{type:'usage',event_id:'unrepresented-use',at:paceNow+2,
  attempt_id:'attempt-1',burn_id:'burn-hidden',resources:[
   {id:'weekly',instance:'weekly-instance-1',amount_micro:125000}]});
 assert.equal(state.attempts[0].resources[0].held_micro,125000);
 assert.equal(state.attempts[0].resources[0].unrepresented_micro,125000);
 const cannotSettle=transitionEstimatedPace50State(state,{type:'cessation_proven',
  event_id:'false-reconcile',at:paceNow+3,attempt_id:'attempt-1',
  authoritative_cessation:true,usage_reconciled:true});
 assert.equal(cannotSettle.applied,false);assert.equal(cannotSettle.reason,'cessation_unreconciled');
 const aggregateTooSmall=transitionEstimatedPace50State(state,{type:'reconcile_burn',
  event_id:'aggregate-did-not-include-burn',at:paceNow+4,observed_at:paceNow+4,
  attempt_id:'attempt-1',burn_id:'burn-hidden',account:paceAccount,epoch:'epoch-1',
  complete:true,compatible:true,refresh_succeeded:true,attribution_confirmed:true,
  resources:[{id:'weekly',instance:'weekly-instance-1',anchor_at:paceNow-126*hourMs,
   resets_at:paceNow+42*hourMs,used_micro:20*micro+124999}]});
 assert.equal(aggregateTooSmall.applied,false);
 assert.equal(aggregateTooSmall.reason,'reconciliation_mismatch');
 assert.equal(state.attempts[0].resources[0].unrepresented_micro,125000);
 // A matching aggregate in reconcile_burn alone does not cover the burn; coverage comes through usage_covered.
 const reconciled=transitionEstimatedPace50State(state,{type:'reconcile_burn',event_id:'attributed-burn',
  at:paceNow+4,observed_at:paceNow+4,attempt_id:'attempt-1',burn_id:'burn-hidden',
  account:paceAccount,epoch:'epoch-1',complete:true,compatible:true,refresh_succeeded:true,
  attribution_confirmed:true,resources:[{id:'weekly',instance:'weekly-instance-1',
   anchor_at:paceNow-126*hourMs,resets_at:paceNow+42*hourMs,
   used_micro:20*micro+125000}]});
 assert.equal(reconciled.applied,false);assert.equal(reconciled.reason,'usage_coverage_unavailable');
 const final=finalizeReading(state,'attempt-1','partial-final',paceNow+5,state.attempts[0].resources.map(r=>({id:r.id,instance:r.instance,anchor_at:r.anchor_at,resets_at:r.resets_at,used_micro:r.baseline_used_micro+125000})));
 state=final;
 assert.equal(state.attempts[0].resources[0].unrepresented_micro,0);
 const duplicate=transitionEstimatedPace50State(state,{type:'cessation_proven',
  event_id:'double-cease',at:paceNow+6,attempt_id:'attempt-1',
  authoritative_cessation:true,usage_reconciled:true});
 assert.equal(duplicate.applied,false);assert.equal(duplicate.reason,'cessation_unreconciled');
 assert.equal(state.attempts[0].resources[0].released_micro,0,'the additive charge exceeds the unused 125000 hold');
});
