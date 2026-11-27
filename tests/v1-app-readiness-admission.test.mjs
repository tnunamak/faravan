import './helpers/no-browser.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appFixture, api, waitFor, syntheticBackend } from './helpers/offers-jobs-fixture.mjs';
import { lendingView } from '../ui/v1/src/helpers.mjs';

// O-A (r11), through the real app. One account runs a held job while the other is signed in and idle (a real spare),
// signed out, or not lent. The page copy comes from lendingView, the same boundary the pages read.
const CLAUDE = 'claude-code-subscription', CODEX = 'codex';
const agent = (harness, signedIn) => ({spec:legacyProxyHarness(harness), installed: true, signedIn,
  harnessVersion: 'synthetic-only', models: ['example-model'], capabilities: []});
const jobInput = (circle, harness) => ({circle: circle.id, git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40),
  prompt: 'Readiness job', harness});

// Open pages hear a readiness event when the answer changes (the same stream the pages read).
async function readinessNews(t, app) {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(app.origin + '/api/events?after=0',
    {headers: {'x-faravan-session-token': app.token, accept: 'text/event-stream'}, signal: controller.signal});
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = '';
  (async () => { try { for (;;) { const {done, value} = await reader.read(); if (done) break; text += decoder.decode(value, {stream: true}); } } catch {} })();
  return () => [...text.matchAll(/"type":"readiness"/g)].length;
}

// Lend this computer's agents in ask mode. Codex is lent only when `codexLent`. A sandbox that is down is a backend that says so.
// `holdSpare` holds the offer long-poll open once the job runs, as production does (GET /offers?wait=30). While the Claude job
// runs, only the idle Codex spare polls offers, so only a refresh can change its answer.
async function lending(t, {claudeSignedIn = true, codexSignedIn = true, codexLent = true, sandboxDown = false, holdSpare = false, adapters} = {}) {
  const f = await appFixture(t, {hold: true});
  const held = {count: 0, active: false};
  if (holdSpare) {
    const previous = f.override;
    f.override = async record => {
      if (record.route === '/offers' && held.active) {
        held.count++;
        return new Promise(() => {});
      }
      return previous(record);
    };
  }
  const backend = syntheticBackend(f.root, {hold: true});
  if (sandboxDown) {
    const up = backend.lenderCapabilities;
    backend.lenderCapabilities = () => ({...up(), available: false});
  }
  const {owner, lender, circle} = await f.connect({backend,
    adapters: adapters ?? [agent(CLAUDE, claudeSignedIn), agent(CODEX, codexSignedIn)]});
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200,
    idleOnly: false, lendingPolicy: {providerConsent: {claude: true, codex: true}}}});
  await api(lender.app, '/api/agents/' + CLAUDE, {method: 'POST', body: {useForLending: true}});
  if (codexLent) await api(lender.app, '/api/agents/' + CODEX, {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'ask'}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  return {f, owner, lender, circle, held};
}

// A job the named agent runs on this computer; the other lent agent is the spare.
async function lendingWithJobRunning(t, {runs = CLAUDE, ...signin} = {}) {
  const {owner, lender, circle, held} = await lending(t, signin);
  await api(owner.app, '/api/jobs', {method: 'POST', body: jobInput(circle, runs)});
  const card = await waitFor(async () => (await api(lender.app, '/api/approvals'))[0], 'review card');
  const news = await readinessNews(t, lender.app), before = news();
  await api(lender.app, '/api/approvals/' + card.id + '/accept', {method: 'POST', body: {}});
  await waitFor(() => lender.backend.calls.some(([kind]) => kind === 'run'), 'the job runs');
  held.active = true;
  return {lender, news, before, held};
}

test('O-A: a running job and a signed-out second account do not make the lender ready for another job', {timeout: 120000}, async t => {
  const {lender, news, before} = await lendingWithJobRunning(t, {codexSignedIn: false});
  // Until the second account has been checked the answer is unknown, which is never ready either.
  await waitFor(() => lender.app.lendingAdmission() !== 'lender_starting', 'the second account is checked', 15000);
  assert.equal(lender.app.lendingAdmission(), 'busy', 'raw admission: the only usable account is running');
  const status = await api(lender.app, '/api/status');
  assert.notEqual(status.lendingProjection.admission, 'allowed', 'the projection must not say another job can start');
  assert.equal(status.lendingProjection.admissionReason, 'busy', 'the producer names the running account, not the spare');
  assert.equal(lendingView(status).message, 'No other job starts until this one finishes.', 'the page says the next job waits for this one');
  await waitFor(() => news() > before, 'open pages hear that the answer changed when the job started', 5000);
});

