import './helpers/no-browser.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {appFixture, api, waitFor} from './helpers/v1-app-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {meteringSandbox} from './helpers/pace50-app-sandbox.mjs';

// Metered acceptance through the real app pair. The fake sandbox reports usage through the guard's meter record and the
// host parser, and the candidate records it without treating it as interval coverage. Every number asserted here is read from the durable candidate state and
// from the synthetic provider counter, not from the test\'s own arithmetic about the adapter.
const claudeJob = (circle) => ({circle: circle.id, git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40),
  prompt: 'Synthetic task: write a greeting. No external execution.', harness: 'claude-code-subscription'});
const claudeAdapters = () => [{spec:legacyProxyHarness('claude-code-subscription'), installed: true, signedIn: true,
  harnessVersion: 'synthetic-only', models: ['claude-haiku-5-5'], capabilities: []}];
const evidence = (source) => ({source, account_week_id: 'synthetic-week-1'});
async function lendAutomatically(lender, circle) {
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false,
    lendingPolicy: {providerConsent: {claude: true}}}});
  await api(lender.app, '/api/agents/claude-code-subscription', {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/agents/claude-code-subscription/run', {method: 'POST', body: {model: 'claude-haiku-5-5', effort: null}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'auto'}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
}
const durable = (home) => JSON.parse(fs.readFileSync(join(home, 'v1', 'lending-pace50-state.json'), 'utf8'));
const legacyLedger = (home) => {
  const file = join(home, 'v1', 'lending-ledger.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {holds: [], entries: []};
};

test('a metered chunk records cost but retains unresolved exposure without interval coverage', {timeout: 240000}, async (t) => {
  const f = await appFixture(t);
  const source = createSyntheticPace50Source({start: Date.now()});
  const backend = meteringSandbox(f.root, {source, tokens: {input: 1200, output: 300}, cost_usd: 2.5, model: 'claude-haiku-5-5'});
  const stopReasons = [], requestStop = backend.requestStop;
  backend.requestStop = async (handle, reason) => { stopReasons.push(reason); return requestStop(handle, reason); };
  const {owner, lender, circle} = await f.connect({backend, lendingPace50: evidence(source), adapters: claudeAdapters});
  await api(owner.app, '/api/jobs', {method: 'POST', body: claudeJob(circle)});
  await lendAutomatically(lender, circle);
  await waitFor(() => [...f.jobs.values()].some((v) => v.state === 'result-accepted'), 'result accepted by the coordinator',60000);
  // A coordinator response is not the lender's local durable cleanup barrier.
  await waitFor(() => durable(lender.home).attempts[0]?.process_state === 'ceased',
    'the metered process is durably ceased',60000);
  const [attempt] = durable(lender.home).attempts;
  assert.equal(attempt.process_state, 'ceased', 'the cleanup proof ceased the attempt');
  assert.equal(attempt.hold_closed,false,'reported usage does not prove the full interval');
  for (const r of attempt.resources) {
    assert.equal(r.initial_micro, r.spent_micro + r.settled_micro + r.held_micro + r.released_micro, `${r.id}: the reservation is conserved`);
    assert.equal(r.held_micro+r.unrepresented_micro,r.initial_micro, `${r.id}: the original exposure stays unresolved`);
    assert.equal(r.released_micro,0,`${r.id}: no residual exposure is released`);
  }
  const weekly = attempt.resources.find((r) => r.id === 'seven_day');
  const short = attempt.resources.find((r) => r.id === 'five_hour');
  assert.equal(weekly.spent_micro, 125000, 'the weekly spend is the converted metered cost');
  assert.equal(short.spent_micro, 500000, 'the short-window spend is the converted metered cost');
  // The provider counter moves by at least the metered weekly spend. The synthetic double also moves on each conversion the candidate makes.
  assert.ok(source.state.used.weekly >= 20000000 + 125000, 'the provider counter shows at least the same weekly spend');
  assert.ok(!stopReasons.includes('provider_limit'), 'a pending quota reading alone does not request Stop');
  assert.equal(backend.meters.length, 1, 'one metered reading came through the host parser');
  const ledger = legacyLedger(lender.home);
  assert.deepEqual(ledger.holds, [], 'the legacy ledger holds nothing from the candidate');
  assert.deepEqual(ledger.entries, [], 'the legacy ledger records nothing from the candidate');
});
