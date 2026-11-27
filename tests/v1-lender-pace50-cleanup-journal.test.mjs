import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLender} from '../lib/v1/lender.mjs';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {normalizeLendingPolicy} from '../lib/v1/lending-policy.mjs';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {lenderFixture, until} from './helpers/v1-lender-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT, HOUR_MS, NOW, WEEK} from './helpers/pace50-fixtures.mjs';

const HAIKU = 'claude-haiku-5-5';

// The lender clears its pending journal entry only after the candidate has durably recorded the sandbox removal. Here the
// durable write is held open, and the run's finish fails, so the lender reaches the journal entry through its error path.
function launch(f) {
  const controller = new AbortController();
  const lender = createLender({client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy, clock: f.clock,
    approve: async () => true, onEvent: (event) => { f.events.push(event); }});
  const running = lender.start(controller.signal);
  let failure;
  const settled = Promise.resolve(running).catch((error) => { failure = error; });
  f.stop = async () => {
    controller.abort();
    let timer;
    try {
      await Promise.race([settled, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('lender shutdown timed out')), 30000); })]);
    } finally {
      clearTimeout(timer);
    }
    if (failure && failure.name !== 'AbortError' && failure.code !== 'aborted') throw failure;
  };
  return lender;
}

const CODEX_RUN = {model: 'gpt-6-sol'};
// The run's final meter reports no tokens and no cost. That is unknown usage, not zero use. A zero reading would settle the
// hold through the lender's own error-path settlement, and the restart assertions would then find it closed.
const UNPRICED_METER = {input: 0, cached_input: 0, cache_write: 0, output: 0, reasoning_output: 0};
// The owner has consented to lending on codex, as the settings UI records it. Without consent every admission is refused.
const settingsOn = () => ({intent: 'on', limits: {lendingPolicy: normalizeLendingPolicy({providerConsent: {codex: true}}),
  dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false}});

test('the lender keeps its pending journal entry until the durable cleanup proof is written', {timeout: 90000}, async (t) => {
  const f = await lenderFixture(t, {policy: {mode: 'auto'}, run: CODEX_RUN, guardTokens: UNPRICED_METER});
  f.policy.userActive = async () => false;
  const source = createSyntheticPace50Source({start: f.clock.now()});
  const runtime = createLendingRuntime({directory: join(f.root, 'pace50'), settings: settingsOn, backend: {}, presence: () => false,
    lastActiveAt: () => null, selfKey: () => null, now: () => f.clock.now(),
    pace50: {account: 'synthetic-account', account_week_id: 'synthetic-week-1', source}});
  f.policy.lendingRuntime = runtime;
  const candidate = runtime.candidate;

  // The durable write for the sandbox removal finishes only when the test opens this gate.
  let openGate;
  const gate = new Promise((resolve) => { openGate = resolve; });
  const recordCleanup = candidate.recordCleanup.bind(candidate);
  candidate.recordCleanup = (attemptId, cleanup) => {
    const durable = recordCleanup(attemptId, cleanup);
    return Promise.all([durable, gate]).then(([outcome]) => outcome);
  };
  // The run's finish fails once, after the sandbox is gone, which sends the lender down its error path.
  const finish = candidate.finish.bind(candidate);
  let failed = false;
  candidate.finish = (args) => {
    if (!failed) {
      failed = true;
      return Promise.reject(Object.assign(new Error('injected finish failure'), {code: 'injected_finish_failure'}));
    }
    return finish(args);
  };

  launch(f);
  await until(() => f.calls.some(([kind]) => kind === 'destroy'), 'the sandbox was removed');
  await until(() => failed, 'the run reached its failing finish');
  // Give the lender time to reach its journal entry. Without the await, the entry is cleared right here.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(f.saved().pending, 'the journal entry is kept while the cleanup proof is not yet durable');

  openGate();
  await until(() => f.saved()?.pending === null, 'the journal entry is cleared once the proof is durable');
  assert.equal(runtime.pace50.state().attempts[0].cleanup_proven, true, 'the removal is durable before the entry goes');
  await f.stop();
  await runtime.close();

  // The journal entry is gone, so the candidate's durable record is the only proof of the removal. It must survive a restart,
  // and the unsettled usage keeps its hold open.
  const restarted = createLendingRuntime({directory: join(f.root, 'pace50'), settings: settingsOn, backend: {}, presence: () => false,
    lastActiveAt: () => null, selfKey: () => null, now: () => f.clock.now(),
    pace50: {account: 'synthetic-account', account_week_id: 'synthetic-week-1', source}});
  const [reopened] = restarted.pace50.state().attempts;
  assert.equal(reopened.cleanup_proven, true, 'the removal survives a restart after the journal entry is gone');
  assert.equal(reopened.process_state, 'ceased', 'the durable record says the process ceased');
  assert.equal(reopened.hold_closed, false, 'the usage is unsettled, so the hold stays open');
  assert.ok(reopened.resources.every((r) => r.held_micro > 0), 'the exposure is still held');
  await restarted.close();
});

