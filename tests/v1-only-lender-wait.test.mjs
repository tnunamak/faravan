import {giveBackCode} from '../lib/v1/lending-reasons.mjs';
import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLender} from '../lib/v1/lender.mjs';
import {jobStatusContract} from '../lib/v1/status-contract.mjs';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
import {until} from './helpers/v1-lender-fixture.mjs';
import {DatabaseSync} from 'node:sqlite';
import {canonicalize} from '../lib/protocol/index.mjs';
import {accountHeartbeat} from './helpers/run-request-fixture.mjs';

// Real lender, real coordinator store and HTTP client, fake clock; the backend never starts a sandbox.
// One lender is the only computer that can take the job, so what it excludes locally decides whether the job ever runs.
const turn = () => new Promise(resolve => setTimeout(resolve, 30));
const runs = f => f.calls.filter(([kind]) => kind === 'run').length;
const starts = f => f.state.failed + prepares(f);
const prepares = f => f.calls.filter(([kind]) => kind === 'prepare').length;
const EXPIRY = Date.parse('2026-10-09T18:00:00Z');
const NOT_READY = {available: false, reason: 'sandbox_not_ready'};

async function fixture(t, {offers, code = 'sandbox_start_failed', failures = 1, mutateJob, approve = async () => true, admit, releaseAs, beforeStart, members}) {
  const f = await realLenderFixture(t, {offers, members, mutateJob: job => {job.expires_at = '2026-10-09T18:00:00Z'; mutateJob?.(job);}});
  const state = {approvals: 0, failed: 0, ready: true};
  // The coordinator's long poll waits in real time. Poll without waiting so a step of the fake clock is a step of the lender.
  const claimNext = f.client.claimNext.bind(f.client);
  f.client.claimNext = (capabilities, opts) => claimNext(capabilities, {...opts, waitSeconds: 0});
  if (offers) {const listOffers = f.client.listOffers.bind(f.client); f.client.listOffers = opts => listOffers({...opts, waitSeconds: 0});}
  // Reproduce a coordinator without the new start-failure count; ordinary setup releases do not exclude the lender.
  if (releaseAs) {const release = f.client.release.bind(f.client); f.client.release = async (attempt, reason, opts) => {
    const result = await release(attempt, canonicalize({code: releaseAs}), opts);
    const db = new DatabaseSync(f.storePath);
    try {
      const row = JSON.parse(db.prepare('SELECT data FROM jobs WHERE id=?').get(attempt.job_digest).data);
      delete row.start_failures; delete row.first_start_failure_at;
      db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(row), attempt.job_digest);
    } finally {db.close();}
    return result;
  };}
  const capabilities = f.backend.lenderCapabilities.bind(f.backend);
  f.backend.lenderCapabilities = (...args) => state.ready ? capabilities(...args) : NOT_READY;
  if (admit) {const admitJob = f.backend.admitJob.bind(f.backend); f.backend.admitJob = spec => admit(spec, admitJob);}
  const prepare = f.backend.prepare.bind(f.backend);
  f.backend.prepare = async spec => {
    if (state.failed < failures) {state.failed++; throw Object.assign(new Error('synthetic ' + code), {code});}
    return prepare(spec);
  };
  await beforeStart?.(f, state);
  const controller = new AbortController();
  const lender = createLender({...f.runOptions,client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy, clock: f.clock,
    approve: async (...args) => {state.approvals++; return approve(...args);}, onEvent: e => f.events.push(e)});
  const loop = lender.start(controller.signal);
  f.stop = async () => {controller.abort(); await loop;};
  Object.assign(f, {state, lender});
  // Advance the lender's clock in small steps; real HTTP needs real turns between them.
  let heartbeatAt=f.clock.now();
  const tick=async step=>{
    f.clock.advance(step);
    if(f.clock.now()-heartbeatAt>=30000){await f.refreshAccountHeartbeat();heartbeatAt=f.clock.now();}
    await turn();
  };
  state.tick = async (ms, step = 250) => {for (let spent = 0; spent < ms; spent += step) await tick(step);};
  state.tickUntil = async (check, ms, step = 250) => {for (let spent = 0; spent < ms && !check(); spent += step) await tick(step);};
  return f;
}
const job = f => f.owner.getJob(f.jobDigest);
const holdOneFailure = async (f, code = 'sandbox_start_failed') => {
  await until(() => f.state.failed === 1, 'the first start must fail');
  await f.state.tick(2000);
  const view = await job(f);
  assert.equal(view.state, 'queued');
  assert.equal(JSON.parse(view.current_attempt.reason).code,giveBackCode(code));
  assert.equal(f.saved().declined.find(row => row.jobDigest === f.jobDigest).exclusionVersion, 1, 'new exclusions carry an explicit version');
};

