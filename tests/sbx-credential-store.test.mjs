import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _internal, DockerSbxBackend, credentialStoreEnv, credentialStoreMismatches, inspectIdentityDaemons, inspectIdentitySandboxes,
  linkAccountKeychains, probeSbxPreflight, restartSbxDaemonForCredentialStore, sbxChildEnv, startSbxDaemon,
} from '../lib/docker-backend.mjs';
import { isProviderSecretSet } from '../lib/auth-flow.mjs';
import { startGitHubAuthFlow } from '../lib/github-auth.mjs';
import { startSbxDockerLogin } from '../lib/sbx-login.mjs';

const PINNED = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'DBUS_SESSION_BUS_ADDRESS'];
const result = (overrides = {}) => ({ code: 0, stdout: '', stderr: '', ...overrides });

// The desktop's values for everything the pin must override.
const DESKTOP = {
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', XDG_RUNTIME_DIR: '/run/user/1000',
  XDG_CONFIG_HOME: '/desktop/.config', XDG_DATA_HOME: '/desktop/.local/share',
  XDG_STATE_HOME: '/desktop/.local/state', XDG_CACHE_HOME: '/desktop/.cache',
};

async function withSbxHome(fn, { desktop = DESKTOP } = {}) {
  // Short and under /tmp: sbx socket paths must fit the Unix limit.
  const root = await mkdtemp('/tmp/wfc-'), home = join(root,'sbx');
  const saved = Object.fromEntries(['FARAVAN_HOME','FARAVAN_HOME','FARAVAN_SBX_HOME','FARAVAN_SBX_HOME', ...Object.keys(DESKTOP)].map((key) => [key, process.env[key]]));
  delete process.env.FARAVAN_HOME;delete process.env.FARAVAN_SBX_HOME;delete process.env.FARAVAN_SBX_HOME;
  process.env.FARAVAN_HOME = root;
  Object.assign(process.env, desktop);
  try { return await fn(home); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

function expectPinned(env, home) {
  assert.deepEqual(Object.fromEntries(PINNED.map((key) => [key, env[key]])), credentialStoreEnv(home, 'linux'));
  assert.equal(env.XDG_CONFIG_HOME, join(home, '.config'));
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, `unix:path=${join(home, 'no-session-bus')}`);
  // The pin must never name a socket that exists, or sbx would connect to it.
  assert.doesNotMatch(env.DBUS_SESSION_BUS_ADDRESS, /\/run\/user/);
}

test('credentialStoreEnv pins HOME, the four XDG dirs and a dead bus on Linux, and only HOME elsewhere', () => {
  const linux = credentialStoreEnv('/h/.wfsbx', 'linux');
  assert.deepEqual(linux, {
    HOME: '/h/.wfsbx', XDG_CONFIG_HOME: '/h/.wfsbx/.config', XDG_DATA_HOME: '/h/.wfsbx/.local/share',
    XDG_STATE_HOME: '/h/.wfsbx/.local/state', XDG_CACHE_HOME: '/h/.wfsbx/.cache',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/h/.wfsbx/no-session-bus',
  });
  assert.deepEqual(credentialStoreEnv('/h/.wfsbx', 'darwin'), { HOME: '/h/.wfsbx' });
  assert.deepEqual(credentialStoreEnv('/h/.wfsbx', 'win32'), { HOME: '/h/.wfsbx' });
});

test('sbxChildEnv replaces the desktop bus and XDG dirs with the pinned credential store', { skip: process.platform !== 'linux' }, async () => {
  await withSbxHome((home) => {
    const env = sbxChildEnv();
    expectPinned(env, home);
    assert.equal(env.XDG_RUNTIME_DIR, '/run/user/1000', 'XDG_RUNTIME_DIR is not part of the pin');
  });
});

test('the daemon start, every probe and the command runner all get the pinned environment', { skip: process.platform !== 'linux' }, async () => {
  await withSbxHome(async (home) => {
    const calls = [];
    const runCommand = async (command, args, options) => {
      calls.push({ command, args, env: options.env });
      return result({ stdout: 'sbx version: v0.51.0 abc' });
    };
    await startSbxDaemon({ runCommand });
    await probeSbxPreflight({ runCommand, platformName: 'linux' });
    const sbxCalls = calls.filter((call) => call.command === 'sbx');
    assert.ok(sbxCalls.length >= 4, 'expected daemon start and several probes');
    for (const call of sbxCalls) expectPinned(call.env, home);
    assert.ok(sbxCalls.some(call=>call.args.join(' ')==='daemon start --detach'));
  });
});

async function fakeSbx(dir, body) {
  const file = join(dir, 'sbx');
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

const dumpEnv = (record) => `{ for v in ${PINNED.join(' ')}; do eval "printf '%s=%s\\n' $v \\"\\$$v\\""; done; } > '${record}'`;

function parseEnvDump(text) {
  return Object.fromEntries(text.trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

test('login and the provider-secret probe run sbx with the pinned credential store; GitHub sign-in runs no sbx', { skip: process.platform !== 'linux' }, async () => {
  await withSbxHome(async (home) => {
    const dir = await mkdtemp(join(tmpdir(), 'wf-cred-bin-'));
    try {
      const loginRecord = join(dir, 'login.env');
      const login = await fakeSbx(dir, `${dumpEnv(loginRecord)}
printf '%s\\n' 'Open this URL to sign in: https://login.docker.com/activate?user_code=AB-CD'
printf '%s\\n' 'Your one-time device confirmation code is: AB-CD'
while :; do sleep 1; done`);
      const flow = await startSbxDockerLogin({ loginBin: login, probe: async () => ({ checks: [] }) });
      flow.cancel?.();
      expectPinned(parseEnvDump(await readFile(loginRecord, 'utf8')), home);

      const secretRecord = join(dir, 'secret.env');
      const secretBin = await fakeSbx(dir, `${dumpEnv(secretRecord)}\necho 'No secrets found'`);
      await isProviderSecretSet({ provider_service_id: 'openai' }, { sbxBin: secretBin, env: { PATH: process.env.PATH, ...DESKTOP } });
      expectPinned(parseEnvDump(await readFile(secretRecord, 'utf8')), home);

      const githubRecord = join(dir, 'github.env');
      const gh = join(dir, 'gh');
      await writeFile(gh, `#!/bin/sh
if [ "$1" = auth ] && [ "$2" = login ]; then
  echo 'First copy your one-time code: TEST-1234'
  echo 'Open this URL to continue in your web browser: https://github.com/login/device'
  exit 0
fi
if [ "$1" = auth ] && [ "$2" = token ]; then printf 'dummy-token'; exit 0; fi
exit 1
`);
      await chmod(gh, 0o755);
      const storeBin = await fakeSbx(dir, `${dumpEnv(githubRecord)}\ncat >/dev/null`);
      const previous = process.env.FARAVAN_SBX_BIN;
      process.env.FARAVAN_SBX_BIN = storeBin;
      try {
        const github = await startGitHubAuthFlow({ ghBin: gh, env: { PATH: process.env.PATH, ...DESKTOP }, faravanHome: join(dir, 'gh-home') });
        assert.equal((await github.waitForCompletion()).status, 'complete');
      } finally { if (previous === undefined) delete process.env.FARAVAN_SBX_BIN; else process.env.FARAVAN_SBX_BIN = previous; }
      // Each GitHub job's sandbox-scoped value is written through the backend's runner, which pins the store (above).
      await assert.rejects(readFile(githubRecord, 'utf8'), { code: 'ENOENT' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

test('credentialStoreMismatches names every pinned variable that differs', () => {
  const expected = credentialStoreEnv('/h/.wfsbx', 'linux');
  assert.deepEqual(credentialStoreMismatches({ ...expected }, expected), []);
  assert.deepEqual(credentialStoreMismatches({ ...expected, XDG_RUNTIME_DIR: '/anything' }, expected), []);
  const old = { ...expected, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', XDG_CONFIG_HOME: '/home/u/.config' };
  assert.deepEqual(credentialStoreMismatches(old, expected), ['XDG_CONFIG_HOME', 'DBUS_SESSION_BUS_ADDRESS']);
  const bare = { HOME: '/h/.wfsbx' };
  assert.deepEqual(credentialStoreMismatches(bare, expected), PINNED.filter((key) => key !== 'HOME'));
});

async function fakeProc(root, entries) {
  for (const [pid, { argv, environ }] of Object.entries(entries)) {
    await mkdir(join(root, pid), { recursive: true });
    await writeFile(join(root, pid, 'cmdline'), argv.join('\0') + '\0');
    await writeFile(join(root, pid, 'environ'), Object.entries(environ).map(([k, v]) => `${k}=${v}`).join('\0') + '\0');
  }
  await mkdir(join(root, 'self'), { recursive: true });
}

test('inspectIdentityDaemons finds only this identity\'s sbx daemons and reads their environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wf-proc-'));
  try {
    await fakeProc(root, {
      100: { argv: ['/usr/bin/sbx', 'daemon', 'start'], environ: { HOME: '/h/.wfsbx', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', EMPTY: '' } },
      101: { argv: ['/usr/bin/sbx', 'daemon', 'start'], environ: { HOME: '/h' } },
      102: { argv: ['/usr/bin/sbx', 'ls', '--json'], environ: { HOME: '/h/.wfsbx' } },
      103: { argv: ['node', 'daemon', 'start'], environ: { HOME: '/h/.wfsbx' } },
    });
    const found = await inspectIdentityDaemons({ procRoot: root, home: '/h/.wfsbx' });
    assert.deepEqual(found.map((daemon) => daemon.pid), [100]);
    assert.equal(found[0].environ.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1000/bus');
    assert.equal(found[0].environ.EMPTY, '');
    assert.equal(await inspectIdentityDaemons({ procRoot: join(root, 'missing'), home: '/h/.wfsbx' }), null, 'an unlistable process table is unknown');
  } finally { await rm(root, { recursive: true, force: true }); }
});

function healthyChecks(daemonEnvironments) {
  const inputs = {
    platformName: 'linux', sbxHome: '/h/.wfsbx', daemonEnvironments,
    runHelp: result({ stdout: ['  -d, --detach', '      --name string', '      --kit stringArray', '      --cpus', '      --memory', '      --skills', '      --deny-network'].join('\n') }),
    version: result({ stdout: 'sbx version: v0.51.0 abc123' }),
    packages: result({ stdout: 'docker-sbx\tinstalled\t0.51.0\ndocker-ce\tinstalled\t28.0.0\ncontainerd.io\tinstalled\t2.1.0\n' }),
    dockerVersion: result({ stdout: '28.0.0' }),
    containerdVersion: result({ stdout: 'containerd github.com/containerd/containerd v2.1.0' }),
    diagnose: result({ stdout: 'Daemon healthy\nDocker authentication healthy' }),
    policy: result({ stdout: 'Policy rules' }), kvmReadable: result(), kvmWritable: result(),
  };
  return Object.fromEntries(_internal.preflightChecks(inputs).map((item) => [item.name, item]));
}

test('sbx_credential_store passes when no daemon runs or the daemon has the pinned environment', () => {
  const pinned = credentialStoreEnv('/h/.wfsbx', 'linux');
  assert.equal(healthyChecks([]).sbx_credential_store.ok, true);
  assert.equal(healthyChecks([{ pid: 7, environ: { ...pinned, XDG_RUNTIME_DIR: '/run/user/1000' } }]).sbx_credential_store.ok, true);
});

test('sbx_credential_store fails with a plain fix and key names only when a daemon predates the pin', () => {
  const stale = healthyChecks([{ pid: 7, environ: { HOME: '/h/.wfsbx', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', SECRET_LOOKING: 'do-not-print' } }]);
  const check = stale.sbx_credential_store;
  assert.equal(check.ok, false);
  assert.equal(check.detail, 'The running sandbox service still keeps its Docker sign-in in your desktop keyring.');
  assert.doesNotMatch(check.fix, /daemon stop/);
  assert.match(check.fix, /FARAVAN_SBX_HOME/);
  assert.match(check.diagnostics, /pid 7 differs on .*DBUS_SESSION_BUS_ADDRESS/);
  assert.doesNotMatch(JSON.stringify(check), /do-not-print|\/run\/user\/1000\/bus/);
});

test('the credential store check exists on Linux only', () => {
  const darwin = _internal.preflightChecks({ ...{
    platformName: 'darwin', version: result({ stdout: 'sbx version: v0.51.0 abc' }), runHelp: result({ stdout: '' }), packages: result(), dockerVersion: result(),
    containerdVersion: result(), diagnose: result({ stdout: 'Daemon healthy' }), policy: result(), kvmReadable: result(), kvmWritable: result() } });
  assert.equal(darwin.some((item) => item.name === 'sbx_credential_store'), false);
});

// --- restart / repair --------------------------------------------------------

const OLD_ENVIRON = { HOME: '/old', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', XDG_STATE_HOME: '/desktop/.local/state' };

function repairStub(home, { listing = [], signedOut = false } = {}) {
  const calls = [];
  const state = { stale: true };
  const runCommand = async (command, args, options) => {
    calls.push({ command, args: args.join(' '), env: options.env });
    const line = args.join(' ');
    if (line === 'ls --json') return signedOut ? result({ code: 1, stderr: 'error: not signed in to Docker' }) : result({ stdout: JSON.stringify(listing) });
    if (line === 'ls -q') return signedOut ? result({ code: 1, stderr: 'error: not signed in to Docker' }) : result({ stdout: listing.map(item => item.name).join('\n') });
    if (line === 'daemon stop') return result({ stdout: 'Stopped daemon' });
    if (line === 'daemon start --detach') { state.stale = false; return result({ stdout: 'started' }); }
    if (args[0] === 'version') return result({ stdout: 'sbx version: v0.51.0 abc123' });
    if (line === 'run --help') return result({ stdout: ['  -d, --detach', '      --name string', '      --kit stringArray', '      --cpus', '      --memory', '      --skills', '      --deny-network'].join('\n') });
    if (args[0] === 'diagnose') return result({ stdout: 'Daemon healthy\nDocker authentication healthy' });
    if (line === 'policy ls') return result({ stdout: 'Policy rules' });
    if (command === 'dpkg-query') return result({ stdout: 'docker-sbx\tinstalled\t0.51.0\ndocker-ce\tinstalled\t28.0.0\ncontainerd.io\tinstalled\t2.1.0\n' });
    if (command === 'docker') return result({ stdout: '28.0.0' });
    if (command === 'containerd') return result({ stdout: 'containerd github.com/containerd/containerd v2.1.0' });
    if (command === 'test') return result();
    throw new Error(`unexpected command: ${command} ${line}`);
  };
  const inspectDaemons = async () => (state.stale ? [{ pid: 4242, environ: OLD_ENVIRON }] : [{ pid: 4343, environ: credentialStoreEnv(home, 'linux') }]);
  return { calls, runCommand, inspectDaemons, state };
}

test('doctor leaves a stale daemon running when installation ownership is unproven', { skip: process.platform !== 'linux' }, async () => {
  await withSbxHome(async (home) => {
    const stub = repairStub(home, { listing: [{ name: 'wf-0123456789abcdef', status: 'stopped' }] });
    const report = await new DockerSbxBackend().probeCapabilities({ runCommand: stub.runCommand, inspectDaemons: stub.inspectDaemons, inspectSandboxes: async () => [], platformName: 'linux', waitForExit: async () => true });
    assert.equal(report.available, false);
    assert.deepEqual(report.identity_repairs.map((item) => [item.name, item.ok]), [['sbx_credential_store', false]]);
    assert.match(report.identity_repairs[0].detail, /ownership/);
    assert.equal(stub.calls.some(call => call.args === 'daemon stop' || call.args === 'daemon start --detach'), false);
    assert.equal(stub.state.stale, true);
  });
});

test('the restart is refused while a sandbox runs, and nothing is stopped or started', { skip: process.platform !== 'linux' }, async () => {
  await withSbxHome(async (home) => {
    const stub = repairStub(home, { listing: [{ name: 'wf-0123456789abcdef', status: 'stopped' }, { name: 'wf-fedcba9876543210', status: 'running' }] });
    const report = await new DockerSbxBackend({ hostDisk: { free: async () => ({ free: 20 * 1024 ** 3 }) } }).probeCapabilities({ runCommand: stub.runCommand, inspectDaemons: stub.inspectDaemons, inspectSandboxes: async () => [], platformName: 'linux', waitForExit: async () => true });
    assert.equal(report.available, false);
    const [repair] = report.identity_repairs;
    assert.equal(repair.ok, false);
    assert.match(repair.detail, /sandbox is running.*left the sandbox service alone/);
    assert.equal(repair.diagnostics, 'wf-fedcba9876543210');
    assert.equal(stub.calls.some((call) => call.args === 'daemon stop' || call.args === 'daemon start --detach'), false);
    assert.deepEqual(report.preflight.checks.filter((item) => !item.ok).map((item) => item.name), ['sbx_credential_store']);
  });
});

test('a sandbox process refuses the restart even when sbx ls is unreadable (signed out)', { skip: process.platform !== 'linux' }, async () => {
  await withSbxHome(async () => {
    const calls = [];
    const runCommand = async (_c, args) => { calls.push(args.join(' ')); return result({ code: 1, stderr: 'error: not signed in to Docker' }); };
    const daemons = [{ pid: 1, environ: OLD_ENVIRON }];
    const busy = await restartSbxDaemonForCredentialStore({ runCommand, daemons, sandboxes: [{ pid: 9, environ: OLD_ENVIRON }] });
    assert.equal(busy.ok, false);
    assert.match(busy.detail, /sandbox is running/);
    assert.deepEqual(calls, [], 'a running sandbox process is enough; nothing else is run');
  });
});

test('a signed-out idle daemon still needs installation ownership before restart', { skip: process.platform !== 'linux' }, async () => {
  await withSbxHome(async (home) => {
    const stub = repairStub(home, { signedOut: true });
    const report = await new DockerSbxBackend().probeCapabilities({ runCommand: stub.runCommand, inspectDaemons: stub.inspectDaemons, inspectSandboxes: async () => [], platformName: 'linux', waitForExit: async () => true });
    assert.equal(report.available, false);
    assert.match(report.identity_repairs[0].detail, /ownership/);
    assert.equal(stub.calls.some(call => call.args === 'daemon stop' || call.args === 'daemon start --detach'), false);
  });
});

test('inspectIdentitySandboxes finds this identity\'s sandbox shims only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wf-proc-'));
  try {
    await fakeProc(root, {
      200: { argv: ['/usr/libexec/containerd-shim-nerdbox-v1', '-namespace', 'docker'], environ: { HOME: '/h/.wfsbx' } },
      201: { argv: ['/usr/libexec/containerd-shim-nerdbox-v1', '-namespace', 'docker'], environ: { HOME: '/h' } },
      202: { argv: ['/usr/bin/containerd-shim-runc-v2'], environ: { HOME: '/h/.wfsbx' } },
    });
    assert.deepEqual((await inspectIdentitySandboxes({ procRoot: root, home: '/h/.wfsbx' })).map((item) => item.pid), [200]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an unowned daemon is refused before trying to wait for its exit', { skip: process.platform !== 'linux' }, async () => {
  await withSbxHome(async (home) => {
    const stub = repairStub(home, { listing: [] });
    const report = await new DockerSbxBackend().probeCapabilities({ runCommand: stub.runCommand, inspectDaemons: stub.inspectDaemons, inspectSandboxes: async () => [], platformName: 'linux', waitForExit: async () => false });
    assert.equal(report.available, false);
    assert.equal(report.identity_repairs[0].ok, false);
    assert.match(report.identity_repairs[0].detail, /ownership/);
    assert.equal(stub.calls.some(call => call.args === 'daemon stop'), false);
    assert.equal(stub.calls.some((call) => call.args === 'daemon start --detach'), false);
  });
});

test('probeSbxPreflight alone never restarts anything', { skip: process.platform !== 'linux' }, async () => {
  await withSbxHome(async (home) => {
    const stub = repairStub(home, { listing: [] });
    const report = await probeSbxPreflight({ runCommand: stub.runCommand, inspectDaemons: stub.inspectDaemons, inspectSandboxes: async () => [], platformName: 'linux' });
    assert.equal(report.checks.find((item) => item.name === 'sbx_credential_store').ok, false);
    assert.equal(stub.calls.some((call) => call.args.startsWith('daemon') || call.args === 'ls --json'), false);
  });
});

test('on macOS the sandbox home links the account keychains so sbx can store the Docker sign-in', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wfkc-'));
  try {
    const account = join(root, 'account');
    const home = join(root, 'sbx');
    await mkdir(join(account, 'Library', 'Keychains'), { recursive: true });
    assert.equal(linkAccountKeychains(home, { platformName: 'darwin', userHome: account }), true);
    assert.equal(await readlink(join(home, 'Library', 'Keychains')), join(account, 'Library', 'Keychains'));
    assert.equal(linkAccountKeychains(home, { platformName: 'darwin', userHome: account }), false, 'an existing link is kept');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the keychain link is never made on Linux, for the account home itself, or over an existing entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wfkc-'));
  try {
    const account = join(root, 'account');
    const home = join(root, 'sbx');
    assert.equal(linkAccountKeychains(home, { platformName: 'linux', userHome: account }), false);
    await assert.rejects(lstat(join(home, 'Library')), { code: 'ENOENT' });
    assert.equal(linkAccountKeychains(account, { platformName: 'darwin', userHome: account }), false);
    await assert.rejects(lstat(join(account, 'Library')), { code: 'ENOENT' });
    await mkdir(join(home, 'Library', 'Keychains'), { recursive: true });
    assert.equal(linkAccountKeychains(home, { platformName: 'darwin', userHome: account }), false);
    assert.equal((await lstat(join(home, 'Library', 'Keychains'))).isDirectory(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stale credential-store guidance does not promise an automatic legacy restart',()=>{
  const checks=_internal.preflightChecks({platformName:'linux',daemonEnvironments:[{pid:4242,environ:OLD_ENVIRON}],sbxHome:'/fixture/home'});
  const check=checks.find(c=>c.name==='sbx_credential_store');
  assert.doesNotMatch(check.fix,/Faravan restarts/);
  assert.doesNotMatch(check.fix,/daemon stop/);
  assert.match(check.fix,/FARAVAN_SBX_HOME/);
});
