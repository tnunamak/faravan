import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeGuard, nativeOvershootBound} from '../lib/v1/lending-native-guard.mjs';

// Independent oracle: integer time and a true-use ledger. No guard arithmetic,
// status field or production timer helper determines how much the backend used.
function rig(sound) {
  let time = 0, serial = 0, readCount = 0, complete;
  const timers = new Map(), ledger = [], stops = [];
  const backend = {running:true, ceasedAt:null, delivered:false, ceaseAt:Infinity,
    requestStop() {this.delivered = true; this.ceaseAt = time + (sound ? 2 : 5); return {delivered:true};}};
  const setTimer = (fn, delay) => {const id = ++serial; timers.set(id, {at:time + delay, fn}); return id;};
  const guard = createNativeGuard({now:() => time, setTimer, clearTimer:id => timers.delete(id), freshnessMs:4,
    bounds:() => sound ? nativeOvershootBound({q:0, L:1, P:4, T:2, R:1, B:0}) : null,
    read:() => {readCount++; return new Promise(resolve => {complete = resolve;});},
    stop:(id, reason) => {stops.push({id, reason, at:time, spend:ledger.length}); return backend.requestStop();}});
  const resource = {id:'weekly', instance:'w1', resets_at:1000, baseline_used_micro:0, initial_micro:12};
  const watch = guard.watch({attemptId:'one', provider:'claude', accountId:'account', epoch:'epoch',
    resources:[resource], lastFreshAt:0});
  const observation = () => ({refresh_succeeded:true, complete:true, observed_at:time,
    identity:{verified:true, account_id:'account'}, funding:{subscription_only:'proven'}, epoch:'epoch',
    resources:[{...resource, used_micro:0}]});
  const flush = async () => {for (let i = 0; i < 8; i++) await Promise.resolve();};
  async function advance(end) {
    while (time < end) {
      // The interval ending at this tick was spent before cessation at its boundary.
      if (backend.running) for (let i = 0; i < (sound ? 1 : 3); i++) ledger.push({from:time, to:time+1});
      time++;
      if (time >= backend.ceaseAt && backend.running) {backend.running = false; backend.ceasedAt = time;}
      for (;;) {
        const next = [...timers].find(([, t]) => t.at <= time);
        if (!next) break;
        timers.delete(next[0]); next[1].fn(); await flush();
      }
      await flush();
    }
  }
  return {guard, watch, backend, stops, timers, ledger, observation, advance, flush,
    finishRead:() => complete(observation()), reads:() => readCount};
}

for (const sound of [true, false]) test(`hung poll -> stale Stop -> late result -> actual cessation (${sound ? 'sound bounds' : 'uncertified'})`, async t => {
  const f = rig(sound);
  t.after(() => f.guard.unwatch('one'));
  await f.advance(2); // PollStart, Hang
  assert.equal(f.reads(), 1);
  assert.equal(f.watch.reading, true);
  assert.equal(f.stops.length, 0);
  await f.advance(3); // InbandMeter: forged low use must not buy more time
  f.guard.offerInband('one', [{window_id:'weekly', used_pct:0, resets_at:1000}], 3);
  assert.equal(f.guard.status('one').last_fresh_at, 0);
  await f.advance(4); // TimerFire, RequestStop while read is unresolved
  assert.deepEqual(f.stops.map(({reason, at}) => ({reason, at})), [{reason:'meter_stale', at:4}]);
  assert.equal(f.watch.reading, true);
  assert.equal(f.backend.delivered, true);
  assert.equal(f.backend.running, true, 'acknowledgement leaves actual exposure alive');
  assert.equal(f.guard.status('one').cessation_proven, false);
  assert.equal(f.watch.resources[0].certified, sound);
  assert.equal(f.watch.resources[0].thresholdMicro, sound ? 5 : 12);
  f.finishRead(); // PollComplete arrives after halt
  await f.flush();
  assert.equal(f.watch.reading, false);
  assert.equal(f.guard.status('one').last_fresh_at, 0);
  assert.equal(f.timers.size, 0, 'late result arms neither poll nor stale timer');
  await f.advance(9);
  assert.equal(f.backend.running, false);
  assert.equal(f.backend.ceasedAt, sound ? 6 : 9);
  assert.equal(f.reads(), 1);
  const residual = f.ledger.length - f.stops[0].spend;
  assert.equal(residual, sound ? 2 : 15);
  // B_stop = R*T + batch = 1*2+0. Unknown envelopes deliberately violate it.
  assert.equal(residual <= 2, sound);
  assert.equal(f.stops.length, 1);
});

for (const sound of [true, false]) test(`host meter applies ${sound ? 'allowance minus margin' : 'uncertified soft allowance'}`, async t => {
  const f = rig(sound);
  t.after(() => f.guard.unwatch('one'));
  await f.advance(1);
  const reading = f.observation();
  reading.resources[0].used_micro = 5;
  const result = f.guard.offer('one', reading);
  await f.flush();
  assert.equal(result.usable, true);
  assert.equal(f.stops.length, sound ? 1 : 0);
  if (sound) assert.equal(f.guard.status('one').stop_detail.certified, true);
  else {
    reading.resources[0].used_micro = 12;
    f.guard.offer('one', reading); await f.flush();
    assert.equal(f.stops.length, 1);
    assert.equal(f.guard.status('one').stop_detail.certified, false);
  }
});