// A restart does not make a started attempt releasable. Its usage is unknown until finish or a meter reading settles it, so a release
// must not invent a zero-use attestation for the held exposure.
test('a restarted candidate refuses to release the hold of a started attempt', {timeout: 30000}, async (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'started-restart-'));
  const attemptId = 'started-before-restart';
  const job = {requirements: {limits: {wall_seconds: 300}}, expires_at: new Date(NOW + HOUR_MS).toISOString()};
  const open = () => createPace50Candidate({directory, now: () => NOW, account: ACCOUNT, account_week_id: WEEK,
    source: createSyntheticPace50Source({start: NOW}), pendingRecords: () => []});
  let pace = open();
  t.after(async () => {
    await pace.adapter.close();
    fs.rmSync(directory, {recursive: true, force: true});
  });

  const grant = await pace.candidate.reserve({attemptId, jobId: 'started-job', provider: 'claude', model: HAIKU, job,
    automatic: true, ownerAbsent: true});
  assert.equal(grant.ok, true, JSON.stringify(grant));
  await pace.candidate.started(attemptId, {ok: true});
  await pace.candidate.recordCleanup(attemptId, {removed: true});
  const held = () => pace.adapter.state().attempts[0].resources.map((r) => r.held_micro);
  const before = held();
  assert.ok(before.every((value) => value > 0), 'the started run holds its exposure');
  await pace.adapter.close();

  pace = open();
  const refused = await pace.candidate.release(attemptId, {reason: 'restart-test', prepared: true});
  assert.deepEqual([refused.applied, refused.reason], [false, 'usage_unreconciled'], JSON.stringify(refused));
  assert.deepEqual(held(), before, 'the hold is unchanged by the refused release');
});

// A directory sync can fail after the rename has made the new revision visible. That revision is not known to be durable, so the store
// refuses from then on: a second write does not claim the proof, and the reopened store shows it only if the rename persisted.
test('a cleanup proof whose directory sync failed is not claimed by the poisoned store', {timeout: 30000}, async (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'cleanup-dir-sync-'));
  const attemptId = 'dir-sync-attempt';
  const job = {requirements: {limits: {wall_seconds: 300}}, expires_at: new Date(NOW + HOUR_MS).toISOString()};
  let failNextDirectorySync = false;
  const io = {fsyncDirectory: (dir) => {
    if (failNextDirectorySync) {
      failNextDirectorySync = false;
      throw new Error('injected directory sync failure');
    }
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }};
  const open = () => createPace50Candidate({directory, now: () => NOW, account: ACCOUNT, account_week_id: WEEK,
    source: createSyntheticPace50Source({start: NOW}), io, pendingRecords: () => []});
  let pace = open();
  t.after(async () => {
    await pace.adapter.close();
    fs.rmSync(directory, {recursive: true, force: true});
  });

  const grant = await pace.candidate.reserve({attemptId, jobId: 'dir-sync-job', provider: 'claude', model: HAIKU, job,
    automatic: true, ownerAbsent: true});
  assert.equal(grant.ok, true, JSON.stringify(grant));
  await pace.candidate.started(attemptId, {ok: true});
  failNextDirectorySync = true;
  await assert.rejects(pace.candidate.recordCleanup(attemptId, {removed: true}), {code: 'pace50_persist_failed'});
  await assert.rejects(pace.candidate.recordCleanup(attemptId, {removed: true}), {code: 'pace50_store_poisoned'});
  await pace.adapter.close();

  pace = open();
  const [attempt] = pace.adapter.state().attempts;
  assert.equal(attempt.process_state, 'ceased', 'the reopened store shows the removal the rename made visible');
  assert.equal(attempt.cleanup_proven, true);
  assert.equal((await pace.candidate.recordCleanup(attemptId, {removed: true})).applied, true);
});

