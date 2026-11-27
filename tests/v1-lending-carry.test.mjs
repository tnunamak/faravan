import './helpers/no-browser.mjs';
// Latest-vintage carry and window accounting (binding carry rule, research 4f816a9 and REVIEW-carry-rule-muse).
// Only the latest issuance's reserve counts; it is carried 1:1 with owner usage until the next re-decision; each
// re-decision takes a fresh reserve at its own budget epsilon/[(j+1)(j+2)]; and one window's lending in total stays
// inside the single allowance. Fixtures are authored. Assertions are relations the paper proves, not read-back decimals.
import test from 'node:test';
import assert from 'node:assert/strict';
import {action, quantile} from '../lib/v1/lending-continuous.mjs';
import {continuousWindowProtection, createContinuousDemandModel, WEEK_MS} from '../lib/v1/lending-continuous-model.mjs';
import {carriedReserve, checkUpdateIndex} from '../lib/v1/lending-risk-ledger.mjs';
import {decideObjectiveLend, MICRO} from '../lib/v1/lending-objective.mjs';
import {calibration, GATES, job, NOW, OWNER_NONE, windows} from './helpers/lending-objective-fixtures.mjs';

const M = MICRO;
const NO_HISTORY = calibration({weeks: 0});
const LIGHT = createContinuousDemandModel({alpha0: 2, b0: 10});
const EPS = 1e-6;

function weeklyWindow({usedMicro = 0, ownerUsedMicro = usedMicro, committedMicro = 0} = {}) {
  return {seven_day: {...windows({weeklyUsedMicro: usedMicro, resetAtMs: NOW + WEEK_MS}).seven_day, ownerUsedMicro,
    committedMicro}};
}

function decide({windowsOverride = weeklyWindow(), modelDataByResource = {}, demandModel = LIGHT, requestedUsd = 3,
  at = NOW} = {}) {
  return decideObjectiveLend({
    now: at, observedAt: at, position: 'balanced', band: NO_HISTORY, owner: OWNER_NONE, gates: GATES,
    laterBurnCapacityMicro: 0, windows: windowsOverride, demandModel, modelDataByResource,
    job: job({friendValue: 3, requestedUsdMicro: requestedUsd * M, estimateUsdMicro: requestedUsd * M, worstCallUsdMicro: M}),
  });
}

// Shape-one day-one reserve for a light owner (alpha 2, scale b) at chance level eta: Q(eta) = b (eta^(-1/2) - 1).
const closedQ = (b, eta) => b * (eta ** -0.5 - 1);

test('REGRESSION (heavy mid-week): a stale tight vintage does not lend everything; the loan is at most R - q_fresh', () => {
  // The day-one issuance reserved 34.72 (the value the cross-family example used). Mid-week the owner has used 40 of
  // the 100-point window and nothing is committed. Remaining net is 60. The stale reserve is 34.72 - 40 < 0, so a
  // minimum-over-vintages rule would lend the whole 60. Only the latest, fresh reserve may cap the loan.
  // Decided at mid-week: the cycle started at NOW, so exposure is 0.5 and the remaining shape is 0.5.
  const usedMicro = 40 * M;
  const midWeek = NOW + WEEK_MS / 2;
  const modelDataByResource = {seven_day: {originAtMs: NOW, initialOwnerUsedMicro: 0, updateIndex: 2,
    forecasts: [{ownerAtIssue: 0, reservePoints: 34.72}]}};
  const d = decide({at: midWeek, windowsOverride: weeklyWindow({usedMicro, ownerUsedMicro: usedMicro}), modelDataByResource});
  // Fresh reserve: the exact beta-prime quantile of the mid-week posterior, Gamma(2.5, 50) over remaining shape 0.5, at
  // the second issuance's budget epsilon/6 for epsilon 0.25 (the dial Balanced; the second issuance is ordinal 2).
  const freshQ = quantile({k: 0.5, alpha: 2.5, b: 50}, 0.25 / 6);
  const remainingNet = 100 - 40;
  const loan = d.admitted ? d.projection.lendablePoints.seven_day : 0;
  assert.ok(loan <= Math.max(0, remainingNet - freshQ) + EPS, `loan ${loan} exceeds R - q_fresh (${remainingNet} - ${freshQ})`);
  assert.ok(loan < remainingNet - EPS, 'never the whole remaining balance');
});

