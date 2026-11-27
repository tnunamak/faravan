import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createUsageHostReader} from '../lib/v1/usage-host-reader.mjs';
import {createLendingReadingRunner} from '../lib/v1/lending-reading-runner.mjs';
import {appFixture, api, syntheticBackend} from './helpers/v1-app-fixture.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';

// Step 3d: a usage reading never creates a sandbox, on any platform, for either provider. Only the dedicated stop check may.
// The proof is at the composition boundary the app really uses: the app is started with a sandbox backend that traps every
// sandbox-making call, and its own reading wiring (status refresh and the lender's readiness read, for two accounts) is driven. The
// fake provider answers only the host reader, and each bearer is checked, so the reads really ran.
const T = Date.now();
const usageBody = {five_hour: {utilization: 10, resets_at: new Date(T + 3 * 3600e3).toISOString()},
  seven_day: {utilization: 20, resets_at: new Date(T + 4 * 86400e3).toISOString()}, extra_usage: {is_enabled: false}};
const SANDBOX_CALLS = ['prepare', 'start', 'run', 'create', 'cloneGitSource', 'requestStop', 'destroy', 'cancel', 'openMeterSession'];

for (const createFails of [false, true]) test(`the app's readings for two accounts reach the sandbox backend zero times (createFails=${createFails})`, {timeout: 60000}, async t => {
  const f = await appFixture(t), backend = syntheticBackend(f.root), reached = [];
  // Every sandbox-making method is a trap on the very backend the app uses for job sandboxes. With createFails it refuses too.
  for (const name of SANDBOX_CALLS) backend[name] = async () => { reached.push(name); if (createFails) throw new Error('create refused'); return {}; };
  const requests = [];
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    requests.push({path, auth: options.headers.Authorization});
    const body = path === '/api/oauth/usage' ? usageBody : path === '/api/oauth/profile' ? {account: {uuid: 'uuid-a', email: 'a@example.test'}, organization: {uuid: 'org-a'}} : {};
    return {status: 200, headers: {get: () => null}, json: async () => body};
  };
  const store = {credential: async accountKey => ({accountKey, provider: 'claude', kind: 'oauth', generation: 'g1', bearer: 'synthetic-' + accountKey, expiresAt: T + 8 * 3600e3})};
  const reader = createUsageHostReader({store, fetchImpl});
  const {app} = await f.start('owner', {backend, lendingHostReader: reader, lendingUsageStore: store,
    adapters: () => [{spec: legacyProxyHarness('claude-code-subscription'), installed: true, signedIn: true, models: ['claude-sonnet-5-5'], capabilities: []}],
    identityProbe: async () => ({providers: [{harness_id: 'claude-code-subscription', installed: true, signedIn: true}]})});
  await api(app, '/api/agents/claude-code-subscription', {method: 'POST', body: {useForLending: true}});
  const registry = app.lendingAccounts().registry(), added = registry.add({provider: 'claude', label: 'B work'});
  registry.setEnabled(added.id, true);
  const keys = ['claude', 'claude:' + added.id];
  // Status reads, one account at a time and then both, through the app's own route; readiness reads after each.
  for (const accounts of [[keys[0]], [keys[1]], keys]) {
    await api(app, '/api/agents/refresh', {method: 'POST', body: {accounts}});
    await api(app, '/api/lending/readiness');
  }
  assert.deepEqual(new Set(requests.map(r => r.auth)), new Set(keys.map(k => 'Bearer synthetic-' + k)), 'both accounts were read, each with its own bearer');
  assert.ok(requests.filter(r => r.path === '/api/oauth/usage').length >= 2, 'the app routed its readings to the host reader');
  assert.deepEqual(reached, [], 'no sandbox-making call reached the backend the app uses');
  assert.equal(backend.calls.some(([kind]) => kind === 'prepare'), false);
});

test('the reading runner refuses sandbox transport however it is asked', async () => {
  const run = createLendingReadingRunner({reader: {read: async () => ({stdout: '{}'})}});
  for (const bad of [{transport: 'sandbox'}, {sandbox: true}, {backend: {prepare() {}}}])
    await assert.rejects(run({provider: 'claude', ...bad}), {probe_failure: 'probe_unavailable'});
  assert.throws(() => createLendingReadingRunner({backend: {prepare() {}}}), TypeError, 'a runner needs a host reader, not a backend');
});

test('the reading sandboxes are deleted from the source, and only the stop check keeps a dedicated sandbox', () => {
  const read = file => fs.readFileSync(new URL('../lib/v1/' + file, import.meta.url), 'utf8');
  assert.equal(fs.existsSync(new URL('../lib/v1/lending-probe-runner.mjs', import.meta.url)), false, 'the sandbox probe runner is gone');
  for (const file of ['app.mjs', 'lending-probe.mjs', 'lending-reading-runner.mjs', 'deadline-recovery-gate.mjs']) {
    const text = read(file);
    for (const dead of ['closeWarm', 'warmRead', 'openReadingSession', 'closeReadingSandboxes', 'runProbeNow', 'lending-probe-runner', 'createLendingProbeRunner'])
      assert.equal(text.includes(dead), false, `${file} no longer mentions ${dead}`);
  }
  const check = read('stop-check.mjs');
  assert.match(check, /STOP_CHECK_MARKER\s*=\s*'faravan_stop_check'/, 'the stop check keeps its own marker');
  assert.match(check, /requestStop/, 'and still stops and removes its own sandbox');
});
