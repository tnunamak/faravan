import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {appFixture, api, waitFor} from './helpers/v1-app-fixture.mjs';
import {HARNESS_ADAPTERS} from '../lib/harnesses/index.mjs';

// Signing in again must not turn lending off by itself. The lending choice and the enrolled account both survive a new
// sign-in: the same account then lends again once its identity is read, and another account meets the held-account state.

const ID = 'claude-code-subscription';
const ACCOUNT = '1111222233334444';
const OTHER = '9999888877776666';

async function lender(t, probe) {
  const claude = HARNESS_ADAPTERS.find(adapter => adapter.spec.harness_id === ID);
  const f = await appFixture(t);
  const {lender: l} = await f.connect({adapters: [{...claude, installed: true, signedIn: false, models: ['m']}],
    lendingSignInProbe: async () => ({signedIn: null, secretPresent: true}),
    lendingIdentityProbe: async () => ({providers: [{harness_id: ID, installed: true, signedIn: probe.signedIn}]}),
    signin: {startProvider: async () => ({status: 'complete', cleanup: async () => {}})}});
  await waitFor(async () => typeof (await api(l.app, '/api/agents'))[0]?.proxySignedIn === 'boolean', 'proxy sign-in readiness');
  await api(l.app, '/api/agents/' + ID, {method: 'POST', body: {useForLending: true}});
  return l;
}
const pinFile = l => join(l.home, 'v1', 'lending-identity-pins.json');
const enroll = async (l, hash) => {
  await mkdir(join(l.home, 'v1'), {recursive: true});
  await writeFile(pinFile(l), JSON.stringify({version: 1, pins: {claude: {account_sha256_16: hash, pinned_at: 1}}}));
};
const pins = async l => JSON.parse(await readFile(pinFile(l), 'utf8')).pins;
const signInAgain = async l => {
  const before = (await api(l.app, '/api/agents'))[0]?.checkedAt;
  const started = await api(l.app, '/api/signin/' + ID, {method: 'POST', body: {}});
  await waitFor(async () => (await api(l.app, '/api/signin/' + started.flowId)).status === 'complete', 'sign-in completion');
  // Completion refreshes in the background and ends by checking the agent again: wait for that fresh check.
  await waitFor(async () => (await api(l.app, '/api/agents'))[0]?.checkedAt !== before, 'the agent is checked again after sign-in');
};
const row = async l => (await api(l.app, '/api/agents'))[0];

test('signing in again keeps the lending choice and the enrolled account', {timeout: 120000}, async t => {
  const l = await lender(t, {signedIn: true});
  await enroll(l, ACCOUNT);
  assert.equal((await row(l)).useForLending, true);
  await signInAgain(l);
  assert.equal((await row(l)).useForLending, true, 'the choice stays on');
  assert.equal((await pins(l)).claude?.account_sha256_16, ACCOUNT, 'the enrolled account is still the one compared');
});

test('a sign-in that expired and then a new sign-in resume with the choice and the enrolled account', {timeout: 120000}, async t => {
  const probe = {signedIn: true};
  const l = await lender(t, probe);
  await enroll(l, ACCOUNT);
  probe.signedIn = false;
  await api(l.app, '/api/agents/refresh', {method: 'POST', body: {agents: [ID]}});
  probe.signedIn = true;
  await signInAgain(l);
  assert.equal((await row(l)).useForLending, true);
  assert.equal((await pins(l)).claude?.account_sha256_16, ACCOUNT);
});

test('another account is never enrolled silently by a sign-in; choosing the agent again enrolls the account now in use', {timeout: 120000}, async t => {
  const l = await lender(t, {signedIn: true});
  await enroll(l, ACCOUNT);
  await signInAgain(l);
  assert.equal((await pins(l)).claude?.account_sha256_16, ACCOUNT, 'the old account stays enrolled, so another account is held');
  await api(l.app, '/api/agents/' + ID, {method: 'POST', body: {useForLending: false}});
  await api(l.app, '/api/agents/' + ID, {method: 'POST', body: {useForLending: true}});
  assert.equal((await pins(l)).claude, undefined, 'the choice is the deliberate step that lets the next reading enroll the account now in use');
  assert.notEqual(OTHER, ACCOUNT);
});
