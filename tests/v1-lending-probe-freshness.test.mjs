import './helpers/no-browser.mjs';
import {guardReadFrom} from './helpers/guard-read.mjs';
import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLendingLedger} from '../lib/v1/lending-ledger.mjs';
import {createLendingProbe, createLendingReadings, guestProbeScript} from '../lib/v1/lending-probe.mjs';
import {createRealPace50Source, standingStopEvidence} from './helpers/real-source.mjs';
import {lendingReadiness} from '../lib/v1/lending-readiness.mjs';
import {LINES} from '../lib/v1/lending-status-copy.mjs';
import {createNativeGuard} from '../lib/v1/lending-native-guard.mjs';

// A usage reading is as old as its request, not as its runner's completion (cold-start money review 1101, two P2 findings).
// Deterministic clock and stubbed runner only: no sandbox, provider or network.
const T = Date.parse('2026-11-01T12:00:00Z');
const F = 60_000;
const H = {account: '1111222233334444', email: 'aaaa0000bbbb1111', org: '5555666677778888'};
// The guest output's marker key, taken from the shipped guest script so this file does not restate the protocol.
const MARKER = guestProbeScript('claude').match(/out=\{"(\w+)":1/)[1];
const CLAUDE_AUTH = {loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty'};
const line = ({status = 200, identity = {status: 200, account_sha256_16: H.account, email_sha256_16: H.email, org_sha256_16: H.org},
  attempts = {usage: 1, identity: 1}} = {}) => JSON.stringify({[MARKER]: 1, status, body: status === 200 ? {
  five_hour: {utilization: 40, resets_at: new Date(T + 3 * 3600e3).toISOString()},
  seven_day: {utilization: 20, resets_at: new Date(T + 4 * 86400e3).toISOString()},
  extra_usage: {is_enabled: false}} : {}, attempts, identity, guest_auth: CLAUDE_AUTH}) + '\n';

function fakeTime(start = T) {
  let t = start, seq = 0;
  const timers = new Map();
  const drain = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  return {now: () => t, set: at => { t = at; },
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, {at: t + Math.max(0, ms), fn}); return id; },
    clearTimer: id => { timers.delete(id); },
    async advanceTo(until) {
      for (;;) {
        await drain();
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next || next[1].at > until) break;
        timers.delete(next[0]); t = Math.max(t, next[1].at); next[1].fn(); await drain();
      }
      t = Math.max(t, until); await drain();
    }};
}

function ledgerFor(t, clock) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'probe-fresh-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return createLendingLedger({file: join(directory, 'ledger.json'), now: clock.now});
}

test('a reading is stamped at its request start, not when a slow teardown lets the runner return', async t => {
  const clock = fakeTime();
  const ledger = ledgerFor(t, clock);
  // The usage answer is read at once; Stop, run completion and sandbox removal then take 40 s.
  const probe = createLendingProbe({ledger, now: clock.now, runGuest: async () => { clock.set(clock.now() + 40_000); return {exitCode: 0, stdout: line()}; }});
  const result = await probe.probe('claude');
  assert.equal(result.ok, true);
  assert.equal(clock.now(), T + 40_000);
  assert.ok(result.readings.every(r => r.observed_at === T), 'every reading carries the request start');
  assert.equal(probe.funding('claude').observed_at, T, 'the same-run fact carries the request start');
  assert.equal(ledger.snapshot('claude', {plan: 'unknown'}).read_at, T, 'the ledger records the request start');
});

test('a runner may name a later usage arrival, but never one before the probe began or after it returned', async t => {
  const clock = fakeTime();
  let requestedAt, overridden = false;
  const probe = createLendingProbe({ledger: ledgerFor(t, clock), now: clock.now, runGuest: async () => {
    clock.set(T + 25_000); const at = overridden ? requestedAt : clock.now(); clock.set(T + 40_000);
    return {exitCode: 0, stdout: line(), usage_seen_at: at};
  }});
  assert.equal((await probe.probe('claude')).readings[0].observed_at, T + 25_000, 'the sandbox boot does not age the reading');
  for (const bad of [T - 1, T + 40_001, 'soon', null]) {
    clock.set(T); requestedAt = bad; overridden = true;
    assert.equal((await probe.probe('claude')).readings[0].observed_at, T, `usage_seen_at ${String(bad)} falls back to the probe start`);
  }
});

