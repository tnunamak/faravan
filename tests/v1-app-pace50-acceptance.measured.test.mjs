import './helpers/no-browser.mjs';
import {settleDurableAtBound} from './helpers/lending-settle-at-bound.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {appFixture, api, syntheticBackend, waitFor} from './helpers/v1-app-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';

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
  const {owner, lender, circle} = await f.connect({lendingPace50: evidence()});
  await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle)});
  await lendAutomatically(lender, circle);
  await waitFor(() => count(lender.backend, 'run') === 1, 'the chunk is running',60000);
  const closed = await lender.app.close();
  assert.deepEqual(closed.lending_live_attempts, [], 'nothing was left unceased');
  await settleDurableAtBound({home:lender.home,source:createSyntheticPace50Source({start:Date.now()})});
  const [attempt] = durable(lender.home).attempts;
  assert.equal(attempt.process_state, 'ceased', 'the removal was confirmed before the store closed');
  assert.ok(attempt.resources.every((r) => r.held_micro === 0), 'the reservation was released after the proof');
});

// A cancellation that never returns must not hold the app open. The Quit bound applies, and the attempt stays fenced.