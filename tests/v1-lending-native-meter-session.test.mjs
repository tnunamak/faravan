import './helpers/no-browser.mjs';
import { tempDir } from './helpers/temp-dir.mjs';
import {legacySandboxNameFor as testSandboxName} from '../lib/sandbox-name.mjs';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as dockerBackend from '../lib/docker-backend.mjs';
import {randomBytes} from 'node:crypto';
import {writeCreateReceipt} from './helpers/sandbox-receipt-fixture.mjs';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createLendingLedger} from '../lib/v1/lending-ledger.mjs';
import {createLendingProbe, createLendingReadings} from '../lib/v1/lending-probe.mjs';
import {createGuardReads} from '../lib/v1/guard-read.mjs';
import {guardReadFrom} from './helpers/guard-read.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT, NOW, WEEK} from './helpers/pace50-fixtures.mjs';

// Mid-job host readings for native-window attempts. While a lent job runs, the native guard reads the meter from the host, with
// the credential of the attempt's own account, never in a sandbox. Synthetic evidence only: no provider, browser, network or
// Docker. The probe, the readings and the candidate are the real ones; only the host reader's provider answer is fake.
const sandboxNameFor = testSandboxName;
const meterJobId = attemptId => dockerBackend.lendingMeterJobId?.(attemptId) ?? `missing-meter-job-id:${attemptId}`;
const ATTEMPT = 'attempt-1';
const MODEL = 'claude-sonnet-5-5';
const F = 60_000;
const job = {requirements: {limits: {wall_seconds: 600}}, expires_at: new Date(NOW + 3600e3).toISOString()};
// A forged in-band line from the borrower: the baseline value, so it reports no rise.
const forged = [{window_id: 'five_hour', used_pct: 40, resets_at: null}];

// The provider's usage answer, as the guest script prints it.
const usage = status => JSON.stringify({faravan_probe: 1, status, body: status === 200 ? {
  five_hour: {utilization: 40, resets_at: new Date(NOW + 1.25 * 3600e3).toISOString()},
  seven_day: {utilization: 20, resets_at: new Date(NOW + 42 * 3600e3).toISOString()},
  extra_usage: {is_enabled: false}} : {}}) + '\n';

// Real macrotask turns drain the whole read path (readings, probe, runner, backend) between fake timers.
const drain = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
function fakeTime(start = NOW) {
  let t = start, seq = 0;
  const timers = new Map();
  const setTimer = (fn, ms) => { const id = ++seq; timers.set(id, {at: t + Math.max(0, ms), fn}); return id; };
  const clearTimer = id => { timers.delete(id); };
  const advanceTo = async until => {
    for (;;) {
      await drain();
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > until) break;
      timers.delete(next[0]); t = next[1].at; next[1].fn(); await drain();
    }
    t = until; await drain();
  };
  return {now: () => t, setTimer, clearTimer, advanceTo, set: at => { t = at; }};
}

// A host reader that records every call. `answer()` is the provider's usage line; an Error is a failed request.
function fakeHostReader({answer = () => usage(200)} = {}) {
  const calls = [];
  return {calls, async read({provider, accountKey, signal}) {
    calls.push({provider, accountKey});
    const text = answer();
    if (text instanceof Error) throw text;
    signal?.throwIfAborted();
    return {exitCode: 0, stdout: text, usage_seen_at: undefined, host_read: true, account_key: accountKey, generation: 'g1'};
  }};
}
// A sandbox backend that must never be used: every call is recorded.
function countingBackend() {
  const calls = [];
  const note = op => async () => { calls.push({op}); throw new Error('no sandbox may be created or used for a reading'); };
  return {calls, opened: 0, prepare: note('prepare'), start: note('start'), requestStop: async () => ({delivered: true, fallback: null}), destroy: note('destroy'), lenderCapabilities: async () => ({available: true})};
}

