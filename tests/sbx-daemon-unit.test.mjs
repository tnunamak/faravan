import './helpers/no-browser.mjs';
import './helpers/short-sbx-home.mjs';
import {testSbxRuntimeFields} from './helpers/sandbox-receipt-fixture.mjs';
import test from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, lstatSync } from 'node:fs';
import { configHome } from '../lib/local-state.mjs';
import { fileURLToPath } from 'node:url';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { systemdShowEnvironment } from './helpers/systemd-environment.mjs';
import { DockerSbxBackend, credentialStoreEnv, ensureSbxDaemon, sbxDaemonDescription, resetSbxDaemonGate, sbxDaemonUnitName, restartSbxDaemon, sbxChildEnv, startSbxDaemon, _internal } from '../lib/docker-backend.mjs';

// The sbx daemon belongs to the cgroup of whatever started it. On Linux with a systemd user manager it runs as its own
// transient service, so a restart of the app (an update, a crash) no longer ends the daemon and every running sandbox.
// Every sbx call waits on one gate that starts a stopped daemon through that path first.

// The suite turns the gate off for everyone; these tests are about the gate.
delete process.env.FARAVAN_SBX_DAEMON_GATE;

const result = (overrides = {}) => ({ code: 0, stdout: '', stderr: '', ...overrides });
const fixtureBinDir = mkdtempSync(join(tmpdir(), 'sbx-unit-bin-'));
const absoluteSbx = join(fixtureBinDir, 'sbx');
writeFileSync(absoluteSbx, '#!/bin/sh\nexit 99\n', {mode:0o755});
process.env.PATH = fixtureBinDir + ':' + process.env.PATH;
process.on('exit', () => rmSync(fixtureBinDir, {recursive:true,force:true}));
const ownerId = createHash('sha256').update('synthetic install owner').digest('hex');
const ownerKey = createHash('sha256').update(fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '')).digest('hex');
mkdirSync(configHome(), {recursive:true});
writeFileSync(join(configHome(), 'sbx-daemon-owner-' + ownerKey + '.json'), JSON.stringify({id:ownerId, executable:absoluteSbx}));
const SBX = process.env.FARAVAN_SBX_BIN || 'sbx';
const legacyUnitName = () => `faravan-sbxd-${createHash('sha256').update(sbxChildEnv().HOME).digest('hex').slice(0, 12)}`;
const unitName = () => `${legacyUnitName()}-${ownerId}`;

// A scripted host: systemd state, unit state and daemon state, with every command recorded.
// What a desktop login leaves in the user manager: a service inherits it unless it is unset.
const MANAGER_ENV = 'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus\nDISPLAY=:0\nWAYLAND_DISPLAY=wayland-0\nSSH_AUTH_SOCK=/synthetic/agent.sock\nAWS_SECRET_ACCESS_KEY=synthetic-aws-secret\nGITHUB_TOKEN=synthetic-github-token\nDATABASE_URL=postgres://synthetic-user:synthetic-password@localhost/synthetic\nPASSWORD=synthetic-password\nHTTPS_PROXY=https://synthetic-user:synthetic-password@proxy.invalid\nHOME=/home/someone';
function host({ manager = 'running', unit = 'inactive', daemon = 'stopped', systemdRunFails = false, systemdRunTimesOutAfterStart = false, systemdRunTimesOutBeforeUnitAppears = false, cancelStartAfterUnitCreated = false, abortController, systemdProbeFails = false, daemonComesUp = true, showEnvFails = false, mainPid = '4242', processAlive = true, deactivatingReads = 0, ownedUnit = true, listing = [], propertyOrder = 'normal', replaceInvocationOnDaemonStatus = false, failedUnits = [], failedListFails = false, failedListOutput = null } = {}) {
  const pinned = sbxChildEnv();
  const state = {
    manager, unit, daemon, mainPid, processAlive, deactivatingReads, listing,
    loadState: unit === 'inactive' ? 'not-found' : 'loaded',
    invocationId: unit === 'inactive' ? '' : 'existing-invocation',
    pendingStart: null,
    description: ownedUnit ? sbxDaemonDescription() : 'A different service',
    execStart: ownedUnit ? `{ path=${absoluteSbx} ; argv[]=${absoluteSbx} daemon start ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=4242 ; code=(null) ; status=0/0 }` : 'path=/usr/bin/other ; argv[]=/usr/bin/other',
    environment: ownedUnit ? systemdShowEnvironment([...Object.entries(credentialStoreEnv(pinned.HOME, 'linux')), ['FARAVAN_SBXD_OWNER_ID', ownerId], ['FARAVAN_SBXD_INSTALL_ROOT', fileURLToPath(new URL('../',import.meta.url)).replace(/\/$/,'')], ['FARAVAN_SBXD_DATA_HOME', configHome()]]) : 'HOME=/other XDG_STATE_HOME=/other/state',
    replaceInvocationOnDaemonStatus,
  };
  let unitReads = 0;
  const calls = [];
  const runCommand = async (command, args, options = {}) => {
    const line = [command, ...args].join(' ');
    calls.push({ command, args, line, env: options.env });
    if (command === 'systemd-run' && args[0] === '--version') return systemdProbeFails ? result({ code: 1, stderr: 'systemd probe timed out', errorCode: 'ETIMEDOUT' }) : result({ stdout: 'systemd 255' });
    if (command === 'systemctl' && args.join(' ') === '--user is-system-running') return result({ code: state.manager === 'running' ? 0 : 1, stdout: `${state.manager}\n` });
    if (command === 'systemctl' && args[1] === 'show' && args.includes('ActiveState') && args.includes('MainPID')) {
      unitReads++;
      if (state.pendingStart && unitReads >= state.pendingStart.readAt) {
        Object.assign(state, state.pendingStart.unit);
        state.pendingStart = null;
      }
      if (state.unit === 'deactivating' && unitReads > state.deactivatingReads) state.unit = 'inactive';
      const values = {
        LoadState: state.loadState,
        ActiveState: state.loadState === 'not-found' ? '' : state.unit,
        MainPID: state.unit === 'active' ? state.mainPid : '0',
        InvocationID: state.invocationId,
        Description: state.description,
        ExecStart: state.execStart,
        Environment: state.environment,
      };
      if (args.includes('--value')) {
        const requested = args.flatMap((arg, index) => arg === '-p' ? [args[index + 1]] : []);
        const ordered = propertyOrder === 'reverse' ? requested.reverse() : requested;
        return result({ stdout: `${ordered.map(name => values[name] ?? '').join('\n')}\n` });
      }
      const requested = args.flatMap((arg, index) => arg === '-p' ? [args[index + 1]] : []);
      const ordered = propertyOrder === 'reverse' ? requested.reverse() : requested;
      return result({ stdout: ordered.map(name => `${name}=${values[name] ?? ''}`).join('\n') + '\n' });
    }
    if (command === 'systemctl' && args[1] === 'list-units' && args.includes('--state=failed')) {
      if (failedListFails) return result({ code: 1, stderr: 'Failed to connect to bus' });
      if (failedListOutput !== null) return result({ stdout: failedListOutput });
      const names = [...failedUnits, ...(state.unit === 'failed' ? [`${unitName()}.service`] : [])];
      return result({ stdout: names.map((name) => `${name} loaded failed failed Some description`).join('\n') + (names.length ? '\n' : '') });
    }
    if (command === 'systemctl' && args[1] === 'is-active') return result({ code: state.unit === 'active' ? 0 : 3, stdout: `${state.unit}\n` });
    if (command === 'systemctl' && args[1] === 'reset-failed') { state.unit = 'inactive'; state.loadState = 'loaded'; return result(); }
    if (command === 'systemctl' && args[1] === 'stop') { state.unit = 'inactive'; state.loadState = 'not-found'; state.mainPid = '0'; state.invocationId = ''; state.daemon = 'stopped'; return result(); }
    if (command === 'systemctl' && args[1] === 'show-environment') return result(showEnvFails ? { code: 1, stderr: 'Failed to connect to bus' } : { stdout: `${MANAGER_ENV}\n` });
    if (command === 'systemd-run') {
      if (systemdRunFails) return result({ code: 1, stderr: 'Failed to start transient service unit' });
      const environment = systemdShowEnvironment(Object.entries(resolvedUnitEnvironment({ args, env: options.env }, MANAGER_ENV)));
      if (systemdRunTimesOutBeforeUnitAppears) {
        state.pendingStart = { readAt: unitReads + 3, unit: {
          unit: 'active', loadState: 'loaded', invocationId: 'started-invocation',
          description: sbxDaemonDescription(), execStart: `{ path=${absoluteSbx} ; argv[]=${absoluteSbx} daemon start ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=4242 ; code=(null) ; status=0/0 }`, environment,
          ...(daemonComesUp ? { daemon: 'running' } : {}),
        } };
        return result({ code: 1, stderr: 'systemd-run timed out before the service appeared in show', errorCode: 'ETIMEDOUT', timedOut: true });
      }
      state.unit = 'active'; state.loadState = 'loaded'; state.mainPid=mainPid; state.invocationId = 'started-invocation';
      state.description = sbxDaemonDescription();
      state.execStart = `{ path=${absoluteSbx} ; argv[]=${absoluteSbx} daemon start ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=4242 ; code=(null) ; status=0/0 }`;
      state.environment = environment;
      if (daemonComesUp) state.daemon = 'running';
      if (cancelStartAfterUnitCreated) abortController.abort();
      if (systemdRunTimesOutAfterStart) return result({ code: 1, stderr: 'systemd-run timed out after activating the service', errorCode: 'ETIMEDOUT', timedOut: true });
      return result();
    }
    if (command === SBX && args.join(' ') === 'daemon status') {
      if (state.replaceInvocationOnDaemonStatus) {
        state.invocationId = 'replacement-invocation';
        state.environment = state.environment.replace(/FARAVAN_SBXD_START_TOKEN=[^\s]*/, 'FARAVAN_SBXD_START_TOKEN=replacement-token');
      }
      return result({ stdout: `Status:  ${state.daemon === 'running' ? '● ' : ''}${state.daemon}\n  Socket:  /x/sandboxd.sock\n` });
    }
    if (command === SBX && args.join(' ') === 'daemon stop') { state.daemon = 'stopped'; return result(); }
    if (command === SBX && args.join(' ') === 'ls --json') return result({ stdout: JSON.stringify(state.listing) });
    if (command === SBX && args.join(' ') === 'daemon start --detach') { state.daemon = 'running'; return result(); }
    if (command === SBX && ['exec', 'stop', 'rm', 'run'].includes(args[0])) return result();
    throw new Error(`unexpected command: ${line}`);
  };
  return { calls, runCommand, state, lines: () => calls.map((call) => call.line) };
}

const START = { inspectDaemons:async()=>[{pid:4242,environ:sbxChildEnv()}], platformName: 'linux', systemd: true, readyPollMs: 1, isProcessAlive: (pid) => pid === 4242 };

test('on Linux with a systemd user manager the daemon starts as its own transient service with the pinned environment', async () => {
  const fake = host();
  const started = await startSbxDaemon({ runCommand: fake.runCommand, ...START });
  assert.equal(started.code, 0);
  const run = fake.calls.find((call) => call.command === 'systemd-run' && call.args[0] === '--user');
  assert.ok(run, 'systemd-run was called');
  const env = sbxChildEnv();
  const allowlist = ['HOME', 'PATH', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'DBUS_SESSION_BUS_ADDRESS', 'BROWSER', 'LANG', 'LC_ALL', 'TMPDIR', 'FARAVAN_SBXD_OWNER_ID', 'FARAVAN_SBXD_START_TOKEN', 'FARAVAN_SBXD_INSTALL_ROOT', 'FARAVAN_SBXD_DATA_HOME'];
  const setenv = [...allowlist.filter((key) => Object.hasOwn(env, key)), 'FARAVAN_SBXD_OWNER_ID', 'FARAVAN_SBXD_START_TOKEN', 'FARAVAN_SBXD_INSTALL_ROOT', 'FARAVAN_SBXD_DATA_HOME'].sort().map((key) => (key === 'DBUS_SESSION_BUS_ADDRESS' ? `--setenv=${key}=${env[key]}` : `--setenv=${key}`));
  const unsetArg = run.args.find((arg) => arg.startsWith('--property=UnsetEnvironment='));
  assert.ok(unsetArg, 'inherited manager variables are unset');
  assert.deepEqual(run.args, ['--user', `--unit=${unitName()}`, '--collect', '--quiet', `--description=${sbxDaemonDescription()}`, '--property=KillMode=mixed', unsetArg, ...setenv, '--', absoluteSbx, 'daemon', 'start']);
  const unset = unsetArg.slice('--property=UnsetEnvironment='.length).split(' ');
  const setenvNames = setenv.map((arg) => arg.slice('--setenv='.length).split('=')[0]);
  for (const key of ['DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY', 'SSH_AUTH_SOCK']) {
    if (!Object.hasOwn(env, key)) assert.ok(unset.includes(key), `${key} from the user manager does not reach the daemon`);
  }
  assert.equal(unset.some((key) => setenvNames.includes(key)), false, 'nothing the daemon allowlist sets is unset');
  assert.match(unitName(), /^faravan-sbxd-[0-9a-f]{12}-[0-9a-f]{64}$/);
  assert.ok(setenv.includes('--setenv=HOME') && setenv.includes('--setenv=XDG_STATE_HOME'), 'the daemon gets the HOME and XDG state every later CLI call uses');
  // Values stay off the command line (world-readable in /proc/<pid>/cmdline); systemd-run copies them from its own environment.
  assert.equal(run.args.some((arg) => arg.startsWith('--setenv=') && arg.includes('=', '--setenv='.length) && !arg.startsWith('--setenv=DBUS_SESSION_BUS_ADDRESS=')), false, 'no value but the dead bus pin is on the command line');
  assert.equal(run.env.HOME, env.HOME);
  assert.equal(run.env.XDG_STATE_HOME, env.XDG_STATE_HOME);
  assert.match(run.env.FARAVAN_SBXD_OWNER_ID, /^[0-9a-f]{64}$/);
  assert.match(run.env.FARAVAN_SBXD_START_TOKEN, /^[0-9a-f-]{36}$/);
  assert.equal(run.env.DBUS_SESSION_BUS_ADDRESS, process.env.DBUS_SESSION_BUS_ADDRESS, 'systemd-run reaches the manager over the login bus');
  assert.ok(setenv.includes(`--setenv=DBUS_SESSION_BUS_ADDRESS=${env.DBUS_SESSION_BUS_ADDRESS}`), 'the daemon gets the dead bus pin');
  assert.equal(fake.lines().some((line) => /daemon start --detach/.test(line)), false, 'a service needs the foreground daemon');
  const control = fake.calls.find((call) => call.command === 'systemctl' && call.args[1] === 'is-system-running');
  assert.equal(control.env, process.env, 'systemctl runs in the login session environment, not the pinned one');
});

