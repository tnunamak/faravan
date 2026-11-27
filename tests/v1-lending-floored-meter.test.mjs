import './helpers/no-browser.mjs';
// A whole-point meter reading r bounds owner usage Z from above: Z < r + v for one meter unit v (paper 06 section 5). It
// enters the continuous model as its upper surrogate r + v, never as exact latent usage. Expected values are
// the day-one closed form (k = 1, Lomax quantile) and the monotone dominance of the reserve in usage, not values read back.
import test from 'node:test';
import assert from 'node:assert/strict';
import {quantile} from '../lib/v1/lending-continuous.mjs';
import {CONTINUOUS_DEMAND_MODEL, DEFAULT_PRIOR, WEEK_MS, continuousLaw, continuousWindowProtection} from '../lib/v1/lending-continuous-model.mjs';
import {decideObjectiveLend} from '../lib/v1/lending-objective.mjs';

const MICRO = 1_000_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 24, 12);
const WEEKLY = 'seven_day';
// The declared meter unit: the provider reports whole points, so v = one point (lending-pace50-source.mjs, uncertainty_micro).
const UNIT = MICRO;
const DIALS = [0.1, 0.25, 0.5];
// Issuance n spends epsilon/[n(n+1)] (lending-risk-ledger.mjs): n = 1, 2, 3.
const issuanceLevels = epsilon => [epsilon / 2, epsilon / 6, epsilon / 12];
const gates = {consent: true, limits: true, funding: true, stopping: true};
const band = {position: 'keep_more_for_me', weekStart: 100, epoch: 'e', procedure: 'frozen-v1', domain: ['weekly@0', 'short@0'],
  weeks: Array.from({length: 9}, (_, i) => ({id: 'w' + i, end: i, epoch: 'e', procedure: 'frozen-v1', complete: true,
    upperScores: {'weekly@0': 10, 'short@0': 5}})),
  forecasts: [{id: 'weekly', domain: 'weekly@0', prediction: 0, scale: 1}, {id: 'short', domain: 'short@0', prediction: 0, scale: 1}]};

// The weekly window as the objective builds it: remaining = cap - reading - unit (lending-objective.mjs). The origin is
// `exposureWeeks` before now, and the reset is a week after the origin, so the remaining shape is 1 - exposureWeeks.
function weeklyAt({exposureWeeks, readingPoints, uncertaintyMicro = UNIT, originAtMs = NOW - exposureWeeks * WEEK_MS}) {
  return {
    windows: {[WEEKLY]: {kind: 'weekly', remainingMicro: 100 * MICRO - readingPoints * MICRO - uncertaintyMicro,
      resetAtMs: originAtMs + WEEK_MS, ownerUsedMicro: readingPoints * MICRO, uncertaintyMicro, pointsPerUsdMicro: MICRO}},
    modelDataByResource: {[WEEKLY]: {originAtMs, initialOwnerUsedMicro: 0}},
  };
}

test('a zero whole-point reading at positive exposure lends on day one: an amount and no hold at every dial', () => {
  for (const hours of [1, 7, 17, 42]) {
    for (const epsilon of DIALS) {
      const r = continuousWindowProtection({model: CONTINUOUS_DEMAND_MODEL, epsilon, nowMs: NOW, weeklyId: WEEKLY,
        ...weeklyAt({exposureWeeks: hours / 168, readingPoints: 0})});
      assert.equal(r.problem, undefined, `${hours} h at epsilon ${epsilon} must not hold: ${r.problem}`);
      assert.equal(r.predictiveFeasible, true, `${hours} h at epsilon ${epsilon}`);
      assert.ok(r.lendMicro[WEEKLY] > 0, `${hours} h at epsilon ${epsilon} lends a positive amount`);
    }
  }
});

