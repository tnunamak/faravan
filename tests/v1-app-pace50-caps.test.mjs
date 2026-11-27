import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {appFixture, api, syntheticBackend, waitFor} from './helpers/v1-app-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';

// The remaining app-route check covers only the durable hold and cleanup outcome.
const gitInput = (circle, prompt = 'Synthetic task: write a greeting. No external execution.') => ({circle: circle.id,
  git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40), prompt, harness: 'codex'});
const evidence = (source = createSyntheticPace50Source({start: Date.now()})) => ({source,
  account_week_id: 'synthetic-week-1', contextFor: () => ({consent: true, people: true, agents: true,
    schedule: true, unexpired: true})});
async function lendAutomatically(lender, circle, harness = 'codex') {
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false}});
  await api(lender.app, `/api/agents/${harness === 'codex' ? 'codex' : 'claude-code-subscription'}`, {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'auto'}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
}
const durableAttempts = (home) => fs.existsSync(join(home, 'v1', 'lending-pace50-state.json'))
  ? JSON.parse(fs.readFileSync(join(home, 'v1', 'lending-pace50-state.json'), 'utf8')).attempts : [];
const count = (backend, kind) => backend.calls.filter(([name]) => name === kind).length;

// Lead decision: delete R6.1 volume ceilings; the objective rule sizes each chunk from spare capacity after worst-call headroom.

test('an unconfirmed removal keeps the exposure held and releases nothing, and a restart keeps it fenced without a relaunch', {timeout: 240000}, async (t) => {
  const f = await appFixture(t);
  const backend = syntheticBackend(f.root, {});
  // The sandbox is not confirmed removed. The lender's own cleanup receipt is what counts, so this is the fake sandbox's answer.
  backend.destroy = async () => { backend.calls.push(['destroy']); return {removed: false}; };
  const {owner, lender, circle} = await f.connect({backend, shutdownProofMs: 2000, lendingPace50: evidence()});
  await api(lender.app, '/api/desktop/presence', {method: 'POST', body: {idleSeconds: 3600}});
  await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle)});
  await lendAutomatically(lender, circle);
  await waitFor(() => count(backend, 'destroy') >= 1, 'the sandbox was asked to stop', 30000);
  await waitFor(() => durableAttempts(lender.home).length === 1, 'the reservation was recorded', 30000);
  const [attempt] = durableAttempts(lender.home);
  assert.notEqual(attempt.process_state, 'ceased', 'an unconfirmed removal does not cease the attempt');
  assert.ok(attempt.resources.some((r) => r.held_micro > 0), 'the exposure stays held after the job ends');
  assert.ok(attempt.resources.every((r) => r.released_micro === 0), 'nothing is released without a confirmed removal');
  await lender.app.close();
  const restarted = await f.start('lender', {backend, shutdownProofMs: 2000, lendingPace50: evidence()});
  await api(restarted.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle, 'Synthetic task: a job while the exposure is fenced.')});
  // A negative control has no observable to wait on, so the lender gets a fixed window to consider the offer.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.equal(count(backend, 'run'), 1, 'the restart did not relaunch the job whose removal is unconfirmed');
  assert.equal(durableAttempts(restarted.home).length, 1, 'the restart did not reserve new exposure behind the fence');
  const [after] = durableAttempts(restarted.home);
  assert.notEqual(after.process_state, 'ceased', 'the restart did not treat the attempt as gone');
  assert.ok(after.resources.every((r) => r.released_micro === 0), 'the restart released nothing');
});
