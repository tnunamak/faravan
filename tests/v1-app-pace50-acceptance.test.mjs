import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {appFixture, api, syntheticBackend, waitFor} from './helpers/v1-app-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {settleOwnResets} from './helpers/pace50-reset-assertions.mjs';

// App-pair acceptance for the candidate path, beyond the first journey: shutdown, a removal that is never confirmed,
// and restart. Trusted evidence is startup input for the test. Removal is only what the fake sandbox reports.
const gitInput = (circle) => ({circle: circle.id, git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40),
  prompt: 'Synthetic task: write a greeting. No external execution.', harness: 'codex'});
const evidence = () => ({source: createSyntheticPace50Source({start: Date.now()}),
  account_week_id: 'synthetic-week-1'});
async function lendAutomatically(lender, circle) {
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60,
    maxWallSeconds: 1200, idleOnly: false, lendingPolicy: {providerConsent: {codex: true}}}});
  await api(lender.app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'auto'}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
}
const durable = (home) => JSON.parse(fs.readFileSync(join(home, 'v1', 'lending-pace50-state.json'), 'utf8'));
const count = (backend, kind) => backend.calls.filter(([name]) => name === kind).length;

test('closing the app with a running chunk whose removal is confirmed ceases the attempt before the store closes', {timeout: 180000}, async (t) => {
  const f = await appFixture(t, {hold: true});
  const proof=evidence();
  const {owner, lender, circle} = await f.connect({lendingPace50: proof});
  await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle)});
  await lendAutomatically(lender, circle);
  await waitFor(() => count(lender.backend, 'run') === 1, 'the chunk is running',60000);
  const closed = await lender.app.close();
  assert.deepEqual(closed.lending_live_attempts, [], 'nothing was left unceased');
  const state=durable(lender.home),[attempt]=state.attempts;
  assert.equal(attempt.process_state, 'ceased', 'the removal was confirmed before the store closed');
  assert.equal(attempt.hold_closed,false,'removal proves cessation, not complete provider posting');
  assert.ok(attempt.resources.every(r=>r.held_micro+r.unrepresented_micro===r.initial_micro&&r.released_micro===0),
    'shutdown retains the original unresolved envelope');
  const reopened=createLendingRuntime({directory:join(lender.home,'v1'),now:()=>state.updated_at,
    pace50:{...proof,account:state.account}});
  try {
    assert.deepEqual(reopened.pace50.state(),state,'shutdown exposure survives reopening');
    await settleOwnResets(reopened.pace50,attempt.id);
    assert.ok(reopened.pace50.state().attempts[0].resources.every(r=>r.released_micro===0&&
      r.spent_micro+r.settled_micro===r.initial_micro),'each own reset charges the full unresolved reservation');
  } finally {await reopened.close();}
});

test('closing the app when removal is never confirmed returns in bounded time, reports the live attempt, and keeps the exposure fenced across restart', {timeout: 180000}, async (t) => {
  const f = await appFixture(t, {hold: true});
  const backend = syntheticBackend(f.root, {hold: true});
  // Removal is not confirmed. The sandbox is cancelled, but the backend cannot say it was removed.
  backend.destroy = async () => { backend.calls.push(['destroy']); return {removed: false}; };
  const {owner, lender, circle} = await f.connect({backend, lendingPace50: evidence(), shutdownProofMs: 1500});
  await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle)});
  await lendAutomatically(lender, circle);
  await waitFor(() => count(lender.backend, 'run') === 1, 'the chunk is running');
  const started = Date.now();
  const runsBefore = count(backend, 'run');
  const closed = await lender.app.close();
  assert.ok(Date.now() - started < 30000, 'shutdown is bounded and does not wait forever');
  assert.equal(closed.lending_live_attempts.length, 1, 'the unconfirmed attempt is reported as live');
  const [attempt] = durable(lender.home).attempts;
  assert.notEqual(attempt.process_state, 'ceased', 'an unconfirmed removal does not cease the attempt');
  assert.ok(attempt.resources.some((r) => r.held_micro > 0), 'the exposure stays held');
  assert.ok(attempt.resources.every((r) => r.released_micro === 0), 'nothing is released without confirmed removal');
  // Restart: the lock is free, the store reopens with the same fence, and nothing runs again.
  const restarted = await f.start('lender', {backend, lendingPace50: evidence(), shutdownProofMs: 1500});
  assert.equal(durable(restarted.home).attempts[0].process_state, attempt.process_state, 'the fence survives the restart');
  await api(restarted.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  assert.equal(count(backend, 'run'), runsBefore, 'nothing ran after the restart');
});

// A cancellation that never returns must not hold the app open. The Quit bound applies, and the attempt stays fenced.
test('a cancellation that never returns cannot hold the app open past the shutdown bound', {timeout: 120000}, async (t) => {
  const f = await appFixture(t, {hold: true});
  const backend = syntheticBackend(f.root, {hold: true});
  // The hung call is released in teardown. Until then the app returns in bounded time and reports the attempt; the call's own
  // handles stay open, so the test releases them itself.
  let unblock;
  backend.cancel = async () => { backend.calls.push(['cancel']); await new Promise((resolve) => { unblock = resolve; }); return {compute_stopped: false}; };
  t.after(() => unblock?.());
  const {owner, lender, circle} = await f.connect({backend, lendingPace50: evidence(), shutdownProofMs: 1500});
  await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle)});
  await lendAutomatically(lender, circle);
  await waitFor(() => count(backend, 'run') === 1, 'the chunk is running');
  const started = Date.now();
  const closed = await lender.app.close();
  assert.ok(Date.now() - started < 30000, 'shutdown returned within the bound');
  assert.equal(closed.lending_live_attempts.length, 1, 'the attempt is reported as live');
  assert.notEqual(durable(lender.home).attempts[0].process_state, 'ceased', 'it is not treated as gone');
});
