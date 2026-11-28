import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as adapter from '../lib/harnesses/claude-code-subscription.adapter.mjs';
import { normalizeLendingBudget } from '../lib/docker-backend.mjs';
import { claudeMaxBudgetUsd } from '../lib/faravan-guard-host.mjs';
import { claudeCallHeadroomUsd } from '../lib/v1/lending-meter.mjs';

test('a lent budget must hold one worst-case call before any Claude job starts', () => {
  // The one headroom: the largest context, priced in the tier that context reaches, plus a full output.
  const headroom = claudeCallHeadroomUsd('claude-haiku-5-5');
  assert.ok(headroom > 0, `headroom ${headroom}`);
  assert.ok(Math.abs(claudeMaxBudgetUsd({ limitUsd: headroom + 0.25, headroomUsd: headroom }) - 0.25) < 1e-6,
    'a limit that holds one call leaves the margin above one call as the cap');
  assert.equal(claudeMaxBudgetUsd({ limitUsd: headroom - 0.1, headroomUsd: headroom }), null, 'a budget below one call is refused, not shrunk');
});

test('a Claude job is never dispatched with a cap that is zero, negative or not a number', () => {
  for (const maxBudgetUsd of [0, -1, Number.NaN]) {
    assert.throws(() => adapter.jobCommand({ maxBudgetUsd, prompt: 'x', workspace: '/w', result: 'message' }),
      (error) => error.code === 'policy_unenforceable', `cap ${maxBudgetUsd}`);
  }
});

test('the lending guard refuses a zero, negative or wrong-unit budget before anything reaches the guest', () => {
  assert.throws(() => normalizeLendingBudget({ agent: 'claude', budget: { unit: 'claude_usd', limit: 0 } }), { code: 'policy_unenforceable' });
  assert.throws(() => normalizeLendingBudget({ agent: 'claude', budget: { unit: 'claude_usd', limit: -0.3 } }), { code: 'policy_unenforceable' });
  assert.throws(() => normalizeLendingBudget({ agent: 'claude', budget: { unit: 'codex_credits', limit: 0.3 } }), { code: 'policy_unenforceable' });
  assert.throws(() => normalizeLendingBudget({ agent: 'unknown', budget: null }), { code: 'policy_unenforceable' });
});