test('the native guard stops a job as stale on time when a slow teardown would have made an old reading look fresh', async t => {
  const clock = fakeTime();
  const ledger = ledgerFor(t, clock);
  let slow = true;
  const runGuest = async () => {
    if (!slow) throw new Error('sbx exec failed');
    slow = false;
    clock.set(clock.now() + 20_000);
    return {exitCode: 0, stdout: line()};
  };
  const probe = createLendingProbe({ledger, now: clock.now, runGuest: async () => ({exitCode: 0, stdout: line()})});
  const readings = createLendingReadings({ledger, probe, now: clock.now});
  const source = createRealPace50Source({readings, funding: provider => probe.funding(provider),
    expectedIdentity: async () => ({email_sha256_16: H.email})});
  const admitted = await source.observe({provider: 'claude', forceRefresh: true});
  assert.equal(admitted.identity.verified, true);
  assert.equal(admitted.funding.subscription_only, 'proven');
  assert.equal(admitted.observed_at, T);
  const stops = [];
  const guard = createNativeGuard({now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, freshnessMs: F,
    read: () => source.observe({provider: 'claude', forceRefresh: true, guardRead: guardReadFrom(runGuest)}),
    stop: (attemptId, reason) => { stops.push({attemptId, reason, at: clock.now()}); }});
  guard.watch({attemptId: 'a1', provider: 'claude', accountId: H.account, epoch: admitted.epoch, lastFreshAt: T,
    resources: admitted.resources.map(r => ({id: r.id, instance: r.instance, resets_at: r.resets_at,
      baseline_used_micro: r.used_micro, initial_micro: 10_000_000}))});
  // Poll at T+30 s reads usage at once and returns at T+50 s; every later read fails.
  await clock.advanceTo(T + 200_000);
  const status = guard.status('a1');
  assert.equal(status.last_fresh_at, T + 30_000, 'the guard counts the reading from its request start');
  assert.equal(status.stop_reason, 'meter_stale');
  assert.equal(status.stop_requested_at, T + 30_000 + F, 'the stale stop fires F after the last request start');
  assert.deepEqual(stops.map(s => s.reason), ['meter_stale']);
});

test('a Claude identity 429 with a usage 200 backs off like a usage 429, and a forced check inside the back-off makes no request', async t => {
  const clock = fakeTime();
  const ledger = ledgerFor(t, clock);
  let runs = 0;
  const probe = createLendingProbe({ledger, now: clock.now, runGuest: async () => {
    runs++; return {exitCode: 0, stdout: line({identity: {status: 429}, attempts: {usage: 1, identity: 3}})};
  }});
  const result = await probe.probe('claude');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'rate_limited');
  assert.equal(result.status_class, '4xx');
  assert.equal(result.retry_at, T + 5 * 60_000);
  assert.equal(probe.funding('claude'), null, 'no funding or identity fact is kept from a rate-limited run');
  assert.equal(ledger.snapshot('claude', {plan: 'unknown'}).read_at, null, 'no reading is recorded from a rate-limited run');

  clock.set(T + 60_000);
  assert.equal(probe.due('claude', {force: true}), false, 'a forced check waits out the back-off');
  const readings = createLendingReadings({ledger, probe, now: clock.now});
  const snap = await readings('claude', {forceRefresh: true});
  assert.equal(snap.probe?.reason, 'rate_limited', 'a skip inside the back-off keeps the rate-limit failure');
  assert.equal(snap.probe?.retry_at, T + 5 * 60_000, 'and its retry time');
  assert.equal(runs, 1, 'no request reached the rate-limited endpoint inside the back-off');

  // The back-off doubles on the next identity 429, as it does for usage.
  clock.set(T + 5 * 60_000);
  assert.equal((await probe.probe('claude')).retry_at, T + 5 * 60_000 + 10 * 60_000);
});

