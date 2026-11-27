import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnHostOperation} from '../lib/v1/host-command.mjs';

// A fake `faravan host --stop` that exits without printing a result. Only fake processes run.
function fakeCommand({exitAfterMs = 5} = {}) {
  const child = new EventEmitter();
  child.pid = 424244; child.signals = [];
  child.kill = signal => { child.signals.push(signal); return true; };
  child.unref = () => {};
  child.spawn = () => { setTimeout(() => child.emit('exit', 1, null), exitAfterMs); return child; };
  return child;
}
const run = async (t, type) => {
  const dir = await mkdtemp(join(tmpdir(), 'spk-stop-error-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const command = fakeCommand();
  return spawnHostOperation({dir, home: '/srv/app', bin: '/srv/app/bin/faravan', runtime: process.execPath, args: ['--stop'], type,
    spawnProcess: command.spawn, timeoutMs: 2000, stopWaitMs: 500});
};

test('a stop command that fails reports its own failure, not an unverified launcher', async t => {
  await assert.rejects(run(t, 'host_stopped'), error => error.code === 'host_failed');
});

test('a start that fails still needs the launcher cleanup proof', async t => {
  await assert.rejects(run(t, 'host_ready'), {code: 'launcher_unverified'});
});

test('the owner stop through hostCommand reports a failed stop as its own failure after a restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'spk-stop-owner-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const {hostCommand} = await import('../lib/v1/host-command.mjs');
  const command = fakeCommand();
  await assert.rejects(hostCommand({home: dir, coordinatorHome: dir, spawnProcess: command.spawn}, ['--stop'], 'host_stopped'),
    error => error.code === 'host_failed');
});
