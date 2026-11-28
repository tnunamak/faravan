import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {borrowerRunRequest,resolveSelection} from '../lib/v1/run-request.mjs';
import {HOST_CAPABILITIES,RUN_REQUEST_CAPABILITY} from '../lib/v1/versions.mjs';
import {syntheticAccountRunOptions} from './helpers/v1-lender-fixture.mjs';
import {checkNewJob} from '../lib/protocol/index.mjs';
import {createLender} from '../lib/v1/lender.mjs';
import {classify, isPassingDecline, passingDeclineCode} from '../lib/v1/failures.mjs';
import {jobStatusContract} from '../lib/v1/status-contract.mjs';
import {DockerSbxBackend} from '../lib/docker-backend.mjs';
import {resolveHarness} from '../lib/executor.mjs';

const CLEANUP_WAIT = 'Nobody can take it right now · 1 computer is waiting for cleanup.';
const CLEANUP_HISTORY = "The last try waited for the lender's computer to clean up. The lender's current status is unavailable.";
const LENDER = 'Waiting for cleanup of sandboxes from last time…';
const DIGEST = 'sha256:' + 'a'.repeat(64);
const GOLDEN=JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json',import.meta.url))).objects.job.envelope.payload;
const AUTHOR = 'sha256:' + 'b'.repeat(64);
const PREPARATION_MS = 1000;
const clone = value => structuredClone(value);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
};
async function drain() {for (let n = 0; n < 250; n++) await Promise.resolve();}
function fakeClock() {
  let time = Date.parse('2026-11-09T00:00:00Z'), id = 0;
  const timers = new Map();
  return {
    now: () => time,
    monotonic: () => time,
    setTimeout(fn, delay) {const key = ++id; timers.set(key, {fn, at: time + delay}); return key;},
    clearTimeout(key) {timers.delete(key);},
    async advance(ms) {
      const end = time + ms;
      for (let turns = 0; ; turns++) {
        assert.ok(turns < 10000, 'fake clock did not become idle');
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        time = next[1].at; timers.delete(next[0]); next[1].fn(); await drain();
      }
      time = end; await drain();
    },
  };
}

