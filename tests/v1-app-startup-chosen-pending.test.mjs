import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdir, writeFile} from 'node:fs/promises';
import {appFixture, api, waitFor} from './helpers/v1-app-fixture.mjs';
import {HARNESS_ADAPTERS} from '../lib/harnesses/index.mjs';

// After a restart or an update the stored choice is on disk, but the first sign-in check has not answered yet.
// The person already chose the agent: the screens must keep saying so while the check runs, and must not ask for a choice.

const ID = 'claude-code-subscription';

// A sign-in probe the test opens by hand, so the first check stays "in flight" for as long as the test needs.
function gate() {
  let open, opened = false;
  const wait = new Promise(resolve => { open = () => { opened = true; resolve(); }; });
  const until = signal => Promise.race([wait, new Promise(resolve => signal?.addEventListener('abort', resolve, {once: true}))]);
  return {wait, open, until, get opened() { return opened; }};
}

async function startWithStoredChoice(t, {chosen = true, probe}) {
  const f = await appFixture(t), home = await f.home('lender');
  await mkdir(join(home, 'v1'), {recursive: true});
  await writeFile(join(home, 'v1', 'app-settings.json'), JSON.stringify({version: 1, name: 'Saved settings', enabled: false, intent: 'off',
    agents: chosen ? {[ID]: true} : {}, lendingAuth: chosen ? {[ID]: true} : {}, modes: {}}));
  const claude = HARNESS_ADAPTERS.find(adapter => adapter.spec.harness_id === ID);
  const gated = gate();
  const {app} = await f.start('lender', {adapters: [{...claude, installed: true, signedIn: false, models: ['m']}],
    lendingSignInProbe: async (id, {signal} = {}) => { await gated.until(signal); return {signedIn: null, secretPresent: true}; },
    lendingIdentityProbe: async ({signal} = {}) => { await gated.until(signal); return {providers: [{harness_id: ID, installed: true, signedIn: probe}]}; }});
  t.after(() => gated.open());
  return {app, gated};
}
const agentRows = status => status.lending_blockers.items.filter(item => item.key === 'agent');
const claudeRow = async app => (await api(app, '/api/agents')).find(row => row.id === ID);

test('a stored choice stays chosen while the first sign-in check runs', {timeout: 60000}, async t => {
  const {app, gated} = await startWithStoredChoice(t, {probe: true});
  const row = await claudeRow(app);
  assert.equal(gated.opened, false, 'the first check has not answered');
  assert.equal(row.useForLending, true);
  assert.equal(row.signInState, 'Checking');
  const status = await api(app, '/api/status');
  assert.equal(status.lending_blockers.items.some(item => item.detail_code === 'none_chosen'), false, 'no "no agent is chosen" row');
  assert.equal(status.lending_blockers.needsYou.some(item => item.key === 'agent'), false, 'nothing for the person to do');
  const chosenRow = agentRows(status).find(item => item.agent === ID);
  assert.equal(chosenRow.status, 'unknown', 'a waiting row that clears by itself');
  assert.equal(chosenRow.detail, 'Checking…');
  gated.open();
});

test('a stored choice stays chosen when the check confirms the sign-in', {timeout: 60000}, async t => {
  const {app, gated} = await startWithStoredChoice(t, {probe: true});
  gated.open();
  await waitFor(async () => (await claudeRow(app)).proxySignedIn === true, 'the sign-in is confirmed');
  const row = await claudeRow(app);
  assert.equal(row.useForLending, true);
  assert.equal(row.signInState, 'Signed in');
  const status = await api(app, '/api/status');
  assert.equal(agentRows(status).find(item => item.agent === ID).status, 'ok');
  assert.equal(status.lending_blockers.needsYou.some(item => item.key === 'agent'), false);
});

test('a stored choice whose check finds the agent signed out keeps the signed-out message', {timeout: 60000}, async t => {
  const {app, gated} = await startWithStoredChoice(t, {probe: false});
  gated.open();
  await waitFor(async () => (await claudeRow(app)).proxySignedIn === false, 'the sign-out is found');
  const row = await claudeRow(app);
  // Claude's lending sign-in is Faravan's own: a missing one keeps the choice shown and asks for one more sign-in.
  assert.equal(row.useForLending, true, 'the choice stays so the blocker can ask for the sign-in');
  assert.equal(row.signedIn, false);
  assert.equal(row.signInState, 'Sign-in needed');
});

test('without a stored choice the screens still ask for one', {timeout: 60000}, async t => {
  const {app, gated} = await startWithStoredChoice(t, {chosen: false, probe: true});
  const row = await claudeRow(app);
  assert.equal(row.useForLending, false);
  const status = await api(app, '/api/status');
  const first = status.lending_blockers.items.find(item => item.detail_code === 'none_chosen');
  assert.ok(first, 'the no-agent row is shown');
  assert.equal(first.action, 'Choose agents');
  gated.open();
});

test('no job is admitted until the check confirms the sign-in', {timeout: 60000}, async t => {
  const {app, gated} = await startWithStoredChoice(t, {probe: true});
  const lending = await api(app, '/api/lending');
  assert.equal(gated.opened, false);
  assert.equal((await api(app, '/api/status')).lending_blockers.canLend, false, 'nothing can lend before the check answers');
  assert.deepEqual((lending.agents ?? []).filter(a => a.enabled), [], 'no agent is open to jobs before the check answers');
  gated.open();
});

test('a later check that cannot tell does not turn a chosen agent back into "no agent chosen"', {timeout: 60000}, async t => {
  const f = await appFixture(t), home = await f.home('lender');
  await mkdir(join(home, 'v1'), {recursive: true});
  await writeFile(join(home, 'v1', 'app-settings.json'), JSON.stringify({version: 1, name: 'Saved settings', enabled: false, intent: 'off',
    agents: {[ID]: true}, lendingAuth: {[ID]: true}, modes: {}}));
  const claude = HARNESS_ADAPTERS.find(adapter => adapter.spec.harness_id === ID);
  const answer = {providers: [{harness_id: ID, installed: true, signedIn: true}]};
  const {app} = await f.start('lender', {adapters: [{...claude, installed: true, signedIn: false, models: ['m']}],
    lendingSignInProbe: async () => ({signedIn: null, secretPresent: true}), lendingIdentityProbe: async () => answer});
  await waitFor(async () => (await claudeRow(app)).proxySignedIn === true, 'the sign-in is confirmed');
  // The next scheduled check gets no usable answer: the confirmed result is replaced by "unknown".
  answer.providers = [];
  await api(app, '/api/agents/refresh', {method: 'POST', body: {agents: [ID]}});
  await waitFor(async () => (await claudeRow(app)).proxySignedIn === null, 'the check ends without an answer');
  const row = await claudeRow(app);
  assert.equal(row.useForLending, true, 'the stored choice is still shown');
  const status = await api(app, '/api/status');
  assert.equal(status.lending_blockers.items.some(item => item.detail_code === 'none_chosen'), false);
  assert.equal(status.lending_blockers.needsYou.some(item => item.key === 'agent'), true, 'a completed unknown check offers a retry without changing the saved choice');
  assert.match(status.lending_blockers.needsYou.find(item => item.key === 'agent').action, /^Check /);
});
