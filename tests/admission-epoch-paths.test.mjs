import './helpers/no-browser.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';

import {createNativeGuard} from '../lib/v1/lending-native-guard.mjs';

import {ACCOUNT, NOW, MICRO} from "./helpers/pace50-fixtures.mjs";

// Oracle uses the original allocation as an immutable liability, never policy helpers.

function guardFixture() {
  let at = NOW, next = 0;
  const timers = new Map(), stops = [], binds = [];
  const guard = createNativeGuard({now:() => at, read:async () => null,
    setTimer:(fn,ms) => {timers.set(++next,{fn,at:at + ms});return next;}, clearTimer:id => timers.delete(id),
    stop:(id,reason) => stops.push(reason), onBind:(...args) => binds.push(args)});
  const resource = {id:'short',instance:'reserved',resets_at:NOW + 20000,baseline_used_micro:0,initial_micro:10 * MICRO};
  const watch = cold => guard.watch({attemptId:'a',provider:'claude',accountId:ACCOUNT,epoch:'epoch-1',
    resources:[resource],lastFreshAt:NOW,cold:cold ? ['short'] : []});
  const reading = patch => ({refresh_succeeded:true,complete:true,identity:{verified:true,account_id:ACCOUNT},
    funding:{subscription_only:'proven'},epoch:'epoch-1',observed_at:at,resources:[{...resource,state:'open',used_micro:0}],...patch});
  return {guard, watch, reading, binds, timers, stops, set at(value) {at = value;}};
}

test('cold binding to a later reset retains the original stop boundary and ignores a late read after stop', async () => {
  const f = guardFixture(); const watch = f.watch(true);
  f.at = NOW + 1000;
  const open = f.reading({resources:[{id:'short',instance:'opened',state:'open',used_micro:0,
    anchor_at:NOW + 1000,resets_at:NOW + 21000}]});
  assert.equal(f.guard.offer('a',open).stopped,false);
  assert.equal(f.binds.length,1);
  assert.equal(watch.resources[0].bound.resets_at,NOW + 21000);
  f.at = NOW + 20000;
  assert.equal(f.guard.offer('a',{...open,observed_at:NOW + 20000}).stopped,true);
  assert.equal(watch.stopReason,'window_reset','independent oracle is the reserved 20s, not the opened 21s');
  assert.equal(f.timers.size,0);
  assert.deepEqual(f.guard.offer('a',{...open,observed_at:NOW + 20000}),{usable:false});
  await Promise.resolve(); assert.deepEqual(f.stops,['window_reset']); f.guard.unwatch('a');
});

for (const component of ['account','epoch','instance']) test(`a change to only ${component} cannot reuse the old scope`, async () => {
  const f = guardFixture(); const watch = f.watch(false);
  const observation = f.reading();
  if (component === 'account') observation.identity.account_id = 'another-account';
  if (component === 'epoch') observation.epoch = 'epoch-2';
  if (component === 'instance') observation.resources[0].instance = 'another-short-same-week';
  assert.equal(f.guard.offer('a',observation).stopped,true);
  assert.equal(watch.stopReason,{account:'identity_changed',epoch:'epoch_changed',instance:'window_reset'}[component]);
  assert.equal(f.timers.size,0);
  await Promise.resolve(); assert.equal(f.stops.length,1); f.guard.unwatch('a');
});