// Real createLender; only transport, storage, clock, provider allowance and backend are fakes.
// resolveHarness reads the bundled harness definition. No credentials, provider or sandbox call is made.
function fixture({accepted = false, cleanup = true, recoveryAtSend = false} = {}) {
  const clock = fakeClock(), controller = new AbortController(), pending = deferred();
  const events = [], releases = [], claims = [], deliveries = [], saved = [];
  let counters = null, inFlight = false, admissions = 0, capabilities = 0, prepares = 0, starts = 0, approvals = 0, loopError;
  const spec = {...resolveHarness('codex'), auth_strategy: 'host-env-proxy', credential_in_guest: false};
  const limits = {wall_seconds: 60, cpu: 1, memory_bytes: 512 * 1048576, disk_bytes: 512 * 1048576, output_bytes: 16384};
  const job = {...clone(GOLDEN),circle:GOLDEN.circle,author:AUTHOR,created_at:new Date(clock.now()-1000).toISOString().replace('.000Z','Z'),runRequest:borrowerRunRequest({harness:'codex'}),result:{kind:'message'},expires_at: new Date(clock.now() + 86400000).toISOString().replace('.000Z','Z'),
    prompt: {digest: 'sha256:' + 'c'.repeat(64), media_type: 'text/plain', bytes: 7},
    source: {kind: 'none'}, requirements: {harness: [spec.harness_id], capabilities: ['results_v1',RUN_REQUEST_CAPABILITY], egress: 'provider-only', limits}};
  assert.deepEqual(checkNewJob(job),{ok:true},'cleanup fixture submits a current complete job');
  const report = {available: true, enforced_limits: Object.keys(limits),
    max_limits: {...limits, wall_seconds: 3600}, capabilities: [], egress: ['provider-only']};
  const runOptions=syntheticAccountRunOptions(),accounts=runOptions.runAccounts();
  // A durable already-approved intent exercises the real claimJob accepted branch.
  if (accepted) counters = {day: '2026-11-09', jobs: 0, milliseconds: 0, pending: null, claimPending: {
    state: 'created-unsent', jobDigest: DIGEST, job: {payload: clone(job)}, acceptedAt: clock.now(),
    wallSeconds: limits.wall_seconds, leaseSeconds: 120, idempotencyKey: 'cleanup-approved',
    advertisement: {accounts,harnesses: [spec.harness_id], models: [], capabilities: ['results_v1',RUN_REQUEST_CAPABILITY],
      egress: report.egress, enforced_limits: report.enforced_limits, max_limits: report.max_limits}}};
  const backend = {
    deadlineRecoveryPending: () => inFlight,
    async lenderCapabilities() {
      capabilities++;
      // Discovery passed, but recovery starts while the final fresh pre-send check is awaiting.
      if (recoveryAtSend && capabilities === 2) inFlight = true;
      return clone(report);
    },
    admitJob() {
      admissions++;
      if (admissions === 1) {inFlight = cleanup; return pending.promise;}
      return Promise.resolve({ok: false, code: 'policy_unenforceable'});
    },
    async prepare() {prepares++; throw new Error('the fixture must never create a sandbox');},
    async start() {starts++; throw new Error('the fixture must never launch an agent');},
  };
  const client = {
    async capabilities(){return {capabilities:[...HOST_CAPABILITIES]};},
    async claimJob(digest, advertisement, options) {
      assert.equal(digest, DIGEST); return client.claimNext(advertisement, options);
    },
    async claimNext(advertisement, options) {
      claims.push({at: clock.now(), recovery: inFlight, exclude: clone(options.exclude ?? [])});
      if (options.exclude?.includes(DIGEST) || deliveries.length >= 2) return null;
      const attempt = {attempt_id: 'cleanup-' + (deliveries.length + 1), job_digest: DIGEST,
        generation: deliveries.length + 1, state: 'active', execution_started_at: null,
        lease_expires_at: new Date(clock.now() + 120000).toISOString()};
      attempt.selection=resolveSelection({runRequest:job.runRequest,accounts:advertisement.accounts}).value;
      const claim = {job_digest:DIGEST,job:{payload:clone(job)},attempt,selection:attempt.selection};
      deliveries.push(clone(claim)); return claim;
    },
    async fetchArtifact() {return Buffer.from('Do work');},
    async renew(attempt) {return {...attempt, state: 'active', lease_expires_at: new Date(clock.now() + 120000).toISOString()};},
    async release(attempt, reason) {releases.push({attempt: clone(attempt), reason, code: JSON.parse(reason).code}); return {applied: true};},
    async stopped() {return {applied: true};},
    async getJob() {return {job_digest: DIGEST, state: 'queued', current_attempt: releases.length
      ? {...releases.at(-1).attempt, state: 'released', reason: releases.at(-1).reason} : null};},
  };
  const storage = {
    async get() {return clone(counters);},
    async set(value) {counters = clone(value); saved.push(clone(value));},
  };
  const candidate = {
    registry: {bind() {}, unbind() {}},
    async gate() {return null;},
    async reserve() {return {ok: true, reservation: {provider: 'codex', model: 'fixture'}};},
    async settle() {return {applied: true};},
  };
  const lender = createLender({...runOptions,client, backend, clock, adapters: [{spec, installed: true, signedIn: true, models: []}],
    policy: {storage, enabled: true, mode: 'ask', timeZone: 'UTC', pollMs: 100,
      preparationTimeoutMs: PREPARATION_MS, lendingRuntime: {candidate}},
    approve: async () => {approvals++; return true;}, credentialValues: async () => [],
    onEvent: event => events.push(event)});
  const loop = lender.start(controller.signal).catch(error => {loopError = error;});
  const until = async (predicate, message) => {
    for (let n = 0; n < 20 && !predicate() && !loopError; n++) await drain();
    if (loopError) throw loopError;
    assert.ok(predicate(), message);
  };
  return {clock, lender, job, events, releases, claims, deliveries, saved, until,
    get counters() {return clone(counters);},
    get admissions() {return admissions;},
    get approvals() {return approvals;},
    get launches() {return prepares + starts;},
    async ready() {await until(() => admissions === 1, 'fixture must reach actual backend admission');},
    finishRecovery() {inFlight = false; if (admissions > 0) pending.resolve({ok: true});},
    rejectLateAdmission() {pending.reject(Object.assign(new Error('private cleanup detail'), {code: 'internal_error'}));},
    async close() {
      controller.abort(); inFlight = false; pending.resolve({ok: false, code: 'policy_unenforceable'});
      await drain(); await loop;
      if (loopError) throw loopError;
    },
  };
}