import {observationProofFailures} from './helpers/real-source.mjs';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {homedir} from 'node:os';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';

for (const invalidate of [false, true]) test(invalidate
  ? 'an executor change clears both providers and the next ordinary reading probes immediately'
  : 'persisted windows wait for current evidence after restart and admission requests a probe', async t => {
  const directory = fs.mkdtempSync(join(homedir(), '.tmp', 'probe-binding-'));
  const ledger = createLendingLedger({file:join(directory, 'ledger.json'), now:() => T});
  let version = 'A', runs = 0, release;
  const runner = async ({provider}) => {
    runs++;
    if (release !== undefined) await new Promise(resolve => {release = resolve;});
    const stdout = provider === 'claude' ? line() : JSON.stringify({[MARKER]:1,status:200,
      body:{plan_type:'pro',rate_limit:{allowed:true,limit_reached:false,primary_window:{
        used_percent:20,limit_window_seconds:604800,reset_at:(T+4*86400e3)/1000}}},
      identity:{status:200,account_sha256_16:H.account,email_sha256_16:H.email}});
    return {stdout, executor:{backend_id:'test', sbx_version:version},
      stop:{delivered:true, fallback:null, latency_ms:1, removed:true}};
  };
  let probe = createLendingProbe({ledger, now:() => T, runGuest:runner});
  await probe.probe('claude');
  await probe.probe('codex');
  assert.ok(probe.funding('claude'));
  assert.ok(probe.funding('codex'));
  if (invalidate) {
    version = 'B';
    probe.invalidateFacts('executor_changed');
    assert.equal(probe.funding('claude'), null);
    assert.equal(probe.funding('codex'), null);
  } else {
    await probe.close();
    probe = createLendingProbe({ledger, now:() => T, runGuest:runner});
  }
  const readings = createLendingReadings({ledger, probe, now:() => T});
  const executorNow = () => ({backend_id:'test', accepts:v => v === version});
  // The receipt is the machine's own and is bound to the runtime now in use; a changed runtime needs a renewed check (here: a new receipt).
  const source = createRealPace50Source({readings, funding:p => probe.funding(p),
    stopEvidence:(p, o) => standingStopEvidence(executorNow, {version, measured_at:T})(p, o),
    expectedIdentity:() => ({email_sha256_16:H.email}),
    expectedExecutor:executorNow, stopBoundMs:35000,
    windowOrigin:(_p, rows)=>new Map(rows.map(row=>[row.id,'owner'])),
    kappaForUsage:({account_id})=>({upper_micro:500000,lower_micro:500000,binding:{account_sha256_16:account_id}})});
  const pace = createPace50Candidate({directory, now:() => T, source,
    account:'test-account', account_week_id:'test-week',
    objectiveInputFor:createSyntheticPace50Source({start:T}).objectiveInputFor});
  t.after(async () => {
    await probe.close(); await pace.candidate.cancelObservations(); await pace.adapter.close();
    fs.rmSync(directory, {recursive:true, force:true});
  });
  if (invalidate) {
    const before = runs;
    await readings('claude');
    assert.equal(runs, before + 1);
    assert.equal(probe.funding('claude').executor, undefined, 'a reading carries no executor');
    probe.invalidateFacts('executor_changed');
  }
  release = null;
  const job = {budget_v1:{max_list_usd:10}, requirements:{limits:{wall_seconds:300}},
    expires_at:new Date(T + 86400e3).toISOString()};
  const request = {jobId:'test-job', job, provider:'claude', model:'claude-haiku-5-5',
    automatic:false, ownerAbsent:true, intentOn:true, paused:false};
  const pending = await source.observe({provider:'claude', admissionOnly:true});
  assert.deepEqual(observationProofFailures(pending), ['objective_evidence_unknown']);
  assert.equal(probe.inFlight('claude'), true, 'admission requested a background probe');
  const held = await pace.candidate.preview(request);
  assert.equal(held.reason, 'objective_evidence_unknown');
  assert.equal(held.admitted, false);
  release(); release = undefined;
  await readings('claude');
  const admitted = await pace.candidate.preview(request);
  assert.equal(admitted.admitted, true, JSON.stringify(admitted));
});

