import './helpers/no-browser.mjs';
import {settlePaceAtBound} from './helpers/lending-settle-at-bound.mjs';
import {durableCessationBound} from '../lib/v1/lending-policy.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createNativeGuard} from '../lib/v1/lending-native-guard.mjs';
import {createSyntheticPace50Source, SYNTHETIC_RESET} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT, NOW, WEEK, MICRO, HOUR_MS} from './helpers/pace50-fixtures.mjs';

const shortReset = NOW + SYNTHETIC_RESET.short;
const weekReset = NOW + SYNTHETIC_RESET.weekly;
const job = {budget_v1:{max_list_usd:10}, requirements:{limits:{wall_seconds:300}},
  expires_at:new Date(NOW + 7 * 86400e3).toISOString()};
const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};

function fixture(t, {native = false} = {}) {
  const directory = fs.mkdtempSync(join(homedir(), '.tmp', 'epoch-replay-'));
  const clock = {at:NOW};
  const control = {gate:null, entered:null, changedInstance:false, observationPatch:{}};
  const source = createSyntheticPace50Source({start:NOW, used:{weekly:20 * MICRO, short:0},
    override:({base, now}) => ({...base, ...control.observationPatch, resources:base.resources.map(r => {
      const row = r.kind === 'short' && now >= shortReset
        ? {...r, instance:'short-successor', anchor_at:shortReset, resets_at:shortReset + 5 * HOUR_MS, used_micro:0}
        : control.changedInstance && r.kind === 'short' ? {...r, instance:'corrected-short'} : r;
      return native ? {...row, conversion:'native_window', kappa_micro:null, kappa_lower_micro:null} : row;
    })})});
  const observe = source.observe.bind(source);
  source.observe = async args => {
    if (control.gate) {
      const gate = control.gate; control.gate = null;
      control.entered.resolve(); await gate.promise;
    }
    return observe(args);
  };
  let pace;
  const open = () => (pace = createPace50Candidate({postingLagBoundMs:120000,directory, source, now:() => clock.at, account:ACCOUNT, account_week_id:WEEK}));
  t.after(async () => {control.gate?.resolve(); await pace.adapter.close(); fs.rmSync(directory, {recursive:true, force:true});});
  return {clock, control, source, open, get pace() {return pace;}};
}
const reserve = (f,id) => f.pace.candidate.reserve({attemptId:id, jobId:id, provider:'claude', model:'claude-haiku-5-5',
  job, automatic:true, ownerAbsent:true});
const row = (f,id = 'parent') => f.pace.adapter.state().attempts.find(a => a.id === id);
// Oracle uses the original allocation as an immutable liability, never policy helpers.
function assertConserved(attempt, original) {
  for (const r of attempt.resources) {
    assert.equal(r.spent_micro + r.held_micro + r.released_micro, original.get(r.id));
    assert.ok(r.unrepresented_micro <= r.spent_micro);
  }
}

test('cleanup -> delayed started -> carry -> reopen -> short and weekly reset retain or charge each liability', async t => {
  const f = fixture(t); f.open();
  assert.equal((await reserve(f,'parent')).ok, true);
  const original = new Map(row(f).resources.map(r => [r.id,r.initial_micro]));
  assertConserved(row(f),original);
  await f.pace.candidate.recordCleanup('parent',{removed:true});
  assert.equal(row(f).cleanup_proven,true);
  assertConserved(row(f),original);
  f.clock.at = shortReset + 1000;
  const gate = deferred();
  f.control.gate = gate; f.control.entered = deferred();
  t.after(() => gate.resolve());
  const started = f.pace.candidate.started('parent',{ok:true});
  await f.control.entered.promise;
  assert.equal(row(f).late_ack_unresolved,true);
  assert.equal(row(f).cleanup_proven,false,'the old proof does not prove the delayed execution gone');
  assertConserved(row(f),original);
  const beforeCarry = await f.pace.adapter.transition({type:'window_reset_settled',event_id:'parent:early-reset',
    attempt_id:'parent',at:f.clock.at,authoritative_cessation:true,resource_ids:['five_hour']},
    {expectedRevision:f.pace.adapter.state().revision});
  assert.equal(beforeCarry.applied,false);
  assert.equal(beforeCarry.reason,'late_carry_required');
  assertConserved(row(f),original);
  assert.equal((await reserve(f,'successor')).ok,false,'the new instance cannot use slack before the carry exists');
  assertConserved(row(f),original);
  assert.equal(row(f,'successor'),undefined);
  gate.resolve();
  await started;
  const carryId = 'parent:carry:five_hour:synthetic-five_hour-1';
  assert.equal(row(f,carryId).resources[0].unrepresented_micro,original.get('five_hour'));
  assert.equal(row(f).resources.find(r => r.id === 'five_hour').held_micro,0);
  assertConserved(row(f),original);
  const carryBeforeProof = structuredClone(row(f,carryId));
  // The same persisted old cleanup event cannot apply to the carry's identity.
  const oldEvent = f.pace.adapter.state().event_ids.find(id => id.startsWith('parent:cleanup-proven:'));
  await f.pace.adapter.transition({type:'cleanup_proven',event_id:oldEvent,attempt_id:'parent',at:f.clock.at,cleanup_removed:true},
    {expectedRevision:f.pace.adapter.state().revision});
  assert.deepEqual(row(f,carryId),carryBeforeProof);
  assert.equal(row(f).cleanup_proven,false);
  await f.pace.adapter.close(); f.open();
  assert.deepEqual(row(f,carryId),carryBeforeProof,'durable carry survives volatile registry loss');
  assertConserved(row(f),original);
  // A short reset retains the weekly hold so it can still acquire its own carry.
  const partial = await f.pace.adapter.transition({type:'window_reset_settled',event_id:'parent:short-reset',
    attempt_id:'parent',at:f.clock.at,authoritative_cessation:true,resource_ids:['five_hour']},
    {expectedRevision:f.pace.adapter.state().revision});
  assert.equal(partial.applied,true,JSON.stringify(partial));
  assert.equal(row(f).resources.find(r => r.kind === 'weekly').held_micro,original.get('seven_day'));
  assertConserved(row(f),original);
  assert.equal(row(f,carryId).resources[0].unrepresented_micro,original.get('five_hour'));
  f.clock.at = weekReset + 1000;
  await f.pace.candidate.probeHeld();
  assertConserved(row(f),original);
  assert.equal(row(f).resources.find(r => r.kind === 'weekly').held_micro,original.get('seven_day'),
    'without a successor or fresh cessation proof the weekly hold stays pending');
  assert.equal(row(f).resources.find(r => r.kind === 'weekly').spent_micro,0);
  assert.equal(row(f,carryId).resources[0].spent_micro,original.get('five_hour'));
  // What closes the pending weekly hold: a fresh durable cessation proof gives it a deadline, and the held sweep at that
  // deadline settles it. Until then (above) nothing releases it.
  assert.equal(durableCessationBound(row(f),{state:f.pace.adapter.state()}),null,'no cessation bound exists before a new proof');
  await f.pace.candidate.recordCleanup('parent',{removed:true});
  const bound = durableCessationBound(row(f),{state:f.pace.adapter.state()});
  assert.ok(Number.isSafeInteger(bound),'the new proof gives the weekly hold a durable cessation bound');
  assert.equal(row(f).resources.find(r => r.kind === 'weekly').held_micro,original.get('seven_day'),'a bound alone releases nothing');
  await settlePaceAtBound(f.pace,at => {f.clock.at = at;});
  assert.equal(row(f).resources.find(r => r.kind === 'weekly').held_micro,0,'the deadline closes the weekly hold');
  assertConserved(row(f),original);
  assert.equal(row(f).resources.find(r => r.kind === 'weekly').spent_micro + row(f).resources.find(r => r.kind === 'weekly').released_micro,
    original.get('seven_day'));
});

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


