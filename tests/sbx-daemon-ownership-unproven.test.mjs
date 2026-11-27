import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _internal, classifySbxDaemonCause, inspectIdentityDaemons } from '../lib/docker-backend.mjs';

// An incomplete process scan never reads as "no daemon" or "one daemon":
// a restart would then start a second daemon beside one it did not see.
test('an unlistable process table leaves the daemon inventory unknown', async () => {
  assert.equal(await inspectIdentityDaemons({ procRoot: join(tmpdir(), 'wf-proc-missing-' + process.pid), home: '/h/.wfsbx' }), null);
});

test('an unreadable matching process leaves the daemon inventory unknown, even beside a readable one', { skip: process.getuid?.() === 0 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'wf-proc-'));
  try {
    for (const [pid, home] of [[100, '/h/.wfsbx'], [101, '/h/.wfsbx']]) {
      await mkdir(join(root, String(pid)));
      await writeFile(join(root, String(pid), 'cmdline'), ['/usr/bin/sbx', 'daemon', 'start'].join('\0'));
      await writeFile(join(root, String(pid), 'environ'), 'HOME=' + home);
    }
    await chmod(join(root, '101', 'environ'), 0o000);
    assert.equal(await inspectIdentityDaemons({ procRoot: root, home: '/h/.wfsbx' }), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an unknown daemon inventory fails the credential-store check without a stop command', () => {
  const check = _internal.preflightChecks({ platformName: 'linux', daemonEnvironments: null, sbxHome: '/fixture/home' })
    .find((item) => item.name === 'sbx_credential_store');
  assert.equal(check.ok, false);
  assert.match(check.detail, /could not be checked/);
  assert.doesNotMatch(JSON.stringify(check), /daemon stop/);
});

// Without ownership proof Faravan names no command that stops a daemon: on a
// shared sandbox HOME it could be another install's daemon, mid-job.
test('unproven daemon ownership gives the isolated-home path, never a stop command', () => {
  const env = { HOME: '/fixture/home', XDG_STATE_HOME: '/fixture/home/.local/state' };
  const legacy = classifySbxDaemonCause('legacy', { env });
  assert.equal(Object.hasOwn(legacy, 'stopCommand'), false);
  assert.doesNotMatch(JSON.stringify(legacy), /daemon stop/);
  assert.match(legacy.detail, /FARAVAN_SBX_HOME/);
  const stale = _internal.preflightChecks({ platformName: 'linux', sbxHome: '/fixture/home',
    daemonEnvironments: [{ pid: 4242, environ: { HOME: '/fixture/home', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' } }] })
    .find((item) => item.name === 'sbx_credential_store');
  assert.equal(stale.ok, false);
  assert.doesNotMatch(JSON.stringify(stale), /daemon stop/);
  assert.match(stale.fix, /FARAVAN_SBX_HOME/);
});
