import './helpers/no-browser.mjs';
// Review regression (dot re-review faravan-review-core-r2-1024, P2): a tiny positive band near reset must survive as a
// positive reserve. The loan used to be R - band, and in floating point a band of 9.8e-25 gave loan 100 and reserve 0,
// where survival(0) = 1 > eta. The reserve is now held directly, rounded up to whole micro-points and never below one.
import test from 'node:test';
import assert from 'node:assert/strict';
import {CONTINUOUS_DEMAND_MODEL, DEFAULT_PRIOR, WEEK_MS, continuousWindowProtection} from '../lib/v1/lending-continuous-model.mjs';
import {survival} from '../lib/v1/lending-continuous.mjs';

const M = 1_000_000;
const prior = k => ({k, alpha: DEFAULT_PRIOR.alpha0, b: DEFAULT_PRIOR.b0});
// The report's case: 50.4 minutes to reset is k = 0.005 weeks, so the remaining demand is almost surely near zero.
const RESET_MS = 3_024_000;

test('a 50.4-minute weekly window keeps a one-micro-point reserve, and that reserve meets the chance constraint', () => {
  const r = continuousWindowProtection({model: CONTINUOUS_DEMAND_MODEL, epsilon: 0.5, nowMs: 0, weeklyId: 'w',
    windows: {w: {kind: 'weekly', resetAtMs: RESET_MS, remainingMicro: 100 * M, ownerUsedMicro: 0, pointsPerUsdMicro: M}}});
  assert.equal(r.problem, undefined, r.problem);
  assert.equal(r.eta, 0.25);
  assert.equal(r.reservesMicro.w, 1, 'the smallest positive reserve, not zero');
  assert.equal(r.lendMicro.w, 100 * M - 1);
  assert.ok(survival(r.reservesMicro.w / M, prior(0.005)) <= r.eta, 'P(demand above the reserve) must not exceed eta');
});

test('a joint window whose short and weekly windows both reset in 50.4 minutes keeps the same one-micro-point reserve', () => {
  // The short window holds 200 points at the same rate, so its capacity C = 200 exceeds the weekly R = 100.
  const r = continuousWindowProtection({model: CONTINUOUS_DEMAND_MODEL, epsilon: 0.5, nowMs: 0, weeklyId: 'w',
    windows: {w: {kind: 'weekly', resetAtMs: RESET_MS, remainingMicro: 100 * M, ownerUsedMicro: 0, pointsPerUsdMicro: M},
      s: {kind: 'short', resetAtMs: RESET_MS, remainingMicro: 200 * M, ownerUsedMicro: 0, pointsPerUsdMicro: M}}});
  assert.equal(r.problem, undefined, r.problem);
  assert.equal(r.reservesMicro.w, 1, 'the smallest positive reserve, not zero');
  assert.ok(survival(r.reservesMicro.w / M, prior(0.005)) <= r.eta, 'P(demand above the reserve) must not exceed eta');
});

test('a scalar window with 3 minutes to reset keeps a one-micro-point reserve: its band is below the zero cutoff', () => {
  // Below about 4 minutes at this prior the eta-quantile lies below the kernel's range, so the band is zero to float
  // precision. The joint path already lent here, so the scalar path must agree with it rather than hold the window.
  const resetMs = 180_000;
  const r = continuousWindowProtection({model: CONTINUOUS_DEMAND_MODEL, epsilon: 0.5, nowMs: 0, weeklyId: 'w',
    windows: {w: {kind: 'weekly', resetAtMs: resetMs, remainingMicro: 100 * M, ownerUsedMicro: 0, pointsPerUsdMicro: M}}});
  assert.equal(r.problem, undefined, r.problem);
  assert.equal(r.reservesMicro.w, 1);
  assert.equal(r.lendMicro.w, 100 * M - 1);
  assert.ok(survival(r.reservesMicro.w / M, prior(resetMs / WEEK_MS)) <= r.eta);
});
