import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {settleOwnResets} from './helpers/pace50-reset-assertions.mjs';
import {ACCOUNT, NOW, WEEK} from './helpers/pace50-fixtures.mjs';

const drain = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
const job = {requirements:{limits:{wall_seconds:300}}, expires_at:new Date(NOW + 86400e3).toISOString(), budget_v1:{max_list_usd:2}};
const reserve = async (runtime, id) => runtime.candidate.reserve({attemptId:id, jobId:id, provider:'claude',
  model:'claude-haiku-5-5', job:{...job,expires_at:new Date(Math.max(NOW,runtime.pace50.state().updated_at)+86400e3).toISOString()}, automatic:true, ownerAbsent:true});

function fixture(t, {backend = {}, pendingRecords = () => []} = {}) {
  t.mock.timers.enable({apis:['setInterval']});
  const directory = fs.mkdtempSync(join(homedir(), '.tmp', 'admission-recovery-'));
  let at = NOW, failSave = false, writes = [], permanent = false, afterRename = false;
  const resets={weekly:42*3600000,short:1.25*3600000};
  const source = createSyntheticPace50Source({start:NOW,resets, override:({base}) => ({...base,
    observed_at:at, resources:base.resources.map(r => ({...r, observed_at:at}))})});
  const opened = [];
  const open = () => {
    const runtime = createLendingRuntime({directory, now:() => at, backend, settings:() => ({intent:'on', limits:{lendingPolicy:{providerConsent:{claude:true}}}}), presence:() => false,
      pace50:{pendingRecords, account:ACCOUNT, account_week_id:WEEK, source, io:{fsyncSync(fd) {
        writes.push(at);
        if (failSave || permanent) {failSave = false; throw new Error('disk unavailable');}
        fs.fsyncSync(fd);
      }, fsyncDirectory(dir) {
        if (afterRename) {afterRename = false; throw new Error('crash after rename');}
        const fd = fs.openSync(dir, 'r');
        try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
      }}}});
    opened.push(runtime);
    return runtime;
  };
  t.after(async () => {for (const r of opened) await r.close(); fs.rmSync(directory, {recursive:true, force:true});});
  return {directory, open, source, writes:() => writes, permanent:() => {permanent = true;}, crash:() => {afterRename = true;}, saveFails:() => {failSave = true;},
    advance:value=>{at=value;for(const [kind,duration] of [['weekly',7*86400000],['short',5*3600000]]) {
      while(NOW+resets[kind]<=at)resets[kind]+=duration;source.state.used[kind]=0;
    }},
    tick:async ms => {at += ms; t.mock.timers.tick(ms); await drain();}, at:() => at};
}

const disk = f => JSON.parse(fs.readFileSync(join(f.directory, 'lending-pace50-state.json'), 'utf8'));
async function started(runtime, f) {
  assert.equal((await reserve(runtime, 'old')).ok, true);
  await runtime.candidate.started('old', {ok:true});
  await runtime.pace50.transition({type:'usage_unknown', event_id:'unknown', at:f.at(), attempt_id:'old', provider:'claude'},
    {expectedRevision:runtime.pace50.state().revision});
  return runtime.pace50.state().attempts[0].resources.map(r => r.held_micro);
}
async function settleRecoveredAtResets(runtime,f) {
  const attempt=runtime.pace50.state().attempts[0];
  assert.equal(attempt.cleanup_proven,true,'reopening preserves the cleanup proof');
  assert.equal(attempt.hold_closed,false,'aggregate movement cannot certify complete posting');
  assert.ok(attempt.resources.every(r=>r.held_micro+r.unrepresented_micro===r.initial_micro&&r.released_micro===0));
  await settleOwnResets(runtime.pace50,attempt.id);
  f.advance(Math.max(...attempt.resources.map(r=>r.resets_at))+1);
  assert.ok(runtime.pace50.state().attempts[0].resources.every(r=>r.released_micro===0&&
    r.spent_micro+r.settled_micro===r.initial_micro),'own resets charge the complete unresolved envelope');
}
for (const crash of [false, true]) test(`save failure recovers on sweep without restart (after rename: ${crash})`, async t => {
  const f = fixture(t), runtime = f.open();
  const held = await started(runtime, f);
  crash ? f.crash() : f.saveFails();
  await assert.rejects(runtime.candidate.recordCleanup('old', {removed:true}), /pace50_persist_failed/);
  await assert.rejects(reserve(runtime, 'blocked'), /pace50_store_poisoned/);
  assert.deepEqual(disk(f).attempts[0].resources.map(r => r.held_micro), held);
  for (const [i, kind] of ['weekly','short'].entries()) f.source.state.used[kind] += held[i];
  runtime.start();
  await f.tick(30_000);
  await f.tick(30_000);
  await settleRecoveredAtResets(runtime,f);
  assert.equal((await reserve(runtime, 'next')).ok, true);
});

