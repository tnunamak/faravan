import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {createNativeGuard} from '../lib/v1/lending-native-guard.mjs';

import {LINES, learningLine, learningExpiredLine, learningCreatorUnknownLine, LEARNING_OFF_LINE} from '../lib/v1/lending-status-copy.mjs';
import {planHint} from '../ui/v1/src/lending-policy-view.mjs';

import {until} from "./helpers/v1-lender-fixture.mjs";
import {NOW, MICRO as M} from './helpers/pace50-fixtures.mjs';

// Regression tests for the 1101 round-3 re-review of native-window lending (F1-F3). Synthetic evidence only: no provider,
// browser, network or Docker.
const F = 60_000;

// Review F3. A lent job never sets an account's usage rate, so no copy may say the account learns it from the jobs it lends.
test('the native-window copy says the account lends in points until local agent logs measure a rate', () => {
  const lines = {learning: LINES.learning, learning_ready: LINES.learning_ready, learningLine: learningLine('weekly'),
    learningExpiredLine: learningExpiredLine('five_hour'), learningCreatorUnknownLine: learningCreatorUnknownLine('weekly'),
    LEARNING_OFF_LINE, planHint: planHint()};
  for (const [name, line] of Object.entries(lines)) {
    assert.doesNotMatch(line, /jobs it lends|\blearn(s|ing)\b/i, `${name} claims the account learns its rate: ${line}`);
    assert.doesNotMatch(line, /\d+ ?%|\$\d/, `${name} claims no numeric bound`);
  }
  for (const name of ['learningLine', 'learningExpiredLine'])
    assert.match(lines[name], /Until your local agent logs measure .*it lends in allowance points using the starting estimate\./);
  assert.match(LEARNING_OFF_LINE, /lends in allowance points using the starting estimate/);
  assert.match(LINES.learning, /allowance points/);
  assert.match(LINES.learning_ready, /starting estimate/);
  for (const line of Object.values(lines)) assert.doesNotMatch(line, /against the live meter/);
});

// A deterministic fake clock. Reads resolve as microtasks, so the queue drains them between timers.
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
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
const hostReading = (at, change = {}) => ({refresh_succeeded: true, complete: true, observed_at: at, epoch: 'e',
  identity: {verified: true, account_id: 'a'}, funding: {subscription_only: 'proven', reason: null},
  resources: [{id: 'five_hour', instance: 'i', resets_at: NOW + 3_600_000, used_micro: 10 * M}], ...change});
function guardWith(change) {
  const clock = fakeTime(), stops = [];
  const guard = createNativeGuard({now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    read: async () => hostReading(clock.now(), change), stop: (id, reason) => { stops.push([reason, clock.now()]); }});
  guard.watch({attemptId: 'x', provider: 'claude', accountId: 'a', epoch: 'e', lastFreshAt: NOW,
    resources: [{id: 'five_hour', instance: 'i', resets_at: NOW + 3_600_000, baseline_used_micro: 10 * M, initial_micro: 5 * M}]});
  return {clock, stops};
}

// Missing evidence does not establish a change or exhaustion. The frozen
// contract removes age-only Stop; positive changed identity/funding/epoch still stops.
for (const [fact, unobserved, positive, reason] of [
  ['identity', [{identity: {verified: false, reason: 'identity_unobserved'}}, {identity: {verified: false}}, {identity: null}],
    [{identity: {verified: true, account_id: 'someone-else'}}, {identity: {verified: false, reason: 'identity_mismatch'}}], 'identity_changed'],
  ['funding', [{funding: {subscription_only: 'unknown', reason: 'funding_unobserved'}}, {funding: {subscription_only: 'unknown'}},
    {funding: {subscription_only: 'unknown', reason: 'extra_usage_unobserved'}}, {funding: null}],
    [{funding: {subscription_only: 'unknown', reason: 'extra_usage_enabled'}},
      {funding: {subscription_only: 'unknown', reason: 'alternative_api_provider'}}], 'funding_changed'],
  ['epoch', [{epoch: null}, {epoch: undefined}], [{epoch: 'another-week'}], 'epoch_changed'],
]) test(`missing ${fact} alone does not Stop; positive changed ${fact} still Stops`, async () => {
  for (const change of unobserved) {
    const {clock, stops} = guardWith(change);
    await clock.advanceTo(NOW + 50_000);
    assert.deepEqual(stops, [], `no stop before F on ${JSON.stringify(change)}`);
    await clock.advanceTo(NOW + 120_000);
    assert.deepEqual(stops, [], `missing evidence alone does not prove exhaustion on ${JSON.stringify(change)}`);
  }
  for (const change of positive) {
    const {clock, stops} = guardWith(change);
    await clock.advanceTo(NOW + 120_000);
    assert.deepEqual(stops, [[reason, NOW + F / 2]], `the first poll stops on ${JSON.stringify(change)}`);
  }
});

// Native allowance exhaustion requests the provider-limit stop, with a bounded fallback when its answer never arrives.