for (const offers of [true, false]) for (const retry of ['backoff expiry', 'readiness repair']) {
  test(`unchanged cleanup recovery passes preserve setup backoff until ${retry} (offers=${offers})`, {timeout: 90000}, async t => {
    let recovering = false;
    const f = await fixture(t, {offers, beforeStart: f => {
      f.backend.deadlineRecoveryPending = () => recovering;
    }});
    await holdOneFailure(f);
    const exclusion = f.saved().declined.find(row => row.jobDigest === f.jobDigest);
    for (let pass = 0; pass < 3; pass++) {
      const observed = f.events.length;
      recovering = true;
      await f.state.tick(3000);
      assert.ok(f.events.slice(observed).some(e => e.reason === 'cleanup_pending'), 'the admission loop overlaps the recovery pass');
      recovering = false;
      await f.state.tick(5000);
      assert.equal(starts(f), 1, 'routine recovery does not retry the failed setup');
      assert.equal(runs(f), 0);
    }
    if (retry === 'readiness repair') {
      f.state.ready = false;
      await f.state.tick(3000);
      f.state.ready = true;
    } else {
      await f.state.tick(exclusion.expiresAt - f.clock.now() - 1000, 1000);
      assert.equal(starts(f), 1, 'the exclusion lasts until its timed expiry');
      await f.state.tick(1000);
    }
    await f.state.tickUntil(() => runs(f) > 0, 60000, 1000);
    assert.equal(runs(f), 1, 'the job retries once after the intended release of the exclusion');
    if (retry === 'readiness repair') assert.ok(f.clock.now() < exclusion.expiresAt, 'a real readiness repair still retries early');
    else assert.ok(f.clock.now() >= exclusion.expiresAt);
  });
}

for (const [offers, code] of [[true, 'sandbox_start_failed'], [false, 'sandbox_start_failed'], [false, 'execution_failed'], [true, 'isolation_check_failed'], [false, 'isolation_check_failed']]) {
  test(`one lender, one failed start (${code}), then it is ready again: the job runs before expiry, once (offers=${offers})`, {timeout: 90000}, async t => {
    const f = await fixture(t, {offers, code});
    await holdOneFailure(f, code);
    const failedAt = f.clock.now();
    // The lender's own setup changes: it stops being ready, then becomes ready again.
    f.state.ready = false;
    await f.state.tick(3000);
    f.state.ready = true;
    await f.state.tickUntil(() => runs(f) > 0, 120000);
    const ranAt = f.clock.now();
    await f.state.tickUntil(() => false, 5000);
    const done = await job(f);
    assert.equal(runs(f), 1, 'the agent ran exactly once');
    assert.equal(done.state, 'result-accepted');
    assert.equal(done.attempts_started, 1);
    assert.ok(f.clock.now() < EXPIRY, 'before the job expired');
    assert.ok(ranAt - failedAt < 5 * 60000, 'the change in the lender\'s own state, not the backoff, ended the exclusion');
  });
}

