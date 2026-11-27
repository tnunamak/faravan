import './helpers/no-browser.mjs';
// The continuous model as the allocator default, seen through decideObjectiveLend. Fixtures are authored, not measured.
import test from 'node:test';
import assert from 'node:assert/strict';
import {decideObjectiveLend, MICRO} from '../lib/v1/lending-objective.mjs';
import {createContinuousDemandModel, WEEK_MS} from '../lib/v1/lending-continuous-model.mjs';
import {rational} from '../lib/v1/lending-schedule.mjs';
import {GATES, NOW, OWNER_NONE, calibration, job, windows} from './helpers/lending-objective-fixtures.mjs';

const M = MICRO;
const HOUR = 3_600_000;
const NO_HISTORY = calibration({weeks: 0});
const HEAVY = createContinuousDemandModel({alpha0: 2, b0: 90});
const LIGHT = createContinuousDemandModel({alpha0: 2, b0: 10});

// Weekly window resets in one week; the five-hour window resets in five hours. One point per USD on both.
function twoWindows({weeklyUsedMicro = 0, shortUsedMicro = 0} = {}) {
  const w = windows({weeklyUsedMicro, shortUsedMicro, resetAtMs: NOW + WEEK_MS});
  w.five_hour.resetAtMs = NOW + 5 * HOUR;
  return w;
}

function decide({position = 'balanced', demandModel = null, strategy, strategyConfig, windowsOverride, chunkCandidates,
  modelDataByResource = {}, resetIndexedSchedule = null, friendValue = 3} = {}) {
  return decideObjectiveLend({
    now: NOW, observedAt: NOW, position, band: NO_HISTORY, owner: OWNER_NONE, gates: GATES,
    laterBurnCapacityMicro: 0, windows: windowsOverride ?? twoWindows(), demandModel, modelDataByResource,
    strategy, strategyConfig, resetIndexedSchedule,
    job: job({friendValue, requestedUsdMicro: 3 * M, estimateUsdMicro: 3 * M, worstCallUsdMicro: M,
      chunkCandidates}),
  });
}

const weeklyOnly = () => ({seven_day: twoWindows().seven_day});

test('with no history and no injected model the continuous model protects the window and says so', () => {
  const d = decide({position: 'share_more', windowsOverride: weeklyOnly()});
  assert.equal(d.admitted, true, d.reasonCode);
  assert.deepEqual(d.projection.protectionSource, {seven_day: 'model'});
  assert.equal(d.projection.demandModelId, 'continuous-gamma-v1');
  assert.match(d.projection.demandModelLabel, /declared prior/);
  assert.match(d.reasonText, /declared prior/);
});

// Micro-point reserves round up, so protected and lendable points can differ from the paper's value by one micro-point.
const near6 = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-5, `${actual} != ${expected}`);

test('heavy reference, one window: Share more lends the paper 10 points; Balanced is held as predictively infeasible', () => {
  // The heavy law is injected explicitly: the production default is optimistic-default-v1 (research 08 section 7).
  const shareMore = decide({position: 'share_more', demandModel: HEAVY, windowsOverride: weeklyOnly()});
  assert.equal(shareMore.admitted, true, shareMore.reasonCode);
  near6(shareMore.projection.protectedOwnerPoints.seven_day, 90);
  near6(shareMore.projection.lendablePoints.seven_day, 10);
  const balanced = decide({position: 'balanced', demandModel: HEAVY, windowsOverride: weeklyOnly()});
  assert.equal(balanced.admitted, false);
  assert.equal(balanced.reasonCode, 'objective_predictive_infeasible');
});

test('an injected light reference lends the paper 81.715729 points at Balanced, with the weekly band as the reserve', () => {
  const d = decide({position: 'balanced', demandModel: LIGHT, windowsOverride: weeklyOnly()});
  assert.equal(d.admitted, true, d.reasonCode);
  assert.ok(Math.abs(d.projection.lendablePoints.seven_day - 81.715729) < 1e-5, String(d.projection.lendablePoints.seven_day));
  assert.ok(Math.abs(d.projection.protectedOwnerPoints.seven_day - 18.284271) < 1e-5);
});

test('two windows are coupled: both reserves come from one joint law, equal at one point per USD', () => {
  const d = decide({position: 'share_more', demandModel: HEAVY});
  assert.equal(d.admitted, true, d.reasonCode);
  assert.equal(d.projection.protectionSource.five_hour, 'model');
  assert.ok(Math.abs(d.projection.protectedOwnerPoints.seven_day - d.projection.protectedOwnerPoints.five_hour) <= 2e-6);
});

test('a demand model cannot silently cover more than two coupled windows', () => {
  const d = decide({windowsOverride: {...twoWindows(), three_day: {...twoWindows().seven_day, kind: 'weekly'}}});
  assert.equal(d.admitted, false);
  assert.equal(d.reasonCode, 'demand_model_coupling_unknown');
});

test('zero recorded usage over positive exposure holds with an explicit reason, not a fabricated posterior', () => {
  const d = decide({windowsOverride: weeklyOnly(),
    modelDataByResource: {seven_day: {originAtMs: NOW - HOUR, initialOwnerUsedMicro: 0}}});
  assert.equal(d.admitted, false);
  assert.equal(d.reasonCode, 'demand_model_exact_usage_required');
  assert.match(d.reasonText, /exact owner usage/);
});

test('fixed share never consults the demand model and keeps its own strategy source', () => {
  const d = decide({strategy: 'fixed_share', demandModel: null, windowsOverride: weeklyOnly(),
    strategyConfig: {fixedShare: {maxWeeklySharePct: 50, keepWeeklyPct: 30}}});
  assert.deepEqual(d.projection.protectionSource, {seven_day: 'strategy'});
  assert.notEqual(d.reasonCode, 'demand_model_unavailable');
});

const SCHEDULE_ROW = {costsMicro: {'seven_day@now': M}, usefulValues: [rational(2)], ownerLosses: [rational(0)],
  firstActionId: 'job-1', scheduleProven: true,
  envelope: {stoppable: true, finishesBeforeReset: true, unknownUsageHeld: true, ownerCapFits: true}};
const SCHEDULE_RESOURCES = [{id: 'seven_day@now', capacityMicro: 100 * M}];
const queueDecision = resetIndexedSchedule => decide({windowsOverride: weeklyOnly(), demandModel: LIGHT,
  position: 'balanced', chunkCandidates: [{id: 'job-1', usdMicro: 3 * M, friendValue: 3}], resetIndexedSchedule});

test('a reset-indexed schedule with no weights fails closed as an unknown queue', () => {
  const d = queueDecision({resources: SCHEDULE_RESOURCES, candidates: [{id: 'one', ...SCHEDULE_ROW}]});
  assert.equal(d.admitted, false);
  assert.equal(d.reasonCode, 'objective_queue_unknown');
});

test('a schedule candidate without its safety envelope is not chosen, so the decision holds', () => {
  const {envelope, ...unsafe} = SCHEDULE_ROW;
  const d = queueDecision({resources: SCHEDULE_RESOURCES, weights: [rational(1)],
    candidates: [{id: 'one', ...unsafe}]});
  assert.equal(d.admitted, false);
  assert.equal(d.reasonCode, 'objective_no_value');
});

test('a chosen schedule without its first-action costs holds as an unknown queue instead of throwing', () => {
  const d = queueDecision({resources: SCHEDULE_RESOURCES, weights: [rational(1)],
    candidates: [{id: 'one', ...SCHEDULE_ROW}]});
  assert.equal(d.admitted, false);
  assert.equal(d.reasonCode, 'objective_queue_unknown');
});
