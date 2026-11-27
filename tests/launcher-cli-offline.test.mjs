import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, stat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {offlineOperationStatus, quitOfflineApp} from '../lib/v1/ops/offline-app.mjs';
import {residentQuit} from '../lib/v1/resident-intent.mjs';

const failure = {version:1, code:'sandbox_start_failed', kind:'Error', at:123};
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'launcher-cli-offline-'));
  t.after(() => rm(home, {recursive:true, force:true}));
  await mkdir(join(home, 'v1'));
  return home;
}
const record = (home, value) => writeFile(join(home, 'v1', 'app.json'), JSON.stringify(value));

test('operation status preserves the documented blockers/lending schema and sanitizes startup evidence', async t => {
  const home = await fixture(t);
  assert.equal(offlineOperationStatus(home), null);
  await writeFile(join(home, 'v1', 'start-failure.json'), JSON.stringify({...failure, message:'secret-token /Users/private', stack:'private'}));
  const result = offlineOperationStatus(home);
  assert.ok(Array.isArray(result.blockers));
  assert.equal(result.lending.app_running, false);
  assert.equal(result.lending.enabled, false);
  assert.deepEqual(result.lending.start_failure, failure);
  assert.equal(result.summary.phase, 'waiting');
  assert.equal(result.summary.reason, 'The protected workspace could not start.');
  assert.equal(Object.hasOwn(result, 'start_failure'), false);
  assert.equal(Object.hasOwn(result, 'running'), false);
  assert.doesNotMatch(JSON.stringify(result), /secret-token|Users|private|stack/);
});

test('unreachable operation status does not assert the live app or lending stopped', async t => {
  const home = await fixture(t);
  await writeFile(join(home, 'v1', 'start-failure.json'), JSON.stringify(failure));
  const result = offlineOperationStatus(home, {unreachable:true});
  assert.equal(result.lending.app_running, null);
  assert.equal(result.lending.enabled, null);
  assert.deepEqual(result.lending.start_failure, failure);
  await record(home, {pid:process.pid});
  assert.equal(offlineOperationStatus(home).lending.app_running, null);
  await writeFile(join(home, 'v1', 'app.json'), '{broken');
  assert.equal(offlineOperationStatus(home).lending.enabled, null);
});

test('missing and malformed saved failure never replace normal status behavior', async t => {
  const home = await fixture(t);
  await writeFile(join(home, 'v1', 'app.json'), '{broken');
  assert.equal(offlineOperationStatus(home), null);
  for (const saved of ['{broken', 'null', JSON.stringify({...failure, code:'private-value'}), JSON.stringify({...failure, at:-1})]) {
    await writeFile(join(home, 'v1', 'start-failure.json'), saved);
    assert.equal(offlineOperationStatus(home), null);
  }
});

test('confirmed offline quit records durable intent without changing the saved failure', async t => {
  const home = await fixture(t);
  await writeFile(join(home, 'v1', 'start-failure.json'), JSON.stringify(failure));
  assert.equal(residentQuit(home), false);
  assert.equal(await quitOfflineApp(home), true);
  assert.equal(residentQuit(home), true);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'v1', 'resident-intent.json'), 'utf8')), {version:1, quit:true});
  assert.equal((await stat(join(home, 'v1', 'resident-intent.json'))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'v1', 'start-failure.json'), 'utf8')), failure);
  assert.equal(await quitOfflineApp(home), true);
});

test('dead app discovery permits stopping a resident startup retry', async t => {
  const home = await fixture(t);
  const child = spawn(process.execPath, ['-e', ''], {stdio:'ignore'});
  await once(child, 'exit');
  await record(home, {pid:child.pid, port:12345, token:'test-token'});
  assert.equal(await quitOfflineApp(home), true);
  assert.equal(residentQuit(home), true);
});

test('a live process must use authenticated shutdown and cannot be bypassed', async t => {
  const home = await fixture(t);
  for (const value of [{pid:process.pid, port:12345, token:'test-token'}, {pid:process.pid}]) {
    await record(home, value);
    assert.equal(await quitOfflineApp(home), false);
    assert.equal(residentQuit(home), false);
  }
});

test('unreadable or malformed discovery is unknown, never permission to quit', async t => {
  const home = await fixture(t);
  for (const value of [null, {}, {pid:0}, {pid:-1}, {pid:'123'}, {pid:1.5}]) {
    await record(home, value);
    assert.equal(await quitOfflineApp(home), false);
    assert.equal(residentQuit(home), false);
  }
  await writeFile(join(home, 'v1', 'app.json'), '{broken');
  assert.equal(await quitOfflineApp(home), false);
  await rm(join(home, 'v1', 'app.json'));
  await mkdir(join(home, 'v1', 'app.json'));
  assert.equal(await quitOfflineApp(home), false);
  assert.equal(residentQuit(home), false);
});

test('a cancelled offline quit writes no resident intent', async t => {
  const home = await fixture(t), abort = new AbortController();
  abort.abort();
  assert.equal(await quitOfflineApp(home, {signal:abort.signal}), false);
  assert.equal(residentQuit(home), false);
});
