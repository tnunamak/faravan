import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {appFixture, api, boundedFetch, syntheticBackend, waitFor} from './helpers/v1-app-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {createRealPace50Source} from '../lib/v1/lending-pace50-source.mjs';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {settleOwnResets} from './helpers/pace50-reset-assertions.mjs';

// Control journeys through the real app pair: Stop, explicit On, Pause, owner presence and an unknown identity.
// Every decision is read from the app's own routes and the fake sandbox's own calls. Nothing edits durable state,
// and nothing calls adapter effects directly.
const gitInput = (circle, prompt = 'Synthetic task: write a greeting. No external execution.') => ({circle: circle.id,
  git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40), prompt, harness: 'codex'});
const evidence = () => ({postingLagBoundMs:0,source: createSyntheticPace50Source({start: Date.now()}),
  account_week_id: 'synthetic-week-1'});
async function lendAutomatically(lender, circle, idleOnly = false) {
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly,
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

test('Stop after the reservation and before the sandbox starts keeps the fake backend from preparing or running', {timeout: 180000}, async (t) => {
  const f = await appFixture(t);
  const backend = syntheticBackend(f.root, {});
  const admission = heldAdmission(backend);
  const {owner, lender, circle} = await f.connect({backend, shutdownProofMs: 2000, lendingPace50: evidence()});
  await api(lender.app, '/api/desktop/presence', {method: 'POST', body: {idleSeconds: 3600}});
  await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle)});
  await lendAutomatically(lender, circle);
  await admission.entered;
  assert.equal(durableAttempts(lender.home).length, 1, 'the reservation exists before the sandbox');
  await api(lender.app, '/api/lending/stop', {method: 'POST', body: {confirmed: true, attemptId: durableAttempts(lender.home)[0].id}});
  admission.release();
  await waitFor(() => durableAttempts(lender.home)[0].process_state === 'ceased', 'the stopped reservation was released', 20000);
  assert.equal(count(backend, 'prepare'), 0, 'no sandbox was prepared after Stop');
  assert.equal(count(backend, 'run'), 0, 'the agent never ran after Stop');
});

test('an explicit On after Stop does not resume the stopped attempt, and consent and limits survive the restart unchanged', {timeout: 240000}, async (t) => {
  const f = await appFixture(t, {hold: true});
  const proof=evidence();
  const {owner, lender, circle} = await f.connect({shutdownProofMs: 2000, lendingPace50: proof});
  await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle)});
  await lendAutomatically(lender, circle);
  await waitFor(() => count(lender.backend, 'run') === 1, 'the first chunk is running', 20000);
  const before = settingsSnapshot(lender.home);
  await api(lender.app, '/api/lending/stop', {method: 'POST', body: {confirmed: true, attemptId: durableAttempts(lender.home)[0].id}});
  await waitFor(() => durableAttempts(lender.home)[0].process_state === 'ceased', 'the stopped chunk was proven gone', 20000);
  assert.equal(durable(lender.home).mode, 'off', 'Stop is durable');
  await lender.app.close();
  const stopped=durableAttempts(lender.home)[0];
  assert.equal(stopped.hold_closed,false,'Stop retains unknown usage after cleanup');
  assert.ok(stopped.resources.every(r=>r.held_micro+r.unrepresented_micro===r.initial_micro&&r.released_micro===0));
  // Keep the same provider windows: the new job must fit beside the stopped job's retained liability.
  // The restarted sandbox is not held, so a later chunk can finish on its own.
  const next = syntheticBackend(f.root, {});
  const restarted = await f.start('lender', {backend: next, shutdownProofMs: 2000, lendingPace50: proof});
  assert.equal(count(next, 'run'), 0, 'the restart did not relaunch the stopped chunk');
  assert.deepEqual(settingsSnapshot(restarted.home), before, 'consent, people, agents, expiry and limits survive Stop and restart');
  await api(restarted.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle, 'Synthetic task: a second greeting after On.')});
  await waitFor(() => count(next, 'run') === 1, 'the next job ran after an explicit On', 30000);
  assert.deepEqual(settingsSnapshot(restarted.home), before, 'On did not change the consent or the limits');
  await waitFor(() => durableAttempts(restarted.home).filter((x) => x.process_state === 'ceased').length === 2, 'both attempts are proven gone', 30000);
  const retained=durableAttempts(restarted.home).find(row=>row.id===stopped.id);
  assert.equal(retained.hold_closed,false);
  assert.deepEqual(retained.resources.map(r=>[r.held_micro+r.unrepresented_micro,r.released_micro]),
    stopped.resources.map(r=>[r.initial_micro,0]),'On and a second job never refund the stopped envelope');
  // Retained is not stranded: each of the stopped job's own resets still releases its exposure.
  await restarted.app.close();
  const state=durable(restarted.home);
  const reopened=createLendingRuntime({directory:join(restarted.home,'v1'),now:()=>state.updated_at,
    pace50:{...proof,account:state.account}});
  try {await settleOwnResets(reopened.pace50,stopped.id);} finally {await reopened.close();}
});