for (const offers of [true, false]) {
  test(`a start that fails every time backs off; the job ends once the attempt limit and the minimum time have both passed (offers=${offers})`, {timeout: 120000}, async t => {
    const f = await fixture(t, {offers, failures: 99});
    const start = f.clock.now();
    await holdOneFailure(f);
    await f.state.tick(3 * 60000, 5000);
    assert.equal(starts(f), 1, 'no second start inside the first wait');
    await f.state.tickUntil(() => starts(f) >= 2, 4 * 60000, 2000);
    assert.equal(starts(f), 2, 'the job is tried again after the wait');
    assert.ok(f.clock.now() - start >= 5 * 60000, 'the first wait is at least five minutes');
    await f.state.tickUntil(() => starts(f) >= 3, 12 * 60000, 2000);
    await f.state.tick(5000, 1000);
    const third = await job(f);
    assert.equal(starts(f), 3);
    assert.equal(third.state, 'queued', 'three counted failures inside the minimum time do not end the job');
    assert.ok(f.clock.now() - start < 30 * 60000);
    // The lender's own count has reached the job's run count. The wait is capped and ends by itself; it is never for the job's life.
    await f.state.tickUntil(() => starts(f) >= 4, 30 * 60000, 2000);
    await f.state.tick(5000, 1000);
    const ended = await job(f);
    assert.equal(starts(f), 4, 'the first failure after the minimum time is the last');
    assert.equal(ended.state, 'failed');
    assert.equal(ended.attempts_started, 0);
    assert.equal(JSON.parse(ended.current_attempt.reason).code, 'start_failed', 'the borrower keeps the fixed code of the last failure');
    assert.equal(jobStatusContract(ended).lifecycle, 'failed');
    assert.ok(f.clock.now() - start >= 30 * 60000, 'not before the minimum time');
    assert.ok(f.clock.now() - start < 60 * 60000, 'it ended long before the job expires');
    await f.state.tick(40 * 60000, 10000);
    assert.equal(starts(f), 4, 'nothing starts it again');
    assert.equal(runs(f), 0);
    assert.ok(f.clock.now() < EXPIRY);
  });
}

test('three counted failures in two minutes leave the job queued; the first one after the minimum time ends it', {timeout: 120000}, async t => {
  const f = await fixture(t, {offers: false, failures: 99});
  const start = f.clock.now();
  await holdOneFailure(f);
  // A change in the lender's own readiness ends its wait at once, so restarts can spend attempts in minutes.
  for (const next of [2, 3]) {
    f.state.ready = false;
    await f.state.tick(3000);
    f.state.ready = true;
    await f.state.tickUntil(() => f.state.failed >= next, 60000, 1000);
    await f.state.tick(2000);
  }
  assert.equal(starts(f), 3);
  assert.ok(f.clock.now() - start < 2 * 60000, 'three failures inside two minutes');
  assert.equal((await job(f)).state, 'queued', 'the attempt limit alone does not end the job');
  f.state.ready = false;
  await f.state.tick(3000);
  f.state.ready = true;
  await f.state.tickUntil(() => starts(f) >= 4, 60000, 1000);
  await f.state.tick(2000);
  assert.equal((await job(f)).state, 'queued', 'a fourth failure inside the minimum time still leaves it queued');
  // After the minimum time since the first counted failure, the next counted failure ends it.
  await f.state.tick(31 * 60000, 10000);
  f.state.ready = false;
  await f.state.tick(3000);
  f.state.ready = true;
  await f.state.tickUntil(() => starts(f) >= 5, 60000, 1000);
  await f.state.tick(2000);
  const ended = await job(f);
  assert.equal(ended.state, 'failed');
  assert.equal(ended.attempts_started, 0);
  assert.equal(JSON.parse(ended.current_attempt.reason).code, 'start_failed');
  assert.ok(f.clock.now() < EXPIRY);
});

