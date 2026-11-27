import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, api, syntheticBackend} from './helpers/v1-app-fixture.mjs';
import {dockerSignedOutFrom, dockerFacts} from '../lib/v1/docker-state.mjs';
import {lendingBlockers as clientBlockers} from '../ui/v1/src/blockers.mjs';
import {lendingBlockers as serverBlockers} from '../lib/v1/blockers.mjs';

const login = row => [{name: 'docker_login', ...row}];
const refreshRow = {ok: false, cause: 'docker_signin_refresh_unavailable', label: 'The sandbox could not refresh your Docker sign-in. This may be temporary.'};
const unverified = {ok: true, signinVerified: false};
const accepted = {ok: true, signinVerified: false, createAccepted: true};

test('a temporary refresh failure is unknown in both shared classifiers, with its own instruction kept', () => {
  assert.equal(dockerSignedOutFrom(login(refreshRow)), null);
  const facts = dockerFacts(login(refreshRow));
  assert.equal(facts.signedIn, null);
  assert.match(facts.signinDetail, /could not refresh/);
});

test('a working listing without proof is not a sign-out answer either', () => {
  assert.equal(dockerSignedOutFrom(login(unverified)), null);
  assert.equal(dockerSignedOutFrom(login(accepted)), false);
  assert.equal(dockerSignedOutFrom(login({ok: true})), false);
});

for (const [name, lendingBlockers] of [['client', clientBlockers], ['server', serverBlockers]]) {
  const row = model => model.items.find(item => item.key === 'docker_signin');
  const base = {installed: true, running: true, intent: {on: true}, agents: []};
  test(`${name} blockers: a settled unknown sign-in says so and offers a recheck instead of Checking forever`, () => {
    const facts = dockerFacts([{name: 'sbx_install', ok: true}, {name: 'sbx_daemon', ok: true}, ...login({ok: false, unknown: true})]);
    const item = row(lendingBlockers({docker: {...base, ...facts}}));
    assert.equal(item.status, 'unknown');
    assert.doesNotMatch(item.detail, /^Checking/);
    assert.equal(item.action, 'Check again');
  });
  test(`${name} blockers: a temporary refresh failure shows its instruction with a recheck, not a sign-in demand`, () => {
    const item = row(lendingBlockers({docker: {...base, ...dockerFacts(login(refreshRow))}}));
    assert.equal(item.status, 'unknown');
    assert.match(item.detail, /could not refresh/);
    assert.equal(item.action, 'Check again');
  });
  test(`${name} blockers: an accepted create says only what Docker accepted`, () => {
    const item = row(lendingBlockers({docker: {...base, ...dockerFacts(login(accepted))}}));
    assert.equal(item.status, 'ok');
    assert.equal(item.detail, "Docker accepted Faravan's request to start a test workspace.");
  });
  test(`${name} blockers: a verified sign-in still says Signed in`, () => {
    const item = row(lendingBlockers({docker: {...base, ...dockerFacts(login({ok: true}))}}));
    assert.equal(item.detail, 'Signed in.');
  });
}

test('an inconclusive check replaces an earlier sign-out in status and agents', {timeout: 60000}, async t => {
  const f = await appFixture(t);
  const backend = syntheticBackend(f.root, {});
  let row = {name: 'docker_login', ok: false, detail: "The sandbox service isn't signed in to Docker yet."};
  backend.probeCapabilities = async () => ({available: true, preflight: {ok: false, checks: [row, {name: 'network_policy', ok: true, detail: 'policy'}]}});
  const {lender} = await f.connect({backend, identityProbe: async () => ({providers: []})});
  const app = lender.app;
  await api(app, '/api/ops/readiness.get', {method: 'POST', body: {refresh: true}});
  assert.equal((await api(app, '/api/status')).docker?.code, 'docker_signed_out', 'the sign-out is seen first');

  row = {name: 'docker_login', ok: false, cause: 'docker_signin_state_unavailable', detail: 'The saved sign-in state could not be read.'};
  await api(app, '/api/ops/readiness.get', {method: 'POST', body: {refresh: true}});
  assert.equal((await api(app, '/api/status')).docker, null, 'an unknown answer is not shown as a sign-out');
  for (const agent of await api(app, '/api/agents')) assert.notEqual(agent.code, 'docker_signed_out');

  row = {name: 'docker_login', ok: false, detail: 'signed out again'};
  await api(app, '/api/ops/readiness.get', {method: 'POST', body: {refresh: true}});
  assert.equal((await api(app, '/api/status')).docker?.code, 'docker_signed_out');
  row = {name: 'sbx_daemon', ok: true};
  await api(app, '/api/ops/readiness.get', {method: 'POST', body: {refresh: true}});
  assert.equal((await api(app, '/api/status')).docker, null, 'a report that does not mention Docker sign-in keeps no old sign-out');
});
