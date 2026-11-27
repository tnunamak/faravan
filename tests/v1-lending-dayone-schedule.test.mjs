import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {uniformTotalPosterior, immediatePriorAction, anytimePriorReserve, MODEL_I_REFERENCE, finiteQuantile} from '../lib/v1/lending-dayone.mjs';
import {chooseResetIndexedSchedule, rational} from '../lib/v1/lending-schedule.mjs';
import {evaluateDemandModel} from '../lib/v1/lending-demand-model.mjs';
import {decideObjectiveLend, MICRO} from '../lib/v1/lending-objective.mjs';
import {RESET, NOW, GATES, OWNER_NONE, calibration, windows, job} from './helpers/lending-objective-fixtures.mjs';

test('day-one uniform-total prior matches the paper install optimum and updates from within-window demand', () => {
  const expected = [[10, 5], [4, 12], [2, 25]];
  for (const [lambda, lend] of expected) {
    const epsilon = 1 / lambda;
    const alpha = epsilon / (1 * 2);
    const band = anytimePriorReserve({capacity:100, count:0, exposureFraction:0, lambda, updateIndex:1});
    const action = immediatePriorAction({capacity:100, count:0, exposureFraction:0, remaining:100,
      lambda, predictiveAlpha:alpha});
    assert.equal(band.reserve, 100 - lend);
    assert.equal(action.loan, lend);
    assert.equal(band.protectionSource, 'model');
  }
  const prior = uniformTotalPosterior({capacity:100, count:5, exposureFraction:.5});
  assert.ok(Math.abs(prior[1].probability / prior[0].probability - 3) < 1e-12);
  const updated = anytimePriorReserve({capacity:100, count:5, exposureFraction:.5, lambda:4, updateIndex:2});
  assert.ok(updated.reserve > 0 && updated.reserve < 95);
  assert.equal(updated.updateIndex, 2);
  assert.match(MODEL_I_REFERENCE.label, /integer unit-point demand \(b=1\)/);
  assert.match(MODEL_I_REFERENCE.label, /coupled-window caveat/);
  const evaluated = evaluateDemandModel(MODEL_I_REFERENCE, {resourceId:'weekly', capacityPoints:100,
    observations:{count:0}, exposureFraction:0, updateIndex:1, epsilon:.25});
  assert.equal(evaluated.markBound, 1);
  assert.match(evaluated.provenance, /not empirically calibrated/);
});

test('one-resource automatic admission uses an explicitly injected reference model without history', () => {
  const singleBand = {weekStart:RESET,epoch:'epoch',procedure:'model-reference',domain:['weekly@decision'],
    weeks:[],forecasts:[{id:'weekly',domain:'weekly@decision',prediction:0,scale:1}]};
  const decision = decideObjectiveLend({now:NOW,observedAt:NOW,position:'balanced',weeklyResource:'weekly',
    windows:{weekly:{kind:'weekly',known:true,fresh:true,compatible:true,usedMicro:0,committedMicro:0,
      uncertaintyMicro:0,pointsPerUsdMicro:MICRO,resetAtMs:RESET,anchorAtMs:NOW,durationMs:7*24*60*60*1000,
      ownerUsedMicro:0}},
    band:singleBand,demandModel:MODEL_I_REFERENCE,job:job({friendValue:12,requestedUsdMicro:12*MICRO,
      estimateUsdMicro:12*MICRO,worstCallUsdMicro:MICRO/10}),gates:GATES,laterBurnCapacityMicro:0});
  assert.equal(decision.admitted,true,decision.reasonCode);
  assert.deepEqual(decision.protectionSource,{weekly:'model'});
  assert.equal(decision.demandModelId,'model-i-reference');
  assert.equal(decision.protectedOwnerPoints.weekly,88);
  assert.equal(decision.lendablePoints.weekly,12);
  assert.match(decision.reasonText,/not empirically calibrated/);
});

test('weekly deferral capacity is not a maximum current-job size', () => {
  const decision = decideObjectiveLend({now:NOW, observedAt:NOW,
    windows:windows({weeklyUsedMicro:93_640_000, shortUsedMicro:90_520_000,
      weeklyK:530_000, shortK:1_580_000}),
    band:calibration(), owner:OWNER_NONE, gates:GATES, laterBurnCapacityMicro:4_240_000,
    job:job({friendValue:10, requestedUsdMicro:6_000_000, estimateUsdMicro:6_000_000,
      worstCallUsdMicro:1_000_000})});
  assert.equal(decision.admitted, true, decision.reasonCode);
  assert.equal(decision.exposureUsdMicro, 6_000_000);
  assert.deepEqual(decision.reservePointsMicro, {seven_day:3_180_000, five_hour:9_480_000});
});