test('the zero-reading loan is the closed form at the surrogate posterior Gamma(2 + a, b0 + 1): remaining shape 1', () => {
  for (const hours of [1, 17, 42]) {
    const a = hours / 168;
    for (const epsilon of DIALS) {
      // Reset one week after now, so the remaining shape is 1 and the reserve is b (eta^(-1/alpha) - 1) in closed form.
      const nowWindow = {windows: {[WEEKLY]: {kind: 'weekly', remainingMicro: 99 * MICRO, resetAtMs: NOW + WEEK_MS,
        ownerUsedMicro: 0, uncertaintyMicro: UNIT, pointsPerUsdMicro: MICRO}},
        modelDataByResource: {[WEEKLY]: {originAtMs: NOW - a * WEEK_MS, initialOwnerUsedMicro: 0}}};
      const r = continuousWindowProtection({model: CONTINUOUS_DEMAND_MODEL, epsilon, nowMs: NOW, weeklyId: WEEKLY, ...nowWindow});
      assert.equal(r.problem, undefined, `${hours} h, epsilon ${epsilon}: must not hold`);
      const alpha = 2 + a, b = DEFAULT_PRIOR.b0 + 1;
      const reserve = b * ((epsilon / 2) ** (-1 / alpha) - 1);
      assert.ok(Math.abs(r.lendMicro[WEEKLY] / MICRO - (99 - reserve)) <= 2e-6,
        `${hours} h, epsilon ${epsilon}: loan ${r.lendMicro[WEEKLY] / MICRO} vs closed form ${99 - reserve}`);
    }
  }
});

test('at the same exposure the surrogate reserve is at least the reserve for any exact usage in [r, r + v), at every issuance level', () => {
  for (const exposureWeeks of [0.01, 0.25, 0.6]) {
    for (const reading of [0, 1, 37, 80]) {
      const originAtMs = NOW - exposureWeeks * WEEK_MS, resetAtMs = originAtMs + WEEK_MS;
      const lawAt = (usedMicro, uncertaintyMicro) => {
        const law = continuousLaw({prior: DEFAULT_PRIOR, originAtMs, nowMs: NOW, resetAtMs, usedSinceOriginMicro: usedMicro,
          uncertaintyMicro});
        return {k: law.k, alpha: law.alpha, b: law.b};
      };
      for (const epsilon of DIALS) {
        for (const eta of issuanceLevels(epsilon)) {
          const surrogate = quantile(lawAt(reading * MICRO, UNIT), eta);
          // Exact usage over positive exposure is positive: a grid over [reading, reading + 1) that skips the impossible zero.
          for (let j = 0; j < 16; j++) {
            const usedMicro = reading * MICRO + j * (MICRO / 16);
            if (usedMicro === 0) continue;
            const exact = quantile(lawAt(usedMicro, 0), eta);
            assert.ok(surrogate >= exact,
              `exposure ${exposureWeeks} wk, reading ${reading}, usage ${usedMicro / MICRO}, eta ${eta}: ` +
              `surrogate ${surrogate} < exact ${exact}`);
          }
        }
      }
    }
  }
});

test('the surrogate is the exact usage at the upper end of the reading interval, and only the posterior label differs', () => {
  const surrogate = continuousLaw({prior: DEFAULT_PRIOR, originAtMs: NOW - HOUR * 17, nowMs: NOW,
    resetAtMs: NOW + WEEK_MS, usedSinceOriginMicro: 37 * MICRO, uncertaintyMicro: UNIT});
  const atUpperEnd = continuousLaw({prior: DEFAULT_PRIOR, originAtMs: NOW - HOUR * 17, nowMs: NOW,
    resetAtMs: NOW + WEEK_MS, usedSinceOriginMicro: 38 * MICRO, uncertaintyMicro: 0});
  assert.equal(surrogate.observation, 'rounded_upper_surrogate');
  assert.equal(atUpperEnd.observation, 'exact_latent');
  assert.deepEqual([surrogate.alpha, surrogate.b], [atUpperEnd.alpha, atUpperEnd.b]);
});

