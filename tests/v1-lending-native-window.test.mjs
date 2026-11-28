import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {createNativeGuard, nativeOvershootBound} from "../lib/v1/lending-native-guard.mjs";
import {createLentKappaStore, lentCalibrationSamples, LENT_LABEL} from '../lib/v1/lending-kappa-lent.mjs';
import {MEASUREMENT_MAX_AGE_MS} from '../lib/v1/lending-kappa-measure.mjs';
import {LINES, lendingStatus} from '../lib/v1/lending-status-copy.mjs';

import {NOW, ACCOUNT, MICRO as M} from "./helpers/pace50-fixtures.mjs";

// Native-window mode (design 1101): an account with no measured conversion lends at once in its own window points.
// Entirely synthetic evidence and effect handlers. No provider, browser, network or Docker.

// A deterministic fake clock and timer queue. Reads resolve as microtasks, so the queue drains them between timers.
function fakeTime(start = NOW) {
  let t = start, seq = 0;
  const timers = new Map();
  const setTimer = (fn, ms) => { const id = ++seq; timers.set(id, {at: t + Math.max(0, ms), fn}); return id; };
  const clearTimer = id => { timers.delete(id); };
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  // Run every timer due by `until`, in time order, with the clock at each timer's due time.
  const advanceTo = async (until, onTick = null) => {
    for (;;) {
      await flush();
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > until) break;
      timers.delete(next[0]);
      t = next[1].at;
      onTick?.(t);
      next[1].fn();
      await flush();
    }
    t = until;
    onTick?.(t);
    await flush();
  };
  return {now: () => t, setTimer, clearTimer, advanceTo, pending: () => timers.size};
}
const reading = (at, used, patch = {}) => ({refresh_succeeded: true, complete: true, observed_at: at, epoch: 'epoch-1',
  identity: {verified: true, account_id: ACCOUNT}, funding: {subscription_only: 'proven'},
  resources: [{id: 'weekly', instance: 'weekly-1', resets_at: NOW + 3 * 86_400_000, used_micro: used}], ...patch});
const watched = (guard, {allowance = 10 * M, baseline = 20 * M, lastFreshAt = NOW} = {}) => guard.watch({attemptId: 'a1',
  provider: 'claude', accountId: ACCOUNT, epoch: 'epoch-1', lastFreshAt,
  resources: [{id: 'weekly', instance: 'weekly-1', resets_at: NOW + 3 * 86_400_000, baseline_used_micro: baseline, initial_micro: allowance}]});

// Design test 1.

// Design test 2 (admission half).

// Design test 2 (watchdog half): no token events, a failing read and a hung read.
for (const [label, read] of [['failing', async () => { throw new Error('unreadable'); }], ['hung', () => new Promise(() => {})],
  ['account busy', async () => ({refresh_succeeded: false, reason: 'account_busy'})]]) {
  test(`the watchdog stops a job whose meter goes silent (${label} read), with no token events`, async () => {
    const clock = fakeTime(), stops = [];
    const guard = createNativeGuard({now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, read,
      stop: (id, reason) => stops.push([id, reason, clock.now()])});
    watched(guard);
    await clock.advanceTo(NOW + 59_999);
    assert.deepEqual(stops, [], 'within the freshness bound');
    await clock.advanceTo(NOW + 60_000);
    assert.deepEqual(stops, [['a1', 'meter_stale', NOW + 60_000]]);
    assert.equal(guard.status('a1').cessation_proven, false, 'a stop request is not cessation');
  });
}

test('the watchdog keeps a quietly read job alive, and stops it on reset, identity, funding or owner stop', async () => {
  for (const [label, patch, reason] of [
    ['reset', {resources: [{id: 'weekly', instance: 'weekly-2', resets_at: NOW + 10 * 86_400_000, used_micro: 0}]}, 'window_reset'],
    ['identity', {identity: {verified: true, account_id: 'someone-else'}}, 'identity_changed'],
    ['funding', {funding: {subscription_only: 'unknown', reason: 'extra_usage_enabled'}}, 'funding_changed'],
    ['epoch', {epoch: 'epoch-2'}, 'epoch_changed']]) {
    const clock = fakeTime(), stops = [];
    let next = 'quiet';
    const guard = createNativeGuard({now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      read: async () => next === 'quiet' ? reading(clock.now(), 21 * M) : reading(clock.now(), 21 * M, patch),
      stop: (id, why) => stops.push(why)});
    watched(guard);
    await clock.advanceTo(NOW + 10 * 60_000);
    assert.deepEqual(stops, [], `${label}: fresh readings keep a quiet job alive past the freshness bound`);
    next = 'changed';
    await clock.advanceTo(NOW + 12 * 60_000);
    assert.deepEqual(stops, [reason], label);
  }
  const clock = fakeTime(), stops = [];
  const guard = createNativeGuard({now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    read: async () => reading(clock.now(), 21 * M), stop: (id, why) => stops.push(why)});
  watched(guard);
  guard.ownerStop('a1');
  await clock.advanceTo(NOW + 1);
  assert.deepEqual(stops, ['owner_stop']);
});

