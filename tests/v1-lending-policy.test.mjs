import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateLending, machineCapacity, normalizeLendingPolicy} from "../lib/v1/lending-policy.mjs";
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
 objectiveInput.job={...objectiveInput.job,model:'claude-sonnet-5-5',minimumCallUsd:5.29};
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

// Startup lane review (P1): the migrated policy reaches the allocator. The owner's per-job point cap (perJobPct) and the
// fixed_share and custom ceilings bound what one admitted job may reserve. Each ceiling is a USD cap on the job's gross
// spend, converted at the weekly window's own conversion (0.05 points per USD in this fixture: 0.1 points is 2 USD).
// Chunk candidates let the engine choose the largest chunk under a binding cap. Without them a binding cap holds the job
// (objective_exceeds_spare), which is the engine's rule that a partial job is refused.
// Each chunk is larger than the worst-case call (1.32 USD in this fixture), or the engine refuses it (a negative usdMicro throws).

// The advertised defaults (fixedSharePct 20, keepPct 30) apply when the owner chooses fixed_share without numbers.

// The integrator throws 'expected loss unresolved' when its two panel resolutions disagree by more than the tolerance
// (v1-lending-expected-loss.test.mjs covers that throw). No state tried so far produces it: the largest error measured over 96
// binding states was 1.7e-8, against a tolerance of 1e-6. So this test raises the same error where it escapes the evaluation,
// from a read of the objective inside the policy's try, and checks the catch that names the hold.

// Helpers that receive the whole event as a positional argument or as a value
// inside an object literal. Each one is audited to read only event fields other
// than `type`; the census cannot see inside them, so adding a name here is a
// claim that the helper never dispatches on event.type.

// Name of the innermost call whose argument list contains `index`, or null at top level.