// A restart recovers a journal entry for an attempt whose exposure the candidate still holds, with its usage unknown. The backend can prove
// the sandbox gone, but the candidate may never have recorded that. The recovery must record it before the entry is cleared, or nothing
// can settle the hold later.
async function recoveryRig(t, {stopped = false, unstarted = false} = {}) {
  const f = await lenderFixture(t, {policy: {mode: 'auto'}, run: CODEX_RUN});
  f.override = async (record) => {
    if (record.route !== '/jobs/claim-next') return false;
    record.res.writeHead(200, {'content-type': 'application/json'});
    record.res.end('null');
    return true;
  };
  const runtime = createLendingRuntime({directory: join(f.root, 'pace50'), settings: settingsOn, backend: {}, presence: () => false,
    lastActiveAt: () => null, selfKey: () => null, now: () => f.clock.now(),
    pace50: {account: 'synthetic-account', account_week_id: 'synthetic-week-1', source: createSyntheticPace50Source({start: f.clock.now()})}});
  f.policy.lendingRuntime = runtime;
  const attempt = f.attempt();
  const attemptId = attempt.attempt_id;
  const grant = await runtime.candidate.reserve({attemptId, jobId: f.jobDigest, provider: 'codex', model: CODEX_RUN.model,
    job: {requirements: {limits: {wall_seconds: 120}}, expires_at: new Date(f.clock.now() + HOUR_MS).toISOString()},
    automatic: true, ownerAbsent: true});
  assert.equal(grant.ok, true, JSON.stringify(grant));
  if (!unstarted) await runtime.candidate.started(attemptId, {ok: true});
  // A persisted counter store requires its calendar day even during recovery; the frozen contract preserves crash journals.
  await f.policy.storage.set({day: '2026-10-09', jobs: 1, milliseconds: 0, pending: {attemptId, attempt, jobId: f.jobDigest, reservedMs: 120000,prepare_contract:'create-only',
    resources: {cpu: 1, memoryBytes: 1}, executionStartRequested: !unstarted, startIdempotencyKey: 'recovery-start',
    ...(stopped ? {stopReason: 'stopped_by_lender', stoppedAt: f.clock.now(), stopReleaseKey: 'recovery-release',
      stopReportKey: 'recovery-report'} : {})}});
  const reconciled = [];
  f.backend.reconcilePending = async (pending) => {
    reconciled.push(pending.attemptId);
    return {attemptId: pending.attemptId, removed: true};
  };
  const row = () => runtime.pace50.state().attempts.find((a) => a.id === attemptId);
  return {f, runtime, attemptId, reconciled, row};
}

test('a recovered journal entry clears only after the candidate has durably recorded the removal', {timeout: 90000}, async (t) => {
  const {f, runtime, attemptId, reconciled, row} = await recoveryRig(t);
  launch(f);
  await until(() => f.saved()?.pending === null, 'the recovered entry is cleared');
  assert.deepEqual(reconciled, [attemptId], 'the backend proved the removal');
  assert.equal(row().cleanup_proven, true, 'the candidate recorded the removal before the entry went');
  await f.stop();
  // Past the windows' resets the held exposure settles, so it cannot block later lending.
  f.clock.advance(43 * HOUR_MS);
  await runtime.candidate.probeHeld();
  assert.deepEqual(row().resources.map((r) => r.held_micro), [0, 0], 'the hold settles at its reset rather than blocking lending');
});

test('a recovered journal entry stays while the candidate write is rejected', {timeout: 90000}, async (t) => {
  const {f, runtime, reconciled, row} = await recoveryRig(t);
  runtime.candidate.recordCleanup = () => Promise.reject(Object.assign(new Error('injected candidate write failure'),
    {code: 'injected_candidate_write'}));
  launch(f);
  await until(() => reconciled.length > 0, 'the lender ran its recovery');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(f.saved()?.pending, 'the entry stays until the candidate has recorded the removal');
  assert.equal(row().cleanup_proven, false, 'nothing was recorded, so nothing is claimed');
  await f.stop();
});