test('a probe already running during invalidation cannot restore the older facts', async t => {
  let release;
  const clock = fakeTime();
  const probe = createLendingProbe({ledger:ledgerFor(t, clock), now:clock.now, runGuest:async () => {
    await new Promise(resolve=>{release=resolve;});
    return {stdout:line(),executor:{backend_id:'test',sbx_version:'A'}};
  }});
  t.after(() => { release(); return probe.close(); });
  const running = probe.probe('claude');
  assert.equal(probe.outcome('claude').outcome, 'pending');
  probe.invalidateFacts('executor_changed');
  assert.equal(probe.outcome('claude'), null);
  assert.equal(probe.latestAttempt('claude'), null);
  assert.equal(probe.lastResult('claude'), null);
  assert.equal(probe.inFlight('claude'), true, 'the old transport still owns its sandbox while draining');
  release();
  assert.equal((await running).ok, false);
  assert.equal(probe.funding('claude'), null);
  assert.equal(probe.successfulResult('claude'), null);
  assert.equal(probe.outcome('claude'), null);
  assert.equal(probe.latestAttempt('claude'), null);
  assert.equal(probe.lastResult('claude'), null);
  assert.equal(probe.inFlight('claude'), false);
});

for (const status of [401, 429]) test(`invalidation clears a completed HTTP ${status} outcome from readiness`, async t => {
  const clock = fakeTime();
  const ledger = ledgerFor(t, clock);
  const probe = createLendingProbe({ledger, now:clock.now,
    runGuest:async () => ({stdout:line({status})})});
  t.after(() => probe.close());
  await probe.probe('claude');
  const readiness = () => lendingReadiness({provider:'claude', signedIn:true,
    observation:{evidence_pending:true, probe_outcome:probe.outcome('claude')}}).filter(row => row.id !== 'signed_in');
  assert.equal(probe.outcome('claude').outcome, 'failed');
  assert.ok(readiness().every(row => row.line !== LINES.evidence));
  const backoff = probe.backoffUntil('claude');

  probe.invalidateFacts('executor_changed');

  assert.equal(probe.outcome('claude'), null);
  assert.equal(probe.latestAttempt('claude'), null);
  assert.equal(probe.lastResult('claude'), null);
  assert.equal(probe.inFlight('claude'), false);
  assert.ok(readiness().every(row => row.line === LINES.evidence));
  assert.equal(probe.backoffUntil('claude'), backoff);
  if (status === 429) {
    assert.equal(backoff, T + 5 * F);
    assert.equal(probe.due('claude', {force:true}), false);
  }
});

test('an invalidated probe rejection cannot restore an obsolete failure', async t => {
  const clock = fakeTime();
  const failure = new Error('ledger write failed');
  const probe = createLendingProbe({now:clock.now,
    ledger:{recordReadings() { probe.invalidateFacts('executor_changed'); throw failure; }},
    runGuest:async () => ({stdout:line()})});
  t.after(() => probe.close());

  await assert.rejects(probe.probe('claude'), error => error === failure);

  assert.equal(probe.outcome('claude'), null);
  assert.equal(probe.latestAttempt('claude'), null);
  assert.equal(probe.lastResult('claude'), null);
  assert.equal(probe.inFlight('claude'), false);
});

