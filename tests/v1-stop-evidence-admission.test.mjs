import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import fs from 'node:fs';
import {homedir} from 'node:os';
import {createLendingLedger} from '../lib/v1/lending-ledger.mjs';
import {createLendingProbe, createLendingReadings, guestProbeScript} from '../lib/v1/lending-probe.mjs';
import {createRealPace50Source} from '../lib/v1/lending-pace50-source.mjs';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {createStopEvidenceStore, STOP_EVIDENCE_TTL_MS} from '../lib/v1/stop-evidence.mjs';
import {createStopCheckCoordinator, STOP_CHECK_LINES} from '../lib/v1/stop-check-coordinator.mjs';

const T0 = Date.UTC(2026, 10, 11, 12);
const STOP = {delivered: true, fallback: null, latency_ms: 1000, removed: true};

async function setup({deadlineMs = 200, cooldownMs = 10_000} = {}) {
  const dir = await mkdtemp(join(process.env.HOME, '.tmp', 'stop-coord-'));
  const clock = {t: T0, now: () => clock.t};
  const store = createStopEvidenceStore({file: join(dir, 's.json'), now: clock.now});
  const runtime = {backend_id: 'docker-sbx', sbx_version: '1.0.0'};
  const log = {checks: 0, held: null, outcome: 'pass', aborted: 0};
  // A fake check that goes through the real store, like the real one does. `held` lets a test keep it running.
  const check = async ({signal} = {}) => {
    log.checks++;
    const bound = {...runtime};
    const generation = await store.begin();
    signal?.addEventListener('abort', () => { log.aborted++; }, {once: true});
    if (log.held) await Promise.race([log.held, new Promise(resolve => signal?.addEventListener('abort', resolve, {once: true}))]);
    if (signal?.aborted) { await store.fail(generation); return {ok: false, reason: 'cancelled'}; }
    if (log.outcome === 'fail') { await store.fail(generation); return {ok: false, reason: 'stop_not_delivered'}; }
    await store.succeed(generation, {...bound, stop: STOP, measured_at: clock.t});
    return {ok: true};
  };
  const make = () => createStopCheckCoordinator({store, check, binding: async () => ({...runtime}), now: clock.now, deadlineMs, cooldownMs});
  return {dir, clock, store, runtime, log, make, coordinator: make(), done: () => rm(dir, {recursive: true, force: true})};
}
const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

test('no valid receipt: concurrent lending-on, resume and two accounts share exactly one check', async () => {
  const s = await setup();
  try {
    s.log.held = new Promise(resolve => { s.release = resolve; });
    s.coordinator.start(); s.coordinator.start();
    const jobs = [s.coordinator.ensure(), s.coordinator.ensure()];
    await tick();
    assert.equal(s.log.checks, 1);
    assert.equal((await s.coordinator.view()).state, 'checking');
    s.release();
    assert.deepEqual(await Promise.all(jobs), [{ok: true}, {ok: true}]);
    assert.equal(s.log.checks, 1);
  } finally { await s.done(); }
});

test('a valid receipt means no check on lending-on, refreshes, account changes or a restart', async () => {
  const s = await setup();
  try {
    assert.deepEqual(await s.coordinator.ensure(), {ok: true});
    assert.equal(s.log.checks, 1);
    for (let i = 0; i < 5; i++) { s.coordinator.start(); await s.coordinator.ensure(); await s.coordinator.view(); }
    const restarted = s.make();
    restarted.start(); await restarted.ensure();
    await tick();
    assert.equal(s.log.checks, 1);
    assert.equal((await restarted.view()).state, 'valid');
    // Never inside the 24 hours, even at the last millisecond.
    s.clock.t = T0 + STOP_EVIDENCE_TTL_MS - 1;
    await restarted.ensure();
    assert.equal(s.log.checks, 1);
  } finally { await s.done(); }
});

test('past 24 hours concurrent requests start one renewal, not one per account', async () => {
  const s = await setup();
  try {
    await s.coordinator.ensure();
    s.clock.t = T0 + STOP_EVIDENCE_TTL_MS;
    assert.equal((await s.coordinator.view()).state, 'expired');
    assert.equal(s.log.checks, 1, 'a status read starts nothing');
    const results = await Promise.all([s.coordinator.ensure(), s.coordinator.ensure(), s.coordinator.ensure()]);
    assert.ok(results.every(r => r.ok));
    assert.equal(s.log.checks, 2);
  } finally { await s.done(); }
});

