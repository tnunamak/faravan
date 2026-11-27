import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Adapter} from '../lib/v1/lending-pace50-adapter.mjs';
import {createLendingLedger} from '../lib/v1/lending-ledger.mjs';
import {parseClaudeUsage} from '../lib/v1/lending-meter.mjs';
import {createRealPace50Source, paceInputFromObservation, resourcesFromReadings, coldOpenWindows} from './helpers/real-source.mjs';
import {coldWindowAccountWeekProven, createEstimatedPace50State, evaluateEstimatedPace50, transitionEstimatedPace50State} from '../lib/v1/lending-policy.mjs';
import {createNativeGuard} from '../lib/v1/lending-native-guard.mjs';
import {withWindowOrigins} from '../lib/v1/lender-pace50.mjs';
import {createWindowOriginStore, RESET_JITTER_MS} from '../lib/v1/window-origin.mjs';
import {lendingStatus} from '../lib/v1/lending-status-copy.mjs';
import {NATIVE_WINDOW_WEIGHTS} from '../lib/v1/quota-registry.mjs';
import {ordinaryInput, request, WEEK, ACCOUNT, MICRO as M} from './helpers/pace50-fixtures.mjs';

// An idle owner: no five-hour session open, so the provider answers `"five_hour": null`, with a fresh seven-day reading.
// Synthetic evidence only. The readings go through the production parser, ledger, source and policy. No provider, browser,
// network or Docker.
const T = Date.parse('2026-11-01T17:40:00.250Z');
const H = 3_600_000, FIVE_H = 5 * H, WEEK_MS = 7 * 24 * H;
const HASH = {account: '1111222233334444', email: 'aaaa0000bbbb1111'};
const AUTH = {loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty'};
const weeklyBody = {utilization: 20, resets_at: new Date(T + 42 * H).toISOString()};
const idleBody = {five_hour: null, seven_day: weeklyBody, extra_usage: {is_enabled: false}};

// One ledger that the probe writes, read the way the app reads it.
function ledgerAt(t, clock) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'cold-short-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return createLendingLedger({file: join(directory, 'ledger.json'), now: () => clock.at});
}
const record = (ledger, body, at) => ledger.recordReadings('claude', parseClaudeUsage(body, at).readings);

// The real source over that ledger. `factAt` is the time of the run that read the identity, funding, executor and stop.
function sourceOver(ledger, {factAt, refresh = async () => {}}) {
  return createRealPace50Source({
    readings: async (provider, options) => { await refresh(options); return ledger.snapshot('claude'); },
    funding: () => ({extra_usage: 'disabled', observed_at: factAt(), guest_auth: AUTH,
      identity: {account_sha256_16: HASH.account, email_sha256_16: HASH.email},
      executor: {backend_id: 'docker-sbx', sbx_version: 'sbx version v0.49.2'},
      stop: {delivered: true, fallback: null, latency_ms: 1, removed: true}}),
    expectedIdentity: () => ({email_sha256_16: HASH.email}),
    expectedExecutor: {backend_id: 'docker-sbx', accepts: () => true}, stopBoundMs: 35_000,
    windowOrigin: () => new Map(),
  });
}

// The policy input the lender builds from the observation, with the normal rule at the dial: no stubbed decision.
function policyInput(observation, now) {
  const input = paceInputFromObservation(observation, {now, context: {consent: true, people: true, agents: true, schedule: true,
    unexpired: true, intent: 'on', ownerAbsent: true}});
  if (input.refuse) return input;
  const provider = 'claude', model = 'claude-sonnet-5-5';
  const p = ordinaryInput({now, windows: input.windows});
  Object.assign(p, {account: input.account, account_week_id: WEEK, weekly_resource_id: input.weekly_resource_id, epoch: input.epoch, controls: input.controls,
    evidence: {...p.evidence, ...input.evidence}});
  p.state = createEstimatedPace50State({account: input.account, account_week_id: WEEK});
  p.request = request({requested_usd_micro: 3 * M, provider, model, expires_at: now + 7 * 24 * H});
  p.objective.ruleDial = .5;
  p.objective.job = {...p.objective.job, provider, model, requestedUsdMicro: 3 * M, nativeCostBounds: {unit: 'usd', lower: 3, upper: 3}};
  p.objective.ruleEvidence = {
    snapshot: {account: input.account, windows: p.windows.map(w => ({window_id: w.id, window_minutes: w.duration_ms / 60_000,
      used_pct: w.used_micro / M, resets_at: w.resets_at, observed_at: w.observed_at, state: 'open', lent_pct: 0, reserved_pct: 0}))},
    applicableResources: {account: input.account, provider, model, complete: true, ids: p.windows.map(w => w.id)},
    entries: [], history: [], roundingPoints: Object.fromEntries(p.windows.map(w => [w.id, 0])),
    lagBounds: Object.fromEntries(p.windows.map(w => [w.id, {providerLagMs: 0, maxPointsPerHour: 0,
      provenance: 'Synthetic synchronous bounded account.'}])),
    quotaRegistry: {version: 'synthetic/1', complete: true, limits: p.windows.map(w => ({id: w.id, provider, unit: 'quota_percent',
      capacity: 100, durationMs: w.duration_ms, reset: {kind: 'first-use'}, scope: {kind: 'account'},
      weights: {version: NATIVE_WINDOW_WEIGHTS, nativeUnit: 'quota_percent', byModel: {}}}))}};
  return p;
}

test('an idle owner (five_hour null, a fresh seven-day reading, identity proven) is admitted under the dial', async t => {
  const clock = {at: T};
  const ledger = ledgerAt(t, clock);
  record(ledger, idleBody, T);
  const observation = await sourceOver(ledger, {factAt: () => T}).observe({provider: 'claude'});
  assert.equal(observation.complete, true, 'the not-open window is a complete reading');
  assert.deepEqual(observation.identity, {verified: true, account_id: HASH.account, reason: null});
  const cold = observation.resources.find(r => r.id === 'five_hour');
  // The reset is a bound: this read plus one window length, at the whole second below it. The first use, the job's own start,
  // comes later, so the real reset is no earlier than this.
  const reset = Math.floor((T + FIVE_H) / 1000) * 1000;
  assert.deepEqual({state: cold.state, used: cold.used_micro, resets: cold.resets_at, anchor: cold.anchor_at, cold: cold.cold_open,
    origin: cold.origin, conversion: cold.conversion},
  {state: 'open', used: 0, resets: reset, anchor: reset - FIVE_H, cold: true, origin: 'cold', conversion: 'native_window'});
  assert.ok(cold.anchor_at <= T && cold.resets_at <= T + FIVE_H);
  assert.ok(observation.resources.every(r => r.conversion === 'native_window'), 'the attempt lends natively, guarded by its meter');

  const out = evaluateEstimatedPace50(policyInput(observation, T + 1_000));
  assert.equal(out.admitted, true, out.reason);
  assert.equal(out.conversion, 'native_window');
  const held = out.proposed_state.attempts[0].resources;
  assert.ok(held.find(r => r.id === 'five_hour').resets_at === reset && held.every(r => r.held_micro > 0));
  // The normal rule decided, at the dial (no stubbed decision): the same reason an open window lends with.
  assert.equal(out.objective.reasonCode, 'objective_lend_native');
});

// The ledger shape seen on 2026-11-01: the last five-hour row is a session that closed the day before, and the seven-day row
// is read every 15 minutes since.
function lastSessionClosed(ledger) {
  record(ledger, {five_hour: {utilization: 31, resets_at: new Date(T - 25 * H).toISOString()}, seven_day: weeklyBody,
    extra_usage: {is_enabled: false}}, T - 25.5 * H);
}

test('a reply with no five_hour key is still unknown and held; the same reply with five_hour null is admitted', async t => {
  const clock = {at: T};
  const missing = ledgerAt(t, clock);
  lastSessionClosed(missing);
  record(missing, {seven_day: weeklyBody, extra_usage: {is_enabled: false}}, T);
  const observation = await sourceOver(missing, {factAt: () => T}).observe({provider: 'claude'});
  assert.equal(observation.complete, false, 'a window the reply left out keeps its old, closed reading');
  assert.equal(paceInputFromObservation(observation, {now: T, context: {}}).refuse, 'resources_incomplete');
  assert.equal(observation.identity.verified, true, 'the hold is the missing window, not the account check');

  const idle = ledgerAt(t, clock);
  lastSessionClosed(idle);
  record(idle, idleBody, T);
  const admitted = evaluateEstimatedPace50(policyInput(await sourceOver(idle, {factAt: () => T}).observe({provider: 'claude'}), T + 1_000));
  assert.equal(admitted.admitted, true, admitted.reason);
});

test('a five_hour null from an older read is held: a stale not-open reading is unknown, and another run is not this run', async t => {
  const clock = {at: T};
  // The control: the same null, read by this run, is admitted.
  const fresh = ledgerAt(t, clock);
  record(fresh, idleBody, T);
  assert.equal(evaluateEstimatedPace50(policyInput(await sourceOver(fresh, {factAt: () => T}).observe({provider: 'claude'}), T + 1_000))
    .admitted, true);

  const ledger = ledgerAt(t, clock);
  // The null was read 20 min ago; this run read only the seven-day window.
  record(ledger, idleBody, T - 20 * 60_000);
  record(ledger, {seven_day: weeklyBody, extra_usage: {is_enabled: false}}, T);
  const stale = await sourceOver(ledger, {factAt: () => T}).observe({provider: 'claude'});
  assert.equal(stale.complete, false, 'stale not-open is unknown in the ledger');
  assert.equal(stale.resources.some(r => r.id === 'five_hour'), false);
  assert.equal(paceInputFromObservation(stale, {now: T, context: {}}).refuse, 'resources_incomplete');

  // A fresh null that a different run read (the identity, funding and stop came from a later run) is not this run's.
  const ledger2 = ledgerAt(t, clock);
  record(ledger2, {five_hour: null, extra_usage: {is_enabled: false}}, T - 60_000);
  record(ledger2, {seven_day: weeklyBody, extra_usage: {is_enabled: false}}, T);
  const other = await sourceOver(ledger2, {factAt: () => T}).observe({provider: 'claude'});
  assert.equal(other.complete, false);
  assert.notEqual(evaluateEstimatedPace50(policyInput(other, T + 1_000)).admitted, true);
});

test('null then open: the job opens the window, the guard binds it, and the next reading takes the normal path', async t => {
  const clock = {at: T};
  const ledger = ledgerAt(t, clock);
  record(ledger, idleBody, T);
  let factAt = T;
  const source = sourceOver(ledger, {factAt: () => factAt});
  const admitted = await source.observe({provider: 'claude'});
  const cold = admitted.resources.find(r => r.id === 'five_hour');
  const weekly = admitted.resources.find(r => r.id === 'seven_day');

  // The guard holds the reserved rows; the five-hour one was reserved cold.
  const binds = [], stops = [];
  const guard = createNativeGuard({now: () => clock.at, setTimer: () => 0, clearTimer: () => {}, read: async () => null,
    stop: (id, reason) => stops.push(reason), onBind: (id, resource, bound) => binds.push([resource, bound])});
  guard.watch({attemptId: 'a1', provider: 'claude', accountId: HASH.account, epoch: admitted.epoch, lastFreshAt: T, cold: ['five_hour'],
    resources: [weekly, cold].map(r => ({id: r.id, instance: r.instance, resets_at: r.resets_at, baseline_used_micro: r.used_micro,
      initial_micro: 5 * M}))});

  // 30 s later the window is still not open: a new bound, no use. The guard keeps the job running.
  clock.at = factAt = T + 30_000;
  record(ledger, idleBody, clock.at);
  const still = await source.observe({provider: 'claude'});
  assert.equal(still.resources.find(r => r.id === 'five_hour').cold_open, true);
  assert.deepEqual(guard.offer('a1', still), {usable: true, stopped: false});

  // The job's first call opened the window 40 s after admission. The provider now reports it open, with its real reset.
  const opened = T + 40_000;
  clock.at = factAt = T + 60_000;
  const openBody = {five_hour: {utilization: 2, resets_at: new Date(opened + FIVE_H).toISOString()}, seven_day: weeklyBody,
    extra_usage: {is_enabled: false}};
  record(ledger, openBody, clock.at);
  const open = await source.observe({provider: 'claude'});
  const real = open.resources.find(r => r.id === 'five_hour');
  assert.equal(open.complete, true);
  assert.equal(real.cold_open, undefined, 'an open window is an ordinary reading');
  assert.equal(real.state, 'open');
  assert.ok(real.resets_at >= cold.resets_at, 'the real reset is no earlier than the reserved bound');
  assert.deepEqual(guard.offer('a1', open), {usable: true, stopped: false});
  assert.deepEqual(binds, [['five_hour', {instance: real.instance, anchor_at: real.anchor_at, resets_at: real.resets_at}]]);
  assert.deepEqual(stops, []);

  // Bound is not opened-by-lending: the origin record says unknown, and the window is offered only to this job's own check.
  const originDir = fs.mkdtempSync(join(tmpdir(), 'cold-origin-'));
  t.after(() => fs.rmSync(originDir, {recursive: true, force: true}));
  const store = createWindowOriginStore({directory: originDir});
  const bindings = live => () => binds.map(([id, b]) => ({window_id: id, resets_at: b.resets_at, attempt_id: 'job', live}));
  const during = withWindowOrigins(open, {windowOrigins: store, coldBindings: bindings(true), checkingAttempt: () => 'job',
    lentAttemptLive: () => true, now: clock.at});
  assert.equal(during.resources.find(r => r.id === 'five_hour').origin, 'bound');
  // Another job's admission, or a status read, while this job runs: the window is unknown to it.
  for (const checkingAttempt of [() => 'other-job', () => null]) {
    const other = withWindowOrigins(open, {windowOrigins: store, coldBindings: bindings(true), checkingAttempt, lentAttemptLive: () => true,
      now: clock.at});
    assert.equal(other.resources.find(r => r.id === 'five_hour').origin, 'unknown');
  }
  const after = withWindowOrigins(open, {windowOrigins: store, coldBindings: bindings(false), lentAttemptLive: () => false, now: clock.at});
  assert.equal(after.resources.find(r => r.id === 'five_hour').origin, 'unknown', 'never inferred as the owner, never as lending');
  assert.equal(store.originFor(real.instance), 'unknown');
  // The cold bound itself is never recorded as a seen open window.
  const coldRecords = [];
  withWindowOrigins(admitted, {windowOrigins: {observeOpen: ({windows}) => coldRecords.push(...windows.filter(w => w.window_id === 'five_hour')),
    originFor: () => null}, now: T});
  assert.deepEqual(coldRecords.map(w => w.state), ['not_open']);

  // Later readings must be of that instance: another reset stops the job.
  clock.at = factAt = T + 90_000;
  const otherBody = {...openBody, five_hour: {utilization: 2, resets_at: new Date(opened + FIVE_H + 3_600_000).toISOString()}};
  record(ledger, otherBody, clock.at);
  assert.deepEqual(guard.offer('a1', await source.observe({provider: 'claude'})), {usable: true, stopped: true});
  await Promise.resolve();
  assert.deepEqual(stops, ['window_reset']);
});