test('exact sources keep exact_latent: with no declared unit a zero reading over positive exposure is still refused', () => {
  assert.throws(() => continuousLaw({prior: DEFAULT_PRIOR, originAtMs: NOW - HOUR, nowMs: NOW, resetAtMs: NOW + WEEK_MS,
    usedSinceOriginMicro: 0, uncertaintyMicro: 0}), /impossible exact Gamma observation/);
  // At zero exposure nothing has elapsed, so the usage since origin is exactly zero and no surrogate applies.
  const atOrigin = continuousLaw({prior: DEFAULT_PRIOR, originAtMs: NOW, nowMs: NOW, resetAtMs: NOW + WEEK_MS,
    usedSinceOriginMicro: 0, uncertaintyMicro: UNIT});
  assert.equal(atOrigin.observation, 'exact_latent');
  assert.deepEqual([atOrigin.alpha, atOrigin.b], [2, DEFAULT_PRIOR.b0]);
});

test('the objective admits a zero-reading window on a later request, and its headroom already nets the unit', () => {
  const originAtMs = NOW - 17 * HOUR;
  const decision = decideObjectiveLend({now: NOW, observedAt: NOW, position: 'keep_more_for_me', weeklyResource: WEEKLY,
    laterBurnCapacityMicro: 0, gates, band, frozenProtectionSource: 'model',
    windows: {[WEEKLY]: {kind: 'weekly', known: true, fresh: true, compatible: true, usedMicro: 0, committedMicro: 0,
      uncertaintyMicro: UNIT, pointsPerUsdMicro: MICRO, resetAtMs: originAtMs + WEEK_MS, ownerUsedMicro: 0}},
    modelDataByResource: {[WEEKLY]: {originAtMs, initialOwnerUsedMicro: 0}},
    job: {friendValue: 10, estimateUsdMicro: MICRO, requestedUsdMicro: MICRO, worstCallUsdMicro: 0, wallMs: 1, uncertaintyMs: 1,
      stopMs: 1}});
  assert.notEqual(decision.reasonCode, 'demand_model_exact_usage_required', decision.reasonText);
  assert.equal(decision.admitted, true, decision.reasonText);
  assert.equal(decision.lendablePoints[WEEKLY] + decision.protectedOwnerPoints[WEEKLY], 99,
    'the window headroom is the cap less the reading and the unit');
});

test('the joint decision, with the five-hour window built as production builds it, admits a zero reading too', () => {
  for (const exposureHours of [1, 17]) {
    const originAtMs = NOW - exposureHours * HOUR;
    for (const position of ['keep_more_for_me', 'balanced']) {
      const decision = decideObjectiveLend({now: NOW, observedAt: NOW, position, weeklyResource: WEEKLY, laterBurnCapacityMicro: 0,
        gates, band, frozenProtectionSource: 'model',
        windows: {
          [WEEKLY]: {kind: 'weekly', known: true, fresh: true, compatible: true, usedMicro: 0, committedMicro: 0,
            uncertaintyMicro: UNIT, pointsPerUsdMicro: 50_000, resetAtMs: originAtMs + WEEK_MS, ownerUsedMicro: 0},
          five_hour: {kind: 'short', known: true, fresh: true, compatible: true, usedMicro: 0, committedMicro: 0,
            uncertaintyMicro: UNIT, pointsPerUsdMicro: 1_000, resetAtMs: NOW + 4 * HOUR, ownerUsedMicro: 0},
        },
        modelDataByResource: {[WEEKLY]: {originAtMs, initialOwnerUsedMicro: 0}},
        job: {friendValue: 10, estimateUsdMicro: MICRO, requestedUsdMicro: MICRO, worstCallUsdMicro: 0, wallMs: 1, uncertaintyMs: 1,
          stopMs: 1}});
      assert.equal(decision.admitted, true, `${exposureHours} h, ${position}: ${decision.reasonText}`);
      assert.ok(decision.lendablePoints[WEEKLY] > 0, `${exposureHours} h, ${position}: a positive weekly loan`);
    }
  }
});