test('backend exposes only whether the shared deadline recovery is in flight', () => {
  const backend = Object.create(DockerSbxBackend.prototype);
  assert.equal(backend.deadlineRecoveryPending(), false);
  backend._deadlineRecovery = Promise.resolve([]);
  assert.equal(backend.deadlineRecoveryPending(), true);
  backend._deadlineRecovery = null;
  assert.equal(backend.deadlineRecoveryPending(), false);
});

test('cleanup_pending is a lender setup requeue and a passing decline', () => {
  const result = classify('cleanup_pending', 'prepare', DIGEST);
  assert.equal(result.owner, 'lender');
  assert.equal(result.outcome, 'requeue');
  assert.deepEqual(result.counts, {job: false, minutes: 'none'});
  assert.equal(result.borrower_key, 'failure.lender_setup.borrower');
  assert.equal(isPassingDecline('cleanup_pending'), true);
  assert.equal(passingDeclineCode({state: 'released', execution_started_at: null, reason: '{"code":"cleanup_pending"}'}), 'cleanup_pending');
});

for (const accepted of [false, true]) {
  test('timer reports cleanup_pending before recovery finishes: accepted=' + accepted, async t => {
    const f = fixture({accepted}); t.after(() => f.close()); await f.ready();
    await f.clock.advance(PREPARATION_MS);
    await f.until(() => f.releases.length === 1, 'the timer must release the job without waiting for recovery');
    assert.equal(f.releases[0].code, 'cleanup_pending');
    assert.deepEqual(JSON.parse(f.releases[0].reason), {code:'cleanup_pending',until:Math.min(Date.parse(f.job.expires_at),f.clock.now()+120000)});
    assert.equal(f.launches, 0);
  });

  test('cleanup-held job can be claimed again after recovery: accepted=' + accepted, async t => {
    const f = fixture({accepted}); t.after(() => f.close()); await f.ready();
    await f.clock.advance(PREPARATION_MS);
    await f.until(() => f.releases.length === 1 && f.lender.snapshot.current === null, 'the first job must be released');
    const expiry = Date.parse(f.job.expires_at);
    if (accepted) {
      assert.ok(f.counters.jobConsents?.some(row=>row.jobDigest===DIGEST&&!row.revoked),'the job approval must be kept');
    }
    for (const row of [...(f.counters.declined ?? []), ...(f.counters.hiddenOffers ?? [])])
      if (row.jobDigest === DIGEST) assert.ok(row.expiresAt < expiry, 'cleanup must not hide the job until its expiry');
    const sends = f.claims.length;
    await f.clock.advance(10000);
    assert.equal(f.claims.length, sends, 'no new transport calls while recovery remains in flight');
    assert.equal(f.lender.admits(f.job), 'cleanup_pending');
    f.finishRecovery(); await f.clock.advance(100);
    await f.until(() => f.deliveries.length === 2, 'the same job must be eligible after recovery');
    assert.ok(f.claims.every(call => call.recovery === false));
    assert.equal(f.claims.filter(call=>!call.exclude.includes(DIGEST)).length,2,'only the original claim and the claim after recovery take the job');
    if (accepted) assert.equal(f.approvals, 0, 'cleanup must not require approval again');
    assert.equal(f.launches, 0, 'late completion of the old admission must never launch');
  });

  test('unrelated preparation timer preserves old behavior: accepted=' + accepted, async t => {
    const f = fixture({accepted, cleanup: false}); t.after(() => f.close()); await f.ready();
    await f.clock.advance(PREPARATION_MS);
    // The old branch also reaches its abort handler when the unrelated admission resolves.
    f.finishRecovery(); await drain();
    await f.until(() => f.releases.length > 0 && f.lender.snapshot.current === null, 'ordinary timeout must settle');
    // The timeout keeps its reason and takes the bounded decline path, so the hidden row ends with the lender's readiness epoch.
    assert.equal(f.releases[0].code,'cleanup_pending');
    assert.ok(f.counters.declined.some(row=>row.jobDigest===DIGEST&&row.epoch!==undefined&&row.expiresAt<Date.parse(f.job.expires_at)));
    assert.ok(f.events.some(event=>event.reason==='cleanup_pending'&&event.until>f.clock.now()));
  });
}

