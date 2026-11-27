import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as adapter from '../lib/harnesses/claude-code-subscription.adapter.mjs';
import { normalizeLendingBudget } from '../lib/docker-backend.mjs';
import { claudeMaxBudgetUsd } from '../lib/faravan-guard-host.mjs';
import { claudeCallHeadroomUsd } from '../lib/v1/lending-meter.mjs';
import { paceInputFromObservation } from '../lib/v1/lending-pace50-source.mjs';

const T = Date.parse('2026-10-23T05:00:00Z');

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

test('unknown funding refuses the pace input even when identity is verified and every other fact is present', () => {
  const verified = {
    refresh_succeeded: true, complete: true, resources: [], weekly_resource_id: 'seven_day',
    identity: { verified: true, account_id: 'acct-test' }, account_week_id: 'week-test', epoch: 'epoch-test',
    executor: { single_executor: 'proven' }, stop: { bounded_execution: 'proven' }, stop_bound_ms: 30000, uncertainty_ms: 0,
    opening_anchor_known: false, resource_coupling_known: false,
  };
  for (const funding of [{ subscription_only: 'unknown', reason: 'extra_usage_enabled' }, { subscription_only: 'unknown' }]) {
    assert.deepEqual(paceInputFromObservation({ ...verified, funding }, { now: T, context: {} }), { refuse: 'funding_unknown' });
  }
  // Proven funding is necessary, not sufficient: a roster without a verified usage-to-resource conversion still refuses.
  const resource = { id: 'seven_day', kind: 'weekly', instance: 'seven_day@1', state: 'open', anchor_at: T - 1, resets_at: T + 1,
    duration_ms: 604800000, observed_at: T, used_micro: 20000000, kappa_micro: null, origin: null };
  const roster = { ...verified, resources: [resource] };
  const proven = { subscription_only: 'proven', reason: null };
  assert.deepEqual(paceInputFromObservation({ ...roster, funding: proven }, { now: T, context: {} }), { refuse: 'conversion_unknown' });
  assert.deepEqual(paceInputFromObservation({ ...roster, funding: proven, executor: { single_executor: 'unknown' } }, { now: T, context: {} }),
    { refuse: 'executor_unknown' });
});
