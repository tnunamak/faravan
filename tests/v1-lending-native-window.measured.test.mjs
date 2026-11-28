import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {createNativeGuard} from "../lib/v1/lending-native-guard.mjs";
import {lentCalibrationSamples} from "../lib/v1/lending-kappa-lent.mjs";

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

// Design test 3: an adversarial burner at the largest rate, read with lag and quantization, polled by the guard's own timers.
// Design test 4.
// Design tests 5 and 6: calibration filters.
const attemptFor = (patch = {}) => ({id: 'att-1', epoch: 'epoch-1', cleanup_proof_persisted_at: NOW,
  resources: [{id: 'seven_day', conversion: 'native_window', instance: 'w1', resets_at: NOW + 86_400_000, baseline_used_micro: 20 * M}], ...patch});
const settled = (patch = {}, used = 24 * M) => ({refresh_succeeded: true, complete: true, epoch: 'epoch-1', observed_at: NOW + 1_000,
  identity: {verified: true, account_id: ACCOUNT}, funding: {subscription_only: 'proven'},
  resources: [{id: 'seven_day', instance: 'w1', resets_at: NOW + 86_400_000, used_micro: used}], ...patch});
const sample = (over = {}) => lentCalibrationSamples({attempt: attemptFor(), reading: settled(), usdMicro: 2 * M, provider: 'claude',
  model: 'claude-sonnet-5-5', accountId: ACCOUNT, now: NOW, ...over});

// Design test 7.

// Design test 8.
// Design test 9.
// Design test 10 (status copy; the mounted Setup check is in ui/v1/src/setup-mounted.test.mjs).
test('a skipped carry contributes no calibration sample; an adjacent carry still can', () => {
  const attempt = attemptFor();
  attempt.id = 'owner:carry:seven_day:old';
  assert.deepEqual(sample({attempt}).samples, [], 'a legacy carry has unknown adjacency');
  attempt.resources[0].skipped_periods = 2;
  assert.deepEqual(sample({attempt}).samples, []);
  attempt.resources[0].skipped_periods = 0;
  assert.equal(sample({attempt}).samples.length, 1);
});

// A legacy full charge marks the attempt's usage unknown. Its remaining exposure was charged in full, so no later reading,
// even one covered by a measured posting bound, may reconcile it as native use.
