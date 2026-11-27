import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT, NOW, WEEK} from './helpers/pace50-fixtures.mjs';

const drain = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
const job = {requirements:{limits:{wall_seconds:300}}, expires_at:new Date(NOW + 86400e3).toISOString(), budget_v1:{max_list_usd:2}};
const reserve = (runtime, id) => runtime.candidate.reserve({attemptId:id, jobId:id, provider:'claude',
  model:'claude-haiku-5-5', job, automatic:true, ownerAbsent:true});

function fixture(t, {native = false, backend = {}, pendingRecords = () => []} = {}) {
  t.mock.timers.enable({apis:['setInterval']});
  const directory = fs.mkdtempSync(join(homedir(), '.tmp', 'admission-recovery-'));
  let at = NOW, failSave = false, stale = false, failures = 0, calls = [];
  const source = createSyntheticPace50Source({start:NOW, override:({base}) => ({...base,
    observed_at:stale ? NOW : at,
    resources:base.resources.map(r => ({...r, observed_at:stale ? NOW : at,
      ...(native ? {conversion:'native_window', kappa_micro:null, kappa_lower_micro:null} : {})}))})});
  const observe = source.observe.bind(source);
  source.observe = args => {
    if (args.forceRefresh === true) {
      calls.push(at);
      if (failures-- > 0) return Promise.reject(new Error('transient read'));
      return observe({...args, now:at}).then(r => ({...r, observed_at:at, resources:r.resources.map(x => ({...x, observed_at:at}))}));
    }
    return observe(args);
  };
  const opened = [];
  const open = () => {
    const runtime = createLendingRuntime({directory, now:() => at, backend, settings:() => ({intent:'on', limits:{lendingPolicy:{providerConsent:{claude:true}}}}), presence:() => false,
      pace50:{pendingRecords, account:ACCOUNT, account_week_id:WEEK, source, io:{fsyncSync(fd) {
        if (failSave) {failSave = false; throw new Error('transient disk');}
        fs.fsyncSync(fd);
      }}}});
    opened.push(runtime);
    return runtime;
  };
  t.after(async () => {for (const r of opened) await r.close(); fs.rmSync(directory, {recursive:true, force:true});});
  return {directory, open, source, saveFails:() => {failSave = true;}, readFails:n => {stale = true; failures = n;},
    fresh:() => {stale = false;}, calls:() => calls, tick:async ms => {at += ms; t.mock.timers.tick(ms); await drain();}, at:() => at};
}

test('a transient save fault reopens on sweep; repeated faults still fail closed', async t => {
  const f = fixture(t);
  const runtime = f.open();
  assert.equal((await reserve(runtime, 'old')).ok, true);
  await runtime.candidate.started('old', {ok:true});
  const before = runtime.pace50.state().attempts[0].resources.map(r => r.held_micro);
  f.saveFails();
  await assert.rejects(runtime.candidate.recordCleanup('old', {removed:true}), /pace50_persist_failed/);
  assert.throws(() => runtime.pace50.state(), /pace50_store_poisoned/);
  // A second failed write during recovery must not expose a usable adapter.
  f.saveFails();
  await assert.rejects(runtime.candidate.probeHeld(), /pace50_persist_failed/);
  assert.throws(() => runtime.pace50.state(), /pace50_store_poisoned/);
  await assert.rejects(reserve(runtime, 'blocked'), /pace50_store_poisoned/);
  await f.tick(120_000);
  await runtime.candidate.probeHeld();
  assert.equal(runtime.pace50.state().attempts[0].cleanup_proven, true);
  assert.deepEqual(runtime.pace50.state().attempts[0].resources.map(r => r.held_micro), before);
  await runtime.pace50.transition({type:'usage_unknown', event_id:'unknown', at:f.at(), attempt_id:'old', provider:'claude'},
    {expectedRevision:runtime.pace50.state().revision});
  for (const [i,kind] of ['weekly','short'].entries()) f.source.state.used[kind] += before[i];
  await runtime.candidate.probeHeld();
  await runtime.candidate.probeHeld();
  const recovered=runtime.pace50.state().attempts[0];
  assert.equal(recovered.hold_closed,false,'aggregate movement does not close unresolved usage');
  assert.ok(recovered.resources.every(r=>r.held_micro+r.unrepresented_micro===r.initial_micro&&r.released_micro===0));
  {const next = await reserve(runtime, 'next'); assert.equal(next.ok, true, JSON.stringify(next));}
});