// Design test 3: an adversarial burner at the largest rate, read with lag and quantization, polled by the guard's own timers.
test('an adversarial fast burner stays within the derived bound q + R*(L+P+T) + B', async () => {
  const F = 60_000, L = 20_000, T = 5_000, readMs = 2_000, B = 0;
  const R = 2 * M / 60_000; // two points a minute, in micro-points per ms
  const P = F / 2 + readMs; // the guard's first poll waits F/2; each later read leaves room for twice the measured read time
  const bound = nativeOvershootBound({L, P, T, R, B});
  assert.equal(bound.certified, true);
  for (const certified of [true, false]) {
    for (const burstDelay of [0, 1, readMs + 1, 7_000]) {
      const clock = fakeTime(), baseline = 20 * M, allowance = 30 * M;
      let stopAt = null;
      // True use: idle until just after a poll, then the full rate R until T after the stop decision.
      const startAt = NOW + burstDelay;
      const use = at => Math.max(0, Math.min(at, stopAt === null ? at : stopAt + T) - startAt) * R;
      const shown = at => baseline + Math.floor(use(at - L) / M) * M; // the meter lags L and shows whole points
      const guard = createNativeGuard({now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
        bounds: () => certified ? bound : null,
        read: async () => { const at = clock.now(); await new Promise(r => clock.setTimer(r, readMs)); return reading(at, shown(at)); },
        stop: () => { stopAt ??= clock.now(); }});
      watched(guard, {allowance, baseline});
      await clock.advanceTo(NOW + 3 * 3_600_000);
      assert.ok(stopAt !== null, 'the guard stopped the burner');
      const overshoot = use(stopAt + T + 1) - allowance;
      assert.ok(overshoot <= bound.marginMicro, `overshoot ${overshoot} <= ${bound.marginMicro} (delay ${burstDelay}, certified ${certified})`);
      if (certified) assert.ok(overshoot <= 0, `a certified threshold keeps the burner inside the allowance (${overshoot})`);
    }
  }
});

// Design test 4.

// Design tests 5 and 6: calibration filters.
const attemptFor = (patch = {}) => ({id: 'att-1', epoch: 'epoch-1', cleanup_proof_persisted_at: NOW,
  resources: [{id: 'seven_day', conversion: 'native_window', instance: 'w1', resets_at: NOW + 86_400_000, baseline_used_micro: 20 * M}], ...patch});
const settled = (patch = {}, used = 24 * M) => ({refresh_succeeded: true, complete: true, epoch: 'epoch-1', observed_at: NOW + 1_000,
  identity: {verified: true, account_id: ACCOUNT}, funding: {subscription_only: 'proven'},
  resources: [{id: 'seven_day', instance: 'w1', resets_at: NOW + 86_400_000, used_micro: used}], ...patch});
const sample = (over = {}) => lentCalibrationSamples({attempt: attemptFor(), reading: settled(), usdMicro: 2 * M, provider: 'claude',
  model: 'claude-sonnet-5-5', accountId: ACCOUNT, now: NOW, ...over});

test('a settled, aligned, plan-funded lent job gives an upper-envelope rate; zero rise never gives a zero rate', () => {
  const ok = sample();
  assert.equal(ok.samples.length, 1);
  // k = (rise + q) / D, rounded up: (4 + 1) points over $2.
  assert.equal(ok.samples[0].upper_micro, Math.ceil(5 * M * M / (2 * M)));
  assert.equal(ok.samples[0].provenance.label, LENT_LABEL);
  assert.equal(ok.samples[0].binding.account_sha256_16, ACCOUNT);
  for (const used of [20 * M, 20 * M + M / 2])
    assert.deepEqual(sample({reading: settled({}, used)}).samples, [], 'below one shown point is no evidence, never zero');
  assert.deepEqual(sample({reading: settled({observed_at: NOW - 1})}).samples, [], 'a reading before the cleanup proof is unsettled');
});