test('preparation row explains the shared recovery wait', async t => {
  const f = fixture(); t.after(() => f.close()); await f.ready();
  assert.ok(f.events.some(event => event.status === 'preparing' && event.label === LENDER));
  assert.equal(f.lender.snapshot.label, LENDER);
});

test('fresh pre-send check blocks recovery that started after discovery', async t => {
  const f = fixture({recoveryAtSend: true}); t.after(() => f.close());
  await drain();
  assert.equal(f.claims.length, 0);
  assert.equal(f.lender.admits(f.job), 'cleanup_pending');
  f.finishRecovery(); await f.clock.advance(100);
  await f.until(() => f.claims.length === 1, 'the parked claim must resume when cleanup finishes');
});

test('late admission rejection is consumed without another release or launch', async t => {
  const f = fixture(); t.after(() => f.close()); await f.ready();
  await f.clock.advance(PREPARATION_MS);
  await f.until(() => f.releases.length === 1, 'the timer must release first');
  f.rejectLateAdmission(); await drain();
  assert.equal(f.releases.length, 1);
  assert.equal(f.launches, 0);
});

test('borrower sees fixed cleanup history for an unstarted release without current presence', () => {
  const NOW = Date.parse('2026-11-09T12:00:00Z');
  const view = {state: 'queued', job_digest: DIGEST, current_attempt: {state: 'released', holder: 'lender-a',
    execution_started_at: null, reason: '{"code":"cleanup_pending","detail":"/private/path person@example.test"}'}};
  const read = v => jobStatusContract(v, {now: NOW}).explanation;
  assert.equal(read(view), CLEANUP_HISTORY);
  assert.doesNotMatch(read(view), /private|example/);
  for (const changed of [
    {...view, current_attempt: {...view.current_attempt, execution_started_at: '2026-11-09T00:00:00Z'}},
    {...view, current_attempt: {...view.current_attempt, reason: '{"code":"preparation_timeout"}'}},
  ]) assert.notEqual(read(changed), CLEANUP_HISTORY);
  const ordinary = {...view, current_attempt: {...view.current_attempt, reason: '{"code":"sandbox_not_ready"}'}};
  assert.equal(read(ordinary),
    'A computer could not start this job yet. Waiting for it to be ready to try again. Another computer may still take it.');
});

