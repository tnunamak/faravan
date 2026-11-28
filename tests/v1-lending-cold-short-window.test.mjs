import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {createNativeGuard} from '../lib/v1/lending-native-guard.mjs';

import {MICRO as M} from "./helpers/pace50-fixtures.mjs";

// An idle owner: no five-hour session open, so the provider answers `"five_hour": null`, with a fresh seven-day reading.
// Synthetic evidence only. The readings go through the production parser, ledger, source and policy. No provider, browser,
// network or Docker.
const T = Date.parse('2026-11-01T17:40:00.250Z');
const H = 3_600_000, FIVE_H = 5 * H, WEEK_MS = 7 * 24 * H;
const HASH = {account: '1111222233334444', email: 'aaaa0000bbbb1111'};

// One ledger that the probe writes, read the way the app reads it.

// The real source over that ledger. `factAt` is the time of the run that read the identity, funding, executor and stop.

// The policy input the lender builds from the observation, with the normal rule at the dial: no stubbed decision.

// The ledger shape seen on 2026-11-01: the last five-hour row is a session that closed the day before, and the seven-day row
// is read every 15 minutes since.

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

// Round 3 (the money review of 2d55d4a2): who opened the window, a late first use, and reset jitter.

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

// Real parser, ledger, source and durable candidate; only strategy history is fixture evidence.

// The adapter account names the local store (a device key in the app), not the provider account.

