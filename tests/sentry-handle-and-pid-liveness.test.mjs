import './helpers/no-browser.mjs';
import './helpers/short-sbx-home.mjs';
import test from 'node:test';
import { systemdShowEnvironment } from './helpers/systemd-environment.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerSbxBackend, restartSbxDaemon, waitForProcessExit } from '../lib/docker-backend.mjs';

// A disk watch belongs to one prepared sandbox. A stale handle that reuses a sandbox name must not stop the
// watch of the sandbox that replaced it, and a process that this user may not signal must not count as exited.

const GiB = 1024 ** 3;
const backend = () => new DockerSbxBackend({ hostDisk: { free: async () => ({ free: 20 * GiB }) } });

test('a stale handle cannot close the disk watch of the sandbox that replaced it', () => {
  const b = backend();
  const stale = { sandbox_id: 'wf-reused' };
  const first = b._diskSentry(stale);
  b._closeDiskSentry(stale);
  assert.equal(first.closed, true);
  b._diskRemoved.delete('wf-reused'); // a retried job reuses the name
  const replacement = { sandbox_id: 'wf-reused' };
  const second = b._diskSentry(replacement);

  b._closeDiskSentry(stale);

  assert.equal(second.closed, false, 'the replacement watch is still open');
  assert.equal(b._diskSentries.get('wf-reused'), second);
  assert.equal(b._diskRemoved.has('wf-reused'), false, 'the replacement is not marked removed');
  b._closeDiskSentry(replacement);
  assert.equal(second.closed, true, 'its own handle still closes it');
  assert.equal(b._diskRemoved.has('wf-reused'), true);
});

test('a copy of a handle closes the watch its original opened', () => {
  const b = backend();
  const handle = { sandbox_id: 'wf-copy' };
  const sentry = b._diskSentry(handle);
  b._closeDiskSentry({ ...handle });
  assert.equal(sentry.closed, true);
  assert.equal(b._diskSentries.has('wf-copy'), false);
});

const errno = code => Object.assign(new Error(code), { code });

test('EPERM from the liveness probe means the process is alive, not exited', async () => {
  let probes = 0;
  const kill = () => { if (++probes < 3) throw errno('EPERM'); throw errno('ESRCH'); };
  assert.equal(await waitForProcessExit(7, { timeoutMs: 5000, kill }), true);
  assert.equal(probes, 3, 'EPERM kept the wait going until ESRCH');
});

test('EPERM until the timeout reports still running, not exited', async () => {
  const kill = () => { throw errno('EPERM'); };
  assert.equal(await waitForProcessExit(7, { timeoutMs: 300, kill }), false);
});

test('an unexpected probe error is unknown, not exited', async () => {
  const kill = () => { throw errno('EINVAL'); };
  assert.equal(await waitForProcessExit(7, { timeoutMs: 300, kill }), null);
});

test('ESRCH means exited', async () => {
  assert.equal(await waitForProcessExit(7, { kill: () => { throw errno('ESRCH'); } }), true);
});

test('the daemon is not started again when its exit is unknown', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sentry-unknown-exit-'));
  const previous = process.env.FARAVAN_HOME;
  process.env.FARAVAN_HOME = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.FARAVAN_HOME; else process.env.FARAVAN_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const owner = await import('../lib/sbx-daemon-owner.mjs');
  const { sbxChildEnv, sbxDaemonDescription, credentialStoreEnv } = await import('../lib/docker-backend.mjs');
  const id = 'a'.repeat(64);
  const executable = process.execPath;
  await writeFile(owner.sbxOwnerFile(), JSON.stringify({ id, executable }));
  const env = systemdShowEnvironment([...Object.entries(credentialStoreEnv(sbxChildEnv().HOME, 'linux')), ['FARAVAN_SBXD_OWNER_ID', id], ['FARAVAN_SBXD_INSTALL_ROOT', owner.installRoot], ['FARAVAN_SBXD_DATA_HOME', dir]]);
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push(args.join(' '));
    if (command === 'systemctl' && args.includes('show')) return { code: 0, stdout: `LoadState=loaded\nActiveState=active\nMainPID=7\nInvocationID=${'b'.repeat(32)}\nDescription=${sbxDaemonDescription()}\nExecStart={ path=${executable} ; argv[]=${executable} daemon start ; }\nEnvironment=${env}\n`, stderr: '' };
    if (command === 'systemctl') return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: args.join(' ') === 'ls --json' ? '[]' : '', stderr: '' };
  };
  const refused = await restartSbxDaemon({ runCommand, daemons: [{ pid: 7, environ: { HOME: '/old' } }], sandboxes: [], inspectSandboxes: async () => [], waitForExit: async () => null, platformName: 'linux', systemd: true, isProcessAlive: () => true });
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /could not confirm|did not stop/i);
  assert.equal(calls.some(c => c.startsWith('daemon start')), false, 'no restart on unknown');
});