test('a job submitted while lending is paused reserves nothing, and an explicit On lets the next job run', {timeout: 180000}, async (t) => {
  const f = await appFixture(t);
  const backend = syntheticBackend(f.root, {});
  const {owner, lender, circle} = await f.connect({backend, shutdownProofMs: 2000, lendingPace50: evidence()});
  await api(lender.app, '/api/desktop/presence', {method: 'POST', body: {idleSeconds: 3600}});
  await lendAutomatically(lender, circle);
  await api(lender.app, '/api/lending/pause', {method: 'POST', body: {}});
  await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle, 'Synthetic task: submitted while paused.')});
  // A negative control has no observable to wait on, so the lender gets a fixed window to consider the offer.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(durableAttempts(lender.home).length, 0, 'nothing was reserved while paused');
  assert.equal(count(backend, 'prepare'), 0, 'nothing was prepared while paused');
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  await waitFor(() => count(backend, 'run') === 1, 'a job ran after an explicit On', 30000);
});

test('with idle-only enabled, the candidate admits only after the owner is explicitly reported away', {timeout: 180000}, async (t) => {
  const f = await appFixture(t);
  const backend = syntheticBackend(f.root, {});
  // Real presence, not the fixture's fixed reader: until a report says otherwise, the owner's presence is unknown.
  const {owner, lender, circle} = await f.connect({backend, shutdownProofMs: 2000, lendingPace50: evidence(), idleReader: undefined});
  await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle, 'Synthetic task: presence unknown.')});
  await lendAutomatically(lender, circle, true);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(durableAttempts(lender.home).length, 0, 'with presence unknown, nothing was reserved');
  assert.equal(count(backend, 'prepare'), 0, 'with presence unknown, nothing was prepared');
  await api(lender.app, '/api/desktop/presence', {method: 'POST', body: {idleSeconds: 3600}});
  // The claim is about a job offered once the owner is away, so that job is submitted after the explicit report.
  await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle, 'Synthetic task: owner explicitly away.')});
  await waitFor(() => count(backend, 'run') >= 1, 'a job ran once the owner was explicitly away', 30000);
});

test('an unknown real source reserves nothing, and the borrower job list keeps working', {timeout: 180000}, async (t) => {
  const f = await appFixture(t);
  const backend = syntheticBackend(f.root, {});
  // The real source has no verified identity, so the candidate has no account to reserve against.
  const source = createRealPace50Source({readings: async () => ({windows: []})});
  const {owner, lender, circle} = await f.connect({backend, shutdownProofMs: 2000, lendingPace50: {source}});
  await api(lender.app, '/api/desktop/presence', {method: 'POST', body: {idleSeconds: 3600}});
  await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle)});
  await lendAutomatically(lender, circle);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(durableAttempts(lender.home).length, 0, 'an unknown identity reserved nothing');
  assert.equal(count(backend, 'prepare'), 0, 'an unknown identity prepared nothing');
  assert.equal(count(backend, 'run'), 0, 'an unknown identity ran nothing');
  const jobs = await api(owner.app, '/api/jobs');
  assert.ok(Array.isArray(jobs) && jobs.length >= 1, 'the borrower job list still shows the job');
  const lending = await api(lender.app, '/api/lending');
  assert.ok(lending && typeof lending === 'object', 'the lender still answers its own view');
});

// The fence is not cleared by a later On or by a delayed owner report: the admission that Stop caught never prepares.
test('an explicit On and a delayed owner-absent report after Stop do not let the stopped admission prepare a sandbox', {timeout: 180000}, async (t) => {
  const f = await appFixture(t);
  const backend = syntheticBackend(f.root, {});
  const admission = heldAdmission(backend);
  const {owner, lender, circle} = await f.connect({backend, lendingPace50: evidence(), idleReader: undefined, shutdownProofMs: 2000});
  await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle)});
  await api(lender.app, '/api/desktop/presence', {method: 'POST', body: {idleSeconds: 3600}});
  await lendAutomatically(lender, circle);
  await admission.entered;
  await api(lender.app, '/api/lending/stop', {method: 'POST', body: {confirmed: true, attemptId: durableAttempts(lender.home)[0].id}});
  // While the stopped admission is still held, the On route refuses until the stop is settled. That refusal is part of the fence.
  const refused = await boundedFetch(lender.app.origin + '/api/lending/on', {method: 'POST',
    headers: {'x-faravan-session-token': lender.app.token, 'content-type': 'application/json'}, body: JSON.stringify({circle: circle.id})});
  assert.equal(refused.status, 409, 'On is refused while the stopped admission is held');
  assert.equal((await refused.json()).code, 'lending_recovery_required', 'the refusal names the unsettled stop');
  // A delayed owner-absent report lands after Stop and must not clear the fence either.
  await api(lender.app, '/api/desktop/presence', {method: 'POST', body: {idleSeconds: 3600}});
  admission.release();
  await waitFor(() => durableAttempts(lender.home)[0].process_state === 'ceased', 'the stopped admission was released', 20000);
  assert.equal(count(backend, 'prepare'), 0, 'the stopped admission never prepared a sandbox');
  assert.equal(count(backend, 'run'), 0, 'the stopped admission never ran');
});