test('latest vintage only: an earlier vintage has no effect on the loan; a re-decision takes a fresh reserve', () => {
  const window = {seven_day: {kind: 'weekly', remainingMicro: 100 * M, resetAtMs: NOW + WEEK_MS, ownerUsedMicro: 0,
    pointsPerUsdMicro: M}};
  const plain = continuousWindowProtection({model: LIGHT, epsilon: 0.25, nowMs: NOW, weeklyId: 'seven_day', windows: window,
    modelDataByResource: {seven_day: {updateIndex: 3,
      forecasts: [{ownerAtIssue: 0, reservePoints: 50}, {ownerAtIssue: 0, reservePoints: 60}]}}});
  // A tighter earlier vintage in front of a looser latest one: the latest reserve governs, the stale one is ignored.
  const withStale = continuousWindowProtection({model: LIGHT, epsilon: 0.25, nowMs: NOW, weeklyId: 'seven_day',
    windows: window, modelDataByResource: {seven_day: {updateIndex: 3,
      forecasts: [{ownerAtIssue: 0, reservePoints: 1}, {ownerAtIssue: 0, reservePoints: 99}]}}});
  assert.equal(plain.problem, undefined);
  assert.equal(withStale.problem, undefined, withStale.problem);
  // Both calls evaluate the same fresh issuance; the stale vintages change nothing, so the lends are identical.
  assert.equal(withStale.lendMicro.seven_day, plain.lendMicro.seven_day);
});

test('carry is 1:1: after an admission, remaining net less the loan tracks max(0, q - owner usage) with no new vintage', () => {
  const q1 = closedQ(10, 0.25 / 2);
  const loanDay1 = 100 - q1;
  // Owner uses 20 points after the admission, and no new admission has been made.
  // Usage of 5 stays below the reserve q1 (about 18.3): above it the carry floors at zero and the identity no longer applies.
  const carried = carriedReserve([{reservePoints: q1, ownerAtIssue: 0}], 5);
  const remainingNet = 100 - 5 - loanDay1;
  assert.ok(Math.abs(remainingNet - carried) < EPS, `${remainingNet} != ${carried}`);
  assert.ok(Math.abs(carried - (q1 - 5)) < EPS);
});

test('two chunks in one window cannot together exceed the single allowance of the latest issuance', () => {
  // A asks for 60 points, which is inside its allowance R - q_1 = 61.01. Its gross hold is recorded. B is then decided on
  // the updated window at issuance 2 with fresh reserve q_2 at budget epsilon/6. Either B is admitted within R - g_A - q_2,
  // so the total stays within R - q_2, or B is held and A alone stays within its own allowance.
  const q1 = closedQ(10, 0.25 / 2), q2 = closedQ(10, 0.25 / 6);
  const decisionA = decide({windowsOverride: weeklyWindow({}), requestedUsd: 60});
  assert.equal(decisionA.admitted, true, decisionA.reasonCode);
  const grossA = decisionA.exposureUsdMicro / M;
  assert.ok(grossA <= 100 - q1 + EPS, `A ${grossA} exceeds its own allowance ${100 - q1}`);
  const issuanceA = decisionA.modelForecasts.seven_day;
  assert.equal(issuanceA.updateIndex, 1);
  const decisionB = decide({windowsOverride: weeklyWindow({committedMicro: decisionA.exposureUsdMicro}), requestedUsd: 60,
    modelDataByResource: {seven_day: {updateIndex: 2, forecasts: [{ownerAtIssue: 0, reservePoints: issuanceA.reservePoints}]}}});
  if (decisionB.admitted) {
    const grossB = decisionB.exposureUsdMicro / M;
    assert.ok(grossA + grossB <= 100 - q2 + EPS, `total ${grossA + grossB} exceeds R - q_2 ${100 - q2}`);
  } else {
    // B is held by design, as objective_exceeds_spare (its request is above the spare left after A), and A alone stays inside its
    // own allowance.
    assert.equal(decisionB.admitted, false);
    assert.equal(decisionB.projection.reasonCode, 'objective_exceeds_spare', decisionB.projection.reasonCode);
    assert.ok(grossA <= 100 - q1 + EPS);
  }
});