test('same weekly epoch with a different short instance cannot settle a native hold', async t => {
  const f = fixture(t, {native:true}); f.open();
  assert.equal((await reserve(f,'parent')).ok,true);
  const original = new Map(row(f).resources.map(r => [r.id,r.initial_micro]));
  await f.pace.candidate.started('parent',{ok:true});
  assertConserved(row(f),original);
  await f.pace.candidate.recordCleanup('parent',{removed:true});
  const held = row(f).resources.map(r => r.held_micro);
  f.control.changedInstance = true;
  f.clock.at += 120001;
  await f.pace.candidate.finish({attemptId:'parent',provider:'claude',model:'claude-haiku-5-5',
    execution:{stdout:'',lending_meter:null}});
  assert.equal(row(f).hold_closed,false);
  assert.deepEqual(row(f).resources.map(r => r.held_micro),held,
    'new short instance is not coverage of either original liability');
  assertConserved(row(f),original);
  await f.pace.adapter.close(); f.open();
  await f.pace.candidate.probeHeld();
  assert.equal(row(f).hold_closed,false);
  assertConserved(row(f),original);
  f.clock.at = shortReset + 1000;
  await f.pace.candidate.probeHeld();
  assert.equal(row(f).resources.find(r => r.kind === 'short').spent_micro,original.get('five_hour'));
  const weekly=row(f).resources.find(r => r.kind === 'weekly');
  assert.equal(weekly.held_micro+weekly.unrepresented_micro,original.get('seven_day'),
    'the short reset cannot release the still-open weekly liability');
  assert.equal(weekly.released_micro,0);
  assertConserved(row(f),original);
});

for (const component of ['account', 'epoch']) test(`native settlement retains every old liability after only ${component} changes`, async t => {
  const f = fixture(t, {native:true}); f.open();
  assert.equal((await reserve(f,'parent')).ok,true);
  const original = new Map(row(f).resources.map(r => [r.id,r.initial_micro]));
  await f.pace.candidate.started('parent',{ok:true});
  assertConserved(row(f),original);
  await f.pace.candidate.recordCleanup('parent',{removed:true});
  assert.equal(row(f).cleanup_proven,true);
  assertConserved(row(f),original);
  const before = structuredClone(row(f).resources);
  f.control.observationPatch = component === 'account'
    ? {identity:{verified:true,account_id:'another-account'},account_week_id:'another-account-week'}
    : {epoch:'another-epoch'};
  f.clock.at += 120001;
  await f.pace.candidate.finish({attemptId:'parent',provider:'claude',model:'claude-haiku-5-5',
    execution:{stdout:'',lending_meter:null}});
  assert.equal(row(f).hold_closed,false);
  assert.deepEqual(row(f).resources,before,'foreign evidence cannot charge or release the old allocation');
  assertConserved(row(f),original);
  await f.pace.adapter.close(); f.open();
  await f.pace.candidate.probeHeld();
  assert.equal(row(f).hold_closed,false);
  assertConserved(row(f),original);
});