test('a recovered stop clears its journal entry only after the candidate has durably recorded the removal', {timeout: 90000}, async (t) => {
  const {f, attemptId, reconciled, row} = await recoveryRig(t, {stopped: true});
  launch(f);
  await until(() => f.saved()?.pending === null, 'the recovered stop is cleared');
  assert.deepEqual(reconciled, [attemptId], 'the backend proved the removal');
  assert.equal(row().cleanup_proven, true, 'the candidate recorded the removal before the stop entry went');
  await f.stop();
});

// The journal entry is the only record that the attempt still needs settling. The finally block clears it before the candidate settles the
// attempt, so a crash between the two orphans the hold. The entry must stay until the settlement has been applied.
test('the lender keeps its journal entry until the candidate has settled the attempt', {timeout: 90000}, async (t) => {
  const f = await lenderFixture(t, {policy: {mode: 'auto'}, run: CODEX_RUN, guardTokens: UNPRICED_METER});
  f.policy.userActive = async () => false;
  const runtime = createLendingRuntime({directory: join(f.root, 'pace50'), settings: settingsOn, backend: {}, presence: () => false,
    lastActiveAt: () => null, selfKey: () => null, now: () => f.clock.now(),
    pace50: {account: 'synthetic-account', account_week_id: 'synthetic-week-1', source: createSyntheticPace50Source({start: f.clock.now()})}});
  f.policy.lendingRuntime = runtime;
  const candidate = runtime.candidate;
  // Finish stays unavailable through the error path and immediate recovery retries.
  // Reopening below supplies a healthy candidate after the retained journal is checked.
  let failed = false;
  candidate.finish = () => {
    failed = true;
    return Promise.reject(Object.assign(new Error('injected finish failure'), {code: 'injected_finish_failure'}));
  };
  // The settlement that follows fails, as a crash or a failed write would.
  let settlementAttempted = false;
  candidate.settle = () => {
    settlementAttempted = true;
    return Promise.reject(Object.assign(new Error('injected settle failure'), {code: 'injected_settle_failure'}));
  };
  launch(f);
  await until(() => f.calls.some(([kind]) => kind === 'destroy'), 'the sandbox was removed');
  await until(() => failed, 'the run reached its failing finish');
  await until(() => settlementAttempted, 'the candidate attempted settlement');
  // Join the lender loop before inspecting the failed settlement's retained journal.
  await f.stop();
  assert.ok(f.saved()?.pending, 'the journal entry is kept until the candidate has settled the attempt');
  const pending = structuredClone(f.saved().pending);
  assert.equal(pending.candidateSettlement.provider, 'codex');
  assert.ok(f.saved().claimedPending, 'the claim still has an owner too');
  await runtime.close();

  // Reopen the candidate's durable state with no live execution registry. Off must still retry settlement.
  f.policy.enabled = false;
  const restarted = createLendingRuntime({directory: join(f.root, 'pace50'), settings: settingsOn, backend: {}, presence: () => false,
    lastActiveAt: () => null, selfKey: () => null, now: () => f.clock.now(),
    pace50: {account: 'synthetic-account', account_week_id: 'synthetic-week-1', source: createSyntheticPace50Source({start: f.clock.now()})}});
  f.policy.lendingRuntime = restarted;
  const settle = restarted.candidate.finish.bind(restarted.candidate);
  const retries = [];
  let allowSettlement = false;
  restarted.candidate.finish = async (...args) => {
    retries.push(structuredClone(args));
    if (!allowSettlement) throw new Error('injected restarted settlement failure');
    return settle(...args);
  };
  launch(f);
  await until(() => retries.length > 0, 'Off restart retries settlement');
  await until(() => f.clock.pending().includes(f.policy.pollMs), 'the failed retry schedules its next poll');
  assert.deepEqual(f.saved().pending, pending, 'a failed retry preserves the complete journal');
  assert.deepEqual(retries[0], [{...pending.candidateSettlement,attemptId:pending.attemptId,execution:null}], 'retry preserves identity and treats usage as unknown');
  allowSettlement = true;
  f.clock.advance(f.policy.pollMs);
  await until(() => f.saved()?.pending === null, 'successful settlement releases the journal');
  assert.equal(restarted.pace50.state().attempts.find(row => row.id === pending.attemptId).usage_unknown, 'codex',
    'the durable candidate now owns the unknown usage until it can reconcile it');
  assert.equal(f.calls.filter(([kind]) => kind === 'run').length, 1, 'recovery does not execute again');
  await f.stop();
  await restarted.close();
});

