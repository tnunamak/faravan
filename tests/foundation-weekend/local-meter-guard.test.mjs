import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeGuard} from '../../lib/v1/lending-native-guard.mjs';

// Conservative partial coverage of the existing guard only. These tests do not
// claim shared AccountUsage ingestion or EnforcementPlan integration is wired.
function fixture(t, read) {
  let now = 1_000, nextTimer = 0;
  const timers = new Map(), stops = [];
  const guard = createNativeGuard({
    now: () => now, read,
    stop: (attemptId, reason) => { stops.push({attemptId, reason}); },
    setTimer: (callback) => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimer: id => timers.delete(id),
  });
  t.after(() => {
    guard.unwatch('attempt-1');
    assert.equal(timers.size, 0);
    assert.deepEqual(guard.watching(), []);
  });
  guard.watch({
    accountId: 'account-1', attemptId: 'attempt-1', provider: 'fixture',
    epoch: 'epoch-1', lastFreshAt: now,
    resources: [{id: 'window-1', instance: 'instance-1', resets_at: 1_000_000,
      baseline_used_micro: 10_000_000, initial_micro: 2_000_000}],
  });
  return {guard, stops, timers, advance: value => { now = value; },
    poll: () => {
      assert.equal(timers.size, 1);
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      callback();
    }};
}

test('partial conservative guard: owner Stop bypasses a never-resolving usage poll', async t => {
  let reads = 0;
  const f = fixture(t, () => { reads++; return new Promise(() => {}); });
  f.poll();
  assert.equal(reads, 1);
  f.advance(900_000);
  assert.equal(f.guard.status('attempt-1').stop_reason, null);
  f.guard.ownerStop('attempt-1');
  await Promise.resolve();
  assert.deepEqual(f.stops, [{attemptId: 'attempt-1', reason: 'owner_stop'}]);
  assert.equal(f.guard.status('attempt-1').cessation_proven, false);
  assert.equal(f.timers.size, 0);
  f.guard.ownerStop('attempt-1');
  await Promise.resolve();
  assert.equal(f.stops.length, 1);
});

test('partial conservative guard: repeated in-band totals preserve baseline and original age', async t => {
  const f = fixture(t, () => null);
  f.advance(20_000);
  const line = used_pct => [{window_id: 'window-1', used_pct, resets_at: 1_000_000}];
  for (let i = 0; i < 3; i++) {
    assert.equal(f.guard.offerInband('attempt-1', line(11)).stopped, false);
  }
  assert.equal(f.guard.status('attempt-1').last_fresh_at, 1_000);
  assert.equal(f.guard.status('attempt-1').stop_reason, null);
  assert.equal(f.stops.length, 0);
  assert.equal(f.guard.offerInband('attempt-1', line(12)).stopped, true);
  await Promise.resolve();
  assert.deepEqual(f.stops, [{attemptId: 'attempt-1', reason: 'allowance_reached'}]);
  assert.equal(f.guard.status('attempt-1').stop_detail.certified, false);
  assert.equal(f.guard.status('attempt-1').last_fresh_at, 1_000);
  assert.equal(f.guard.status('attempt-1').cessation_proven, false);
  f.guard.offerInband('attempt-1', line(15));
  await Promise.resolve();
  assert.equal(f.stops.length, 1);
});
