import './helpers/no-browser.mjs';
import {testSbxRuntimeFields} from './helpers/sandbox-receipt-fixture.mjs';
import test,{beforeEach,afterEach} from 'node:test';
// Each test declares its overrides explicitly; inherited homes are never test fixtures.
beforeEach(()=>{for(const key of ['FARAVAN_SBX_HOME','FARAVAN_SBX_HOME','FARAVAN_HOME','FARAVAN_HOME','FARAVAN_DATA_HOME','FARAVAN_DATA_HOME'])delete process.env[key];});
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path, { join } from 'node:path';
import { homedir,tmpdir } from 'node:os';
import { _internal, DockerSbxBackend, probeSbxPreflight, sbxVersionCheck, restartSbxDaemonForCredentialStore } from '../lib/docker-backend.mjs';

let testHome;
beforeEach(()=>{testHome=mkdtempSync(join(tmpdir(),'preflight-profile-'));});
afterEach(()=>{rmSync(testHome,{recursive:true,force:true});});

const execFileAsync = promisify(execFile);
const CLI = join(process.cwd(), 'bin', 'faravan');

function result(overrides = {}) {
  return { code: 0, stdout: '', stderr: '', ...overrides };
}

function runHelp(detach = '--detach') {
  return [
    'Usage: sbx run [flags] AGENT PATH',
    'Flags:',
    `  -d, ${detach}                    Start the sandbox and print its ID without opening an agent session`,
    '      --detach-keys string          Override the detach keys',
    '      --name string',
    '      --kit stringArray',
    '      --cpus',
    '      --memory',
    '      --skills',
    '      --static-mcp',
    '      --deny-network',
  ].join('\n');
}

function healthyInputs(overrides = {}) {
  return {
    platformName: 'linux',
    dockerLoginProbe: result(),
    runHelp: result({ stdout: runHelp() }),
    version: result({ stdout: 'sbx version: v0.51.0 abc123' }),
    packages: result({ stdout: 'docker-sbx\tinstalled\t0.51.0\ndocker-ce\tinstalled\t28.0.0\ncontainerd.io\tinstalled\t2.1.0\n' }),
    dockerVersion: result({ stdout: '28.0.0' }),
    containerdVersion: result({ stdout: 'containerd github.com/containerd/containerd v2.1.0' }),
    diagnose: result({ stdout: 'Daemon healthy\nDocker authentication healthy' }),
    policy: result({ stdout: 'Policy rules' }),
    kvmReadable: result(),
    kvmWritable: result(),
    ...overrides,
  };
}

function byName(inputs) {
  return Object.fromEntries(_internal.preflightChecks(inputs).map((item) => [item.name, item]));
}

// `sbx diagnose` as sbx 0.50.0 prints it (live, 2026-10-28): one line per check, exit 1 when any check fails.
const sbx050Diagnose = ({ policyReady, dockerLogin }) => result({ code: policyReady && dockerLogin ? 0 : 1, stdout: [
  'Diagnostics', '  ! Binary version — could not check for updates', '  ✓ Daemon — healthy',
  dockerLogin ? '  ✓ Authentication — authenticated' : '  ✗ Authentication — not authenticated',
  policyReady ? '  ✓ Global network policy — initialized' : '  ✗ Global network policy — not initialized\n      try: sbx policy init <allow-all|balanced|deny-all>',
].join('\n') });

