import './helpers/no-browser.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {appFixture, api, waitFor, syntheticBackend} from './helpers/v1-app-fixture.mjs';

// A failing optional history note must leave one private diagnostic row and must not stop lending.
const unlistedModelAdapters = () => [{spec:legacyProxyHarness('claude-code-subscription'), installed: true, signedIn: true,
  harnessVersion: 'synthetic-only', models: [], capabilities: []}];

async function freshAutomaticOwner(t, {lendingHistory}) {
  const f = await appFixture(t);
  const backend = syntheticBackend(f.root), probeCapabilities = backend.probeCapabilities.bind(backend);
  backend.probeCapabilities = async options => ({...await probeCapabilities(options), backend_id: 'synthetic-only', version: 'synthetic-version'});
  const body = {five_hour: {utilization: 5, resets_at: new Date(Date.now() + 5 * 3600000).toISOString()},
    seven_day: {utilization: 10, resets_at: new Date(Date.now() + 7 * 86400000).toISOString()}, extra_usage: {is_enabled: false}};
  const probes = [];
  const runner = async ({provider}) => {
    probes.push(provider);
    return {exitCode: 0, stdout: JSON.stringify({faravan_probe: 1, status: 200, body,
      identity: {status: 200, account_sha256_16: '1111222233334444', email_sha256_16: 'aaaabbbbccccdddd'},
      guest_auth: {loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty'}}),
      executor: {backend_id: 'synthetic-only', sbx_version: 'synthetic-version'},
      stop: {delivered: true, fallback: null, latency_ms: 1, removed: true}};
  };
  const {owner, lender, circle} = await f.connect({backend, adapters: unlistedModelAdapters, lendingProbeRunner: runner, lendingHistory,
    lendingExpectedIdentity: () => ({email_sha256_16: 'aaaabbbbccccdddd'})});
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false,
    lendingPolicy: {accountPlans: {claude: 'max20'}, providerConsent: {claude: true}}}});
  await api(lender.app, '/api/agents/claude-code-subscription', {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/agents/claude-code-subscription/run', {method: 'POST', body: {model: 'claude-haiku-5-5', effort: null}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'auto'}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  await api(owner.app, '/api/jobs', {method: 'POST', body: {circle: circle.id,
    git: {url: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40)},
    prompt: 'Synthetic Claude admission: no external execution.', harness: 'claude-code-subscription',
    model: 'claude-haiku-5-5', budget_v1: {max_list_usd: 2}}});
  return {lender, probes, backend};
}

const decisionOf = async lender => {
  const view = await api(lender.app, '/api/lending');
  return view.objective?.accounts?.find(account => account.provider === 'claude')?.decision ?? null;
};

test('a failing optional history note writes one private warning row and lending still decides on the reading', {timeout: 180000}, async t => {
  const failing = {claude: {record() { throw new Error('PRIVATE_HISTORY_STORAGE'); }, ownerTraces: () => []}};
  const {lender, probes} = await freshAutomaticOwner(t, {lendingHistory: failing});
  await waitFor(() => probes.length > 0, 'the waiting job to reach the quota gate, which takes the reading', 60000);
  const decision = await waitFor(async () => {
    const row = await decisionOf(lender);
    return row?.reason && row.reason !== 'objective_evidence_unknown' ? row : null;
  }, 'a specific decision from the reading despite the failed history note', 60000);
  assert.notEqual(decision.reason, 'objective_evidence_unknown');
  const file = join(lender.home, 'v1', 'lending-errors.jsonl');
  const rows = (await waitFor(async () => {
    try {
      const lines = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      return lines.some(row => row.code === 'history_write_failed') ? lines : null;
    } catch { return null; }
  }, 'the history warning row', 30000)).filter(row => row.code === 'history_write_failed');
  assert.equal(rows.length, 1, 'one row per failed note in this run');
  assert.equal(typeof rows[0].at, 'string');
  assert.ok(Number.isFinite(Date.parse(rows[0].at)));
  assert.equal(JSON.stringify(rows).includes('PRIVATE_HISTORY_STORAGE'), false, 'raw recorder text never reaches the row');
  const log = await api(lender.app, '/api/lending/log');
  assert.equal(log[0].code, 'history_write_failed');
  assert.equal(log[0].message, 'Faravan could not save a usage history note for an account. Lending is not affected.');
});