test('a changed backend or sbx version needs one replacement check; an old binding is not trusted', async () => {
  const s = await setup();
  try {
    await s.coordinator.ensure();
    s.runtime.sbx_version = '1.0.1';
    assert.equal((await s.coordinator.view()).state, 'changed');
    await Promise.all([s.coordinator.ensure(), s.coordinator.ensure()]);
    assert.equal(s.log.checks, 2);
    s.runtime.backend_id = 'other';
    await s.coordinator.ensure();
    assert.equal(s.log.checks, 3);
  } finally { await s.done(); }
});

test('a failed check refuses the waiting job with the status line and starts no hidden retry', async () => {
  const s = await setup();
  try {
    s.log.outcome = 'fail';
    const first = await s.coordinator.ensure();
    assert.deepEqual([first.ok, first.reason], [false, 'stop_not_delivered']);
    const view = await s.coordinator.view();
    assert.deepEqual([view.state, view.line], ['failed', STOP_CHECK_LINES.failed]);
    // Status reads, restarts of the view, and a job inside the cooldown start nothing.
    for (let i = 0; i < 3; i++) { await s.coordinator.view(); const again = await s.coordinator.ensure(); assert.equal(again.ok, false); }
    assert.equal(s.log.checks, 1);
    // After the cooldown the next job arrival starts exactly one new check.
    s.clock.t += 10_000;
    s.log.outcome = 'pass';
    assert.deepEqual(await s.coordinator.ensure(), {ok: true});
    assert.equal(s.log.checks, 2);
  } finally { await s.done(); }
});

test('an explicit retry or turning lending on again starts one check inside the cooldown', async () => {
  const s = await setup();
  try {
    s.log.outcome = 'fail';
    await s.coordinator.ensure();
    s.log.outcome = 'pass';
    s.coordinator.retry(); s.coordinator.start();
    await tick(40);
    assert.equal(s.log.checks, 2);
    assert.equal((await s.coordinator.view()).state, 'valid');
  } finally { await s.done(); }
});

test('the wait is bounded: a check past the deadline refuses the job and its late success admits nothing', async () => {
  const s = await setup({deadlineMs: 60});
  try {
    s.log.held = new Promise(() => {});
    const waiting = await s.coordinator.ensure();
    assert.deepEqual([waiting.ok, waiting.reason], [false, 'timeout']);
    assert.equal(s.log.aborted, 1, 'the timed-out check was aborted');
    assert.equal(await s.store.receipt(), null);
    assert.equal((await s.coordinator.view()).state, 'failed');
  } finally { await s.done(); }
});

test('one waiter leaving does not cancel the check for the others', async () => {
  const s = await setup();
  try {
    s.log.held = new Promise(resolve => { s.release = resolve; });
    const leaving = new AbortController();
    const gone = s.coordinator.ensure({signal: leaving.signal});
    const stays = s.coordinator.ensure();
    await tick();
    leaving.abort();
    assert.deepEqual([(await gone).ok, (await gone).reason], [false, 'cancelled']);
    assert.equal(s.log.aborted, 0);
    s.release();
    assert.deepEqual(await stays, {ok: true});
    assert.equal(s.log.checks, 1);
  } finally { await s.done(); }
});

test('a check that finished for an older runtime does not admit the job', async () => {
  const s = await setup();
  try {
    s.log.held = new Promise(resolve => { s.release = resolve; });
    const waiting = s.coordinator.ensure();
    await tick();
    s.release();
    s.runtime.sbx_version = '2.0.0';      // the runtime changed while the check ran
    const result = await waiting;
    assert.equal(result.ok, false);
  } finally { await s.done(); }
});

