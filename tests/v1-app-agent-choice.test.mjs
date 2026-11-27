import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appFixture, api, bounded, syntheticBackend, waitFor } from './helpers/v1-app-fixture.mjs';
import { HARNESS_ADAPTERS } from '../lib/harnesses/index.mjs';

// The test Mac 11-01: Claude and Codex were signed in, but the Agents switches did nothing for minutes, then worked
// with no message. The choice queued behind an agent check that held the one mutation lane. Choosing still proves the
// sign-in again, because the cached proof is per agent, not per account.
const testOptions = {timeout: 60000};
const native = HARNESS_ADAPTERS.find(a => a.spec.harness_id === 'codex');

async function start(t, probe, {agents = [native], faravanSignIn = async () => true} = {}) {
  const f = await appFixture(t);
  const {app} = await f.start('owner', {adapters: agents.map(a => ({...a, installed: true, signedIn: true, models: ['example-model']})),
    lendingSignInProbe: async () => ({signedIn: true}), // Codex's Faravan sign-in is modelled by the same identity evidence these tests drive; Claude's is the explicit store read.
    faravanSignInProbe: async id => id === 'codex' ? (await probe({harnessNames: [id]})).providers?.find(row => row.harness_id === id)?.signedIn ?? null : faravanSignIn(id), lendingIdentityProbe: probe,
    identityProbe: async () => ({providers: agents.map(a => ({harness_id: a.spec.harness_id, installed: true, signedIn: true}))})});
  await waitFor(async () => (await api(app, '/api/agents')).every(a => a.proxySignedIn === true), 'first proxy check');
  return app;
}
const signedInProbe = state => async () => { state.checks++; return {providers: [{harness_id: 'codex', installed: true, signedIn: state.signedIn}]}; };
const viewOf = async (app, id) => (await api(app, '/api/agents')).find(a => a.id === id);

test('choosing an agent answers while an agent check holds the mutation lane', testOptions, async t => {
  const claude = HARNESS_ADAPTERS.find(a => a.spec.harness_id === 'claude-code-subscription');
  let hold = false, release, codexChecks = 0;
  const held = new Promise(resolve => { release = resolve; });
  // "Check again" on Claude boots a sandbox and holds the shared lane until it ends; choosing Codex is not behind it.
  const app = await start(t, async ({harnessNames: [id]}) => {
    if (id === 'codex') codexChecks++;
    return {providers: [{harness_id: id, installed: true, signedIn: true}]};
  }, {agents: [claude, native],
    // Claude's lending check reads Faravan's sign-in store; that read is the slow one here.
    faravanSignIn: async () => { if (hold) await held; return true; }});
  hold = true;
  const refresh = api(app, '/api/agents/refresh', {method: 'POST', body: {agents: ['claude-code-subscription']}});
  await waitFor(async () => (await viewOf(app, 'claude-code-subscription'))?.checking === true, 'the Claude check holds the mutation lane');
  const before = codexChecks;
  // A failed assertion still lets the held check end, so the test reports instead of hanging.
  try {
    const chosen = await bounded(api(app, '/api/agents/codex-lending', {method: 'POST', body: {useForLending: true}}),
      'choosing Codex while an agent check runs', 3000);
    assert.equal(chosen.find(a => a.id === 'codex').useForLending, true);
    assert.equal(codexChecks, before + 1, 'choosing proves the Codex sign-in again in its own check');
  } finally { release(); await refresh; }
  const off = await bounded(api(app, '/api/agents/codex-lending', {method: 'POST', body: {useForLending: false}}), 'turning Codex off', 3000);
  assert.equal(off.find(a => a.id === 'codex').useForLending, false);
});

test('a sign-out outside Faravan after a recent positive check is caught when the agent is chosen', testOptions, async t => {
  const state = {checks: 0, signedIn: true};
  const app = await start(t, signedInProbe(state));
  // A positive proof a moment old sits in the cache; then the account is signed out outside Faravan.
  assert.equal((await api(app, '/api/agents'))[0].proxySignedIn, true);
  state.signedIn = false;
  const before = state.checks;
  assert.equal((await api(app, '/api/agents/codex-lending', {method: 'POST', body: {useForLending: true}, status: 400})).code, 'agent_not_ready');
  assert.equal(state.checks, before + 1, 'the recent positive proof does not skip the check');
  const codex = await viewOf(app, 'codex');
  assert.deepEqual([codex.useForLending, codex.proxySignedIn], [false, false], 'the agent is not lendable and reads as signed out');
});

test('choosing an agent with no recent sign-in proof still checks it first', testOptions, async t => {
  let signedIn = false, checks = 0;
  const app = await start(t, async () => { checks++; return {providers: [{harness_id: 'codex', installed: true, signedIn: checks === 1 || signedIn}]}; });
  // The first check proved a sign-in; a later check saw it gone. The cache now holds a signed-out proof.
  await api(app, '/api/agents/refresh', {method: 'POST', body: {agents: ['codex']}});
  assert.equal((await api(app, '/api/agents'))[0].proxySignedIn, false);
  const before = checks;
  assert.equal((await api(app, '/api/agents/codex-lending', {method: 'POST', body: {useForLending: true}, status: 400})).code, 'agent_not_ready');
  assert.equal(checks, before + 1, 'old or negative proof starts one sandbox check');
  signedIn = true;
  assert.equal((await api(app, '/api/agents/codex-lending', {method: 'POST', body: {useForLending: true}}))[0].useForLending, true);
});
