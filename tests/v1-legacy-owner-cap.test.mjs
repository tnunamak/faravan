import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLendingManager} from '../lib/v1/lending-manager.mjs';

// M1 removed the independent legacy allocator. Compatibility callers must use
// the same durable candidate, including its owner-cap decision and native budget.
test('legacy manager without a durable candidate fails closed instead of allocating a second budget', async () => {
  assert.deepEqual(await createLendingManager().reserve({provider: 'claude'}),
    {ok: false, reason: 'objective_evidence_unknown'});
});
test('legacy manager preserves the durable candidate owner-cap refusal and budget without recomputing either', async () => {
  const args = {provider: 'claude', model: 'claude-haiku-5-5', job: {budget_v1: {max_list_usd: 4}}};
  for (const result of [
    {ok: false, reason: 'quota_reserve', policyReason: 'budget_too_small'},
    {ok: true, lendingBudget: {agent: 'claude', budget: {unit: 'claude_usd', limit: 0.5}}, maxBudgetUsd: 0.5},
  ]) {
    let calls = 0;
    const manager = createLendingManager({candidate: {reserve: async actual => {
      calls++; assert.equal(actual, args); return result;
    }}});
    assert.equal(await manager.reserve(args), result);
    assert.equal(calls, 1);
  }
});