// The journal entry is kept on a failed settlement, so the next start finds it. An entry that never requested a start ran nothing, so
// the start settles the reservation itself once the removal is recorded. Clearing the entry without that release orphans the reservation.
test('a recovered entry that never requested a start releases its reservation before it clears', {timeout: 90000}, async (t) => {
  const {f, attemptId, reconciled, row} = await recoveryRig(t, {unstarted: true});
  launch(f);
  await until(() => f.saved()?.pending === null, 'the recovered entry is cleared');
  assert.deepEqual(reconciled, [attemptId], 'the backend proved the removal');
  assert.deepEqual(row().resources.map((r) => r.held_micro), [0, 0], 'the unstarted reservation is released, not held');
  await f.stop();
});

test('a recovered claimed-only entry releases its candidate reservation before the claim journal clears', {timeout: 90000}, async (t) => {
  const f = await lenderFixture(t, {policy: {mode: 'auto'}, run: CODEX_RUN});
  f.policy.userActive = async () => false;
  const source = createSyntheticPace50Source({start: f.clock.now()});
  const directory = join(f.root, 'pace50');
  const openRuntime = () => createLendingRuntime({directory, settings: settingsOn, backend: {}, presence: () => false,
    now: () => f.clock.now(), pace50: {account: 'synthetic-account', account_week_id: 'synthetic-week-1', source}});
  let runtime = openRuntime();
  f.policy.lendingRuntime = runtime;
  const attempt = f.attempt();
  const grant = await runtime.candidate.reserve({attemptId: attempt.attempt_id, jobId: f.jobDigest, provider: 'codex',
    model: CODEX_RUN.model, job: f.job.payload, automatic: true, ownerAbsent: true});
  assert.equal(grant.ok, true, JSON.stringify(grant));
  const heldBefore = runtime.pace50.state().attempts.find(row => row.id === attempt.attempt_id).resources.map(row => row.held_micro);
  assert.ok(heldBefore.some(value => value > 0));
  await runtime.close();

  await f.policy.storage.set({day: '2026-10-09', jobs: 1, milliseconds: 0, pending: null, claimedPending: attempt});
  runtime = openRuntime();
  f.policy.lendingRuntime = runtime;
  const releases = [];
  const release = runtime.candidate.release.bind(runtime.candidate);
  runtime.candidate.release = async (...args) => {
    assert.equal(f.saved()?.claimedPending?.attempt_id, attempt.attempt_id, 'the durable claim remains while its reservation is released');
    const outcome = await release(...args);
    releases.push(outcome);
    assert.equal(f.saved()?.claimedPending?.attempt_id, attempt.attempt_id, 'the claim journal is not cleared before release applies');
    return outcome;
  };

  launch(f);
  await until(() => f.saved()?.declinePending === null && f.saved()?.claimedPending === null, 'startup decline clears');
  await f.stop();
  assert.equal(releases.length, 1, 'the recovered claim releases through the candidate');
  assert.equal(releases[0].applied, true, JSON.stringify(releases[0]));
  const row = runtime.pace50.state().attempts.find(attemptRow => attemptRow.id === attempt.attempt_id);
  assert.equal(row.process_state, 'ceased');
  assert.deepEqual(row.resources.map(resource => resource.held_micro), heldBefore.map(() => 0), 'the orphaned hold is released');
  await runtime.close();
});

