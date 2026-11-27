import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {appFixture, api, syntheticBackend, waitFor} from './helpers/v1-app-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';

// Fence and negative controls through the real app pair. The sandbox is held, so a chunk is running when the owner
// returns, presses Stop, or pauses. Presence, Stop, Pause and On are the app's own routes, not test-only hooks.
const gitInput = (circle) => ({circle: circle.id, git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40),
  prompt: 'Synthetic task: write a greeting. No external execution.', harness: 'codex', budget_v1: {max_list_usd: 3}});
// The codex model the journey runs: a priced model, so its guard meter can be enforced and its usage settled.
const CODEX_RUN = {model: 'gpt-6-sol'};
const evidence = () => ({source: createSyntheticPace50Source({start: Date.now()}),
  account_week_id: 'synthetic-week-1',contextFor:()=>({consent:true,people:true,agents:true,schedule:true,unexpired:true})});
// These Stop/Pause journeys admit the synthetic fifteen-point job before exercising control behavior.
async function lendAutomatically(lender, circle) {
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false,
    lendingPolicy: {providerConsent: {codex: true}, protectionPosition: 'balanced',strategyParams:{perJobPct:100}}}});
  await api(lender.app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'auto'}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
}
const durable = (home) => JSON.parse(fs.readFileSync(join(home, 'v1', 'lending-pace50-state.json'), 'utf8'));
const attemptOf = (f) => [...f.jobs.values()].find((v) => v.current_attempt)?.current_attempt.attempt_id;

// A killed chunk reports no usage, so its exposure is held: the stop is recorded and the sandbox is stopped, but nothing settles.
test('owner Stop through the app durably records cessation and settles the held burn exactly once', {timeout: 180000}, async (t) => {
  const f = await appFixture(t, {hold: true});
  const source = createSyntheticPace50Source({start: Date.now(), kappa: {weekly: 5_000_000, short: 200_000}, override: ({base}) => ({...base,
    resources: base.resources.filter((resource) => resource.kind === 'weekly')})});
  const backend = syntheticBackend(f.root, {hold: true});
  const start = backend.start.bind(backend);
  backend.start = (handle, options = {}) => start(handle, {...options, lendingBudget: null, onMeter: () => {}, onLog: () => {}});
  const cancel = backend.cancel.bind(backend);
  backend.cancel = async (handle) => {
    // The synthetic provider meter records one point of use before confirming that Stop removed the sandbox.
    source.state.used.weekly += 1000000;
    return cancel(handle);
  };
  const {owner, lender, circle} = await f.connect({backend, lendingPace50: {source,postingLagBoundMs:0,
    account_week_id: 'synthetic-week-1', contextFor: () => ({people: true, agents: true, schedule: true, unexpired: true})},
    codexRun: CODEX_RUN});
  await api(lender.app, '/api/desktop/presence', {method: 'POST', body: {idleSeconds: 3600}});
  await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle)});
  await lendAutomatically(lender, circle);
  await waitFor(() => lender.backend.calls.some(([kind]) => kind === 'run'), 'the synthetic sandbox started');

  const attemptId = attemptOf(f);
  const wrongAttempt = '00000000-0000-4000-8000-000000000000';
  const rejected = await api(lender.app, '/api/lending/stop', {method: 'POST',
    body: {confirmed: true, attemptId: wrongAttempt}, status: 409});
  assert.equal(rejected.code, 'no_current_job', 'an unrelated attempt cannot stop this run');
  assert.equal(backend.calls.some(([kind]) => kind === 'cancel'), false, 'wrong-attempt Stop did not signal this run');
  assert.equal(durable(lender.home).event_ids.includes(wrongAttempt + ':owner-stop'), false, 'no unrelated Stop was acknowledged');
  const before = durable(lender.home).attempts.find((attempt) => attempt.id === attemptId);
  assert.equal(before.process_state, 'running');
  const weeklyBefore = before.resources.find((resource) => resource.kind === 'weekly');
  assert.ok(weeklyBefore.held_micro > 0, 'the admitted exposure is held before Stop');

  await api(lender.app, '/api/lending/stop', {method: 'POST', body: {confirmed: true, attemptId}});
  assert.ok(durable(lender.home).event_ids.includes(`${attemptId}:owner-stop`),
    `the first route call persisted its Stop intent: ${durable(lender.home).event_ids.join(',')}`);
  await api(lender.app, '/api/lending/stop', {method: 'POST', body: {confirmed: true, attemptId}});
  const stopIntent = durable(lender.home);
  assert.ok(stopIntent.event_ids.includes(`${attemptId}:owner-stop`),
    'the app route records an attempt-specific durable Stop intent');
  assert.ok(['cessation_requested', 'ceased'].includes(stopIntent.attempts.find((attempt) => attempt.id === attemptId)?.process_state),
    'the durable intent requests cessation without claiming it happened');
  await waitFor(() => lender.backend.calls.some(([kind]) => kind === 'destroy'), 'the stopped sandbox was removed');
  // cessation_proven is durable as soon as the sandbox is gone. The settlement is what releases the held exposure, after the meter
  // reconciles, so the wait is on the hold.
  await waitFor(() => durable(lender.home).attempts.find((attempt) => attempt.id === attemptId)?.resources
    .every((resource) => resource.held_micro === 0), 'durable cessation and meter reconciliation completed');

  const state = durable(lender.home);
  const settled = state.attempts.find((attempt) => attempt.id === attemptId);
  const weekly = settled.resources.find((resource) => resource.kind === 'weekly');
  assert.equal(settled.process_state, 'ceased');
  assert.equal(weekly.spent_micro,2000000,'whole growth plus a reporting step is charged once');
  assert.equal(weekly.held_micro, 0, 'the remaining exposure was released after reconciliation');
  assert.equal(weekly.released_micro, Math.max(0,weeklyBefore.initial_micro-2000000));
  assert.equal(state.event_ids.filter((eventId) => eventId === `${attemptId}:owner-stop`).length, 1,
    'a route retry records the same durable Stop intent only once');
  assert.equal(state.event_ids.filter(id=>id.startsWith(`${attemptId}:coverage:`)).length,1,'the final charge is atomic and recorded once');
  assert.equal(state.event_ids.filter(id=>id===`${attemptId}:probe-usage`).length,0,
    'account-wide growth is covered conservatively, without attributing it to this job');
});