test('with a coordinator that never ends the job, the lender keeps retrying on a capped backoff after its own count reaches the run count', {timeout: 120000}, async t => {
  const f = await fixture(t, {offers: false, failures: 99, releaseAs: 'sandbox_start_failed'});
  const start = f.clock.now();
  await f.state.tickUntil(() => starts(f) >= 3, 20 * 60000, 2000);
  assert.equal(starts(f), 3);
  await f.state.tickUntil(() => starts(f) >= 5, 90 * 60000, 5000);
  assert.ok(starts(f) >= 5, 'the lender tried the job again after its third failure');
  assert.ok(f.clock.now() - start < 90 * 60000);
  assert.equal((await job(f)).state, 'queued');
  assert.equal(runs(f), 0);
});

for (const offers of [true, false]) test(`a preparation that times out (offers=${offers}) keeps its reason, counts, and is taken again after the lender state changes`, {timeout: 120000}, async t => {
  let admits = 0;
  const f = await fixture(t, {offers, failures: 0, admit: (spec, real) => admits++ === 0 ? new Promise(() => {}) : real(spec)});
  await until(() => admits === 1, 'the first admission must start');
  await f.state.tick(190000, 5000);
  await f.state.tick(3000, 1000);
  const view = await job(f);
  assert.equal(view.state, 'queued');
  assert.equal(JSON.parse(view.current_attempt.reason).code, 'cleanup_pending', 'the real reason, not a restart');
  assert.equal(runs(f), 0);
  assert.equal(f.saved().startFailures?.find(row => row.jobDigest === f.jobDigest)?.count, 1, 'timeout uses counted decline');
  await f.state.tick(60000, 5000);
  assert.equal(admits, 1, 'no retry inside the first backoff');
  f.state.ready = false;
  await f.state.tick(3000);
  f.state.ready = true;
  await f.state.tickUntil(() => runs(f) > 0, 120000);
  await f.state.tickUntil(() => false, 5000);
  const done = await job(f);
  assert.equal(runs(f), 1, 'the agent ran once');
  assert.equal(done.state, 'result-accepted');
  assert.ok(f.clock.now() < EXPIRY);
});

test('an explicit Skip excludes the job until it expires, whatever the lender does next', {timeout: 90000}, async t => {
  const f = await fixture(t, {offers: false, approve: async () => false});
  await until(() => f.state.approvals === 1, 'the lender must be asked once');
  await f.state.tick(2000);
  const first = await job(f);
  assert.equal(first.state, 'queued');
  assert.equal(JSON.parse(first.current_attempt.reason).code, 'approval_pending');
  // The lender's own state changes: not ready, then ready again. A person's Skip is not a setup fault, so it stays.
  f.state.ready = false;
  await f.state.tick(30000, 2000);
  f.state.ready = true;
  await f.state.tick(20 * 60000, 10000);
  assert.equal(f.state.approvals, 1, 'the lender is not asked about a job it skipped');
  assert.equal(prepares(f) + runs(f), 0);
  const view = await job(f);
  assert.equal(view.state, 'queued');
  assert.equal(JSON.parse(view.current_attempt.reason).code, 'approval_pending');
});

test('a passing hold is retried on its short wait and never counts against the job', {timeout: 90000}, async t => {
  const f = await fixture(t, {offers: false, code: 'sandbox_not_ready', failures: 4});
  // A one-second fake-clock step still observes each two-minute deadline; 250 ms steps spent most of the hang guard sleeping.
  await f.state.tickUntil(() => runs(f) > 0, 10 * 60000, 1000);
  await f.state.tickUntil(() => false, 5000);
  const done = await job(f);
  assert.equal(f.state.failed, 4);
  assert.equal(done.state, 'result-accepted');
  assert.equal(done.attempts_started, 1);
  assert.equal(runs(f), 1);
});

for (const offers of [true, false]) for (const readyAtBoot of [true, false]) test(`old lender exclusion without an epoch stays after repair (offers=${offers}, readyAtBoot=${readyAtBoot})`, {timeout: 90000}, async t => {
  const f = await fixture(t, {offers, failures: 0, beforeStart: async (f, state) => {
    state.ready = readyAtBoot;
    const row = {jobDigest: f.jobDigest, expiresAt: EXPIRY};
    await f.policy.storage.set({day: '2026-10-09', jobs: 0, milliseconds: 0, declined: [row], hiddenOffers: [row]});
  }});
  if (!readyAtBoot) {
    await f.state.tick(3000);
    assert.equal(runs(f), 0);
    f.state.ready = true;
  }
  await f.state.tick(10000);
  assert.equal(runs(f), 0, 'an old row cannot distinguish setup failure from a refusal');
  assert.equal((await job(f)).state, 'queued');
});