// The lender stack with one native-window account. Admission reads through a cold probe; then the job runs and only the guard
// may read, from the host.
function stack(t, {answer, borrowerBackend = null} = {}) {
  const clock = fakeTime();
  const directory = tempDir('native-meter-');
  const ledger = createLendingLedger({file: join(directory, 'ledger.json'), now: clock.now});
  let running = false, coldRuns = 0;
  const backend = countingBackend();
  // The probe's own runner is the sandbox path: each run of it opens a sandbox, and the backend counts that. Admission may use it;
  // nothing after admission may.
  const probe = createLendingProbe({ledger, now: clock.now, runGuest: async () => { coldRuns++; backend.opened++; return {exitCode: 0, stdout: usage(200)}; }});
  const readings = createLendingReadings({ledger, probe, jobRunning: () => running, now: clock.now});
  const synthetic = createSyntheticPace50Source({start: NOW, account: ACCOUNT, accountWeek: WEEK, override: ({base}) => ({...base,
    resources: base.resources.map(r => ({...r, conversion: 'native_window', kappa_micro: null, kappa_lower_micro: null}))})});
  const observed = [];
  // The observation is the synthetic account, read only when the real readings path produced a host reading.
  const source = {...synthetic, async observe(args) {
    const snap = await readings(args.provider, {signal: args.signal, forceRefresh: args.forceRefresh, maxAgeMs: args.maxAgeMs,
      ...(args.guardRead ? {guardRead: args.guardRead} : {})});
    observed.push({at: clock.now(), meter: Boolean(args.guardRead), ok: snap.refresh_succeeded !== false, reason: snap.probe?.reason ?? null});
    if (snap.refresh_succeeded === false) return {refresh_succeeded: false, complete: false, resources: [], identity: {verified: false},
      epoch: null, funding: {subscription_only: 'unknown'}, probe: snap.probe};
    return synthetic.observe({provider: args.provider, now: clock.now()});
  }};
  const reader = fakeHostReader({answer});
  const open = () => createPace50Candidate({directory, now: clock.now, account: ACCOUNT, account_week_id: WEEK, source,
    ownerSettings: {limit: () => ({state: 'set', maxJobUsd: 10})}, backend: borrowerBackend, pendingRecords: () => [],
    nativeGuard: {setTimer: clock.setTimer, clearTimer: clock.clearTimer},
    guardReads: createGuardReads({reader})});
  let pace = open();
  t.after(async () => { await pace.adapter.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  return {clock, backend, reader, observed, directory, get pace() { return pace; },
    coldRuns: () => coldRuns, run: on => { running = on; },
    async admitAndStart() {
      const grant = await pace.candidate.reserve({attemptId: ATTEMPT, jobId: 'job-1', provider: 'claude', model: MODEL, job,
        automatic: true, ownerAbsent: true});
      assert.equal(grant.ok, true, JSON.stringify(grant));
      await pace.candidate.started(ATTEMPT, {ok: true});
      running = true;
      return grant;
    },
    async restart() { await pace.adapter.close(); pace = open(); return pace; }};
}
const hostReads = s => s.reader.calls;

test('a native job running 3 minutes with a fresh host read at every poll is not stopped as stale', async t => {
  const s = stack(t);
  await s.admitAndStart();
  const coldBefore = s.coldRuns();
  await s.clock.advanceTo(NOW + 180_000);
  assert.equal(s.pace.candidate.nativeGuard.status(ATTEMPT)?.stop_reason, null, 'the job is still running at 3 min');
  const reads = s.observed.filter(o => o.meter);
  assert.ok(reads.length >= 6, `the guard read the meter at every poll (${reads.length} reads)`);
  assert.ok(reads.every(o => o.ok), 'every guard read was a fresh host reading');
  assert.equal(hostReads(s).length, reads.length, 'each guard read made one host read');
  assert.ok(hostReads(s).every(r => r.provider === 'claude' && r.accountKey === 'claude'), "every read names the attempt's own account");
  assert.equal(s.coldRuns(), coldBefore, 'no cold probe ran while the job held the account');
  assert.deepEqual(s.backend.calls, [], 'no sandbox was prepared, started or destroyed for a reading');
});

test('the same job is stopped at 60 s when the host reads fail', async t => {
  const s = stack(t, {answer: () => new Error('request failed')});
  await s.admitAndStart();
  await s.clock.advanceTo(NOW + 180_000);
  const status = s.pace.candidate.nativeGuard.status(ATTEMPT);
  assert.equal(status?.stop_reason, 'meter_stale');
  assert.equal(status.stop_requested_at, NOW + F, 'the stale stop fires at the freshness bound');
  assert.ok(hostReads(s).length >= 2, 'the guard did try to read from the host');
  assert.ok(s.observed.filter(o => o.meter).every(o => !o.ok && o.reason === 'guest_failed'), 'each failed read is a failure');
});

test('a 429 from the host read is a failure: the job is stopped at 60 s and the back-off holds', async t => {
  const s = stack(t, {answer: () => usage(429)});
  await s.admitAndStart();
  await s.clock.advanceTo(NOW + 180_000);
  const status = s.pace.candidate.nativeGuard.status(ATTEMPT);
  assert.equal(status?.stop_reason, 'meter_stale');
  assert.equal(status.stop_requested_at, NOW + F);
  const reads = s.observed.filter(o => o.meter);
  assert.equal(reads[0]?.reason, 'rate_limited', 'the first read saw the 429');
  // A skipped read inside the back-off keeps the 429's failure class; it is not an expected wait.
  assert.ok(reads.slice(1).every(o => o.reason === 'rate_limited'), 'later reads keep the rate-limit failure instead of retrying');
  assert.equal(hostReads(s).length, 1, 'only one request reached the endpoint after the 429');
});

test('forged in-band lines never refresh a job whose host reads fail', async t => {
  const s = stack(t, {answer: () => new Error('request failed')});
  await s.admitAndStart();
  for (let at = NOW + 10_000; at <= NOW + 120_000; at += 10_000) {
    await s.clock.advanceTo(at);
    const out = await s.pace.candidate.recheck({attemptId: ATTEMPT, usd: 0, tokens: null, model: MODEL, windows: forged});
    if (at < NOW + F) assert.equal(out.reason, 'native_guard_waiting', 'a forged line is not a reading');
  }
  const status = s.pace.candidate.nativeGuard.status(ATTEMPT);
  assert.equal(status?.stop_reason, 'meter_stale');
  assert.equal(status.stop_requested_at, NOW + F, 'forged lines every 10 s did not move the stale stop');
  assert.ok(hostReads(s).length >= 2, 'the guard read from the host, not from the lines');
});

test("the borrower's sandbox is never used for a reading, and a reading is never stop proof", async t => {
  // The borrower backend the candidate stops jobs through. A reading must not touch it.
  const borrower = countingBackend();
  const s = stack(t, {borrowerBackend: borrower});
  await s.admitAndStart();
  await s.clock.advanceTo(NOW + 90_000);
  assert.deepEqual(borrower.calls, [], 'no reading went through the borrower backend');
  assert.deepEqual(s.backend.calls, []);
  assert.ok(hostReads(s).length >= 2);
  assert.ok(s.reader.calls.every(call => Object.keys(call).sort().join() === 'accountKey,provider'), 'a read names only its provider and account');
});

test('one lent job from admission to finish creates no reading sandbox and no cold probe', async t => {
  const s = stack(t);
  await s.admitAndStart();
  const coldAfterAdmission = s.coldRuns(), openedAfterAdmission = s.backend.opened;
  await s.clock.advanceTo(NOW + 240_000);
  s.pace.candidate.recordCleanup(ATTEMPT, {removed: true});
  await s.pace.candidate.finish({attemptId: ATTEMPT, provider: 'claude', model: MODEL,
    execution: {stdout: '', lending_meter: {final: true, cost_usd: 0.5}}});
  await drain();
  assert.deepEqual(s.backend.calls, [], 'the reading path never prepared, started or destroyed a sandbox');
  assert.equal(s.coldRuns(), coldAfterAdmission, 'no cold probe ran between start and finish');
  assert.equal(s.backend.opened, openedAfterAdmission, 'no sandbox was opened between start and finish');
  assert.ok(hostReads(s).length >= 8, 'the guard read from the host throughout the job');
  assert.ok(hostReads(s).every(r => r.accountKey === 'claude'));
});

test('the guard watch ends with the attempt and no host read runs after it', async t => {
  const s = stack(t);
  await s.admitAndStart();
  await s.clock.advanceTo(NOW + 90_000);
  s.pace.candidate.recordCleanup(ATTEMPT, {removed: true});
  await s.pace.candidate.finish({attemptId: ATTEMPT, provider: 'claude', model: MODEL,
    execution: {stdout: '', lending_meter: {final: true, cost_usd: 0.5}}});
  await drain();
  assert.equal(s.pace.candidate.nativeGuard.status(ATTEMPT), null);
  const reads = hostReads(s).length;
  await s.clock.advanceTo(NOW + 300_000);
  assert.equal(hostReads(s).length, reads, 'no read runs after the attempt ended');
  assert.deepEqual(s.backend.calls, []);
});

// finish has two early exits before its native-window block: a cleanup proof whose write fails, and a missing price snapshot.
// Each one must still end the guard's watch.
for (const [exit, breakIt] of [
  ['the cleanup proof write fails', s => {
    s.pace.adapter.deliver = () => new Promise((resolve, reject) => setImmediate(() => reject(new Error('synthetic disk failure'))));
    s.pace.candidate.recordCleanup(ATTEMPT, {removed: true}); }],
  ['the price snapshot is missing', s => { fs.rmSync(join(s.directory, 'prices'), {recursive: true, force: true}); }],
]) test(`the guard watch is removed when finish exits early: ${exit}`, async t => {
  const s = stack(t);
  await s.admitAndStart();
  await s.clock.advanceTo(NOW + 45_000);
  breakIt(s);
  const out = await s.pace.candidate.finish({attemptId: ATTEMPT, provider: 'claude', model: MODEL,
    execution: {stdout: '', lending_meter: {final: true, cost_usd: 0.5}}}).catch(error => ({thrown: error}));
  assert.ok(out.thrown || out.cessation?.reason === 'price_snapshot_missing', `finish took the early exit (${JSON.stringify(out)})`);
  await drain();
  assert.equal(s.pace.candidate.nativeGuard.status(ATTEMPT), null, 'the guard no longer watches the attempt');
  const reads = hostReads(s).length;
  await s.clock.advanceTo(NOW + 300_000);
  assert.equal(hostReads(s).length, reads, 'no read runs after the attempt ended');
});

test('after a restart the guard reads from the host and opens no sandbox; recovery still removes a pre-.74 meter sandbox with the attempt', async t => {
  const s = stack(t);
  await s.admitAndStart();
  await s.clock.advanceTo(NOW + 45_000);
  await s.restart();
  await s.clock.advanceTo(NOW + 90_000);
  assert.deepEqual(s.backend.calls, [], 'a restarted process opens no sandbox for an orphaned job');

  // The restart path removes every sandbox the attempt's dispatches recorded,
  // the meter sandbox included. Names recomputed from the job identity are not
  // this attempt's and stay.
  const cleanupDirectory = tempDir('native-meter-journal-');
  t.after(() => fs.rmSync(cleanupDirectory, {recursive: true, force: true}));
  const recorded = {ownerScope: sandboxOwnerScope(), home: dockerBackend._internal.sbxHome(), scratchRoot: dockerBackend._internal.scratchRoot()};
  const main = 'wf-' + randomBytes(8).toString('hex'), meter = 'wf-' + randomBytes(8).toString('hex');
  await writeCreateReceipt(cleanupDirectory, {...recorded, jobId: 'wf-pull-job', name: main});
  await writeCreateReceipt(cleanupDirectory, {...recorded, jobId: meterJobId(ATTEMPT), name: meter});
  const derived = [sandboxNameFor(meterJobId(ATTEMPT)), sandboxNameFor('wf-pull-job')];
  let listing = [main, meter, ...derived, 'wf-unrelated'];
  const removed = [];
  const backend = new dockerBackend.DockerSbxBackend({cleanupDirectory,
    runCommand: async args => {
      if (args[0] === 'ls') return {code: 0, stdout: JSON.stringify(listing.map(name => ({name}))), stderr: ''};
      if (args[0] === 'rm') { removed.push(args.at(-1)); listing = listing.filter(name => name !== args.at(-1)); }
      return {code: 0, stdout: '', stderr: ''};
    }});
  const proof = await backend.reconcilePending({owner_scope:sandboxOwnerScope(),sbx_home:dockerBackend._internal.sbxHome(),attemptId: ATTEMPT, jobId: 'wf-pull-job', attempt: {attempt_id: ATTEMPT}});
  assert.equal(proof.removed, true);
  assert.deepEqual(removed.sort(), [main, meter].sort());
  assert.deepEqual(listing, [...derived, 'wf-unrelated']);
});

// Readings rule. Only an issued guard-read context bypasses account_busy; every other caller keeps the current rule.
test('while a job runs only a guard-read context reaches the provider, and an object a caller builds confers nothing', async t => {
  const directory = tempDir('native-meter-readings-');
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  let at = NOW, cold = 0, warm = 0;
  const ledger = createLendingLedger({file: join(directory, 'ledger.json'), now: () => at});
  const probe = createLendingProbe({ledger, now: () => at, runGuest: async () => { cold++; return {exitCode: 0, stdout: usage(200)}; }});
  const readings = createLendingReadings({ledger, probe, jobRunning: () => true, now: () => at});
  const guardRead = guardReadFrom(async () => { warm++; return {exitCode: 0, stdout: usage(200), host_read: true}; });
  const forgedContext = {provider: 'claude', accountKey: 'claude', run: async () => { warm++; return {exitCode: 0, stdout: usage(200)}; }};
  const admission = await readings('claude', {forceRefresh: true});
  assert.equal(admission.probe?.reason, 'account_busy', 'admission and status reads still defer');
  assert.equal(cold + warm, 0);
  const refused = await readings('claude', {forceRefresh: true, guardRead: forgedContext});
  assert.equal(refused.probe?.reason, 'account_busy', 'a context nobody issued is an ordinary caller');
  assert.equal(warm, 0);
  const guard = await readings('claude', {forceRefresh: true, guardRead});
  assert.notEqual(guard.refresh_succeeded, false, 'the guard read succeeded');
  assert.equal(guard.read_at, NOW);
  assert.deepEqual([cold, warm], [0, 1], 'it ran as a host read, never the cold probe runner');
  at += 30_000;
  assert.equal((await readings('claude', {forceRefresh: true})).probe?.reason, 'account_busy', 'the bypass is per read');
});