test('a cold reservation still stops at its reserved reset, and a window that opened before admission is not its own', async () => {
  let at = T;
  const stops = [];
  const guard = createNativeGuard({now: () => at, setTimer: () => 0, clearTimer: () => {}, read: async () => null,
    stop: (id, reason) => stops.push([id, reason])});
  const reset = Math.floor((T + FIVE_H) / 1000) * 1000;
  const reading = (when, five) => ({refresh_succeeded: true, complete: true, observed_at: when, epoch: 'e',
    identity: {verified: true, account_id: HASH.account}, funding: {subscription_only: 'proven'},
    resources: [{id: 'seven_day', instance: 'w', resets_at: T + 42 * H, used_micro: 20 * M}, {id: 'five_hour', ...five}]});
  const watch = id => guard.watch({attemptId: id, provider: 'claude', accountId: HASH.account, epoch: 'e', lastFreshAt: T, cold: ['five_hour'],
    resources: [{id: 'seven_day', instance: 'w', resets_at: T + 42 * H, baseline_used_micro: 20 * M, initial_micro: 5 * M},
      {id: 'five_hour', instance: `five_hour@${reset}`, resets_at: reset, baseline_used_micro: 0, initial_micro: 5 * M}]});
  // A window open with an earlier reset was opened before this job was admitted: it is not the reserved one.
  watch('early');
  at = T + 1_000;
  assert.deepEqual(guard.offer('early', reading(T + 1_000, {instance: 'five_hour@x', state: 'open', resets_at: reset - 61_000,
    anchor_at: reset - 61_000 - FIVE_H, used_micro: M})), {usable: true, stopped: true});
  // The job's own window opened later than the bound, so it resets later. The reserved reset still ends the job.
  watch('late');
  at = reset - 1_000;
  assert.deepEqual(guard.offer('late', reading(at, {instance: 'five_hour@y', state: 'open', resets_at: reset + 30_000,
    anchor_at: reset + 30_000 - FIVE_H, used_micro: M})), {usable: true, stopped: false});
  at = reset;
  assert.deepEqual(guard.offer('late', reading(at, {instance: 'five_hour@y', state: 'open', resets_at: reset + 30_000,
    anchor_at: reset + 30_000 - FIVE_H, used_micro: M})), {usable: true, stopped: true});
  // A reservation that was not cold keeps the exact instance check: a not-open reading of it is a reset.
  at = T + 2_000;
  guard.watch({attemptId: 'strict', provider: 'claude', accountId: HASH.account, epoch: 'e', lastFreshAt: T,
    resources: [{id: 'five_hour', instance: `five_hour@${reset}`, resets_at: reset, baseline_used_micro: 0, initial_micro: 5 * M}]});
  assert.deepEqual(guard.offer('strict', reading(at, {instance: `five_hour@${reset + 1_000}`, state: 'open', cold_open: true,
    resets_at: reset + 1_000, anchor_at: reset + 1_000 - FIVE_H, used_micro: 0})), {usable: true, stopped: true});
  await Promise.resolve();
  assert.deepEqual(stops, [['early', 'window_reset'], ['late', 'window_reset'], ['strict', 'window_reset']]);
});