test('permanent save failures keep holds and admission blocked, with sweep backoff', async t => {
  const f = fixture(t), runtime = f.open();
  const held = await started(runtime, f);
  f.permanent();
  await assert.rejects(runtime.candidate.recordCleanup('old', {removed:true}), /pace50_persist_failed/);
  const baseline = f.writes().length;
  runtime.start();
  for (const ms of [30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 300_000]) {
    await f.tick(ms);
    await assert.rejects(reserve(runtime, `blocked-${f.at()}`), /pace50_store_poisoned/);
    assert.deepEqual(disk(f).attempts[0].resources.map(r => r.held_micro), held);
    assert.notEqual(disk(f).attempts[0].hold_closed, true);
  }
  assert.deepEqual(f.writes().slice(baseline), [NOW + 30_000, NOW + 60_000, NOW + 180_000, NOW + 480_000]);
});

test('admission stays fenced while reopen waits for backend recovery', async t => {
  let complete, calls = 0;
  const f = fixture(t, {backend:{reconcilePending() {
    calls++;
    return new Promise(resolve => {complete = () => resolve({attemptId:'old', removed:true});});
  }}, pendingRecords:() => [{attemptId:'old'}]});
  const runtime = f.open();
  await started(runtime, f);
  f.saveFails();
  await assert.rejects(runtime.candidate.recordCleanup('old', {removed:true}), /pace50_persist_failed/);
  const sweep = runtime.candidate.probeHeld();
  await drain();
  assert.equal(calls, 1);
  const otherSweep = runtime.candidate.probeHeld();
  await assert.rejects(reserve(runtime, 'blocked-during-reopen'), /pace50_store_poisoned/);
  complete();
  await Promise.all([sweep, otherSweep]);
  assert.equal(calls, 1);
  assert.equal(runtime.pace50.state().attempts[0].cleanup_proven, true);
});

test('an unknown backend check cannot erase proven cleanup after a failed save', async t => {
  const f = fixture(t, {backend:{async reconcilePending() {throw new Error('offline');}},
    pendingRecords:() => [{attemptId:'old'}]});
  const runtime = f.open(), held = await started(runtime, f);
  f.saveFails();
  await assert.rejects(runtime.candidate.recordCleanup('old', {removed:true}), /pace50_persist_failed/);
  for (const [i, kind] of ['weekly','short'].entries()) f.source.state.used[kind] += held[i];
  runtime.start();
  await f.tick(30_000);
  await f.tick(30_000);
  await settleRecoveredAtResets(runtime,f);
  assert.equal((await reserve(runtime, 'next')).ok, true);
});

test('a failed recovery stop stays fenced and retries on the sweep cadence', async t => {
  const f = fixture(t), runtime = f.open();
  await started(runtime, f);
  let calls = 0;
  runtime.candidate.registry.bind('old', {stop:async () => {
    if (++calls === 1) throw new Error('stop unavailable');
  }});
  f.saveFails();
  await assert.rejects(runtime.candidate.recordCleanup('old', {removed:true}), /pace50_persist_failed/);
  runtime.start();
  await f.tick(30_000);
  assert.equal(calls, 1);
  await assert.rejects(reserve(runtime, 'blocked'), /pace50_store_poisoned/);
  await f.tick(30_000);
  assert.equal(calls, 2);
  assert.equal(runtime.pace50.state().attempts[0].cleanup_proven, true);
});

test('shutdown drains a replacement even if a recovery stop never returns', async t => {
  const f = fixture(t), runtime = f.open();
  await started(runtime, f);
  runtime.candidate.registry.bind('old', {stop:() => new Promise(() => {})});
  f.saveFails();
  await assert.rejects(runtime.candidate.recordCleanup('old', {removed:true}), /pace50_persist_failed/);
  void runtime.candidate.probeHeld();
  await drain();
  await runtime.close({drainMs:1});
  const reopened = f.open();
  assert.notEqual(reopened.pace50.state().attempts[0].hold_closed, true);
});