test('O-A: a running Codex job with a signed-out Claude listed first: the producer does not blame the workspace', {timeout: 120000}, async t => {
  const {lender} = await lendingWithJobRunning(t, {runs: CODEX, claudeSignedIn: false});
  await waitFor(() => lender.app.lendingAdmission() !== 'lender_starting', 'the Claude account is checked', 15000);
  assert.equal(lender.app.lendingAdmission(), 'busy', 'the running Codex account outranks the signed-out Claude account');
  const status = await api(lender.app, '/api/status');
  assert.equal(status.lendingProjection.admissionReason, 'busy', 'the producer says busy, not sandbox_not_ready');
  assert.equal(lendingView(status).message, 'No other job starts until this one finishes.');
});

test('O-A control: a running job and a signed-in idle second account still say ready for another job', {timeout: 120000}, async t => {
  const {lender} = await lendingWithJobRunning(t, {codexSignedIn: true});
  await waitFor(() => lender.app.lendingAdmission() === null, 'the spare account admits', 15000);
  const status = await api(lender.app, '/api/status');
  assert.equal(status.lendingProjection.admission, 'allowed', 'the spare account is real capacity');
});

test('O-A: turning the spare account off is seen at once, and back on it admits again', {timeout: 120000}, async t => {
  const {lender} = await lendingWithJobRunning(t, {codexSignedIn: true});
  await waitFor(() => lender.app.lendingAdmission() === null, 'the spare account admits', 15000);
  await api(lender.app, '/api/agents/' + CODEX, {method: 'POST', body: {useForLending: false}});
  await waitFor(() => lender.app.lendingAdmission() === 'busy', 'the disabled spare no longer admits', 3000);
  await api(lender.app, '/api/agents/' + CODEX, {method: 'POST', body: {useForLending: true}});
  await waitFor(() => lender.app.lendingAdmission() === null, 'the re-enabled spare admits again', 15000);
});

test('O-A: with the spare claim held open, turning the spare off is still seen at once', {timeout: 120000}, async t => {
  const {lender, held} = await lendingWithJobRunning(t, {codexSignedIn: true, holdSpare: true});
  await waitFor(() => held.count >= 1, 'the spare is in a long claim wait', 15000);
  await waitFor(() => lender.app.lendingAdmission() === null, 'the held spare admits', 15000);
  await api(lender.app, '/api/agents/' + CODEX, {method: 'POST', body: {useForLending: false}});
  await waitFor(() => lender.app.lendingAdmission() === 'busy', 'the turned-off spare no longer admits while its claim waits', 3000);
});

test('O-A: with the spare claim held open, a spare that signs out is seen by the next check', {timeout: 120000}, async t => {
  const adapters = [agent(CLAUDE, true), agent(CODEX, true)];
  const {lender, held} = await lendingWithJobRunning(t, {holdSpare: true, adapters});
  await waitFor(() => held.count >= 1, 'the spare is in a long claim wait', 15000);
  await waitFor(() => lender.app.lendingAdmission() === null, 'the held spare admits', 15000);
  // Two observed sign-outs in a row make a sign-out (the app's rule for sandbox evidence).
  adapters[1].signedIn = false;
  await api(lender.app, '/api/agents/refresh', {method: 'POST', body: {agents: [CODEX]}});
  await api(lender.app, '/api/agents/refresh', {method: 'POST', body: {agents: [CODEX]}});
  await waitFor(() => lender.app.lendingAdmission() === 'busy', 'the signed-out spare no longer admits while its claim waits', 3000);
});

test('O-A: a sandbox that is genuinely down keeps the workspace setup message', {timeout: 120000}, async t => {
  const {lender} = await lending(t, {sandboxDown: true});
  await waitFor(() => lender.app.lendingAdmission() === 'sandbox_not_ready', 'the sandbox is checked', 15000);
  assert.match(lendingView(await api(lender.app, '/api/status')).message, /protected workspace/);
});
