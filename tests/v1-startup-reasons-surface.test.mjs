import './helpers/no-browser.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, api, waitFor, adapters} from './helpers/v1-app-fixture.mjs';
import {OPS} from '../lib/v1/ops/registry.mjs';

// Item 3 of the startup lane: the status read names the hold it is in. A named evidence hold is not replaced by a generic
// operation_failed, and every decision carries its strategy id and protection source. Synthetic readings only.
const harness = 'claude-code-subscription';

async function askToLend(owner, lender, circle) {
  const ownerLimits = await api(lender.app, '/api/lending/owner-settings');
  const sourceTestCap = Math.max(20, ...ownerLimits.minimums.map(row => row.minimumMaxJobUsd)) + 1;
  await api(lender.app, '/api/lending/owner-settings', {method:'POST', body:{maxJobUsd:sourceTestCap,
    reason:'test the source hold beyond the worst-call budget guard'}});
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200,
    idleOnly: false, lendingPolicy: {providerConsent: {claude: true}, accountPlans: {claude: 'max20'}}}});
  await api(lender.app, '/api/agents/' + harness, {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'auto'}});
  await api(owner.app, '/api/jobs', {method: 'POST', body: {circle: circle.id, git: 'https://github.com/example/synthetic.git',
    commit: '1'.repeat(40), prompt: 'reasons surface', harness}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
}

test('the status read names the evidence hold instead of operation_failed, with its strategy and protection source', {timeout: 120000}, async t => {
  const realNow = Date.now.bind(Date);
  const reset = realNow() + 86400000;
  const f = await appFixture(t);
  const {owner, lender, circle} = await f.connect({
    adapters: adapters().map(a => ({...a, spec:legacyProxyHarness(harness)})),
    quotaReader: async () => ({provider: 'claude', remaining: 100, observedAt: realNow()}),
    lendingReadings: async () => ({windows: [{window_id: 'seven_day', window_minutes: 10080, state: 'open', used_pct: 5,
      observed_at: realNow(), resets_at: reset}]}),
  });
  await askToLend(owner, lender, circle);
  const status = await waitFor(async () => {
    const view = await api(lender.app, '/api/lending');
    return view.objective?.accounts?.find(account => account.id === 'claude')?.decision?.reason === 'objective_evidence_unknown' ? view : null;
  }, 'the named hold reaches the status read', 20000);
  assert.notEqual(status.reason, 'operation_failed', 'a provider hold is not flattened into a generic operation failure');
  const decision = status.objective.accounts.find(account => account.id === 'claude').decision;
  // Saved windows with no reading from this run wait for a fresh reading. The hold is per-provider: it must not become a
  // global Codex hold.
  assert.equal(decision.reason, 'objective_evidence_unknown', 'the provider status names the hold');
  assert.equal(decision.strategy, 'automatic', 'the decision names its strategy id');
  assert.ok(typeof decision.objective.reasonText === 'string' && decision.objective.reasonText.length > 0, 'the hold has a sentence');
  assert.ok(Object.hasOwn(decision.objective, 'protectionSource'), 'the decision names its protection source (null until known)');
  assert.equal(decision.objective.protectionSource, null, 'a hold waiting for evidence has no protection source yet, and the surface says null');
});

test('the status read shows the strategy the owner chose, not a hard-coded automatic one', {timeout: 120000}, async t => {
  const f = await appFixture(t);
  const {lender} = await f.connect();
  const saved = await api(lender.app, '/api/lending/limits', {method: 'POST', body: {
    lendingPolicy: {strategy: 'fixed_share', strategyParams: {fixedSharePct: 20, keepPct: 30}}}});
  assert.ok(saved, 'the owner can save a fixed share strategy');
  const view = await api(lender.app, '/api/lending');
  assert.equal(view.objective.accounts.find(account => account.id === 'claude').decision.strategy, 'fixed_share');
});

// Agents read the registry before they call lending.get, so its description must name the three things the status read carries.
test('the ops registry describes the strategy id, the hold reason and the protection source', () => {
  const lending = OPS.find(op => op.id === 'lending.get');
  assert.ok(lending, 'lending.get is registered');
  assert.match(lending.description, /each provider objective/);
  assert.match(lending.output.properties.objective.description, /strategy id/);
  assert.match(lending.description, /hold reason/);
  assert.match(lending.description, /protection source/);
});