// --- the claim gate -----------------------------------------------------------------------------------------------------
// Usage readings come from the host and carry no stop or executor. The stop receipt is the only proof, and a claimed job with no
// valid receipt joins the one bounded check before it is admitted or refused.
const H = {account: '1111222233334444', email: 'aaaa0000bbbb1111', org: '5555666677778888'};
const MARKER = guestProbeScript('claude').match(/out=\{"(\w+)":1/)[1];
const usageLine = () => JSON.stringify({[MARKER]: 1, status: 200, body: {
  five_hour: {utilization: 40, resets_at: new Date(T0 + 3 * 3600e3).toISOString()},
  seven_day: {utilization: 20, resets_at: new Date(T0 + 4 * 86400e3).toISOString()}, extra_usage: {is_enabled: false}},
  attempts: {usage: 1, identity: 1}, identity: {status: 200, account_sha256_16: H.account, email_sha256_16: H.email, org_sha256_16: H.org},
  guest_auth: {loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty'}}) + '\n';

async function gateFixture(t, {outcome = 'pass'} = {}) {
  const s = await setup({deadlineMs: 5000});
  s.log.outcome = outcome;
  const directory = fs.mkdtempSync(join(homedir(), '.tmp', 'stop-gate-'));
  const ledger = createLendingLedger({file: join(directory, 'ledger.json'), now: s.clock.now});
  let reads = 0;
  const probe = createLendingProbe({ledger, now: s.clock.now, runGuest: async () => { reads++; return {stdout: usageLine(), host_read: true}; }});
  const readings = createLendingReadings({ledger, probe, now: s.clock.now});
  const stopEvidence = async () => {
    const r = await s.store.receipt();
    return r ? {executor: {backend_id: r.backend_id, sbx_version: r.sbx_version}, measured_at: r.measured_at,
      stop: {delivered: r.delivered, fallback: r.fallback, latency_ms: r.latency_ms, removed: r.removed}} : null;
  };
  const source = createRealPace50Source({readings, funding: p => probe.funding(p), stopEvidence,
    expectedIdentity: () => ({email_sha256_16: H.email}), expectedExecutor: () => ({backend_id: s.runtime.backend_id, accepts: v => v === s.runtime.sbx_version}),
    stopBoundMs: 35000, windowOrigin: (_p, rows) => new Map(rows.map(row => [row.id, 'owner'])),
    kappaForUsage: ({account_id}) => ({upper_micro: 500000, lower_micro: 500000, binding: {account_sha256_16: account_id}})});
  const pace = createPace50Candidate({directory, now: s.clock.now, source, account: 'test-account', account_week_id: 'test-week', stopCheck: s.coordinator,
    objectiveInputFor: createSyntheticPace50Source({start: T0}).objectiveInputFor, pendingReadingWaitMs: 500});
  t.after(async () => { await probe.close(); await pace.candidate.cancelObservations(); await pace.adapter.close(); fs.rmSync(directory, {recursive: true, force: true}); await s.done(); });
  const job = {budget_v1: {max_list_usd: 10}, requirements: {limits: {wall_seconds: 300}}, expires_at: new Date(T0 + 86400e3).toISOString()};
  await probe.probe('claude');   // the owner's account has been read once, from the host
  return {...s, pace, job, probe, reads: () => reads, gate: () => pace.candidate.gate({provider: 'claude', job, automatic: false, ownerAbsent: true})};
}

test('a claimed job with no valid receipt joins the one stop check and is then admitted', async t => {
  const f = await gateFixture(t);
  const [a, b] = await Promise.all([f.gate(), f.gate()]);
  assert.equal(a, null, JSON.stringify(a)); assert.equal(b, null);
  assert.equal(f.log.checks, 1, 'two claims, one check');
  // With the receipt standing, a later claim starts no check.
  assert.equal(await f.gate(), null);
  assert.equal(f.log.checks, 1);
});

test('a failed stop check refuses the claimed job and never turns anything off', async t => {
  const f = await gateFixture(t, {outcome: 'fail'});
  const refusal = await f.gate();
  assert.ok(['stop_bound_unknown', 'executor_unknown'].includes(refusal), refusal);
  assert.equal(f.log.checks, 1);
  assert.equal((await f.coordinator.view()).line, STOP_CHECK_LINES.failed);
  assert.equal(await f.gate(), refusal, 'inside the cooldown the job is refused at once');
  assert.equal(f.log.checks, 1, 'no hidden retry');
});

test('a usage reading never makes proof: with readings only, the stop stays unknown', async t => {
  const f = await gateFixture(t, {outcome: 'fail'});
  await f.probe.probe('claude');   // a second reading
  assert.equal(f.probe.funding('claude').stop, undefined);
  assert.equal(f.probe.funding('claude').executor, undefined);
  assert.equal(await f.store.receipt(), null);
  assert.equal(f.log.checks, 0, 'a reading starts no check');
});