test('reset-indexed finite schedules choose two indivisible jobs when a scalar min-now cap rejects either', () => {
  const q = rational;
  const result = chooseResetIndexedSchedule({
    resources: [
      {id:'short@now',capacityMicro:9_480_000},
      {id:'short@after-reset',capacityMicro:12_640_000},
      {id:'weekly@same-week',capacityMicro:6_360_000},
    ],
    weights:[q(1)], lambda:q(4),
    candidates:[
      {id:'one-now-one-later',costsMicro:{'short@now':9_480_000,'short@after-reset':9_480_000,'weekly@same-week':6_360_000},
        usefulValues:[q(2)], ownerLosses:[q(0)], firstActionId:'job-1', scheduleProven:true,
        envelope:{stoppable:true,finishesBeforeReset:true,unknownUsageHeld:true,ownerCapFits:true}},
      {id:'both-later',costsMicro:{'short@now':0,'short@after-reset':18_960_000,'weekly@same-week':6_360_000},
        usefulValues:[q(2)], ownerLosses:[q(0)], firstActionId:null, scheduleProven:true,
        envelope:{stoppable:true,finishesBeforeReset:true,unknownUsageHeld:true,ownerCapFits:true}},
      {id:'unsafe-now',costsMicro:{'short@now':9_480_000,'short@after-reset':0,'weekly@same-week':3_180_000},
        usefulValues:[q(100)], ownerLosses:[q(0)], firstActionId:'unsafe', scheduleProven:true,
        envelope:{stoppable:false,finishesBeforeReset:true,unknownUsageHeld:true,ownerCapFits:true}},
    ],
  });
  assert.equal(result.choice, 'one-now-one-later');
  assert.equal(result.firstActionId, 'job-1');
  assert.equal(result.evaluations.find(row=>row.id==='both-later').feasible, false);
});

test('reset-indexed schedules reject missing resource coordinates and missing scenario losses', () => {
  const q = rational;
  const resources = [{id:'short@now',capacityMicro:10},{id:'weekly@same-week',capacityMicro:10}];
  const weights = [q(1)];
  const base = {id:'candidate',costsMicro:{'short@now':1,'weekly@same-week':1},
    usefulValues:[q(1)],ownerLosses:[q(0)],firstActionId:'job',scheduleProven:true,
    envelope:{stoppable:true,finishesBeforeReset:true,unknownUsageHeld:true,ownerCapFits:true}};
  assert.throws(()=>chooseResetIndexedSchedule({resources,weights,lambda:q(4),candidates:[{
    ...base,costsMicro:{'short@now':1},
  }]}),/cost identity mismatch/);
  assert.throws(()=>chooseResetIndexedSchedule({resources,weights,lambda:q(4),candidates:[{
    ...base,ownerLosses:[],
  }]}),/scenario loss dimensions/);
  assert.throws(()=>chooseResetIndexedSchedule({resources,weights,lambda:q(4),candidates:[{
    ...base,ownerLosses:new Array(1),
  }]}),/missing|rational|scenario/);
  assert.throws(()=>chooseResetIndexedSchedule({resources,weights,lambda:q(4),candidates:[{
    ...base,costsMicro:{'short@now':1,'weekly@same-week':undefined},
  }]}),/invalid schedule cost/);
  assert.throws(()=>chooseResetIndexedSchedule({resources,weights:new Array(1),lambda:q(4),candidates:[base]}),
    /missing scenario weight entry/);
  assert.throws(()=>chooseResetIndexedSchedule({resources:new Array(2),weights,candidates:[base],lambda:q(4)}),
    /missing schedule resource coordinate/);
  assert.equal(chooseResetIndexedSchedule({resources,weights,lambda:q(4),candidates:[{
    ...base,ownerLosses:[q(0)],
  }]}).choice,'candidate');
});