test('a recovered accepted claim releases its orphaned candidate reservation before decline', {timeout: 90000}, async (t) => {
  const f = await lenderFixture(t, {policy: {mode: 'auto'}, run: CODEX_RUN});
  f.policy.userActive = async () => false;
  const source = createSyntheticPace50Source({start: f.clock.now()});
  const directory = join(f.root, 'pace50');
  const runtime = createLendingRuntime({directory, settings: settingsOn, backend: {}, presence: () => false,
    now: () => f.clock.now(), pace50: {account: 'synthetic-account', account_week_id: 'synthetic-week-1', source}});
  f.policy.lendingRuntime = runtime;
  const attempt = f.attempt();
  const grant = await runtime.candidate.reserve({attemptId: attempt.attempt_id, jobId: f.jobDigest, provider: 'codex',
    model: CODEX_RUN.model, job: f.job.payload, automatic: true, ownerAbsent: true});
  assert.equal(grant.ok, true, JSON.stringify(grant));
  const heldBefore = runtime.pace50.state().attempts.find(row => row.id === attempt.attempt_id).resources.map(row => row.held_micro);
  assert.ok(heldBefore.some(value => value > 0));

  const advertisement = f.backend.lenderCapabilities();
  const intent = {jobDigest: f.jobDigest, advertisement: {harnesses: ['codex'], models: ['example-model'], capabilities: [],
    egress: advertisement.egress, enforced_limits: advertisement.enforced_limits, max_limits: advertisement.max_limits},
    leaseSeconds: 120, idempotencyKey: 'r4-orphaned-accepted-claim', acceptedAt: f.clock.now()};
  await f.policy.storage.set({day: '2026-10-09', jobs: 0, milliseconds: 0, pending: null, declinePending: null,
    claimedPending: attempt, acceptedClaim: {intent, claim: {job_digest: f.jobDigest, job: f.job, attempt, accepted: true}}});

  const releases = [];
  const release = runtime.candidate.release.bind(runtime.candidate);
  runtime.candidate.release = async (...args) => {
    assert.equal(f.saved()?.claimedPending?.attempt_id, attempt.attempt_id, 'the claim journal remains while its reservation is released');
    const outcome = await release(...args);
    releases.push(outcome);
    assert.equal(f.saved()?.claimedPending?.attempt_id, attempt.attempt_id, 'the claim journal is not cleared before release applies');
    return outcome;
  };
  let clearedBeforeRelease = false;
  const storageSet = f.policy.storage.set.bind(f.policy.storage);
  f.policy.storage.set = async (value) => {
    if (f.saved()?.claimedPending?.attempt_id === attempt.attempt_id &&
        value.claimedPending?.attempt_id !== attempt.attempt_id && !releases.some(outcome => outcome.applied === true)) {
      clearedBeforeRelease = true;
    }
    return storageSet(value);
  };
  launch(f);
  try {
    await until(() => f.saved()?.declinePending === null && f.saved()?.claimedPending === null &&
      f.saved()?.acceptedClaim === null, 'orphaned accepted claim recovery clears', 5000);
  } catch (error) {
    throw new Error(`${error.message}; saved=${JSON.stringify(f.saved())}; `+
      `releases=${JSON.stringify(releases)}; events=${JSON.stringify(f.events.map(event => [event.status,event.reason]))}`);
  }
  await f.stop();
  assert.equal(clearedBeforeRelease, false, 'the accepted claim cannot clear its candidate journal before release');
  assert.equal(releases.length, 1);
  assert.equal(releases[0].applied, true, JSON.stringify(releases[0]));
  const row = runtime.pace50.state().attempts.find(attemptRow => attemptRow.id === attempt.attempt_id);
  assert.equal(row.process_state, 'ceased');
  assert.deepEqual(row.resources.map(resource => resource.held_micro), heldBefore.map(() => 0));
  await runtime.close();
});