// After a restart the process has no probe fact, so the first reserve holds with pending evidence and requests a probe. The
// owner already accepted the job, so reserve waits for that probe once instead of declining and asking again after the re-offer
// delay. A probe slower than the bound still declines with the same reason as before.
for (const probeReturns of [true, false]) test(probeReturns
  ? 'a reserve held for a pending reading waits for the probe it requested and then admits'
  : 'a reserve held for a pending reading declines as before when the probe outlasts the bound', async t => {
  const directory = fs.mkdtempSync(join(homedir(), '.tmp', 'reserve-pending-'));
  const ledger = createLendingLedger({file:join(directory, 'ledger.json'), now:() => T});
  let gate = null, runs = 0;
  const runner = async () => {
    runs++;
    if (gate) await gate;
    return {stdout:line(), executor:{backend_id:'test', sbx_version:'A'},
      stop:{delivered:true, fallback:null, latency_ms:1, removed:true}};
  };
  // A first app run saves the windows; the restarted app has no probe fact for them yet.
  const first = createLendingProbe({ledger, now:() => T, runGuest:runner});
  await first.probe('claude');
  await first.close();
  let release;
  gate = new Promise(resolve => { release = resolve; });
  const probe = createLendingProbe({ledger, now:() => T, runGuest:runner});
  const readings = createLendingReadings({ledger, probe, now:() => T});
  const source = createRealPace50Source({readings, funding:p => probe.funding(p),
    expectedIdentity:() => ({email_sha256_16:H.email}),
    expectedExecutor:() => ({backend_id:'test', accepts:v => v === 'A'}), stopBoundMs:35000,
    windowOrigin:(_p, rows)=>new Map(rows.map(row=>[row.id,'owner'])),
    kappaForUsage:({account_id})=>({upper_micro:500000,lower_micro:500000,binding:{account_sha256_16:account_id}})});
  const pace = createPace50Candidate({directory, now:() => T, source, account:'test-account', account_week_id:'test-week',
    objectiveInputFor:createSyntheticPace50Source({start:T}).objectiveInputFor, pendingReadingWaitMs:probeReturns ? 5_000 : 50});
  t.after(async () => {
    release();
    await probe.close(); await pace.candidate.cancelObservations(); await pace.adapter.close();
    fs.rmSync(directory, {recursive:true, force:true});
  });
  const job = {budget_v1:{max_list_usd:10}, requirements:{limits:{wall_seconds:300}},
    expires_at:new Date(T + 86400e3).toISOString()};
  const before = runs;
  const reserving = pace.candidate.reserve({attemptId:'held-job', jobId:'held-job', provider:'claude',
    model:'claude-haiku-5-5', job, automatic:false, ownerAbsent:true, intentOn:true, paused:false});
  if (probeReturns) setTimeout(() => release(), 20);
  const out = await reserving;
  assert.equal(runs, before + 1, 'one probe: the wait joins the probe the held admission requested');
  if (probeReturns) assert.equal(out.ok, true, JSON.stringify(out));
  else {
    assert.equal(out.ok, false);
    assert.equal(out.policyReason, 'objective_evidence_unknown');
  }
});