test('real objective admission follows the exact reset-indexed schedule first action', () => {
  const q = rational;
  const resetIndexedSchedule = {
    resources:[
      {id:'short@now',capacityMicro:9_480_000},
      {id:'short@after-reset',capacityMicro:12_640_000},
      {id:'weekly@same-week',capacityMicro:6_360_000},
    ],
    weights:[q(1)],
    candidates:[{
      id:'one-now-one-later',
      costsMicro:{'short@now':9_480_000,'short@after-reset':9_480_000,'weekly@same-week':6_360_000},
      usefulValues:[q(2)],ownerLosses:[q(0)],firstActionId:'job-1',
      firstActionCostsMicro:{seven_day:3_180_000,five_hour:9_480_000},scheduleProven:true,
      envelope:{stoppable:true,finishesBeforeReset:true,unknownUsageHeld:true,ownerCapFits:true},
    },{
      id:'wait-for-one',costsMicro:{'short@now':0,'short@after-reset':9_480_000,'weekly@same-week':3_180_000},
      usefulValues:[q(1)],ownerLosses:[q(0)],firstActionId:null,scheduleProven:true,
      envelope:{stoppable:true,finishesBeforeReset:true,unknownUsageHeld:true,ownerCapFits:true},
    }],
  };
  const decision = decideObjectiveLend({now:NOW,observedAt:NOW,
    windows:windows({weeklyUsedMicro:93_640_000,shortUsedMicro:90_520_000,weeklyK:530_000,shortK:1_580_000}),
    band:calibration(),owner:OWNER_NONE,gates:GATES,laterBurnCapacityMicro:4_240_000,
    resetIndexedSchedule,
    job:job({friendValue:1,requestedUsdMicro:6_000_000,estimateUsdMicro:6_000_000,
      worstCallUsdMicro:1_000_000,chunkCandidates:[{id:'job-1',usdMicro:6_000_000,friendValue:1}]})});
  assert.equal(decision.admitted,true,decision.reasonCode);
  assert.equal(decision.chunkId,'job-1');
  assert.equal(decision.scheduleDecision.choice,'one-now-one-later');
  assert.equal(decision.objectiveEvaluation.exactScore,'2/1');
});

test('finite quantiles ignore atom order without mutating caller data', () => {
  const atoms = Object.freeze([Object.freeze({amount:100,probability:.5}),
    Object.freeze({amount:0,probability:.5})]);
  assert.equal(finiteQuantile(atoms,.125),100);
  assert.equal(finiteQuantile([...atoms].reverse(),.125),100);
  assert.deepEqual(atoms.map(atom => atom.amount),[100,0]);
});

test('finite quantiles validate every atom before returning a crossing', () => {
  for (const invalid of [{amount:NaN,probability:0},{amount:1,probability:-1},
    {amount:1,probability:Infinity},undefined]) {
    assert.throws(() => finiteQuantile([{amount:0,probability:1},invalid],.125),/atom/);
  }
});

test('joint posterior coordinates require independently ordered quantiles', () => {
  const joint = Object.freeze([
    Object.freeze({weekly:100,short:0,probability:.5}),
    Object.freeze({weekly:0,short:70,probability:.5}),
  ]);
  for (const rows of [joint,[...joint].reverse()]) {
    const reserves = Object.fromEntries(['weekly','short'].map(id => [id,
      finiteQuantile(rows.map(atom => ({amount:atom[id],probability:atom.probability})),.125)]));
    assert.deepEqual(reserves,{weekly:100,short:70});
  }
  assert.deepEqual(joint.map(atom => [atom.weekly,atom.short]),[[100,0],[0,70]]);
});

test('exported allocator preserves capacity under discrete posterior permutations', () => {
  const atoms = Object.freeze([Object.freeze({amount:20,probability:.5}),
    Object.freeze({amount:0,probability:.5})]);
  const decide = posterior => decideObjectiveLend({
    now:NOW,observedAt:NOW,position:'balanced',weeklyResource:'weekly',
    windows:{weekly:{kind:'weekly',known:true,fresh:true,compatible:true,usedMicro:0,committedMicro:0,
      uncertaintyMicro:0,pointsPerUsdMicro:MICRO,resetAtMs:RESET,anchorAtMs:NOW,
      durationMs:7*24*60*60*1000,ownerUsedMicro:0}},
    band:{weekStart:RESET,epoch:'epoch',procedure:'model-reference',domain:['weekly@decision'],
      weeks:[],forecasts:[{id:'weekly',domain:'weekly@decision',prediction:0,scale:1}]},
    demandModel:{...MODEL_I_REFERENCE,id:'permuted-discrete',posterior:() => posterior},
    job:job({friendValue:12,requestedUsdMicro:12*MICRO,estimateUsdMicro:12*MICRO,
      worstCallUsdMicro:MICRO/10}),gates:GATES,laterBurnCapacityMicro:0,
  });
  const unsorted = decide(atoms);
  const sorted = decide([...atoms].reverse());
  assert.equal(sorted.admitted,true,sorted.reasonCode);
  assert.equal(unsorted.admitted,true,unsorted.reasonCode);
  assert.equal(sorted.protectedOwnerPoints.weekly,20);
  assert.equal(unsorted.protectedOwnerPoints.weekly,20);
  assert.deepEqual(unsorted.lendablePoints,sorted.lendablePoints);
  assert.deepEqual(unsorted.objectiveEvaluation,sorted.objectiveEvaluation);
  assert.deepEqual(atoms.map(atom => atom.amount),[20,0]);
});