test('an unapplied release keeps both accepted-claim recovery journals and skips replay', {timeout: 90000}, async (t) => {
  const f = await lenderFixture(t, {policy: {mode: 'auto'}, run: CODEX_RUN});
  f.policy.userActive = async () => false;
  const source = createSyntheticPace50Source({start: f.clock.now()});
  const runtime = createLendingRuntime({directory: join(f.root, 'pace50'), settings: settingsOn, backend: {}, presence: () => false,
    now: () => f.clock.now(), pace50: {account: 'synthetic-account', account_week_id: 'synthetic-week-1', source}});
  f.policy.lendingRuntime = runtime;
  const attempt = f.attempt();
  const grant = await runtime.candidate.reserve({attemptId: attempt.attempt_id, jobId: f.jobDigest, provider: 'codex',
    model: CODEX_RUN.model, job: f.job.payload, automatic: true, ownerAbsent: true});
  assert.equal(grant.ok, true, JSON.stringify(grant));
  const advertisement = f.backend.lenderCapabilities();
  const intent = {jobDigest: f.jobDigest, advertisement: {harnesses: ['codex'], models: ['example-model'], capabilities: [],
    egress: advertisement.egress, enforced_limits: advertisement.enforced_limits, max_limits: advertisement.max_limits},
    leaseSeconds: 120, idempotencyKey: 'unapplied-orphaned-accepted-claim', acceptedAt: f.clock.now()};
  await f.policy.storage.set({day: '2026-10-09', jobs: 0, milliseconds: 0, pending: null, declinePending: null,
    claimedPending: attempt, acceptedClaim: {intent, claim: {job_digest: f.jobDigest, job: f.job, attempt, accepted: true}}});

  const calls = [];
  runtime.candidate.release = async (...args) => {
    calls.push(args);
    return {applied: false, reason: 'simulated_refusal'};
  };
  let replays = 0;
  f.client.claimJob = async () => { replays++; throw new Error('claim replay must wait for reservation release'); };
  launch(f);
  await until(() => calls.length > 0, 'candidate release attempted');
  await f.stop();

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], attempt.attempt_id);
  assert.deepEqual(calls[0][1], {reason: 'restart_interrupted', prepared: false});
  assert.equal(replays, 0);
  assert.equal(f.saved()?.claimedPending?.attempt_id, attempt.attempt_id, 'claimed recovery remains durable on release refusal');
  assert.equal(f.saved()?.acceptedClaim?.claim?.attempt?.attempt_id, attempt.attempt_id, 'accepted recovery remains durable on release refusal');
  assert.equal(f.saved()?.declinePending, null, 'a decline cannot start before release applies');
  await runtime.close();
});

test('the lender retains both journals when candidate settlement resolves unapplied', {timeout: 90000}, async (t) => {
  const f = await lenderFixture(t, {policy: {mode: 'auto'}, run: CODEX_RUN, guardTokens: UNPRICED_METER});
  f.policy.userActive = async () => false;
  const source = createSyntheticPace50Source({start: f.clock.now()});
  const runtime = createLendingRuntime({directory: join(f.root, 'pace50'), settings: settingsOn, backend: {}, presence: () => false,
    now: () => f.clock.now(), pace50: {account: 'synthetic-account', account_week_id: 'synthetic-week-1', source}});
  f.policy.lendingRuntime = runtime;
  const candidate = runtime.candidate;
  let heldBefore;
  const reserve = candidate.reserve.bind(candidate);
  candidate.reserve = async (...args) => {
    const grant = await reserve(...args);
    if (grant.ok) heldBefore = runtime.pace50.state().attempts.find(row => row.id === args[0].attemptId).resources.map(row => row.held_micro);
    return grant;
  };
  let settlement;
  const settle = candidate.settle.bind(candidate);
  candidate.settle = async (...args) => {
    f.clock.advance(-1);
    settlement = await settle(...args);
    return settlement;
  };
  f.backend.prepare = async () => {
    f.calls.push(['prepare']);
    throw Object.assign(new Error('Synthetic prepare failure after confirmed cleanup'),
      {cleanup_receipt: {removed: true, scratch_removed: true}});
  };

  launch(f);
  await until(() => settlement !== undefined, 'candidate settlement returned');
  await f.stop();
  assert.equal(settlement.applied, false);
  assert.equal(settlement.reason, 'event_order', JSON.stringify(settlement));
  assert.ok(f.saved()?.pending, 'the pending journal stays until settlement applies');
  assert.ok(f.saved()?.claimedPending, 'the claim journal stays until settlement applies');
  const row = runtime.pace50.state().attempts.find(attemptRow => attemptRow.id === f.attempt().attempt_id);
  assert.deepEqual(row.resources.map(resource => resource.held_micro), heldBefore, 'the refused settlement keeps the reservation');
  await runtime.close();
});