test('native stopped hold retries failed forced reads and retains exposure through reopen', async t => {
  const f = fixture(t, {native:true});
  let runtime = f.open();
  {const grant = await reserve(runtime, 'old'); assert.equal(grant.ok, true, JSON.stringify(grant));}
  await runtime.candidate.started('old', {ok:true});
  await runtime.candidate.recordCleanup('old', {removed:true});
  const before = runtime.pace50.state().attempts[0].resources.map(r => r.held_micro);
  f.readFails(3);
  runtime.start();
  await f.tick(90_000);
  assert.equal(f.calls().length, 0, 'no forced settlement read before 120 s');
  for (const ms of [30_000, 30_000, 120_000]) {
    await f.tick(ms);
    assert.equal(runtime.pace50.state().attempts[0].hold_closed, false);
    assert.deepEqual(runtime.pace50.state().attempts[0].resources.map(r => r.held_micro), before);
  }
  assert.deepEqual(f.calls(), [NOW + 120_000, NOW + 150_000, NOW + 270_000]);
  await f.tick(270_000);
  assert.equal(f.calls().length, 3);
  await f.tick(30_000);
  assert.equal(f.calls().length, 4);
  let attempt = runtime.pace50.state().attempts[0];
  assert.equal(attempt.hold_closed, false);
  const original=attempt.resources.map(r=>r.initial_micro);
  assert.deepEqual(attempt.resources.map(r => r.held_micro+r.unrepresented_micro), original);
  assert.ok(attempt.resources.every(r => r.spent_micro >= 1_000_000 && r.unrepresented_micro > 0), 'floor remains charged');
  f.fresh();
  {const next=await reserve(runtime, 'uncovered');assert.equal(next.ok,false,JSON.stringify(next));}
  await runtime.close();
  runtime = f.open();
  assert.equal(runtime.pace50.state().attempts[0].hold_closed, false);
  for (const r of attempt.resources) f.source.state.used[r.kind] = r.baseline_used_micro+r.initial_micro;
  f.fresh();
  await runtime.candidate.probeHeld();
  attempt = runtime.pace50.state().attempts[0];
  assert.equal(attempt.hold_closed, false);
  assert.deepEqual(attempt.resources.map(r=>r.held_micro+r.unrepresented_micro),original);
  {const next = await reserve(runtime, 'next'); assert.equal(next.ok,false,'aggregate movement leaves the old hold in place');}
});

for (const permanent of [false, true]) test(`backend removal failure is safe and ${permanent ? 'blocked while permanent' : 'recoverable on retry'}`, async t => {
  let calls = 0;
  const backend = {async reconcilePending(row) {
    calls++;
    if (permanent || calls === 1) throw new Error('backend offline');
    return {attemptId:row.attemptId, removed:true};
  }};
  const f = fixture(t, {backend, pendingRecords:() => [{attemptId:'old'}]});
  let runtime = f.open();
  assert.equal((await reserve(runtime, 'old')).ok, true);
  await runtime.candidate.started('old', {ok:true});
  const held = runtime.pace50.state().attempts[0].resources.map(r => r.held_micro);
  await runtime.close();
  runtime = f.open();
  await runtime.pace50.recover();
  assert.equal(calls, 1);
  assert.notEqual(runtime.pace50.state().attempts[0].cleanup_proven, true);
  assert.deepEqual(runtime.pace50.state().attempts[0].resources.map(r => r.held_micro), held);
  await runtime.pace50.recover();
  assert.equal(calls, 2);
  if (permanent) {
    await runtime.candidate.probeHeld();
    assert.notEqual(runtime.pace50.state().attempts[0].hold_closed, true);
    assert.deepEqual(runtime.pace50.state().attempts[0].resources.map(r => r.held_micro), held);
    return;
  }
  // The lender owns this handoff (lender.mjs:1419-1421): backend removal
  // precedes recordCleanup; adapter.recover itself does not persist that proof.
  await runtime.candidate.recordCleanup('old', {removed:true});
  assert.equal(runtime.pace50.state().attempts[0].cleanup_proven, true);
  await runtime.pace50.transition({type:'usage_unknown', event_id:'unknown', at:f.at(), attempt_id:'old', provider:'claude'},
    {expectedRevision:runtime.pace50.state().revision});
  for (const [i, kind] of ['weekly','short'].entries()) f.source.state.used[kind] += held[i];
  await runtime.candidate.probeHeld();
  await runtime.candidate.probeHeld();
  const recovered=runtime.pace50.state().attempts[0];
  assert.equal(recovered.hold_closed,false,'a retry with aggregate movement still lacks interval coverage');
  assert.ok(recovered.resources.every(r=>r.held_micro+r.unrepresented_micro===r.initial_micro&&r.released_micro===0));
  await runtime.close();
  runtime = f.open();
  assert.equal(runtime.pace50.state().attempts[0].hold_closed,false);
  {const next = await reserve(runtime, 'next'); assert.equal(next.ok, true, JSON.stringify(next));}
});
