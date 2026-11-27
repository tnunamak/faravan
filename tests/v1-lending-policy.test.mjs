import './helpers/no-browser.mjs';
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
test('the policy wrapper delegates to the objective and holds when objective evidence is absent',()=>{
 const missing=evaluateLending();
 assert.equal(missing.admitted,false);assert.equal(missing.reason,'objective_evidence_unknown');
 assert.equal(missing.objective,null);
 const out=evaluateLending({objectiveInput:policyObjective()});
 assert.equal(out.admitted,true);assert.equal(out.reason,'lend');
 assert.equal(out.objective.policyVersion,'objective/m1');
 assert.equal(out.budget_units,2);
});
test('automatic typed strategies keep the forecast reserve when it binds before their share ceiling',()=>{
 const objectiveInput=policyObjective({band:calibration({score:100,forecast:0,weeks:19})});
 objectiveInput.windows.seven_day.lentMicro=0;
 objectiveInput.windows.five_hour.lentMicro=0;
 const policies=[
  {strategy:'fixed_share',strategyParams:{fixedSharePct:80,keepPct:0}},
  {strategy:'custom',strategyParams:{e0:0.2}},
 ];
 for(const policy of policies){
  const out=evaluateLending({objectiveInput,policy});
  assert.equal(out.admitted,false,`${policy.strategy}: ${out.reason}`);
  assert.equal(out.reason,'owner_reserve',`${policy.strategy} must keep the owner's forecast reserve`);
  assert.equal(out.objective.strategyId,policy.strategy);
  assert.deepEqual(out.objective.protectionSource,{seven_day:'history',five_hour:'history'});
 }
});
test('a fixed-share cap names the lending setting that blocks a request',()=>{
 const objectiveInput=policyObjective();
 objectiveInput.windows.seven_day.lentMicro=18*M;
 objectiveInput.windows.five_hour.lentMicro=0;
 const out=evaluateLending({objectiveInput,policy:{strategy:'fixed_share',strategyParams:{fixedSharePct:20,keepPct:30}}});
 assert.equal(out.admitted,false);
 assert.equal(out.reason,'strategy_limit');
 assert.equal(out.objective.reasonCode,'objective_strategy_limit');
 assert.match(out.objective.reasonText,/limit you set for this lending strategy/);
});
test('a fixed-share ceiling below one call names the strategy, not the per-job limit',()=>{
 const objectiveInput={...policyObjective({requestedUsdMicro:null,worstCallUsdMicro:5.28*M}),automatic:false};
 objectiveInput.job={...objectiveInput.job,model:'claude-sonnet-5-5',minimumMaxJobUsd:5.29};
 objectiveInput.windows.seven_day.lentMicro=0;
 objectiveInput.windows.five_hour.lentMicro=0;
 const out=evaluateLending({objectiveInput,policy:{strategy:'fixed_share',strategyParams:{fixedSharePct:3,keepPct:0}}});
 assert.equal(out.reason,'budget_too_small');
 assert.equal(out.budgetLimit.source,'strategy');
 assert.match(out.objective.reasonText,/limit you set for this lending strategy allows \$3\.00 for this job/);
 assert.doesNotMatch(out.objective.reasonText,/per-job limit/);
});
test('the production wrapper rounds typed share ceilings down',()=>{
 for(const [fixedSharePct,keepPct,expected] of [
  [20.0000006,0,20_000_000],
  [100,30.0000004,69_999_999],
  [20,30,20_000_000],
 ]){
  const objectiveInput=policyObjective({weeklyUsedMicro:0,shortUsedMicro:0,
   requestedUsdMicro:null,worstCallUsdMicro:0,friendValue:100});
  objectiveInput.windows.seven_day.lentMicro=0;
  objectiveInput.windows.five_hour.lentMicro=0;
  const out=evaluateLending({objectiveInput,policy:{strategy:'fixed_share',
   strategyParams:{fixedSharePct,keepPct,perJobPct:100}}});
  assert.equal(out.admitted,true,out.reason);
  assert.equal(out.exposureUsdMicro,expected,`${fixedSharePct}% share, ${keepPct}% kept`);
  assert.equal(out.reservePointsMicro.seven_day,expected);
 }
});
test('Keep more for me is the default dial and follows the objective at either end of a window',()=>{
 assert.equal(normalizeLendingPolicy().protectionPosition,'keep_more_for_me');
 const early=policyObjective({now:RESET-6*86400000,weeklyUsedMicro:0,shortUsedMicro:0});
 const late={...early,now:RESET-10*60000,observedAt:RESET-10*60000,
  windows:windows({weeklyUsedMicro:0,shortUsedMicro:0,resetAtMs:RESET})};
 const a=evaluateLending({objectiveInput:early}),b=evaluateLending({objectiveInput:late});
 assert.equal(a.admitted,true);assert.equal(b.admitted,true);
 assert.equal(a.objective.maximumExposureUsd,b.objective.maximumExposureUsd);
 assert.equal(a.objective.lambda,10);assert.equal(a.objective.epsilon,.10);
});
test('objective uses a safe finish before the earliest reset and rejects unknown conversion',()=>{
 const tooLate=policyObjective({now:RESET-60_000});
 assert.equal(evaluateLending({objectiveInput:tooLate}).reason,'reset');
 const unknown=policyObjective();unknown.windows.seven_day.pointsPerUsdMicro=0;
 assert.equal(evaluateLending({objectiveInput:unknown}).reason,'usage_unknown');
});
test('machine cap respects CPU and RAM',()=>{
 assert.equal(machineCapacity({ramBytes:16*1024**3,cpus:8,memoryMb:4096,cpu:2}),3);
 assert.equal(machineCapacity({ramBytes:2*1024**3,cpus:2,memoryMb:2048,cpu:2}),0);
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
 const out=transitionEstimatedPace50State(state,event);
 assert.equal(out.applied,true,event.type+': '+out.reason);
 return out.state;
}
function recordUsageAndCleanup(input,quote,label='settle') {
 assert.equal(quote.admitted,true);
 let state=quote.proposed_state,at=input.now;
 state=applyEvent(state,{type:'launch_result',event_id:label+'-started',at:at+1,
  attempt_id:input.request.attempt_id,result:'started'});
 const usageAt=at+2;
 state=applyEvent(state,{type:'usage',event_id:label+'-usage',at:usageAt,
  attempt_id:input.request.attempt_id,burn_id:label+'-burn',
  resources:quote.windows.map(w=>({id:w.id,instance:w.instance,
   amount_micro:w.exposure_micro}))});
 return applyEvent(state,{type:'cleanup_proven',event_id:`${input.request.attempt_id}:cleanup-proven:1`,at:usageAt+2,
  attempt_id:input.request.attempt_id,cleanup_removed:true});
}

test('objective admission reserves the selected total spend across every linked resource',()=>{
 const input=paceFixture(),before=structuredClone(input),out=evaluateEstimatedPace50(input);
 assert.equal(out.admitted,true,out.reason);assert.equal(out.reason,'objective_lend');
 assert.equal(out.budget_micro,5*micro);assert.equal(out.native_budget_micro,4*micro);
 assert.deepEqual(out.windows.map(w=>w.exposure_micro),[250000,micro]);
 assert.equal(out.proposed_state.attempts[0].resources[1].held_micro,micro);
 assert.equal(out.effects[0].type,'persist_proposed_state_before_provider_action');
 assert.deepEqual(input,before);
});
test('objective holds when spare cannot cover the worst call, with no minimum quote',()=>{
 const input=paceFixture({short:null,request:{requested_usd_micro:micro,worst_call_usd_micro:micro}});
 const out=evaluateEstimatedPace50(input);
 assert.equal(out.admitted,false);assert.equal(out.reason,'budget_too_small');
 assert.equal(out.native_budget_micro,0);assert.deepEqual(out.proposed_state,input.state);
});
test('objective chunk size follows spare and the job request without old volume ceilings',()=>{
 const input=paceFixture({request:{requested_usd_micro:51*micro,worst_call_usd_micro:micro,
  wall_ms:10*60000}});
 const out=evaluateEstimatedPace50(input);
 assert.equal(out.admitted,true,out.reason);assert.equal(out.native_budget_micro,50*micro);
 assert.deepEqual(out.windows.map(w=>w.exposure_micro),[2550000,10200000]);
});
test('an aggregate reading cannot release a converted burn before its window reset',()=>{
 const duration=7*dayMs,elapsed=duration*17/32,reset=paceNow+(duration-elapsed);
 const weekly=weeklyWindow(paceNow,{anchor_at:paceNow-elapsed,resets_at:reset,used_micro:5*micro});
 const input=paceFixture({weekly,short:null}),first=evaluateEstimatedPace50(input);
 assert.equal(first.admitted,true);assert.equal(first.windows[0].exposure_micro,250000);
 const state=recordUsageAndCleanup(input,first,'watermark');
 input.state=JSON.parse(JSON.stringify(state));input.now=paceNow+5;
 input.request.attempt_id='after-watermark';input.request.job_id='after-watermark-job';
 input.request.expires_at=input.now+7*dayMs;
 input.windows[0].used_micro=5*micro;input.windows[0].observed_at=input.now-10;
 const regressed=evaluateEstimatedPace50(input);
 assert.equal(regressed.admitted,false);assert.equal(regressed.reason,'aggregate_observation_regressed');
 assert.deepEqual(regressed.effects,[{type:'request_fresh_complete_read',resource_id:'weekly'}]);
 input.windows[0].used_micro=5250000;input.windows[0].observed_at=input.now;
 const current=evaluateEstimatedPace50(input);
 assert.equal(current.admitted,true,current.reason);
 const retained=current.proposed_state.attempts.find(attempt=>attempt.id==='attempt-1').resources[0];
 assert.equal(retained.held_micro+retained.unrepresented_micro,first.windows[0].exposure_micro);
 assert.equal(retained.released_micro,0);
});
test('objective admission stops before the earliest reset with the proven stop and uncertainty margin',()=>{
 const input=paceFixture(),out=evaluateEstimatedPace50(input);
 assert.equal(out.admitted,true,out.reason);
 const earliest=Math.min(...input.windows.map(w=>w.resets_at));
 input.now=earliest-input.request.wall_ms-input.request.stop_ms-input.request.uncertainty_ms;
 input.windows.forEach(w=>{w.observed_at=input.now;});
 const exact=evaluateEstimatedPace50(input);
 assert.equal(exact.admitted,false);assert.equal(exact.reason,'resource_reset_margin');
 input.now--;
 input.windows.forEach(w=>{w.observed_at=input.now;});
 assert.equal(evaluateEstimatedPace50(input).admitted,true);
});
test('objective candidate requires exact account-week identity and a verified rollover',()=>{
 const input=paceFixture({short:null}),quote=evaluateEstimatedPace50(input);
 assert.equal(quote.admitted,true,quote.reason);
 let state=recordUsageAndCleanup(input,quote,'week-1');
 const nextNow=input.windows[0].resets_at+10;
 const nextReset=input.windows[0].resets_at+7*dayMs;
 const nextWeekId=`${paceAccount}:weekly:${nextReset}`;
 const wrongWeek=paceFixture({short:null,state,accountWeekId:nextWeekId,now:nextNow});
 retime(wrongWeek,paceNow+10);
 assert.equal(evaluateEstimatedPace50(wrongWeek).reason,'account_week_identity');
 const denied=transitionEstimatedPace50State(state,{type:'advance_account_week',
  event_id:'week-unverified',at:paceNow+10,account_week_id:nextWeekId,
  account_week_mapping_known:false});
 assert.equal(denied.applied,false);assert.equal(denied.reason,'account_week_identity');
 state=applyEvent(state,{type:'advance_account_week',event_id:'week-verified',at:nextNow,
  account_week_id:nextWeekId,account_week_mapping_known:true,account:paceAccount,weekly_account_id:paceAccount,
  weekly_resource_id:input.windows[0].id,weekly_resets_at:nextReset});
 assert.equal(state.account_week_id,nextWeekId);
 const next=paceFixture({weekly:weeklyWindow(nextNow,{resets_at:nextReset,anchor_at:nextReset-7*dayMs}),short:null,state,accountWeekId:nextWeekId,now:nextNow,
  request:{attempt_id:'week-2-attempt'}});
 retime(next,nextNow);
 const nextWeek=evaluateEstimatedPace50(next);
 assert.equal(nextWeek.admitted,false,nextWeek.reason);
 assert.equal(nextWeek.reason,'cross_window_exposure_unreconciled');
});
test('JSON restart preserves an ambiguous launch reservation across a window reset',()=>{
 const input=paceFixture(),quote=evaluateEstimatedPace50(input);
 assert.equal(quote.admitted,true,quote.reason);
 const persisted=JSON.parse(JSON.stringify(quote.proposed_state));
 assert.deepEqual(persisted,quote.proposed_state);
 const failed=applyEvent(persisted,{type:'launch_result',event_id:'ambiguous-launch',
  at:paceNow+1,attempt_id:'attempt-1',result:'failed'});
 const state=JSON.parse(JSON.stringify(failed));
 assert.deepEqual(state.attempts[0].resources.map(r=>r.held_micro),
  quote.windows.map(w=>w.exposure_micro));
 const retry=paceFixture({state,now:shortWindow(paceNow).resets_at+1,
  request:{attempt_id:'retry'}});
 retry.epoch='epoch-2';retry.windows.forEach(w=>{w.epoch='epoch-2';});
 retry.windows[1].instance='short-instance-2';
 retry.windows[1].anchor_at=shortWindow(paceNow).resets_at;
 retry.windows[1].resets_at=retry.windows[1].anchor_at+5*hourMs;
 retry.windows[1].used_micro=0;
 retime(retry,retry.now);
 const fenced=evaluateEstimatedPace50(retry);
 assert.equal(fenced.admitted,false);
 assert.equal(fenced.reason,'cross_window_exposure_unreconciled');
 assert.deepEqual(state.attempts[0].resources.map(r=>r.held_micro),
  quote.windows.map(w=>w.exposure_micro));
});
test('late acknowledgement keeps its reservation when a fresh aggregate has no coverage proof',()=>{
 const input=paceFixture(),quote=evaluateEstimatedPace50(input);
 assert.equal(quote.admitted,true,quote.reason);
 let state=JSON.parse(JSON.stringify(quote.proposed_state));
 const late=transitionEstimatedPace50State(state,{type:'late_ack',event_id:'late-ack',
  at:paceNow+1,attempt_id:'attempt-1'});
 assert.equal(late.applied,true);assert.equal(late.state.attempts[0].late_ack_unresolved,true);
 assert.ok(late.effects.some(effect=>effect.type==='request_cessation'));
 assert.ok(late.effects.some(effect=>effect.type==='request_fresh_complete_reconciliation'));
 state=JSON.parse(JSON.stringify(late.state));
 const reserved=quote.windows.map(row=>row.exposure_micro);
 assert.deepEqual(state.attempts[0].resources.map(resource=>resource.held_micro),reserved);
 const attempt=state.attempts[0];
 const reconciled=transitionEstimatedPace50State(state,{type:'cessation_proven',event_id:'late-cessation-proof',
  at:paceNow+3,observed_at:paceNow+3,attempt_id:'attempt-1',authoritative_cessation:true,
  usage_reconciled:true,complete:true,compatible:true,refresh_succeeded:true,
  resources:attempt.resources.map(resource=>({id:resource.id,instance:resource.instance,
   anchor_at:resource.anchor_at,resets_at:resource.resets_at,used_micro:resource.baseline_used_micro}))});
 assert.equal(reconciled.applied,false);
 assert.equal(reconciled.reason,'usage_coverage_unavailable');
 assert.deepEqual(reconciled.state.attempts[0].resources.map(r=>r.held_micro),reserved);
 assert.ok(reconciled.state.attempts[0].late_ack_unresolved);

});
test('cross-reset settlement retains exposure on resources whose own window is still open',()=>{
 const input=paceFixture(),quote=evaluateEstimatedPace50(input);
 let state=applyEvent(quote.proposed_state,{type:'launch_result',event_id:'cross-started',at:paceNow+2,
  attempt_id:input.request.attempt_id,result:'started'});
 state=applyEvent(state,{type:'late_ack',event_id:'cross-late-ack',at:paceNow+3,
  attempt_id:input.request.attempt_id});
 state=JSON.parse(JSON.stringify(state));
 const attempt=state.attempts[0],old=attempt.resources;
 const originalShort=old.find(resource=>resource.kind==='short');
 const observedAt=originalShort.resets_at+60001;
 const currentWeeklyAnchor=observedAt-126*hourMs;
 const identity=resource=>({id:resource.id,instance:resource.instance,epoch:resource.epoch,
  anchor_at:resource.anchor_at,resets_at:resource.resets_at});
 const oldCharges=old.map(resource=>({...identity(resource),kind:resource.kind,
  kappa_micro:resource.kappa_micro,charged_micro:resource.kind==='weekly'?125000:500000}));
 const currentResources=[
  {id:'weekly',instance:'weekly-instance-2',epoch:'epoch-2',kind:'weekly',
   anchor_at:currentWeeklyAnchor,resets_at:currentWeeklyAnchor+7*dayMs,duration_ms:7*dayMs,
   baseline_used_micro:0,used_micro:125000,kappa_micro:75000,
   charged_micro:125000,cumulative_charged_micro:125000,
   source_resource_ids:[identity(old[0])]},
  {id:'short',instance:'short-instance-2',epoch:'epoch-2',kind:'short',
   anchor_at:originalShort.resets_at,resets_at:originalShort.resets_at+5*hourMs,
   duration_ms:5*hourMs,baseline_used_micro:0,used_micro:250000,kappa_micro:300000,
   charged_micro:250000,cumulative_charged_micro:250000,
   source_resource_ids:[identity(originalShort)]},
 ];
 const displayRead=transitionEstimatedPace50State(state,{type:'cessation_proven',
  event_id:'current-display-is-not-settlement',at:observedAt,observed_at:observedAt,
  attempt_id:attempt.id,authoritative_cessation:true,usage_reconciled:true,complete:true,
  compatible:true,refresh_succeeded:true,resources:currentResources.map(resource=>({
   id:resource.id,instance:resource.instance,anchor_at:resource.anchor_at,
   resets_at:resource.resets_at,used_micro:resource.used_micro}))});
 assert.equal(displayRead.applied,false);assert.equal(displayRead.reason,'late_ack_reconciliation_mismatch');
 assert.deepEqual(state.attempts[0].resources.map(resource=>resource.held_micro),[250000,micro]);
 const event={type:'cross_reset_reconciled',event_id:'cross-reset-settled',
  settlement_id:'provider-settlement-1',previous_settlement_id:null,at:observedAt,
  observed_at:observedAt,attempt_id:attempt.id,account:input.account,
  account_week_id:input.account_week_id,authoritative_cessation:true,usage_reconciled:true,
  complete:true,compatible:true,refresh_succeeded:true,attribution_confirmed:true,
  resource_ids:['weekly','short'],old_charges:oldCharges,resources:currentResources};
 const currentDisplayOnly=transitionEstimatedPace50State(state,{...event,
  event_id:'display-only-reset',settlement_id:'display-only-settlement',attribution_confirmed:false});
 assert.equal(currentDisplayOnly.applied,false);
 assert.equal(currentDisplayOnly.reason,'cross_reset_reconciliation_incomplete');
 assert.deepEqual(state.attempts[0].resources.map(resource=>resource.held_micro),[250000,micro]);
 const missingResource=transitionEstimatedPace50State(state,{...event,event_id:'missing-reset-resource',
  settlement_id:'missing-reset-settlement',resource_ids:['weekly'],resources:[currentResources[0]]});
 assert.equal(missingResource.applied,false);assert.equal(missingResource.reason,'cross_reset_resource_mapping');
 const unknownMap=structuredClone(event);unknownMap.event_id='unknown-reset-map';
 unknownMap.settlement_id='unknown-map-settlement';unknownMap.resources[1].source_resource_ids[0].instance='unknown';
 assert.equal(transitionEstimatedPace50State(state,unknownMap).reason,'cross_reset_resource_mapping');
 const aggregateTooSmall=structuredClone(event);aggregateTooSmall.event_id='small-reset-aggregate';
 aggregateTooSmall.settlement_id='small-aggregate-settlement';aggregateTooSmall.resources[0].used_micro--;
 assert.equal(transitionEstimatedPace50State(state,aggregateTooSmall).reason,
  'cross_reset_reconciliation_mismatch');

 const ownerRelease=transitionEstimatedPace50State(state,{type:'owner_release_hold',
  event_id:`${attempt.id}:owner-release-hold`,at:state.updated_at+1,attempt_id:attempt.id,confirmed:true});
 assert.equal(ownerRelease.applied,true);
 const afterRelease=structuredClone(ownerRelease.state);
 const refundAfterRelease=transitionEstimatedPace50State(ownerRelease.state,event);
 assert.equal(refundAfterRelease.applied,false,'owner recovery must refuse an otherwise valid partial refund');
 assert.equal(refundAfterRelease.reason,'manual_full_charge_pending');
 assert.deepEqual(refundAfterRelease.state,afterRelease);
 assert.deepEqual(ownerRelease.state,afterRelease);

 state=applyEvent(state,event);
 state=JSON.parse(JSON.stringify(state));
 const settled=state.attempts[0];
 assert.equal(settled.late_ack_unresolved,true);assert.equal(settled.process_state,'unknown');
 assert.deepEqual(settled.resources.map(resource=>resource.settled_micro),[0,500000]);
 assert.deepEqual(settled.resources.map(resource=>resource.released_micro),[0,500000]);
 assert.equal(settled.recoveries[0].resources[0].kappa_micro,75000);
 assert.equal(settled.resources[0].kappa_micro,50000);

 const delayedStart=applyEvent(state,{type:'launch_result',event_id:'cross-late-start',
  at:event.at+1,attempt_id:attempt.id,result:'started'});
 assert.equal(delayedStart.attempts[0].late_ack_unresolved,true);
 assert.deepEqual(delayedStart.attempts[0].resources.map(resource=>resource.held_micro),
  [250000,500000]);
 const secondSettlement={...event,event_id:'cross-reset-settled-again',
  settlement_id:'provider-settlement-2',previous_settlement_id:'provider-settlement-1',
  at:event.at+2,observed_at:event.at+2,
  resources:currentResources.map(resource=>({...resource,charged_micro:0}))};
 state=applyEvent(delayedStart,secondSettlement);
 state=JSON.parse(JSON.stringify(state));
 assert.equal(state.attempts[0].recoveries.length,2);
 assert.equal(state.attempts[0].late_ack_unresolved,true);
 assert.deepEqual(state.attempts[0].resources.map(resource=>resource.settled_micro),[0,500000]);
 assert.deepEqual(state.attempts[0].resources.map(resource=>resource.held_micro),[250000,0]);

 const resumeAt=event.at+3*hourMs;
 input.state=state;input.now=resumeAt;input.request.attempt_id='cross-reset-resume';
 input.epoch='epoch-2';
 input.request.job_id='cross-reset-resume-job';input.request.expires_at=resumeAt+7*dayMs;
 input.windows=currentResources.map(resource=>({id:resource.id,kind:resource.kind,
  instance:resource.instance,account:input.account,epoch:resource.epoch,state:'open',
  origin:resource.kind==='short'?'owner':undefined,anchor_at:resource.anchor_at,
  resets_at:resource.resets_at,duration_ms:resource.duration_ms,observed_at:resumeAt,
  used_micro:resource.used_micro,kappa_micro:resource.kappa_micro}));
 const resumed=evaluateEstimatedPace50(input);
 assert.equal(resumed.admitted,false);
 assert.equal(resumed.reason,'cross_window_exposure_unreconciled');
});
test('a converted usage report stays unresolved without interval coverage',()=>{
 const input=paceFixture(),quote=evaluateEstimatedPace50(input);
 let state=applyEvent(quote.proposed_state,{type:'launch_result',event_id:'started',at:paceNow+2,
  attempt_id:'attempt-1',result:'started'});
 state=applyEvent(state,{type:'usage',event_id:'burned',at:paceNow+3,
  attempt_id:'attempt-1',burn_id:'burn-1',resources:[
   {id:'weekly',instance:'weekly-instance-1',amount_micro:250000},
   {id:'short',instance:'short-instance-1',amount_micro:micro}]});
 const uncovered=transitionEstimatedPace50State(state,{type:'reconcile_burn',event_id:'burn-attributed',at:paceNow+4,
  observed_at:paceNow+4,attempt_id:'attempt-1',burn_id:'burn-1',account:paceAccount,
  epoch:'epoch-1',complete:true,compatible:true,refresh_succeeded:true,attribution_confirmed:true,
  resources:[{id:'weekly',instance:'weekly-instance-1',anchor_at:input.windows[0].anchor_at,
   resets_at:paceNow+42*hourMs,used_micro:20*micro+250000},
   {id:'short',instance:'short-instance-1',anchor_at:input.windows[1].anchor_at,
    resets_at:input.windows[1].resets_at,used_micro:input.windows[1].used_micro+micro}]});
 assert.equal(uncovered.applied,false);
 assert.equal(uncovered.reason,'usage_coverage_unavailable');
 for(const r of state.attempts[0].resources) {
  assert.equal(r.held_micro+r.unrepresented_micro,r.initial_micro);
  assert.equal(r.released_micro,0);
 }
 const next=paceFixture({state,now:paceNow+5});
 next.windows[0].used_micro+=250000;next.windows[1].used_micro+=micro;
 next.request.attempt_id='second';
 retime(next,paceNow+5);
 const out=evaluateEstimatedPace50(next);
 assert.equal(out.admitted,false,out.reason);
 assert.equal(out.reason,'cross_window_exposure_unreconciled');
 assert.equal(out.proposed_state.attempts[0].resources[0].held_micro+
  out.proposed_state.attempts[0].resources[0].unrepresented_micro,quote.windows[0].exposure_micro);
});
test('unrepresented burn stays held when an aggregate rise matches it',()=>{
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
 const reconciled=transitionEstimatedPace50State(state,{type:'reconcile_burn',event_id:'attributed-burn',
  at:paceNow+4,observed_at:paceNow+4,attempt_id:'attempt-1',burn_id:'burn-hidden',
  account:paceAccount,epoch:'epoch-1',complete:true,compatible:true,refresh_succeeded:true,
  attribution_confirmed:true,resources:[{id:'weekly',instance:'weekly-instance-1',
   anchor_at:paceNow-126*hourMs,resets_at:paceNow+42*hourMs,
   used_micro:20*micro+125000}]});
 assert.equal(reconciled.applied,false);
 assert.equal(reconciled.reason,'usage_coverage_unavailable');
 assert.equal(state.attempts[0].resources[0].unrepresented_micro,125000);
 assert.equal(state.attempts[0].resources[0].held_micro+state.attempts[0].resources[0].unrepresented_micro,
  state.attempts[0].resources[0].initial_micro);
 assert.equal(state.attempts[0].resources[0].released_micro,0);
});
test('with no measured bound, a repeated reconcile_burn covers nothing and the burn never refunds',()=>{
 const input=paceFixture({short:null}),quote=evaluateEstimatedPace50(input);
 let state=applyEvent(quote.proposed_state,{type:'launch_result',event_id:'start-weekly',
  at:paceNow+1,attempt_id:'attempt-1',result:'started'});
 state=applyEvent(state,{type:'usage',event_id:'unrepresented-use',at:paceNow+2,
  attempt_id:'attempt-1',burn_id:'burn-hidden',resources:[
   {id:'weekly',instance:'weekly-instance-1',amount_micro:125000}]});
 const initial=state.attempts[0].resources[0].initial_micro,before=structuredClone(state);
 for(const id of ['reconcile-1','reconcile-2']){
  const out=transitionEstimatedPace50State(state,{type:'reconcile_burn',event_id:id,at:paceNow+4,observed_at:paceNow+4,
   attempt_id:'attempt-1',burn_id:'burn-hidden',account:paceAccount,epoch:'epoch-1',complete:true,compatible:true,
   refresh_succeeded:true,attribution_confirmed:true,resources:[{id:'weekly',instance:'weekly-instance-1',
    anchor_at:paceNow-126*hourMs,resets_at:paceNow+42*hourMs,used_micro:20*micro+125000}]});
  assert.equal(out.applied,false);assert.equal(out.reason,'usage_coverage_unavailable');
  state=out.state;
  const r=state.attempts[0].resources[0];
  assert.equal(r.held_micro+r.unrepresented_micro,initial,'the whole amount stays counted');
  assert.equal(r.released_micro,0);
 }
 assert.deepEqual(state,before,'a repeated reconcile_burn changes nothing');
});
test('later chunks use separate spare while each earlier converted envelope stays unresolved',()=>{
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
  input.state=recordUsageAndCleanup(input,quote,attemptId);
  input.windows[0].used_micro=previousUsed+quote.windows[0].exposure_micro;
  assert.equal(input.request.job_id,task);
  return quote;
 };
 runChunk('same-task-1',paceNow);
 assert.ok(input.state.attempts.every(attempt=>attempt.resources.every(r=>
  r.held_micro+r.unrepresented_micro===r.initial_micro&&r.released_micro===0)));
 runChunk('same-task-2',paceNow+20*60000);
 assert.ok(input.state.attempts.every(attempt=>attempt.resources.every(r=>
  r.held_micro+r.unrepresented_micro===r.initial_micro&&r.released_micro===0)));
 runChunk('same-task-3',paceNow+40*60000);
 assert.ok(input.state.attempts.every(attempt=>attempt.resources.every(r=>
  r.held_micro+r.unrepresented_micro===r.initial_micro&&r.released_micro===0)));
 assert.equal(input.windows[0].used_micro,35*micro);
});
test('physical weekly capacity remains 100 points; a larger hold is valid and blocks more lending',()=>{
 const input=paceFixture({short:null,weekly:weeklyWindow(paceNow,{kappa_micro:micro,used_micro:0}),
  request:{requested_usd_micro:100*micro,worst_call_usd_micro:micro}});
 const quote=evaluateEstimatedPace50(input,{objective:{strategyParams:{perJobPct:100}}});
 assert.equal(quote.admitted,true,quote.reason);
 assert.equal(quote.windows[0].exposure_micro,100*micro);
 assert.equal(quote.proposed_state.attempts[0].resources[0].held_micro,100*micro);
 input.state=quote.proposed_state;input.now=paceNow+5;input.request.attempt_id='after-full-window';
 input.windows[0].observed_at=input.now;input.request.expires_at=input.now+7*dayMs;
 const held=evaluateEstimatedPace50(input);
 assert.equal(held.admitted,false);assert.equal(held.objective.reasonCode,'objective_owner_reserve');
 assert.equal(held.proposed_state.attempts[0].resources[0].held_micro,100*micro);
});
test('manual approval bypasses only the owner-absence control',()=>{
 const manual=paceFixture({short:null,controls:{owner_absent:false}});
 assert.equal(evaluateEstimatedPace50(manual,{automatic:false}).admitted,true);
 const automatic=paceFixture({short:null,controls:{owner_absent:false}});
 assert.equal(evaluateEstimatedPace50(automatic).reason,'controls');
 const missingConsent=paceFixture({short:null,controls:{consent:false,owner_absent:false}});
 assert.equal(evaluateEstimatedPace50(missingConsent,{automatic:false}).reason,'controls');
 const ownerReturned=paceFixture({short:null,controls:{owner_absent:false}});
 ownerReturned.state=applyEvent(ownerReturned.state,{type:'owner_return',event_id:'owner-return',at:paceNow});
 assert.equal(evaluateEstimatedPace50(ownerReturned,{automatic:false}).reason,'owner_present');
});
test('manual approval bypasses an unknown automatic estimate but keeps measured capacity and hard guards',()=>{
 const unavailableModel={kind:'unknown-demand-model'};
 const manual=paceFixture({short:null,controls:{owner_absent:false}});
 const admitted=evaluateEstimatedPace50(manual,{automatic:false,objective:{demandModel:unavailableModel}});
 assert.equal(admitted.admitted,true);
 assert.equal(admitted.objective.protectionSource.weekly,'strategy');
 assert.match(admitted.objective.reasonText,/after your approval/);

 const automatic=paceFixture({short:null,controls:{owner_absent:false}});
 assert.equal(evaluateEstimatedPace50(automatic,{objective:{demandModel:unavailableModel}}).reason,'controls');
 automatic.controls.owner_absent=true;
 assert.equal(evaluateEstimatedPace50(automatic,{objective:{frozenProtectionSource:'model',demandModel:unavailableModel}}).reason,'demand_model_unavailable');

 const full=paceFixture({weekly:weeklyWindow(paceNow,{used_micro:100*micro}),short:null,
  controls:{owner_absent:false}});
 assert.equal(evaluateEstimatedPace50(full,{automatic:false}).admitted,false);
 assert.equal(evaluateEstimatedPace50(full,{automatic:false}).reason,'owner_reserve');
 const tooSmall=paceFixture({short:null,controls:{owner_absent:false},
  request:{requested_usd_micro:micro}});
 assert.equal(evaluateEstimatedPace50(tooSmall,{automatic:false}).reason,'budget_too_small');
 const fundingUnknown=paceFixture({short:null,controls:{owner_absent:false},
  evidence:{subscription_only:false}});
 assert.equal(evaluateEstimatedPace50(fundingUnknown,{automatic:false}).reason,'funding_unknown');

 for(const control of ['consent','people','agents','schedule','unexpired','on']) {
  const blocked=paceFixture({short:null,controls:{owner_absent:false,[control]:false}});
  assert.equal(evaluateEstimatedPace50(blocked,{automatic:false}).reason,'controls',control);
 }
 const paused=paceFixture({short:null,controls:{owner_absent:false,paused:true}});
 paused.state=transitionEstimatedPace50State(paused.state,{type:'pause',event_id:'manual-paused',at:paceNow}).state;
 assert.equal(evaluateEstimatedPace50(paused,{automatic:false}).reason,'paused');

 for(const automaticSignal of [undefined,null,0,'false',true]) {
  const invalid=paceFixture({short:null,controls:{owner_absent:false}});
  const objective={...objectiveFor(invalid)};
  if(automaticSignal!==undefined)objective.automatic=automaticSignal;
  assert.equal(evaluateEstimatedPace50Raw({...invalid,objective}).reason,'controls',String(automaticSignal));
 }
});
test('Pause freezes chunks; Stop stays off until explicit On and owner return requests cessation',()=>{
 const input=paceFixture({short:null}),quote=evaluateEstimatedPace50(input);
 let state=applyEvent(quote.proposed_state,{type:'launch_result',event_id:'running',
  at:paceNow+1,attempt_id:'attempt-1',result:'started'});
 const pause=transitionEstimatedPace50State(state,{type:'pause',event_id:'pause',
  at:paceNow+2});
 assert.equal(pause.applied,true);assert.deepEqual(pause.effects.map(e=>e.type),
  ['persist_proposed_state','freeze_new_chunks']);
 input.state=pause.state;input.now=paceNow+3;input.windows[0].observed_at=input.now;
 input.request.attempt_id='after-pause';
 assert.equal(evaluateEstimatedPace50(input).reason,'paused');
 const stop=transitionEstimatedPace50State(pause.state,{type:'stop',event_id:'stop',at:paceNow+4});
 assert.equal(stop.state.mode,'off');assert.ok(stop.effects.some(e=>e.type==='request_cessation'));
 input.state=stop.state;input.now=paceNow+5;input.windows[0].observed_at=input.now;
 assert.equal(evaluateEstimatedPace50(input).reason,'stopped');
 state=applyEvent(stop.state,{type:'on',event_id:'explicit-on',at:paceNow+6});
 assert.equal(state.mode,'on');assert.equal(state.attempts[0].resources[0].held_micro,250000);
 const returned=transitionEstimatedPace50State(state,{type:'owner_return',event_id:'owner-return',
  at:paceNow+7});
 assert.equal(returned.state.owner_present,true);
 assert.ok(returned.effects.some(e=>e.type==='request_cessation'));
 assert.equal(returned.state.attempts[0].resources[0].held_micro,250000);
});
test('malformed evidence, read sets, event order, time and unsafe integers fail closed',()=>{
 const cases=[
  ['missing roster member',i=>{i.evidence.resource_ids.pop();},'resources_incomplete'],
  ['future observation',i=>{i.windows[0].observed_at=i.now+1;},'reading_stale'],
  ['missing conversion',i=>{i.windows[0].kappa_micro=null;},'conversion_unknown'],
  ['zero conversion',i=>{i.windows[0].kappa_micro=0;},'conversion_unknown'],
  ['failed refresh despite cache',i=>{i.evidence.refresh_succeeded=false;},'refresh_failed'],
  ['incomplete resources',i=>{i.evidence.complete=false;},'resources_incomplete'],
  ['unknown account identity',i=>{i.evidence.identity_compatible=false;},'identity_unknown'],
    ['missing funding proof',i=>{i.evidence.subscription_only=false;},'funding_unknown'],
  ['unbounded stop',i=>{i.evidence.bounded_execution=false;},'stop_bound_unknown'],
  ['competing executor',i=>{i.evidence.single_executor=false;},'executor_unknown'],
  ['wrong epoch',i=>{i.windows[0].epoch='epoch-2';},'resource_unknown'],
  ['invalid timestamp range',i=>{i.windows[0].observed_at=Number.MAX_SAFE_INTEGER+1;},'resource_unknown'],
  ['unknown wall bound',i=>{i.request.wall_ms=null;},'invalid_request'],
  ['no useful time before expiry',i=>{i.request.expires_at=i.now+1000;},'deadline'],
  ['unknown window',i=>{i.windows[0].state='unknown';},'reading_unknown'],
 ];
 for(const [name,change,reason]of cases){
  const input=paceFixture();change(input);
  const out=evaluateEstimatedPace50(input);
  assert.equal(out.admitted,false,name);assert.equal(out.reason,reason,name);
 }
 for(const [key,value]of [['consent',false],['people',false],['agents',false],['schedule',false],
   ['unexpired',false],['on',false],['paused',true],['owner_absent',false]]){
  const input=paceFixture({short:null,controls:{[key]:value}});
  assert.equal(evaluateEstimatedPace50(input).reason,'controls',key);
 }
 const stale=paceFixture({short:null});stale.windows[0].observed_at=stale.now+1;
 const refresh=evaluateEstimatedPace50(stale);
 assert.equal(refresh.reason,'reading_stale');
 assert.deepEqual(refresh.effects,[{type:'request_fresh_complete_read'}]);
 const failedRefresh=paceFixture({short:null,evidence:{refresh_succeeded:false}});
 assert.equal(evaluateEstimatedPace50(failedRefresh).reason,'refresh_failed');
 assert.deepEqual(evaluateEstimatedPace50(failedRefresh).effects,[]);
 const state=createEstimatedPace50State({account:paceAccount,account_week_id:'provider-week-1'});
 const ordered=transitionEstimatedPace50State(state,{type:'pause',event_id:'later',at:20});
 const old=transitionEstimatedPace50State(ordered.state,{type:'on',event_id:'earlier',at:19});
 assert.equal(old.reason,'event_order');
 const duplicate=transitionEstimatedPace50State(ordered.state,{type:'pause',event_id:'later',at:21});
 assert.equal(duplicate.reason,'duplicate_event');
 const unexpected={...state,hidden_state:true};
 assert.equal(evaluateEstimatedPace50({...paceFixture({short:null}),state:unexpected}).reason,'state_unknown');
 const overflow={...state,revision:Number.MAX_SAFE_INTEGER,updated_at:paceNow};
 assert.equal(evaluateEstimatedPace50({...paceFixture({short:null}),state:overflow}).reason,'revision_overflow');
 assert.equal(transitionEstimatedPace50State(overflow,{type:'pause',event_id:'overflow',at:paceNow})
  .reason,'revision_overflow');
 const huge=paceFixture({short:null,now:0,weekly:weeklyWindow(0,{anchor_at:0,
  resets_at:Number.MAX_SAFE_INTEGER,duration_ms:Number.MAX_SAFE_INTEGER,observed_at:0,used_micro:0})});
 assert.doesNotThrow(()=>evaluateEstimatedPace50(huge));
});
test('zero-used unknown windows stay held, and point reservations round upward',()=>{
 const unknown=paceFixture();unknown.windows[1].state='unknown';unknown.windows[1].used_micro=0;
 assert.equal(evaluateEstimatedPace50(unknown).reason,'reading_unknown');
 const rounded=paceFixture({short:null,weekly:weeklyWindow(paceNow,{used_micro:0,kappa_micro:1}),
  request:{requested_usd_micro:1,worst_call_usd_micro:0}});
 const out=evaluateEstimatedPace50(rounded);
 assert.equal(out.admitted,true,out.reason);
 assert.equal(out.windows[0].exposure_micro,1);
 assert.equal(out.proposed_state.attempts[0].resources[0].held_micro,1);
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
test('a migrated per-job point cap bounds the weekly reservation of an admitted job',()=>{
 const free=quoteUnder({strategy:'automatic',strategyParams:{}});
 assert.equal(free.admitted,true,free.reason);assert.ok(free.budget_micro>2*micro,'the largest chunk is admitted without a cap');
 const capped=quoteUnder({strategy:'automatic',strategyParams:{perJobPct:0.1}});
 assert.equal(capped.admitted,true,capped.reason);
 assert.ok(capped.windows.find(w=>w.id==='weekly').exposure_micro<=100000,'at most 0.1 weekly points per job');
 assert.ok(capped.budget_micro<=2*micro,'the cap is 2 USD at this window\'s conversion');
});
test('the owner dollar cap keeps bounding the job beside the migrated numbers',()=>{
 const capped=quoteUnder({strategy:'automatic',strategyParams:{perJobPct:5}},{request:{owner_max_job_usd_micro:2*micro}});
 assert.equal(capped.admitted,true,capped.reason);
 assert.ok(capped.budget_micro<=2*micro,'the owner cap still bounds the spend');
});
test('fixed_share and custom lend less than automatic when their ceilings bind',()=>{
 const free=quoteUnder({strategy:'automatic',strategyParams:{}});
 const fixed=quoteUnder({strategy:'fixed_share',strategyParams:{fixedSharePct:0.1,keepPct:30}});
 assert.equal(fixed.admitted,true,fixed.reason);
 assert.equal(fixed.objective.strategyId,'fixed_share');
 assert.match(fixed.objective.reasonText,/fixed share limits/);
 assert.ok(fixed.budget_micro<free.budget_micro,'the friends\' share is capped at fixedSharePct');
 assert.ok(fixed.budget_micro<=2*micro);
});
test('custom friends start at their start point e0, and the pace line grows the share along the week',()=>{
 const free=quoteUnder({strategy:'automatic',strategyParams:{}});
 // Half the week has elapsed (0.5005 after the window is set): the pace line from e0 = 0.5 leaves 0.1 points.
 const halfway=quoteUnder({strategy:'custom',strategyParams:{e0:0.5}},{weekly:weeklyWindow(paceNow,{resets_at:paceNow+302097600,anchor_at:paceNow+302097600-7*dayMs,used_micro:0})});
 assert.equal(halfway.admitted,true,halfway.reason);
 assert.equal(halfway.objective.strategyId,'custom');
 assert.match(halfway.objective.reasonText,/custom limits/);
 assert.ok(halfway.budget_micro<free.budget_micro,'the pace line leaves 0.1 points at the half-week mark');
 assert.ok(halfway.budget_micro<=2*micro);
 // Only a tenth of the week has elapsed, before e0: the pace line is at zero, so nothing is lent.
 const early=quoteUnder({strategy:'custom',strategyParams:{e0:0.5}},{weekly:weeklyWindow(paceNow,{resets_at:paceNow+544320000,anchor_at:paceNow+544320000-7*dayMs,used_micro:0})});
 assert.equal(early.admitted,false,'before the start point friends can use nothing');
});
// The advertised defaults (fixedSharePct 20, keepPct 30) apply when the owner chooses fixed_share without numbers.
test('a fixed_share policy without its numbers takes the advertised defaults',()=>{
 const defaults=normalizeLendingPolicy({strategy:'fixed_share'});
 assert.deepEqual({...defaults.strategyParams},{fixedSharePct:20,keepPct:30,perJobPct:10});
 const out=quoteUnder(defaults);
 assert.equal(out.admitted,true,out.reason);
 assert.equal(out.budget_micro,quoteUnder({strategy:'automatic',strategyParams:{}}).budget_micro,'the 20-point share does not bind this job');
});
// The integrator throws 'expected loss unresolved' when its two panel resolutions disagree by more than the tolerance
// (v1-lending-expected-loss.test.mjs covers that throw). No state tried so far produces it: the largest error measured over 96
// binding states was 1.7e-8, against a tolerance of 1e-6. So this test raises the same error where it escapes the evaluation,
// from a read of the objective inside the policy's try, and checks the catch that names the hold.
function objectiveThrowingOnPosition(input,error) {
 return Object.defineProperty(objectiveFor(input),'position',{enumerable:true,get(){throw error;}});
}
test('an unresolved expected loss holds as demand_model_invalid, and any other evaluation error as objective_evidence_invalid',()=>{
 const input=paceFixture();
 assert.equal(evaluateEstimatedPace50(input).admitted,true);
 const unresolved=evaluateEstimatedPace50Raw({...input,objective:objectiveThrowingOnPosition(input,new RangeError('expected loss unresolved'))});
 assert.equal(unresolved.admitted,false);
 assert.equal(unresolved.reason,'demand_model_invalid');
 const other=evaluateEstimatedPace50Raw({...input,objective:objectiveThrowingOnPosition(input,new RangeError('joint loan exceeds the protected capacity'))});
 assert.equal(other.admitted,false);
 assert.equal(other.reason,'objective_evidence_invalid');
});

test('absence proof releases a never-started reservation even after its deadline',()=>{
 const quote=evaluateEstimatedPace50(paceFixture());
 const state=quote.proposed_state;
 const at=Math.min(...state.attempts[0].resources.map(r=>r.resets_at))+1;
 const out=transitionEstimatedPace50State(state,{type:'cessation_proven',event_id:'absent-after-deadline',
  at,attempt_id:'attempt-1',authoritative_cessation:true,usage_reconciled:true,
  zero_use_attested:true,absence_proven:true});
 assert.equal(out.applied,true,out.reason);
 assert.equal(out.state.attempts[0].hold_closed,true);
 assert.equal(out.state.attempts[0].late_ack_unresolved,false);
 assert.ok(out.state.attempts[0].resources.every(r=>r.held_micro===0&&r.unrepresented_micro===0));
});

test('cleanup then a zero-use report leaves the hold unchanged until the durable deadline',()=>{
 const input=paceFixture(),quote=evaluateEstimatedPace50(input);
 assert.equal(quote.admitted,true);
 const id=quote.proposed_state.attempts[0].id;
 const started=applyEvent(quote.proposed_state,{type:'launch_result',event_id:'zero-report-started',at:input.now,
  attempt_id:id,result:'started'});
 const state=applyEvent(started,{type:'cleanup_proven',event_id:`${id}:cleanup-proven:zero`,
  at:input.now+1,attempt_id:id,cleanup_removed:true}),attempt=state.attempts[0];
 const out=transitionEstimatedPace50State(state,{type:'cessation_proven',event_id:'reserved-zero-report',
  at:input.now+2,attempt_id:attempt.id,authoritative_cessation:true,usage_reconciled:true,zero_use_attested:true});
 assert.notEqual(out.reason,'state_unknown');
 assert.deepEqual(out.state.attempts[0].resources,attempt.resources,'a zero-use report changes no ledger');
 assert.notEqual(out.state.attempts[0].hold_closed,true);
 assert.ok(out.state.attempts[0].resources.every(r=>r.held_micro===r.initial_micro&&r.released_micro===0));
 let bounded=out.state;
 for(const resource of [...attempt.resources].sort((a,b)=>Math.max(a.resets_at,input.now+a.duration_ms)-Math.max(b.resets_at,input.now+b.duration_ms))){
  const at=Math.max(resource.resets_at,input.now+resource.duration_ms);
  bounded=applyEvent(bounded,{type:'window_reset_settled',event_id:`bound:${resource.id}`,
   at,attempt_id:attempt.id,resource_ids:[resource.id],authoritative_cessation:true});
 }
 assert.equal(bounded.attempts[0].hold_closed,true,'only the deadline closes it');
 assert.ok(bounded.attempts[0].resources.every(r=>r.held_micro===0&&r.unrepresented_micro===0&&r.spent_micro===r.initial_micro));
});

test('an unproved unstarted cessation after the deadline refuses unchanged before a later absence proof closes it',()=>{
 const state=evaluateEstimatedPace50(paceFixture()).proposed_state;
 const at=Math.min(...state.attempts[0].resources.map(r=>r.resets_at))+1;
 const before=structuredClone(state);
 const event={type:'cessation_proven',event_id:'unproved-after-deadline',at,attempt_id:'attempt-1',
  authoritative_cessation:true,usage_reconciled:true,zero_use_attested:true};
 const refused=transitionEstimatedPace50State(state,event);
 assert.equal(refused.applied,false);
 assert.equal(refused.reason,'usage_unknown');
 assert.deepEqual(refused.state,before,'an unproved event cannot orphan the reservation by marking it late');
 assert.deepEqual(state,before);
 const closed=transitionEstimatedPace50State(refused.state,{...event,event_id:'proved-after-deadline',absence_proven:true});
 assert.equal(closed.applied,true,closed.reason);
 const attempt=closed.state.attempts[0];
 assert.equal(attempt.hold_closed,true);
 assert.equal(attempt.late_ack_unresolved,false);
 for(const r of attempt.resources){
  assert.equal(r.held_micro,0);assert.equal(r.unrepresented_micro,0);
  assert.equal(r.spent_micro,0);assert.equal(r.settled_micro,0);
  assert.equal(r.released_micro,r.initial_micro);
 }
});

test('a late cessation in its original live window refuses unchanged without releasing the held maximum',()=>{
 let state=evaluateEstimatedPace50(paceFixture()).proposed_state;
 state=applyEvent(state,{type:'launch_result',event_id:'same-window-start',at:paceNow+1,attempt_id:'attempt-1',result:'started'});
 state=applyEvent(state,{type:'late_ack',event_id:'same-window-late-ack',at:paceNow+2,attempt_id:'attempt-1'});
 const before=structuredClone(state),attempt=state.attempts[0],at=paceNow+3;
 assert.ok(attempt.resources.every(r=>at<r.resets_at),'every original window is still live');
 const out=transitionEstimatedPace50State(state,{type:'cessation_proven',event_id:'same-window-cessation',
  at,observed_at:at,attempt_id:attempt.id,authoritative_cessation:true,usage_reconciled:true,
  complete:true,compatible:true,refresh_succeeded:true,
  resources:attempt.resources.map(r=>({id:r.id,instance:r.instance,anchor_at:r.anchor_at,resets_at:r.resets_at,
   used_micro:r.baseline_used_micro}))});
 assert.equal(out.applied,false);
 assert.equal(out.reason,'usage_coverage_unavailable');
 assert.deepEqual(out.state,before,'the matching aggregate cannot discharge late exposure');
 assert.deepEqual(state,before);
 for(const r of out.state.attempts[0].resources){
  assert.equal(r.released_micro,0);
  assert.equal(r.held_micro+r.unrepresented_micro,r.initial_micro,'the full maximum remains counted');
 }
});

test('a lost launch receipt still records late cessation and charges the covering window maximum',()=>{
 let state=evaluateEstimatedPace50(paceFixture()).proposed_state;
 const short=structuredClone(state.attempts[0].resources.find(r=>r.id==='short'));
 const at=short.resets_at+1;
 assert.equal(state.attempts[0].launch_state,'reserved');
 state=applyEvent(state,{type:'cessation_proven',event_id:'lost-start-cessation',at,attempt_id:'attempt-1',
  authoritative_cessation:true,usage_reconciled:true});
 assert.equal(state.attempts[0].late_ack_unresolved,true);
 assert.equal(state.attempts[0].late_ack_events.length,1);
 state=applyEvent(state,{type:'cleanup_proven',event_id:'attempt-1:cleanup-proven:lost-start',at:at+1,
  attempt_id:'attempt-1',cleanup_removed:true});
 const reset={type:'window_reset_settled',event_id:'lost-start-reset',at:at+2,attempt_id:'attempt-1',
  authoritative_cessation:true,resource_ids:['short']};
 const refused=transitionEstimatedPace50State(state,reset);
 assert.equal(refused.applied,false);
 assert.equal(refused.reason,'late_carry_required');
 assert.deepEqual(refused.state,state);
 const covering={...short,instance:'short-instance-2',anchor_at:short.resets_at,
  resets_at:short.resets_at+5*hourMs,duration_ms:5*hourMs,used_micro:0,kappa_micro:300000};
 state=applyEvent(state,{type:'late_start_carried',event_id:'lost-start-carry',at:at+2,observed_at:at+2,
  attempt_id:'attempt-1',carries:[{from_id:short.id,from_instance:short.instance,resource:covering}]});
 state=applyEvent(state,{...reset,at:at+3});
 const carry=state.attempts.find(a=>a.id==='attempt-1:carry:short:short-instance-1').resources[0];
 const maximum=Math.ceil(short.initial_micro*covering.kappa_micro/short.kappa_micro);
 assert.equal(carry.spent_micro,maximum);
 assert.equal(carry.unrepresented_micro,maximum);
 assert.equal(carry.released_micro,0);
 assert.equal(state.attempts[0].resources.find(r=>r.id==='short').spent_micro,short.initial_micro);
});

for(const evidence of ['burn','late_ack'])test(`cancelled absence proof cannot erase ${evidence}`,()=>{
 let state=evaluateEstimatedPace50(paceFixture()).proposed_state;
 if(evidence==='burn'){
  state=applyEvent(state,{type:'launch_result',event_id:'burn-start',at:paceNow,attempt_id:'attempt-1',result:'started'});
  state=applyEvent(state,{type:'usage',event_id:'cancel-burn',at:paceNow+1,attempt_id:'attempt-1',burn_id:'cancel-burn',
   resources:state.attempts[0].resources.map(r=>({id:r.id,instance:r.instance,amount_micro:1}))});
 }else state=applyEvent(state,{type:'late_ack',event_id:'cancel-late',at:paceNow+1,attempt_id:'attempt-1'});
 // Model contradictory durable evidence alongside a lost launch receipt and cancellation.
 state.attempts[0].launch_state='reserved';
 state.attempts[0].process_state='cancel_requested';
 const before=structuredClone(state);
 const out=transitionEstimatedPace50State(state,{type:'cessation_proven',event_id:'cancel-absence',at:paceNow+2,
  attempt_id:'attempt-1',authoritative_cessation:true,usage_reconciled:true,zero_use_attested:true,absence_proven:true});
 assert.equal(out.applied,false);
 assert.deepEqual(out.state,before);
 assert.notEqual(out.state.attempts[0].hold_closed,true);
 assert.ok(out.state.attempts[0].resources.every(r=>r.released_micro===0));
});


test('owner release freezes feedback repricing and preserves the full deadline charge',async t=>{
 for(const type of ['meter_feedback','meter_feedback_pending'])for(const multiplier of [0.5,2]){
  await t.test(`${type} at ${multiplier} times the held rate`,()=>{
   const input=paceFixture({short:null}),quote=evaluateEstimatedPace50(input);
   assert.equal(quote.admitted,true);
   let state=applyEvent(quote.proposed_state,{type:'launch_result',event_id:'started',at:paceNow+1,
    attempt_id:'attempt-1',result:'started'});
   state=applyEvent(state,{type:'owner_release_hold',event_id:'attempt-1:owner-release-hold',
    at:paceNow+2,attempt_id:'attempt-1',confirmed:true});
   const before=structuredClone(state.attempts[0]),ledger=before.resources[0];
   const resource=Object.fromEntries(['id','instance','epoch','anchor_at','resets_at'].map(k=>[k,ledger[k]]));
   const feedback=transitionEstimatedPace50State(state,{type,event_id:'feedback',at:paceNow+3,
    account:input.account,observed_at:paceNow+3,
    resources:[{...resource,kappa_micro:ledger.kappa_micro*multiplier,used_micro:0}]});
   assert.equal(feedback.applied,true,'account feedback still applies');
   assert.deepEqual(feedback.state.attempts[0],before,'released attempt keeps amounts and process state');
   assert.equal(feedback.effects.some(effect=>effect.type==='request_cessation'),false,
    'released attempt receives no cessation request');
   const settled=applyEvent(feedback.state,{type:'window_reset_settled',event_id:'deadline',
    at:ledger.resets_at+week,attempt_id:'attempt-1',authoritative_cessation:true,resource_ids:['weekly']});
   assert.equal(settled.attempts[0].resources[0].spent_micro,ledger.held_micro);
   assert.equal(settled.attempts[0].resources[0].held_micro,0);
   assert.equal(settled.attempts[0].resources[0].released_micro,0);
  });
 }
});

// Helpers that receive the whole event as a positional argument or as a value
// inside an object literal. Each one is audited to read only event fields other
// than `type`; the census cannot see inside them, so adding a name here is a
// claim that the helper never dispatches on event.type.
const EVENT_PASSTHROUGH_HELPERS=new Set([
 'record','transitionResult','crossResetRecoveryProblem','markLateAcknowledgement','resolveLateExposure',
 'nativeCoverageMeasured','protectionRemovable','settlementEligibility',
]);

function stripJsComments(source) {
 // Keep string and template literals intact so `'https://example'` is not cut as a comment.
 return source.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
  (_match,literal)=>literal??' ');
}

// Name of the innermost call whose argument list contains `index`, or null at top level.
function enclosingCallee(text,index) {
 let depth=0;
 for(let i=index-1;i>=0;i--){
  if(text[i]===')')depth++;
  else if(text[i]==='('){
   if(depth===0)return /([\w$]+)\s*$/.exec(text.slice(0,i))?.[1]??'(anonymous)';
   depth--;
  }
 }
 return null;
}

function assertOwnerReleaseEventCensus(source,policy) {
 // The reducer's own signature names `event`; only its body is dispatched on.
 const body=stripJsComments(source).replace(/^function[^(]*\([^)]*\)\s*\{/,'{');
 const handled=new Set();
 const fail=(form,index,text)=>assert.fail(
  `Unclassified event dispatch form (${form}) near "${text.slice(Math.max(0,index-40),index+40).replace(/\s+/g,' ')}": extend the census explicitly`);
 // Consume only dispatch forms we can enumerate: `event.type` compared to a literal, in either quote style.
 let rest=body.replace(/(?<![\w$])event\s*\.\s*type\s*(?:===|!==|==|!=)\s*(['"])([a-z_]+)\1(?=\s*(?:[)&|?:;},]|$))/g,(_match,_quote,type)=>{
  handled.add(type);return ' ';
 });
 rest=rest.replace(/\[([^\[\]]*)\]\s*\.\s*includes\s*\(\s*event\s*\.\s*type\s*\)/g,(_match,items)=>{
  assert.match(items,/^\s*(?:'[a-z_]+'|"[a-z_]+")(?:(?:\s*,\s*)(?:'[a-z_]+'|"[a-z_]+"))*\s*,?\s*$/,
   'Event dispatch arrays must contain only literal event names');
  for(const literal of items.matchAll(/(['"])([a-z_]+)\1/g))handled.add(literal[2]);
  return ' ';
 });
 // This lookup enforces the release policy; it does not dispatch a handler.
 rest=rest.replace(/\bOWNER_RELEASE_EVENT_POLICY\s*\[\s*event\s*\.\s*type\s*\]/g,' ');
 // Any other way to reach the type, or to hold the event as a value, fails closed.
 const forbidden=[
  [/(?<![\w$])event\s*\?\./,'optional chaining on event (event?.)'],
  [/(?<![\w$])event\s*\[/,'computed access on event (event[...])'],
  [/(?<![\w$])event\s*\.\s*type\b/,'event.type outside an enumerated comparison or includes list'],
  [/\.\s*type\b/,'type read off a value other than event'],
  [/[{,]\s*type\s*[,}]/,'destructuring of type'],
 ];
 for(const [pattern,form] of forbidden){
  const match=pattern.exec(rest);
  if(match)fail(form,match.index,rest);
 }
 // Bare `event` may appear only as a property read (`event.at`) or as an argument or
 // object value passed to a helper on the pass-through allow-list.
 for(const match of rest.matchAll(/(?<![\w$])event(?![\w$])/g)){
  if(/^\s*\./.test(rest.slice(match.index+5)))continue;
  const before=rest.slice(0,match.index).trimEnd(),after=rest.slice(match.index+5).trimStart();
  const callee=enclosingCallee(rest,match.index);
  const valuePosition=before.endsWith('...')||/[(,:]$/.test(before);
  if(valuePosition&&/^[,)}]/.test(after)&&callee!==null&&EVENT_PASSTHROUGH_HELPERS.has(callee))continue;
  if(before.endsWith('='))fail('alias or destructuring of event (`= event`)',match.index,rest);
  fail(`bare event value passed to ${callee===null?'top level':`"${callee}"`}, which is not on the pass-through list`,match.index,rest);
 }
 assert.deepEqual(Object.keys(policy).sort(),[...handled].sort());
}

test('every handled reducer event has an explicit owner release policy',async()=>{
 const {OWNER_RELEASE_EVENT_POLICY}=await import('../lib/v1/lending-policy.mjs');
 assert.ok(OWNER_RELEASE_EVENT_POLICY,'the reducer exports its closed event policy');
 assertOwnerReleaseEventCensus(transitionEstimatedPace50State.toString(),OWNER_RELEASE_EVENT_POLICY);
 assert.ok(Object.values(OWNER_RELEASE_EVENT_POLICY).every(value=>['allow','refuse','skip_released'].includes(value)));
});

test('the event census rejects a double-quoted unclassified handler',async()=>{
 const {OWNER_RELEASE_EVENT_POLICY}=await import('../lib/v1/lending-policy.mjs');
 const source=transitionEstimatedPace50State.toString();
 const mutated=source.replace("if(['meter_feedback'", 'if(event.type === "new_event"){}else if([\'meter_feedback\'');
 assert.notEqual(mutated,source,'the mutation adds an unclassified dispatch branch');
 assert.throws(()=>assertOwnerReleaseEventCensus(mutated,OWNER_RELEASE_EVENT_POLICY));
});

function mutateReducerBranch(source,branch) {
 const mutated=source.replace("if(['meter_feedback'",`${branch}else if(['meter_feedback'`);
 assert.notEqual(mutated,source,'the mutation adds a branch before the feedback dispatch');
 return mutated;
}

test('the event census rejects optional-computed dispatch on event',async()=>{
 const {OWNER_RELEASE_EVENT_POLICY}=await import('../lib/v1/lending-policy.mjs');
 const mutated=mutateReducerBranch(transitionEstimatedPace50State.toString(),"if(event?.['type'] === 'new_event'){}");
 assert.throws(()=>assertOwnerReleaseEventCensus(mutated,OWNER_RELEASE_EVENT_POLICY),/optional chaining on event/);
});

test('the event census rejects a comment between event and .type',async()=>{
 const {OWNER_RELEASE_EVENT_POLICY}=await import('../lib/v1/lending-policy.mjs');
 const mutated=mutateReducerBranch(transitionEstimatedPace50State.toString(),"if(event/*c*/.type === 'new_event'){}");
 assert.throws(()=>assertOwnerReleaseEventCensus(mutated,OWNER_RELEASE_EVENT_POLICY),/new_event/);
});

test('the event census rejects an alias of event',async()=>{
 const {OWNER_RELEASE_EVENT_POLICY}=await import('../lib/v1/lending-policy.mjs');
 const mutated=mutateReducerBranch(transitionEstimatedPace50State.toString(),'const e=event;if(e.type === "new_event"){}');
 assert.throws(()=>assertOwnerReleaseEventCensus(mutated,OWNER_RELEASE_EVENT_POLICY),/alias|type read off/);
});

test('the event census rejects destructuring of event',async()=>{
 const {OWNER_RELEASE_EVENT_POLICY}=await import('../lib/v1/lending-policy.mjs');
 const mutated=mutateReducerBranch(transitionEstimatedPace50State.toString(),'const {type}=event;if(type === "new_event"){}');
 assert.throws(()=>assertOwnerReleaseEventCensus(mutated,OWNER_RELEASE_EVENT_POLICY),/destructuring of type/);
});

test('the event census refuses dispatch forms it cannot enumerate',async()=>{
 const {OWNER_RELEASE_EVENT_POLICY}=await import('../lib/v1/lending-policy.mjs');
 const source=transitionEstimatedPace50State.toString();
 for(const dispatch of [
  'switch(event.type){case "new_event":break;}',
  'if(types.includes(event.type)){}',
  'if(["pause",newType].includes(event.type)){}',
  'if("new_event" === event.type){}',
  'if(event["type"] === "new_event"){}',
  'if(event?.type === "new_event"){}',
  'if(event.type === "pause"+suffix){}',
  'if(event.type in {new_event:1}){}',
  'if(event.type.startsWith("new_")){}',
  'if(Object.values(event).includes("new_event")){}',
  'const e=event.type;',
  'JSON.stringify(event);',
  'const copy={...event};',
  'f(event);',
 ])assert.throws(()=>assertOwnerReleaseEventCensus(source+dispatch,OWNER_RELEASE_EVENT_POLICY),dispatch);
 const doubleQuoted=source.replace(/event\.type==='([a-z_]+)'/g,'event.type === "$1"');
 assert.notEqual(doubleQuoted,source);
 assertOwnerReleaseEventCensus(doubleQuoted,OWNER_RELEASE_EVENT_POLICY);
});



test('account feedback still reprices other attempts while released attempts stay frozen',()=>{
 const input=paceFixture({short:null}),quote=evaluateEstimatedPace50(input);
 let state=applyEvent(quote.proposed_state,{type:'launch_result',event_id:'started',at:paceNow+1,
  attempt_id:'attempt-1',result:'started'});
 const other=structuredClone(state.attempts[0]);other.id='attempt-2';other.job_id='job-2';
 state.attempts.push(other);
 state=applyEvent(state,{type:'owner_release_hold',event_id:'attempt-1:owner-release-hold',
  at:paceNow+2,attempt_id:'attempt-1',confirmed:true});
 const before=structuredClone(state.attempts[0]),ledger=before.resources[0];
 const resource=Object.fromEntries(['id','instance','epoch','anchor_at','resets_at'].map(k=>[k,ledger[k]]));
 const result=transitionEstimatedPace50State(state,{type:'meter_feedback',event_id:'mixed-feedback',
  at:paceNow+3,observed_at:paceNow+3,account:input.account,
  resources:[{...resource,kappa_micro:2*ledger.kappa_micro,used_micro:0}]});
 assert.equal(result.applied,true);
 assert.deepEqual(result.state.attempts[0],before);
 assert.equal(result.state.attempts[1].resources[0].held_micro,2*ledger.held_micro);
 assert.equal(result.state.attempts[1].process_state,'cessation_requested');
 assert.deepEqual(result.effects.filter(effect=>effect.type==='request_cessation').map(effect=>effect.attempt_id),['attempt-2']);
 assert.equal(result.state.rate_feedback.blocked,true);
});

test('owner release refuses unknown event types without changing state',()=>{
 const quote=evaluateEstimatedPace50(paceFixture());
 const state=applyEvent(quote.proposed_state,{type:'owner_release_hold',event_id:'attempt-1:owner-release-hold',
  at:paceNow+1,attempt_id:'attempt-1',confirmed:true});
 for(const type of ['future_money_event','toString']){
  const result=transitionEstimatedPace50State(state,{type,event_id:type,at:paceNow+2,attempt_id:'attempt-1'});
  assert.equal(result.applied,false);
  assert.equal(result.reason,'manual_full_charge_pending');
  assert.deepEqual(result.state,state);
 }
});