test('a failed unit is reset before the new one starts', async () => {
  const fake = host({ unit: 'failed' });
  assert.equal((await startSbxDaemon({ runCommand: fake.runCommand, ...START })).code, 0);
  const lines = fake.lines();
  const reset = lines.indexOf(`systemctl --user reset-failed ${unitName()}`);
  const run = lines.findIndex((line) => line.startsWith('systemd-run --user'));
  assert.ok(reset >= 0 && run > reset, `reset-failed comes before systemd-run: ${lines.join(' | ')}`);
});

test('an active unit is left alone: nothing is started', async () => {
  const fake = host({ unit: 'active', daemon: 'running' });
  assert.equal((await startSbxDaemon({ runCommand: fake.runCommand, ...START })).code, 0);
  assert.equal(fake.lines().some((line) => line.startsWith('systemd-run --user') || line.includes('reset-failed')), false);
});

test('unit property names keep an active service from being restarted when output order changes', async () => {
  const fake = host({ unit: 'active', daemon: 'running', propertyOrder: 'reverse' });
  const started = await startSbxDaemon({ runCommand: fake.runCommand, ...START });
  assert.equal(started.code, 0);
  assert.equal(fake.lines().some((line) => line.startsWith('systemd-run --user') || line.includes('reset-failed')), false);
});

test('a failed same-name unit from another tool is refused without reset or start', async () => {
  const fake = host({ unit: 'failed', ownedUnit: false });
  const started = await startSbxDaemon({ runCommand: fake.runCommand, ...START });
  assert.equal(started.code, 1);
  assert.equal(started.status, 'systemd_unit_conflict');
  assert.match(started.stderr, /not owned by Faravan/);
  const ownershipRead = fake.calls.find((call) => call.command === 'systemctl' && call.args[1] === 'show');
  assert.ok(['LoadState', 'Description', 'ExecStart', 'Environment'].every((name) => ownershipRead.args.includes(name)),
    'the existing unit origin and profile are verified before reset');
  assert.equal(fake.lines().some((line) => line.includes('reset-failed') || line.startsWith('systemd-run --user')), false);
});

test('a readiness failure stops and verifies only the invocation this start created', async () => {
  const fake = host({ daemonComesUp: false });
  const started = await startSbxDaemon({ runCommand: fake.runCommand, ...START, readyTimeoutMs: 10, readyPollMs: 1 });
  assert.equal(started.code, 1);
  assert.equal(started.status, 'daemon_not_ready');
  assert.equal(fake.lines().filter((line) => line === `systemctl --user stop ${unitName()}`).length, 1);
  assert.equal(fake.state.unit, 'inactive');
  assert.ok(fake.calls.some(call => call.command === 'systemctl' && call.args[1] === 'show' && call.args.includes('ActiveState')),
    'the unit state is read back after stop');
});

test('a timed-out start reconciles and stops only the service it started', async () => {
  const fake = host({ systemdRunTimesOutAfterStart: true });
  const started = await startSbxDaemon({ runCommand: fake.runCommand, ...START });
  assert.equal(started.code, 1);
  assert.equal(started.status, 'systemd_start_failed');
  assert.equal(fake.lines().filter((line) => line === `systemctl --user stop ${unitName()}`).length, 1);
  assert.equal(fake.state.unit, 'inactive');
  assert.ok(fake.calls.some(call => call.command === 'systemctl' && call.args[1] === 'show' && call.args.includes('InvocationID')),
    'the timeout is reconciled against the unit identity before cleanup');
});

test('a timed-out start waits for unit registration before deciding whether it owns a cleanup target', async () => {
  const fake = host({ systemdRunTimesOutBeforeUnitAppears: true });
  const started = await startSbxDaemon({ runCommand: fake.runCommand, ...START, readyTimeoutMs: 20, readyPollMs: 1 });
  assert.equal(started.code, 1);
  assert.equal(started.status, 'systemd_start_failed');
  assert.equal(fake.lines().filter((line) => line === `systemctl --user stop ${unitName()}`).length, 1);
  assert.equal(fake.state.unit, 'inactive');
});

test('cancelling startup stops and verifies the service created by that start', async () => {
  const abortController = new AbortController();
  const fake = host({ cancelStartAfterUnitCreated: true, abortController });
  const started = await startSbxDaemon({ runCommand: fake.runCommand, ...START, signal: abortController.signal });
  assert.equal(started.code, 1);
  assert.equal(started.status, 'sandbox_check_cancelled');
  assert.equal(fake.lines().filter((line) => line === `systemctl --user stop ${unitName()}`).length, 1);
  assert.equal(fake.state.unit, 'inactive');
});

test('readiness cleanup leaves a replacement invocation alone', async () => {
  const fake = host({ daemonComesUp: false, replaceInvocationOnDaemonStatus: true });
  const started = await startSbxDaemon({ runCommand: fake.runCommand, ...START, readyTimeoutMs: 10, readyPollMs: 1 });
  assert.equal(started.code, 1);
  assert.equal(started.status, 'systemd_start_cleanup_failed');
  assert.equal(fake.lines().some(line => line === `systemctl --user stop ${unitName()}`), false);
  assert.equal(fake.state.invocationId, 'replacement-invocation');
});

test('a start that never reports running is bounded and fails with the status it saw', async () => {
  const fake = host({ daemonComesUp: false });
  const started = await startSbxDaemon({ runCommand: fake.runCommand, ...START, readyTimeoutMs: 30 });
  assert.equal(started.code, 1);
  assert.match(started.stderr, /did not become ready/);
  assert.match(started.stderr, /stopped/);
});

test('a refused systemd-run is returned as the start result', async () => {
  const fake = host({ systemdRunFails: true });
  const started = await startSbxDaemon({ runCommand: fake.runCommand, ...START });
  assert.equal(started.code, 1);
  assert.equal(started.status, 'systemd_start_failed');
  assert.match(started.stderr, /refused to start the managed sandbox service/);
});

test('a failed manager probe refuses the managed start without using a detached daemon', async () => {
  const fake = host({ systemdProbeFails: true });
  const started = await startSbxDaemon({ runCommand: fake.runCommand, ...START });
  assert.equal(started.code, 1);
  assert.equal(started.status, 'systemd_probe_failed');
  assert.equal(fake.lines().some((line) => line.includes('daemon start --detach') || line.startsWith('systemd-run --user')), false);
});

test('a timed-out user-manager probe refuses instead of using a detached daemon', async () => {
  const fake = host();
  const runCommand = async (command, args, options) => {
    if (command === 'systemctl' && args.join(' ') === '--user is-system-running') {
      return result({ code: 1, stderr: 'synthetic timeout', errorCode: 'ETIMEDOUT', timedOut: true });
    }
    return fake.runCommand(command, args, options);
  };
  const started = await startSbxDaemon({ runCommand, ...START });
  assert.equal(started.code, 1);
  assert.equal(started.status, 'systemd_probe_failed');
  assert.equal(fake.lines().some((line) => line.includes('daemon start --detach') || line.startsWith('systemd-run --user')), false);
});

// The installed app unit removes both session-bus variables from its environment. Only the systemd calls get them back.
const BUS_NAMES = ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'];
async function withoutSessionBus(runtimeDirWithBus, body) {
  const saved = Object.fromEntries(BUS_NAMES.map((name) => [name, process.env[name]]));
  const dir = mkdtempSync(join(tmpdir(), 'sbx-bus-'));
  for (const name of BUS_NAMES) delete process.env[name];
  const restore = _internal.useBusRuntimeDir(() => (runtimeDirWithBus ? dir : null));
  try { return await body(dir); }
  finally {
    restore();
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    rmSync(dir, { recursive: true, force: true });
  }
}
const hasBus = (env) => BUS_NAMES.every((name) => env?.[name]);

test('the manager probe gets the user bus even when the app environment has none', async () => {
  await withoutSessionBus(true, async () => {
    const fake = host();
    const started = await startSbxDaemon({ runCommand: fake.runCommand, ...START });
    assert.notEqual(started.status, 'systemd_probe_failed');
    const probes = fake.calls.filter((call) => call.command === 'systemctl' && call.args.join(' ') === '--user is-system-running');
    assert.ok(probes.length > 0);
    for (const call of fake.calls.filter((c) => c.command === 'systemctl' || c.command === 'systemd-run')) assert.ok(hasBus(call.env), call.line);
  });
});

test('without a bus socket the manager probe still refuses', async () => {
  await withoutSessionBus(false, async () => {
    const fake = host();
    const runCommand = async (command, args, options = {}) => command === 'systemctl' && !hasBus(options.env)
      ? result({ code: 1, stderr: 'Failed to connect to user scope bus' }) : fake.runCommand(command, args, options);
    const started = await startSbxDaemon({ runCommand, ...START });
    assert.equal(started.code, 1);
    assert.equal(started.status, 'systemd_probe_failed');
  });
});

test('the session bus never reaches sbx children or the daemon unit', async () => {
  await withoutSessionBus(true, async (dir) => {
    const live = `unix:path=${dir}/bus`;
    const pin = sbxChildEnv().DBUS_SESSION_BUS_ADDRESS;
    assert.notEqual(pin, live);
    assert.equal(sbxChildEnv().XDG_RUNTIME_DIR, undefined);
    const fake = host();
    // Like the real systemctl: no bus in the environment, no answer.
    const runCommand = async (command, args, options = {}) => command === 'systemctl' && !hasBus(options.env)
      ? result({ code: 1, stderr: 'Failed to connect to user scope bus' }) : fake.runCommand(command, args, options);
    const started = await startSbxDaemon({ runCommand, ...START });
    assert.equal(started.code, 0);
    const run = fake.calls.find((call) => call.command === 'systemd-run' && call.args[0] === '--user');
    assert.ok(run);
    assert.equal(run.args.some((arg) => arg.startsWith('--setenv=XDG_RUNTIME_DIR')), false);
    assert.equal(run.args.some((arg) => arg.includes(dir)), false);
    assert.ok(run.args.includes(`--setenv=DBUS_SESSION_BUS_ADDRESS=${pin}`), 'the unit gets the dead pin');
    for (const call of fake.calls.filter((c) => c.command !== 'systemctl' && c.command !== 'systemd-run')) {
      assert.equal(call.env?.XDG_RUNTIME_DIR, undefined, call.line);
      assert.notEqual(call.env?.DBUS_SESSION_BUS_ADDRESS, live, call.line);
    }
  });
});

