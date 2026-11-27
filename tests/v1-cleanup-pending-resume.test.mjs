import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLender} from '../lib/v1/lender.mjs';
import {jobStatusContract} from '../lib/v1/status-contract.mjs';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
import {until, deferred} from './helpers/v1-lender-fixture.mjs';

// Real lender, real coordinator store and HTTP client; the backend is the shared fake that never starts a sandbox.
// A stalled first admission models a lender whose cleanup recovery pass outlasts the preparation timer.
const PREPARATION_MS = 3000;
// A bare coordinator job read carries no presence, so the release is shown as history.
const BORROWER = "The last try waited for the lender's computer to clean up. The lender's current status is unavailable.";
const turn = () => new Promise(resolve => setTimeout(resolve, 30));
const runs = f => f.calls.filter(([kind]) => kind === 'run').length;
const prepares = f => f.calls.filter(([kind]) => kind === 'prepare').length;

async function stalledFixture(t, {offers}) {
  const f = await realLenderFixture(t, {offers, mutateJob: job => {job.expires_at = '2026-10-09T18:00:00Z';}});
  const pending = deferred();
  const state = {inFlight: false, admissions: 0, approvals: 0, pending};
  const admit = f.backend.admitJob.bind(f.backend);
  f.backend.deadlineRecoveryPending = () => state.inFlight;
  f.backend.admitJob = spec => {
    state.admissions++;
    if (state.admissions === 1) {state.inFlight = true; f.calls.push(['admit', spec]); return pending.promise;}
    return admit(spec);
  };
  f.policy.preparationTimeoutMs = PREPARATION_MS;
  const controller = new AbortController();
  const lender = createLender({client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy, clock: f.clock,
    approve: async () => {state.approvals++; return true;}, onEvent: e => f.events.push(e)});
  const loop = lender.start(controller.signal);
  f.stop = async () => {controller.abort(); state.inFlight = false; pending.resolve({ok: false, code: 'policy_unenforceable'}); await loop;};
  Object.assign(state, {controller, loop, lender});
  // Advance the lender's clock in small steps; real HTTP needs real turns between them.
  state.tick = async (ms, step = 250) => {for (let spent = 0; spent < ms; spent += step) {f.clock.advance(step); await turn();}};
  return Object.assign(f, {state});
}

for (const offers of [true, false]) {
  test(`recovery outlasts the preparation timer; the job runs once after recovery (accepted=${offers})`, {timeout: 60000}, async t => {
    const f = await stalledFixture(t, {offers});
    await until(() => f.state.admissions === 1, 'the first admission must start');
    await f.state.tick(PREPARATION_MS + 500);
    // The coordinator holds the job queued with the fixed cause, not an expiry-length exclusion.
    const waiting = await f.owner.getJob(f.jobDigest);
    assert.equal(waiting.state, 'queued');
    assert.equal(waiting.attempts_started, 0);
    assert.equal(JSON.parse(waiting.current_attempt.reason).code, 'cleanup_pending');
    assert.equal(jobStatusContract(waiting).explanation, BORROWER);
    if (offers) assert.equal(f.saved().acceptedClaim?.intent.jobDigest, f.jobDigest, 'the approved claim intent is kept');
    else assert.equal(f.saves.some(row => row.acceptedClaim), false);
    const claimsDuringRecovery = () => f.realRequests.filter(r => r.url.includes('/claim')).length;
    const before = claimsDuringRecovery();
    await f.state.tick(30000);
    assert.equal(claimsDuringRecovery(), before, 'no claim traffic while recovery is in flight');
    assert.equal(runs(f) + prepares(f), 0);
    const approvalsBefore = f.state.approvals;
    // Recovery ends; the abandoned admission resolves late and must not launch anything by itself.
    f.state.inFlight = false;
    f.state.pending.resolve({ok: true, enforced_limits: ['cpu', 'memory', 'wall', 'output', 'storage'], unenforced: []});
    for (let n = 0; n < 200 && runs(f) === 0; n++) {f.clock.advance(250); await turn();}
    for (let n = 0; n < 200; n++) {
      if ((await f.owner.getJob(f.jobDigest)).state === 'result-accepted') break;
      f.clock.advance(250); await turn();
    }
    const done = await f.owner.getJob(f.jobDigest);
    assert.equal(done.state, 'result-accepted');
    assert.equal(done.attempts_started, 1, 'the job started exactly once');
    assert.equal(runs(f), 1, 'the agent ran exactly once');
    if (offers) assert.equal(f.state.approvals, approvalsBefore, 'no second lender approval after recovery');
    // A wait for cleanup is a setup wait, so the lender's approval for this job is remembered and asked once.
    assert.equal(f.state.approvals, 1);
  });
}

test('an aborted lender stops waiting on a stalled admission; a late result cannot launch work', {timeout: 60000}, async t => {
  const f = await stalledFixture(t, {offers: false});
  await until(() => f.state.admissions === 1, 'the first admission must start');
  f.state.controller.abort();
  const settled = await Promise.race([f.state.loop.then(() => 'stopped'), new Promise(resolve => setTimeout(() => resolve('still waiting'), 5000))]);
  assert.equal(settled, 'stopped', 'the lender must not wait for the stalled admission');
  f.state.pending.resolve({ok: true, enforced_limits: ['cpu', 'memory', 'wall', 'output', 'storage'], unenforced: []});
  for (let n = 0; n < 20; n++) await turn();
  assert.equal(prepares(f) + runs(f), 0, 'a late admission result must not launch work');
});