function identityCommandStub({ daemonReady = true, policyReady = true, dockerLogin = true, sbx050 = false } = {}) {
  const calls = [];
  const state = { daemonReady, policyReady, dockerLogin };
  const runCommand = async (command, args, options) => {
    calls.push({ args, env: options.env });
    if(args.join(' ')==='ls -q') return !state.daemonReady ? result({code:1,stderr:'daemon connection refused'}) : state.dockerLogin ? result() : result({code:1,stderr:'error: not signed in to Docker'});
    if(args.join(' ')==='ls --json')return result({stdout:'[]'});
    if(args.join(' ')==='policy reset --help')return result({stdout:'Flags: --force Skip confirmation'});
    if(args.join(' ')==='policy reset --force'){state.policyReady=false;return result();}
    if (args.join(' ') === 'run --help') return result({ stdout: runHelp() });
    if (args[0] === 'version') return result({ stdout: 'sbx version: v0.51.0 abc123' });
    if (args[0] === 'diagnose') {
      if (!state.daemonReady) return result({ code: 1, stderr: 'daemon connection refused' });
      if (sbx050) return sbx050Diagnose(state);
      return state.dockerLogin
        ? result({ stdout: 'Daemon healthy\nDocker authentication healthy' })
        : result({ code: 1, stdout: 'Daemon healthy', stderr: 'user is not authenticated to Docker' });
    }
    if (args[0] === 'policy' && args[1] === 'ls') {
      return state.policyReady
        ? result({ stdout: 'Policy rules' })
        : result({ code: 1, stderr: 'global network policy has not been initialized' });
    }
    if (args[0] === 'daemon' && args[1] === 'start' && args[2] === '--detach') {
      state.daemonReady = true;
      return result({ stdout: 'daemon started' });
    }
    if (args[0] === 'policy' && args[1] === 'init' && args[2] === 'deny-all') {
      state.policyReady = true;
      return result({ stdout: 'policy initialized' });
    }
    if (command === 'dpkg-query') return result({ stdout: 'docker-sbx\tinstalled\t0.51.0\ndocker-ce\tinstalled\t28.0.0\ncontainerd.io\tinstalled\t2.1.0\n' });
    if (command === 'docker') return result({ stdout: '28.0.0' });
    if (command === 'containerd') return result({ stdout: 'containerd github.com/containerd/containerd v2.1.0' });
    if (command === 'test') return result();
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
  return { calls, runCommand, state };
}

test('preflight classifies a fully ready Ubuntu sbx installation', () => {
  const checks = byName(healthyInputs());
  assert.equal(Object.keys(checks).length, 10);
  assert.ok(Object.values(checks).every((item) => item.ok));
  assert.ok(Object.values(checks).every((item) => typeof item.detail === 'string' && typeof item.fix === 'string'));
});

test('darwin doctor checks that the sbx keychains path resolves to the account keychains', () => {
  const checks = byName(healthyInputs({ platformName: 'darwin', sbxHome: '/Users/a/.wfsbx', userHome: '/Users/a', realpathPath: path => ({
    '/Users/a/.wfsbx/Library/Keychains': '/Users/a/Library/Keychains',
    '/Users/a/Library/Keychains': '/Users/a/Library/Keychains',
  })[path] ?? null }));
  assert.equal(checks.sbx_keychain.ok, true);
  const missing = byName(healthyInputs({ platformName: 'darwin', sbxHome: '/Users/a/.wfsbx', userHome: '/Users/a', realpathPath: path => path === '/Users/a/Library/Keychains' ? path : null }));
  assert.equal(missing.sbx_keychain.ok, false);
  assert.equal(missing.sbx_keychain.automatic, true);
});

test('sandbox home follows the product data home and its current override', () => {
  const previous = process.env.FARAVAN_SBX_HOME;
  try {
    assert.equal(_internal.selectSbxHome({home:'/h',dataHome:'/h/Faravan',override:'',userHome:null}).home, '/h/Faravan/sbx');
    process.env.FARAVAN_SBX_HOME = '/fixture/sbx';
    assert.equal(_internal.sbxHome(), '/fixture/sbx');
  } finally {
    if (previous === undefined) delete process.env.FARAVAN_SBX_HOME;
    else process.env.FARAVAN_SBX_HOME = previous;
  }
});


test('an app HOME too long for the sandbox socket gets a short sandbox home in the account home', () => {
  const macHome = '/Users/sam/Library/Application Support/Faravan Preview 20261025/Home';
  const selection = _internal.selectSbxHome({ home: macHome, dataHome: macHome, override: '', pathExists: () => false, userHome: '/Users/sam' });
  assert.match(selection.home, /^\/Users\/sam\/\.fsbx\/[0-9a-f]{6}$/);
  assert.ok(Buffer.byteLength(_internal.containerdSocketPathForSbxHome(selection.home)) <= 103);
  assert.equal(_internal.socketPathLengthCheck(selection.home).ok, true);
  // Each app HOME gets its own folder, and the same HOME always gets the same one.
  assert.equal(_internal.selectSbxHome({ home: macHome, dataHome: macHome, override: '', pathExists: () => false, userHome: '/Users/sam' }).home, selection.home);
  assert.notEqual(_internal.selectSbxHome({ home: macHome + '2', dataHome: macHome + '2', override: '', pathExists: () => false, userHome: '/Users/sam' }).home, selection.home);
  // A HOME that already fits keeps its .wfsbx, and an account home too long to help changes nothing.
  assert.equal(_internal.selectSbxHome({ home: '/home/a', dataHome: '/home/a/Faravan', override: '', pathExists: () => false, userHome: '/home/a' }).home, '/home/a/Faravan/sbx');
  const tooLong = '/home/' + 'x'.repeat(40);
  assert.equal(_internal.selectSbxHome({ home: macHome, dataHome: macHome, override: '', pathExists: () => false, userHome: tooLong }).home, join(macHome, 'sbx'));
});

for (const [platform, limit] of [['darwin', 103], ['linux', 104]]) {
  test(`${platform}: a Unicode HOME uses the fitting account-home fallback based on socket bytes`, () => {
    const home = '/t/' + 'é'.repeat(15);
    const candidate = join(home, '.wfsbx');
    assert.equal(Buffer.byteLength(_internal.containerdSocketPathForSbxHome(candidate)), 115);
    const options = { home, override: '', channelPlatform: platform, dataHome: join(home, '.spare' + 'kin'), pathExists: () => false, userHome: '/u' };
    const selection = _internal.selectSbxHome(options);
    assert.match(selection.home, /^\/u\/\.fsbx\/[0-9a-f]{6}$/);
    assert.equal(Buffer.byteLength(_internal.containerdSocketPathForSbxHome(selection.home)), 90);
    assert.equal(_internal.socketPathLengthCheck(selection.home, platform).ok, true);
    assert.equal(_internal.selectSbxHome(options).home, selection.home);
    assert.equal(selection.migration, null);
  });

  test(`${platform}: an overlong Unicode legacy home yields to the fitting default without moving state`, () => {
    const home = '/t/' + 'é'.repeat(6);
    const legacy = join(home, '.waspflow', 'sbx-home');
    const defaultHome = join(home, '.wfsbx');
    assert.equal(Buffer.byteLength(_internal.containerdSocketPathForSbxHome(legacy)), 109);
    assert.equal(Buffer.byteLength(_internal.containerdSocketPathForSbxHome(defaultHome)), 97);
    const selection = _internal.selectSbxHome({ home, override: '', channelPlatform: platform, dataHome: join(home, '.spare' + 'kin'), pathExists: candidate => candidate === legacy, userHome: null });
    assert.deepEqual(selection, { home: defaultHome, migration: 'legacy_home_too_long' });
    assert.equal(_internal.socketPathLengthCheck(selection.home, platform).ok, true);
  });

  test(`${platform}: an overlong Unicode account-home fallback does not replace the original home`, () => {
    const home = '/t/' + 'a'.repeat(40);
    const userHome = '/u/' + 'é'.repeat(8);
    const candidate = join(home, '.wfsbx');
    assert.equal(Buffer.byteLength(_internal.containerdSocketPathForSbxHome(join(userHome, '.fsbx', '123456'))), 107);
    const selection = _internal.selectSbxHome({ home, override: '', channelPlatform: platform, dataHome: join(home, '.spare' + 'kin'), pathExists: () => false, userHome });
    assert.deepEqual(selection, { home: candidate, migration: null });
    assert.equal(_internal.socketPathLengthCheck(selection.home, platform).ok, false);
  });

  test(`${platform}: a 104-byte default socket path ${platform === 'linux' ? 'keeps its existing home' : 'uses a fitting fallback'}`, () => {
    const home = '/t/' + 'a'.repeat(19);
    const defaultHome = join(home, '.wfsbx');
    assert.equal(Buffer.byteLength(_internal.containerdSocketPathForSbxHome(defaultHome)), 104);
    const selection = _internal.selectSbxHome({ home, override: '', channelPlatform: platform, dataHome: join(home, '.spare' + 'kin'), pathExists: candidate => candidate === defaultHome, userHome: '/u' });
    if (platform === 'linux') assert.equal(selection.home, defaultHome);
    else assert.match(selection.home, /^\/u\/\.fsbx\/[0-9a-f]{6}$/);
    assert.equal(selection.migration, null);
    assert.equal(_internal.socketPathLengthCheck(selection.home, platform).ok, true);
  });

  test(`${platform}: a 104-byte channel socket path follows the platform budget`, () => {
    const home = '/u';
    const dataHome = '/t/' + 'a'.repeat(22);
    const candidate = join(dataHome, 'sbx');
    assert.equal(Buffer.byteLength(_internal.containerdSocketPathForSbxHome(candidate)), 104);
    const selection = _internal.selectSbxHome({ home, override: '', channelPlatform: platform, dataHome, pathExists: () => true, userHome: '/u' });
    if (platform === 'linux') assert.equal(selection.home, candidate);
    else assert.match(selection.home, /^\/u\/\.fsbx\/[0-9a-f]{6}$/);
    assert.equal(selection.migration, null);
    assert.equal(_internal.socketPathLengthCheck(selection.home, platform).ok, true);
  });

  test(`${platform}: a 104-byte account-home fallback follows the platform budget`, () => {
    const home = '/t/' + 'a'.repeat(40);
    const userHome = '/u/' + 'a'.repeat(13);
    const candidate = join(home, '.wfsbx');
    assert.equal(Buffer.byteLength(_internal.containerdSocketPathForSbxHome(join(userHome, '.fsbx', '123456'))), 104);
    const selection = _internal.selectSbxHome({ home, override: '', channelPlatform: platform, dataHome: join(home, '.spare' + 'kin'), pathExists: () => false, userHome });
    if (platform === 'linux') {
      assert.equal(path.dirname(selection.home), join(userHome, '.fsbx'));
      assert.match(path.basename(selection.home), /^[0-9a-f]{6}$/);
    } else assert.equal(selection.home, candidate);
    assert.equal(selection.migration, null);
    assert.equal(_internal.socketPathLengthCheck(selection.home, platform).ok, platform === 'linux');
  });

  test(`${platform}: legacy home selection uses its ${limit}-byte pathname budget`, () => {
    for (const [length, keepLegacy] of [[limit, true], [limit + 1, false]]) {
      const home = '/t/' + 'a'.repeat(length - 97);
      const legacy = join(home, '.waspflow', 'sbx-home');
      const defaultHome = join(home, '.wfsbx');
      assert.equal(Buffer.byteLength(_internal.containerdSocketPathForSbxHome(legacy)), length);
      const selection = _internal.selectSbxHome({ home, override: '', channelPlatform: platform, dataHome: join(home, '.spare' + 'kin'), pathExists: candidate => candidate === legacy, userHome: null });
      assert.deepEqual(selection, { home: keepLegacy ? legacy : defaultHome, migration: keepLegacy ? 'using_legacy_home' : 'legacy_home_too_long' });
      assert.equal(_internal.socketPathLengthCheck(selection.home, platform).ok, true);
    }
  });
}

test('channel data home gets its own sbx home when HOME overrides are unset', () => {
  const channel = { id: 'faravan', name: 'Faravan', dataFolder: 'Faravan', bundleId: 'com.faravan.app', helperBundleId: 'com.faravan.app.notify', launchAgentLabel: 'com.faravan.agent', linuxPrefix: 'faravan' };
  const dataHome = '/users/a/.local/share/Faravan Preview';
  const selected = _internal.selectSbxHome({
    home: '/users/a', override: '', channel, channelPlatform: 'linux', channelEnv: { XDG_DATA_HOME: '/users/a/.local/share' }, dataHome: undefined, pathExists: () => false,
    userHome: '/users/a',
  });
  const implicit = _internal.selectSbxHome({ home: '/users/a', override: '', channel, channelPlatform: 'linux', channelEnv: { XDG_DATA_HOME: '/users/a/.local/share' }, pathExists: () => false, userHome: '/users/a' });
  assert.equal(selected.home, implicit.home);
  assert.notEqual(implicit.home, '/users/a/.wfsbx');
});

for (const [platform, limit] of [['darwin', 103], ['linux', 104]]) {
  test(`${platform}: socket path length preflight uses the ${limit}-byte pathname budget`, () => {
    const fittingHome = `/t/${'a'.repeat(limit - 78)}`;
    const tooLongHome = `/t/${'a'.repeat(limit + 1 - 78)}`;
    const pass = _internal.socketPathLengthCheck(fittingHome, platform);
    const fail = _internal.socketPathLengthCheck(tooLongHome, platform);
    assert.equal(Buffer.byteLength(_internal.containerdSocketPathForSbxHome(fittingHome)), limit);
    assert.equal(pass.ok, true);
    assert.equal(fail.ok, false);
    assert.equal(fail.detail, 'The sandbox files live at a path that is too long for the system.');
    assert.equal(fail.fix, 'Set FARAVAN_SBX_HOME to a shorter directory.');
  });

  for (const [label, name, bytes] of [['non-ASCII letters', 'é'.repeat(25), 128], ['non-ASCII symbols', '🧪'.repeat(12) + 'a', 127]]) {
    test(`${platform}: socket path length rejects ${label} that fit in characters but exceed the byte limit`, () => {
      const home = `/t/${name}`;
      const socketPath = _internal.containerdSocketPathForSbxHome(home);
      assert.equal(socketPath.length, 103);
      assert.equal(Buffer.byteLength(socketPath), bytes);
      const result = _internal.socketPathLengthCheck(home, platform);
      assert.equal(result.ok, false);
      assert.equal(result.detail, 'The sandbox files live at a path that is too long for the system.');
      assert.equal(result.fix, 'Set FARAVAN_SBX_HOME to a shorter directory.');
      assert.equal(result.diagnostics, `Sandbox path length: ${bytes} bytes.`);
    });
  }

  for (const [length, ok] of [[limit, true], [limit + 1, false]]) {
    test(`${platform}: socket path length reports ${length} ASCII bytes at its ${limit}-byte pathname budget`, () => {
      const home = `/t/${'a'.repeat(length - 78)}`;
      const socketPath = _internal.containerdSocketPathForSbxHome(home);
      assert.equal(socketPath.length, length);
      assert.equal(Buffer.byteLength(socketPath), length);
      const result = _internal.socketPathLengthCheck(home, platform);
      assert.equal(result.ok, ok);
      assert.equal(result.detail, ok ? `The sandbox files are at a path that is ${length} bytes long.` : 'The sandbox files live at a path that is too long for the system.');
      assert.equal(result.fix, ok ? '' : 'Set FARAVAN_SBX_HOME to a shorter directory.');
      assert.equal(result.diagnostics, `Sandbox path length: ${length} bytes.`);
    });
  }

}

for (const [platformName, ok] of [['darwin', false], ['linux', true], ['win32', true]]) {
  test(`${platformName}: preflight forwards its platform to the 104-byte socket check`, () => {
    const home = `/t/${'a'.repeat(26)}`;
    const checks = byName(healthyInputs({ platformName, sbxHome: home, userHome: null, realpathPath: value => value, restartNeeded: false }));
    assert.equal(checks.socket_path_length.ok, ok);
    assert.equal(checks.socket_path_length.diagnostics, 'Sandbox path length: 104 bytes.');
  });
}

test('every preflight detail is one plain sentence while raw command output stays in diagnostics', () => {
  const hostile = '\u001b[32m✓\u001b[0m Daemon healthy\n╰─ detailed terminal output';
  const linux = Object.values(byName(healthyInputs({ dockerLoginProbe: result({stdout:hostile}), diagnose: result({ stdout: hostile }) })));
  const windows = Object.values(byName(healthyInputs({
    platformName: 'win32',
    version: result({ stdout: hostile }),
    hypervisorPlatform: result({ stdout: hostile }),
    diagnose: result({ stdout: hostile }),
  })));
  for (const item of [...linux, ...windows]) {
    assert.doesNotMatch(item.detail, /[\r\n\x1b\u2500-\u257f]/, `${item.name} detail leaked terminal formatting`);
    assert.equal(item.detail.split(/[.!?]/).filter(Boolean).length, 1, `${item.name} detail must be one sentence`);
    assert.equal(typeof item.diagnostics, 'string');
  }
  assert.match(linux.find((item) => item.name === 'docker_login').diagnostics, /Daemon healthy/);
  assert.match(windows.find((item) => item.name === 'sbx_install').diagnostics, /\x1b\[32m/);
});

test('preflight rejects a bare sbx binary that was not installed as docker-sbx', () => {
  const checks = byName(healthyInputs({ packages: result({ stdout: 'docker-ce\tinstalled\t28.0.0\ncontainerd.io\tinstalled\t2.1.0\n' }) }));
  assert.equal(checks.sbx_install.ok, false);
  assert.match(checks.sbx_install.detail, /copied binary/i);
  assert.match(checks.sbx_install.fix, /docker-sbx/);
});

test('preflight rejects the exact transfer.v1 containerd failure', () => {
  const checks = byName(healthyInputs({ diagnose: result({ stdout: 'Daemon healthy\nio.containerd.transfer.v1: no plugins registered' }) }));
  assert.equal(checks.docker_runtime.ok, false);
  assert.match(checks.docker_runtime.detail, /transfer\.v1/);
  assert.match(checks.docker_runtime.fix, /docker-ce/);
});

test('preflight rejects an unhealthy sbx daemon diagnostic', () => {
  const checks = byName(healthyInputs({ diagnose: result({ code: 1, stderr: 'daemon connection refused' }) }));
  assert.equal(checks.sbx_daemon.ok, false);
  assert.equal(checks.sbx_daemon.fix, '');
  assert.doesNotMatch(checks.sbx_daemon.fix,/daemon start --detach/);
});

test('preflight rejects the exact uninitialized policy diagnostic and offers the safe fix', () => {
  const checks = byName(healthyInputs({ policy: result({ code: 1, stderr: 'global network policy has not been initialized' }) }));
  assert.equal(checks.network_policy.ok, false);
  assert.match(checks.network_policy.detail, /has not been initialized/);
  assert.match(checks.network_policy.fix, /doctor --fix-policy/);
});

test('probeCapabilities starts a stopped daemon under the isolated Faravan sbx identity, then passes', async () => {
  const stub = identityCommandStub({ daemonReady: false });
  const report = await new DockerSbxBackend({home:testHome}).probeCapabilities({ runCommand: stub.runCommand, platformName: 'linux' });
  assert.equal(report.available, true);
  assert.deepEqual(report.identity_repairs.map((item) => item.name), ['sbx_daemon']);
  const start = stub.calls.find((call) => call.args.join(' ') === 'daemon start --detach');
  assert.ok(start, 'expected the stopped daemon to be started');
  assert.equal(start.env.HOME, _internal.sbxHome());
});

test('probeCapabilities initializes an uninitialized deny-all policy under the isolated Faravan sbx identity, then passes', async () => {
  const stub = identityCommandStub({ policyReady: false });
  const report = await new DockerSbxBackend({home:testHome}).probeCapabilities({ runCommand: stub.runCommand, platformName: 'linux' });
  assert.equal(report.available, true);
  assert.deepEqual(report.identity_repairs.map((item) => item.name), ['network_policy']);
  const initialize = stub.calls.find((call) => call.args.join(' ') === 'policy init deny-all');
  assert.ok(initialize, 'expected the missing policy to be initialized');
  assert.equal(initialize.env.HOME, _internal.sbxHome());
});

test('probeCapabilities forwards cancellation through read-only preflight and skips repairs after abort', async () => {
  const stub = identityCommandStub({ daemonReady: false });
  const controller = new AbortController(), signals = [];
  const runCommand = async (command, args, options) => {
    signals.push(options.signal);
    const out = await stub.runCommand(command, args, options);
    if (args[0] === 'diagnose') controller.abort(new DOMException('test cancellation', 'AbortError'));
    return out;
  };
  await new DockerSbxBackend({home:testHome}).probeCapabilities({runCommand, platformName: 'linux', signal: controller.signal});
  assert.ok(signals.length > 0);
  assert.ok(signals.every(signal => signal?.aborted), 'all preflight commands stop when the owning signal aborts');
  assert.equal(stub.calls.some(call => call.args.join(' ') === 'daemon start --detach'), false,
    'a cancelled preflight does not start a service during capability inspection');
});

test('probeCapabilities does not restart an identity after cancellation during its daemon scan', async () => {
  const stub = identityCommandStub({ daemonReady: false });
  const controller = new AbortController();
  const staleDaemon = {pid: 12345, environ: {HOME: _internal.sbxHome(), XDG_STATE_HOME: '/synthetic-old-state'}};
  let inspections = 0, releaseScan, scanStarted;
  const started = new Promise(resolve => { scanStarted = resolve; });
  const scanGate = new Promise(resolve => { releaseScan = resolve; });
  const inspectDaemons = async () => {
    inspections++;
    if (inspections === 2) { scanStarted(); await scanGate; }
    return [staleDaemon];
  };
  const checking = new DockerSbxBackend({home:testHome}).probeCapabilities({runCommand: stub.runCommand,
    platformName: 'linux', inspectDaemons, signal: controller.signal});
  await started;
  controller.abort(new DOMException('test cancellation', 'AbortError'));
  releaseScan();
  await checking;
  assert.equal(stub.calls.some(call => call.args[0] === 'daemon' ||
    (call.args[0] === 'policy' && call.args[1] === 'init')), false,
  'an aborted identity scan does not start, stop, or initialize a service');
});

test('identity setup leaves Docker login and low host disk as separate preflight failures', async () => {
  const stub = identityCommandStub({ dockerLogin: false });
  const report = await new DockerSbxBackend({home:testHome, hostDisk: { free: async () => ({ free: 7 * 1024 ** 3 }) } })
    .probeCapabilities({ runCommand: stub.runCommand, platformName: 'linux' });
  assert.equal(report.available, false);
  assert.deepEqual(report.preflight.checks.filter((item) => !item.ok).map((item) => item.name), ['docker_login','host_disk']);
  assert.deepEqual(report.identity_repairs, []);
  assert.equal(stub.calls.some((call) => call.args[0] === 'daemon' || (call.args[0] === 'policy' && call.args[1] === 'init')), false);
});

test('Docker sign-in and policy repairs do not bypass the host disk gate', async () => {
  let free = 7 * 1024 ** 3;
  const backend = () => new DockerSbxBackend({home:testHome, hostDisk: { free: async () => ({ free }) } });
  const stub = identityCommandStub({ daemonReady: false, policyReady: false, dockerLogin: false });
  const blocked = await backend().probeCapabilities({ runCommand: stub.runCommand, platformName: 'linux' });
  assert.equal(blocked.available, false);
  assert.deepEqual(blocked.identity_repairs.map((item) => item.name), ['sbx_daemon', 'network_policy']);
  assert.deepEqual(blocked.preflight.checks.filter((item) => !item.ok).map((item) => item.name), ['network_policy','docker_login','host_disk']);

  stub.state.dockerLogin = true;
  const signedIn = backend();
  const stillRefused = await signedIn.probeCapabilities({ runCommand: stub.runCommand, platformName: 'linux' });
  assert.deepEqual(stillRefused.preflight.checks.filter(item=>!item.ok).map(item=>item.name),['docker_login','host_disk']);
  // Complete the owner sign-in explicitly; a successful listing alone cannot clear the saved refusal.
  assert.equal(signedIn.confirmDockerSignIn(signedIn.signInRefusalEpoch()),true);
  const low = await signedIn.probeCapabilities({ runCommand: stub.runCommand, platformName: 'linux' });
  assert.equal(low.available, false);
  assert.deepEqual(low.preflight.checks.filter(item=>!item.ok).map(item=>item.name),['host_disk']);
  const lowLending=await backend().lenderCapabilities({runCommand:stub.runCommand,platformName:'linux'});
  assert.equal(lowLending.available,false);
  assert.equal(lowLending.reason,'host_disk_low');

  free = 20 * 1024 ** 3;
  const ready = await backend().probeCapabilities({ runCommand: stub.runCommand, platformName: 'linux' });
  assert.equal(ready.available, true);
  assert.equal(ready.preflight.ok, true);
  const lending=await backend().lenderCapabilities({runCommand:stub.runCommand,platformName:'linux'});
  assert.equal(lending.available,true);
  assert.equal(lending.reason,null);
  assert.equal(lending.host_storage_protection,false,'host storage is watched, never claimed as enforced');
  assert.equal(lending.enforced_limits.includes('disk_bytes'),false);
});

test('preflight rejects the exact KVM permission diagnostic', () => {
  const checks = byName(healthyInputs({ diagnose: result({ stdout: 'Daemon healthy\nKVM error: Permission denied (os error 13)' }) }));
  assert.equal(checks.kvm_access.ok, false);
  assert.match(checks.kvm_access.fix, /usermod -aG kvm/);
});

test('while signed out the policy only waits for the Docker sign-in, and the app repairs it itself', () => {
  const checks = byName(healthyInputs({
    dockerLoginProbe: result({code:1,stderr:'user is not authenticated to Docker'}), diagnose: result({ stdout: 'Daemon healthy\nuser is not authenticated to Docker' }),
    policy: result({ code: 1, stderr: 'error: not signed in to Docker' }),
  }));
  assert.equal(checks.network_policy.ok, false);
  assert.equal(checks.network_policy.detail, 'Waits for the Docker sign-in.');
  assert.equal(checks.network_policy.automatic, true);
  assert.equal(checks.network_policy.waitsFor, 'docker_login');
  assert.doesNotMatch(checks.network_policy.fix, /sbx policy|--fix-policy/);
});

// Faravan starts a stopped service by itself. It does nothing about a service it refused to use, so it must not say it will.
const REFUSALS = [
  'Sandbox service ownership could not be verified. The sandbox call was refused.',
  'The computer reports a failed service, and Faravan could not confirm that its own sandbox service is safe to use. Choose Check again after the failed service is cleared.',
  'The managed sandbox service state could not be verified. The sandbox call was refused.',
];
for (const observation of [false, true]) for (const refusal of REFUSALS) {
  test(`a refused sandbox call is not promised to fix itself (${observation ? 'observed' : 'full read'}: ${refusal.slice(0, 32)})`, () => {
    const failed = result({ code: 1, stderr: refusal });
    const check = byName(healthyInputs({ observation, ...(observation ? { dockerLoginProbe: failed } : { diagnose: failed }) })).sbx_daemon;
    assert.equal(check.ok, false);
    assert.notEqual(check.automatic, true, 'Faravan does not repair a refusal, so the check is not automatic');
    assert.equal(_internal.daemonNeedsStart(check), false);
    assert.doesNotMatch(check.detail, /not running yet/i, 'a refused call does not say the service is stopped');
    assert.match(check.fix, /Check again/);
    assert.doesNotMatch(`${check.detail} ${check.fix}`, /verdict|receipt|attempt|settled|lease|by itself/i);
  });
}

test('the check is automatic exactly when the repair path acts on it', () => {
  for (const stderr of ['daemon connection refused', 'sandbox daemon is not running', 'Daemon stopped', 'something unrelated broke']) {
    const check = byName(healthyInputs({ diagnose: result({ code: 1, stderr }) })).sbx_daemon;
    assert.equal(check.automatic === true, _internal.daemonNeedsStart(check), stderr);
  }
});

test('a missing policy and a stopped daemon are marked as repaired by Faravan itself', () => {
  assert.equal(byName(healthyInputs({ policy: result({ code: 1, stderr: 'global network policy has not been initialized' }) })).network_policy.automatic, true);
  assert.equal(byName(healthyInputs({ diagnose: result({ code: 1, stderr: 'daemon connection refused' }) })).sbx_daemon.automatic, true);
  assert.equal(byName(healthyInputs()).network_policy.automatic, undefined);
});

test('an exact Docker refusal in a failed listing requires sign-in', () => {
  const checks = byName(healthyInputs({ dockerLoginProbe: result({code:1,stderr:'user is not authenticated to Docker'}), diagnose: result({ stdout: 'Daemon healthy\nuser is not authenticated to Docker' }) }));
  assert.equal(checks.docker_login.ok, false);
  assert.equal(checks.docker_login.unknown, undefined);
  assert.match(checks.docker_login.fix, /Sign in to Docker/);
});

test('probeSbxPreflight builds its JSON-ready report from stubbed command output', async () => {
  const report = await probeSbxPreflight({
    platformName: 'darwin',
    sbxHomePath: '/Users/a/.wfsbx', userHome: '/Users/a',
    realpathPath: path => ({ '/Users/a/.wfsbx/Library/Keychains': '/Users/a/Library/Keychains', '/Users/a/Library/Keychains': '/Users/a/Library/Keychains' })[path] ?? null,
    runCommand: async (_command, args) => {
      if (args.join(' ') === 'ls -q') return result();
      if (args.join(' ') === 'run --help') return result({ stdout: runHelp() });
      if (args[0] === 'version') return result({ stdout: 'sbx version: v0.51.0' });
      if (args[0] === 'diagnose') return result({ stdout: 'Daemon healthy\nDocker authentication healthy' });
      if (args[0] === 'policy') return result({ stdout: 'Policy rules' });
      throw new Error(`unexpected command: ${args.join(' ')}`);
    },
  });
  assert.equal(report.schema_version, 1);
  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 10);
});

test('Windows preflight reads sbx version, checks HypervisorPlatform, and skips Linux-only checks', async () => {
  const calls = [];
  const report = await probeSbxPreflight({
    platformName: 'win32',
    runCommand: async (command, args) => {
      calls.push([command, args]);
      if (args.join(' ') === 'ls -q') return result();
      if (args.join(' ') === 'run --help') return result({ stdout: runHelp() });
      if (args[0] === 'version') return result({ stdout: 'sbx version 0.51.0' });
      if (args.join(' ') === 'policy ls') return result({stdout:'deny-all policy'});
      if (command === 'powershell.exe') return result({ stdout: 'Enabled' });
      if (args[0] === 'diagnose') return result({ stdout: 'Daemon healthy\nDocker authentication healthy' });
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    },
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map((item) => item.name), ['sbx_install', 'hypervisor_platform', 'docker_login', 'windows_file_permissions', 'network_policy', 'sbx_version', 'sbx_cli_contract', 'socket_path_length']);
  assert.ok(calls.some(([_command, args]) => args[0] === 'version'));
  assert.ok(calls.some(([command, args]) => command === 'powershell.exe' && args.some((arg) => arg.includes('Get-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform'))));
  assert.ok(!calls.some(([command]) => ['dpkg-query', 'docker', 'containerd', 'test'].includes(command)));
});

test('Windows preflight routes HypervisorPlatform recovery through installer repair before an administrator fallback', () => {
  const checks = byName(healthyInputs({
    platformName: 'win32',
    version: result({ stdout: 'C:\\Program Files\\Docker\\sbx.exe' }),
    hypervisorPlatform: result({ stdout: 'Disabled' }),
  }));
  assert.equal(checks.hypervisor_platform.ok, false);
  assert.match(checks.hypervisor_platform.fix, /^Reinstall or run the Faravan installer's Repair action\./);
  assert.match(checks.hypervisor_platform.fix, /Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All -NoRestart$/);
});

test('doctor --json returns a structured setup_required event, never a stack trace', async () => {
  await assert.rejects(execFileAsync(process.execPath, [CLI, 'doctor', '--json'], {
    env: { ...process.env, FARAVAN_SBX_BIN: '/definitely/missing/sbx' },
  }), (error) => {
    const event = JSON.parse(error.stdout);
    assert.equal(event.schema_version, 1);
    assert.equal(event.type, 'sandbox_preflight');
    assert.equal(event.status, 'setup_required');
    assert.ok(event.checks.some((item) => item.name === 'sbx_install' && item.ok === false));
    assert.doesNotMatch(error.stderr, /\.mjs:\d+:\d+|\bat \w+ \(/);
    return true;
  });
});

for (const [version, ok, status] of [
  ['0.41.9', false, 'blocked'], ['0.46.0', false, 'blocked'],
  ['0.49.0', false, 'blocked'], ['0.49.1', false, 'blocked'], ['0.51.0', true, 'passed'], ['garbage', false, 'blocked'],
]) {
  test(`sbx version admission: ${version} is ${status}`, () => {
    const check = sbxVersionCheck(result({ stdout: `sbx version ${version}` }));
    assert.equal(check.ok, ok);
    assert.equal(check.status, status);
    if (status !== 'passed') assert.match(check.fix, /0\.51\.0/);
  });
}

test('an explicitly shared non-deny-all policy requires reset confirmation', () => {
  const previous=process.env.FARAVAN_SBX_HOME;
  process.env.FARAVAN_SBX_HOME='/synthetic-shared-home';
  try {
  const checks = byName(healthyInputs({ policy: result({ stdout: 'balanced policy' }) }));
  assert.equal(checks.network_policy.ok,false);
  assert.equal(checks.network_policy.repair,'policy_confirm');
  } finally {if(previous===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=previous;}
});

test('unsafe sbx version blocks before repair commands', async () => {
  const calls = [];
  const stub = identityCommandStub({ policyReady: false });
  const report = await new DockerSbxBackend({home:testHome}).probeCapabilities({
    platformName: 'linux',
    runCommand: async (command, args, options) => {
      calls.push(args);
      if (args.join(' ') === 'ls -q') return result();
      if (args.join(' ') === 'run --help') return result({ stdout: runHelp() });
      if (args[0] === 'version') return result({ stdout: 'sbx version 0.41.9' });
      return stub.runCommand(command, args, options);
    },
  });
  assert.equal(report.available, false);
  assert.equal(calls.some((args) => args.includes('init') || args.includes('start')), false);
});

for (const [version, detach] of [['0.47.0', '--detached'], ['0.48.0', '--detach']]) {
  test(`sbx CLI contract accepts ${version} help with the short detach flag`, () => {
    const check = byName(healthyInputs({ version: result({ stdout: `sbx version ${version}` }), runHelp: result({ stdout: runHelp(detach) }) })).sbx_cli_contract;
    assert.equal(check.ok, true);
    assert.equal(check.detail, 'Docker Sandboxes accepts the options Faravan uses.');
    assert.equal(check.fix, '');
  });
}

test('sbx CLI contract names missing whole flags, ignoring prefixes and description mentions', () => {
  for (const replacement of ['', '      --deny-network-extra', '      --skills-extra string  Enables --deny-network']) {
    const help = runHelp().replace('      --deny-network', replacement);
    const check = byName(healthyInputs({ runHelp: result({ stdout: help }) })).sbx_cli_contract;
    assert.equal(check.ok, false);
    assert.equal(check.detail, 'This Docker Sandboxes version does not accept options Faravan uses: --deny-network.');
    assert.equal(check.fix, 'Install a Docker Sandboxes version Faravan supports, or update Faravan.');
  }
  const help = runHelp().replace(/  -d, --detach[^\n]*/, '      --detach-keys string  Use -d to detach');
  assert.equal(byName(healthyInputs({ runHelp: result({ stdout: help }) })).sbx_cli_contract.detail,
    'This Docker Sandboxes version does not accept options Faravan uses: -d.');
});

test('sbx CLI contract fails closed on unsuccessful help even with valid output', async () => {
  const stub = identityCommandStub();
  const report = await probeSbxPreflight({ platformName: 'linux', runCommand: (command, args, options) =>
    args.join(' ') === 'run --help' ? result({ code: 1, stdout: runHelp(), stderr: 'help failed' }) : stub.runCommand(command, args, options) });
  const check = report.checks.find((item) => item.name === 'sbx_cli_contract');
  assert.equal(report.ok, false);
  assert.equal(check.ok, false);
  assert.equal(check.detail, 'Could not read the Docker Sandboxes command options.');
  assert.equal(check.fix, 'Install a Docker Sandboxes version Faravan supports, or update Faravan.');
});

test('sbx CLI contract fails closed when unavailable and does not attempt help', async () => {
  const calls = [];
  const report = await probeSbxPreflight({ platformName: 'darwin', runCommand: async (_command, args) => {
    calls.push(args);
    return result({ code: 1, errorCode: 'ENOENT' });
  } });
  assert.deepEqual(calls, [['version']]);
  const check = report.checks.find((item) => item.name === 'sbx_cli_contract');
  assert.equal(check.ok, false);
  assert.equal(check.detail, 'Could not read the Docker Sandboxes command options.');
});


test('inconclusive KVM is a nonblocking CHECK, never PASS', async () => {
  const checks = _internal.preflightChecks(healthyInputs({ kvmReadable: result({ code: 1 }) }));
  const kvm = checks.find(item => item.name === 'kvm_access');
  assert.equal(kvm.ok, true);
  assert.equal(kvm.status, 'inconclusive');
  const { default: cli } = await import('../bin/faravan');
  const lines = cli.preflightHumanLines({ ok: true, checks });
  assert.ok(lines.some(line => line.startsWith('CHECK kvm_access:')));
  assert.ok(!lines.some(line => line.startsWith('PASS kvm_access:')));
});

test('doctor JSON tests a real workspace path by default; --quick skips it', async () => {
  const { default: cli } = await import('../bin/faravan');
  const preflight = { ok: true, backend_id: 'docker-sbx', checks: _internal.preflightChecks(healthyInputs()) };
  let probes = 0;
  const backendFactory = () => ({
    probeCapabilities: async () => ({ preflight, version: 'sbx version 0.48.0' }),
    testWorkspace: async ({ version }) => {
      probes++;
      assert.equal(version, 'sbx version 0.48.0');
      return { ok: true, cause: null, detail: 'Faravan started and removed a test workspace.', fix: '', diagnostics: '' };
    },
  });
  const capture = async (args) => {
    const original = process.stdout.write;
    let output = '';
    process.stdout.write = chunk => { output += chunk; return true; };
    try { await cli.cmdDoctor(args, { backendFactory, storeFree: async () => null }); }
    finally { process.stdout.write = original; }
    return JSON.parse(output);
  };
  const full = await capture(['--json']);
  assert.equal(probes, 1);
  assert.equal(full.status, 'ready');
  const check = full.checks.find(item => item.name === 'test_workspace');
  assert.equal(check.ok, true);
  assert.equal(check.label, 'Test workspace');
  assert.equal(check.detail, 'Faravan started and removed a test workspace.');
  const quick = await capture(['--quick', '--json']);
  assert.equal(probes, 1);
  assert.ok(!quick.checks.some(item => item.name === 'test_workspace'));
});

test('doctor never starts a workspace after failed preflight and reports workspace failure plainly', async () => {
  const { default: cli } = await import('../bin/faravan');
  let probes = 0;
  const backend = {
    probeCapabilities: async () => ({ preflight: { ok: false, backend_id: 'docker-sbx',
      checks: [{ name: 'docker_login', ok: false, detail: 'Sign-in is missing.', fix: 'Sign in.' }] } }),
    testWorkspace: async () => { probes++; return { ok: false, cause: 'option_rejected',
      detail: 'Docker Sandboxes 0.48.0 rejected an option Faravan uses.', fix: 'Update Faravan.',
      diagnostics: 'unknown flag: --detached' }; },
  };
  const blocked = await cli.sandboxPreflight({ report: false, backendFactory: () => backend, storeFree: async () => null });
  assert.equal(blocked.ok, false);
  assert.equal(probes, 0);
  backend.probeCapabilities = async () => ({ version: 'sbx version 0.48.0',
    preflight: { ok: true, backend_id: 'docker-sbx', checks: [] } });
  const failed = await cli.sandboxPreflight({ report: false, backendFactory: () => backend, storeFree: async () => null });
  assert.equal(probes, 1);
  assert.equal(failed.ok, false);
  assert.equal(failed.preflight.checks[0].cause, 'option_rejected');
  const lines = cli.preflightHumanLines(failed.preflight).join('\n');
  assert.match(lines, /FAIL Test workspace:/);
  assert.match(lines, /Fix: Update Faravan\./);
  assert.doesNotMatch(lines, /unknown flag|--detached/);
});

test('runtime health repairs a stopped daemon and verifies readiness, without stopping a service', async () => {
  const stub = identityCommandStub({ daemonReady: false });
  const backend = new DockerSbxBackend({home:testHome});
  const previousPolicies = backend._verifiedIdentityPolicies;
  previousPolicies.set('old-daemon-policy', { verification: {} });
  const report = await backend.recoverHealth({ runCommand: stub.runCommand, platformName: 'linux' });
  assert.equal(report.recovered, true);
  assert.notEqual(backend._verifiedIdentityPolicies, previousPolicies, 'in-flight old-daemon proofs must not populate the new cache');
  assert.equal(backend._verifiedIdentityPolicies.size, 0, 'a restarted daemon must repeat identity-policy checks');
  assert.equal(report.preflight.checks.find(c => c.name === 'sbx_daemon').ok, true);
  assert.equal(stub.calls.filter(c => c.args.join(' ') === 'daemon start --detach').length, 1);
  assert.equal(stub.calls.some(c => c.args.join(' ') === 'daemon stop'), false);
});

test('runtime health never restarts a healthy daemon to repair Docker authentication', async () => {
  const stub = identityCommandStub({ dockerLogin: false });
  const report = await new DockerSbxBackend({home:testHome}).recoverHealth({ runCommand: stub.runCommand, platformName: 'linux' });
  assert.equal(report.recovered, false);
  assert.equal(stub.calls.some(c => c.args[0] === 'daemon'), false);
});

test('runtime health refuses to start beside a live daemon using a stale credential-store identity', async () => {
  const stub = identityCommandStub({ daemonReady: false });
  const report = await new DockerSbxBackend({home:testHome}).recoverHealth({
    runCommand: stub.runCommand, platformName: 'linux',
    inspectDaemons: async () => [{ pid: 12345, environ: { HOME: _internal.sbxHome(), XDG_STATE_HOME: '/synthetic-old-state' } }],
  });
  assert.equal(report.recovered, false);
  assert.equal(report.preflight.checks.find(c => c.name === 'sbx_credential_store').ok, false);
  assert.equal(stub.calls.some(c => c.args[0] === 'daemon'), false, 'runtime recovery must neither start nor stop a daemon');
});

test('workspace credential errors use fixed copy and keep diagnostic details out of the primary message',async()=>{
 const {workspaceFailure}=await import('../lib/docker-backend.mjs');
 const detail=workspaceFailure({stderr:'pull failed: failed to decrypt secret: invalid pkcs7 padding; private-value'});
 assert.equal(detail.cause,'credential_store');
 assert.match(detail.detail,/saved Docker sign-in/);
 assert.doesNotMatch(detail.detail,/private-value|padding/);
 const coded=workspaceFailure({code:'sandbox_credential_store_failed',message:'safe copy'});
 assert.equal(coded.cause,'credential_store');
});


for(const phase of ['inventory','exit'])test('repair cancellation after '+phase+' prevents new daemon effects',async()=>{
  const controller=new AbortController(),calls=[];
  const result=await restartSbxDaemonForCredentialStore({signal:controller.signal,
    daemons:[{pid:12345,environ:{}}],sandboxes:[],
    runCommand:async(_command,args,options)=>{
      calls.push(args.join(' '));
      if(phase==='inventory'&&args[0]==='ls')controller.abort();
      return {code:0,stdout:args[0]==='ls'?'[]':'',stderr:''};
    },
    waitForExit:async()=>{controller.abort();return true;}});
  assert.equal(result.ok,false,'a cancelled repair cannot report success');
  assert.equal(calls.includes('daemon start --detach'),false,'no new daemon starts after cancellation');
  if(phase==='inventory')assert.equal(calls.includes('daemon stop'),false,'no daemon stop begins after inventory abort');
});

test('a second install keeps its sandbox identity beside its own data dir; the default profile keeps ~/.wfsbx', () => {
  const second = (dataHome) => _internal.selectSbxHome({ home: '/home/u', override: '', dataHome, pathExists: () => false, userHome: '/home/u' }).home;
  assert.equal(second('/p/s'), '/p/s/sbx');
  // A long data dir is fitted to the socket limit, still one sandbox home per data dir.
  assert.notEqual(second('/home/u/.faravan-preview-x/state'), '/home/u/.wfsbx');
  assert.notEqual(second('/home/u/.faravan-preview-x/state'), second('/home/u/.faravan-preview-y/state'));
  assert.equal(_internal.selectSbxHome({ home: '/home/u', override: '', dataHome: '/home/u/.spare' + 'kin', pathExists: () => false, userHome: '/home/u' }).home, '/home/u/.wfsbx');
  assert.equal(_internal.selectSbxHome({ home: '/home/u', override: '', dataHome: '', pathExists: () => false, userHome: '/home/u' }).home, '/home/u/.wfsbx');
  assert.equal(_internal.selectSbxHome({ home: '/home/u', override: '/x/sbx', dataHome: '/home/u/other', pathExists: () => false }).home, '/x/sbx');
});

test('a failing policy check in sbx diagnose does not read as a signed-out Docker identity', async () => {
  const stub = identityCommandStub({ policyReady: false, sbx050: true });
  const checks = Object.fromEntries((await probeSbxPreflight({ runCommand: stub.runCommand, platformName: 'linux' })).checks.map(c => [c.name, c]));
  assert.equal(checks.docker_login.ok, true, 'the sandbox listing succeeds despite the failed policy diagnostic');
  assert.equal(checks.network_policy.ok, false);
  assert.equal(checks.network_policy.automatic, true);
  assert.equal(checks.network_policy.waitsFor, undefined, 'the policy does not wait for a sign-in that already happened');
});

test('a signed-out listing requires sign-in without a create refusal', async () => {
  const stub = identityCommandStub({ dockerLogin: false, sbx050: true });
  const checks = Object.fromEntries((await probeSbxPreflight({ runCommand: stub.runCommand, platformName: 'linux' })).checks.map(c => [c.name, c]));
  assert.equal(checks.docker_login.ok, false);
  assert.equal(checks.docker_login.unknown, undefined);
  assert.match(checks.docker_login.fix, /Sign in to Docker/);
});

test('help text and unrelated authentication wording do not override Docker login evidence', async () => {
  const affirmative=identityCommandStub({sbx050:true,dockerLogin:true});
  const advisory=await probeSbxPreflight({platformName:'linux',runCommand:async(command,args,options)=>{
    if(args.join(' ')==='ls -q')return result({code:1,stderr:'Cannot connect to daemon. See sbx login --help.'});
    if(args.join(' ')==='diagnose')return result({stdout:'Help: sbx login --help\n✓ Authentication — authenticated'});
    return affirmative.runCommand(command,args,options);
  }});
  const advisoryLogin=advisory.checks.find(check=>check.name==='docker_login');
  assert.equal(advisoryLogin.ok,false);
  assert.equal(advisoryLogin.unknown,true);

  const unrelated=identityCommandStub({sbx050:true,dockerLogin:true});
  const unknown=await probeSbxPreflight({platformName:'linux',runCommand:async(command,args,options)=>{
    if(args.join(' ')==='ls -q')return result({code:1,stderr:'Cannot connect to daemon.'});
    if(args.join(' ')==='diagnose')return result({code:1,stdout:'Daemon healthy',stderr:'registry mirror is not authenticated'});
    return unrelated.runCommand(command,args,options);
  }});
  const unknownLogin=unknown.checks.find(check=>check.name==='docker_login');
  assert.equal(unknownLogin.ok,false);
  assert.equal(unknownLogin.unknown,true);
  assert.match(unknownLogin.detail,/Faravan could not list Docker sandboxes/);
});

test('a pending ls login probe is aborted on timeout and stays unknown despite healthy diagnose', {timeout:1000}, async () => {
  const stub=identityCommandStub({sbx050:true,dockerLogin:true});
  let lsSignal;
  const report=await probeSbxPreflight({platformName:'linux',commandTimeoutMs:10,runCommand:(command,args,options)=>{
    if(args.join(' ')==='ls -q'){lsSignal=options.signal;return new Promise(()=>{});}
    return stub.runCommand(command,args,options);
  }});
  const login=report.checks.find(check=>check.name==='docker_login');
  assert.equal(lsSignal.aborted,true);
  assert.equal(login.ok,false,'authenticated diagnostics cannot qualify a listing that timed out');
  assert.equal(login.unknown,true);
  assert.equal(report.ok,false);
});

test('every preflight command is bounded when diagnose, policy or help hangs', {timeout:2000}, async () => {
  for (const verb of ['diagnose', 'policy ls', 'run --help']) {
    const stub=identityCommandStub({sbx050:true,dockerLogin:true});
    let heldSignal, timer;
    const pending=probeSbxPreflight({platformName:'linux',commandTimeoutMs:10,runCommand:(command,args,options)=>{
      if(args.join(' ')===verb){heldSignal=options.signal;return new Promise(()=>{});}
      return stub.runCommand(command,args,options);
    }});
    try {
      const report=await Promise.race([pending,new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Error(verb+' held the whole preflight open')),150);
      })]);
      assert.equal(heldSignal.aborted,true,verb+' receives its own abort deadline');
      assert.equal(report.ok,false,'an unfinished safety check must not become ready');
    } finally {clearTimeout(timer);}
  }
});

for (const [source, options] of [
  ['process timeout', () => ({ timeout:25 })],
  ['TimeoutError abort signal', () => ({ timeout:1000, signal:AbortSignal.timeout(25) })],
]) test(`the real preflight ${source} stays unknown and fails closed`, async () => {
  const child=await _internal.runPreflightCommand(process.execPath,['-e','setInterval(()=>{},1000)'],options());
  assert.equal(child.errorCode,'ETIMEDOUT');
  assert.equal(child.killed,true);
  assert.equal(child.timedOut,true);
  for (const observation of [false,true]) {
    const stub=identityCommandStub();
    const report=await probeSbxPreflight({platformName:'linux',observation,runCommand:(command,args,options)=>{
      if (['diagnose','ls -q'].includes(args.join(' '))) return Promise.resolve(child);
      return stub.runCommand(command,args,options);
    }});
    const checks=Object.fromEntries(report.checks.map(check=>[check.name,check]));
    assert.equal(checks.sbx_daemon.ok,false);
    assert.equal(checks.sbx_daemon.unknown,true);
    assert.equal(checks.docker_login.ok,false);
    assert.equal(checks.docker_login.unknown,true);
    assert.equal(_internal.daemonNeedsStart(checks.sbx_daemon),false);
    assert.equal(report.ok,false,'a timeout must never make readiness true');
  }
});

test('readiness and doctor use the same definitive Docker sign-in result as signin when diagnose disagrees', async () => {
  const stub = identityCommandStub({ dockerLogin: false, sbx050: true });
  const runCommand = async (command, args, options) => {
    if (args.join(' ') === 'ls -q') {
      stub.calls.push({ args, env: options.env });
      return result({ stdout: 'sandbox-id\n' });
    }
    return stub.runCommand(command, args, options);
  };
  const report = await probeSbxPreflight({ runCommand, platformName: 'linux' });
  const dockerLogin = report.checks.find(check => check.name === 'docker_login');

  assert.ok(stub.calls.some(call => call.args.join(' ') === 'ls -q'), 'preflight asks the same cheap status command as signin');
  assert.equal(dockerLogin.ok, true, 'the signed-in result is authoritative when diagnose contradicts it');
});

test('an exact signed-out ls result overrides authenticated diagnose', async () => {
  const stub = identityCommandStub({ dockerLogin: true, sbx050: true });
  const runCommand = async (command, args, options) => args.join(' ') === 'ls -q'
    ? result({ code: 1, stderr: 'error: not signed in to Docker' })
    : stub.runCommand(command, args, options);
  const dockerLogin = (await probeSbxPreflight({ runCommand, platformName: 'linux' })).checks.find(check => check.name === 'docker_login');

  assert.equal(dockerLogin.ok, false);
  assert.equal(dockerLogin.unknown, undefined);
  assert.match(dockerLogin.fix, /Sign in to Docker/);
});

test('runtime health sets a never-set network policy on a signed-in identity, without touching the daemon', async () => {
  const stub = identityCommandStub({ policyReady: false, sbx050: true });
  const report = await new DockerSbxBackend({home:testHome}).recoverHealth({ runCommand: stub.runCommand, platformName: 'linux' });
  assert.equal(report.recovered, true);
  assert.equal(report.preflight.checks.find(c => c.name === 'network_policy').ok, true);
  assert.equal(report.preflight.checks.find(c => c.name === 'docker_login').ok, true);
  const init = stub.calls.filter(c => c.args.join(' ') === 'policy init deny-all');
  assert.equal(init.length, 1);
  assert.equal(init[0].env.HOME, _internal.sbxHome());
  assert.equal(stub.calls.some(c => c.args[0] === 'daemon'), false);
});

test('runtime health leaves the policy alone while Docker is signed out', async () => {
  const stub = identityCommandStub({ policyReady: false, dockerLogin: false, sbx050: true });
  const report = await new DockerSbxBackend({home:testHome}).recoverHealth({ runCommand: stub.runCommand, platformName: 'linux' });
  assert.equal(report.recovered, false);
  assert.equal(stub.calls.some(c => c.args[0] === 'policy' && c.args[1] === 'init'), false);
});

for (const platformName of ['linux', 'darwin', 'win32']) test(`policy read failure stays repairable in-app on ${platformName}`, () => {
  const checks = byName(healthyInputs({platformName,
    diagnose:result({stdout:'Daemon healthy\nVersion match — CLI v0.51.0 ≠ daemon v0.50.0'}),
    policy: result({code:1, stderr:'cannot prompt for restart: stdin is not a terminal; try: sbx daemon restart'})}));
  assert.equal(checks.network_policy,undefined);
  assert.equal(checks.sbx_daemon.ok,false);
  assert.equal(checks.sbx_daemon.automatic,true);
  assert.equal(checks.sbx_daemon.cause,'daemon_restart_required');
});

test('runtime health replaces an existing permissive policy only after an owner click', async () => {
  const stub=identityCommandStub(); let initialized=false;
  const runCommand=async(command,args,options)=>{
    if(args.join(' ')==='policy ls')return result({stdout:initialized?'deny-all policy':'balanced policy'});
    if(args.join(' ')==='policy init deny-all')initialized=true;
    return stub.runCommand(command,args,options);
  };
  const backend=new DockerSbxBackend({home:testHome});
  const waiting=await backend.recoverHealth({runCommand,platformName:'linux'});
  assert.equal(initialized,false);
  assert.equal(waiting.preflight.checks.find(c=>c.name==='network_policy').repair,'policy_confirm');
  const report=await backend.recoverHealth({runCommand,platformName:'linux',confirmedPolicy:true});
  assert.equal(initialized,true);
  assert.equal(report.recovered,true,JSON.stringify(report));
  assert.equal(report.preflight.checks.find(c=>c.name==='network_policy').ok,true);
});

test('an owned policy that allows all hosts must be repaired', () => {
  const check=byName(healthyInputs({policy:result({stdout:'allow all hosts'})})).network_policy;
  assert.equal(check.ok,false);
  assert.equal(_internal.policyNeedsInitialization(check),true);
});

test('a deny-all policy with scoped rule rows is not flagged wrong', () => {
  for (const stdout of [
    'deny-all  network  deny  **',
    'deny-all\nallow api.anthropic.com:443\nallow chatgpt.com:443',
  ]) {
    const check=byName(healthyInputs({policy:result({stdout})})).network_policy;
    assert.equal(check.ok,true,stdout);
    assert.notEqual(check.repair,'policy_confirm',stdout);
  }
});

test('rule rows without deny-all still need the owner to confirm a reset', () => {
  const check=byName(healthyInputs({policy:result({stdout:'allow custom.example.test:443'})})).network_policy;
  assert.equal(check.ok,false);
  assert.equal(check.repair,'policy_confirm');
});

function outdatedDaemonStub({source='policy ls',busy=false}={}) {
  const base=identityCommandStub({policyReady:false}); let outdated=true;
  const runCommand=async(command,args,options)=>{
    if(args.join(' ')==='daemon stop'){base.calls.push({args,env:options.env});outdated=false;return result();}
    if(args.join(' ')==='ls --json')return result({code:1,stderr:'cannot prompt for restart'});
    if(outdated&&args[0]==='diagnose'&&source!=='exec example')return result({stdout:'Daemon healthy\nVersion match — CLI v0.51.0 ≠ daemon v0.50.0'});
    if(outdated&&args[0]==='version'&&source==='version')return result({code:1,stdout:'Client Version: v0.51.0\nServer Version: v0.50.0'});
    if(outdated&&args.join(' ')===source){base.calls.push({args,env:options.env});return result({code:1,stderr:'Docker Sandboxes has been updated and needs to restart; cannot prompt for restart: stdin is not a terminal'});}
    return base.runCommand(command,args,options);
  };
  return {...base,runCommand,inspectDaemons:async()=>[{pid:123,environ:base.calls.at(-1)?.env??{}}],inspectSandboxes:async()=>busy?[{pid:456}]:[],waitForExit:async()=>true};
}
for(const source of ['policy ls','diagnose','run --help','version']) test(`an idle unproven daemon update from ${source} refuses restart and policy repair`,async()=>{
  const stub=outdatedDaemonStub({source});
  const report=await new DockerSbxBackend({home:testHome}).recoverHealth({...stub,platformName:'linux'});
  assert.equal(report.recovered,false,JSON.stringify(report));
  assert.match(report.preflight.checks.find(c=>c.name==='sbx_daemon').detail,/ownership/);
  assert.equal(stub.calls.some(c=>['daemon stop','daemon start --detach','policy init deny-all'].includes(c.args.join(' '))),false);
});
test('an unproven daemon waits for a running sandbox and still refuses restart when it ends',async()=>{
  const stub=outdatedDaemonStub({busy:true}),backend=new DockerSbxBackend({home:testHome});
  const waiting=await backend.recoverHealth({...stub,platformName:'linux'});
  assert.equal(waiting.recovered,false);
  const daemon=waiting.preflight.checks.find(c=>c.name==='sbx_daemon');
  assert.match(daemon.detail,/wait.*job|job.*finish/i);
  assert.equal(stub.calls.some(c=>c.args[0]==='daemon'),false);
  const done=await backend.recoverHealth({...stub,inspectSandboxes:async()=>[],platformName:'linux'});
  assert.equal(done.recovered,false);
  assert.match(done.preflight.checks.find(c=>c.name==='sbx_daemon').detail,/ownership/);
});
test('an unreadable daemon inventory during an update restart starts no daemon',async()=>{
  const stub=outdatedDaemonStub();
  const report=await new DockerSbxBackend({home:testHome}).recoverHealth({...stub,inspectDaemons:async()=>{throw Object.assign(new Error('denied'),{code:'EACCES'});},platformName:'linux'});
  assert.equal(report.recovered,false);
  assert.equal(stub.calls.some(c=>c.args[0]==='daemon'&&c.args[1]!=='status'||c.command==='systemd-run'),false);
});
for(const key of ['FARAVAN_SBX_HOME','FARAVAN_SBX_HOME'])test(`confirmation cannot authorize an unproven overridden home (${key})`,async()=>{
  const previous=process.env[key];process.env[key]=join(testHome,'shared-sbx');
  try {
    const stub=outdatedDaemonStub(),backend=new DockerSbxBackend({home:testHome});
    const report=await backend.recoverHealth({...stub,platformName:'linux'});
    assert.equal(report.recovered,false);
    assert.equal(stub.calls.some(c=>c.args[0]==='daemon'),false);
    assert.equal(report.preflight.checks.find(c=>c.name==='sbx_daemon').fix,'Restart Docker Sandboxes');
    const confirmed=await backend.recoverHealth({...stub,platformName:'linux',confirmedRestart:true});
    assert.equal(confirmed.recovered,false);
    assert.equal(stub.calls.some(c=>c.args.join(' ')==='daemon stop'),false);
  } finally {if(previous===undefined)delete process.env[key];else process.env[key]=previous;}
});
test('version mismatch in diagnose classifies a daemon restart without blaming network policy',()=>{
  const checks=byName(healthyInputs({diagnose:result({stdout:'Daemon healthy\nVersion match — CLI v0.51.0 ≠ daemon v0.50.0'})}));
  assert.equal(checks.sbx_daemon.ok,false);
  assert.equal(checks.sbx_daemon.cause,'daemon_restart_required');
  assert.equal(checks.network_policy,undefined);
});

test('a local job blocks update recovery even when the process listing is unavailable',async()=>{
  const stub=outdatedDaemonStub(),backend=new DockerSbxBackend({home:testHome});
  const report=await backend.recoverHealth({...stub,inspectSandboxes:async()=>null,jobRunning:()=>true});
  assert.equal(report.recovered,false);
  assert.equal(stub.calls.some(c=>c.args[0]==='daemon'),false);
});
test('a trusted management version signal cannot replace installation ownership',async()=>{
  const stub=outdatedDaemonStub({source:'diagnose'});
  const backend=new DockerSbxBackend({home:testHome,runCommand:args=>stub.runCommand('sbx',args,{env:{}})});
  await backend.runSbx(['diagnose']);
  const report=await backend.recoverHealth({...stub,platformName:'linux'});
  assert.equal(report.recovered,false,JSON.stringify(report));
  assert.equal(stub.calls.some(c=>c.args.join(' ')==='daemon stop'),false);
});

test('new job preparation waits until daemon recovery finishes',async()=>{
  const stub=outdatedDaemonStub(),backend=new DockerSbxBackend({home:testHome});
  let enter,release,prepared=false;
  const entered=new Promise(resolve=>{enter=resolve;}),hold=new Promise(resolve=>{release=resolve;});
  backend._prepare=async()=>{prepared=true;return {};};
  const runCommand=async(c,a,o)=>{if(a.join(' ')==='ls --json'){enter();await hold;}return stub.runCommand(c,a,o);};
  const recovery=backend.recoverHealth({...stub,runCommand});
  await entered;
  const preparation=backend.prepare({resources:{wall_seconds:60}});
  await Promise.resolve();
  assert.equal(prepared,false);
  release();await recovery;await preparation;
  assert.equal(prepared,true);
});

test('successful guest output mentioning a restart does not schedule a daemon restart',async()=>{
  const backend=new DockerSbxBackend({home:testHome,runCommand:async()=>result({stdout:'Docker Sandboxes has been updated and needs to restart'})});
  await backend.runSbx(['exec','example']);
  const stub=identityCommandStub();
  const report=await backend.recoverHealth({runCommand:stub.runCommand});
  assert.equal(report.recovered,false);
  assert.equal(stub.calls.some(c=>c.args[0]==='daemon'),false);
});

for(const guest of [result({stderr:'Docker Sandboxes has been updated and needs to restart'}),result({code:1,stdout:'Client Version: v0.50.1\nServer Version: v0.50.0\nDocker Sandboxes has been updated and needs to restart'})])test(`guest streams never request host restart (exit ${guest.code})`,async()=>{
  const backend=new DockerSbxBackend({home:testHome,runCommand:async()=>guest});
  await backend.runSbx(['exec','guest','--','sh']);
  const stub=identityCommandStub();
  const report=await backend.recoverHealth({runCommand:stub.runCommand});
  assert.equal(report.recovered,false);
  assert.equal(stub.calls.some(c=>c.args[0]==='daemon'),false);
});
for(const platformName of ['linux','win32'])test(`unknown inventory cannot authorize auto restart on ${platformName}`,async()=>{
  const stub=outdatedDaemonStub({source:'diagnose'}),base=stub.runCommand;
  const runCommand=async(c,a,o)=>{
    if(c==='powershell.exe')return result({stdout:'Enabled'});
    if(a[0]==='diagnose')return result({stdout:'Daemon healthy\nVersion match — CLI v0.51.0 ≠ daemon v0.50.0'});
    return base(c,a,o);
  };
  const report=await new DockerSbxBackend({home:testHome}).recoverHealth({...stub,runCommand,platformName,inspectSandboxes:async()=>null});
  assert.equal(stub.calls.some(c=>c.args.join(' ')==='daemon stop'),false);
  const daemon=report.preflight.checks.find(c=>c.name==='sbx_daemon');
  assert.equal(daemon.automatic,false);
  assert.match(daemon.detail,/could not confirm|cannot confirm/i);
  assert.equal(daemon.fix,'Restart Docker Sandboxes');
});
test('unknown inventory cannot authorize permissive-policy replacement',async()=>{
  const stub=identityCommandStub(),base=stub.runCommand;
  const runCommand=async(c,a,o)=>a.join(' ')==='policy ls'?result({stdout:'balanced policy'}):a.join(' ')==='ls --json'?result({code:1}):base(c,a,o);
  const report=await new DockerSbxBackend({home:testHome}).recoverHealth({runCommand,inspectSandboxes:async()=>null});
  assert.equal(stub.calls.some(c=>c.args[0]==='policy'&&['init','reset'].includes(c.args[1])),false);
  assert.equal(report.preflight.checks.find(c=>c.name==='network_policy').fix,'Reset sandbox network rules');
});
test('unproven ownership is explained without ever attempting daemon stop',async()=>{
  const stub=outdatedDaemonStub({source:'diagnose'}),base=stub.runCommand;let stops=0;
  const runCommand=async(c,a,o)=>{
    if(a[0]==='diagnose')return result({stdout:'Daemon healthy\nVersion match — CLI v0.51.0 ≠ daemon v0.50.0'});
    if(a.join(' ')==='daemon stop'){stops++;return result({code:1,stderr:'cannot prompt for restart'});}
    return base(c,a,o);
  };
  const backend=new DockerSbxBackend({home:testHome});await backend.recoverHealth({...stub,runCommand});
  const report=await backend.recoverHealth({...stub,runCommand});
  assert.equal(stops,0);
  assert.equal(report.preflight.checks.find(c=>c.name==='sbx_daemon').fix,'');
  assert.equal(report.preflight.checks.find(c=>c.name==='sbx_daemon').repair,'manual_restart');
  assert.doesNotMatch(report.preflight.checks.find(c=>c.name==='sbx_daemon').detail,/repair-owner/);
});
test('failed policy init is explained and is not attempted on every refresh',async()=>{
  const stub=identityCommandStub({policyReady:false}),base=stub.runCommand;let inits=0;
  const runCommand=async(c,a,o)=>{
    if(a.join(' ')==='policy init deny-all'){inits++;return result({code:1,stderr:'permission denied'});}
    return base(c,a,o);
  };
  const backend=new DockerSbxBackend({home:testHome});await backend.recoverHealth({runCommand});
  const report=await backend.recoverHealth({runCommand});
  assert.equal(inits,1);
  const policy=report.preflight.checks.find(c=>c.name==='network_policy');
  assert.match(policy.detail,/permission/i);assert.equal(policy.fix,'Open Settings');
});

test('permissive policy replacement never resets without an owner click',async()=>{
  const stub=identityCommandStub(),base=stub.runCommand;let permissive=true;
  const runCommand=async(c,a,o)=>{
    if(a.join(' ')==='policy ls')return result({stdout:permissive?'balanced policy':'deny-all policy'});
    if(a.join(' ')==='policy init deny-all')permissive=false;
    return base(c,a,o);
  };
  await new DockerSbxBackend({home:testHome}).recoverHealth({runCommand});
  const commands=stub.calls.map(c=>c.args.join(' '));
  assert.equal(commands.includes('policy reset --force'),false);
  assert.equal(commands.includes('policy init deny-all'),false);
});
test('policy reset failure is terminal and does not attempt init',async()=>{
  const stub=identityCommandStub(),base=stub.runCommand;let resets=0;
  const runCommand=async(c,a,o)=>{
    if(a.join(' ')==='policy ls')return result({stdout:'balanced policy'});
    if(a.join(' ')==='policy reset --force'){resets++;return result({code:1,stderr:'access denied'});}
    return base(c,a,o);
  };
  const backend=new DockerSbxBackend({home:testHome});await backend.recoverHealth({runCommand,confirmedPolicy:true});
  const report=await backend.recoverHealth({runCommand});
  assert.equal(resets,1);
  assert.equal(stub.calls.some(c=>c.args.join(' ')==='policy init deny-all'),false);
  assert.equal(report.preflight.checks.find(c=>c.name==='network_policy').repair,'support');
});
test('free text without a version mismatch does not classify a daemon update',()=>{
  const checks=byName(healthyInputs({diagnose:result({stdout:'Daemon healthy\nDocker Sandboxes has been updated and needs to restart'})}));
  assert.equal(checks.sbx_daemon.ok,true);
  assert.equal(checks.sbx_daemon.cause,undefined);
});

for(const guest of [result({stderr:'Docker Sandboxes has been updated and needs to restart'}),result({code:1,stdout:'Client Version: v0.50.1\nServer Version: v0.50.0'})])test(`job-command path preserves guest streams without a host restart (exit ${guest.code})`,async()=>{
  const backend=new DockerSbxBackend({home:testHome,runCommand:async()=>guest});backend.assertActive=async()=>{};
  const actual=await backend._runJobCommand({...testSbxRuntimeFields(),sandbox_id:'fixture',_resources:{}},['exec','fixture','--','sh']);
  assert.deepEqual(actual,guest);
});
test('a sign-in writer also fences standalone backend policy probes',async()=>{
  const stub=identityCommandStub(),base=stub.runCommand;
  const runCommand=async(c,a,o)=>a.join(' ')==='policy ls'?result({stdout:'balanced policy'}):base(c,a,o);
  const backend=new DockerSbxBackend({home:testHome});backend.credentialWriterBusy=()=>true;
  const report=await backend.probeCapabilities({runCommand});
  assert.equal(stub.calls.some(c=>c.args[0]==='policy'&&['init','reset'].includes(c.args[1])),false);
  const waiting=await backend.recoverHealth({runCommand,confirmedPolicy:true});
  assert.match(waiting.preflight.checks.find(c=>c.name==='network_policy').detail,/sign-ins/);
});

test('an unreadable policy without a repairable cause offers support instead of an ineffective retry',()=>{
  const policy=byName(healthyInputs({policy:result({code:1,stderr:'unexpected failure'})})).network_policy;
  assert.equal(policy.repair,'support');assert.equal(policy.automatic,false);
  assert.equal(policy.fix,'Open Settings');
});

test('unrelated version-like text in diagnose is not the sbx version-match signal',()=>{
  const checks=byName(healthyInputs({diagnose:result({stdout:'Daemon healthy\nprocess args: tool CLI v0.50.1 ≠ daemon v0.50.0'})}));
  assert.equal(checks.sbx_daemon.ok,true);
});
test('confirming an unknown-inventory restart does not also authorize policy reset',async()=>{
  const stub=outdatedDaemonStub(),base=stub.runCommand;
  const runCommand=async(c,a,o)=>a.join(' ')==='policy ls'?result({stdout:'balanced policy'}):base(c,a,o);
  const report=await new DockerSbxBackend({home:testHome}).recoverHealth({...stub,runCommand,inspectSandboxes:async()=>null,confirmedRestart:true});
  assert.equal(report.recovered,false);
  assert.equal(stub.calls.some(c=>['daemon stop','policy reset --force'].includes(c.args.join(' '))),false);
  assert.match(report.preflight.checks.find(c=>c.name==='sbx_daemon').detail,/ownership/);
});

test('an idle home with a custom global rule requires the reset button',async()=>{
  const stub=identityCommandStub(),base=stub.runCommand;
  const runCommand=async(c,a,o)=>a.join(' ')==='policy ls'?result({stdout:'balanced policy\nallow custom-api.example.test:443'}):base(c,a,o);
  const report=await new DockerSbxBackend({home:testHome}).recoverHealth({runCommand});
  assert.equal(stub.calls.some(c=>c.args.join(' ')==='policy reset --force'),false);
  assert.equal(report.preflight.checks.find(c=>c.name==='network_policy').repair,'policy_confirm');
  assert.equal(report.preflight.checks.find(c=>c.name==='network_policy').fix,'Reset sandbox network rules');
});
test('a sandbox appearing after the listing vetoes daemon stop',async()=>{
  const stub=outdatedDaemonStub(),backend=new DockerSbxBackend({home:testHome});let scans=0;
  const report=await backend.recoverHealth({...stub,inspectSandboxes:async()=>++scans===1?[]:[{pid:789}]});
  assert.equal(stub.calls.some(c=>c.args.join(' ')==='daemon stop'),false);
  assert.equal(report.recovered,false);
});

const realUpdateFixture=name=>JSON.parse(readFileSync(new URL(`./fixtures/sbx-update-0501/${name}.json`,import.meta.url),'utf8'));
for(const name of ['doctor','version','diagnose','policy-ls'])test(`captured ${name} fixture classifies the real daemon update`,()=>{
  const fixture=realUpdateFixture(name);let inputs={};
  if(name==='doctor'){
    const report=JSON.parse(fixture.stdout);
    inputs={diagnose:result({stdout:report.checks.find(c=>c.name==='sbx_daemon').diagnostics})};
  } else if(name==='version'){
    // Real version prints the CLI only. Pair it with captured daemon evidence rather than inventing a server line.
    inputs={version:fixture,diagnose:realUpdateFixture('diagnose')};
  } else inputs=name==='diagnose'?{diagnose:fixture}:{policy:fixture};
  const checks=byName(healthyInputs(inputs));
  assert.equal(checks.sbx_daemon.cause,'daemon_restart_required');
  assert.equal(checks.network_policy,undefined);
});
test('the exact policy-ls restart warning is a host-only third detection source',()=>{
  const policy=realUpdateFixture('policy-ls');
  policy.stderr=policy.stderr.split('\n').filter(line=>line.startsWith('warning:')).join('\n');
  const checks=byName(healthyInputs({policy}));
  assert.equal(checks.sbx_daemon.cause,'daemon_restart_required');
});
test('a missing policy confirmation initializes without resetting existing rules',async()=>{
  process.env.FARAVAN_SBX_HOME=join(testHome,'shared-sbx');
  const stub=identityCommandStub({policyReady:false}),backend=new DockerSbxBackend({home:testHome});
  const waiting=await backend.recoverHealth({runCommand:stub.runCommand});
  assert.equal(waiting.preflight.checks.find(c=>c.name==='network_policy').repair,'policy_init_confirm');
  const repaired=await backend.recoverHealth({runCommand:stub.runCommand,confirmedInit:true});
  assert.equal(repaired.recovered,true);
  assert.equal(stub.calls.some(c=>c.args.join(' ')==='policy reset --force'),false);
  assert.equal(stub.calls.some(c=>c.args.join(' ')==='policy init deny-all'),true);
});

test('an initialization click cannot authorize resetting a policy that appeared meanwhile',async()=>{
  const stub=identityCommandStub(),base=stub.runCommand;
  const runCommand=async(c,a,o)=>a.join(' ')==='policy ls'?result({stdout:'balanced policy\nallow custom.example.test'}):base(c,a,o);
  const report=await new DockerSbxBackend({home:testHome}).recoverHealth({runCommand,confirmedInit:true});
  assert.equal(stub.calls.some(c=>c.args.join(' ')==='policy reset --force'),false);
  assert.equal(report.preflight.checks.find(c=>c.name==='network_policy').repair,'policy_confirm');
});
test('a job becoming busy during the final process scan vetoes daemon stop',async()=>{
  const stub=outdatedDaemonStub();let scans=0,busy=false;
  const report=await new DockerSbxBackend({home:testHome}).recoverHealth({...stub,inspectSandboxes:async()=>{if(++scans===2)busy=true;return [];},jobRunning:()=>busy});
  assert.equal(report.recovered,false);
  assert.equal(stub.calls.some(c=>c.args.join(' ')==='daemon stop'),false);
});

for(const cooperative of [true,false])test(`external preflight cancellation cannot succeed and keeps its deadline (cooperative=${cooperative})`,{timeout:5000},async t=>{
  const {mkdtemp,readFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const directory=await mkdtemp(join(tmpdir(),'preflight-cancel-'));
  const marker=join(directory,'pid'),controller=new AbortController();
  const source="process.on('SIGTERM',()=>{if("+cooperative+")process.exit(0);});require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);";
  const pending=_internal.runPreflightCommand(process.execPath,['-e',source,marker],{signal:controller.signal,timeout:1500});
  t.after(async()=>{await pending;await rm(directory,{recursive:true,force:true});});
  let pid;
  for(let i=0;i<100&&!pid;i++){
    pid=await readFile(marker,'utf8').then(Number).catch(()=>null);
    if(!pid)await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.ok(pid,'the synthetic child installs its cancellation handler before publishing its PID');
  controller.abort();
  const result=await pending;
  assert.notEqual(result.code,0);
  assert.notEqual(result.timedOut,true,'caller cancellation must not become a timeout');
  assert.notEqual(result.errorCode,'ETIMEDOUT');
  if(!cooperative)assert.equal(result.killed,true);
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'},'the existing deadline kills and reaps the uncooperative child');
});

import {sbxUpdateOutput} from './helpers/sbx-update-output.mjs';
import {sandboxServiceUnavailableHold} from '../lib/sandbox-remediation.mjs';
test('captured update listing hold names restart rather than Docker Desktop',()=>{
  const hold=sandboxServiceUnavailableHold(sbxUpdateOutput,{rowCount:3});
  assert.equal(hold.cause,'daemon_restart_required');
  assert.equal(hold.row_count,3);
  assert.doesNotMatch(hold.message,/Open Docker Desktop/);
});
for(const busy of [false,true])test(`macOS private daemon update recovery with jobRunning=${busy}`,async()=>{
  process.env.FARAVAN_DATA_HOME=testHome;
  const base=identityCommandStub();let outdated=true;const verbs=[];
  const runCommand=async(command,args,options)=>{
    const verb=args.join(' ');verbs.push(verb);
    if(verb==='daemon stop'){outdated=false;return result();}
    if(outdated&&['ls --json','diagnose'].includes(verb))return sbxUpdateOutput;
    return base.runCommand(command,args,options);
  };
  const report=await new DockerSbxBackend({home:testHome}).recoverHealth({runCommand,platformName:'darwin',inspectDaemons:async()=>null,inspectSandboxes:async()=>null,jobRunning:()=>busy,realpathPath:p=>p,userHome:testHome});
  assert.equal(report.recovered,!busy,JSON.stringify(report));
  assert.equal(verbs.includes('daemon stop'),!busy);
  assert.equal(verbs.includes('daemon start --detach'),!busy);
  assert.equal(report.preflight.checks.find(c=>c.name==='sbx_daemon').ok,!busy);
});

test('macOS shared home never automatically restarts an update',async()=>{
  process.env.FARAVAN_SBX_HOME=join(testHome,'.sbx');
  const stub=outdatedDaemonStub();
  const report=await new DockerSbxBackend({home:testHome}).recoverHealth({...stub,platformName:'darwin',inspectDaemons:async()=>null,inspectSandboxes:async()=>null});
  assert.equal(report.recovered,false);
  assert.equal(report.preflight.checks.find(c=>c.name==='sbx_daemon').automatic,false);
  assert.equal(stub.calls.some(c=>c.args[0]==='daemon'),false);
});
for(const mode of ['stop-fails','job-appears','sandbox-appears'])test(`macOS update restart is fenced when ${mode}`,async()=>{
  process.env.FARAVAN_DATA_HOME=testHome;
  const base=identityCommandStub();const verbs=[];let busy=false;
  const runCommand=async(c,a,o)=>{
    const verb=a.join(' ');verbs.push(verb);
    if(verb==='diagnose')return sbxUpdateOutput;
    if(verb==='ls --json'){if(mode==='job-appears')busy=true;return sbxUpdateOutput;}
    if(verb==='daemon stop')return result({code:1,stderr:'stop failed'});
    return base.runCommand(c,a,o);
  };
  let scans=0;
  const report=await new DockerSbxBackend({home:testHome}).recoverHealth({runCommand,platformName:'darwin',inspectDaemons:async()=>null,
    inspectSandboxes:async()=>mode==='sandbox-appears'&&++scans>1?[{pid:42}]:null,jobRunning:()=>busy});
  assert.equal(report.recovered,false);
  assert.equal(verbs.includes('daemon start --detach'),false);
  assert.equal(verbs.includes('daemon stop'),mode==='stop-fails');
});

test('colored captured update listing and existing policy capture share restart classification',()=>{
  for(const output of [sbxUpdateOutput,realUpdateFixture('policy-ls'),{...sbxUpdateOutput,stdout:'\x1b[31m'+sbxUpdateOutput.stdout+'\x1b[0m'}]){
    const hold=sandboxServiceUnavailableHold(output,{rowCount:3});
    assert.equal(hold.cause,'daemon_restart_required');
    assert.doesNotMatch(hold.message,/Open Docker Desktop|2c62|c5b1/);
  }
});
