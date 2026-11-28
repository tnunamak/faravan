import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateLending} from '../lib/v1/lending-policy.mjs';
import {calibration, MICRO, NOW, OWNER_NONE, RESET, windows} from './helpers/lending-objective-fixtures.mjs';

// The former pace50/owner_allowance comparison tested a second allocator.
// The durable objective rule is the only allocator, so legacy strategy labels cannot select a different answer.
const OBJECTIVE = {
  now: NOW,
  observedAt: NOW,
  windows: windows({weeklyUsedMicro: 10 * MICRO, shortUsedMicro: 0, resetAtMs: RESET}),
  band: calibration({weeks: 19}),
  owner: OWNER_NONE,
  gates: {consent: true, limits: true, funding: true, stopping: true},
  laterBurnCapacityMicro: 0,
  job: {id: 'strategy-independent', friendValue: 3, estimateUsdMicro: 3 * MICRO,
    requestedUsdMicro: 3 * MICRO, worstCallUsdMicro: 1_320_000,
    wallMs: 60_000, uncertaintyMs: 30_000, stopMs: 60_000},
};

test('legacy strategy labels cannot select a different objective allocation', () => {
  const results = ['pace50', 'owner_allowance', 'anything else'].map(strategy =>
    evaluateLending({objectiveInput: OBJECTIVE, policy: {protectionPosition: 'balanced'}, strategy}));
  const answer = {
    admitted: results[0].admitted,
    reason: results[0].reason,
    budget_units: results[0].budget_units,
    reasonCode: results[0].objective.reasonCode,
    maximumExposureUsd: results[0].objective.maximumExposureUsd,
    nativeMaxBudgetUsd: results[0].objective.nativeMaxBudgetUsd,
  };
  assert.deepEqual(answer, {admitted: true, reason: 'lend', budget_units: 1.68,
    reasonCode: 'objective_lend', maximumExposureUsd: 3, nativeMaxBudgetUsd: 1.68});
  for (const result of results.slice(1)) {
    assert.equal(result.admitted, answer.admitted);
    assert.equal(result.reason, answer.reason);
    assert.equal(result.budget_units, answer.budget_units);
    assert.deepEqual(result.objective, results[0].objective);
  }
});

test('the objective engine rejects an out-of-range typed strategy before applying its cap', () => {
  assert.throws(() => evaluateLending({objectiveInput: OBJECTIVE,
    policy: {strategy: 'fixed_share', strategyParams: {fixedSharePct: 150}}}), /invalid_lending_policy/);
});

test('the objective engine fills omitted strategy fields before normalizing the policy', () => {
  const result = evaluateLending({objectiveInput: OBJECTIVE,
    policy: {protectionPosition: 'balanced', strategy: undefined, strategyParams: undefined}});
  assert.equal(result.admitted, true);
});
