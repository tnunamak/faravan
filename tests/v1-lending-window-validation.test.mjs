import './helpers/no-browser.mjs';
// Review regression (dot re-review faravan-review-core-r2-1024, P1): every window's latest issuance is validated, not only
// the weekly one. Both windows bind, so a corrupt latest short-window record must fail closed as well.
import test from 'node:test';
import assert from 'node:assert/strict';
import {CONTINUOUS_DEMAND_MODEL, continuousWindowProtection, WEEK_MS} from '../lib/v1/lending-continuous-model.mjs';

const M = 1_000_000;

// The report's setup: a full weekly window and a five-hour window, both with usage 0 and one point per USD.
function twoWindows(modelDataByResource) {
  const cap = {remainingMicro: 100 * M, ownerUsedMicro: 0, pointsPerUsdMicro: M};
  return continuousWindowProtection({model: CONTINUOUS_DEMAND_MODEL, epsilon: 0.5, nowMs: 0, weeklyId: 'w',
    windows: {w: {kind: 'weekly', resetAtMs: WEEK_MS, ...cap}, s: {kind: 'short', resetAtMs: 18_000_000, ...cap}},
    modelDataByResource});
}

test('a finite nonmonotone latest short-window issuance is refused as exact usage required, not lent through', () => {
  const r = twoWindows({s: {forecasts: [{reservePoints: 1, ownerAtIssue: 1}]}});
  assert.equal(r.problem, 'demand_model_exact_usage_required');
});

test('an invalid latest short-window reserve is refused as an invalid model state', () => {
  const r = twoWindows({s: {forecasts: [{reservePoints: Number.NaN, ownerAtIssue: 0}]}});
  assert.equal(r.problem, 'demand_model_invalid');
});

test('a consistent latest short-window issuance is accepted: the validation refuses only inconsistent records', () => {
  const r = twoWindows({s: {forecasts: [{reservePoints: 1, ownerAtIssue: 0}]}});
  assert.equal(r.problem, undefined, r.problem);
  assert.ok(r.reservesMicro.w >= 1 && r.reservesMicro.s >= 0);
});

test('a non-finite latest weekly reserve is still refused as an invalid model state', () => {
  const r = twoWindows({w: {forecasts: [{reservePoints: Number.NaN, ownerAtIssue: 0}]}});
  assert.equal(r.problem, 'demand_model_invalid');
});