test('concurrent claims on one issuance index: a second claim from a stale snapshot is refused at persistence', () => {
  // Two decisions made from the same snapshot both claim index 1. Once the first is recorded, the count is 1 and a
  // second index-1 claim fails the index guard, so the window cannot issue twice on one budget.
  const first = decide({windowsOverride: weeklyWindow({})});
  const second = decide({windowsOverride: weeklyWindow({})});
  assert.equal(first.modelForecasts.seven_day.updateIndex, second.modelForecasts.seven_day.updateIndex);
  assert.throws(() => checkUpdateIndex(1, second.modelForecasts.seven_day.updateIndex), /next issued index is 2/);
});

test('an issuance persists the shape the decision record stores, with riskAlpha equal to epsilon/2 for the first issuance', () => {
  const d = decide();
  assert.equal(d.admitted, true, d.reasonCode);
  const forecast = d.modelForecasts.seven_day;
  assert.equal(forecast.modelId, 'continuous-gamma-v1');
  assert.equal(forecast.updateIndex, 1);
  assert.ok(Math.abs(forecast.riskAlpha - 0.25 / 2) < 1e-15, String(forecast.riskAlpha));
  assert.equal(forecast.markBound, 1);
  assert.deepEqual(forecast.priorState, {version: 'declared', alpha0: 2, b0: 10, K: 1});
  assert.ok(Math.abs(forecast.reservePoints - (100 - d.projection.lendablePoints.seven_day)) < EPS);
});

test('the adapter loan equals the kernel scalar loan at the same chance level, and its expected loss is the closed form', () => {
  const r = continuousWindowProtection({model: LIGHT, epsilon: 0.25, nowMs: NOW, weeklyId: 'seven_day',
    windows: {seven_day: {kind: 'weekly', remainingMicro: 100 * M, resetAtMs: NOW + WEEK_MS, ownerUsedMicro: 0,
      pointsPerUsdMicro: M}}});
  assert.equal(r.problem, undefined);
  // The kernel is the research reference. Its loan is positive here, so its objective gate does not apply.
  const exact = action({R: 100, lambda: 4, law: {k: 1, alpha: 2, b: 10}, eta: 0.25 / 2});
  const x = r.lendMicro.seven_day / M;
  assert.ok(Math.abs(x - exact.loan) < 1e-6, `${x} != ${exact.loan}`);
  assert.ok(Math.abs(r.expectedLoss({seven_day: x}) - closedLoss(100, x, 10)) < 1e-9);
});

test('an update index that does not follow the issued count is refused, never silently renumbered', () => {
  const d = decide({modelDataByResource: {seven_day: {updateIndex: 1, forecasts: [{ownerAtIssue: 0, reservePoints: 95}]}}});
  assert.equal(d.admitted, false);
  assert.equal(d.reasonCode, 'demand_model_invalid');
});

test('an issue that recorded more owner usage than now is nonmonotone and refused as unreconciled usage', () => {
  const d = decide({windowsOverride: weeklyWindow({usedMicro: 2 * M}), modelDataByResource: {seven_day: {updateIndex: 2,
    forecasts: [{ownerAtIssue: 5, reservePoints: 50}]}}});
  assert.equal(d.admitted, false);
  assert.equal(d.reasonCode, 'demand_model_exact_usage_required');
});

test('an unrecognized demand model is a named hold, not a silent default', () => {
  const d = decide({demandModel: {kind: 'not-a-model'}});
  assert.equal(d.admitted, false);
  assert.equal(d.reasonCode, 'demand_model_unavailable');
});

test('a request above the remaining window reports its expected loss at the whole window instead of throwing', () => {
  const r = continuousWindowProtection({model: LIGHT, epsilon: 0.25, nowMs: NOW, weeklyId: 'seven_day',
    windows: {seven_day: {kind: 'weekly', remainingMicro: 40 * M, resetAtMs: NOW + WEEK_MS, ownerUsedMicro: 60 * M,
      pointsPerUsdMicro: M}}});
  assert.equal(r.problem, undefined, r.problem);
  const atWindow = r.expectedLoss({seven_day: 40});
  assert.ok(Number.isFinite(atWindow) && atWindow > 0);
  assert.equal(r.expectedLoss({seven_day: 60}), atWindow);
});

// Closed-form expected owner loss for a shape-one day-one law: S(x) = integral over [R-x, R] of (b/(b+s))^2 ds
// = b [1/(b+R-x) - 1/(b+R)] * b  (the integrand is (b/(b+s))^2).
function closedLoss(R, x, b) {
  return b * b * (1 / (b + R - x) - 1 / (b + R));
}
