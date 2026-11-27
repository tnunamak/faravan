import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {appFixture, api, boundedFetch, syntheticBackend, waitFor} from './helpers/v1-app-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {createRealPace50Source} from '../lib/v1/lending-pace50-source.mjs';

// Control journeys through the real app pair: Stop, explicit On, Pause, owner presence and an unknown identity.
// Every decision is read from the app's own routes and the fake sandbox's own calls. Nothing edits durable state,
// and nothing calls adapter effects directly.
const gitInput = (circle, prompt = 'Synthetic task: write a greeting. No external execution.') => ({circle: circle.id,
  git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40), prompt, harness: 'codex'});
const evidence = () => ({postingLagBoundMs:0,source: createSyntheticPace50Source({start: Date.now()}),
  account_week_id: 'synthetic-week-1'});
async function lendAutomatically(lender, circle) {
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false,
    lendingPolicy: {providerConsent: {codex: true}}}});
  await api(lender.app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'auto'}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
}
const durable = (home) => JSON.parse(fs.readFileSync(join(home, 'v1', 'lending-pace50-state.json'), 'utf8'));
const durableAttempts = (home) => fs.existsSync(join(home, 'v1', 'lending-pace50-state.json')) ? durable(home).attempts : [];
const settingsSnapshot = (home) => {
  const s = JSON.parse(fs.readFileSync(join(home, 'v1', 'app-settings.json'), 'utf8'));
  return {standingRules: s.standingRules, modes: s.modes, limits: s.limits};
};
const count = (backend, kind) => backend.calls.filter(([name]) => name === kind).length;
// Holds the admission step, which runs after the reservation and before any sandbox exists, until the test releases it.
function heldAdmission(backend) {
  let enteredAdmission, releaseAdmission;
  const entered = new Promise((resolve) => { enteredAdmission = resolve; });
  const released = new Promise((resolve) => { releaseAdmission = resolve; });
  const admitJob = backend.admitJob.bind(backend);
  backend.admitJob = async (spec) => { enteredAdmission(); await released; return admitJob(spec); };
  return {entered, release: () => releaseAdmission()};
}

test('an explicit On after Stop does not resume the stopped attempt, and consent and limits survive the restart unchanged', {timeout: 240000}, async (t) => {
  const f = await appFixture(t, {hold: true});
  const providerEvidence=evidence();
  const {owner, lender, circle} = await f.connect({shutdownProofMs: 2000, lendingPace50:providerEvidence});
  await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle)});
  await lendAutomatically(lender, circle);
  await waitFor(() => count(lender.backend, 'run') === 1, 'the first chunk is running', 20000);
  const before = settingsSnapshot(lender.home);
  await api(lender.app, '/api/lending/stop', {method: 'POST', body: {confirmed: true, attemptId: durableAttempts(lender.home)[0].id}});
  await waitFor(() => durableAttempts(lender.home)[0].process_state === 'ceased', 'the stopped chunk was proven gone', 20000);
  assert.equal(durable(lender.home).mode, 'off', 'Stop is durable');
  await lender.app.close();
  // The restarted sandbox is not held, so a later chunk can finish on its own.
  const next = syntheticBackend(f.root, {});
  const restarted = await f.start('lender', {backend: next, shutdownProofMs: 2000, lendingPace50:providerEvidence});
  assert.equal(count(next, 'run'), 0, 'the restart did not relaunch the stopped chunk');
  assert.deepEqual(settingsSnapshot(restarted.home), before, 'consent, people, agents, expiry and limits survive Stop and restart');
  await api(restarted.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle, 'Synthetic task: a second greeting after On.')});
  await waitFor(() => count(next, 'run') === 1, 'the next job ran after an explicit On', 30000);
  assert.deepEqual(settingsSnapshot(restarted.home), before, 'On did not change the consent or the limits');
  await waitFor(() => durableAttempts(restarted.home).filter((x) => x.process_state === 'ceased').length === 2, 'both attempts are proven gone', 30000);
});

// The fence is not cleared by a later On or by a delayed owner report: the admission that Stop caught never prepares.