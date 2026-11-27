import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createUsageHostReader} from '../lib/v1/usage-host-reader.mjs';
import {createGuardReads} from '../lib/v1/guard-read.mjs';
import {createLendingReadingRunner} from '../lib/v1/lending-reading-runner.mjs';
import {createDaemonGate} from '../lib/v1/daemon-gate.mjs';
import {appFixture, api, syntheticBackend} from './helpers/v1-app-fixture.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';

// Host usage reads replaced the sandbox readings and their daemon gate. Two guarantees of that gate are kept as tests here:
// one provider request per account however many callers ask at once, and no read ever waits behind a stop check.
const NOW = Date.now();
const usageBody = {five_hour: {utilization: 10, resets_at: new Date(NOW + 3 * 3600e3).toISOString()},
  seven_day: {utilization: 20, resets_at: new Date(NOW + 4 * 86400e3).toISOString()}, extra_usage: {is_enabled: false}};
function rig() {
  const usage = [], pending = [];
  const fetchImpl = (url, options) => new Promise(resolve => {
    const path = new URL(url).pathname;
    const answer = () => resolve({status: 200, headers: {get: () => null}, json: async () => path === '/api/oauth/usage' ? usageBody : {account: {uuid: 'u', email: 'a@example.test'}, organization: {uuid: 'o'}}});
    if (path === '/api/oauth/usage') { usage.push(options.headers.Authorization); pending.push(answer); } else answer();
  });
  const store = {credential: async accountKey => ({accountKey, provider: 'claude', kind: 'oauth', generation: 'g1', bearer: 'synthetic-' + accountKey, expiresAt: NOW + 8 * 3600e3})};
  const reader = createUsageHostReader({store, fetchImpl, now: () => NOW});
  const settleAll = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); while (pending.length) pending.shift()(); };
  return {reader, usage, settleAll};
}
const A = 'claude', B = 'claude:7248ba68-0000-4000-8000-000000000001';

test('a guard read and a status read of one account at the same time share one provider request; another account has its own', async () => {
  const {reader, usage, settleAll} = rig();
  const guard = createGuardReads({reader})({provider: 'claude', accountKey: A}), status = createLendingReadingRunner({reader});
  const reads = [guard.run({provider: 'claude'}), status({provider: 'claude', accountKey: A}), status({provider: 'claude', accountKey: A}),
    status({provider: 'claude', accountKey: B}), createGuardReads({reader})({provider: 'claude', accountKey: B}).run({provider: 'claude'})];
  await new Promise(resolve => setImmediate(resolve));
  await settleAll();
  const results = await Promise.all(reads);
  assert.ok(results.every(r => r.host_read === true));
  assert.deepEqual(results.map(r => r.account_key), [A, A, A, B, B], 'each result names the account it was asked for');
  assert.deepEqual(usage.slice().sort(), ['Bearer synthetic-' + A, 'Bearer synthetic-' + B].sort(), 'one request per account, each with its own bearer');
  // A later read is a new flight.
  const later = status({provider: 'claude', accountKey: A});
  await settleAll();
  await later;
  assert.equal(usage.length, 3);
});

test('a guard read and a status read never wait behind a queued or running stop check', async () => {
  const {reader, settleAll} = rig(), gate = createDaemonGate();
  // The stop check holds the daemon gate, and a second check waits in line behind it.
  let releaseCheck;
  const running = gate.run(() => new Promise(resolve => { releaseCheck = resolve; }), {label: 'stop check'});
  const queued = gate.run(async () => {}, {label: 'queued stop check'});
  await new Promise(resolve => setImmediate(resolve));
  const guard = createGuardReads({reader})({provider: 'claude', accountKey: A}), status = createLendingReadingRunner({reader});
  const reads = Promise.all([guard.run({provider: 'claude'}), status({provider: 'claude', accountKey: B})]);
  await new Promise(resolve => setImmediate(resolve));
  await settleAll();
  const settled = await Promise.race([reads.then(() => 'read'), new Promise(resolve => setTimeout(() => resolve('waiting'), 500))]);
  assert.equal(settled, 'read', 'both reads finished while the stop check still held the gate');
  releaseCheck();
  await Promise.all([running, queued]);
});

// The same guarantee through the app: the app's own daemon gate is held by a running stop check with another queued behind it,
// and the app's status refresh and readiness reads, for two accounts, still finish. (Guard reads need a lent job; they are covered above.)
test('the app\'s status and readiness reads finish while a stop check runs and another waits on the app\'s daemon gate', {timeout: 60000}, async t => {
  const f = await appFixture(t), gate = createDaemonGate(), requests = [];
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    requests.push({path, auth: options.headers.Authorization});
    const body = path === '/api/oauth/usage' ? usageBody : path === '/api/oauth/profile' ? {account: {uuid: 'uuid-a', email: 'a@example.test'}, organization: {uuid: 'org-a'}} : {};
    return {status: 200, headers: {get: () => null}, json: async () => body};
  };
  const store = {credential: async accountKey => ({accountKey, provider: 'claude', kind: 'oauth', generation: 'g1', bearer: 'synthetic-' + accountKey, expiresAt: NOW + 8 * 3600e3})};
  const {app} = await f.start('owner', {backend: syntheticBackend(f.root), daemonGate: gate, lendingHostReader: createUsageHostReader({store, fetchImpl}), lendingUsageStore: store,
    adapters: () => [{spec: legacyProxyHarness('claude-code-subscription'), installed: true, signedIn: true, models: ['claude-sonnet-5-5'], capabilities: []}],
    identityProbe: async () => ({providers: [{harness_id: 'claude-code-subscription', installed: true, signedIn: true}]})});
  await api(app, '/api/agents/claude-code-subscription', {method: 'POST', body: {useForLending: true}});
  const registry = app.lendingAccounts().registry(), added = registry.add({provider: 'claude', label: 'B work'});
  registry.setEnabled(added.id, true);
  const keys = ['claude', 'claude:' + added.id];
  let release, queuedRan = false;
  const running = gate.run(() => new Promise(resolve => { release = resolve; }), {label: 'stop check'});
  const queued = gate.run(async () => { queuedRan = true; }, {label: 'queued stop check'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queuedRan, false, 'the second stop check is queued behind the first');
  const drive = (async () => {
    for (const accounts of [[keys[0]], [keys[1]], keys]) {
      await api(app, '/api/agents/refresh', {method: 'POST', body: {accounts}});
      await api(app, '/api/lending/readiness');
    }
    return 'read';
  })();
  const settled = await Promise.race([drive, new Promise(resolve => setTimeout(() => resolve('waiting'), 15000))]);
  assert.equal(settled, 'read', 'status and readiness reads finished while the gate was held');
  assert.equal(queuedRan, false, 'and the gate was still held');
  assert.deepEqual(new Set(requests.map(r => r.auth)), new Set(keys.map(k => 'Bearer synthetic-' + k)), 'both accounts were really read');
  release();
  await Promise.all([running, queued]);
});