// An approved job's claim previews against the saved reading. When that reading is older than the freshness bound and its
// 5-hour window is not open, the window reads as unknown and the claim used to release the job at once. The gate now waits for
// the probe it already requested, inside the same bound reserve uses, and decides on the fresh reading. A probe that outlasts
// the bound still refuses with the same reason.
for (const probeReturns of [true, false]) test(probeReturns
  ? 'a claim gate held for a stale reading with a window that is not open waits for the probe and accepts'
  : 'a claim gate held for a stale reading still refuses when the probe outlasts the bound', async t => {
  const directory = fs.mkdtempSync(join(homedir(), '.tmp', 'gate-pending-'));
  let clock = T;
  const now = () => clock;
  const ledger = createLendingLedger({file:join(directory, 'ledger.json'), now});
  const notOpen = () => line().replace(/"five_hour":\{[^}]*\}/, '"five_hour":{"utilization":0,"resets_at":null}');
  let gate = null, runs = 0;
  const runner = async () => {
    runs++;
    if (gate) await gate;
    return {stdout:notOpen(), executor:{backend_id:'test', sbx_version:'A'},
      stop:{delivered:true, fallback:null, latency_ms:1, removed:true}};
  };
  // A first app run saves a reading whose 5-hour window is not open. The restarted app finds that reading 16 minutes old.
  const first = createLendingProbe({ledger, now, runGuest:runner});
  await first.probe('claude');
  await first.close();
  clock = T + 16 * 60_000;
  let release;
  gate = new Promise(resolve => { release = resolve; });
  const probe = createLendingProbe({ledger, now, runGuest:runner});
  const readings = createLendingReadings({ledger, probe, now});
  const source = createRealPace50Source({readings, funding:p => probe.funding(p),
    expectedIdentity:() => ({email_sha256_16:H.email}),
    expectedExecutor:() => ({backend_id:'test', accepts:v => v === 'A'}), stopBoundMs:35000,
    windowOrigin:(_p, rows)=>new Map(rows.map(row=>[row.id,'owner'])),
    kappaForUsage:({account_id})=>({upper_micro:500000,lower_micro:500000,binding:{account_sha256_16:account_id}})});
  const pace = createPace50Candidate({directory, now, source, account:'test-account', account_week_id:'test-week',
    objectiveInputFor:createSyntheticPace50Source({start:T}).objectiveInputFor, pendingReadingWaitMs:probeReturns ? 5_000 : 50});
  t.after(async () => {
    release();
    await probe.close(); await pace.candidate.cancelObservations(); await pace.adapter.close();
    fs.rmSync(directory, {recursive:true, force:true});
  });
  const job = {budget_v1:{max_list_usd:10}, requirements:{limits:{wall_seconds:300}},
    expires_at:new Date(T + 86400e3).toISOString()};
  const before = runs;
  const gating = pace.candidate.gate({provider:'claude', job, automatic:false, ownerAbsent:true});
  if (probeReturns) setTimeout(() => release(), 20);
  const refusal = await gating;
  assert.equal(runs, before + 1, 'one probe: the wait joins the probe the held claim requested');
  if (probeReturns) assert.equal(refusal, null, JSON.stringify(refusal));
  else assert.ok(refusal, 'a probe slower than the bound still refuses');
});

// The stop receipt is independent of the reading: it stands for 0 <= age < 24 h and is not tied to the 15-minute reading age. A
// reading that is old by the reading rule does not weaken it, and a fresh reading does not extend it.
test('the stop receipt expires at exactly 24 h, whatever the reading age', async t => {
  const {STOP_EVIDENCE_TTL_MS} = await import('../lib/v1/stop-evidence.mjs');
  const {usableAdmissionEvidence} = await import('../lib/v1/lender-pace50.mjs');
  const directory = fs.mkdtempSync(join(homedir(), '.tmp', 'receipt-edge-'));
  t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
  let clock = T;
  const now = () => clock;
  const ledger = createLendingLedger({file:join(directory, 'ledger.json'), now});
  const probe = createLendingProbe({ledger, now, runGuest:async () => ({stdout:line(), host_read:true})});
  t.after(() => probe.close());
  const readings = createLendingReadings({ledger, probe, now});
  const receipt = {executor:{backend_id:'test', sbx_version:'A'}, stop:{delivered:true, fallback:null, latency_ms:1, removed:true}, measured_at:T};
  const source = createRealPace50Source({readings, funding:p => probe.funding(p), stopEvidence:async () => receipt,
    expectedIdentity:() => ({email_sha256_16:H.email}), expectedExecutor:() => ({backend_id:'test', accepts:v => v === 'A'}), stopBoundMs:35000,
    windowOrigin:(_p, rows)=>new Map(rows.map(row=>[row.id,'owner'])),
    kappaForUsage:({account_id})=>({upper_micro:500000,lower_micro:500000,binding:{account_sha256_16:account_id}})});
  await probe.probe('claude');
  const observed = await source.observe({provider:'claude', admissionOnly:true});
  assert.equal(observed.stop.bounded_execution, 'proven');
  assert.equal(observed.stop.proven_until, T + STOP_EVIDENCE_TTL_MS);
  const request = {attempt_id:'a', job_id:'j', requested_usd_micro:1};
  assert.notEqual(usableAdmissionEvidence(observed, request, T + STOP_EVIDENCE_TTL_MS - 1), 'stop_bound_unknown', 'valid at 24 h minus 1 ms');
  assert.equal(usableAdmissionEvidence(observed, request, T + STOP_EVIDENCE_TTL_MS + 1), 'stop_bound_unknown', 'refused after 24 h');
  // Anti-rejuvenation: a newer reading does not move the receipt's end.
  clock = T + 3600e3;
  await probe.probe('claude');
  assert.equal((await source.observe({provider:'claude', admissionOnly:true})).stop.proven_until, T + STOP_EVIDENCE_TTL_MS);
});