test('an old hidden row stays after repair despite a preparation failure in the current attempt', {timeout: 90000}, async t => {
  const f = await fixture(t, {offers: true, failures: 0, beforeStart: async (f, state) => {
    state.ready = false;
    await f.policy.storage.set({day: '2026-10-09', jobs: 0, milliseconds: 0,
      hiddenOffers: [{jobDigest: f.jobDigest, expiresAt: EXPIRY}]});
    const get = f.client.getJob.bind(f.client);
    f.client.getJob = async (...args) => ({...await get(...args), current_attempt: {
      state: 'released', reason: canonicalize({code: 'preparation_timeout'})}});
  }});
  await f.state.tick(3000);
  f.state.ready = true;
  await f.state.tick(10000);
  assert.equal(runs(f), 0);
  assert.equal((await job(f)).state, 'queued');
});

for (const scenario of ['Decline after setup release', 'setup row with another lender refusal', 'Hide with another lender setup release', 'Hide after own setup release']) {
  test(`upgrade preserves old exclusion: ${scenario}`, {timeout: 90000}, async t => {
    let oldRow;
    const f = await fixture(t, {offers: true, members: true, failures: 0, beforeStart: async f => {
      const other = scenario.includes('another lender');
      const client = other ? f.clientFor(3) : f.client;
      const accounts=f.runOptions.runAccounts();
      await client.heartbeat(accountHeartbeat(accounts));
      const ad = {harnesses: ['codex'], models: ['example-model'], capabilities: ['filtered_git_v1','run_request_v1'],accounts,
        egress: ['internet'], enforced_limits: Object.keys(f.job.payload.requirements.limits), max_limits: f.job.payload.requirements.limits};
      const {attempt} = await client.claimJob(f.jobDigest, ad);
      await client.release(attempt, canonicalize({code: scenario.includes('refusal') ? 'approval_denied' : 'sandbox_not_ready'}));
      if (scenario.startsWith('Decline')) {
        await f.client.declineJob(f.jobDigest);
        const db = new DatabaseSync(f.storePath);
        try {
          const row = JSON.parse(db.prepare('SELECT data FROM jobs WHERE id=?').get(f.jobDigest).data);
          delete row.declined_by_version;
          db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(row), f.jobDigest);
        } finally {db.close();}
      }
      oldRow = {jobDigest: f.jobDigest, expiresAt: EXPIRY};
      await f.policy.storage.set({day: '2026-10-09', jobs: 0, milliseconds: 0,
        ...(scenario.startsWith('Hide') ? {} : {declined: [oldRow]}), hiddenOffers: [oldRow]});
    }});
    await f.state.tick(3000);
    f.state.ready = false;
    await f.state.tick(3000);
    f.state.ready = true;
    await f.state.tick(10000);
    assert.deepEqual(f.saved().hiddenOffers, [oldRow], 'no attempt can supply the missing cause of an old row');
    if (!scenario.startsWith('Hide')) assert.deepEqual(f.saved().declined, [oldRow]);
    assert.equal(f.state.approvals, 0, 'the old exclusion prevents a new prompt');
    assert.equal(runs(f), 0);
    if (scenario.startsWith('Decline')) await assert.rejects(f.client.claimJob(f.jobDigest, {
      harnesses: ['codex'], models: ['example-model'], capabilities: ['filtered_git_v1','run_request_v1'],accounts:f.runOptions.runAccounts(), egress: ['internet'],
      enforced_limits: Object.keys(f.job.payload.requirements.limits), max_limits: f.job.payload.requirements.limits}), {code: 'forbidden'});
  });
}
