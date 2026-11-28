import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {createNativeGuard} from '../lib/v1/lending-native-guard.mjs';

import {NOW, ACCOUNT, MICRO as M} from "./helpers/pace50-fixtures.mjs";

// Regression tests for the 1101 security and money reviews of native-window lending. Synthetic evidence only: no provider,
// browser, network or Docker. Each test names the review finding it closes.

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// A deterministic fake clock. Reads resolve as microtasks, so the queue drains them between timers.
function fakeTime(start = NOW) {
  let t = start, seq = 0;
  const timers = new Map();
  const setTimer = (fn, ms) => { const id = ++seq; timers.set(id, {at: t + Math.max(0, ms), fn}); return id; };
  const clearTimer = id => { timers.delete(id); };
  const advanceTo = async until => {
    for (;;) {
      await flush();
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > until) break;
      timers.delete(next[0]); t = next[1].at; next[1].fn(); await flush();
    }
    t = until; await flush();
  };
  return {now: () => t, setTimer, clearTimer, advanceTo};
}
const hostReading = (at, used) => ({refresh_succeeded: true, complete: true, observed_at: at, epoch: 'e',
  identity: {verified: true, account_id: 'a'}, funding: {subscription_only: 'proven'},
  resources: [{id: 'five_hour', instance: 'i', resets_at: NOW + 3_600_000, used_micro: used}]});
const watchFiveHour = guard => guard.watch({attemptId: 'x', provider: 'claude', accountId: 'a', epoch: 'e', lastFreshAt: NOW,
  resources: [{id: 'five_hour', instance: 'i', resets_at: NOW + 3_600_000, baseline_used_micro: 10 * M, initial_micro: 5 * M}]});
// A borrower-forged in-band line: the baseline value, so it reports no rise.
const forged = [{window_id: 'five_hour', used_pct: 10, resets_at: null}];

// Security P1 (in-band meter forgery). The PoC (coldlend-1101/sec-poc.test.mjs) showed forged lines every 10 s kept the host
// meter unread for 30 min with no stop. Pass means safe: the host meter is still read and the job is stopped.
test('forged in-band meter lines cannot starve the host meter read or delay its stop', async () => {
  const clock = fakeTime(); let reads = 0; const stops = [];
  const guard = createNativeGuard({now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    read: async () => { reads++; return hostReading(clock.now(), 90 * M); }, stop: (id, reason) => stops.push([reason, clock.now()])});
  watchFiveHour(guard);
  for (let i = 0; i < 180; i++) {
    await clock.advanceTo(clock.now() + 10_000);
    guard.offerInband('x', forged, clock.now());
  }
  assert.ok(reads >= 1, 'the host meter was read');
  assert.equal(stops.length, 1);
  assert.equal(stops[0][0], 'allowance_reached', 'the host reading stopped the job');
  assert.ok(stops[0][1] <= NOW + 30_000, `stopped at the first host poll (${stops[0][1] - NOW} ms)`);
});

test('forged in-band lines never refresh the stale deadline: a silent host meter still stops the job at F', async () => {
  const clock = fakeTime(); const stops = [];
  const guard = createNativeGuard({now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    read: async () => ({refresh_succeeded: false, probe: {reason: 'account_busy'}}), stop: (id, reason) => stops.push([reason, clock.now()])});
  watchFiveHour(guard);
  for (let i = 0; i < 12; i++) {
    await clock.advanceTo(clock.now() + 10_000);
    guard.offerInband('x', forged, clock.now());
  }
  assert.deepEqual(stops, [['meter_stale', NOW + 60_000]]);
  assert.equal(guard.status('x').last_fresh_at, NOW, 'an in-band line is not a fresh reading');
});

test('an in-band line can still add a stop: a rise at the allowance stops the job', async () => {
  const clock = fakeTime(); const stops = [];
  const guard = createNativeGuard({now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    read: async () => ({refresh_succeeded: false}), stop: (id, reason) => stops.push(reason)});
  watchFiveHour(guard);
  await clock.advanceTo(NOW + 5_000);
  const below = guard.offerInband('x', [{window_id: 'five_hour', used_pct: 14, resets_at: null}], clock.now());
  assert.equal(below.stopped, false);
  assert.equal(below.usable, false, 'an in-band line below the threshold is not a usable reading');
  guard.offerInband('x', [{window_id: 'five_hour', used_pct: 15, resets_at: null}], clock.now());
  await flush();
  assert.deepEqual(stops, ['allowance_reached']);
});

test('a host reading older than an in-band line is still used', async () => {
  const clock = fakeTime(); const stops = [];
  // The host read reports a reading taken 5 s before the read returns; an in-band line arrives in between.
  const guard = createNativeGuard({now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    read: async () => { guard.offerInband('x', forged, clock.now()); return hostReading(clock.now() - 5_000, 90 * M); },
    stop: (id, reason) => stops.push(reason)});
  watchFiveHour(guard);
  await clock.advanceTo(NOW + 20_000);
  guard.offerInband('x', forged, clock.now());
  await clock.advanceTo(NOW + 60_000);
  assert.deepEqual(stops, ['allowance_reached']);
});

// The admission, launch, cleanup and meter settlement of one native job on a pure policy state.

// Money P1 (overshoot not debited). Fixed share 20, per job 5, keep 0. The first job uses 12 points: 5 held and spent, 7 over.

// Security P3 (usage 0 skips the one-point floor). The usage class comes from guest output, so a zero report is not proof.

// A candidate restarted on a directory that holds one started, cleaned-up native attempt.

// Money P2 (settlement scope substitution). A reading of a new short-window instance, before the old instance's recorded reset,
// with the same weekly epoch, must not settle as ordinary use of the old instance.

// Security P3 (restart). After a restart nothing binds the job's stop, so the guard's stop must reach the backend's hard stop.

// Security P2 / money (c) (kappa poisoning). A lent job's USD comes from guest output, and no host-side source prices the job
// (the provider traffic goes from the sandbox through Docker's credential proxy; Faravan reads only the meter). So a lent sample
// may only raise a trusted rate; it can never lower one, and alone it never enables dollar mode.
test('a lent sample cannot lower a trusted rate or establish one alone', async () => {
  const {learnedConversion} = await import('../lib/v1/lending-kappa-lent.mjs');
  assert.equal(typeof learnedConversion, 'function');
  const row = (upper, method) => ({upper_micro: upper, binding: {account_sha256_16: ACCOUNT}, provenance: {method}});
  const logged = row(500_000, 'log'), poisoned = row(1, 'lent-job'), higher = row(900_000, 'lent-job');
  assert.equal(learnedConversion({logged: null, lent: poisoned}), null, 'a cold account stays in native points mode');
  assert.equal(learnedConversion({logged: null, lent: higher}), null, 'even a plausible lent rate alone is not trusted');
  assert.equal(learnedConversion({logged, lent: poisoned}), logged, 'a poisoned low sample never lowers the trusted rate');
  assert.equal(learnedConversion({logged, lent: higher}), higher, 'a higher lent sample only makes points per dollar more conservative');
  assert.equal(learnedConversion({logged, lent: null}), logged);
});
