import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {rig, HOUR, MINUTE, holdOpen} from './helpers/lending-soak.mjs';

for (const native of [false, true]) test(`unknown use, cancel, Stop, reset and resume (${native ? 'native' : 'priced'})`, async t => {
  const f = rig(t); f.meter.native = native;
  const args = f.args('unknown');
  assert.equal((await f.reserve(args)).ok, true);
  await f.pace.candidate.started(args.attemptId, {ok:true});
  await f.pace.candidate.ownerStop({attemptId:args.attemptId,event_id:'stop-unknown',at:f.clock.at});
  await f.pace.candidate.recordCleanup(args.attemptId, {removed:true});
  await f.pace.candidate.finish({...args,execution:{stdout:'',lending_meter:{final:false,cost_usd:0}}});
  const row = f.pace.adapter.state().attempts[0];
  assert.equal(row.cleanup_proven, true);
  if (holdOpen(row)) assert.ok(row.resources.some(r => r.held_micro > 0), 'unknown use cannot silently become zero');
  await f.restart();
  f.clock.at += 48 * HOUR;
  await f.pace.candidate.probeHeld();
  assert.equal(f.pace.adapter.state().attempts.filter(holdOpen).length, 0, 'I1 all-window reset closes unknown use');
  await f.pace.adapter.deliver({type:'on',event_id:'resume-on',at:f.clock.at});
  const grant = await f.reserve(f.args('resume'));
  assert.equal(grant.ok, true, JSON.stringify(grant));
  await f.pace.candidate.ownerStop({attemptId:'resume',event_id:'cancel-resume',at:f.clock.at});
  assert.equal((await f.pace.candidate.release('resume',{prepared:false})).applied, true);
});

test('probe bursts and flaps recover immediately after usable quota returns', async t => {
  const f = rig(t);
  for (const fail of [false,true,true,true,false,true,false,true,false]) {
    f.clock.at += MINUTE; f.meter.fail = fail;
    const args = f.args(), out = await f.reserve(args);
    assert.equal(out.ok, !fail, JSON.stringify(out));
    if (out.ok) await f.pace.candidate.release(args.attemptId,{prepared:false});
    else assert.equal(out.policyReason, 'refresh_failed');
    await f.pace.candidate.probeHeld();
  }
});

test('a full native reservation blocks on headroom until cleanup and reset', async t => {
  const f = rig(t); f.meter.native = true;
  const args = f.args('native-first');
  assert.equal((await f.reserve(args)).ok,true);
  const blocked = await f.reserve(f.args('native-second'));
  assert.equal(blocked.policyReason,'native_attempt_in_flight');
  await f.pace.candidate.started(args.attemptId,{ok:true});
  await f.pace.candidate.recordCleanup(args.attemptId,{removed:true});
  await f.restart(); f.clock.at += 48*HOUR;
  await f.pace.candidate.probeHeld();
  assert.equal((await f.reserve(f.args('native-after-reset'))).ok,true);
});

test('positive priced use closes only after a covering meter and cleanup', async t => {
  const f = rig(t,{candidate:{postingLagBoundMs:120000}}), args = f.args('positive');
  assert.equal((await f.reserve(args)).ok,true);
  await f.pace.candidate.started(args.attemptId,{ok:true});
  f.meter.used += 1_000_000;
  await f.pace.candidate.recordCleanup(args.attemptId,{removed:true});
  const result = await f.pace.candidate.finish({...args,execution:{stdout:'',lending_meter:{final:true,cost_usd:0.1,tokens:{input:100000}}}});
  assert.ok(result.metered.units_micro > 0);
  f.clock.at+=120000;await f.pace.candidate.probeHeld();
  f.meter.used+=1000000;await f.pace.candidate.probeHeld();
  assert.equal(f.pace.adapter.state().attempts[0].hold_closed,true);
});

test('backward clock refuses observation and event without changing durable state', async t => {
  const f = rig(t), args = f.args();
  assert.equal((await f.reserve(args)).ok,true);
  const before = f.pace.adapter.state();
  f.clock.at -= MINUTE;
  const out = await f.pace.adapter.deliver({type:'pause',event_id:'backward',at:f.clock.at});
  assert.equal(out.reason,'event_order');
  const quote = await f.pace.candidate.preview(f.args('backward-job'));
  assert.equal(quote.reason,'adapter_frozen');
  assert.deepEqual(f.pace.adapter.state(),before);
});

test('unpriced models, unreadable settings and owner presence remain named safety holds', async t => {
  const f = rig(t);
  const unpriced = await f.reserve(f.args('unpriced',{model:'synthetic-unpriced-model'}));
  assert.equal(unpriced.policyReason,'model_unpriced');
  const present = await f.reserve(f.args('owner-present',{ownerAbsent:false}));
  assert.equal(present.ok,false);
  const unreadable = rig(t,{candidate:{ownerSettings:{limit:() => ({state:'unreadable'})}}});
  assert.equal((await unreadable.reserve()).policyReason,'owner_settings_unreadable');
});

test('positive priced use closes only after a covering meter and cleanup: aggregate growth still waits for reset', async t => {
  const f = rig(t), args = f.args('positive');
  assert.equal((await f.reserve(args)).ok,true);
  await f.pace.candidate.started(args.attemptId,{ok:true});
  f.meter.used += 1_000_000;
  await f.pace.candidate.recordCleanup(args.attemptId,{removed:true});
  const result = await f.pace.candidate.finish({...args,execution:{stdout:'',lending_meter:{final:true,cost_usd:0.1,tokens:{input:100000}}}});
  assert.ok(result.metered.units_micro > 0);
  const row = () => f.pace.adapter.state().attempts.find(row => row.id === args.attemptId);
  assert.notEqual(row().hold_closed,true,'aggregate growth does not prove interval coverage');
  assert.ok(row().resources.every(r => r.held_micro > 0 && r.released_micro === 0 && r.burns.length > 0));
  const resets = [...new Set(row().resources.map(r => r.resets_at))].sort((a,b) => a-b);
  await f.restart();
  for (const reset of resets) {
    f.clock.at = reset + 1;
    await f.pace.candidate.probeHeld();
    for (const resource of row().resources) {
      assert.equal(resource.released_micro,0,'positive use is conservatively charged, never refunded');
      if (resource.resets_at <= f.clock.at) {
        assert.equal(resource.held_micro,0);
        assert.equal(resource.spent_micro + resource.settled_micro,resource.initial_micro);
      } else assert.ok(resource.held_micro + resource.unrepresented_micro > 0,'another window reset cannot release this resource');
    }
  }
  assert.equal(row().hold_closed,true);
});
