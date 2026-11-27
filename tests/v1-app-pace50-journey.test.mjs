import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {appFixture, api, waitFor} from './helpers/v1-app-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';

// The real app pair: a borrower app submits a signed git job through the loopback coordinator, and a lender app with the
// candidate opt-in accepts it under the standing rule it chose through the canonical mode route. The fake sandbox runs
// it, and the result goes back through the coordinator. Trusted evidence is internal test input, not a request body.
// The codex model the journey runs: a priced model, so its guard meter can be enforced and its usage recorded.
const CODEX_RUN = {model: 'gpt-6-sol'};
const gitInput = (circle) => ({circle: circle.id, git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40),
  prompt: 'Synthetic task: write a greeting. No external execution.', harness: 'codex'});

// Initial consent through the canonical routes only: the limits, the agent, the auto mode (which derives the
// standing rule), and On. No per-job confirmation is involved.
async function lendAutomatically(lender, circle) {
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60,
    maxWallSeconds: 1200, idleOnly: false}});
  await api(lender.app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'auto'}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
}

const readDurable = (home, name) => JSON.parse(fs.readFileSync(join(home, 'v1', name), 'utf8'));

test('the app accepts a signed job automatically after consent, the fake sandbox runs it, and the coordinator accepts the result', {timeout: 180000}, async (t) => {
  const f = await appFixture(t);
  const source = createSyntheticPace50Source({start: Date.now()});
  const {owner, lender, circle} = await f.connect({lendingPace50: {source, account_week_id: 'synthetic-week-1'}, codexRun: CODEX_RUN});
  await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle)});
  await lendAutomatically(lender, circle);
  await waitFor(() => lender.backend.calls.some(([kind]) => kind === 'run'), 'fake sandbox ran the chunk',60000);
  await waitFor(() => [...f.jobs.values()].some((v) => v.state === 'result-accepted'), 'result accepted by the coordinator',60000);
  // Coordinator acceptance precedes cleanup proof; wait for the durable process stop.
  await waitFor(() => readDurable(lender.home, 'lending-pace50-state.json').attempts[0]?.process_state === 'ceased',
    'the candidate durably records cessation',60000);
  assert.deepEqual(await api(lender.app, '/api/approvals'), [], 'no per-job approval card was invented');

  // Durable candidate state: cleanup proves cessation, but aggregate usage has no interval-coverage proof.
  const state = readDurable(lender.home, 'lending-pace50-state.json');
  assert.equal(state.attempts.length, 1);
  assert.equal(state.attempts[0].process_state, 'ceased');
  assert.equal(state.attempts[0].hold_closed,false);
  assert.ok(state.attempts[0].resources.every((r) => r.held_micro+r.unrepresented_micro===r.initial_micro && r.released_micro===0),
    'the original envelope remains unresolved');
  // The legacy ledger is not part of the candidate path: it holds no entries from it.
  const ledgerPath = join(lender.home, 'v1', 'lending-ledger.json');
  if (fs.existsSync(ledgerPath)) assert.deepEqual(JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).entries ?? [], []);
  const runs = lender.backend.calls.filter(([kind]) => kind === 'run').length;

  // Restart: the cleanup proof and unresolved envelope survive, and nothing is launched again.
  await lender.app.close();
  const restarted = await f.start('lender', {lendingPace50: {source, account_week_id: 'synthetic-week-1'}, codexRun: CODEX_RUN});
  const after = readDurable(restarted.home, 'lending-pace50-state.json');
  assert.equal(after.attempts[0].process_state, 'ceased');
  assert.equal(after.attempts[0].hold_closed,false);
  assert.equal(after.revision, state.revision, 'the durable revision is unchanged by the restart');
  assert.equal(restarted.backend.calls.filter(([kind]) => kind === 'run').length, 0, `no relaunch (earlier runs: ${runs})`);
});
