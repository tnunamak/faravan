import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeGuard} from '../lib/v1/lending-native-guard.mjs';

test('an older admission baseline keeps normal polls with no age-only deadline', async () => {
  const now = 1_800_000_000_000;
  const timers = new Map();
  let sequence = 0, reads = 0;
  const guard = createNativeGuard({now:() => now,
    setTimer:(fn, ms) => {const id = ++sequence; timers.set(id, {fn, ms}); return id;},
    clearTimer:id => timers.delete(id), stop:() => assert.fail('the initial grace remains valid'),
    read:async () => {reads++; return {refresh_succeeded:true, complete:true, resources:[],
      identity:{verified:true, account_id:'account'}, funding:{subscription_only:'proven'}, epoch:'epoch', observed_at:now};}});
  const watch = guard.watch({attemptId:'cached', provider:'claude', accountId:'account', epoch:'epoch', resources:[],
    lastFreshAt:now - 5 * 60_000, freshnessMs:4 * 60 * 60_000});
  const firstPoll = timers.get(watch.poll);
  const firstDelay = firstPoll.ms;
  timers.delete(watch.poll);
  firstPoll.fn();
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  const deadlines = [...timers.values()].map(timer => timer.ms);
  guard.unwatch('cached');
  assert.ok(firstDelay <= 30_000, `first poll was ${firstDelay} ms away`);
  assert.equal(reads, 1);
  assert.equal(watch.freshnessMs, 60_000, 'the first usable read ends admission grace');
  assert.equal(deadlines.length, 1);
  assert.ok(deadlines.every(ms => ms <= 60_000));
  assert.ok(deadlines.includes(30_000), 'subsequent polls keep their existing thirty-second interval');
});

test('failed usage reads never Stop for age; owner Stop remains immediate', async () => {
  let now = 1_800_000_000_000;
  const timers = new Map(), stops = [];
  let sequence = 0;
  const guard = createNativeGuard({now:() => now,
    setTimer:(fn, ms) => {const id = ++sequence; timers.set(id, {fn, ms, at:now + ms}); return id;},
    clearTimer:id => timers.delete(id), stop:(id, reason) => {stops.push(reason);},
    read:async () => ({refresh_succeeded:false, complete:false, resources:[], identity:{verified:false}})});
  guard.watch({attemptId:'cached', provider:'claude', accountId:'account', epoch:'epoch', resources:[],
    lastFreshAt:now - 5 * 60_000, freshnessMs:4 * 60 * 60_000});
  const start = now;
  while (!stops.length && timers.size && now - start <= 3 * 60_000) {
    const [id, next] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    timers.delete(id); now = Math.max(now, next.at); next.fn();
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(stops, []);
  guard.ownerStop('cached');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(stops,['owner_stop']);
  guard.unwatch('cached');
});
