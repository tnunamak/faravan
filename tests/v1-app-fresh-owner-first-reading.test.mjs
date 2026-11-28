import './helpers/no-browser.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, api, waitFor, syntheticBackend} from './helpers/v1-app-fixture.mjs';

// A real harness adapter lists no models; only the owner's chosen run model says what this computer lends.
const unlistedModelAdapters = () => [{spec:legacyProxyHarness('claude-code-subscription'), installed: true, signedIn: true,
  harnessVersion: 'synthetic-only', models: [], capabilities: []}];

async function freshAutomaticOwner(t, {jobModel, injectIdentity = true}) {
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
  const {owner, lender, circle} = await f.connect({backend, adapters: unlistedModelAdapters, lendingProbeRunner: runner,
    ...(injectIdentity ? {lendingExpectedIdentity: () => ({email_sha256_16: 'aaaabbbbccccdddd'})} : {})});
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false,
    lendingPolicy: {accountPlans: {claude: 'max20'}, providerConsent: {claude: true}}}});
  await api(lender.app, '/api/agents/claude-code-subscription', {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/agents/claude-code-subscription/run', {method: 'POST', body: {model: 'claude-haiku-5-5', effort: null}});
  // Automatic is chosen before lending starts, so no job-less preflight takes a reading: only a waiting job can.
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'auto'}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  assert.deepEqual(probes, [], 'no job is waiting, so no reading is taken yet');
  await api(owner.app, '/api/jobs', {headers:{'faravan-confirm':'yes'},method: 'POST', body: {circle: circle.id,
    git: {url: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40)},
    prompt: 'Synthetic Claude admission: no external execution.', harness: 'claude-code-subscription',
    ...(jobModel ? {model: jobModel} : {})}});
  return {lender, probes, backend, root: f.root};
}

test('a fresh owner takes its first native usage reading on explicit refresh', {timeout: 180000}, async t => {
  const {lender, probes, backend} = await freshAutomaticOwner(t, {jobModel: 'claude-haiku-5-5'});
  const agent = (await api(lender.app, '/api/agents')).find(row => row.id === 'claude-code-subscription');
  assert.deepEqual(agent.models, ['claude-haiku-5-5'], 'the chosen run model is the model this computer offers');
  await api(lender.app,'/api/agents/refresh',{method:'POST',body:{agents:['claude-code-subscription']}});
  assert.equal(probes.length,1);
  const decision = await waitFor(async () => {
    return (await api(lender.app,'/api/lending/readiness')).agents.find(row=>row.id==='claude-code-subscription'&&row.hasReading);
  }, 'a specific decision from the reading', 60000);
  assert.equal(decision.hasReading,true);
  assert.equal(backend.calls.some(([kind]) => kind === 'run'), false, 'the test never runs an agent');
});

test('a job that names a model the owner does not run still never reaches the quota gate', {timeout: 180000}, async t => {
  const {probes} = await freshAutomaticOwner(t, {jobModel: 'claude-sonnet-5-5'});
  await new Promise(resolve => setTimeout(resolve, 5000));
  assert.deepEqual(probes, [], 'the owner lends only the model they chose');
});

test('a fresh owner whose Claude status names no e-mail pins the account its first reading verifies', {timeout: 180000}, async t => {
  // The real sandbox status has no e-mail, so nothing but the reading itself can say which account is enrolled.
  const {lender, probes} = await freshAutomaticOwner(t, {jobModel: 'claude-haiku-5-5', injectIdentity: false});
  await api(lender.app,'/api/agents/refresh',{method:'POST',body:{agents:['claude-code-subscription']}});
  assert.equal(probes.length,1);
  const decision = await waitFor(async () => {
    return (await api(lender.app,'/api/lending/readiness')).agents.find(row=>row.id==='claude-code-subscription'&&row.hasReading);
  }, 'a specific decision from the reading', 60000);
  assert.equal(decision.checks.find(check=>check.id==='account').state,'pass','the first explicit reading pins the verified identity');
});