// The real lender, from admission on a cold window to a settlement read of the window the job opened.
async function coldLender(t, {phase, accountWeek = WEEK, configureSource = () => {}}) {
  const {createPace50Candidate} = await import('../lib/v1/lender-pace50.mjs');
  const {createSyntheticPace50Source} = await import('./helpers/pace50-synthetic-source.mjs');
  const {ACCOUNT, NOW} = await import('./helpers/pace50-fixtures.mjs');
  let at = NOW;
  const timers = new Map();
  let seq = 0;
  const setTimer = (fn, ms) => { timers.set(++seq, {due: at + ms, fn}); return seq; };
  const clearTimer = id => timers.delete(id);
  const drain = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  const advanceTo = async until => {
    for (;;) {
      await drain();
      const next = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
      if (!next || next[1].due > until) break;
      timers.delete(next[0]); at = next[1].due; next[1].fn(); await drain();
    }
    at = until; await drain();
  };
  const synthetic = createSyntheticPace50Source({start: NOW, account: ACCOUNT, accountWeek, override: ({base, now}) => ({...base,
    ...(phase.provenUntil ? {stop: {...base.stop, proven_until: phase.provenUntil}} : {}),
    resources: base.resources.map(r => {
      const native = {...r, conversion: 'native_window', kappa_micro: null, kappa_lower_micro: null};
      if (r.id !== 'five_hour') return {...native, used_micro: native.used_micro + phase.weeklyRise};
      if (phase.open === null) {
        const reset = Math.floor((now + FIVE_H) / 1000) * 1000;
        return {...native, instance: `five_hour@${reset}`, anchor_at: reset - FIVE_H, resets_at: reset, used_micro: 0, owner_used_micro: 0,
          origin: 'cold', cold_open: true};
      }
      return {...native, instance: `five_hour@${phase.open + FIVE_H}`, anchor_at: phase.open, resets_at: phase.open + FIVE_H,
        used_micro: phase.used, owner_used_micro: phase.used, origin: null};
    })})});
  configureSource(synthetic);
  const directory = fs.mkdtempSync(join(tmpdir(), 'cold-lender-'));
  const windowOrigins = createWindowOriginStore({directory: join(directory, 'window-origin')});
  const open = () => createPace50Candidate({directory, now: () => at, account: ACCOUNT, account_week_id: accountWeek, source: synthetic, windowOrigins,
    ownerSettings: {limit: () => ({state: 'set', maxJobUsd: 10})}, pendingRecords: () => [], nativeGuard: {setTimer, clearTimer}});
  let pace = open();
  t.after(async () => { await pace.adapter.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  return {get pace() { return pace; }, source: synthetic, NOW, advanceTo, windowOrigins, set: v => { at = v; },
    async restart() { await pace.adapter.close(); timers.clear(); pace = open(); },
    async finishAndSweepAfterLag(args) {
      await pace.candidate.finish(args);
      at += 120_000;
      await pace.candidate.probeHeld();
      return pace.candidate.finish(args);
    }};
}

test('through the lender: a job admitted on a not-open window keeps running when it opens, and retains blind use on that window', async t => {
  const phase = {open: null, used: 0, weeklyRise: 0};
  const s = await coldLender(t, {phase});
  const job = {requirements: {limits: {wall_seconds: 600}}, expires_at: new Date(s.NOW + 3600e3).toISOString()};
  const grant = await s.pace.candidate.reserve({attemptId: 'attempt-1', jobId: 'job-1', provider: 'claude', model: 'claude-sonnet-5-5',
    job, automatic: true, ownerAbsent: true});
  assert.equal(grant.ok, true, JSON.stringify(grant));
  const reserved = s.pace.adapter.state().attempts[0].resources.find(r => r.id === 'five_hour');
  assert.equal(reserved.baseline_used_micro, 0);
  await s.pace.candidate.started('attempt-1', {ok: true});

  // Still not open at the first guard read; then the job's first call opens it 40 s after admission, and uses 3 points.
  await s.advanceTo(s.NOW + 30_000);
  assert.equal(s.pace.candidate.nativeGuard.status('attempt-1').stop_reason, null);
  Object.assign(phase, {open: s.NOW + 40_000, used: 3 * M, weeklyRise: M});
  await s.advanceTo(s.NOW + 90_000);
  assert.equal(s.pace.candidate.nativeGuard.status('attempt-1').stop_reason, null, 'the opened window is the reserved one');

  s.pace.candidate.recordCleanup('attempt-1', {removed: true});
  await s.finishAndSweepAfterLag({attemptId: 'attempt-1', provider: 'claude', model: 'claude-sonnet-5-5',
    execution: {stdout: '', lending_meter: {final: true, cost_usd: 0.5}}});
  const attempt = s.pace.adapter.state().attempts[0];
  assert.equal(attempt.hold_closed, false, 'a partial rise cannot cover the reserved envelope');
  const five = attempt.resources.find(r => r.id === 'five_hour');
  assert.equal(five.instance, reserved.instance, 'the charge stays on the reserved scope');
  assert.equal(five.spent_micro, 3 * M, 'the whole use of the opened window is charged');

  // The next admission reads the window as an ordinary open window. Who opened it is unknown, so it holds until it resets,
  // and the hold is not put on the owner.
  const next = await s.pace.candidate.reserve({attemptId: 'attempt-2', jobId: 'job-2', provider: 'claude', model: 'claude-sonnet-5-5',
    job, automatic: true, ownerAbsent: true});
  assert.equal(next.policyReason, 'window_origin_unknown');
  assert.equal(s.windowOrigins.originFor(`five_hour@${phase.open + FIVE_H}`), 'unknown');
  assert.equal(lendingStatus({reason: next.policyReason}).recovery.who, 'automatic');
});

test('through the lender: a job whose window still shows as not open retains blind use', async t => {
  const phase = {open: null, used: 0, weeklyRise: M};
  const s = await coldLender(t, {phase});
  const job = {requirements: {limits: {wall_seconds: 600}}, expires_at: new Date(s.NOW + 3600e3).toISOString()};
  assert.equal((await s.pace.candidate.reserve({attemptId: 'attempt-1', jobId: 'job-1', provider: 'claude', model: 'claude-sonnet-5-5',
    job, automatic: true, ownerAbsent: true})).ok, true);
  await s.pace.candidate.started('attempt-1', {ok: true});
  await s.advanceTo(s.NOW + 45_000);
  assert.equal(s.pace.candidate.nativeGuard.status('attempt-1').stop_reason, null);
  s.pace.candidate.recordCleanup('attempt-1', {removed: true});
  await s.finishAndSweepAfterLag({attemptId: 'attempt-1', provider: 'claude', model: 'claude-sonnet-5-5',
    execution: {stdout: '', lending_meter: {final: true, cost_usd: 0.5}}});
  const attempt = s.pace.adapter.state().attempts[0];
  assert.equal(attempt.hold_closed, false);
  assert.ok(attempt.resources.every(r => r.spent_micro >= M), 'each window pays at least the one-point settlement floor');
});

// Round 3 (the money review of 2d55d4a2): who opened the window, a late first use, and reset jitter.
const longJob = NOW => ({requirements: {limits: {wall_seconds: 1800}}, expires_at: new Date(NOW + 3600e3).toISOString()});
async function runCold(t, phase, {openAt, used, advance}) {
  const s = await coldLender(t, {phase});
  const job = longJob(s.NOW);
  assert.equal((await s.pace.candidate.reserve({attemptId: 'attempt-1', jobId: 'job-1', provider: 'claude', model: 'claude-sonnet-5-5',
    job, automatic: true, ownerAbsent: true})).ok, true);
  await s.pace.candidate.started('attempt-1', {ok: true});
  const reserved = s.pace.adapter.state().attempts[0].resources.find(r => r.id === 'five_hour');
  await s.advanceTo(s.NOW + Math.max(0, openAt - s.NOW - 1));
  Object.assign(phase, {open: openAt, used, weeklyRise: M});
  await s.advanceTo(s.NOW + advance);
  return {s, job, reserved};
}
const finishAndSettle = async s => {
  s.pace.candidate.recordCleanup('attempt-1', {removed: true});
  await s.finishAndSweepAfterLag({attemptId: 'attempt-1', provider: 'claude', model: 'claude-sonnet-5-5',
    execution: {stdout: '', lending_meter: {final: true, cost_usd: 0.5}}});
  return s.pace.adapter.state().attempts[0];
};

for (const [label, offsetMs] of [['the owner used the account first, on another computer', 20_000],
  ['the owner and the job used it in the same second', 0]]) {
  test(`origin: ${label}; the bound window is unknown, never lending's or the owner's, and its whole rise is the job's`, async t => {
    const phase = {open: null, used: 0, weeklyRise: 0};
    // Both used the window: 2 points by the owner and 3 by the job.
    const {s} = await runCold(t, phase, {openAt: (await import('./helpers/pace50-fixtures.mjs')).NOW + offsetMs, used: 5 * M,
      advance: 90_000});
    assert.equal(s.pace.candidate.nativeGuard.status('attempt-1').stop_reason, null);
    const instance = `five_hour@${phase.open + FIVE_H}`;
    const attempt = await finishAndSettle(s);
    assert.equal(attempt.hold_closed, false);
    assert.equal(attempt.resources.find(r => r.id === 'five_hour').spent_micro, 5 * M, 'the owner is never charged for the job');
    const next = await s.pace.candidate.reserve({attemptId: 'attempt-2', jobId: 'job-2', provider: 'claude', model: 'claude-sonnet-5-5',
      job: longJob(s.NOW), automatic: true, ownerAbsent: true});
    assert.equal(next.policyReason, 'window_origin_unknown');
    assert.equal(s.windowOrigins.originFor(instance), 'unknown', 'not inferred as the owner after the job ended, nor as lending');
    assert.equal(lendingStatus({reason: next.policyReason}).recovery.who, 'automatic', 'the hold is not put on the owner');
  });
}

test('the owner may still attest a window whose origin is unknown, and a lending record never replaces it', async t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'cold-attest-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const store = createWindowOriginStore({directory: dir});
  const reset = Math.floor((T + FIVE_H) / 1000) * 1000, window = {window_id: 'five_hour', window_minutes: 300, resets_at: reset, state: 'open'};
  store.observeOpen({windows: [window], unknownWindows: [{window_id: 'five_hour', resets_at: reset + 5_000}], lentAttemptLive: false, now: T});
  assert.equal(store.originFor(`five_hour@${reset}`), 'unknown', 'matched within the reset jitter');
  store.observeOpen({windows: [window], lendingInstances: [`five_hour@${reset}`], lentAttemptLive: false, now: T + 1});
  assert.equal(store.originFor(`five_hour@${reset}`), 'unknown');
  store.attestOwnerOpening({windows: [window], instance: `five_hour@${reset}`, by: 'owner', reason: 'I opened it', now: T + 2});
  assert.equal(store.originFor(`five_hour@${reset}`), 'owner');
});

test('a window that opens long after admission re-checks the job against it: a pass keeps the job, the reserved reset still ends it', async t => {
  const phase = {open: null, used: 0, weeklyRise: 0};
  const {NOW} = await import('./helpers/pace50-fixtures.mjs');
  // The job ran 20 minutes before its first quota use.
  const {s, reserved} = await runCold(t, phase, {openAt: NOW + 20 * 60_000, used: 2 * M, advance: 21 * 60_000});
  assert.deepEqual(s.pace.candidate.registry.entry('attempt-1').boundRecheck, {admitted: true, reason: 'objective_lend'});
  assert.equal(s.pace.candidate.nativeGuard.status('attempt-1').stop_reason, null);
  // The bound label is this job's alone: another job is not admitted on a window whose opener is unknown.
  const other = await s.pace.candidate.reserve({attemptId: 'attempt-2', jobId: 'job-2', provider: 'claude', model: 'claude-sonnet-5-5',
    job: longJob(s.NOW), automatic: true, ownerAbsent: true});
  assert.equal(other.ok, false);
  assert.equal(other.policyReason, 'window_origin_unknown', JSON.stringify(other));
  // The bound window resets 20 minutes after the reserved reset; the job still stops at the reserved one.
  await s.advanceTo(reserved.resets_at - 1_000);
  assert.equal(s.pace.candidate.nativeGuard.status('attempt-1').stop_reason, null);
  await s.advanceTo(reserved.resets_at + 1_000);
  assert.equal(s.pace.candidate.nativeGuard.status('attempt-1').stop_reason, 'window_reset');
});

test('the re-check of a running job keeps its launch stop proof: a stop proof that expired since launch does not stop it', async t => {
  const {NOW} = await import('./helpers/pace50-fixtures.mjs');
  // The source's latest stop proof stops counting 15 minutes after admission; the window opens at 20 minutes.
  const phase = {open: null, used: 0, weeklyRise: 0, provenUntil: NOW + 15 * 60_000};
  const {s} = await runCold(t, phase, {openAt: NOW + 20 * 60_000, used: 2 * M, advance: 21 * 60_000});
  assert.deepEqual(s.pace.candidate.registry.entry('attempt-1').boundRecheck, {admitted: true, reason: 'objective_lend'});
  assert.equal(s.pace.candidate.nativeGuard.status('attempt-1').stop_reason, null);
});

test('the re-check asks only for the rest of the job: a job 30 minutes into a 30-minute run in a 1-hour expiry is not refused', async t => {
  const phase = {open: null, used: 0, weeklyRise: 0};
  const {NOW} = await import('./helpers/pace50-fixtures.mjs');
  const {s} = await runCold(t, phase, {openAt: NOW + 29 * 60_000, used: 2 * M, advance: 30 * 60_000});
  assert.deepEqual(s.pace.candidate.registry.entry('attempt-1').boundRecheck, {admitted: true, reason: 'objective_lend'});
  assert.equal(s.pace.candidate.nativeGuard.status('attempt-1').stop_reason, null);
});

test('a window that opens long after admission stops the job when the re-check against it fails', async t => {
  const phase = {open: null, used: 0, weeklyRise: 0};
  const {NOW} = await import('./helpers/pace50-fixtures.mjs');
  // The admission check refuses the job against the late window (here a stand-in refusal); the guard stops it.
  const s = await coldLender(t, {phase});
  const previews = [];
  const real = s.pace.adapter.preview.bind(s.pace.adapter);
  s.pace.adapter.preview = async (args) => {
    const out = await real(args);
    if (args.replacingAttemptId !== 'attempt-1') return out;
    previews.push({wall_ms: args.request.wall_ms, admitted: out.admitted});
    return {...out, admitted: false, reason: 'objective_hold'};
  };
  assert.equal((await s.pace.candidate.reserve({attemptId: 'attempt-1', jobId: 'job-1', provider: 'claude', model: 'claude-sonnet-5-5',
    job: longJob(s.NOW), automatic: true, ownerAbsent: true})).ok, true);
  await s.pace.candidate.started('attempt-1', {ok: true});
  await s.advanceTo(s.NOW + 20 * 60_000 - 1);
  Object.assign(phase, {open: s.NOW + 20 * 60_000, used: 2 * M, weeklyRise: M});
  await s.advanceTo(s.NOW + 21 * 60_000);
  assert.equal(previews.length, 1, 'one re-check, at the bind');
  assert.ok(previews[0].wall_ms <= 10 * 60_000 && previews[0].wall_ms > 8 * 60_000, 'the rest of the 30-minute run');
  assert.deepEqual(s.pace.candidate.registry.entry('attempt-1').boundRecheck, {admitted: false, reason: 'objective_hold'});
  assert.equal(s.pace.candidate.nativeGuard.status('attempt-1').stop_reason, 'window_recheck');
  assert.match(lendingStatus({reason: 'native_guard_window_recheck'}).line, /opened later than the last job was checked for/);
  assert.equal(lendingStatus({reason: 'native_guard_window_recheck'}).recovery.who, 'automatic');
});

test('a window that opens within the reset jitter of admission is not re-checked', async t => {
  const phase = {open: null, used: 0, weeklyRise: 0};
  const {NOW} = await import('./helpers/pace50-fixtures.mjs');
  const {s} = await runCold(t, phase, {openAt: NOW + 30_000, used: 2 * M, advance: 90_000});
  assert.equal(s.pace.candidate.registry.entry('attempt-1').boundRecheck, undefined);
  assert.equal(s.pace.candidate.nativeGuard.status('attempt-1').stop_reason, null);
  // A later read of the same window, its reset 5 s later, is still the bound window.
  phase.open += 5_000;
  await s.advanceTo(s.NOW + 150_000);
  assert.equal(s.pace.candidate.nativeGuard.status('attempt-1').stop_reason, null);
  assert.equal(s.pace.candidate.registry.entry('attempt-1').boundRecheck, undefined);
});

// Jitter: the provider's reset for one window moves by a few seconds between reads. The guard matches within 60 s, and the stop
// deadline never moves later.
function jitterGuard() {
  let at = T;
  const stops = [];
  const guard = createNativeGuard({now: () => at, setTimer: () => 0, clearTimer: () => {}, read: async () => null,
    stop: (id, reason) => stops.push(reason)});
  const reset = Math.floor((T + FIVE_H) / 1000) * 1000;
  const reading = (when, resetsAt) => ({refresh_succeeded: true, complete: true, observed_at: when, epoch: 'e',
    identity: {verified: true, account_id: HASH.account}, funding: {subscription_only: 'proven'},
    resources: [{id: 'seven_day', instance: 'w', resets_at: T + 42 * H, used_micro: 20 * M},
      {id: 'five_hour', instance: `five_hour@${resetsAt}`, state: 'open', resets_at: resetsAt, anchor_at: resetsAt - FIVE_H, used_micro: M}]});
  guard.watch({attemptId: 'j', provider: 'claude', accountId: HASH.account, epoch: 'e', lastFreshAt: T, cold: ['five_hour'],
    resources: [{id: 'seven_day', instance: 'w', resets_at: T + 42 * H, baseline_used_micro: 20 * M, initial_micro: 5 * M},
      {id: 'five_hour', instance: `five_hour@${reset}`, resets_at: reset, baseline_used_micro: 0, initial_micro: 5 * M}]});
  return {guard, stops, reset, reading, at: v => { at = v; }};
}

test('jitter at the first bind: a reset a few seconds before the reserved one binds; one more than 60 s before does not', async () => {
  for (const [early, stopped] of [[3_000, false], [60_000, false], [61_000, true]]) {
    const g = jitterGuard();
    g.at(T + 10_000);
    assert.deepEqual(g.guard.offer('j', g.reading(T + 10_000, g.reset - early)), {usable: true, stopped}, `${early} ms early`);
  }
});

test('jitter on later reads: the bound window within 60 s still matches; beyond it is a reset; the deadline never moves later', async () => {
  const g = jitterGuard();
  const bound = g.reset + 10_000;
  g.at(T + 10_000);
  assert.deepEqual(g.guard.offer('j', g.reading(T + 10_000, bound)), {usable: true, stopped: false});
  for (const [i, delta] of [-4_000, 4_000, -60_000, 60_000].entries()) {
    g.at(T + 20_000 + i * 1_000);
    assert.deepEqual(g.guard.offer('j', g.reading(T + 20_000 + i * 1_000, bound + delta)), {usable: true, stopped: false}, `${delta} ms`);
  }
  g.at(T + 30_000);
  assert.deepEqual(g.guard.offer('j', g.reading(T + 30_000, bound + 61_000)), {usable: true, stopped: true});
  await Promise.resolve();
  assert.deepEqual(g.stops, ['window_reset']);

  // A window bound a few seconds before the reserved reset ends the job at its own reset, not at the later reserved one.
  const e = jitterGuard();
  e.at(T + 10_000);
  assert.deepEqual(e.guard.offer('j', e.reading(T + 10_000, e.reset - 5_000)), {usable: true, stopped: false});
  e.at(e.reset - 5_000);
  // A read at the bound reset, still showing the same window within the jitter: the job stops all the same.
  assert.deepEqual(e.guard.offer('j', e.reading(e.reset - 5_000, e.reset - 2_000)), {usable: true, stopped: true});
  // In-band lines get the same bound window and the same deadline.
  const b = jitterGuard();
  b.at(T + 10_000);
  b.guard.offer('j', b.reading(T + 10_000, bound));
  assert.equal(b.guard.offerInband('j', [{window_id: 'five_hour', used_pct: 1, resets_at: bound + 30_000}], T + 11_000).stopped, false);
  assert.equal(b.guard.offerInband('j', [{window_id: 'five_hour', used_pct: 1, resets_at: bound + 61_000}], T + 12_000).stopped, true);
});

test('settlement matches the bound window within the reset jitter', async t => {
  const phase = {open: null, used: 0, weeklyRise: 0};
  const {NOW} = await import('./helpers/pace50-fixtures.mjs');
  const {s} = await runCold(t, phase, {openAt: NOW + 40_000, used: 3 * M, advance: 90_000});
  // The settlement read shows the same window with its reset 7 s later.
  phase.open += 7_000;
  const attempt = await finishAndSettle(s);
  assert.equal(attempt.hold_closed, false);
  assert.equal(attempt.resources.find(r => r.id === 'five_hour').spent_micro, 3 * M);
});

// Real parser, ledger, source and durable candidate; only strategy history is fixture evidence.
test('a stopped cold native window retains exposure until a verified post-stop reading after restart', async t => {
  const {createPace50Candidate} = await import('../lib/v1/lender-pace50.mjs');
  const {createSyntheticPace50Source} = await import('./helpers/pace50-synthetic-source.mjs');
  const clock = {at: T};
  const ledger = ledgerAt(t, clock);
  const directory = fs.mkdtempSync(join(tmpdir(), 'cold-native-restart-'));
  let fact = T;
  const source = sourceOver(ledger, {factAt: () => fact});
  const observe = source.observe.bind(source);
  let invalid = null;
  source.observe = async args => {
    const reading = await observe(args);
    return invalid === 'identity' ? {...reading, identity: {verified: false}}
      : invalid === 'failed' ? {...reading, refresh_succeeded: false}
      : invalid === 'incomplete' ? {...reading, complete: false} : reading;
  };
  const objectiveInputFor = createSyntheticPace50Source({start: T}).objectiveInputFor;
  const open = () => createPace50Candidate({directory, now: () => clock.at, account: HASH.account, account_week_id: `${HASH.account}:weekly:${T + 42 * H}`, source, objectiveInputFor,
    ownerSettings: {limit: () => ({state: 'set', maxJobUsd: 10})}});
  record(ledger, idleBody, T);
  let pace = open();
  t.after(async () => { await pace.adapter.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  const attemptId = 'cold-stopped';
  const grant = await pace.candidate.reserve({attemptId, jobId: 'cold-job', provider: 'claude', model: 'claude-sonnet-5-5',
    job: {requirements: {limits: {wall_seconds: 1200}}, expires_at: new Date(T + H).toISOString()}, ownerAbsent: true});
  assert.equal(grant.ok, true, JSON.stringify(grant));
  await pace.candidate.started(attemptId, {ok: true});
  await pace.candidate.ownerStop({attemptId, event_id: 'owner-stop', at: clock.at});
  clock.at += 210_000;
  await pace.candidate.recordCleanup(attemptId, {removed: true});
  await pace.adapter.close();
  pace = open();
  // No in-memory cold reservation survives. Old evidence cannot release anything.
  const held = () => pace.adapter.state().attempts.find(a => a.id === attemptId);
  const initial = held().resources.map(r => r.held_micro);
  await pace.candidate.probeHeld();
  assert.deepEqual(held().resources.map(r => r.held_micro), initial);
  clock.at += 120_000;
  fact = clock.at;
  record(ledger, {...idleBody, seven_day: {...weeklyBody, utilization: 22}}, fact);
  for (invalid of ['identity', 'failed', 'incomplete']) {
    await pace.candidate.probeHeld();
    assert.deepEqual(held().resources.map(r => r.held_micro), initial, `${invalid} evidence keeps every point held`);
  }
  invalid = null;
  await pace.candidate.probeHeld();
  const outcome = await pace.candidate.finish({attemptId, provider: 'claude', model: 'claude-sonnet-5-5',
    execution: {lending_meter: {final: true, tokens: {input: 1000, output: 100}}}});
  assert.equal(outcome.cessation.reason, 'already_settled');
  assert.equal(held().hold_closed, true);
  assert.ok(held().resources.every(r => r.held_micro === 0 && r.unrepresented_micro === 0));
  assert.equal(held().resources.find(r => r.id === 'seven_day').spent_micro, 2 * M);
});

test('native cleanup forces its own fresh probe with bounded backoff, without a status read or new job', async t => {
  const {createPace50Candidate} = await import('../lib/v1/lender-pace50.mjs');
  const {createSyntheticPace50Source} = await import('./helpers/pace50-synthetic-source.mjs');
  const clock = {at: T};
  const ledger = ledgerAt(t, clock);
  const directory = fs.mkdtempSync(join(tmpdir(), 'native-post-cleanup-'));
  let fact = T, available = false;
  const probes = [];
  const source = sourceOver(ledger, {factAt: () => fact, refresh: async options => {
    if (!options.forceRefresh) return;
    probes.push(clock.at);
    if (available) {
      fact = clock.at;
      record(ledger, idleBody, fact);
    }
  }});
  const open = () => createPace50Candidate({directory, now: () => clock.at, source, account: HASH.account,
    account_week_id: `${HASH.account}:weekly:${T + 42 * H}`,
    objectiveInputFor: createSyntheticPace50Source({start: T}).objectiveInputFor,
    ownerSettings: {limit: () => ({state: 'set', maxJobUsd: 10})}});
  record(ledger, idleBody, T);
  let pace = open();
  t.after(async () => { await pace.adapter.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  const attemptId = 'post-cleanup';
  const grant = await pace.candidate.reserve({attemptId, jobId: 'post-cleanup-job', provider: 'claude', model: 'claude-sonnet-5-5',
    job: {requirements: {limits: {wall_seconds: 1200}}, expires_at: new Date(T + H).toISOString()}, ownerAbsent: true});
  assert.equal(grant.ok, true, JSON.stringify(grant));
  await pace.candidate.started(attemptId, {ok: true});
  clock.at += 210_000;
  await pace.candidate.recordCleanup(attemptId, {removed: true});
  const initial = pace.adapter.state().attempts[0].resources.map(r => r.initial_micro);
  const out = await pace.candidate.finish({attemptId, provider: 'claude', model: 'claude-sonnet-5-5',
    execution: {lending_meter: {final: true, tokens: {input: 1000, output: 100}}}});
  assert.equal(out.cessation.settlement_reason ?? out.cessation.reason, 'native_settlement_unread');
  assert.equal(probes.length, 0, 'finish does not delay result delivery for a probe');
  clock.at += 120_000;
  await pace.candidate.probeHeld();
  assert.equal(probes.length, 1, 'the idle sweep requests the first eligible post-cleanup probe');
  for (let i = 0; i < 5; i++) await pace.candidate.probeHeld();
  assert.equal(probes.length, 1, 'reconciliation cannot spin against the provider');
  clock.at += 30_000;
  await pace.candidate.probeHeld();
  assert.equal(probes.length, 2);
  clock.at += 119_000;
  await pace.candidate.probeHeld();
  assert.equal(probes.length, 2, 'the second retry backs off for two minutes');
  clock.at += 1000;
  await pace.candidate.probeHeld();
  assert.equal(probes.length, 3);
  clock.at += 299_000;
  await pace.candidate.probeHeld();
  assert.equal(probes.length, 3, 'later retries back off for five minutes');
  await pace.adapter.close();
  pace = open();
  available = true;
  await pace.candidate.probeHeld();
  assert.equal(probes.length, 4, 'restart can promptly recover durable work');
  const held = pace.adapter.state().attempts.find(a => a.id === attemptId);
  assert.equal(held.hold_closed, false);
  assert.deepEqual(held.resources.map(r => r.held_micro + r.unrepresented_micro), initial,
    'an unchanged fresh reading leaves each original exposure unresolved');
  assert.ok(held.resources.every(r => r.released_micro === 0));
});

async function settlementReviewRig(t, {localAccount = HASH.account, initialBody = idleBody} = {}) {
  const {createPace50Candidate, NATIVE_SETTLEMENT_DELAY_MS} = await import('../lib/v1/lender-pace50.mjs');
  const {createSyntheticPace50Source} = await import('./helpers/pace50-synthetic-source.mjs');
  const clock = {at: T}, probes = [];
  const ledger = ledgerAt(t, clock);
  const directory = fs.mkdtempSync(join(tmpdir(), 'native-review-'));
  let fact = T, body = initialBody;
  const source = sourceOver(ledger, {factAt: () => fact, refresh: async options => {
    if (!options.forceRefresh) return;
    probes.push(clock.at);
    fact = clock.at; record(ledger, body, fact);
  }});
  const open = () => createPace50Candidate({directory, now: () => clock.at, source, account: localAccount,
    account_week_id: `${HASH.account}:weekly:${T + 42 * H}`,
    objectiveInputFor: createSyntheticPace50Source({start: T}).objectiveInputFor,
    ownerSettings: {limit: () => ({state: 'set', maxJobUsd: 10})}});
  record(ledger, initialBody, T);
  let pace = open();
  t.after(async () => { await pace.adapter.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  const attemptId = 'review-job';
  const grant = await pace.candidate.reserve({attemptId, jobId: 'review-job', provider: 'claude', model: 'claude-sonnet-5-5',
    job: {requirements: {limits: {wall_seconds: 1200}}, expires_at: new Date(T + H).toISOString()}, ownerAbsent: true});
  assert.equal(grant.ok, true, JSON.stringify(grant));
  await pace.candidate.started(attemptId, {ok: true});
  clock.at += 210_000;
  await pace.candidate.recordCleanup(attemptId, {removed: true});
  const cleanupAt = clock.at;
  return {clock, probes, source, cleanupAt, delay: NATIVE_SETTLEMENT_DELAY_MS ?? 120_000,
    get pace() { return pace; }, row: () => pace.adapter.state().attempts.find(a => a.id === attemptId),
    finish: () => pace.candidate.finish({attemptId, provider: 'claude', model: 'claude-sonnet-5-5',
      execution: {lending_meter: {final: true, tokens: {input: 1000, output: 100}}}}),
    restart: async () => { await pace.adapter.close(); pace = open(); },
    matchColdScope() {
      const observe = source.observe.bind(source);
      source.observe = async args => {
        const reading = await observe(args);
        const saved = pace.adapter.state().attempts.find(row => row.id === attemptId)?.resources
          .find(row => row.id === 'five_hour');
        if (!saved || !Array.isArray(reading?.resources)) return reading;
        return {...reading, resources:reading.resources.map(resource => resource.id === 'five_hour'
          ? {...resource, instance:saved.instance, anchor_at:saved.anchor_at, resets_at:saved.resets_at, cold_open:true}
          : resource)};
      };
    },
    reading: value => { body = value; fact = clock.at; record(ledger, body, fact); },
  };
}

test('covering scope-changed readings after restart retain the forced-probe backoff and every held point', async t => {
  const rig = await settlementReviewRig(t);
  await rig.restart();
  rig.clock.at = rig.cleanupAt + rig.delay;
  // The job opened its cold window, but restart lost the process-local binding. Its reset differs from the cold bound.
  const opened = {...idleBody, five_hour: {utilization: 3, resets_at: new Date(T + FIVE_H + 180_000).toISOString()}};
  rig.reading(opened);
  const initial = rig.row().resources.map(r => r.held_micro);
  // Make the first sweep need a refresh; subsequent sweeps receive covering but unplaceable readings.
  rig.clock.at += 61_000;
  const first = rig.clock.at;
  for (let sweep = 0; sweep <= 40; sweep++) {
    rig.clock.at = first + sweep * 30_000;
    await rig.pace.candidate.probeHeld();
    assert.deepEqual(rig.row().resources.map(r => r.held_micro), initial);
  }
  assert.deepEqual(rig.probes.map(at => at - first), [0, 90_000, 210_000, 510_000, 810_000, 1_110_000],
    'a fresh cached read can postpone a retry, but cannot reset the two-minute/five-minute backoff');
  assert.equal(rig.row().hold_closed, false);
});

test('native settlement rejects a reading ten seconds after cleanup across restart and retains blind use after the lag delay', async t => {
  const rig = await settlementReviewRig(t);
  assert.equal(rig.delay, 120_000);
  const initial = rig.row().resources.map(r => r.held_micro + r.unrepresented_micro);
  await rig.restart();
  rig.matchColdScope();
  rig.clock.at = rig.cleanupAt + 10_000;
  rig.reading(idleBody);
  await rig.pace.candidate.probeHeld();
  assert.equal(rig.row().hold_closed, false);
  assert.ok(rig.row().resources.every(r=>r.spent_micro===0), 'the read delay prevents even the floor charge');
  assert.equal(rig.probes.length, 0, 'the delay also suppresses premature forced probes');
  rig.clock.at = rig.cleanupAt + rig.delay;
  rig.reading(idleBody);
  await rig.pace.candidate.probeHeld();
  assert.equal(rig.row().hold_closed, false);
  assert.ok(rig.row().resources.every(r=>r.spent_micro>0), 'an eligible reading records the charge while retaining blind exposure');
  assert.deepEqual(rig.row().resources.map(r => r.held_micro + r.unrepresented_micro), initial,
    'a delay and unchanged meter do not reduce the original exposure');
  assert.ok(rig.row().resources.every(r => r.released_micro === 0));
});

test('a cold window that never opened settles at its synthetic reset after a fresh not-open reading', async t => {
  const rig = await settlementReviewRig(t);
  const initial = Object.fromEntries(rig.row().resources.map(r => [r.id, r.initial_micro]));
  const shortReset = rig.row().resources.find(r => r.id === 'five_hour').resets_at;
  rig.clock.at = shortReset + 1_000;
  rig.reading(idleBody);
  await rig.pace.candidate.probeHeld();

  const attempt = rig.row(), short = attempt.resources.find(r => r.id === 'five_hour');
  assert.equal(short.spent_micro, initial.five_hour, 'the never-opened reservation is charged at its synthetic reset');
  assert.equal(short.held_micro, 0);
  assert.equal(short.unrepresented_micro, 0);
  assert.equal(short.released_micro, 0);
  assert.equal(attempt.hold_closed, false, 'the still-open weekly window keeps its own exposure');
  const weekly = attempt.resources.find(r => r.id === 'seven_day');
  assert.equal(weekly.held_micro + weekly.unrepresented_micro, initial.seven_day);
});

test('native finish returns without reading or awaiting the provider meter', async t => {
  const rig = await settlementReviewRig(t);
  rig.clock.at = rig.cleanupAt + rig.delay;
  const observe = rig.source.observe;
  let reads = 0;
  rig.source.observe = () => { reads++; return Promise.resolve(null); };
  const outcome = await rig.finish();
  rig.source.observe = observe;
  assert.equal(reads, 0, 'result accounting must never initiate a provider read');
  assert.equal(outcome.cessation.reason, 'native_usage_held');
  assert.equal(rig.row().hold_closed, false);
});

test('native settlement holds for a different account or account week even when the epoch matches', async t => {
  const rig = await settlementReviewRig(t);
  rig.matchColdScope();
  rig.clock.at = rig.cleanupAt + rig.delay;
  rig.reading(idleBody);
  const observe = rig.source.observe.bind(rig.source);
  for (const patch of [{identity: {verified: true, account_id: 'different-account'}, account_week_id: 'different-account:weekly:1'},
    {account_week_id: 'different-week'}]) {
    rig.source.observe = async args => ({...await observe(args), ...patch});
    await rig.pace.candidate.probeHeld();
    assert.equal(rig.row().hold_closed, false, JSON.stringify(patch));
    assert.ok(rig.row().resources.every(r=>r.spent_micro===0), 'a mismatched identity records no charge');
  }
  rig.source.observe = observe;
  await rig.pace.candidate.probeHeld();
  assert.equal(rig.row().hold_closed, false);
  assert.ok(rig.row().resources.every(r=>r.spent_micro>0), 'matching identity records the charge without claiming coverage');
});

test('a fresh but unchanged post-delay meter does not prove that the provider posted the native job use', async t => {
  const rig = await settlementReviewRig(t);
  const initial = rig.row().resources.map(r => r.held_micro + r.unrepresented_micro);
  rig.clock.at = rig.cleanupAt + rig.delay;
  rig.reading(idleBody);
  await rig.pace.candidate.probeHeld();

  assert.equal(rig.row().hold_closed, false);
  assert.deepEqual(rig.row().resources.map(r => r.held_micro + r.unrepresented_micro), initial,
    'a new timestamp without meter movement cannot release any unresolved exposure');
});

// The adapter account names the local store (a device key in the app), not the provider account.
test('native settlement matches the provider account week when the local store uses a device identity', async t => {
  const rig = await settlementReviewRig(t, {localAccount: 'local-device-key'});
  rig.matchColdScope();
  rig.clock.at = rig.cleanupAt + rig.delay;
  rig.reading(idleBody);
  await rig.pace.candidate.probeHeld();
  assert.equal(rig.row().hold_closed, false);
  assert.ok(rig.row().resources.every(r=>r.spent_micro>0), 'an eligible reading records the charge while retaining blind exposure');
});

for (const exhausted of [false, true]) {
  test(`bound recheck retries superseding evidence once (fresh exhausted: ${exhausted})`, async t => {
    const phase = {open:null, used:0, weeklyRise:0};
    let generation = 0, builds = 0;
    const s = await coldLender(t, {phase, configureSource(source) {
      const observe = source.observe.bind(source), builder = source.objectiveInputFor.bind(source);
      source.observe = async args => ({...await observe(args), evidence_generation:generation});
      source.admissionEvidence = observation => ({...observation,
        latest_attempt:observation.evidence_generation === generation ? observation.latest_attempt
          : {outcome:'failed', reason:'evidence_superseded'}});
      source.objectiveInputFor = async args => {
        const out = await builder(args);
        if (phase.open && ++builds === 1) { generation++; if (exhausted) phase.used = 100 * M; }
        return out;
      };
    }});
    assert.equal((await s.pace.candidate.reserve({attemptId:'attempt-1', jobId:'job-1', provider:'claude',
      model:'claude-sonnet-5-5', job:longJob(s.NOW), automatic:true, ownerAbsent:true})).ok, true);
    await s.pace.candidate.started('attempt-1', {ok:true});
    await s.advanceTo(s.NOW + 20 * 60_000 - 1);
    Object.assign(phase, {open:s.NOW + 20 * 60_000, used:2 * M, weeklyRise:M});
    await s.advanceTo(s.NOW + 21 * 60_000);
    const check = s.pace.candidate.registry.entry('attempt-1').boundRecheck;
    assert.equal(check.admitted, !exhausted, JSON.stringify(check));
    assert.equal(s.pace.candidate.nativeGuard.status('attempt-1').stop_reason, exhausted ? 'window_recheck' : null);
    assert.ok(builds <= 2, 'at most one rebuild');
  });
}

async function coldResetRig(t, {neverOpened = false, accountWeek = WEEK} = {}) {
  const phase = {open:null, used:0, weeklyRise:0};
  const s = await coldLender(t, {phase, accountWeek});
  assert.equal((await s.pace.candidate.reserve({attemptId:'attempt-1', jobId:'job-1', provider:'claude',
    model:'claude-sonnet-5-5', job:longJob(s.NOW), automatic:true, ownerAbsent:true})).ok, true);
  await s.pace.candidate.started('attempt-1', {ok:true});
  await s.advanceTo(s.NOW + 39_999);
  if (!neverOpened) Object.assign(phase, {open:s.NOW + 40_000, used:2 * M, weeklyRise:M});
  await s.advanceTo(s.NOW + 90_000);
  const row = () => s.pace.adapter.state().attempts[0];
  const five = () => row().resources.find(r => r.id === 'five_hour');
  const usage = await s.pace.adapter.transition({type:'usage', event_id:'partial-use', at:s.NOW + 90_000,
    attempt_id:'attempt-1', burn_id:'partial-use', resources:row().resources.map(r => ({
      id:r.id, instance:r.instance, amount_micro:Math.max(1, Math.floor(r.held_micro / 2))}))},
  {expectedRevision:s.pace.adapter.state().revision});
  assert.equal(usage.applied, true, usage.reason);
  await s.pace.candidate.recordCleanup('attempt-1', {removed:true});
  await s.pace.candidate.finish({attemptId:'attempt-1', provider:'claude', model:'claude-sonnet-5-5',
    execution:{lending_meter:{final:true, cost_usd:0.5}}});
  assert.ok(five().held_micro > 0 && five().unrepresented_micro > 0);
  const before = structuredClone(five());
  s.set(before.resets_at);
  return {s, phase, row, five, before};
}

function weekReading(reading, {accountId, reset, omitShort = true, epoch = `weekly-${reset}`, weeklyInstance = epoch}) {
  return {...reading, account_week_id:`${accountId}:weekly:${reset}`, epoch,
    resources:reading.resources.filter(resource => !omitShort || resource.id !== 'five_hour').map(resource => resource.kind === 'weekly'
      ? {...resource, instance:weeklyInstance, anchor_at:reset - WEEK_MS, resets_at:reset} : resource)};
}

function resetEvent(attempt, at, eventId, reading) {
  return {type:'window_reset_settled', event_id:eventId, at, attempt_id:attempt.id,
    resource_ids:attempt.resources.filter(resource => resource.resets_at <= at).map(resource => resource.id),
    authoritative_cessation:true, reading};
}

test('cold reset freeze: the real window remains charged and repeated sweeps append no reset events', async t => {
  const rig = await coldResetRig(t);
  const {s, before} = rig;
  const transitions = [];
  const transition = s.pace.adapter.transition.bind(s.pace.adapter);
  s.pace.adapter.transition = (event, options) => { transitions.push(event); return transition(event, options); };
  const revision = s.pace.adapter.state().revision;
  for (let i = 0; i < 3; i++) {
    await s.pace.candidate.probeHeld();
    assert.deepEqual(rig.five(), before, 'the synthetic reset cannot erase real-window exposure');
  }
  assert.equal(s.pace.adapter.state().revision, revision);
  assert.equal(transitions.filter(e => e.type === 'window_reset_settled').length, 0);
});

for (const gone of ['not open', 'a different anchor']) {
  test(`cold reset freeze: ${gone} clears the old window exactly once`, async t => {
    const rig = await coldResetRig(t);
    await rig.s.pace.candidate.probeHeld();
    assert.deepEqual(rig.five(), rig.before);
    rig.phase.open = gone === 'not open' ? null : rig.row().cleanup_proof_persisted_at + 60_001;
    rig.s.set(rig.before.resets_at + 60_001);
    await rig.s.pace.candidate.probeHeld();
    assert.equal(rig.five().held_micro, 0);
    assert.equal(rig.five().unrepresented_micro, 0);
    assert.ok(rig.five().burns.every(b => b.represented));
    const cleared = structuredClone(rig.five());
    for (let i = 0; i < 3; i++) await rig.s.pace.candidate.probeHeld();
    assert.deepEqual(rig.five(), cleared);
    assert.equal(rig.s.pace.adapter.state().event_ids.filter(id => id === 'attempt-1:reset:five_hour').length, 1);
  });
}

test('cold reset freeze: a window that never opened clears at the synthetic reset', async t => {
  const rig = await coldResetRig(t, {neverOpened:true});
  await rig.s.pace.candidate.probeHeld();
  assert.equal(rig.five().held_micro, 0);
  assert.equal(rig.five().unrepresented_micro, 0);
  assert.ok(rig.five().burns.every(b => b.represented));
  assert.equal(rig.s.pace.adapter.state().event_ids.filter(id => id === 'attempt-1:reset:five_hour').length, 1);
});

test('cold reset freeze: late carry keeps its charge when the reset reading is unverified', async t => {
  const phase = {open:null, used:0, weeklyRise:0};
  const s = await coldLender(t, {phase});
  const job = {requirements:{limits:{wall_seconds:1800}}, expires_at:new Date(s.NOW + 7 * 86400e3).toISOString()};
  assert.equal((await s.pace.candidate.reserve({attemptId:'late-cold', jobId:'late-cold', provider:'claude', model:'claude-sonnet-5-5',
    job, automatic:true, ownerAbsent:true})).ok, true);
  const initial = s.pace.adapter.state().attempts[0].resources.find(r => r.id === 'five_hour');
  s.set(initial.resets_at + 3 * H);
  await s.pace.candidate.started('late-cold', {ok:true});
  await s.pace.candidate.recordCleanup('late-cold', {removed:true});
  await s.pace.candidate.finish({attemptId:'late-cold', provider:'claude', model:'claude-sonnet-5-5', execution:{stdout:'', lending_meter:null}});
  s.set(s.pace.adapter.state().attempts[0].cleanup_proof_persisted_at + 120_000);
  const observe = s.source.observe.bind(s.source);
  s.source.observe = async args => ({...await observe(args), identity:{verified:false}});
  await s.pace.candidate.probeHeld();
  const state = s.pace.adapter.state();
  const original = state.attempts.find(a => a.id === 'late-cold').resources.find(r => r.id === 'five_hour');
  assert.equal(original.held_micro, initial.held_micro, 'an unverified reading cannot retire the cold scope');
  assert.equal(state.attempts.some(a => a.id.startsWith('late-cold:carry:')), false, 'no successor can bypass the proof');
});

test('cold reset freeze: a synthetic successor keeps the late charge until its own verified reset', async t => {
  const phase = {open:null, used:0, weeklyRise:0};
  const s = await coldLender(t, {phase});
  const job = {requirements:{limits:{wall_seconds:1800}}, expires_at:new Date(s.NOW + 7 * 86400e3).toISOString()};
  assert.equal((await s.pace.candidate.reserve({attemptId:'late-cold-valid', jobId:'late-cold-valid', provider:'claude', model:'claude-sonnet-5-5',
    job, automatic:true, ownerAbsent:true})).ok, true);
  const initial = s.pace.adapter.state().attempts[0].resources.find(r => r.id === 'five_hour');
  s.set(initial.resets_at + 3 * H);
  await s.pace.candidate.started('late-cold-valid', {ok:true});
  await s.pace.candidate.recordCleanup('late-cold-valid', {removed:true});
  await s.pace.candidate.finish({attemptId:'late-cold-valid', provider:'claude', model:'claude-sonnet-5-5',
    execution:{stdout:'', lending_meter:null}});
  s.set(s.pace.adapter.state().attempts[0].cleanup_proof_persisted_at + 120_000);
  await s.pace.candidate.probeHeld();
  const carried = s.pace.adapter.state().attempts.find(a => a.id.startsWith('late-cold-valid:carry:'));
  assert.equal(carried?.resources[0].cold_open, true, 'the synthetic successor keeps the cold marker');
  assert.ok(carried.resources[0].unrepresented_micro > 0, 'the carried maximum remains exposed');

  const observe = s.source.observe.bind(s.source);
  s.source.observe = async args => ({...await observe(args), identity:{verified:false}});
  s.set(carried.resources[0].resets_at + 1_000);
  await s.pace.candidate.probeHeld();
  const still = s.pace.adapter.state().attempts.find(a => a.id === carried.id);
  assert.ok(still.resources[0].unrepresented_micro > 0, 'time alone cannot clear the successor');
});

test('cold reset freeze: a running attempt cannot settle its cold charge', async t => {
  const rig = await coldResetRig(t, {neverOpened:true});
  const state = structuredClone(rig.s.pace.adapter.state());
  const attempt = state.attempts[0];
  attempt.process_state = 'running';
  attempt.cessation_proven = false;
  const reading = await rig.s.source.observe({provider:'claude', now:rig.before.resets_at});
  const out = transitionEstimatedPace50State(state, {type:'window_reset_settled', event_id:'running-reset',
    at:rig.before.resets_at, attempt_id:'attempt-1', resource_ids:['five_hour'], authoritative_cessation:true, reading});
  assert.equal(out.applied, false);
  assert.equal(out.reason, 'cold_window_unresolved');
  assert.deepEqual(out.state, state);
});

test('cold reset freeze: a next provider week clears a never-opened hold only for the same account', async t => {
  const {ACCOUNT} = await import('./helpers/pace50-fixtures.mjs');
  const weekReset = T + 42 * H;
  const accountWeek = `${ACCOUNT}:weekly:${weekReset}`;
  const phase = {open:null, used:0, weeklyRise:0};
  const rig = await coldLender(t, {phase, accountWeek, configureSource(source) {
    const observe = source.observe.bind(source);
    source.observe = async args => {
      const reading = await observe(args);
      if (args.now < weekReset) return reading;
      const nextReset = weekReset + 7 * 24 * H;
      return {...reading, account_week_id:`${ACCOUNT}:weekly:${nextReset}`, epoch:`weekly-${nextReset}`,
        resources:reading.resources.map(r => r.kind === 'weekly' ? {...r, instance:`weekly-${nextReset}`,
          anchor_at:nextReset - 7 * 24 * H, resets_at:nextReset} : r)};
    };
  }});
  assert.equal((await rig.pace.candidate.reserve({attemptId:'rollover-cold', jobId:'rollover-cold', provider:'claude', model:'claude-sonnet-5-5',
    job:longJob(rig.NOW), automatic:true, ownerAbsent:true})).ok, true);
  await rig.pace.candidate.started('rollover-cold', {ok:true});
  await rig.pace.candidate.recordCleanup('rollover-cold', {removed:true});
  await rig.pace.candidate.finish({attemptId:'rollover-cold', provider:'claude', model:'claude-sonnet-5-5',
    execution:{lending_meter:{final:true, cost_usd:0.5}}});
  await rig.restart();
  rig.set(weekReset + 60_000);
  await rig.pace.candidate.probeHeld();
  let attempt = rig.pace.adapter.state().attempts.find(a => a.id === 'rollover-cold');
  assert.equal(attempt.resources.find(r => r.id === 'five_hour').held_micro, 0,
    'a fresh, same-account reading after the weekly reset can clear the never-opened scope');

  const otherPhase = {open:null, used:0, weeklyRise:0};
  const other = await coldLender(t, {phase:otherPhase, accountWeek, configureSource(source) {
    const observe = source.observe.bind(source);
    source.observe = async args => {
      const reading = await observe(args);
      if (args.now < weekReset) return reading;
      return {...reading, account_week_id:`other-account:weekly:${weekReset + 7 * 24 * H}`,
        identity:{verified:true, account_id:'other-account'}, epoch:'other-week',
        resources:reading.resources.map(r => r.kind === 'weekly' ? {...r, instance:'other-week',
          anchor_at:weekReset, resets_at:weekReset + 7 * 24 * H} : r)};
    };
  }});
  assert.equal((await other.pace.candidate.reserve({attemptId:'other-cold', jobId:'other-cold', provider:'claude', model:'claude-sonnet-5-5',
    job:longJob(other.NOW), automatic:true, ownerAbsent:true})).ok, true);
  await other.pace.candidate.started('other-cold', {ok:true});
  await other.pace.candidate.recordCleanup('other-cold', {removed:true});
  await other.pace.candidate.finish({attemptId:'other-cold', provider:'claude', model:'claude-sonnet-5-5',
    execution:{lending_meter:{final:true, cost_usd:0.5}}});
  other.set(weekReset + 60_000);
  await other.pace.candidate.probeHeld();
  attempt = other.pace.adapter.state().attempts.find(a => a.id === 'other-cold');
  assert.ok(attempt.resources.find(r => r.id === 'five_hour').held_micro > 0,
    'a different account cannot clear the cold scope');
});

for (const unavailable of ['incomplete', 'unverified', 'unreadable']) {
  test(`cold reset freeze: ${unavailable} evidence retains the charge and probe backoff`, async t => {
    const rig = await coldResetRig(t);
    const observe = rig.s.source.observe.bind(rig.s.source);
    let refreshes = 0;
    rig.s.source.observe = async args => {
      if (args.forceRefresh) refreshes++;
      if (unavailable === 'unreadable') throw new Error('synthetic unreadable meter');
      const reading = await observe(args);
      return unavailable === 'incomplete' ? {...reading, complete:false} : {...reading, identity:{verified:false}};
    };
    const revision = rig.s.pace.adapter.state().revision;
    for (let i = 0; i < 3; i++) await rig.s.pace.candidate.probeHeld();
    assert.deepEqual(rig.five(), rig.before);
    assert.equal(rig.s.pace.adapter.state().revision, revision);
    assert.equal(refreshes, 1, 'failed probes use the existing backoff');
  });
}

test('cold reset freeze: restart after the synthetic reset retains the matched window charge', async t => {
  const rig = await coldResetRig(t);
  rig.s.set(rig.before.resets_at + 1);
  await rig.s.restart();
  const revision = rig.s.pace.adapter.state().revision;
  for (let i = 0; i < 3; i++) await rig.s.pace.candidate.probeHeld();
  assert.deepEqual(rig.five(), rig.before);
  assert.equal(rig.s.pace.adapter.state().revision, revision);
});

test('cold reset freeze: native finish after the synthetic reset still does not read the provider', async t => {
  const rig = await coldResetRig(t);
  let reads = 0;
  rig.s.source.observe = async () => { reads++; return null; };
  await rig.s.pace.candidate.finish({attemptId:'attempt-1', provider:'claude', model:'claude-sonnet-5-5',
    execution:{lending_meter:{final:true, cost_usd:0.5}}});
  assert.equal(reads, 0);
  assert.deepEqual(rig.five(), rig.before);
});

test('cold reset freeze: the reducer refuses missing proof and inclusive anchor boundaries without mutating any charge', async t => {
  const rig = await coldResetRig(t);
  const state = rig.s.pace.adapter.state();
  const at = rig.before.resets_at;
  const reading = await rig.s.source.observe({provider:'claude', now:at});
  const event = {type:'window_reset_settled', event_id:'direct-reset', at, attempt_id:'attempt-1',
    resource_ids:['five_hour'], authoritative_cessation:true};
  const withAnchor = anchor => ({...reading, resources:reading.resources.map(r => r.id === 'five_hour'
    ? {...r, anchor_at:anchor, resets_at:anchor + FIVE_H} : r)});
  for (const evidence of [undefined, {...reading, complete:false}, {...reading, refresh_succeeded:false},
    {...reading, identity:{verified:false}}, {...reading, account_week_id:'other-week'},
    {...reading, epoch:'other-epoch'}, {...reading, observed_at:at - 1}, {...reading, observed_at:at + 1},
    {...reading, resources:reading.resources.filter(r => r.id !== 'five_hour')},
    withAnchor(undefined), withAnchor(rig.before.anchor_at - RESET_JITTER_MS),
    withAnchor(rig.row().cleanup_proof_persisted_at + RESET_JITTER_MS)]) {
    const out = transitionEstimatedPace50State(state, {...event, reading:evidence});
    assert.equal(out.applied, false);
    assert.equal(out.reason, 'cold_window_unresolved');
    assert.deepEqual(out.state, state);
  }
  const missingProof = structuredClone(state);
  delete missingProof.attempts[0].cleanup_proof_persisted_at;
  const noCleanup = structuredClone(missingProof);
  const notOpen = {...reading, observed_at:at, resources:reading.resources.map(r => r.id === 'five_hour'
    ? {...r, cold_open:true} : r)};
  const unresolved = transitionEstimatedPace50State(noCleanup, {...event, reading:notOpen});
  assert.equal(unresolved.applied, false);
  assert.equal(unresolved.reason, 'cold_window_unresolved');
  assert.deepEqual(unresolved.state, noCleanup);
  for (const anchor of [rig.before.anchor_at - RESET_JITTER_MS - 1,
    rig.row().cleanup_proof_persisted_at + RESET_JITTER_MS + 1]) {
    const out = transitionEstimatedPace50State(state, {...event, reading:withAnchor(anchor)});
    assert.equal(out.applied, true, out.reason);
    const five = out.state.attempts[0].resources.find(r => r.id === 'five_hour');
    assert.equal(five.held_micro, 0);
    assert.equal(five.unrepresented_micro, 0);
  }
});

test('cold reset refuses a retained warm window in a mixed settlement', async t => {
  const rig = await coldResetRig(t);
  const state = structuredClone(rig.s.pace.adapter.state());
  const at = rig.before.resets_at;
  const attempt = state.attempts[0];
  attempt.cleanup_proof_persisted_at = at - 120_000;
  state.updated_at = at;
  const warm = attempt.resources.find(r => r.id !== 'five_hour');
  warm.resets_at = attempt.cleanup_proof_persisted_at;
  warm.anchor_at = warm.resets_at - warm.duration_ms;
  assert.ok(warm.held_micro > 0);
  const reading = await rig.s.source.observe({provider:'claude', now:at});
  const proof = {...reading, resources:reading.resources.map(r => r.id === 'five_hour'
    ? {...r, anchor_at:rig.before.anchor_at - RESET_JITTER_MS - 1,
      resets_at:rig.before.anchor_at - RESET_JITTER_MS - 1 + FIVE_H} : r)};
  const event = {type:'window_reset_settled', event_id:'mixed-reset', at, attempt_id:attempt.id,
    resource_ids:['five_hour', warm.id], authoritative_cessation:true, reading:proof};
  const coldOnly = transitionEstimatedPace50State(state, {...event, resource_ids:['five_hour']});
  assert.equal(coldOnly.applied, true, coldOnly.reason);
  const out = transitionEstimatedPace50State(state, event);
  assert.equal(out.applied, false);
  assert.equal(out.reason, 'settlement_not_eligible');
  assert.deepEqual(out.state, state);
});

test('cold reset freeze: the reducer requires a post-cleanup reading for a not-open scope', async t => {
  const rig = await coldResetRig(t, {neverOpened:true});
  const reset = rig.before.resets_at;
  const cleanup = reset + 50_000;
  const event = {type:'window_reset_settled', event_id:'delayed-reset', at:cleanup,
    attempt_id:'attempt-1', resource_ids:['five_hour'], authoritative_cessation:true};
  const oldState = structuredClone(rig.s.pace.adapter.state());
  oldState.updated_at = cleanup;
  oldState.attempts[0].cleanup_proven = true;
  oldState.attempts[0].cleanup_proof_persisted_at = cleanup;
  const beforeCleanup = {...await rig.s.source.observe({provider:'claude', now:reset}), observed_at:reset};
  const old = transitionEstimatedPace50State(oldState, {...event, reading:beforeCleanup});
  assert.equal(old.applied, false, 'a not-open read from before cleanup must not erase the charge');
  assert.equal(old.reason, 'cold_window_unresolved');

  for (const offset of [0, 119_999]) {
    const state = structuredClone(oldState);
    const observedAt = cleanup + offset;
    const candidate = {...await rig.s.source.observe({provider:'claude', now:observedAt}), observed_at:observedAt};
    const out = transitionEstimatedPace50State(state, {...event, at:observedAt, reading:candidate});
    assert.equal(out.applied, false, `cleanup lag ${offset}ms is too short`);
    assert.equal(out.reason, 'cold_window_unresolved');
    assert.deepEqual(out.state, state);
  }
  const eligibleAt = cleanup + 120_000;
  const eligible = {...await rig.s.source.observe({provider:'claude', now:eligibleAt}), observed_at:eligibleAt};
  const out = transitionEstimatedPace50State(structuredClone(oldState), {...event, at:eligibleAt, reading:eligible});
  assert.equal(out.applied, true, out.reason);

  const staleAt = eligibleAt + 60_001;
  const stale = {...await rig.s.source.observe({provider:'claude', now:eligibleAt}), observed_at:eligibleAt};
  const staleState = structuredClone(oldState);
  staleState.updated_at = staleAt;
  const tooOld = transitionEstimatedPace50State(staleState, {...event, at:staleAt, reading:stale});
  assert.equal(tooOld.applied, false, 'a verified reading older than the reset freshness bound cannot clear the charge');
  assert.equal(tooOld.reason, 'cold_window_unresolved');
});

test('cold reset freeze: an omitted ended scope clears only from fresh verified same-account evidence', async t => {
  const {ACCOUNT} = await import('./helpers/pace50-fixtures.mjs');
  const accountWeek = `${ACCOUNT}:weekly:${T + 42 * H}`;
  const rig = await coldResetRig(t, {neverOpened:true, accountWeek});
  const cleanup = rig.row().cleanup_proof_persisted_at;
  const observedAt = Math.max(rig.before.resets_at, cleanup + 120_000) + 1;
  const reading = await rig.s.source.observe({provider:'claude', now:observedAt});
  const omitted = {...reading, resources:reading.resources.filter(resource => resource.id !== 'five_hour')};
  assert.equal(omitted.resources.some(resource => resource.id === 'five_hour'), false);
  const state = structuredClone(rig.s.pace.adapter.state());
  const event = {type:'window_reset_settled', event_id:'omitted-reset', at:observedAt, attempt_id:'attempt-1',
    resource_ids:['five_hour'], authoritative_cessation:true};

  const staleAt = observedAt + 60_001;
  const rejected = [
    ['partial', {...omitted, complete:false}, observedAt],
    ['refresh failed', {...omitted, refresh_succeeded:false}, observedAt],
    ['unverified', {...omitted, identity:{verified:false, account_id:ACCOUNT}}, observedAt],
    ['wrong account in the same week', {...omitted, identity:{verified:true, account_id:'other-account'}}, observedAt],
    ['stale', {...omitted, observed_at:observedAt}, staleAt],
  ];
  for (const [label, evidence, at] of rejected) {
    const unchanged = structuredClone(state);
    const out = transitionEstimatedPace50State(unchanged, {...event, at, reading:evidence});
    assert.equal(out.applied, false, label);
    assert.equal(out.reason, 'cold_window_unresolved', label);
    assert.deepEqual(out.state, unchanged, label);
  }

  const out = transitionEstimatedPace50State(state, {...event, reading:omitted});
  assert.equal(out.applied, true, out.reason);
  const short = out.state.attempts[0].resources.find(resource => resource.id === 'five_hour');
  assert.equal(short.held_micro, 0);
  assert.equal(short.unrepresented_micro, 0);
});

test('cold reset freeze: the lender settles a pruned ended window from a verified fresh reading', async t => {
  const {ACCOUNT} = await import('./helpers/pace50-fixtures.mjs');
  const accountWeek = `${ACCOUNT}:weekly:${T + 42 * H}`;
  const rig = await coldResetRig(t, {neverOpened:true, accountWeek});
  const cleanup = rig.row().cleanup_proof_persisted_at;
  const observedAt = Math.max(rig.before.resets_at, cleanup + 120_000) + 1;
  const observe = rig.s.source.observe.bind(rig.s.source);
  const pruned = [];
  rig.s.source.observe = async args => {
    const reading = await observe(args);
    if (args.now < observedAt) return reading;
    const next = {...reading, resources:reading.resources.filter(resource => resource.id !== 'five_hour')};
    pruned.push(next);
    return next;
  };

  rig.s.set(observedAt);
  await rig.s.pace.candidate.probeHeld();

  assert.ok(pruned.length > 0, 'the sweep used the post-reset provider reading');
  assert.ok(pruned.every(reading => reading.complete && reading.identity.verified && reading.refresh_succeeded));
  const attempt = rig.s.pace.adapter.state().attempts.find(row => row.id === 'attempt-1');
  const short = attempt.resources.find(resource => resource.id === 'five_hour');
  assert.equal(short.held_micro, 0);
  assert.equal(short.unrepresented_micro, 0);
});

test('cold reset freeze: forward-week omission waits through the full settlement delay', async t => {
  const weekReset = T + 42 * H;
  const accountWeek = `${ACCOUNT}:weekly:${weekReset}`;
  const rig = await coldResetRig(t, {neverOpened:true, accountWeek});
  const initial = rig.s.pace.adapter.state();
  const state = structuredClone(initial);
  const cleanupAt = weekReset + 1;
  state.updated_at = cleanupAt;
  state.attempts[0].cleanup_proof_persisted_at = cleanupAt;
  const rejectedAt = cleanupAt + 119_999;
  const rejectedReading = weekReading(await rig.s.source.observe({provider:'claude', now:rejectedAt}),
    {accountId:ACCOUNT, reset:weekReset + WEEK_MS});
  assert.equal(coldWindowAccountWeekProven(state.attempts[0], rejectedReading), true);
  const rejected = transitionEstimatedPace50State(state, {...resetEvent(state.attempts[0], rejectedAt, 'forward-omission-too-early', rejectedReading), resource_ids:['five_hour']});
  assert.equal(rejected.applied, false, 'cleanup plus 119999ms must keep the omitted cold hold');
  assert.equal(rejected.reason, 'cold_window_unresolved');
  assert.deepEqual(rejected.state, state);

  const eligibleAt = cleanupAt + 120_000;
  const eligibleState = structuredClone(state);
  const eligibleReading = weekReading(await rig.s.source.observe({provider:'claude', now:eligibleAt}),
    {accountId:ACCOUNT, reset:weekReset + WEEK_MS});
  assert.equal(coldWindowAccountWeekProven(eligibleState.attempts[0], eligibleReading), true);
  const eligible = transitionEstimatedPace50State(eligibleState,
    {...resetEvent(eligibleState.attempts[0], eligibleAt, 'forward-omission-at-boundary', eligibleReading), resource_ids:['five_hour']});
  assert.equal(eligible.applied, true, eligible.reason);
  const ended = eligible.state.attempts[0].resources.find(resource => resource.id === 'five_hour');
  assert.equal(ended.held_micro, 0);
  assert.equal(ended.unrepresented_micro, 0);
});

test('cold reset freeze: an omitted row clears after two forward weekly rollovers', async t => {
  const weekReset = T + 42 * H;
  const rig = await coldResetRig(t, {neverOpened:true, accountWeek:`${ACCOUNT}:weekly:${weekReset}`});
  const at = weekReset + 2 * WEEK_MS + 1;
  const state = structuredClone(rig.s.pace.adapter.state());
  const reading = weekReading(await rig.s.source.observe({provider:'claude', now:at}),
    {accountId:ACCOUNT, reset:weekReset + 2 * WEEK_MS});
  assert.equal(coldWindowAccountWeekProven(state.attempts[0], reading), true);
  const out = transitionEstimatedPace50State(state, resetEvent(state.attempts[0], at, 'two-forward-rollovers', reading));
  assert.equal(out.applied, true, out.reason);
  const ended = out.state.attempts[0].resources.find(resource => resource.id === 'five_hour');
  assert.equal(ended.held_micro, 0);
  assert.equal(ended.unrepresented_micro, 0);
});

test('cold reset freeze: forward-week omission rejects invalid identity and reading evidence', async t => {
  const weekReset = T + 42 * H;
  const rig = await coldResetRig(t, {neverOpened:true, accountWeek:`${ACCOUNT}:weekly:${weekReset}`});
  const initial = rig.s.pace.adapter.state();
  const original = initial.attempts[0];
  const ledger = original.resources.find(resource => resource.id === 'five_hour');
  const at = Math.max(weekReset, ledger.resets_at, original.cleanup_proof_persisted_at + 120_000) + 1;
  const nextReset = weekReset + WEEK_MS;
  const base = await rig.s.source.observe({provider:'claude', now:at});
  const valid = weekReading(base, {accountId:ACCOUNT, reset:nextReset});
  assert.equal(coldWindowAccountWeekProven(original, valid), true);

  const cleanupPreviousReset = ledger.resets_at + 60_000;
  const cleanupAt = cleanupPreviousReset + 120_000;
  const beforeCleanupAt = cleanupAt - 1;
  const beforeCleanupState = structuredClone(initial);
  beforeCleanupState.updated_at = cleanupAt;
  beforeCleanupState.attempts[0].account_week_id = `${ACCOUNT}:weekly:${cleanupPreviousReset}`;
  beforeCleanupState.attempts[0].cleanup_proof_persisted_at = cleanupAt;
  const beforeCleanupReading = weekReading(await rig.s.source.observe({provider:'claude', now:beforeCleanupAt}),
    {accountId:ACCOUNT, reset:cleanupPreviousReset + WEEK_MS});
  assert.equal(coldWindowAccountWeekProven(beforeCleanupState.attempts[0], beforeCleanupReading), true);

  const beforeResetAt = ledger.resets_at - 1;
  const beforeResetState = structuredClone(initial);
  const beforeResetPrevious = ledger.resets_at - 60_000;
  beforeResetState.attempts[0].account_week_id = `${ACCOUNT}:weekly:${beforeResetPrevious}`;
  const beforeResetReading = weekReading(await rig.s.source.observe({provider:'claude', now:beforeResetAt}),
    {accountId:ACCOUNT, reset:beforeResetPrevious + WEEK_MS});
  assert.equal(coldWindowAccountWeekProven(beforeResetState.attempts[0], beforeResetReading), true);

  const rejected = [
    ['wrong account identity', structuredClone(initial), {...valid, identity:{verified:true, account_id:'other-account'}}, at],
    ['older account week', structuredClone(initial), weekReading(base,
      {accountId:ACCOUNT, reset:weekReset - WEEK_MS}), at],
    ['mismatched weekly epoch', structuredClone(initial), weekReading(base,
      {accountId:ACCOUNT, reset:nextReset, epoch:'unrelated-epoch', weeklyInstance:`weekly-${nextReset}`}), at],
    ['failed refresh', structuredClone(initial), {...valid, refresh_succeeded:false}, at],
    ['partial refresh', structuredClone(initial), {...valid, complete:false}, at],
    ['stale reading', structuredClone(initial), valid, at + 60_001],
    ['future reading', structuredClone(initial), {...valid, observed_at:at + 1}, at],
    ['reading before cleanup', beforeCleanupState, beforeCleanupReading, cleanupAt],
    ['reading before reset', beforeResetState, beforeResetReading, ledger.resets_at],
  ];
  for (const [label, state, reading, eventAt] of rejected) {
    const attempt = state.attempts[0];
    if (!['wrong account identity', 'older account week', 'mismatched weekly epoch'].includes(label))
      assert.equal(coldWindowAccountWeekProven(attempt, reading), true, `${label} isolates its evidence check`);
    const out = transitionEstimatedPace50State(state, resetEvent(attempt, eventAt, `forward-negative-${label}`, reading));
    assert.equal(out.applied, false, label);
    assert.equal(out.reason, 'cold_window_unresolved', label);
    assert.deepEqual(out.state, state, label);
  }
});

test('cold reset freeze: a rollover read then restart still needs the omitted-row proof', async t => {
  const weekReset = T + 42 * H;
  const rig = await coldResetRig(t, {neverOpened:true, accountWeek:`${ACCOUNT}:weekly:${weekReset}`});
  const {s} = rig;
  const readings = [];
  const short = rig.before;
  const observe = s.source.observe.bind(s.source);
  s.source.observe = async args => {
    const reading = await observe(args);
    if (args.now < weekReset) return reading;
    const rolled = weekReading(reading, {accountId:ACCOUNT, reset:weekReset + WEEK_MS, omitShort:false});
    const next = args.now < weekReset + 1_000 ? {...rolled, resources:rolled.resources.map(resource => resource.id === 'five_hour'
      ? {...resource, instance:short.instance, state:'open', anchor_at:short.anchor_at, resets_at:short.resets_at, cold_open:false}
      : resource)}
      : {...rolled, resources:rolled.resources.filter(resource => resource.id !== 'five_hour')};
    readings.push(next);
    return next;
  };

  const rolloverAt = weekReset + 1;
  s.set(rolloverAt);
  await s.pace.candidate.probeHeld();
  const first = readings.at(-1);
  assert.ok(first, 'the first sweep read the rolled-over account week');
  assert.equal(first.account_week_id, `${ACCOUNT}:weekly:${weekReset + WEEK_MS}`);
  assert.equal(first.resources.some(resource => resource.id === 'five_hour'), true);
  assert.ok(s.pace.adapter.state().attempts[0].resources.find(resource => resource.id === 'five_hour').held_micro > 0);
  assert.ok(s.pace.adapter.state().attempts[0].resources.find(resource => resource.id === 'five_hour').unrepresented_micro > 0);

  await s.restart();
  const omittedAt = weekReset + 1_001;
  s.set(omittedAt);
  await s.pace.candidate.probeHeld();
  const omitted = readings.at(-1);
  assert.equal(omitted.account_week_id, `${ACCOUNT}:weekly:${weekReset + WEEK_MS}`);
  assert.equal(omitted.resources.some(resource => resource.id === 'five_hour'), false);
  assert.equal(omitted.identity.verified, true);
  assert.equal(omitted.identity.account_id, ACCOUNT);
  assert.equal(omitted.complete, true);
  assert.equal(omitted.refresh_succeeded, true);
  assert.ok(omitted.observed_at >= short.resets_at);
  assert.ok(omitted.observed_at >= rig.row().cleanup_proof_persisted_at + 120_000);
  const settled = s.pace.adapter.state().attempts.find(attempt => attempt.id === 'attempt-1');
  const ended = settled.resources.find(resource => resource.id === 'five_hour');
  assert.equal(ended.held_micro, 0);
  assert.equal(ended.unrepresented_micro, 0);
  assert.equal(settled.hold_closed, true);
});

test('cold native settlement after restart refuses to remap a different not-open window', async t => {
  const phase = {open:null, used:0, weeklyRise:0};
  const s = await coldLender(t, {phase});
  assert.equal((await s.pace.candidate.reserve({attemptId:'restart-remap', jobId:'restart-remap', provider:'claude',
    model:'claude-sonnet-5-5', job:longJob(s.NOW), automatic:true, ownerAbsent:true})).ok, true);
  const attempt = () => s.pace.adapter.state().attempts.find(row => row.id === 'restart-remap');
  const original = structuredClone(attempt().resources.find(resource => resource.id === 'five_hour'));
  await s.pace.candidate.started('restart-remap', {ok:true});
  await s.pace.candidate.recordCleanup('restart-remap', {removed:true});
  await s.pace.candidate.finish({attemptId:'restart-remap', provider:'claude', model:'claude-sonnet-5-5',
    execution:{stdout:'', lending_meter:null}});
  const cleanup = attempt().cleanup_proof_persisted_at;
  await s.restart();

  const observedAt = cleanup + 120_000;
  const observe = s.source.observe.bind(s.source);
  let seen = null;
  s.source.observe = async args => {
    const reading = await observe(args);
    if (args.now >= observedAt) seen = reading.resources.find(resource => resource.id === 'five_hour');
    return reading;
  };
  s.set(observedAt);
  await s.pace.candidate.probeHeld();

  assert.ok(seen?.cold_open, 'the post-restart reading still describes a cold window');
  assert.notEqual(seen.instance, original.instance, 'the provider now reports a different instance');
  assert.ok(Math.abs(seen.resets_at - original.resets_at) > RESET_JITTER_MS, 'the provider reset is outside the match band');
  const current = attempt().resources.find(resource => resource.id === 'five_hour');
  assert.equal(current.held_micro, original.held_micro, 'a different cold window cannot release the reservation');
  assert.equal(current.unrepresented_micro, 0);
  assert.equal(current.native_release_used_micro, undefined);
});


async function weeklyColdInput(t) {
  const ledger = ledgerAt(t, {at:T});
  record(ledger, idleBody, T);
  return policyInput(await sourceOver(ledger, {factAt:() => T}).observe({provider:'claude'}), T + 1_000);
}

test('weekly cold admission refuses before proposing state and leaves the state readable', async t => {
  const input = await weeklyColdInput(t);
  const weekly = input.windows.find(r => r.kind === 'weekly');
  Object.assign(weekly, {cold_open:true, used_micro:0});
  const before = structuredClone(input.state);
  const unopened = structuredClone(input);
  delete unopened.windows.find(r => r.kind === 'weekly').cold_open;
  unopened.windows.find(r => r.kind === 'weekly').state = 'not_open';
  assert.equal(evaluateEstimatedPace50(unopened).reason, 'window_not_open', 'an unopened weekly window keeps its existing hold');
  const out = evaluateEstimatedPace50(input);
  assert.equal(out.admitted, false);
  assert.equal(out.reason, 'cold_window_kind_unsupported');
  assert.deepEqual(out.proposed_state, before);
  assert.deepEqual(out.effects, []);
  const restarted = transitionEstimatedPace50State(JSON.parse(JSON.stringify(out.proposed_state)),
    {type:'on', event_id:'after-restart', at:input.now});
  assert.equal(restarted.applied, true, restarted.reason);
});

test('weekly cold carry refuses before changing either the predecessor or successor state', async t => {
  const input = await weeklyColdInput(t);
  const admitted = evaluateEstimatedPace50(input);
  assert.equal(admitted.admitted, true, admitted.reason);
  const from = admitted.proposed_state.attempts[0].resources.find(r => r.kind === 'weekly');
  const at = from.resets_at + 1_000;
  const late = transitionEstimatedPace50State(admitted.proposed_state,
    {type:'late_ack', event_id:'late-weekly', attempt_id:input.request.attempt_id, at});
  assert.equal(late.applied, true, late.reason);
  const resource = {...from, instance:'next-week', anchor_at:from.resets_at,
    resets_at:from.resets_at + WEEK_MS, used_micro:0, cold_open:true};
  const out = transitionEstimatedPace50State(late.state, {type:'late_start_carried', event_id:'carry-weekly',
    attempt_id:input.request.attempt_id, at, observed_at:at,
    carries:[{from_id:from.id, from_instance:from.instance, resource}]});
  assert.equal(out.applied, false);
  assert.equal(out.reason, 'cold_window_kind_unsupported');
  assert.deepEqual(out.state, late.state);
  const restarted = transitionEstimatedPace50State(JSON.parse(JSON.stringify(out.state)),
    {type:'on', event_id:'after-carry-restart', at});
  assert.equal(restarted.applied, true, restarted.reason);
});

test('weekly cold loader rows are incomplete and never become cold resources', () => {
  const row = {window_id:'seven_day', window_minutes:7 * 24 * 60, state:'open', used_pct:0,
    resets_at:T + WEEK_MS, observed_at:T, source:'probe', cold_open:true};
  const out = resourcesFromReadings([row]);
  assert.equal(out.complete, false);
  assert.deepEqual(out.resources, []);
  const unopened = {...row, state:'not_open', resets_at:null};
  delete unopened.cold_open;
  assert.deepEqual(coldOpenWindows([unopened], T), [unopened], 'weekly windows are not synthesized as lent openings');
});


test('weekly cold rejection preserves the durable store across an adapter restart', async t => {
  const input = await weeklyColdInput(t);
  Object.assign(input.windows.find(r => r.kind === 'weekly'), {cold_open:true, used_micro:0});
  const directory = fs.mkdtempSync(join(tmpdir(), 'cold-weekly-restart-'));
  let adapter;
  t.after(async () => { await adapter?.close(); fs.rmSync(directory, {recursive:true, force:true}); });
  const effects = Object.fromEntries(['arm_cessation_deadline', 'launch_chunk', 'open_short_window',
    'cancel_pending_attempt', 'request_cessation', 'request_fresh_complete_reconciliation']
    .map(type => [type, async () => assert.fail(`rejected input dispatched ${type}`)]));
  const open = () => createPace50Adapter({directory, account:input.account, account_week_id:WEEK,
    now:() => input.now, buildInput:() => input, effects});
  adapter = open();
  const before = adapter.state();
  const out = await adapter.admit({request:input.request, expectedRevision:before.revision});
  assert.equal(out.admitted, false);
  assert.equal(out.reason, 'cold_window_kind_unsupported');
  await adapter.close();
  adapter = open();
  assert.deepEqual(adapter.state(), before);
});

test('probeHeld settles a cold short window then its weekly window across restart only at their own resets', async t => {
  const weeklyOne = {...idleBody, seven_day: {...weeklyBody, utilization: 1}};
  const rig=await settlementReviewRig(t, {initialBody: weeklyOne});
  const initial=Object.fromEntries(rig.row().resources.map(r=>[r.id,r.initial_micro]));
  const shortReset=rig.row().resources.find(r=>r.id==='five_hour').resets_at;
  const weeklyReset=rig.row().resources.find(r=>r.id==='seven_day').resets_at;
  const total=id=>{const r=rig.row().resources.find(r=>r.id===id);return r.held_micro+r.unrepresented_micro;};
  assert.equal(rig.row().cleanup_proven, true);
  const completion = await rig.finish();
  assert.equal(completion.cessation.reason, 'native_usage_held');
  rig.clock.at=shortReset-1;
  rig.reading(weeklyOne);
  await rig.pace.candidate.probeHeld();
  assert.equal(rig.row().hold_closed,false);
  assert.equal(total('five_hour'),initial.five_hour);
  assert.equal(total('seven_day'),initial.seven_day);

  const events=[];
  const transition=rig.pace.adapter.transition.bind(rig.pace.adapter);
  rig.pace.adapter.transition=async (event,options)=>{events.push(structuredClone(event));return transition(event,options);};
  rig.clock.at=shortReset+1000;
  rig.reading(weeklyOne);
  await rig.pace.candidate.probeHeld();
  const reset=events.find(e=>e.type==='window_reset_settled');
  assert.ok(reset,'the real idle sweep emits the reset transition');
  assert.equal(reset.event_id,'review-job:reset:five_hour');
  assert.equal(reset.at,rig.clock.at);
  assert.deepEqual(reset.resource_ids,['five_hour']);
  assert.ok(reset.reading.resources.some(r=>r.id==='five_hour'&&r.cold_open===true),
    'the real source includes its fresh not-open reading as a synthetic cold resource');
  assert.equal(total('five_hour'),0);
  assert.equal(total('seven_day'),initial.seven_day);
  assert.equal(rig.row().hold_closed,false);

  await rig.restart();
  assert.equal(total('five_hour'),0);
  assert.equal(total('seven_day'),initial.seven_day);
  rig.clock.at=weeklyReset-1;
  rig.reading(weeklyOne);
  await rig.pace.candidate.probeHeld();
  assert.equal(rig.row().hold_closed,false);
  assert.equal(total('seven_day'),initial.seven_day);
  rig.clock.at=weeklyReset+1000;
  rig.reading({...idleBody,seven_day:{utilization:0,resets_at:new Date(weeklyReset+7*24*H).toISOString()}});
  await rig.pace.candidate.probeHeld();
  assert.equal(rig.row().hold_closed,true);
  assert.ok(rig.pace.adapter.state().event_ids.includes('review-job:reset:seven_day'));
  for(const r of rig.row().resources){
    assert.equal(r.spent_micro,initial[r.id]);
    assert.equal(r.settled_micro,0);assert.equal(r.released_micro,0);
    assert.equal(r.held_micro,0);assert.equal(r.unrepresented_micro,0);
    assert.ok(r.burns.every(b=>b.represented));
  }
});

test('a post-completion reading settles a ceased cold attempt and lets the next offer lend', async t => {
  const initialReading = {...idleBody, seven_day: {...weeklyBody, utilization: 1}};
  const rig = await settlementReviewRig(t, {initialBody: initialReading});
  const finished = await rig.finish();
  assert.equal(finished.cessation.reason, 'native_usage_held');
  await rig.restart();
  const before = rig.row();
  assert.equal(before.cleanup_proven, true);
  assert.equal(before.resources.find(r => r.id === 'seven_day').baseline_used_micro, M);
  const observations = [];
  const observe = rig.source.observe.bind(rig.source);
  rig.source.observe = async args => {
    const observation = await observe(args);
    observations.push(observation);
    return observation;
  };
  rig.clock.at = rig.cleanupAt + rig.delay;
  await rig.pace.candidate.probeHeld();
  assert.equal(rig.row().hold_closed, false, "a pre-completion reading cannot close the hold");
  rig.clock.at += 70_000;
  rig.reading({...initialReading, seven_day: {...initialReading.seven_day, utilization: 2}});
  await rig.pace.candidate.probeHeld();

  assert.ok(observations.some(o => o?.resources?.some(r => r.id === 'seven_day' && r.used_micro === 2 * M)),
    'the settlement evaluation observed the increased weekly reading');
  const after = rig.row();
  assert.equal(after.hold_closed, true);
  for (const resource of after.resources) {
    assert.equal(resource.held_micro, 0);
    assert.equal(resource.unrepresented_micro, 0);
  }
  const next = await rig.pace.candidate.reserve({attemptId: 'successor', jobId: 'successor',
    provider: 'claude', model: 'claude-sonnet-5-5', ownerAbsent: true,
    job: {requirements: {limits: {wall_seconds: 120}}, expires_at: new Date(T + H).toISOString()}});
  assert.equal(next.ok, true, JSON.stringify(next));
});

for (const type of ['pause', 'stop', 'owner_return']) {
  test(`through the lender: ${type} before preparation releases the full reservation without spend`, async t => {
    const s = await coldLender(t, {phase: {open: null, used: 0, weeklyRise: 0}});
    const job = {requirements: {limits: {wall_seconds: 600}}, expires_at: new Date(s.NOW + 3600e3).toISOString()};
    const grant = await s.pace.candidate.reserve({attemptId: 'attempt-1', jobId: 'job-1', provider: 'claude', model: 'claude-sonnet-5-5',
      job, automatic: true, ownerAbsent: true});
    assert.equal(grant.ok, true, JSON.stringify(grant));
    const cancelled = await s.pace.adapter.transition({type, event_id: `before-preparation-${type}`, at: s.NOW + 1},
      {expectedRevision: s.pace.adapter.state().revision});
    assert.equal(cancelled.applied, true, cancelled.reason);
    assert.equal(s.pace.adapter.state().attempts[0].process_state, 'cancel_requested');
    s.set(s.NOW + 2);
    const released = await s.pace.candidate.release('attempt-1', {prepared: false, reason: type});
    assert.equal(released.applied, true, released.reason);
    const attempt = s.pace.adapter.state().attempts[0];
    assert.equal(attempt.hold_closed, true);
    assert.equal(attempt.cleanup_proven, false, 'no sandbox was prepared or removed');
    assert.equal(attempt.late_ack_unresolved, false);
    for (const r of attempt.resources) {
      assert.equal(r.held_micro, 0);
      assert.equal(r.unrepresented_micro, 0);
      assert.equal(r.spent_micro, 0);
      assert.equal(r.settled_micro, 0);
      assert.equal(r.released_micro, r.initial_micro);
    }
  });
}

test('a job settled on a window that still shows as not open does not hold the next job; its blind use counts against that window', async t => {
  const phase = {open: null, used: 0, weeklyRise: M};
  const s = await coldLender(t, {phase});
  const job = at => ({requirements: {limits: {wall_seconds: 600}}, expires_at: new Date(at + 3600e3).toISOString()});
  const reserve = (n, at) => s.pace.candidate.reserve({attemptId: `attempt-${n}`, jobId: `job-${n}`, provider: 'claude',
    model: 'claude-sonnet-5-5', job: job(at), automatic: true, ownerAbsent: true});
  assert.equal((await reserve(1, s.NOW)).ok, true);
  await s.pace.candidate.started('attempt-1', {ok: true});
  await s.advanceTo(s.NOW + 45_000);
  s.pace.candidate.recordCleanup('attempt-1', {removed: true});
  await s.finishAndSweepAfterLag({attemptId: 'attempt-1', provider: 'claude', model: 'claude-sonnet-5-5',
    execution: {stdout: '', lending_meter: {final: true, cost_usd: 0.5}}});
  const first = s.pace.adapter.state().attempts[0].resources.find(r => r.id === 'five_hour');
  assert.equal(first.held_micro, 0);
  assert.equal(first.unrepresented_micro, M, 'one meter step of blind use stays on the settled cold window');

  // Ten minutes later the window still shows as not open, so the reading's bound reset is ten minutes later than the held one.
  await s.advanceTo(s.NOW + 10 * 60_000);
  const second = await reserve(2, s.NOW + 10 * 60_000);
  assert.equal(second.ok, true, JSON.stringify(second));
  const next = s.pace.adapter.state().attempts.find(a => a.id === 'attempt-2').resources.find(r => r.id === 'five_hour');
  assert.deepEqual([next.instance, next.anchor_at, next.resets_at], [first.instance, first.anchor_at, first.resets_at],
    'the second job is held on the same not-open window, at its earliest reset');
});

test('only a still-not-open window takes the held cold scope, and only while that scope has not reset', async () => {
  const {withHeldColdScope} = await import('../lib/v1/lender-pace50.mjs');
  const heldScope = {id: 'five_hour', instance: 'five_hour@100', anchor_at: 0, resets_at: 100, epoch: 'e', cold_open: true,
    held_micro: 0, unrepresented_micro: M};
  const state = {attempts: [{resources: [heldScope]}]};
  const cold = {id: 'five_hour', instance: 'five_hour@160', anchor_at: 60, resets_at: 160, cold_open: true};
  const opened = {id: 'five_hour', instance: 'five_hour@170', anchor_at: 70, resets_at: 170};
  const at = observation => withHeldColdScope(observation, state, 50).resources[0];
  assert.equal(at({epoch: 'e', resources: [cold]}).resets_at, 100);
  assert.equal(at({epoch: 'e', resources: [opened]}).resets_at, 170, 'an opened window keeps its own reset');
  assert.equal(at({epoch: 'other', resources: [cold]}).resets_at, 160, 'another weekly epoch is another window');
  assert.equal(withHeldColdScope({epoch: 'e', resources: [cold]}, state, 100).resources[0].resets_at, 160,
    'a held scope that has reset settles in full; it is not carried');
  assert.equal(withHeldColdScope({epoch: 'e', resources: [cold]},
    {attempts: [{resources: [{...heldScope, unrepresented_micro: 0}]}]}, 50).resources[0].resets_at, 160, 'nothing held, nothing carried');
});