test('API-paid or unknown funding, another account, a reset, a wrong model, a full meter or no price never calibrate', () => {
  const cases = {
    api: {reading: settled({funding: {subscription_only: 'disproven'}})},
    unknown_funding: {reading: settled({funding: {subscription_only: 'unknown'}})},
    other_account: {reading: settled({identity: {verified: true, account_id: 'ffffffffffffffff'}})},
    unverified: {reading: settled({identity: {verified: false, account_id: ACCOUNT}})},
    reset: {reading: settled({resources: [{id: 'seven_day', instance: 'w2', resets_at: NOW + 8 * 86_400_000, used_micro: 24 * M}]})},
    epoch: {reading: settled({epoch: 'epoch-2'})},
    censored: {reading: settled({}, 100 * M)},
    unpriced: {usdMicro: 0},
    unpriced_null: {usdMicro: null},
    model_family: {attempt: attemptFor({resources: [{id: 'seven_day_opus', conversion: 'native_window', instance: 'w1',
      resets_at: NOW + 86_400_000, baseline_used_micro: 20 * M}]}), reading: settled({resources: [{id: 'seven_day_opus', instance: 'w1',
      resets_at: NOW + 86_400_000, used_micro: 24 * M}]})},
    not_native: {attempt: attemptFor({resources: [{id: 'seven_day', conversion: 'measured', instance: 'w1', resets_at: NOW + 86_400_000, baseline_used_micro: 20 * M}]})},
  };
  for (const [label, over] of Object.entries(cases)) assert.deepEqual(sample(over).samples, [], label);
});

test('a replayed or copied settlement counts once, the store keeps the highest unexpired envelope, and expiry returns to native mode', t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'native-lent-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  let now = NOW + 1_000;
  const file = join(directory, 'lent.json');
  const store = createLentKappaStore({file, now: () => now});
  const first = sample().samples;
  assert.equal(store.record(first), true);
  assert.equal(store.record(first), false, 'the same attempt counts once');
  assert.equal(createLentKappaStore({file, now: () => now}).record(first), false, 'even after a restart');
  const lower = sample({attempt: attemptFor({id: 'att-2'}), reading: settled({}, 22 * M)}).samples;
  store.record(lower);
  assert.equal(store.current({accountId: ACCOUNT, resource: 'claude:seven_day'}).upper_micro, first[0].upper_micro, 'the highest envelope stays');
  assert.equal(store.current({accountId: 'ffffffffffffffff', resource: 'claude:seven_day'}), null, 'never for another account');
  now = first[0].expires_at;
  assert.equal(store.current({accountId: ACCOUNT, resource: 'claude:seven_day'}), null, 'expired: back to native mode, not a hold');
  assert.equal(first[0].expires_at - first[0].evidence_end_at, MEASUREMENT_MAX_AGE_MS);
});

// Design test 7.

// Design test 8.

// Design test 9.

// Design test 10 (status copy; the mounted Setup check is in ui/v1/src/setup-mounted.test.mjs).
test('status shows lending-while-learning distinctly from a telemetry hold', () => {
  const lending = lendingStatus({admitted: true, active: true, conversion: 'native_window'});
  assert.equal(lending.id, 'learning');
  assert.equal(lending.line, "Lending now in allowance points · no measured usage rate yet.");
  const ready = lendingStatus({admitted: true, reasonCode: 'objective_lend_native'});
  assert.equal(ready.id, 'learning_ready');
  for (const reason of ['native_guard_meter_stale', 'refresh_failed', 'reading_stale']) {
    const hold = lendingStatus({reason});
    assert.equal(hold.id, 'measured', reason);
    assert.doesNotMatch(hold.line, /learning/);
  }
  assert.equal(lendingStatus({reason: 'native_attempt_in_flight'}).id, 'native_pending');
  for (const line of Object.values(LINES)) assert.doesNotMatch(line, /measuring|hasn't recorded the use/);
});

test('an unreadable lent envelope is unknown: record refuses, the bytes survive and the app can tell', t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'native-lent-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const file = join(directory, 'lent.json');
  for (const bytes of ['{"version":1,"rows":{"claude', JSON.stringify({version: 2, rows: {}})]) {
    fs.writeFileSync(file, bytes);
    const store = createLentKappaStore({file, now: () => NOW + 1_000});
    assert.equal(store.unknown, true);
    assert.equal(store.current({accountId: ACCOUNT, resource: 'claude:seven_day'}), null);
    assert.throws(() => store.record(sample().samples), {code: 'state_unknown'});
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  }
  fs.rmSync(file);
  const fresh = createLentKappaStore({file, now: () => NOW + 1_000});
  assert.equal(fresh.unknown, false, 'a missing file is absent, not unknown');
  assert.equal(fresh.record(sample().samples), true);
});
