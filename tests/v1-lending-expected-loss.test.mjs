import './helpers/no-browser.mjs';
// The joint expected loss (paper 06 sections 4 and 7) and its numerical implementation. Expected values are closed forms (a
// polynomial, an endpoint step with a known integral, the scalar capped mean) or a high-resolution reference built from the joint
// risk itself through nestedCdf, not values read back from the implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {loss, nestedCdf} from '../lib/v1/lending-continuous.mjs';
import {CONTINUOUS_DEMAND_MODEL, WEEK_MS, compareExpectedLoss, compareExpectedLosses, continuousWindowProtection,
  integrateExpectedLoss} from '../lib/v1/lending-continuous-model.mjs';

const MICRO = 1_000_000;
const NOW = Date.UTC(2026, 9, 24, 12);
// The acceptance case (a) geometry: owner reading 10 points, 0.99 weeks elapsed, weekly headroom R = 89 (one unit held back), and a
// five-hour window that resets 30 minutes ahead.
const READING = 10, EXPOSURE_WEEKS = 0.99, EPSILON = 0.25;
const R = 100 - READING - 1;
const ORIGIN_MS = NOW - EXPOSURE_WEEKS * WEEK_MS;
const WEEKLY_RESET_MS = ORIGIN_MS + WEEK_MS;
const SHORT_RESET_MS = NOW + 30 * 60_000;
const K_SHORT = (SHORT_RESET_MS - NOW) / WEEK_MS;
const K_LATER = (WEEKLY_RESET_MS - SHORT_RESET_MS) / WEEK_MS;
const ALPHA = 2 + EXPOSURE_WEEKS;
const B = CONTINUOUS_DEMAND_MODEL.prior.b0 + READING + 1;
// Short points per weekly point. At 0.02 the short window cannot bind (C = 99 / 0.02 = 4950 >= R). At 2.98 it binds (C = 33.22 < R).
const NON_BINDING = {shortPointsPerUsdMicro: 1_000, shortPerWeekly: 0.02};
const BINDING = {shortPointsPerUsdMicro: 149_000, shortPerWeekly: 2.98};

function protectionFor({shortPointsPerUsdMicro}) {
  return continuousWindowProtection({model: CONTINUOUS_DEMAND_MODEL, epsilon: EPSILON, nowMs: NOW, weeklyId: 'seven_day',
    windows: {
      seven_day: {kind: 'weekly', remainingMicro: R * MICRO, resetAtMs: WEEKLY_RESET_MS, ownerUsedMicro: READING * MICRO,
        uncertaintyMicro: MICRO, pointsPerUsdMicro: 50_000},
      five_hour: {kind: 'short', remainingMicro: 99 * MICRO, resetAtMs: SHORT_RESET_MS, ownerUsedMicro: 0,
        uncertaintyMicro: MICRO, pointsPerUsdMicro: shortPointsPerUsdMicro},
    },
    modelDataByResource: {seven_day: {originAtMs: ORIGIN_MS, initialOwnerUsedMicro: 0}}});
}

// The joint risk, P(z < x) = 1 - G(C - x, R - x), as the implementation integrates it (paper 06 section 7).
const jointRisk = C => x => 1 - nestedCdf({short: C - x, week: R - x, kShort: K_SHORT, kLater: K_LATER, alpha: ALPHA, b: B});
// Uniform composite 8-point Gauss-Legendre with equal panels, the control for the graded rule.
const NODES = [0.1834346424956498, 0.5255324099163290, 0.7966664774136267, 0.9602898564975363];
const WEIGHTS = [0.3626837833783620, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763];
function uniformGauss(f, upper, panels) {
  const h = upper / panels;
  let total = 0;
  for (let p = 0; p < panels; p++) {
    const mid = (p + 0.5) * h, half = h / 2;
    let panel = 0;
    for (let j = 0; j < 4; j++) panel += WEIGHTS[j] * (f(mid - half * NODES[j]) + f(mid + half * NODES[j]));
    total += panel * half;
  }
  return total;
}

test('the graded 8-point rule integrates polynomials up to degree 15 exactly', () => {
  assert.ok(Math.abs(integrateExpectedLoss(x => x ** 14, 1) - 1 / 15) <= 1e-12);
  assert.ok(Math.abs(integrateExpectedLoss(x => x ** 15, 1) - 1 / 16) <= 1e-12);
  assert.equal(integrateExpectedLoss(x => 1, 0), 0);
});