// Upgrade from .73: readings saved before the upgrade carried stop and executor facts in memory only. After a restart no account
// reads as proven, a receipt is never made from old readings, and a fresh host read for one account rebinds that account only.
test('after an upgrade every account reads unknown until its own fresh host read, and no read makes stop proof', async t => {
  const {STOP_EVIDENCE_TTL_MS} = await import('../lib/v1/stop-evidence.mjs');
  const directory = fs.mkdtempSync(join(homedir(), '.tmp', 'upgrade-'));
  t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
  const idA = {status:200, account_sha256_16:H.account, email_sha256_16:H.email, org_sha256_16:H.org};
  const idB = {status:200, account_sha256_16:'9999888877776666', email_sha256_16:'bbbb0000cccc2222', org_sha256_16:'4444333322221111'};
  let identity = idA, creates = 0;
  const ledgerFile = join(directory, 'ledger.json');
  // Before the upgrade: an old build's runner reported a stop and an executor with every reading.
  const legacy = {executor:{backend_id:'test', sbx_version:'A'}, stop:{delivered:true, fallback:null, latency_ms:1, removed:true}};
  let old = createLendingProbe({ledger:createLendingLedger({file:ledgerFile, now:() => T}), now:() => T,
    runGuest:async () => ({stdout:line({identity}), host_read:true, ...legacy})});
  await old.probe('claude');
  await old.close();
  // After the upgrade: a new process on the same ledger, with no receipt.
  let receipts = 0;
  const ledger = createLendingLedger({file:ledgerFile, now:() => T});
  const probe = createLendingProbe({ledger, now:() => T, runGuest:async () => { creates++; return {stdout:line({identity}), host_read:true}; }});
  t.after(() => probe.close());
  assert.equal(probe.funding('claude'), null, 'no fact survives the restart');
  let expectedEmail = idA.email_sha256_16;
  const readings = createLendingReadings({ledger, probe, now:() => T});
  const source = createRealPace50Source({readings, funding:p => probe.funding(p),
    stopEvidence:async () => { receipts++; return null; },
    expectedIdentity:() => ({email_sha256_16:expectedEmail}),
    expectedExecutor:() => ({backend_id:'test', accepts:v => v === 'A'}), stopBoundMs:35000,
    windowOrigin:(_p, rows) => new Map(rows.map(row => [row.id, 'owner'])),
    kappaForUsage:({account_id}) => ({upper_micro:500000, lower_micro:500000, binding:{account_sha256_16:account_id}})});
  const before = await source.observe({provider:'claude', admissionOnly:true});
  assert.notEqual(before.stop.bounded_execution, 'proven', 'old readings are not promoted to proof');
  assert.notEqual(before.executor.single_executor, 'proven');
  // A fresh host read for account A rebinds A, still with no stop proof.
  await probe.probe('claude');
  const a = await source.observe({provider:'claude', admissionOnly:true});
  assert.equal(a.identity.verified, true);
  assert.notEqual(a.stop.bounded_execution, 'proven', 'reading A makes no stop proof');
  // Account B has had no read: it reads unknown, not A's facts.
  identity = idB; expectedEmail = idB.email_sha256_16;
  const b = await source.observe({provider:'claude', admissionOnly:true});
  assert.notEqual(b.identity.verified, true, 'B is unverified until its own read');
  assert.notEqual(b.stop.bounded_execution, 'proven');
  await probe.probe('claude');
  assert.equal((await source.observe({provider:'claude', admissionOnly:true})).identity.verified, true);
  assert.equal(probe.funding('claude').stop, undefined);
  assert.equal(STOP_EVIDENCE_TTL_MS, 86_400_000);
  assert.ok(receipts > 0 && creates >= 2);
});
