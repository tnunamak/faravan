import './helpers/no-browser.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {appFixture, api, waitFor} from './helpers/v1-app-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
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


// Measured posting-lag bound (120 s): the metered chunk's hold closes only on a reading taken after cessation plus the bound.
test('a metered chunk spends the reconciled usage, keeps the spend and held amounts conserved, and releases only the unused reservation at the measured bound', {timeout: 240000}, async (t) => {
  const f = await appFixture(t);
  const source = createSyntheticPace50Source({start: Date.now()});
  const backend = meteringSandbox(f.root, {source, tokens: {input: 1200, output: 300}, cost_usd: 2.5, model: 'claude-haiku-5-5'});
  const stopReasons = [], requestStop = backend.requestStop;
  backend.requestStop = async (handle, reason) => { stopReasons.push(reason); return requestStop(handle, reason); };
  const {owner, lender, circle} = await f.connect({backend, lendingPace50: evidence(source), adapters: claudeAdapters});
  await api(owner.app, '/api/jobs', {method: 'POST', body: claudeJob(circle)});
  await lendAutomatically(lender, circle);
  await waitFor(() => [...f.jobs.values()].some((v) => v.state === 'result-accepted'), 'result accepted by the coordinator', 60000);
  await waitFor(() => durable(lender.home).attempts[0]?.process_state === 'ceased', 'the metered process is durably ceased', 60000);
  await lender.app.close();
  const saved = durable(lender.home);
  assert.equal(saved.attempts[0].hold_closed, false, 'reported usage alone does not close the hold');
  const clock = {at: saved.updated_at};
  const opened = createPace50Candidate({postingLagBoundMs: 120000, directory: join(lender.home, 'v1'), source, now: () => clock.at,
    account: saved.account, account_week_id: saved.account_week_id});
  try {
    clock.at = saved.attempts[0].cleanup_proof_persisted_at + 121000; // a reading past cessation plus the measured bound
    await opened.candidate.probeHeld();
    let [attempt] = durable(lender.home).attempts;
    for (const r of attempt.resources) {
      assert.equal(r.initial_micro, r.spent_micro + r.settled_micro + r.held_micro + r.released_micro, `${r.id}: the reservation is conserved`);
      assert.equal(r.held_micro, 0, `${r.id}: the covering reading leaves nothing held`);
      assert.ok(r.unrepresented_micro > 0, `${r.id}: the burn is not yet on the meter`);
    }
    assert.equal(attempt.hold_closed, false, 'the hold closes only once the burn shows on the meter');
    // A later owner rise by the unrepresented amount shows the burn on the meter.
    source.state.used.weekly += 1000000; source.state.used.short += 1000000;
    clock.at += 1000;
    await opened.candidate.probeHeld();
    [attempt] = durable(lender.home).attempts;
    assert.equal(attempt.process_state, 'ceased', 'the cleanup proof ceased the attempt');
    assert.equal(attempt.hold_closed, true);
    for (const r of attempt.resources) {
      assert.equal(r.initial_micro, r.spent_micro + r.settled_micro + r.held_micro + r.released_micro, `${r.id}: the reservation is conserved`);
      assert.equal(r.held_micro, 0, `${r.id}: nothing stays held after the proof`);
      assert.equal(r.unrepresented_micro, 0, `${r.id}: every burn is reconciled`);
    }
    assert.equal(attempt.resources.find((r) => r.id === 'seven_day').spent_micro, 1125000, 'the weekly spend is the converted metered cost');
    assert.equal(attempt.resources.find((r) => r.id === 'five_hour').spent_micro, 1500000, 'the short-window spend is the converted metered cost');
    assert.ok(source.state.used.weekly >= 20000000 + 125000, 'the provider counter shows at least the same weekly spend');
    assert.ok(!stopReasons.includes('provider_limit'), 'a pending quota reading alone does not request Stop');
    assert.equal(backend.meters.length, 1, 'one metered reading came through the host parser');
    const ledger = legacyLedger(lender.home);
    assert.deepEqual(ledger.holds, [], 'the legacy ledger holds nothing from the candidate');
    assert.deepEqual(ledger.entries, [], 'the legacy ledger records nothing from the candidate');
  } finally { await opened.candidate.cancelObservations?.(); await opened.adapter.close(); }
});