test('the graded mesh resolves an endpoint step of the joint risk that a uniform rule of the same size misses', () => {
  // 1 - c (U - x)^p is the endpoint form of the joint risk when the remaining shape p is small. Its integral is closed form.
  const upper = 33.2215, c = 0.5, p = 0.003;
  const risk = x => 1 - c * (upper - x) ** p;
  const exact = upper - c * upper ** (p + 1) / (p + 1);
  const graded = integrateExpectedLoss(risk, upper);
  assert.ok(Math.abs(graded - exact) <= 1e-8, `graded ${graded} vs exact ${exact}`);
  const uniform = uniformGauss(risk, upper, 37);
  assert.ok(Math.abs(uniform - exact) > 1e-6, `the uniform control must miss: ${uniform} vs ${exact}`);
});

test('the first monotone mesh encloses a transition missed at both Gaussian resolutions', () => {
  const risk = x => x <= 5.84 ? 0 : x < 5.85 ? (x - 5.84) / 0.01 : 1;
  const coarseAndFine = integrateExpectedLoss(risk, 100);
  assert.equal(coarseAndFine, 94.140625, 'the two Gaussian resolutions agree on the missed value');
  const decision = compareExpectedLoss(risk, 100, 94.15, {maxEvaluations:38});
  assert.equal(decision.initialLower, 94.140625);
  assert.equal(decision.initialUpper, 100);
  assert.equal(decision.relation, 'unresolved', 'agreement must not decide while the threshold remains in the enclosure');
  assert.ok(decision.lower <= 94.15 && 94.15 <= decision.upper);
});

test('a linear CDF enclosure proves the expected loss is below its decision threshold', () => {
  const risk = x => x / 100;
  const result = compareExpectedLoss(risk, 100, 50.1);
  assert.equal(result.relation, 'below');
  assert.ok(result.lower <= 50 && result.upper >= 50, `the exact integral 50 is enclosed by [${result.lower}, ${result.upper}]`);
  assert.ok(result.evaluations <= 10_000);
});

test('two linear-CDF losses are ordered by their enclosures', () => {
  assert.equal(compareExpectedLosses(x => x / 100, 20, 40), -1);
});

test('loss ordering rejects a budget smaller than both initial meshes', () => {
  assert.throws(() => compareExpectedLosses(x => x / 100, 20, 40, {maxEvaluations:75}), /below the initial meshes/);
});

test('loss ordering holds when adjacent exposures leave a transition unresolved at float precision', () => {
  const risk = x => x < 0.1 ? 0 : x < 5.85 ? 0.25 : 1;
  assert.throws(() => compareExpectedLosses(risk, 100, 100.00000000000001,
    {bulkPanels:1, gradedLevels:0, maxEvaluations:400}), /expected loss unresolved/);
});

test('zero exposure leaves the full enclosure budget for the nonzero loss', () => {
  assert.equal(compareExpectedLosses(x => x / 100, 0, 20, {maxEvaluations:38}), -1);
});

test('the demand model compares losses through its window adapter', () => {
  const protection = protectionFor(NON_BINDING);
  assert.equal(protection.expectedLoss.compare({seven_day:20, five_hour:0}, {seven_day:30, five_hour:0}), -1);
});

test('a threshold inside the enclosure holds when the evaluation budget runs out', () => {
  const result = compareExpectedLoss(x => x / 100, 100, 50, {maxEvaluations:100});
  assert.equal(result.relation, 'unresolved');
  assert.equal(result.evaluations, 100, 'refinement stops at the configured risk-evaluation budget');
  assert.ok(result.lower <= 50 && 50 <= result.upper);
});
test('a near-cap binding loan that threw in the adaptive rule returns a finite bounded expected loss', () => {
  const C = 99 / BINDING.shortPerWeekly;
  const value = protectionFor(BINDING).expectedLoss({seven_day: C, five_hour: C * BINDING.shortPerWeekly});
  assert.ok(Number.isFinite(value) && value > 0, `value ${value}`);
  assert.ok(value <= C, `expected loss ${value} cannot exceed the $${C} exposure`);
});

test('a near-cap state without binding reduces to the closed-form scalar loss', () => {
  const C = 99 / NON_BINDING.shortPerWeekly;
  const value = protectionFor(NON_BINDING).expectedLoss({seven_day: R, five_hour: R * NON_BINDING.shortPerWeekly});
  assert.ok(Number.isFinite(value) && value > 0, `value ${value}`);
  const exact = loss(R, R, {k: (WEEKLY_RESET_MS - NOW) / WEEK_MS, alpha: ALPHA, b: B});
  assert.ok(Math.abs(value - exact) <= 1e-10, `value ${value} vs scalar ${exact} (C ${C})`);
});