test('borrower sees current lender facts over an old cleanup release', () => {
  const NOW = Date.parse('2026-11-09T12:00:00Z');
  const view = {state: 'queued', job_digest: DIGEST, current_attempt: {state: 'released', holder: 'lender-a',
    execution_started_at: null, reason: '{"code":"cleanup_pending"}'}};
  const lender = (over) => ({device: 'lender-a', online: true, source: 'heartbeat', personName: 'Ada',
    last_heartbeat_at: new Date(NOW - 5000).toISOString(), intent: {state: 'ready'}, ...over});
  const read = (devices, over = {}) => jobStatusContract({...view, ...over, presence: {devices}}, {now: NOW}).explanation;
  assert.equal(read([lender({intent: {state: 'blocked', reason: 'cleanup_pending'}})]), CLEANUP_WAIT);
  assert.match(read([lender()]), /1 computer is ready/, 'a new ready report supersedes the old cleanup release');
  assert.match(read([lender({online: false})]), /Ada hasn't checked in/, 'an offline lender wins over the old release');
  assert.match(read([lender({last_heartbeat_at: new Date(NOW - 120000).toISOString()})]), /Ada hasn't checked in/,
    'a stale report wins over the old release');
  const paused = read([lender({intent: {state: 'off'}})]);
  assert.notEqual(paused, CLEANUP_WAIT);
  assert.match(paused, /Ada isn't lending/);
  assert.equal(read([lender()], {state: 'expired'}), 'The deadline passed.', 'an expired job shows the deadline line');
  assert.equal(read([lender({online: false})], {state: 'expired'}), 'The deadline passed.');
});

test('after cleanup a ready lender still needs the right agent and enough time', () => {
  const NOW = Date.parse('2026-11-09T12:00:00Z');
  const view = {state: 'queued', job_digest: DIGEST, current_attempt: {state: 'released', holder: 'lender-a',
    execution_started_at: null, reason: '{"code":"cleanup_pending"}'},
    job: {payload: {requirements: {harness: ['claude'], limits: {wall_seconds: 120}}}}};
  const lender = over => ({device: 'lender-a', online: true, source: 'heartbeat', personName: 'Ada',
    last_heartbeat_at: new Date(NOW - 5000).toISOString(), intent: {state: 'ready'}, ...over});
  const read = devices => jobStatusContract({...view, presence: {devices}}, {now: NOW}).explanation;
  assert.match(read([lender({budget: {minutes_left_today: 60}})]), /1 computer is ready/);
  const short = read([lender({budget: {minutes_left_today: 1}})]);
  assert.notEqual(short, CLEANUP_WAIT, 'one minute left cannot fit a 120 second job');
  assert.match(short, /Nobody can take it right now.*Ada is done for today/);
  const wrongAgent = read([lender({agents: [{adapter: 'codex', readiness: 'ready'}]})]);
  assert.notEqual(wrongAgent, CLEANUP_WAIT, 'a lender without the job agent cannot start it after cleanup');
  assert.match(wrongAgent, /doesn't lend the agent this job needs/);
});

test('a busy releasing lender is not promised to start the job after cleanup', () => {
  const NOW = Date.parse('2026-11-09T12:00:00Z');
  const view = {state: 'queued', job_digest: DIGEST, current_attempt: {state: 'released', holder: 'lender-a',
    execution_started_at: null, reason: '{"code":"cleanup_pending"}'},
    job: {payload: {requirements: {harness: ['claude'], limits: {wall_seconds: 120}}}}};
  const lender = over => ({device: 'lender-a', online: true, source: 'heartbeat', personName: 'Ada',
    last_heartbeat_at: new Date(NOW - 5000).toISOString(), intent: {state: 'ready'}, ...over});
  const read = device => jobStatusContract({...view, presence: {devices: [device]}}, {now: NOW}).explanation;
  const running = read(lender({execution: {state: 'running'}, budget: {minutes_left_today: 1}}));
  assert.notEqual(running, CLEANUP_WAIT, 'a running lender with one minute left cannot fit a 120 second job');
  assert.match(running, /answering another job/);
  const finishing = read(lender({execution: {state: 'finishing'}, agents: [{adapter: 'codex', readiness: 'ready'}]}));
  assert.notEqual(finishing, CLEANUP_WAIT, 'a finishing lender without the job agent cannot start it');
  assert.match(finishing, /answering another job/);
});

test('without presence a cleanup release is history, not current fact', () => {
  const NOW = Date.parse('2026-11-09T12:00:00Z');
  const view = {state: 'queued', job_digest: DIGEST, current_attempt: {state: 'released', holder: 'lender-a',
    execution_started_at: null, reason: '{"code":"cleanup_pending"}'}};
  assert.equal(jobStatusContract(view, {now: NOW}).explanation, CLEANUP_HISTORY);
  assert.equal(jobStatusContract({...view, presence: {}}, {now: NOW}).explanation, CLEANUP_HISTORY);
  assert.doesNotMatch(CLEANUP_HISTORY, /attempt|settled|lease|—/);
  assert.equal(jobStatusContract({...view, state: 'expired'}, {now: NOW}).explanation, 'The deadline passed.',
    'an expired job still shows the deadline line');
});