test('only a real socket owned by this user counts as the user bus', async () => {
  const { createServer } = await import('node:net');
  const { symlinkSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'sbx-busroot-'));
  const uid = process.getuid();
  const dir = join(root, String(uid)); mkdirSync(dir);
  const probe = (options = {}) => _internal.userBusRuntimeDir(uid, { runtimeRoot: root, ...options });
  try {
    assert.equal(probe(), null, 'no bus entry');
    writeFileSync(join(dir, 'bus'), '');
    assert.equal(probe(), null, 'a regular file');
    rmSync(join(dir, 'bus'));
    const server = createServer();
    await new Promise((resolve) => server.listen(join(dir, 'bus'), resolve));
    try {
      assert.equal(probe(), dir, 'a socket of this user');
      assert.equal(probe({ lstat: (path) => Object.assign(Object.create(Object.getPrototypeOf(lstatSync(path))), lstatSync(path), { uid: uid + 1, isSocket: () => true, isSymbolicLink: () => false }) }), null, 'another user');
    } finally { await new Promise((resolve) => server.close(resolve)); }
    mkdirSync(join(root, 'real')); 
    const target = join(root, 'target-sock');
    const other = createServer(); await new Promise((resolve) => other.listen(target, resolve));
    try { rmSync(join(dir, 'bus'), { force: true }); symlinkSync(target, join(dir, 'bus')); assert.equal(probe(), null, 'a symlink to a socket'); }
    finally { await new Promise((resolve) => other.close(resolve)); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('help reads never wait on the sandbox daemon', () => {
  assert.equal(_internal.needsSbxDaemon(['run', '--help']), false);
  assert.equal(_internal.needsSbxDaemon(['policy', 'reset', '--help']), false);
  assert.equal(_internal.needsSbxDaemon(['run', '--name', 'x']), true);
  assert.equal(_internal.needsSbxDaemon(['exec', 'wf-x', '--', 'sh', '-c', 'echo executed', '--help']), true);
  assert.equal(_internal.needsSbxDaemon(['run', '--name', '--help']), true);
  assert.equal(_internal.needsSbxDaemon(['run', '--help', '--name', 'x']), true);
  assert.equal(_internal.needsSbxDaemon(['ls', '-q']), true);
});

test('an unreadable user-manager environment refuses the service start rather than leak it to the daemon', async () => {
  const fake = host({ showEnvFails: true });
  const started = await startSbxDaemon({ runCommand: fake.runCommand, ...START });
  assert.equal(started.code, 1);
  assert.equal(fake.lines().some((line) => line.startsWith('systemd-run --user')), false);
});

for (const [label, options, setup] of [
  ['offline', START, { manager: 'offline' }],
  ['starting', START, { manager: 'starting' }],
  ['initializing', START, { manager: 'initializing' }],
  ['stopping', START, { manager: 'stopping' }],
  ['unknown', START, { manager: 'unknown' }],
]) {
  test(`a ${label} user manager refuses a managed start`, async () => {
    const fake = host(setup);
    const started = await startSbxDaemon({ runCommand: fake.runCommand, ...options });
    assert.equal(started.code, 1);
    assert.equal(started.status, 'systemd_manager_not_ready');
    assert.equal(fake.lines().some((line) => line.startsWith('systemd-run --user')), false);
    assert.equal(fake.lines().some((line) => line.includes('daemon start --detach')), false);
  });
}

test('a platform without a systemd user manager may use the detached daemon', async () => {
  const fake = host();
  const started = await startSbxDaemon({ runCommand: fake.runCommand, ...START, systemd: false });
  assert.equal(started.code, 0);
  assert.equal(started.status, 'no_systemd_user_manager');
  assert.equal(fake.lines().some((line) => line.startsWith('systemd-run --user')), false);
  assert.ok(fake.lines().includes(`${SBX} daemon start --detach`));
});

test('a missing systemctl executable reports no manager and permits the detached start', async () => {
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push([command, ...args].join(' '));
    if (command === 'systemctl') throw Object.assign(new Error('missing systemctl'), { code: 'ENOENT' });
    return result();
  };
  const started = await startSbxDaemon({ runCommand, ...START });
  assert.equal(started.code, 0);
  assert.equal(started.status, 'no_systemd_user_manager');
  assert.deepEqual(calls, ['systemctl --user is-system-running', `${SBX} daemon start --detach`]);
});

test('macOS may use the detached daemon', async () => {
  const fake = host();
  const started = await startSbxDaemon({ runCommand: fake.runCommand, ...START, platformName: 'darwin' });
  assert.equal(started.code, 0);
  assert.equal(started.status, 'no_systemd_user_manager');
  assert.ok(fake.lines().includes(`${SBX} daemon start --detach`));
});

test('a unit that is still deactivating is not started over', async () => {
  const fake = host({ unit: 'deactivating', deactivatingReads: Number.MAX_SAFE_INTEGER });
  const started = await startSbxDaemon({ runCommand: fake.runCommand, ...START, readyTimeoutMs: 10, readyPollMs: 1 });
  assert.equal(started.code, 1);
  assert.equal(started.status, 'systemd_unit_deactivating');
  assert.equal(fake.lines().some((line) => line.startsWith('systemd-run --user')), false);
});

test('a deactivating unit is allowed to finish before its name is reused', async () => {
  const fake = host({ unit: 'deactivating', deactivatingReads: 1 });
  const started = await startSbxDaemon({ runCommand: fake.runCommand, ...START });
  assert.equal(started.code, 0);
  assert.ok(fake.lines().some((line) => line.startsWith('systemd-run --user')));
});

test('each gate call verifies the managed unit and its live main process', async () => {
  resetSbxDaemonGate();
  const fake = host();
  await ensureSbxDaemon({ runCommand: fake.runCommand, ...START });
  assert.equal(fake.lines().filter((line) => line.startsWith('systemd-run --user')).length, 1);
  const before = fake.calls.length;
  await ensureSbxDaemon({ runCommand: fake.runCommand, ...START });
  assert.ok(fake.calls.length > before, 'the next call reads the service liveness');
  assert.equal(fake.calls.filter((call) => call.command === 'systemctl' && call.args[1] === 'show' && call.args.includes('ActiveState') && call.args.includes('MainPID')).length, 4);
  resetSbxDaemonGate();
  const running = host({ daemon: 'running' });
  await assert.rejects(ensureSbxDaemon({ runCommand: running.runCommand, ...START, inspectDaemons:async()=>[], isProcessAlive: () => true }), (error) => {
    assert.equal(error.status, 'daemon_not_managed');
    assert.match(error.message, /FARAVAN_SBX_HOME/);
    assert.doesNotMatch(error.message, /daemon stop/);
    return true;
  });
  assert.equal(running.lines().some((line) => line.startsWith('systemd-run --user')), false);
  const dead = host({ daemon: 'running', unit: 'active' });
  await assert.rejects(ensureSbxDaemon({ runCommand: dead.runCommand, ...START, isProcessAlive: () => false }), { status: 'systemd_unit_mainpid_not_alive' });
  const degraded = host({ manager: 'degraded', daemon: 'running', unit: 'active' });
  await assert.doesNotReject(ensureSbxDaemon({ runCommand: degraded.runCommand, ...START }));
});

test('a stopped managed unit is not hidden by a previous successful check', async () => {
  resetSbxDaemonGate();
  const fake = host();
  await ensureSbxDaemon({ runCommand: fake.runCommand, ...START });
  fake.state.unit = 'inactive';
  fake.state.daemon = 'running';
  await assert.rejects(ensureSbxDaemon({ runCommand: fake.runCommand, ...START, inspectDaemons:async()=>[], isProcessAlive: () => true }), { status: 'daemon_not_managed' });
});

test('legacy daemon inventory permits no unlaunched sandbox mutations or migration', async () => {
  resetSbxDaemonGate();
  const fake = host({ daemon: 'running', listing: [{ name: 'wf-legacy123', status: 'running' }] });
  const daemons = [{ pid: 4242, environ: sbxChildEnv() }];
  const options = { runCommand: fake.runCommand, ...START, inspectDaemons: async () => daemons, isProcessAlive: () => true };

  await assert.rejects(ensureSbxDaemon({ ...options, commandArgs: ['exec', 'wf-legacy123', '--', 'true'] }), {status:'legacy_daemon_drain_only'});
  await assert.rejects(ensureSbxDaemon({ ...options, commandArgs: ['run', '--name', 'wf-new'] }), { status: 'legacy_daemon_drain_only' });

  const restart = await restartSbxDaemon({
    runCommand: fake.runCommand, daemons, sandboxes: [], waitForExit: async () => true,
    inspectSandboxes: async () => [], update: false, platformName: 'linux', systemd: true,
  });
  assert.equal(restart.ok, false);
  assert.match(restart.detail, /sandbox is running/i);
  assert.equal(fake.lines().some(line => line === `${SBX} daemon stop`), false, 'the legacy daemon stays alive while its sandbox is active');
  assert.equal(fake.lines().some(line => line.startsWith('systemd-run --user')), false, 'new work is not detached into the legacy service');

  await assert.rejects(ensureSbxDaemon({ ...options, commandArgs: ['stop', 'wf-legacy123'] }), {status:'legacy_daemon_drain_only'});
  fake.state.listing = [{ name: 'wf-legacy123', status: 'stopped' }];
  await assert.rejects(ensureSbxDaemon({ ...options, commandArgs: ['rm', '--force', 'wf-legacy123'] }), {status:'legacy_daemon_drain_only'});
  const refusedRestart = await restartSbxDaemon({
    runCommand: fake.runCommand, daemons, sandboxes: [], waitForExit: async () => true,
    inspectSandboxes: async () => [], update: true, platformName: 'linux', systemd: true, isProcessAlive: () => true,
  });
  assert.equal(refusedRestart.ok, false);
  assert.match(refusedRestart.detail, /ownership|owned/i);
  assert.equal(fake.lines().some(line => line === `${SBX} daemon stop` || line.startsWith('systemd-run --user')), false);
});

test('a pending drain check cannot authorize concurrent new sandbox work', async () => {
  resetSbxDaemonGate();
  const fake = host({ daemon: 'running', listing: [{ name: 'wf-legacy123', status: 'running' }] });
  const daemons = [{ pid: 4242, environ: sbxChildEnv() }];
  let releaseListing, listingRead;
  const listingGate = new Promise((resolve) => { releaseListing = resolve; });
  const firstListing = new Promise((resolve) => { listingRead = resolve; });
  const runCommand = async (command, args, options) => {
    if (command === SBX && args.join(' ') === 'ls --json') {
      listingRead();
      await listingGate;
    }
    return fake.runCommand(command, args, options);
  };
  const options = { runCommand, ...START, inspectDaemons: async () => daemons, isProcessAlive: () => true };
  const drain = ensureSbxDaemon({ ...options, commandArgs: ['stop', 'wf-legacy123'] });
  await firstListing;
  const create = ensureSbxDaemon({ ...options, commandArgs: ['run', '--name', 'wf-new'] });
  releaseListing();
  await assert.rejects(drain, {status:'legacy_daemon_drain_only'});
  await assert.rejects(create, { status: 'legacy_daemon_drain_only' });
});

test('concurrent callers share one check', async () => {
  resetSbxDaemonGate();
  const fake = host();
  await Promise.all([1, 2, 3, 4].map(() => ensureSbxDaemon({ runCommand: fake.runCommand, ...START })));
  assert.equal(fake.lines().filter((line) => line === `${SBX} daemon status`).length >= 1, true);
  assert.equal(fake.lines().filter((line) => line.startsWith('systemd-run --user')).length, 1);
});

test('a status that is neither running nor stopped refuses every call', async () => {
  resetSbxDaemonGate();
  const calls = [];
  const runCommand = async (command, args) => { calls.push([command, ...args].join(' ')); return result({ code: 1, stderr: 'spawn sbx ENOENT', errorCode: 'ENOENT' }); };
  await assert.rejects(ensureSbxDaemon({ runCommand, ...START }), { status: 'daemon_status_unknown' });
  await assert.rejects(ensureSbxDaemon({ runCommand, ...START }), { status: 'daemon_status_unknown' });
  assert.deepEqual(calls, [
    'systemctl --user is-system-running', `${SBX} daemon status`,
    'systemctl --user is-system-running', `${SBX} daemon status`,
  ]);
});

test('a failed managed start refuses each call instead of passing through', async () => {
  resetSbxDaemonGate();
  const fake = host({ systemdRunFails: true });
  await assert.rejects(ensureSbxDaemon({ runCommand: fake.runCommand, ...START }), { status: 'systemd_start_failed' });
  await assert.rejects(ensureSbxDaemon({ runCommand: fake.runCommand, ...START }), { status: 'systemd_start_failed' });
  assert.equal(fake.lines().filter((line) => line.startsWith('systemd-run --user')).length, 2);
});

test('the systemd unit environment excludes inherited secret-looking variables', async () => {
  const names = ['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'DATABASE_URL', 'PASSWORD', 'HTTPS_PROXY'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    AWS_SECRET_ACCESS_KEY: 'synthetic-aws-secret', GITHUB_TOKEN: 'synthetic-github-token', SSH_AUTH_SOCK: '/synthetic/agent.sock',
    DATABASE_URL: 'postgres://synthetic-user:synthetic-password@localhost/synthetic', PASSWORD: 'synthetic-password', HTTPS_PROXY: 'https://synthetic-user:synthetic-password@proxy.invalid',
  });
  try {
    const fake = host();
    const started = await startSbxDaemon({ runCommand: fake.runCommand, ...START });
    assert.equal(started.code, 0);
    const run = fake.calls.find((call) => call.command === 'systemd-run' && call.args[0] === '--user');
    const environment = resolvedUnitEnvironment(run, MANAGER_ENV);
    for (const name of names) assert.equal(Object.hasOwn(environment, name), false, `${name} is absent from the unit Environment`);
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

function resolvedUnitEnvironment(run, managerEnvironment) {
  const environment = Object.fromEntries(managerEnvironment.split('\n').filter(Boolean).map((entry) => {
    const index = entry.indexOf('=');
    return [entry.slice(0, index), entry.slice(index + 1)];
  }));
  for (const argument of run.args) {
    if (!argument.startsWith('--property=UnsetEnvironment=')) continue;
    for (const name of argument.slice('--property=UnsetEnvironment='.length).split(/\s+/).filter(Boolean)) delete environment[name];
  }
  for (const argument of run.args.filter((arg) => arg.startsWith('--setenv='))) {
    const item = argument.slice('--setenv='.length), index = item.indexOf('=');
    const name = index < 0 ? item : item.slice(0, index);
    const value = index < 0 ? run.env[name] : item.slice(index + 1);
    if (value === undefined) delete environment[name]; else environment[name] = value;
  }
  return environment;
}

test('the gate leaves another identity, another binary and the off switch alone', async () => {
  resetSbxDaemonGate();
  const fake = host();
  await ensureSbxDaemon({ runCommand: fake.runCommand, ...START, env: { ...sbxChildEnv(), HOME: '/somewhere/else' } });
  await ensureSbxDaemon({ runCommand: fake.runCommand, ...START, bin: '/stub/sbx' });
  const previous = process.env.FARAVAN_SBX_DAEMON_GATE;
  process.env.FARAVAN_SBX_DAEMON_GATE = 'off';
  try { await ensureSbxDaemon({ runCommand: fake.runCommand, ...START }); }
  finally { if (previous === undefined) delete process.env.FARAVAN_SBX_DAEMON_GATE; else process.env.FARAVAN_SBX_DAEMON_GATE = previous; }
  assert.deepEqual(fake.calls, []);
});

test('a restart starts through the same path and the next call verifies it again', async () => {
  resetSbxDaemonGate();
  const fake = host({ daemon: 'running', unit: 'active', mainPid: String(process.pid) });
  const alive = (pid) => Number(pid) === process.pid;
  await ensureSbxDaemon({ runCommand: fake.runCommand, ...START, inspectDaemons:async()=>[{pid:process.pid,environ:sbxChildEnv()}], isProcessAlive: alive });
  const stopping = async (command, args, options) => {
    if (command === SBX && args.join(' ') === 'daemon stop') { fake.state.daemon = 'stopped'; fake.state.unit = 'inactive'; fake.calls.push({ command, args, line: `${command} ${args.join(' ')}` }); return result(); }
    if (command === SBX && args.join(' ') === 'ls --json') return result({ stdout: '[]' });
    return fake.runCommand(command, args, options);
  };
  const restarted = await restartSbxDaemon({ runCommand: stopping, inspectDaemons:async()=>[{pid:process.pid,environ:sbxChildEnv()}], daemons: [{ pid: process.pid, environ: sbxChildEnv() }], sandboxes: [], waitForExit: async () => true, update: true, platformName: 'linux', systemd: true, isProcessAlive: alive });
  assert.equal(restarted.ok, true);
  assert.ok(fake.lines().some((line) => line.startsWith('systemd-run --user')), 'the restart starts the managed service again');
  const before = fake.calls.length;
  await ensureSbxDaemon({ runCommand: fake.runCommand, ...START, inspectDaemons:async()=>[{pid:process.pid,environ:sbxChildEnv()}], isProcessAlive: alive });
  assert.ok(fake.calls.length > before, 'the next call checks the daemon again after the restart');
});

// The real runners, against a stand-in sbx that logs its argv and keeps a "running" flag. These tests point the
// manager probe at a bus that does not exist, so no real unit can be reached.
const NO_BUS = { XDG_RUNTIME_DIR: '/nonexistent', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/bus' };
async function withStandIn(run) {
  const stub = await standIn();
  for (const tool of ['systemctl','systemd-run']) await writeFile(join(stub.dir,tool), '#!/bin/sh\nexit 1\n', {mode:0o755});
  const savedPath = process.env.PATH;
  process.env.PATH = stub.dir + ':' + savedPath;
  const saved = Object.fromEntries(['FARAVAN_SBX_BIN', 'FARAVAN_SBX_DAEMON_GATE', ...Object.keys(NO_BUS)].map((key) => [key, process.env[key]]));
  delete process.env.FARAVAN_SBX_DAEMON_GATE;
  Object.assign(process.env, { FARAVAN_SBX_BIN: stub.bin, ...NO_BUS });
  resetSbxDaemonGate();
  try { await run(stub); } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    process.env.PATH = savedPath;
    resetSbxDaemonGate();
    await rm(stub.dir, { recursive: true, force: true });
  }
}
async function standIn() {
  const dir = await mkdtemp(join(tmpdir(), 'wf-gate-'));
  const log = join(dir, 'log'), running = join(dir, 'running'), refuseOnce = join(dir, 'refuse-once');
  await writeFile(join(dir, 'sbx'), `#!/bin/sh
echo "$@" >>${JSON.stringify(log)}
case "$1 $2" in
  "daemon status") if [ -e ${JSON.stringify(running)} ]; then echo "Status:  ● running"; else echo "  Status:  stopped"; fi; exit 0;;
  "daemon start") touch ${JSON.stringify(running)}; exit 0;;
esac
if [ "$1" = ls ] && [ -e ${JSON.stringify(refuseOnce)} ]; then rm -f ${JSON.stringify(refuseOnce)} ${JSON.stringify(running)}; echo "daemon connection refused" >&2; exit 1; fi
exit 0
`);
  await chmod(join(dir, 'sbx'), 0o755);
  return { dir, bin: join(dir, 'sbx'), refuseOnce, lines: async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean) };
}

test('an unverified user manager refuses a real sbx call before its command starts', () => withStandIn(async (stub) => {
  const backend = new DockerSbxBackend();
  // The control commands never wait on the daemon.
  await _internal.runPreflightCommand(stub.bin, ['daemon', 'status']);
  await _internal.runPreflightCommand(stub.bin, ['version']);
  await _internal.runPreflightCommand(stub.bin, ['daemon', 'stop']);
  assert.deepEqual(await stub.lines(), ['daemon status', 'version', 'daemon stop']);

  const refusedPreflight = await _internal.runPreflightCommand(stub.bin, ['policy', 'ls']);
  assert.equal(refusedPreflight.code, 1);
  assert.equal(refusedPreflight.status, 'systemd_probe_failed');

  const refused = await backend.runSbx(['ls']);
  assert.equal(refused.code, 1);
  assert.equal(refused.status, 'systemd_probe_failed');
  assert.deepEqual((await stub.lines()).slice(3), [], 'no sbx command is spawned when the manager cannot be verified');
}));

test('the streaming runner refuses before spawning a command when the manager cannot be verified', () => withStandIn(async (stub) => {
  const backend = new DockerSbxBackend();
  backend.assertActive = async () => {};backend._dispatchProtected=async(_h,signal,launch)=>{signal?.throwIfAborted();return launch();};
  const handle = { ...testSbxRuntimeFields(), backend_id: 'docker-sbx', job_id: 'j', sandbox_id: 'wf-x', scratch_dir: '/s' };
  await assert.rejects(backend._runJobCommand(handle, ['exec', 'wf-x', '--', 'true'], () => {}), { status: 'systemd_probe_failed' });
  assert.deepEqual(await stub.lines(), []);
}));

test('the output stream refuses before spawning exec when the manager cannot be verified', () => withStandIn(async (stub) => {
  const backend = new DockerSbxBackend();
  await assert.rejects(async () => { for await (const chunk of backend.streamOutput({ ...testSbxRuntimeFields(), sandbox_id: 'wf-x' }, '/s/f')) void chunk; }, { status: 'systemd_probe_failed' });
  assert.deepEqual(await stub.lines(), []);
}));

for (const marker of [undefined, createHash('sha256').update(`stable\0${sbxChildEnv().HOME}`).digest('hex')]) {
  test(`a failed same-profile unit with ${marker ? 'another install marker' : 'no marker'} is refused`, async () => {
    const previous=process.env.FARAVAN_SBX_BIN;
    process.env.FARAVAN_SBX_BIN=absoluteSbx;
    try {
      const fake = host({unit:'failed'});
      fake.state.environment = Object.entries(credentialStoreEnv(sbxChildEnv().HOME, 'linux')).map(([k,v]) => `${k}=${v}`).join(' ') + (marker ? ` FARAVAN_SBXD_OWNER_ID=${marker}` : '');
      const runCommand=(command,args,options)=>fake.runCommand(command===absoluteSbx?SBX:command,args,options);
      assert.equal((await startSbxDaemon({runCommand,...START})).status, 'systemd_unit_conflict');
      assert.equal(fake.lines().some(line => line.includes('reset-failed') || line.startsWith('systemd-run --user')), false);
    } finally {if(previous===undefined)delete process.env.FARAVAN_SBX_BIN;else process.env.FARAVAN_SBX_BIN=previous;}
  });
}
test('a prepared legacy sandbox cannot launch an agent through exec', async () => {
  resetSbxDaemonGate();
  const fake = host({daemon:'running', listing:[{name:'wf-prepared',status:'running'}]});
  await assert.rejects(ensureSbxDaemon({runCommand:fake.runCommand,...START,inspectDaemons:async()=>[{pid:4242,environ:sbxChildEnv()}],commandArgs:['exec','wf-prepared','--','sh','-c','claude -p task']}), {status:'legacy_daemon_drain_only'});
});
test('a degraded manager refuses a failed unit of this installation without starting or resetting', async () => {
  assert.equal((await startSbxDaemon({runCommand:host({manager:'degraded',unit:'active',daemon:'running'}).runCommand,...START})).code,0);
  const fake = host({manager:'degraded',unit:'failed',failedUnits:['whoopsie.service']});
  const started = await startSbxDaemon({runCommand:fake.runCommand,...START});
  assert.equal(started.code,1);
  assert.equal(started.status,'systemd_manager_degraded');
  assert.match(started.stderr,/service Faravan started earlier has failed/);
  assert.equal(fake.lines().some(line=>line.includes('reset-failed')||line.startsWith('systemd-run --user')),false);
});

const FOREIGN_FAILED = ['app-firefox-1234.scope','whoopsie.service','tmp-cleanup.service','faravan-sbxd-aaaaaaaaaaaa-'+'b'.repeat(64)+'.service'];
test('a degraded manager with only foreign failed units still creates the owned unit', async () => {
  const fake = host({manager:'degraded',failedUnits:FOREIGN_FAILED});
  const started = await startSbxDaemon({runCommand:fake.runCommand,...START});
  assert.equal(started.code,0);
  assert.ok(fake.lines().some(line=>line.startsWith(`systemd-run --user --unit=${unitName()}`)), 'the owned unit was created');
  assert.equal(fake.lines().some(line=>line.includes('reset-failed')),false);
});
test('a degraded manager with no failed unit listed still creates the owned unit', async () => {
  const fake = host({manager:'degraded'});
  assert.equal((await startSbxDaemon({runCommand:fake.runCommand,...START})).code,0);
  assert.ok(fake.lines().some(line=>line.startsWith('systemd-run --user')));
});
test('a degraded manager refuses to create the unit when its own name is in the failed list', async () => {
  const fake = host({manager:'degraded',failedUnits:['whoopsie.service',`${unitName()}.service`]});
  const started = await startSbxDaemon({runCommand:fake.runCommand,...START});
  assert.equal(started.code,1);
  assert.equal(started.status,'systemd_manager_degraded');
  assert.equal(fake.lines().some(line=>line.includes('reset-failed')||line.startsWith('systemd-run --user')),false);
});
for (const [label, options] of [['cannot be read',{failedListFails:true}],['cannot be parsed',{failedListOutput:'this is not a unit list\n'}]]) {
  test(`a degraded manager refuses to create the unit when the failed-unit list ${label}`, async () => {
    const fake = host({manager:'degraded',...options});
    const started = await startSbxDaemon({runCommand:fake.runCommand,...START});
    assert.equal(started.code,1);
    assert.equal(started.status,'systemd_manager_degraded');
    assert.match(started.stderr,/could not read which services failed/);
    assert.equal(fake.lines().some(line=>line.includes('reset-failed')||line.startsWith('systemd-run --user')),false);
  });
}
test('the failed-unit list is read without touching any unit', async () => {
  const fake = host({manager:'degraded',failedUnits:FOREIGN_FAILED});
  await startSbxDaemon({runCommand:fake.runCommand,...START});
  assert.ok(fake.lines().includes('systemctl --user list-units --state=failed --plain --no-legend'));
});
test('a running manager never reads the failed-unit list', async () => {
  const fake = host();
  await startSbxDaemon({runCommand:fake.runCommand,...START});
  assert.equal(fake.lines().some(line=>line.includes('list-units')),false);
});
test('a degraded manager can reuse only its active owned service', async () => {
  const fake = host({manager:'degraded',unit:'active',daemon:'running'});
  assert.equal((await startSbxDaemon({runCommand:fake.runCommand,...START})).code,0);
  fake.state.environment = '';
  assert.equal((await startSbxDaemon({runCommand:fake.runCommand,...START})).code,1);
});

// The default Linux preview profile keeps its data in a folder with spaces in its name.
async function withSpacedDataHome(run) {
  const saved = { FARAVAN_HOME: process.env.FARAVAN_HOME };
  const dataHome = mkdtempSync(join(tmpdir(), 'Faravan Preview '));
  writeFileSync(join(dataHome, 'sbx-daemon-owner-' + ownerKey + '.json'), JSON.stringify({id:ownerId, executable:absoluteSbx}));
  process.env.FARAVAN_HOME = dataHome;
  try { await run(dataHome); }
  finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    rmSync(dataHome, {recursive:true, force:true});
  }
}

for (const manager of ['degraded', 'running']) {
  test(`a ${manager} manager does not refuse our active unit when the data folder has a space`, async () => {
    await withSpacedDataHome(async dataHome => {
      assert.match(dataHome, / /);
      resetSbxDaemonGate();
      const fake = host({manager, unit:'active', daemon:'running'});
      assert.match(fake.state.environment, new RegExp('"FARAVAN_SBXD_DATA_HOME=' + dataHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"'), 'the fixture prints systemd quoting');
      await assert.doesNotReject(ensureSbxDaemon({runCommand:fake.runCommand, ...START}));
      assert.equal(fake.lines().some(line => line.startsWith('systemd-run --user') || line.includes('reset-failed') || line.includes(' stop ')), false);
      resetSbxDaemonGate();
      assert.equal((await startSbxDaemon({runCommand:fake.runCommand, ...START})).code, 0);
    });
  });
}

test('a data folder with a space does not make a foreign active unit look like ours', async () => {
  await withSpacedDataHome(async () => {
    resetSbxDaemonGate();
    const fake = host({manager:'running', unit:'active', daemon:'running'});
    fake.state.environment = fake.state.environment.replace(/"FARAVAN_SBXD_DATA_HOME=[^"]*"/, '"FARAVAN_SBXD_DATA_HOME=/home/someone/.local/share/Faravan Other"');
    await assert.rejects(ensureSbxDaemon({runCommand:fake.runCommand, ...START}), {status:'systemd_unit_conflict'});
  });
});

test('only a handle launched on the managed service can execute while draining', async () => {
  resetSbxDaemonGate();
  const fake = host({unit:'active',daemon:'running',listing:[{name:'wf-running',status:'running'}]});
  const backend = new DockerSbxBackend({runCommand:async args => {
    await ensureSbxDaemon({runCommand:fake.runCommand,...START,commandArgs:args,inspectDaemons:async()=>[{pid:4242,environ:sbxChildEnv()}]});
    return result();
  }});
  backend.assertActive = async () => {};backend._dispatchProtected=async(_h,signal,launch)=>{signal?.throwIfAborted();return launch();};
  const handle = { ...testSbxRuntimeFields(),sandbox_id:'wf-running'};
  await launchManagedHandle(backend,handle);
  fake.state.unit='inactive'; fake.state.loadState='not-found';
  await assert.doesNotReject(backend._runJobCommand(handle,['exec','wf-running','--','true']));
  await assert.rejects(backend._runJobCommand(handle,['exec','wf-running','--','sh','-c','claude -p task'],null,{agentRun:true}),{status:'legacy_daemon_drain_only'});
  await assert.rejects(backend._runJobCommand({ ...testSbxRuntimeFields(),sandbox_id:'wf-running'},['exec','wf-running','--','true']),{status:'legacy_daemon_drain_only'});
});

for (const unit of ['failed','unowned','unreadable']) {
  test(`a degraded manager gate refuses a ${unit} service`, async () => {
    resetSbxDaemonGate();
    await assert.doesNotReject(ensureSbxDaemon({runCommand:host({manager:'degraded',unit:'active',daemon:'running'}).runCommand,...START}));
    const fake = host({manager:'degraded',unit:['unowned','unreadable'].includes(unit)?'active':unit,daemon:'running',ownedUnit:unit!=='unowned'});
    if(unit==='unreadable') fake.state.environment='';
    await assert.rejects(ensureSbxDaemon({runCommand:fake.runCommand,...START}),{status:'systemd_manager_degraded'});
    assert.equal(fake.lines().some(line=>line.includes('reset-failed')||line.startsWith('systemd-run --user')),false);
  });
}
test('a degraded manager gate with only foreign failed units starts the owned service', async () => {
  resetSbxDaemonGate();
  const fake = host({manager:'degraded',failedUnits:FOREIGN_FAILED});
  await assert.doesNotReject(ensureSbxDaemon({runCommand:fake.runCommand,...START}));
  assert.ok(fake.lines().some(line=>line.startsWith(`systemd-run --user --unit=${unitName()}`)), 'the owned unit was created');
});
test('a degraded manager gate refuses when its own unit is in the failed list', async () => {
  resetSbxDaemonGate();
  const fake = host({manager:'degraded',failedUnits:[`${unitName()}.service`]});
  await assert.rejects(ensureSbxDaemon({runCommand:fake.runCommand,...START}),{status:'systemd_manager_degraded',message:/service Faravan started earlier has failed/});
  assert.equal(fake.lines().some(line=>line.includes('reset-failed')||line.startsWith('systemd-run --user')),false);
});
for (const [label, options] of [['cannot be read',{failedListFails:true}],['cannot be parsed',{failedListOutput:'not a unit list\n'}]]) {
  test(`a degraded manager gate refuses when the failed-unit list ${label}`, async () => {
    resetSbxDaemonGate();
    const fake = host({manager:'degraded',...options});
    await assert.rejects(ensureSbxDaemon({runCommand:fake.runCommand,...START}),{status:'systemd_manager_degraded',message:/could not read which services failed/});
    assert.equal(fake.lines().some(line=>line.startsWith('systemd-run --user')),false);
  });
}
test('a degraded manager gate leaves a running legacy daemon to the existing drain rules when foreign units failed', async () => {
  resetSbxDaemonGate();
  const fake = host({manager:'degraded',daemon:'running',failedUnits:FOREIGN_FAILED});
  await assert.rejects(ensureSbxDaemon({runCommand:fake.runCommand,...START,inspectDaemons:async()=>[],isProcessAlive:()=>true}),{status:'daemon_not_managed'});
  assert.equal(fake.lines().some(line=>line.startsWith('systemd-run --user')),false);
});


test('restart refuses a foreign idle daemon on the same HOME even with no jobs or sandboxes', async () => {
  const fake = host({daemon:'running', listing:[]});
  const restarted = await restartSbxDaemon({runCommand:fake.runCommand, ...START,
    daemons:[{pid:4242,environ:sbxChildEnv()}],sandboxes:[],inspectSandboxes:async()=>[],
    jobRunning:()=>false, waitForExit:async()=>true,update:true});
  assert.equal(fake.lines().some(line=>line===`${SBX} daemon stop` || line.includes('--user stop')),false);
  assert.equal(fake.state.daemon,'running');
  assert.equal(restarted.ok,false);
  assert.match(restarted.detail,/ownership|owned/i);
});

test('unit names bind the saved install owner, so a replacement with another owner has a different name', () => {
  assert.equal(sbxDaemonUnitName(sbxChildEnv().HOME), unitName());
});

test('a live owned unit is accepted after its pinned executable is removed', async () => {
  const fake=host({unit:'active',daemon:'running'});
  const missing=join(fixtureBinDir,'removed-sbx');
  const record=join(configHome(),'sbx-daemon-owner-'+ownerKey+'.json');
  writeFileSync(record,JSON.stringify({id:ownerId,executable:missing}));
  fake.state.execStart=`{ path=${missing} ; argv[]=${missing} daemon start ; ignore_errors=no }`;
  try { assert.equal((await startSbxDaemon({runCommand:fake.runCommand,...START})).code,0); }
  finally { writeFileSync(record,JSON.stringify({id:ownerId,executable:absoluteSbx})); }
});

test('concurrent starts serialize the service lifecycle', async () => {
  const fake=host();
  await Promise.all([startSbxDaemon({runCommand:fake.runCommand,...START}),startSbxDaemon({runCommand:fake.runCommand,...START})]);
  assert.equal(fake.lines().filter(line=>line.startsWith('systemd-run --user')).length,1);
});

test('passing the gate without spawning grants no drain receipt', async () => {
  resetSbxDaemonGate();
  const fake=host({unit:'active',daemon:'running',listing:[{name:'wf-unspawned',status:'running'}]});
  const backend=new DockerSbxBackend({runCommand:async args=> {
    await ensureSbxDaemon({runCommand:fake.runCommand,...START,commandArgs:args,inspectDaemons:async()=>[{pid:4242,environ:sbxChildEnv()}]});
    return result({code:1});
  }});
  backend.assertActive=async()=>{};backend._dispatchProtected=async(_h,signal,launch)=>{signal?.throwIfAborted();return launch();};
  const handle={ ...testSbxRuntimeFields(),sandbox_id:'wf-unspawned'};
  await backend._runJobCommand(handle,['exec',handle.sandbox_id,'--','true'],null,{agentRun:true});
  fake.state.unit='inactive';fake.state.loadState='not-found';
  await assert.rejects(backend._runJobCommand(handle,['exec',handle.sandbox_id,'--','true']),{status:'legacy_daemon_drain_only'});
});


test('replacement after the ownership check cannot receive our reset', async () => {
  const fake=host({unit:'failed'});
  let foreignReset=false;
  const foreignName=legacyUnitName(); // The reusable name can now denote another install.
  const runCommand=async(command,args,options)=>{
    if(command==='systemctl' && args.includes('reset-failed')) foreignReset=args.at(-1)===foreignName;
    return fake.runCommand(command,args,options);
  };
  await startSbxDaemon({runCommand,...START});
  assert.equal(foreignReset,false);
});

test('output collection carries the launched handle context into the drain gate', async () => {
  const fake=host({unit:'active',daemon:'running',listing:[{name:'wf-output',status:'running'}]});
  const handle={ ...testSbxRuntimeFields(),sandbox_id:'wf-output',scratch_dir:'/s'};
  const backend=new DockerSbxBackend({runCommand:async args=>{
    await ensureSbxDaemon({runCommand:fake.runCommand,...START,commandArgs:args});return result();
  },streamOutput:async function*(h){
    await ensureSbxDaemon({runCommand:fake.runCommand,...START,commandArgs:['exec',h.sandbox_id,'--','cat'],inspectDaemons:async()=>[{pid:4242,environ:sbxChildEnv()}]});
    yield Buffer.from('output');
  }});
  backend.assertActive=async()=>{};backend._dispatchProtected=async(_h,signal,launch)=>{signal?.throwIfAborted();return launch();};
  await launchManagedHandle(backend,handle);
  fake.state.unit='inactive';fake.state.loadState='not-found';
  const outputs=await backend.collectDeclaredOutputs(handle,['out.txt']);
  assert.equal(outputs[0].bytes_content.toString(),'output');
});


// Only the real spawn boundary can mint a drain receipt. All external commands
// here are local stand-ins, including the systemd probes.
async function launchManagedHandle(backend, handle) {
  const stub=await standIn();
  const record=join(configHome(),'sbx-daemon-owner-'+ownerKey+'.json');
  const previous=await readFile(record,'utf8');
  const savedPath=process.env.PATH, savedBin=process.env.FARAVAN_SBX_BIN;
  await writeFile(join(stub.dir,'daemon'),'setInterval(()=>{},1000);');
  const fakeDaemon=spawn(process.execPath,['daemon','start'],{argv0:'sbx',cwd:stub.dir,env:{...process.env,...sbxChildEnv()},stdio:'ignore'});
  await new Promise((resolve,reject)=>{fakeDaemon.once('spawn',resolve);fakeDaemon.once('error',reject);});
  const properties={LoadState:'loaded',ActiveState:'active',MainPID:String(fakeDaemon.pid),InvocationID:'test-invocation',
    Description:sbxDaemonDescription(),ExecStart:`{ path=${stub.bin} ; argv[]=${stub.bin} daemon start ; }`,
    Environment:systemdShowEnvironment([...Object.entries(credentialStoreEnv(sbxChildEnv().HOME,'linux')),['FARAVAN_SBXD_OWNER_ID',ownerId],['FARAVAN_SBXD_INSTALL_ROOT',fileURLToPath(new URL('../',import.meta.url)).replace(/\/$/,'')],['FARAVAN_SBXD_DATA_HOME',configHome()]])};
  await writeFile(join(stub.dir,'running'),'yes');
  await writeFile(record,JSON.stringify({id:ownerId,executable:stub.bin}));
  const shown=Object.entries(properties).map(([k,v])=>k+'='+v).join('\n');
  await writeFile(join(stub.dir,'properties'),shown);
  await writeFile(join(stub.dir,'systemctl'),`#!/bin/sh\ncase "$2" in is-system-running) echo running ;; show) cat "${stub.dir}/properties" ;; *) exit 99 ;; esac\n`,{mode:0o755});
  await writeFile(join(stub.dir,'systemd-run'),'#!/bin/sh\nexit 99\n',{mode:0o755});
  process.env.PATH=stub.dir+':'+savedPath;process.env.FARAVAN_SBX_BIN=stub.bin;
  Object.assign(handle,testSbxRuntimeFields());
  try { await backend._runJobCommand(handle,['exec',handle.sandbox_id,'--','true'],()=>{},{agentRun:true}); }
  finally { fakeDaemon.kill();await new Promise(resolve=>fakeDaemon.once('close',resolve));process.env.PATH=savedPath;if(savedBin===undefined)delete process.env.FARAVAN_SBX_BIN;else process.env.FARAVAN_SBX_BIN=savedBin;await writeFile(record,previous);await rm(stub.dir,{recursive:true,force:true});Object.assign(handle,testSbxRuntimeFields()); }
}


test('legacy drain cannot stop or remove a sandbox this install did not launch', async () => {
  const fake=host({daemon:'running',listing:[{name:'wf-foreign',status:'running'}]});
  const options={runCommand:fake.runCommand,...START,inspectDaemons:async()=>[{pid:4242,environ:sbxChildEnv()}]};
  await assert.rejects(ensureSbxDaemon({...options,commandArgs:['stop','wf-foreign']}),{status:'legacy_daemon_drain_only'});
  fake.state.listing[0].status='stopped';
  await assert.rejects(ensureSbxDaemon({...options,commandArgs:['rm','--force','wf-foreign']}),{status:'legacy_daemon_drain_only'});
});

for (const corrupt of [false,true]) test(`explicit repair recovers a ${corrupt?'corrupt':'deleted'} owner file from an install-bound unit`, async () => {
  const {repairSbxDaemonOwner}=await import('../lib/docker-backend.mjs');
  const record=join(configHome(),'sbx-daemon-owner-'+ownerKey+'.json');
  const previous=await readFile(record,'utf8');
  const fake=host({unit:'active',daemon:'running'});
  const root=fileURLToPath(new URL('../',import.meta.url)).replace(/\/$/,'');
  // The host fixture carries this installation's root and data home.
  const runCommand=async(command,args,options)=>args.includes('list-units')?result({stdout:unitName()+'.service loaded active running Faravan\n'}):fake.runCommand(command,args,options);
  if(corrupt)await writeFile(record,'{broken');else await rm(record);
  try {
    const repaired=await repairSbxDaemonOwner({runCommand,...START});
    assert.equal(repaired.ok,true);
    assert.equal(JSON.parse(await readFile(record,'utf8')).id,ownerId);
  } finally {await writeFile(record,previous);}
});

test('explicit repair refuses a foreign installation without writing an owner', async () => {
  const {repairSbxDaemonOwner}=await import('../lib/docker-backend.mjs');
  const record=join(configHome(),'sbx-daemon-owner-'+ownerKey+'.json');
  const previous=await readFile(record,'utf8');
  const fake=host({unit:'active',daemon:'running'});
  fake.state.environment=fake.state.environment.replace(/FARAVAN_SBXD_INSTALL_ROOT=[^ ]+/, 'FARAVAN_SBXD_INSTALL_ROOT=/another-install');
  const runCommand=async(command,args,options)=>args.includes('list-units')?result({stdout:unitName()+'.service loaded active running Faravan\n'}):fake.runCommand(command,args,options);
  await rm(record);
  try {assert.equal((await repairSbxDaemonOwner({runCommand,...START})).ok,false);await assert.rejects(readFile(record),{code:'ENOENT'});}
  finally {await writeFile(record,previous);}
});


test('the next verified start refreshes a moved executable while retaining the owner id', async () => {
  const fake=host();
  const record=join(configHome(),'sbx-daemon-owner-'+ownerKey+'.json');
  writeFileSync(record,JSON.stringify({id:ownerId,executable:join(fixtureBinDir,'old-version-sbx')}));
  try {
    assert.equal((await startSbxDaemon({runCommand:fake.runCommand,...START})).code,0);
    assert.deepEqual(JSON.parse(await readFile(record,'utf8')),{id:ownerId,executable:absoluteSbx});
  } finally {writeFileSync(record,JSON.stringify({id:ownerId,executable:absoluteSbx}));}
});

test('a missing next-launch executable has its own status', async () => {
  const previous=process.env.FARAVAN_SBX_BIN;
  const fake=host();
  process.env.FARAVAN_SBX_BIN='/nonexistent/sbx';
  try {
    const runCommand=(command,args,options)=>fake.runCommand(command==='/nonexistent/sbx'?SBX:command,args,options);
    assert.equal((await startSbxDaemon({runCommand,...START})).status,'pinned_executable_missing');
    assert.equal(fake.calls.some(call=>call.command==='systemd-run' && call.args[0]==='--user'),false);
  } finally {if(previous===undefined)delete process.env.FARAVAN_SBX_BIN;else process.env.FARAVAN_SBX_BIN=previous;}
});


test('automatic start never mints a new identity over a live daemon with a lost owner', async () => {
  const fake=host({unit:'active',daemon:'running'});
  const record=join(configHome(),'sbx-daemon-owner-'+ownerKey+'.json');
  const previous=await readFile(record,'utf8');await rm(record);
  try {
    assert.equal((await startSbxDaemon({runCommand:fake.runCommand,...START})).status,'daemon_owner_repair_required');
    await assert.rejects(readFile(record),{code:'ENOENT'});
    assert.equal(fake.calls.some(call=>call.command==='systemd-run' && call.args[0]==='--user'),false);
  } finally {await writeFile(record,previous);}
});


for (const reason of ['daemon_not_managed','legacy_daemon_drain_only']) {
  test(`${reason} gives the isolated-home path, never a stop command`, async () => {
    const saved=Object.fromEntries(['FARAVAN_SBX_HOME','FARAVAN_SBX_BIN'].map(key=>[key,process.env[key]]));
    const home=join(fixtureBinDir,'sandbox home');
    process.env.FARAVAN_SBX_HOME=home;
    process.env.FARAVAN_SBX_BIN=join(fixtureBinDir,'sbx');
    try {
      const fake=host({daemon:'running',listing:[{name:'wf-existing',status:'running'}]});
      const runCommand=(command,args,options)=>fake.runCommand(command===process.env.FARAVAN_SBX_BIN?SBX:command,args,options);
      const inspectDaemons=async()=>reason==='daemon_not_managed'?[]:[{pid:4242,environ:sbxChildEnv()}];
      const message="Sandbox daemon ownership could not be proven for sandbox HOME '"+home+"'. Another Faravan install or tool may use this daemon, so Faravan leaves it running. To give this install its own sandbox daemon, set FARAVAN_SBX_HOME to an empty folder only this install uses, then restart Faravan.";
      await assert.rejects(ensureSbxDaemon({runCommand,...START,inspectDaemons,commandArgs:['run','--name','wf-new']}),error=>{
        assert.equal(error.status,reason);
        assert.equal(error.message,message);
        assert.doesNotMatch(error.message,/repair-owner|manual resolution/);
        return true;
      });
      assert.equal(fake.calls.some(call=>call.args.join(' ')==='daemon stop'),false);
    } finally {for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
  });
}

test('restart guidance for an unproven daemon never stops it', async () => {
  const previous=process.env.FARAVAN_SBX_HOME;
  const home=join(fixtureBinDir,'sandbox home');
  process.env.FARAVAN_SBX_HOME=home;
  try {
    const fake=host({daemon:'running'});
    const restart=await restartSbxDaemon({runCommand:fake.runCommand,...START,daemons:[{pid:4242,environ:{...sbxChildEnv(),XDG_STATE_HOME:'/fixture/legacy state'}}],sandboxes:[],inspectSandboxes:async()=>[],update:true});
    assert.equal(restart.detail,"Sandbox daemon ownership could not be proven for sandbox HOME '"+home+"'. Another Faravan install or tool may use this daemon, so Faravan leaves it running. To give this install its own sandbox daemon, set FARAVAN_SBX_HOME to an empty folder only this install uses, then restart Faravan.");
    assert.equal(fake.calls.some(call=>call.args.join(' ')==='daemon stop'),false);
  } finally {if(previous===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=previous;}
});

const ownerRepairMessage = 'Sandbox ownership is missing or unreadable. Run faravan sandbox repair-owner --yes to verify and repair this installation.';
const manualRestartMessage = 'Faravan cannot verify sandbox daemon ownership without a systemd user manager. A manual restart is needed after running jobs finish.';
const legacyMessage = (env) => `Sandbox daemon ownership could not be proven for sandbox HOME '${env.HOME}'. Another Faravan install or tool may use this daemon, so Faravan leaves it running. To give this install its own sandbox daemon, set FARAVAN_SBX_HOME to an empty folder only this install uses, then restart Faravan.`;
const isolateFix = 'Set FARAVAN_SBX_HOME to an empty folder only this install uses, then restart Faravan.';

function refusalProbe(fake) {
  return (command, args, options) => {
    if (command === 'systemctl' || command === 'systemd-run' || args[0] === 'daemon' || args.join(' ') === 'ls --json') return fake.runCommand(command, args, options);
    if (args[0] === 'version') return result({stdout:'sbx version: v0.51.0'});
    if (args[0] === 'diagnose') return result({stdout:'Daemon healthy\nDocker authentication healthy\nVersion match — CLI v0.51.0 ≠ daemon v0.50.0'});
    if (args.join(' ') === 'run --help') return result({stdout:'--detach --name --kit --cpus --memory --skills --static-mcp --deny-network'});
    if (command === 'dpkg-query') return result({stdout:'docker-sbx\tinstalled\t0.51.0\ndocker-ce\tinstalled\t28.0.0\ncontainerd.io\tinstalled\t2.1.0'});
    if (command === 'docker') return result({stdout:'28.0.0'});
    if (command === 'containerd') return result({stdout:'containerd v2.1.0'});
    return result({stdout:args[0] === 'policy' ? 'deny-all' : ''});
  };
}

for (const scenario of [
  {name:'owner missing with our live unit', missingOwner:true, host:{unit:'active',daemon:'running'}, repair:'owner_repair', message:()=>ownerRepairMessage, fix:'faravan sandbox repair-owner --yes'},
  {name:'no daemon', daemons:[], host:{}, message:()=> 'Docker Sandboxes restarted.'},
  {name:'multiple daemons', daemons:[4242,4343], host:{unit:'active',daemon:'running'}, repair:'refused', message:()=> 'Sandbox daemon ownership could not be proven: found 2 daemons for this sandbox HOME (PIDs 4242, 4343).'},
  {name:'PID mismatch', daemons:[4343], host:{unit:'active',daemon:'running'}, repair:'refused', message:()=> 'Sandbox daemon ownership could not be proven: daemon PID 4343 does not match unit MainPID 4242.'},
  {name:'dead MainPID', host:{unit:'active',daemon:'running'}, alive:()=>false, repair:'refused', message:()=> 'Sandbox daemon ownership could not be proven: unit MainPID 4242 is not alive.'},
  {name:'unit not ours', host:{unit:'active',daemon:'running',ownedUnit:false}, repair:'refused', message:()=> 'Sandbox daemon ownership could not be proven: the sandbox unit does not belong to this Faravan installation.'},
  {name:'true legacy', host:{daemon:'running'}, repair:'legacy_isolate', message:()=>legacyMessage(sbxChildEnv()), fix:isolateFix},
  {name:'darwin manual restart', platformName:'darwin', host:{daemon:'running'}, repair:'manual_restart', message:()=>manualRestartMessage},
  {name:'linux without systemd manual restart', systemd:false, host:{daemon:'running'}, repair:'manual_restart', message:()=>manualRestartMessage},
]) test(`restart guidance by cause: ${scenario.name}`, async () => {
  const fake = host(scenario.host);
  const ownerFile = join(configHome(), 'sbx-daemon-owner-' + ownerKey + '.json');
  if (scenario.missingOwner) rmSync(ownerFile);
  try {
    const daemons = (scenario.daemons ?? [4242]).map(pid=>({pid,environ:sbxChildEnv()}));
    const options = {...START, runCommand:refusalProbe(fake), daemons, inspectDaemons:async()=>scenario.name==='no daemon'&&fake.state.daemon==='running'?[{pid:4242,environ:sbxChildEnv()}]:daemons,
      sandboxes:[], inspectSandboxes:async()=>[], update:true, confirmedRestart:true,
      ...(scenario.alive ? {isProcessAlive:scenario.alive} : {}),
      ...(scenario.platformName ? {platformName:scenario.platformName} : {}),
      ...(scenario.systemd === false ? {systemd:false} : {})};
    const restarted = await restartSbxDaemon(options);
    assert.equal(restarted.detail, scenario.message());
    assert.equal(Object.hasOwn(restarted,'stopCommand'), false, 'no stop command without ownership proof');
    assert.equal(restarted.repair, scenario.repair);
    if (scenario.repair) {
      const report = await new DockerSbxBackend().recoverHealth(options);
      const check = report.preflight.checks.find(c=>c.name==='sbx_daemon');
      assert.equal(check.detail, scenario.message());
      assert.equal(check.repair, scenario.repair);
      assert.equal(check.fix, scenario.fix ?? '');
    }
    assert.equal(fake.calls.some(c=>c.args.join(' ')==='daemon stop' || c.command==='systemctl' && c.args[1]==='stop'),false);
  } finally {
    if (scenario.missingOwner) writeFileSync(ownerFile,JSON.stringify({id:ownerId,executable:absoluteSbx}));
  }
});

test('doctor not-running has no manual guidance', () => {
  const check = _internal.preflightChecks({platformName:'linux',diagnose:result({code:1,stderr:'daemon connection refused'})}).find(c=>c.name==='sbx_daemon');
  assert.equal(check.detail,'The sandbox service is not running yet.');
  assert.equal(check.fix,'');
  assert.equal(Object.hasOwn(check,'stopCommand'),false);
  assert.equal(check.repair,undefined);
  assert.equal(check.automatic,true);
});

test('doctor legacy shows the isolated-home guidance and no stop command', async () => {
  const fake = host({daemon:'running'});
  const report = await new DockerSbxBackend().recoverHealth({...START,runCommand:refusalProbe(fake),confirmedRestart:true,inspectDaemons:async()=>[{pid:4242,environ:sbxChildEnv()}],inspectSandboxes:async()=>[]});
  const check = report.preflight.checks.find(c=>c.name==='sbx_daemon');
  assert.equal(check.detail,legacyMessage(sbxChildEnv()));
  assert.equal(check.fix,isolateFix);
  assert.equal(Object.hasOwn(check,'stopCommand'),false);
  assert.equal(check.repair,'legacy_isolate');
  assert.equal(check.automatic,false);
});

for (const [label,pids] of [['reused PID',[4343]],['two daemons',[4242,4343]],['EPERM liveness without process proof',[]]]) {
  test(`managed gate and readiness refuse ${label}`, async () => {
    const fake=host({unit:'active',daemon:'running'});
    const options={...START,runCommand:fake.runCommand,isProcessAlive:()=>true,inspectDaemons:async()=>pids.map(pid=>({pid,environ:sbxChildEnv()}))};
    await assert.rejects(ensureSbxDaemon({...options,commandArgs:['run','--name','wf-new']}),{status:'systemd_unit_mainpid_mismatch'});
    assert.equal((await startSbxDaemon(options)).status,'systemd_unit_mainpid_mismatch');
  });
}

for (const contents of ['', '{corrupt']) for (const live of [false,true]) {
  test(`unreadable owner ${JSON.stringify(contents)} with ${live?'live':'no'} unit`, async () => {
    const record=join(configHome(),'sbx-daemon-owner-'+ownerKey+'.json');
    writeFileSync(record,contents);
    const fake=host({unit:live?'active':'inactive',daemon:'stopped'});
    const runCommand=(command,args,options)=>{
      if(command==='systemctl' && args.includes('list-units'))return Promise.resolve(result({stdout:live?unitName()+'.service loaded active running Faravan\n':''}));
      return fake.runCommand(command,args,options);
    };
    try {
      const started=await startSbxDaemon({runCommand,...START,readyTimeoutMs:20});
      if(live){assert.equal(started.status,'daemon_owner_repair_required');assert.match(started.stderr,/repair-owner/);assert.equal(await readFile(record,'utf8'),contents);}
      else {assert.equal(started.code,0,started.stderr);const files=(await import('node:fs/promises')).readdir;const backups=(await files(configHome())).filter(name=>name.startsWith('sbx-daemon-owner-'+ownerKey+'.json.bad-'));assert.equal(backups.length,1);assert.equal(await readFile(join(configHome(),backups[0]),'utf8'),contents);await rm(join(configHome(),backups[0]));}
    } finally {writeFileSync(record,JSON.stringify({id:ownerId,executable:absoluteSbx}));}
  });
}

for (const stopped of [false,true]) test(`restart final inventory sees ${stopped?'stopped sandbox':'new sandbox'}`, async () => {
  const fake=host({unit:'active',daemon:'running'});let listings=0;
  const runCommand=(command,args,options)=>{
    if(args.join(' ')==='ls --json' && ++listings===2)return Promise.resolve(result({stdout:JSON.stringify([{name:'wf-arrived',status:stopped?'stopped':'running'}])}));
    return fake.runCommand(command,args,options);
  };
  const outcome=await restartSbxDaemon({...START,runCommand,daemons:[{pid:4242,environ:sbxChildEnv()}],sandboxes:[],inspectSandboxes:async()=>[],update:true});
  assert.equal(outcome.ok,false);
  assert.match(outcome.detail,/waiting for running jobs/);
  assert.equal(fake.calls.some(c=>c.command==='systemctl' && c.args[1]==='stop'),false);
});

for (const valid of [true,false]) test(`repair refuses another data profile with ${valid?'valid':'missing'} record`, async()=>{
  const {repairSbxDaemonOwner}=await import('../lib/docker-backend.mjs');
  const {sbxOwnerFile}=await import('../lib/sbx-daemon-owner.mjs');
  const previousHome=process.env.FARAVAN_HOME, previousSbx=process.env.FARAVAN_SBX_HOME;
  const a=join(fixtureBinDir,'profile-a'),b=join(fixtureBinDir,'profile-b');
  process.env.FARAVAN_SBX_HOME=join(fixtureBinDir,'shared');
  process.env.FARAVAN_HOME=a;
  const fake=host({unit:'active',daemon:'running'});
  // The fixture captures profile A's data home before switching to B.
  const runCommand=async(c,args,o)=>args.includes('list-units')?result({stdout:unitName()+'.service loaded active running Faravan\n'}):fake.runCommand(c,args,o);
  process.env.FARAVAN_HOME=b;mkdirSync(b,{recursive:true});
  if(valid)writeFileSync(sbxOwnerFile(),JSON.stringify({id:ownerId,executable:absoluteSbx}));else rmSync(sbxOwnerFile(),{force:true});
  try {
    const before=valid?await readFile(sbxOwnerFile(),'utf8'):null;
    const repaired=await repairSbxDaemonOwner({runCommand,...START});
    assert.equal(repaired.ok,false);
    if(valid){assert.match(repaired.detail,/ownership is already recorded/i);assert.equal(await readFile(sbxOwnerFile(),'utf8'),before);}
    else await assert.rejects(readFile(sbxOwnerFile()),{code:'ENOENT'});
    // A copied record still cannot grant profile B authority over A's live unit.
    writeFileSync(sbxOwnerFile(),JSON.stringify({id:ownerId,executable:absoluteSbx}));
    await assert.rejects(ensureSbxDaemon({runCommand,...START,commandArgs:['run','--name','wf-new']}),{status:'systemd_unit_conflict'});
    const restarted=await restartSbxDaemon({runCommand,...START,daemons:[{pid:4242,environ:sbxChildEnv()}],sandboxes:[],inspectSandboxes:async()=>[],update:true});
    assert.equal(restarted.ok,false);assert.equal(restarted.stopCommand,undefined);
    assert.equal(fake.calls.some(c=>c.command==='systemctl'&&c.args[1]==='stop'),false);
  } finally {
    if(previousHome===undefined)delete process.env.FARAVAN_HOME;else process.env.FARAVAN_HOME=previousHome;
    if(previousSbx===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=previousSbx;
  }
});

test('repair leaves a valid record unchanged even for its own unit',async()=>{
  const {repairSbxDaemonOwner}=await import('../lib/docker-backend.mjs');
  const fake=host({unit:'active',daemon:'running'});
  // The host fixture already carries this installation's root.
  const runCommand=async(c,args,o)=>args.includes('list-units')?result({stdout:unitName()+'.service loaded active running Faravan\n'}):fake.runCommand(c,args,o);
  const repaired=await repairSbxDaemonOwner({runCommand,...START});
  assert.equal(repaired.ok,false);assert.match(repaired.detail,/ownership is already recorded/i);
});

for(const marker of ['duplicate HOME','missing data home'])test(`managed unit refuses ${marker}`,async()=>{
  const fake=host({unit:'active',daemon:'running'});
  if(marker==='duplicate HOME')fake.state.environment+=' HOME=/foreign';
  else fake.state.environment=fake.state.environment.replace(/ (?:"FARAVAN_SBXD_DATA_HOME=[^"]*"|FARAVAN_SBXD_DATA_HOME=\S+)/,'');
  await assert.rejects(ensureSbxDaemon({runCommand:fake.runCommand,...START}),{status:'systemd_unit_conflict'});
});

test('spawned handle drains output and cleanup with exec workdir and environment flags',async()=>{
  const fake=host({unit:'active',daemon:'running',listing:[{name:'wf-flags',status:'running'}]});
  const handle={ ...testSbxRuntimeFields(),sandbox_id:'wf-flags',scratch_dir:'/workspace',_mountless:true,_workspaceReady:true,_credentialEnv:['CODEX_HOME=/guest/codex']};
  const backend=new DockerSbxBackend({runCommand:async args=>{await ensureSbxDaemon({runCommand:fake.runCommand,...START,commandArgs:args});return result({stdout:'diff and tar output'});}});
  backend.assertActive=async()=>{};backend._dispatchProtected=async(_h,signal,launch)=>{signal?.throwIfAborted();return launch();};
  await launchManagedHandle(backend,handle);
  fake.state.unit='inactive';fake.state.loadState='not-found';
  assert.equal((await backend._runJobCommand(handle,['exec',handle.sandbox_id,'--','sh','-c','git diff; tar cf - .'])).stdout,'diff and tar output');
});

for(const gitDiff of [false,true])test(`executor drains ${gitDiff?'diff':'tar'} output with workdir and credential flags`,async()=>{
  const {runJob,buildValidatedJobSpec,resolveHarness}=await import('../lib/executor.mjs');
  const fake=host({unit:'active',daemon:'running',listing:[{name:'wf-executor-output',status:'running'}]});
  const handle={ ...testSbxRuntimeFields(),sandbox_id:'wf-executor-output',scratch_dir:'/workspace',_entrypoint:'agent-run',_mountless:true,_workspaceReady:true,_credentialEnv:['CODEX_HOME=/guest']};
  const commands=[];
  const backend=new DockerSbxBackend({runCommand:async args=>{
    await ensureSbxDaemon({runCommand:fake.runCommand,...START,commandArgs:args});commands.push(args);
    return result({stdout:args.at(-1)?.includes('rev-parse')?`FARAVAN_BASE ${'a'.repeat(40)} ${'b'.repeat(40)}`:'agent output'});
  },streamOutput:async function*(current){
    await ensureSbxDaemon({runCommand:fake.runCommand,...START,commandArgs:['exec','-w','/workspace','-e','CODEX_HOME=/guest',current.sandbox_id,'--','cat']});
    yield Buffer.from('collected output');
  }});
  backend.assertActive=async()=>{};backend._dispatchProtected=async(_h,signal,launch)=>{signal?.throwIfAborted();return launch();};
  await launchManagedHandle(backend,handle);
  backend.admitJob=async()=>({ok:true});backend.probeCapabilities=async()=>({available:true});backend.prepare=async()=>handle;
  const run=backend.runSbx;
  backend.runSbx=async(args,options)=>{
    const out=await run(args,options);
    if(args[0]==='exec'&&args.at(-1)==='agent-run'){fake.state.unit='inactive';fake.state.loadState='not-found';}
    return out;
  };
  backend._diskSentry=()=>({low:null});
  backend.destroy=async current=>{
    // This hand-made handle has no create receipt, so the test runs stop itself.
    await backend._runJobCommand(current,['stop',current.sandbox_id]);fake.state.listing[0].status='stopped';
    await backend._runJobCommand(current,['rm','--force',current.sandbox_id]);return {removed:true};
  };
  const jobSpec=buildValidatedJobSpec({taskDigest:'d'.repeat(64),harness:resolveHarness('codex'),entrypointWithPrompt:'agent-run'});
  const outcome=await runJob({backend,jobSpec,gitDiff});
  assert.equal(outcome.collected[0].bytes_content.toString(),'collected output');
  assert.equal(outcome.candidate.format,gitDiff?'diff':'tree');
  assert.ok(commands.some(args=>args[0]==='exec'&&args.includes('-w')&&args.includes('-e')&&args.at(-1).includes(gitDiff?'faravan-git-diff':'tar czf')));
  assert.ok(commands.some(args=>args[0]==='stop'));
  assert.ok(commands.some(args=>args[0]==='rm'));
});

test('unit conflict never offers repair-owner over a valid record',async()=>{
  const fake=host({unit:'active',daemon:'running',ownedUnit:false});
  await assert.rejects(ensureSbxDaemon({runCommand:fake.runCommand,...START}),error=>{assert.doesNotMatch(error.message,/repair-owner/);return true;});
});

test('a failed owner scope lookup does not prevent live-unit owner repair',async()=>{
  const {sandboxOwnerScope}=await import('../lib/sandbox-name.mjs');
  const {repairSbxDaemonOwner,sbxDaemonUnitName}=await import('../lib/docker-backend.mjs');
  const {sbxOwnerFile}=await import('../lib/sbx-daemon-owner.mjs');
  const record=sbxOwnerFile(),before=await readFile(record,'utf8'),unit=sbxDaemonUnitName();
  const fake=host({unit:'active',daemon:'running'});
  await rm(record);
  try {
    assert.throws(()=>sandboxOwnerScope(),/owner|ownership/i);
    const runCommand=async(c,args,o)=>args.includes('list-units')?result({stdout:unit+'.service loaded active running Faravan'}):fake.runCommand(c,args,o);
    assert.equal((await repairSbxDaemonOwner({runCommand,...START})).ok,true);
  } finally {await writeFile(record,before);}
});

for(const platformName of ['darwin','linux'])test(`daemon startup initializes owner scope without a manager on ${platformName}`,async()=>{
  const {sbxOwnerFile,readSbxOwner}=await import('../lib/sbx-daemon-owner.mjs');
  const record=sbxOwnerFile(),before=await readFile(record,'utf8');await rm(record);
  const fake=host();
  try {
    const started=await startSbxDaemon({runCommand:fake.runCommand,...START,platformName,systemd:false});
    assert.equal(started.code,0);assert.ok(readSbxOwner()?.id,'only daemon startup initializes the scope');
  } finally {await writeFile(record,before);}
});

// A receipted create of this job, so recovery must read the sandbox listing.
async function receiptedRow(jobId,ownerScope) {
  const directory=await mkdtemp(join(tmpdir(),'wf-recovery-journal-')),id=randomUUID(),name='wf-'+randomBytes(8).toString('hex');
  const scratch=join(process.env.FARAVAN_SCRATCH_ROOT||tmpdir(),'wf-job-'+name+'-'+randomUUID());
  await writeFile(join(directory,id+'.json'),JSON.stringify({ ...testSbxRuntimeFields(undefined,process.execPath),version:2,_cleanupId:id,owner_scope:ownerScope,sbx_home:sbxChildEnv().HOME,job_id:jobId,sandbox_id:name,scratch_dir:scratch,
    create:'dispatched',compute_created:true,create_settled:true,compute_stopped:false,data_cleanup:'owned',policy_cleanup:'owned'}));
  return directory;
}

test('durable recovery refuses a stopped daemon without starting it',async()=>{
  const {sandboxOwnerScope}=await import('../lib/sandbox-name.mjs');
  const fake=host({daemon:'stopped'});
  const backend=new DockerSbxBackend({cleanupDirectory:await receiptedRow('recovery-stopped',sandboxOwnerScope()),runCommand:async(args,options)=>{
    await ensureSbxDaemon({...START,runCommand:fake.runCommand,env:options?.env,commandArgs:args});
    return result({stdout:'[]'});
  }});
  const proof=await backend.reconcilePending({ ...testSbxRuntimeFields(),owner_scope:sandboxOwnerScope(),sbx_home:sbxChildEnv().HOME,jobId:'recovery-stopped',attemptId:'attempt',attempt:{attempt_id:'attempt'}}).catch(()=>({removed:false}));
  assert.equal(proof.removed,false);
  assert.equal(fake.calls.some(call=>call.command==='systemd-run'&&call.args.includes('--unit')||call.args.join(' ')==='daemon start --detach'),false);
});

test('durable recovery still requires a live daemon when the normal gate is disabled',async()=>{
  const {sandboxOwnerScope}=await import('../lib/sandbox-name.mjs');
  const saved=process.env.FARAVAN_SBX_DAEMON_GATE;process.env.FARAVAN_SBX_DAEMON_GATE='off';
  const fake=host({daemon:'stopped'});
  try {
    const backend=new DockerSbxBackend({cleanupDirectory:await receiptedRow('recovery-off',sandboxOwnerScope()),runCommand:async(args,options)=>{
      await ensureSbxDaemon({...START,runCommand:fake.runCommand,env:options?.env,commandArgs:args});return result({stdout:'[]'});
    }});
    const proof=await backend.reconcilePending({ ...testSbxRuntimeFields(),owner_scope:sandboxOwnerScope(),sbx_home:sbxChildEnv().HOME,jobId:'recovery-off',attemptId:'attempt',attempt:{attempt_id:'attempt'}}).catch(()=>({removed:false}));
    assert.equal(proof.removed,false);
    assert.equal(fake.calls.some(call=>call.args.join(' ')==='daemon start --detach'||call.command==='systemd-run'&&call.args.includes('--unit')),false);
  } finally {if(saved===undefined)delete process.env.FARAVAN_SBX_DAEMON_GATE;else process.env.FARAVAN_SBX_DAEMON_GATE=saved;}
});

test('durable recovery never initializes a missing owner or starts a daemon',async()=>{
  const {sandboxOwnerScope}=await import('../lib/sandbox-name.mjs');
  const {sbxOwnerFile,readSbxOwner}=await import('../lib/sbx-daemon-owner.mjs');
  const scope=sandboxOwnerScope(),cleanupDirectory=await receiptedRow('recovery-owner',scope);
  const record=sbxOwnerFile(),before=await readFile(record,'utf8');await rm(record);
  // The daemon reads running first and stopped after any owner initialization.
  const fake=host({daemon:'running'});let statusReads=0;
  const runCommand=async(command,args,options)=>args.join(' ')==='daemon status'&&++statusReads>1?result({stdout:'stopped'}):fake.runCommand(command,args,options);
  try {
    const backend=new DockerSbxBackend({cleanupDirectory,runCommand:async(args,options)=>{
      await ensureSbxDaemon({...START,runCommand,platformName:'darwin',systemd:false,env:options?.env,commandArgs:args});
      return result({stdout:'[]'});
    }});
    // Every recovery sbx call goes through the recorded row's runner.
    const row=JSON.parse(await readFile(join(cleanupDirectory,(await readdir(cleanupDirectory)).find(file=>file.endsWith('.json'))),'utf8'));
    const served=await Promise.resolve().then(()=>backend._rowRun(row,['ls','--json'])).then(()=>true,()=>false);
    assert.equal(served,false,'recovery refuses instead of starting');
    assert.equal(readSbxOwner(),null,'recovery does not initialize the owner record');
    assert.equal(fake.calls.some(call=>call.args.join(' ')==='daemon start --detach'),false);
  } finally {await writeFile(record,before);}
});

test('restart never stops a sandbox service replaced after its ownership check', async () => {
  const fake=host({unit:'active',daemon:'running'});let shows=0;
  const runCommand=(command,args,options)=>{
    if(command==='systemctl'&&args[1]==='show'&&args.includes('InvocationID')&&++shows===2)fake.state.invocationId='replacement-invocation';
    return fake.runCommand(command,args,options);
  };
  const outcome=await restartSbxDaemon({...START,runCommand,daemons:[{pid:4242,environ:sbxChildEnv()}],sandboxes:[],inspectSandboxes:async()=>[],waitForExit:async()=>true,update:true});
  assert.equal(outcome.ok,false);
  assert.equal(fake.calls.some(c=>c.command==='systemctl'&&c.args[1]==='stop'),false);
});

test('restart refuses while an uninstall holds the lock', async () => {
  const {acquireUninstallLock}=await import('../lib/v1/uninstall-lock.mjs');
  const profileHome=await mkdtemp(join(tmpdir(),'wf-uninstall-held-'));
  const release=acquireUninstallLock(profileHome);
  try {
    const fake=host({unit:'active',daemon:'running'});
    const outcome=await restartSbxDaemon({...START,runCommand:fake.runCommand,profileHome,daemons:[{pid:4242,environ:sbxChildEnv()}],sandboxes:[],inspectSandboxes:async()=>[],waitForExit:async()=>true,update:true});
    assert.equal(outcome.ok,false);
    assert.match(outcome.detail,/uninstall/i);
    assert.equal(fake.calls.some(c=>c.command==='systemctl'&&c.args[1]==='stop'),false);
  } finally {release();await rm(profileHome,{recursive:true,force:true});}
});

test('a refused start on a degraded manager tells the person what to do instead of promising Faravan will fix it', async () => {
  const cases = [
    [{ failedListFails: true }, /could not read which services failed/],
    [{ unit: 'failed' }, /service Faravan started earlier has failed/],
  ];
  for (const [options, wording] of cases) {
    const fake = host({ manager: 'degraded', ...options });
    const hostCommands = (command, args) => command === 'systemctl' || command === 'systemd-run' || (command === SBX && args[0] === 'daemon' && args[1] === 'status');
    const refused = result({ code: 1, stderr: 'daemon connection refused' });
    const preflightReads = (command, args) => {
      if (command === 'dpkg-query') return result({ stdout: 'docker-sbx\tinstalled\t0.51.0\ndocker-ce\tinstalled\t28.0.0\ncontainerd.io\tinstalled\t2.1.0\n' });
      if (command === 'docker') return result({ stdout: '28.0.0' });
      if (command === 'containerd') return result({ stdout: 'containerd github.com/containerd/containerd v2.1.0' });
      if (command === 'test') return result();
      if (args[0] === 'version') return result({ stdout: 'sbx version: v0.51.0 abc123' });
      if (args.join(' ') === 'run --help') return result({ stdout: 'Usage: sbx run [flags] AGENT PATH\nFlags:\n  -d, --detach  Start the sandbox\n      --detach-keys string\n      --name string\n      --kit stringArray\n      --cpus\n      --memory\n      --skills\n      --static-mcp\n      --deny-network' });
      return refused;
    };
    const runCommand = (command, args, runOptions) => hostCommands(command, args)
      ? fake.runCommand(command, args, runOptions)
      : Promise.resolve(preflightReads(command, args));
    const report = await new DockerSbxBackend().recoverHealth({ runCommand, ...START });
    const daemon = report.preflight.checks.find((check) => check.name === 'sbx_daemon');
    assert.equal(report.recovered, false);
    assert.equal(daemon.ok, false);
    assert.equal(daemon.automatic, false, 'a failure that clears only when the person acts is not marked automatic');
    assert.match(daemon.detail, wording);
    assert.equal(daemon.fix, 'Check again');
    assert.doesNotMatch(daemon.detail, /by itself|automatically/i);
    assert.equal(fake.lines().some((line) => line.startsWith('systemd-run --user') || line.includes('reset-failed')), false);
  }
});

// One verified daemon per preparation. The first command verifies the managed unit in full; later commands of the same
// preparation skip the subprocess reads only while the verified process is still the same one (PID, /proc start time and
// command line), and the proof is bound to the binary, HOME, runtime and lifecycle generation. It is never time-based.
const daemonReads = fake => fake.calls.filter(call => (call.command === SBX && call.args.join(' ') === 'daemon status') ||
  (call.command === 'systemctl' && call.args[1] === 'show')).length;
const inPreparation = (action, scope = { proof: null }) => _internal.withDaemonProofScope(scope, () => _internal.withDaemonJob({ handle: { sandbox_id: 'wf-proof' }, agentRun: false }, action));

test('later commands of one preparation skip the daemon reads while the same process runs', async () => {
  resetSbxDaemonGate();
  const fake = host({ daemon: 'running', unit: 'active' });
  const identity = () => '1234\0sbx\0daemon\0start';
  const options = { runCommand: fake.runCommand, ...START, processIdentity: identity, endpointIdentity: () => '64769:5:1' };
  await inPreparation(async () => {
    await ensureSbxDaemon(options);
    const oneFullCheck = daemonReads(fake);
    assert.ok(oneFullCheck >= 2, 'the first command verifies the unit and the daemon');
    for (let i = 0; i < 5; i++) await ensureSbxDaemon(options);
    assert.equal(daemonReads(fake), oneFullCheck, 'five more commands add no daemon or unit read');
  });
  resetSbxDaemonGate();
  const unscoped = host({ daemon: 'running', unit: 'active' });
  for (let i = 0; i < 6; i++) await _internal.withDaemonJob({ handle: { sandbox_id: 'wf-proof' }, agentRun: false }, () => ensureSbxDaemon({ runCommand: unscoped.runCommand, ...START, processIdentity: identity, endpointIdentity: () => '64769:5:1' }));
  assert.ok(daemonReads(unscoped) >= 6 * 2, 'without a preparation scope every command still verifies in full');
});

test('a changed or vanished daemon process drops the proof and the next command verifies in full', async () => {
  resetSbxDaemonGate();
  const fake = host({ daemon: 'running', unit: 'active' });
  let identity = '1234\0sbx';
  const options = { runCommand: fake.runCommand, ...START, processIdentity: () => identity, endpointIdentity: () => '64769:5:1' };
  await inPreparation(async () => {
    await ensureSbxDaemon(options);
    const verified = daemonReads(fake);
    await ensureSbxDaemon(options);
    assert.equal(daemonReads(fake), verified);
    identity = '9999\0sbx'; // the daemon restarted: same PID would be a new start time
    await ensureSbxDaemon(options);
    assert.ok(daemonReads(fake) > verified, 'a replaced process is verified again');
    const second = daemonReads(fake);
    identity = null; // the daemon exited
    fake.state.unit = 'inactive';
    fake.state.daemon = 'running';
    await assert.rejects(ensureSbxDaemon({ ...options, inspectDaemons: async () => [], isProcessAlive: () => true }), { status: 'daemon_not_managed' });
    assert.ok(daemonReads(fake) > second, 'an exited daemon is never hidden by the earlier proof');
  });
});

test('a daemon lifecycle change invalidates the proof and recovery never reuses it', async () => {
  resetSbxDaemonGate();
  const fake = host({ daemon: 'running', unit: 'active' });
  const options = { runCommand: fake.runCommand, ...START, processIdentity: () => '1234\0sbx', endpointIdentity: () => '64769:5:1' };
  const scope = { proof: null };
  await inPreparation(() => ensureSbxDaemon(options), scope);
  assert.ok(scope.proof, 'one full verification recorded a proof');
  const verified = daemonReads(fake);
  resetSbxDaemonGate(); // a start, stop or restart of the daemon bumps the lifecycle generation
  await inPreparation(() => ensureSbxDaemon(options), scope);
  assert.ok(daemonReads(fake) > verified, 'the generation change forced a full check');
  const again = daemonReads(fake);
  await _internal.withDaemonProofScope(scope, () => _internal.withDaemonJob({ handle: { sandbox_id: 'wf-proof' }, agentRun: false, recovery: true }, () => ensureSbxDaemon(options)));
  assert.ok(daemonReads(fake) > again, 'a recovery command verifies in full even with a standing proof');
});

test('an unproven or unmanaged daemon records no proof', async () => {
  resetSbxDaemonGate();
  const fake = host({ daemon: 'running', unit: 'active' });
  const scope = { proof: null };
  await inPreparation(() => ensureSbxDaemon({ runCommand: fake.runCommand, ...START, processIdentity: () => null, endpointIdentity: () => '64769:5:1' }), scope);
  assert.equal(scope.proof, null, 'a process that cannot be identified is checked on every command');
  resetSbxDaemonGate();
  const legacy = host({ daemon: 'running' });
  await inPreparation(() => assert.rejects(ensureSbxDaemon({ runCommand: legacy.runCommand, ...START, inspectDaemons: async () => [], isProcessAlive: () => true, processIdentity: () => '1\0x', endpointIdentity: () => '64769:5:1' }), { status: 'daemon_not_managed' }), scope);
  assert.equal(scope.proof, null);
});

// The recorded PID can survive while the endpoint a command reaches changes (measured on this host: a live sbx daemon whose
// socket file was removed). The proof also binds the daemon's socket file, one stat, so that case verifies in full.
test('a surviving daemon whose socket was replaced or removed drops the proof', async () => {
  resetSbxDaemonGate();
  const fake = host({ daemon: 'running', unit: 'active' });
  let endpoint = '64769:5:100';
  const options = { runCommand: fake.runCommand, ...START, processIdentity: () => '1234\0sbx', endpointIdentity: () => endpoint };
  await inPreparation(async () => {
    await ensureSbxDaemon(options);
    const verified = daemonReads(fake);
    await ensureSbxDaemon(options);
    assert.equal(daemonReads(fake), verified, 'the same process and endpoint reuse the proof');
    endpoint = '64769:9:200'; // same PID, but the socket path now holds a different socket
    await ensureSbxDaemon(options);
    const replaced = daemonReads(fake);
    assert.ok(replaced > verified, 'a replaced endpoint is verified in full');
    endpoint = null; // same PID, socket file gone
    await ensureSbxDaemon(options);
    assert.ok(daemonReads(fake) > replaced, 'a removed endpoint is verified in full');
  });
  resetSbxDaemonGate();
  const none = host({ daemon: 'running', unit: 'active' });
  const scope = { proof: null };
  await inPreparation(() => ensureSbxDaemon({ runCommand: none.runCommand, ...START, processIdentity: () => '1234\0sbx', endpointIdentity: () => null }), scope);
  assert.equal(scope.proof, null, 'no endpoint to bind, no proof');
});

test('the endpoint identity follows the real socket file: replaced, removed or not a socket', async () => {
  const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { createServer } = await import('node:net');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const home = mkdtempSync(path.join(tmpdir(), 'ep-'));
  const state = path.join(home, 'state', 'sandboxes', 'sandboxes', 'sandboxd');
  const socket = path.join(state, 'sandboxd.sock');
  mkdirSync(state, { recursive: true });
  const env = { HOME: home, XDG_STATE_HOME: path.join(home, 'state') };
  const listen = () => new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(socket, () => resolve(server)); });
  const close = server => new Promise(resolve => server.close(resolve));
  try {
    assert.equal(_internal.readEndpointIdentity(env), null, 'no socket file');
    const first = await listen();
    const a = _internal.readEndpointIdentity(env);
    assert.match(a, /^\d+:\d+:\d+$/);
    assert.equal(_internal.readEndpointIdentity(env), a, 'stable while the same socket stays bound');
    assert.equal(_internal.readEndpointIdentity({ HOME: home }), null, 'a different XDG state directory is a different endpoint');
    rmSync(socket); // the daemon process (this one) survives; only its path is gone
    assert.equal(_internal.readEndpointIdentity(env), null, 'a removed socket file is not an endpoint');
    const second = await listen();
    const b = _internal.readEndpointIdentity(env);
    assert.notEqual(b, a, 'a different socket bound at the same path is a different endpoint');
    await close(second); await close(first);
    rmSync(socket, { force: true });
    writeFileSync(socket, 'not a socket');
    assert.equal(_internal.readEndpointIdentity(env), null, 'a regular file is never an endpoint');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
