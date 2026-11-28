import './helpers/no-browser.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, api, waitFor, syntheticBackend} from './helpers/v1-app-fixture.mjs';

// Quit waits for an in-flight usage check only as long as the shutdown bound. A check that never settles must not hold
// Quit, and a rejection that arrives after Quit moved on must be observed, not left unhandled.
const adapters = () => [{spec: legacyProxyHarness('claude-code-subscription'), installed: true, signedIn: true,
  harnessVersion: 'synthetic-only', models: [], capabilities: []}];

test('Quit continues after the shutdown bound when a usage check never settles, and a late rejection is observed', {timeout: 120000}, async t => {
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const f = await appFixture(t);
  const backend = syntheticBackend(f.root), probeCapabilities = backend.probeCapabilities.bind(backend);
  backend.probeCapabilities = async options => ({...await probeCapabilities(options), backend_id: 'synthetic-only', version: 'synthetic-version'});
  let started = 0, rejectProbe;
  const runner = () => { started++; return new Promise((_, reject) => { rejectProbe = reject; }); };
  const {owner, lender, circle} = await f.connect({backend, adapters, lendingProbeRunner: runner, shutdownProofMs: 400,
    lendingExpectedIdentity: () => ({email_sha256_16: 'aaaabbbbccccdddd'})});
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false,
    lendingPolicy: {accountPlans: {claude: 'max20'}, providerConsent: {claude: true}}}});
  await api(lender.app, '/api/agents/claude-code-subscription', {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/agents/claude-code-subscription/run', {method: 'POST', body: {model: 'claude-haiku-5-5', effort: null}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'auto'}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  const refresh=api(lender.app,'/api/agents/refresh',{method:'POST',body:{agents:['claude-code-subscription']}});
  refresh.catch(()=>{});
  await waitFor(() => started > 0, 'the usage check to start and hang', 60000);
  const began = Date.now();
  const closed=await lender.app.close();
  const elapsed = Date.now() - began;
  // Producers have 40/60 of the 400 ms total budget. The unresolved check stays owned and the result is interrupted.
  assert.equal(closed.state,'interrupted');assert.equal(closed.cessation,'unknown');
  assert.ok(closed.unfinished.includes('lending probe'));
  assert.ok(elapsed >= 400*2/3-50, `Quit waited for the usage check (took ${elapsed} ms)`);
  assert.ok(elapsed < 3000, `Quit stopped waiting at the bound (took ${elapsed} ms)`);
  rejectProbe(new Error('late failure'));
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(unhandled, [], 'the late rejection was observed');
});
