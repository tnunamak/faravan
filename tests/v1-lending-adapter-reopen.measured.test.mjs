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

function fixture(t, {backend = {}, pendingRecords = () => []} = {}) {
  t.mock.timers.enable({apis:['setInterval']});
  const directory = fs.mkdtempSync(join(homedir(), '.tmp', 'admission-recovery-'));
  let at = NOW, failSave = false, writes = [], permanent = false, afterRename = false;
  const source = createSyntheticPace50Source({start:NOW, override:({base}) => ({...base,
    observed_at:at, resources:base.resources.map(r => ({...r, observed_at:at}))})});
  const opened = [];
  const open = () => {
    const runtime = createLendingRuntime({directory, now:() => at, backend, settings:() => ({intent:'on', limits:{lendingPolicy:{providerConsent:{claude:true}}}}), presence:() => false,
      pace50:{postingLagBoundMs:120000,pendingRecords, account:ACCOUNT, account_week_id:WEEK, source, io:{fsyncSync(fd) {
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
  await f.tick(120_000);
  for (const kind of ['weekly','short']) f.source.state.used[kind] += 1_000_000;
  await runtime.candidate.probeHeld();
  assert.equal(runtime.pace50.state().attempts[0].hold_closed, true);
  assert.equal((await reserve(runtime, 'next')).ok, true);
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
  await f.tick(120_000);
  for (const kind of ['weekly','short']) f.source.state.used[kind] += 1_000_000;
  await runtime.candidate.probeHeld();
  assert.equal(runtime.pace50.state().attempts[0].hold_closed, true);
  assert.equal((await reserve(runtime, 'next')).ok, true);
});
