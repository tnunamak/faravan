import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, rename as fsRename, chmod } from 'node:fs/promises';
import { readFileSync, writeFileSync, appendFileSync, unlinkSync, renameSync as fsRenameSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUpdater, updaterForInstall, coordinatorSnapshot, unmanagedCoordinators, UNMANAGED_COORDINATOR_WARNING, runUpdateCommand } from '../lib/v1/self-update.mjs';
import { captureCoordinatorOwner } from '../lib/v1/coordinator-owner.mjs';

// Nothing here runs a real update, process or network. Host steps are fakes that log their order.
const exists = path => access(path).then(() => true, () => false);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const OWNER = {version: 1, platform: 'linux', host: 'test-host', pid: 424242, config: '/fake/host.json', namespace: 'pid:[test]', boot: 'test-boot', start: '42'};
const OWNER_RECORD = {pid: 424242, owner: OWNER};

// The old install at lib/faravan and its staged successor at lib/faravan.next, as the updater finds them on disk.
async function install(t) {
  const root = await mkdtemp(join(tmpdir(), 'spk-restart-host-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const installDir = join(root, 'lib', 'faravan');
  await mkdir(join(installDir, 'bin'), {recursive: true});
  await writeFile(join(installDir, 'VERSION'), '0.1.0\n');
  await writeFile(join(installDir, '.installed-via'), 'tarball\n');
  await writeFile(join(installDir, 'bin/faravan'), 'old\n');
  await mkdir(join(installDir + '.next', 'bin'), {recursive: true});
  await writeFile(join(installDir + '.next', 'VERSION'), '0.2.0\n');
  await writeFile(join(installDir + '.next', 'bin/faravan'), 'new\n');
  return {root, installDir, stateFile: join(root, 'home', 'v1', 'update.json')};
}
const version = dir => readFile(join(dir, 'VERSION'), 'utf8').then(text => text.trim());
const savedState = s => readFile(s.stateFile, 'utf8').then(JSON.parse, () => ({}));

// The smoke test and the swap, each logged in order. A failing smoke test models a new version that cannot start.
function swapSeams(events, {smokeFails = false} = {}) {
  return {
    smoke: async dir => {
      events.push('smoke ' + (dir.endsWith('.next') ? 'staged' : 'installed'));
      if (smokeFails) throw new Error('boom');
    },
    rename: (from, to) => {
      if (from.endsWith('.prev')) events.push('restore');
      return fsRename(from, to);
    },
    renameSync:(from,to)=>{if(from.endsWith('.next'))events.push('swap');return fsRenameSync(from,to);},
  };
}

// The circle host. record() answers from `records` (the last answer repeats). Each step logs the version it saw.
function hostFake(events, installDir, {records = [OWNER_RECORD], stop, start} = {}) {
  const queue = [...records];
  const seen = () => version(installDir);
  return {
    record: async () => { events.push('record'); return queue.length > 1 ? queue.shift() : queue[0]; },
    stop: async record => { events.push('stop ' + await seen()); if (stop) await stop(record); },
    start: async () => { events.push('start ' + await seen()); if (start) return start(); },
  };
}

test('a hosted coordinator is stopped before the swap and started from the new install after it', async t => {
  const s = await install(t);
  const events = [];
  const updater = createUpdater({installDir: s.installDir, stateFile: s.stateFile, ...swapSeams(events),
    hosts: hostFake(events, s.installDir)});
  await updater.apply({version: '0.2.0'});
  assert.deepEqual(events, ['smoke staged', 'record', 'stop 0.1.0', 'swap', 'start 0.2.0']);
  assert.equal(await version(s.installDir), '0.2.0');
});

test('a new version that does not start leaves the running coordinator alone and starts nothing', async t => {
  const s = await install(t);
  const events = [];
  const updater = createUpdater({installDir: s.installDir, stateFile: s.stateFile, ...swapSeams(events, {smokeFails: true}),
    hosts: hostFake(events, s.installDir)});
  await assert.rejects(updater.apply({version: '0.2.0'}), {code: 'rolled_back'});
  assert.deepEqual(events, ['smoke staged'], 'the host is never stopped or started');
  assert.equal(await version(s.installDir), '0.1.0');
  assert.equal((await savedState(s)).failedVersion, '0.2.0');
  assert.equal(await exists(s.installDir + '.next'), false, 'the failed tree is dropped');
});

test('a new circle host that does not become ready rolls the install back and restarts the previous coordinator', async t => {
  const s = await install(t);
  const events = [];
  let starts = 0;
  const updater = createUpdater({installDir: s.installDir, stateFile: s.stateFile, ...swapSeams(events),
    hosts: hostFake(events, s.installDir, {records: [OWNER_RECORD, null],
      start: () => (++starts === 1 ? Promise.reject(new Error('not ready')) : undefined)})});
  await assert.rejects(updater.apply({version: '0.2.0'}), {code: 'rolled_back'});
  assert.deepEqual(events, ['smoke staged', 'record', 'stop 0.1.0', 'swap', 'start 0.2.0', 'record', 'restore', 'start 0.1.0']);
  assert.equal(await version(s.installDir), '0.1.0', 'the old tree is back');
  assert.equal((await savedState(s)).failedVersion, '0.2.0');
});

test('a failed stop aborts the update before any swap, and a coordinator that still runs is left alone', async t => {
  const s = await install(t);
  const events = [];
  const updater = createUpdater({installDir: s.installDir, stateFile: s.stateFile, ...swapSeams(events),
    hosts: hostFake(events, s.installDir, {stop: async () => { throw new Error('did not stop'); }})});
  await assert.rejects(updater.apply({version: '0.2.0'}), {code: 'host_stop_failed'});
  assert.deepEqual(events, ['smoke staged', 'record', 'stop 0.1.0', 'record'], 'no swap and no second coordinator');
  assert.equal(await version(s.installDir), '0.1.0');
  assert.equal(await exists(s.installDir + '.next'), true, 'the staged tree is kept for a later try');
});

test('a legacy_exposure_pending stop refusal surfaces as a plain updater next action', async t => {
  const s = await install(t);
  const events = [];
  const refusal = Object.assign(new Error('provider: legacy exposure at /saved/legacy'), {code: 'legacy_exposure_pending'});
  const updater = createUpdater({installDir: s.installDir, stateFile: s.stateFile, ...swapSeams(events),
    hosts: hostFake(events, s.installDir, {stop: async () => { throw refusal; }})});
  await assert.rejects(updater.apply({version: '0.2.0'}),
    error => error.code === 'legacy_exposure_pending'
      && error.message === 'The circle host refused to stop because of a saved legacy exposure. Review the saved legacy exposure and retry the update.'
      && !error.message.includes('provider'));
  assert.deepEqual(events, ['smoke staged', 'record', 'stop 0.1.0', 'record'], 'no swap and no second coordinator');
  assert.equal(await version(s.installDir), '0.1.0');
  assert.equal(await exists(s.installDir + '.next'), true, 'the staged tree is kept for a later try');
});

test('a failed stop that took the coordinator down starts it again from the unchanged install', async t => {
  const s = await install(t);
  const events = [];
  const updater = createUpdater({installDir: s.installDir, stateFile: s.stateFile, ...swapSeams(events),
    hosts: hostFake(events, s.installDir, {records: [OWNER_RECORD, null], stop: async () => { throw new Error('gone'); }})});
  await assert.rejects(updater.apply({version: '0.2.0'}), {code: 'host_stop_failed'});
  assert.deepEqual(events, ['smoke staged', 'record', 'stop 0.1.0', 'record', 'start 0.1.0']);
});

test('the update reports done only after the new circle host reports ready', async t => {
  const s = await install(t);
  const events = [];
  const started = deferred(), ready = deferred();
  t.after(() => ready.resolve());
  const updater = createUpdater({installDir: s.installDir, stateFile: s.stateFile, ...swapSeams(events),
    hosts: hostFake(events, s.installDir, {start: () => { started.resolve(); return ready.promise; }})});
  let done = false;
  const applied = updater.apply({version: '0.2.0'}).then(() => { done = true; });
  // Whichever settles first: the host start is reached, or apply finishes (which fails the check below, not hangs).
  await Promise.race([started.promise, applied]);
  assert.equal(events.at(-1), 'start 0.2.0', 'the new host is still starting');
  assert.equal(done, false, 'the update is not done while the new host is starting');
  ready.resolve({circle_id: 'c1'});
  await applied;
  assert.equal(done, true);
});

test('with no hosted coordinator the update checks for one before the swap and swaps as before', async t => {
  const s = await install(t);
  const events = [];
  const updater = createUpdater({installDir: s.installDir, stateFile: s.stateFile, ...swapSeams(events),
    hosts: hostFake(events, s.installDir, {records: [null]})});
  await updater.apply({version: '0.2.0'});
  assert.deepEqual(events, ['smoke staged', 'record', 'swap']);
  assert.equal(await version(s.installDir), '0.2.0');
});

// A coordinator home whose status names a process with a verified identity. Nothing here is a real process.
async function coordinatorFixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'spk-restart-coordinator-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const config = join(home, 'host.json'), status = join(home, 'status.json');
  const entry = fileURLToPath(new URL('../bin/faravan-coordinator', import.meta.url));
  const identityOptions = {platform: 'linux',
    readlink: file => (file.endsWith('/exe') ? process.execPath : 'pid:[test]'),
    readFile: file => (file.endsWith('/cmdline') ? ['node', entry, '--host-config', config].join('\0') + '\0'
      : file.endsWith('/boot_id') ? 'test-boot' : '424242 (node) ' + ['S', ...Array(18).fill('0'), '42'].join(' ')),
    execFile: () => ''};
  await writeFile(config, JSON.stringify({protocol_version: 1, status_path: status}));
  const owner = captureCoordinatorOwner(424242, config, identityOptions);
  await writeFile(status, JSON.stringify({protocol_version: 1, pid: 424242, status: 'listening', owner}));
  return {home, config, status, identityOptions, owner};
}

test('a stop that names a coordinator no longer on record refuses before it changes anything', async t => {
  const {stopV1Host} = await import('../lib/v1/host.mjs');
  const fixture = await coordinatorFixture(t);
  const before = await readFile(fixture.config, 'utf8');
  let signalled = 0;
  await assert.rejects(stopV1Host({home: fixture.home, expectedOwner: {...fixture.owner, boot: 'a-different-boot'}},
    {processExists: () => true, identityOptions: fixture.identityOptions, stopServer: async () => { signalled++; }, sleep: async () => {}}),
  /changed after it was recorded/);
  assert.equal(signalled, 0, 'the process was not signalled');
  assert.equal(await readFile(fixture.config, 'utf8'), before, 'no supervisor generation was retired');
});

for (const [name, origin, managed, inspectionFails] of [
  ['managed public address','https://old-host.example.test',true],
  ['managed loopback address','http://127.0.0.1:4100',true],
  ['managed address with unavailable inspection','https://old-host.example.test',true,true],
  ['plain loopback address','http://127.0.0.1:4100',false],
]) test('update legacy exposure fence: '+name, async t => {
  const {stopV1Host}=await import('../lib/v1/host.mjs');
  const fixture=await coordinatorFixture(t);
  const old={protocol_version:1,status_path:fixture.status,port:4100,v1_origin:origin,host_wanted:true,
    reachability:{kind:'url',publicUrl:origin,...(managed?{managedBy:'legacy-fixture'}:{})}};
  const bytes=JSON.stringify(old);
  await writeFile(fixture.config,bytes);
  let signalled=0, inspections=0;
  const stop=()=>stopV1Host({home:fixture.home,expectedOwner:fixture.owner},{
    processExists:()=>signalled===0,identityOptions:fixture.identityOptions,sleep:async()=>{},
    stopServer:async()=>{signalled++;},
    hostingApi:{inspectLegacyRoute:async request=>{
      inspections++;
      assert.deepEqual(request.source.stateFiles,[fixture.config]);
      assert.equal(request.origin,origin);
      if(inspectionFails)throw new Error('synthetic inspection unavailable');
      return {nextAction:{instructions:'Review the saved exposure.'}};
    }},
  });
  if(managed) {
    await assert.rejects(stop,error=>{
      assert.equal(error.code,'legacy_exposure_pending');
      assert.equal(error.action?.instructions,inspectionFails?undefined:'Review the saved exposure.');
      return true;
    });
    assert.equal(signalled,0);
    assert.equal(inspections,1);
    assert.equal(await readFile(fixture.config,'utf8'),bytes);
  } else {
    await stop();
    assert.equal(signalled,1);
    assert.equal(inspections,0);
    const after=JSON.parse(await readFile(fixture.config,'utf8'));
    assert.ok(after.stop_generation);
    assert.equal(after.host_wanted,true);
    assert.deepEqual(after.reachability,old.reachability);
  }
});

test('hostedCoordinatorRecord names a verified live coordinator; absence and dead PIDs are null; an unverifiable one throws', async t => {
  const {hostedCoordinatorRecord} = await import('../lib/v1/host.mjs');
  const fixture = await coordinatorFixture(t);
  assert.deepEqual(hostedCoordinatorRecord(fixture.home, {...fixture.identityOptions, processKill: () => {}}), {pid: 424242, owner: fixture.owner});
  const dead = () => { throw Object.assign(new Error('no such process'), {code: 'ESRCH'}); };
  assert.equal(hostedCoordinatorRecord(fixture.home, {...fixture.identityOptions, processKill: dead}), null);
  const empty = await mkdtemp(join(tmpdir(), 'spk-restart-empty-'));
  t.after(() => rm(empty, {recursive: true, force: true}));
  assert.equal(hostedCoordinatorRecord(empty), null);
  await writeFile(fixture.status, JSON.stringify({protocol_version: 1, pid: 424242, status: 'listening'}));
  assert.throws(() => hostedCoordinatorRecord(fixture.home, {...fixture.identityOptions, processKill: () => {}}));
});

test('the restart runs the new install\'s faravan host and resolves with its host_ready line', async t => {
  const {startHostFromInstall} = await import('../lib/v1/host-command.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'spk-restart-start-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const spawned = [];
  const spawnProcess = (command, args, options) => {
    spawned.push({command, args, env: options.env});
    writeFileSync(options.stdio[1], JSON.stringify({schema_version: 1, type: 'host_ready', circle_id: 'c1', origin: 'https://example.test'}) + '\n');
    return {once() {}, on() {}, unref() {}};
  };
  const result = await startHostFromInstall({installDir: '/srv/new/lib/faravan', runtime: '/srv/new/runtime/bin/node',
    home: '/srv/app', coordinatorHome: dir, spawnProcess});
  assert.deepEqual(result, {circle_id: 'c1', origin: 'https://example.test'});
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, '/srv/new/runtime/bin/node');
  assert.deepEqual(spawned[0].args, ['/srv/new/lib/faravan/bin/faravan', 'host', '--json']);
  assert.equal(spawned[0].env.FARAVAN_COORDINATOR_HOME, dir);
  assert.equal(spawned[0].env.FARAVAN_HOME, '/srv/app');
});

test('an install told where its coordinator lives will not swap while that coordinator cannot be verified', async t => {
  const s = await install(t);
  const coordinator = await mkdtemp(join(tmpdir(), 'spk-restart-unverified-'));
  t.after(() => rm(coordinator, {recursive: true, force: true}));
  await writeFile(join(coordinator, 'host.json'), JSON.stringify({protocol_version: 1, status_path: join(coordinator, 'status.json')}));
  // A live-looking status with no owner: its identity cannot be verified, so nothing may be stopped or swapped.
  await writeFile(join(coordinator, 'status.json'), JSON.stringify({protocol_version: 1, pid: 424242, status: 'listening'}));
  const updater = await updaterForInstall({home: join(s.root, 'home'), env: {}, installDir: s.installDir, platform: 'linux',
    coordinatorHome: coordinator, smoke: async () => {}});
  await assert.rejects(updater.apply({version: '0.2.0'}), {code: 'host_unverified'});
  assert.equal(await version(s.installDir), '0.1.0');
});

// A detached host launch that never reports ready by itself. Once one of `exitOn` arrives it exits, a moment later.
// `events` logs each signal and each exit in order. `readyLine` is written to the start's output file when it spawns.
function fakeLaunch({exitOn = ['SIGTERM'], events, readyLine, verified = true, doubleError = false, removeProof = false} = {}) {
  const launch = new EventEmitter();
  launch.pid = 424243;
  let output, token;
  launch.signals = [];
  launch.exits = 0;
  launch.kill = signal => {
    launch.signals.push(signal);
    events?.push('kill ' + signal);
    if (doubleError) { launch.emit('error', new Error('signal failure one')); launch.emit('error', new Error('signal failure two')); }
    if (exitOn.includes(signal)) setTimeout(() => {
      if (signal === 'SIGTERM' && verified) {
        // Fake the actual CLI contract: owned coordinator stopped, then acknowledgement, then exit.
        events?.push('coordinator stopped');
        writeFileSync(output, JSON.stringify({type:'host_launch_stopped', token}) + '\n', {flag:'a'});
      }
      if (removeProof) unlinkSync(output);
      launch.exits++; events?.push('exit'); launch.emit('exit', null, signal);
    }, 5);
    return true;
  };
  launch.unref = () => {};
  launch.spawn = (command, args, options) => {
    token = options.env.FARAVAN_HOST_LAUNCH_TOKEN;
    output = join(options.env.FARAVAN_COORDINATOR_HOME, 'host-op-' + token + '.out');
    if (readyLine) writeFileSync(options.stdio[1], readyLine);
    return launch;
  };
  return launch;
}
const READY = JSON.stringify({schema_version: 1, type: 'host_ready', circle_id: 'c1', origin: 'https://example.test'}) + '\n';
// A bundled Node at <tree>/runtime/bin/node, as a tarball tree ships it. Returns its path.
async function bundledNode(tree) {
  const node = join(tree, 'runtime', 'bin', 'node');
  await mkdir(dirname(node), {recursive: true});
  await writeFile(node, '');
  await chmod(node, 0o755);
  return node;
}
const disk = () => Object.assign(new Error('the disk went away'), {code: 'EIO'});

test('a host start that times out stops the launch it spawned and waits for that launch to exit before it fails', async t => {
  const {startHostFromInstall} = await import('../lib/v1/host-command.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'spk-restart-timeout-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const launch = fakeLaunch();
  await assert.rejects(startHostFromInstall({installDir: '/srv/new/lib/faravan', runtime: process.execPath, home: '/srv/app',
    coordinatorHome: dir, spawnProcess: launch.spawn, timeoutMs: 50, stopWaitMs: 2000}), {code: 'timeout'});
  assert.deepEqual(launch.signals, ['SIGTERM'], 'the launch this start spawned is stopped');
  assert.equal(launch.exits, 1, 'its exit is seen before the start fails');
});

test('a host start that fails after its launch went live stops that launch too', async t => {
  const {startHostFromInstall} = await import('../lib/v1/host-command.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'spk-restart-broken-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const launch = fakeLaunch({readyLine: '{"schema_version":1,"type":"host_ready",\n'});
  await assert.rejects(startHostFromInstall({installDir: '/srv/new/lib/faravan', runtime: process.execPath, home: '/srv/app',
    coordinatorHome: dir, spawnProcess: launch.spawn, timeoutMs: 2000, stopWaitMs: 2000}), SyntaxError);
  assert.deepEqual(launch.signals, ['SIGTERM'], 'a failure that is not a timeout still stops the live launch');
  assert.equal(launch.exits, 1);
});

test('a launch that ignores SIGTERM is killed but its coordinator cleanup remains unverified', async t => {
  const {startHostFromInstall} = await import('../lib/v1/host-command.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'spk-restart-stubborn-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const launch = fakeLaunch({exitOn: ['SIGKILL']});
  await assert.rejects(startHostFromInstall({installDir: '/srv/new/lib/faravan', runtime: process.execPath, home: '/srv/app',
    coordinatorHome: dir, spawnProcess: launch.spawn, timeoutMs: 50, stopWaitMs: 100}), {code: 'launcher_unverified'});
  assert.deepEqual(launch.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(launch.exits, 1);
});

test('a launch that reports ready is left running', async t => {
  const {startHostFromInstall} = await import('../lib/v1/host-command.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'spk-restart-ready-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const launch = fakeLaunch({readyLine: READY});
  const result = await startHostFromInstall({installDir: '/srv/new/lib/faravan', runtime: process.execPath, home: '/srv/app',
    coordinatorHome: dir, spawnProcess: launch.spawn, timeoutMs: 2000, stopWaitMs: 2000});
  assert.deepEqual(result, {circle_id: 'c1', origin: 'https://example.test'});
  assert.deepEqual(launch.signals, [], 'a host that is up is not stopped');
});

test('the rollback after a launch that timed out waits until that launch has exited, and then starts the old host', async t => {
  const {startHostFromInstall} = await import('../lib/v1/host-command.mjs');
  const s = await install(t);
  const events = [];
  const launches = [fakeLaunch({events}), fakeLaunch({readyLine: READY})];
  const hosts = hostFake(events, s.installDir, {records: [OWNER_RECORD, null],
    start: () => startHostFromInstall({installDir: s.installDir, runtime: process.execPath, home: s.root,
      coordinatorHome: join(s.root, 'coordinator'), spawnProcess: launches.shift().spawn, timeoutMs: 50, stopWaitMs: 2000})});
  const updater = createUpdater({installDir: s.installDir, stateFile: s.stateFile, ...swapSeams(events), hosts});
  const error = await updater.apply({version: '0.2.0'}).catch(e => e);
  assert.equal(error?.code, 'rolled_back');
  assert.deepEqual(events, ['smoke staged', 'record', 'stop 0.1.0', 'swap', 'start 0.2.0', 'kill SIGTERM', 'coordinator stopped', 'exit', 'record', 'restore', 'start 0.1.0']);
  assert.equal(await version(s.installDir), '0.1.0');
});

test('a launch that will not exit blocks the rollback: the new version stays in place and the old host is not started', async t => {
  const {startHostFromInstall} = await import('../lib/v1/host-command.mjs');
  const s = await install(t);
  const events = [];
  const launches = [fakeLaunch({events, exitOn: []}), fakeLaunch({readyLine: READY})];
  const hosts = hostFake(events, s.installDir, {records: [OWNER_RECORD],
    start: () => startHostFromInstall({installDir: s.installDir, runtime: process.execPath, home: s.root,
      coordinatorHome: join(s.root, 'coordinator'), spawnProcess: launches.shift().spawn, timeoutMs: 50, stopWaitMs: 30})});
  const updater = createUpdater({installDir: s.installDir, stateFile: s.stateFile, ...swapSeams(events), hosts});
  const error = await updater.apply({version: '0.2.0'}).catch(e => e);
  assert.equal(error?.code, 'host_unverified');
  assert.deepEqual(events, ['smoke staged', 'record', 'stop 0.1.0', 'swap', 'start 0.2.0', 'kill SIGTERM', 'kill SIGKILL']);
  assert.equal(await version(s.installDir), '0.2.0', 'the new version stays in place');
  assert.equal((await savedState(s)).failedVersion, undefined, 'and nothing is recorded as failed');
});

test('a failed failure-record write still restarts the previous coordinator, and both errors are kept', async t => {
  const s = await install(t);
  const blocker = join(s.root, 'not-a-folder');
  await writeFile(blocker, 'a file where the state folder should be\n');
  const events = [];
  let starts = 0;
  const updater = createUpdater({installDir: s.installDir, stateFile: join(blocker, 'update.json'), ...swapSeams(events),
    hosts: hostFake(events, s.installDir, {records: [OWNER_RECORD, null],
      start: () => (++starts === 1 ? Promise.reject(new Error('not ready')) : undefined)})});
  const error = await updater.apply({version: '0.2.0'}).catch(e => e);
  assert.equal(error?.code, 'rolled_back');
  assert.equal(error.recovery?.restarted, true, 'the old coordinator was started again');
  assert.equal(error.recovery?.failedVersionRecorded, false, 'and the failed write is reported, not hidden');
  assert.ok(error.cause instanceof Error, 'the start error and the write error are kept together as the cause');
  assert.deepEqual(events, ['smoke staged', 'record', 'stop 0.1.0', 'swap', 'start 0.2.0', 'record', 'restore', 'start 0.1.0']);
  assert.equal(await version(s.installDir), '0.1.0');
});

test('a replacement process after the stop fence is not signalled', async t => {
  const {stopV1Host}=await import('../lib/v1/host.mjs');
  const home=await mkdtemp(join(tmpdir(),'spk-restart-replaced-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const config=join(home,'host.json'),status=join(home,'status.json');
  const entry=fileURLToPath(new URL('../bin/faravan-coordinator',import.meta.url));
  let start='42';
  const identityOptions={platform:'linux',
    readlink:file=>file.endsWith('/exe')?process.execPath:'pid:[test]',
    readFile:file=>file.endsWith('/cmdline')?['node',entry,'--host-config',config].join('\0')+'\0'
      : file.endsWith('/boot_id')?'test-boot':'424242 (node) '+['S',...Array(18).fill('0'),start].join(' '),
    execFile:()=>''};
  await writeFile(config,JSON.stringify({protocol_version:1,status_path:status,reachability:{kind:'gozar'}}));
  const first=captureCoordinatorOwner(424242,config,identityOptions);
  await writeFile(status,JSON.stringify({protocol_version:1,pid:424242,status:'public_listening',owner:first}));
  const originalRead=identityOptions.readFile;
  identityOptions.readFile=file=>{
    if(file.endsWith('/stat')&&JSON.parse(readFileSync(config,'utf8')).stop_generation)start='43';
    return originalRead(file);
  };
  await assert.rejects(stopV1Host({home,expectedOwner:first},{
    processExists:()=>true,identityOptions,stopServer:()=>assert.fail('the replacement must not be signalled'),
  }),error=>!String(error).includes('the replacement must not be signalled')&&/coordinator changed|coordinator.*ownership|process identity|cannot verify the previous coordinator process/.test(error.message));
  assert.equal(start,'43','the identity changed after the stop was fenced');
});

test('stopping a coordinator named by an update refuses when the host config is gone, instead of reporting it stopped', async t => {
  const {stopV1Host} = await import('../lib/v1/host.mjs');
  const home = await mkdtemp(join(tmpdir(), 'spk-restart-gone-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  await assert.rejects(stopV1Host({home, expectedOwner: OWNER}), /was not stopped/);
});

test('a swap whose previous version cannot be put back does not start the old host, and the error names what is on disk', async t => {
  const s = await install(t);
  const events = [];
  let starts = 0;
  const hosts = {
    record: async () => { events.push('record'); return OWNER_RECORD; },
    stop: async () => { events.push('stop'); },
    start: async () => { starts++; },
  };
  const updater = createUpdater({installDir: s.installDir, stateFile: s.stateFile, smoke: swapSeams(events).smoke, hosts,
    rename: (from, to) => (from.endsWith('.prev') ? Promise.reject(disk()) : fsRename(from, to)),
    renameSync:(from,to)=>{if(from.endsWith('.next'))throw disk();return fsRenameSync(from,to);}});
  const error = await updater.apply({version: '0.2.0'}).catch(e => e);
  assert.equal(error?.code, 'restore_failed');
  assert.match(error.message, /faravan\.prev/, 'the message says where the previous version is');
  assert.deepEqual(events, ['smoke staged', 'record', 'stop']);
  assert.equal(starts, 0, 'the old host is not started over a missing install');
  assert.equal(await exists(s.installDir), false);
  assert.equal(await exists(s.installDir + '.prev'), true);
});

test('a rollback that cannot put the previous version back does not restart the old host', async t => {
  const s = await install(t);
  const events = [];
  const seams = swapSeams(events);
  let starts = 0;
  const updater = createUpdater({installDir: s.installDir, stateFile: s.stateFile, smoke: seams.smoke,renameSync:seams.renameSync,
    rename: (from, to) => (from.endsWith('.prev') ? Promise.reject(disk()) : seams.rename(from, to)),
    hosts: hostFake(events, s.installDir, {records: [OWNER_RECORD, null],
      start: () => (++starts === 1 ? Promise.reject(new Error('not ready')) : undefined)})});
  const error = await updater.apply({version: '0.2.0'}).catch(e => e);
  assert.equal(error?.code, 'restore_failed');
  assert.equal(starts, 1, 'only the new host was started');
  assert.deepEqual(events, ['smoke staged', 'record', 'stop 0.1.0', 'swap', 'start 0.2.0', 'record']);
  assert.equal(await exists(s.installDir), false, 'the install is missing, and that is what the error reports');
  assert.equal(await exists(s.installDir + '.prev'), true);
  assert.equal((await savedState(s)).failedVersion, '0.2.0', 'the version that did not start is still recorded');
});

test('an update whose new tree has no Node of its own is refused before anything stops, when this app runs the Node it would replace', async t => {
  const s = await install(t);
  const oldNode = await bundledNode(s.installDir);
  const events = [];
  const updater = createUpdater({installDir: s.installDir, stateFile: s.stateFile, ...swapSeams(events), execPath: oldNode,
    hosts: hostFake(events, s.installDir)});
  const error = await updater.apply({version: '0.2.0'}).catch(e => e);
  assert.equal(error?.code, 'runtime_missing');
  assert.deepEqual(events, ['smoke staged'], 'nothing is stopped or moved');
  assert.equal(await version(s.installDir), '0.1.0');
});

test('with no hosted coordinator, an update whose new tree has no Node of its own is refused the same way', async t => {
  const s = await install(t);
  const oldNode = await bundledNode(s.installDir);
  const events = [];
  const updater = createUpdater({installDir: s.installDir, stateFile: s.stateFile, ...swapSeams(events), execPath: oldNode});
  const error = await updater.apply({version: '0.2.0'}).catch(e => e);
  assert.equal(error?.code, 'runtime_missing');
  assert.deepEqual(events, ['smoke staged']);
  assert.equal(await version(s.installDir), '0.1.0');
});

test('an update whose new tree ships its own Node swaps and starts as before, though this app runs the Node it replaces', async t => {
  const s = await install(t);
  const oldNode = await bundledNode(s.installDir);
  await bundledNode(s.installDir + '.next');
  const events = [];
  const updater = createUpdater({installDir: s.installDir, stateFile: s.stateFile, ...swapSeams(events), execPath: oldNode,
    hosts: hostFake(events, s.installDir)});
  await updater.apply({version: '0.2.0'});
  assert.deepEqual(events, ['smoke staged', 'record', 'stop 0.1.0', 'swap', 'start 0.2.0']);
  assert.equal(await version(s.installDir), '0.2.0');
});

test('TERM exit without an owned-cleanup acknowledgement is unverified', async t => {
  const {startHostFromInstall} = await import('../lib/v1/host-command.mjs');
  const s = await install(t), launch = fakeLaunch({verified:false});
  await assert.rejects(startHostFromInstall({installDir:s.installDir, runtime:process.execPath,
    coordinatorHome:join(s.root,'coordinator'), spawnProcess:launch.spawn, timeoutMs:10, stopWaitMs:100}),
    {code:'launcher_unverified'});
});

test('a second child error event is handled throughout failed launch cleanup', async t => {
  const {startHostFromInstall} = await import('../lib/v1/host-command.mjs');
  const s = await install(t), launch = fakeLaunch({doubleError:true});
  await assert.rejects(startHostFromInstall({installDir:s.installDir, runtime:process.execPath,
    coordinatorHome:join(s.root,'coordinator'), spawnProcess:launch.spawn, timeoutMs:10, stopWaitMs:100}),
    {code:'timeout'});
  assert.equal(launch.listenerCount('error'), 1);
  launch.emit('error', new Error('late error after cleanup'));
});

for (const exitOn of [['SIGKILL'], ['SIGTERM']]) test('unverified ' + exitOn[0] + ' exit keeps new install, without rollback or old host restart', async t => {
  const {startHostFromInstall} = await import('../lib/v1/host-command.mjs');
  const s = await install(t), events = [], launch = fakeLaunch({events, exitOn, verified:false});
  const updater = createUpdater({...s, ...swapSeams(events), hosts:hostFake(events,s.installDir,{
    records:[OWNER_RECORD,null],
    start:()=>startHostFromInstall({installDir:s.installDir,runtime:process.execPath,
      coordinatorHome:join(s.root,'coordinator'),spawnProcess:launch.spawn,timeoutMs:10,stopWaitMs:100}),
  })});
  const error = await updater.apply({version:'0.2.0'}).catch(error=>error);
  assert.equal(error.code,'host_unverified');
  assert.equal(error.cause.code,'launcher_unverified');
  assert.equal(await version(s.installDir),'0.2.0');
  assert.equal(await version(s.installDir+'.prev'),'0.1.0');
  assert.equal(events.filter(event=>event==='record').length,1,'no absence-based recovery after unverified cleanup');
  assert.equal(events.includes('restore'),false);
  assert.equal(events.includes('start 0.1.0'),false);
  assert.equal((await savedState(s)).failedVersion,undefined);
});

for (const mode of ['executable','missing','not-executable','directory']) test('in-tree fallback staged counterpart: ' + mode, async t => {
  const s = await install(t), events = [], oldNode = join(s.installDir,'tools','node');
  await mkdir(dirname(oldNode),{recursive:true}); await writeFile(oldNode,''); await chmod(oldNode,0o755);
  const stagedNode = join(s.installDir+'.next','tools','node');
  if(mode !== 'missing') {
    await mkdir(dirname(stagedNode),{recursive:true});
    if(mode==='directory') await mkdir(stagedNode);
    else { await writeFile(stagedNode,''); await chmod(stagedNode,mode==='executable'?0o755:0o644); }
  }
  const updater = createUpdater({...s,...swapSeams(events),execPath:oldNode,hosts:hostFake(events,s.installDir)});
  if(mode==='executable') {
    await updater.apply({version:'0.2.0'});
    assert.equal(await version(s.installDir),'0.2.0');
    assert.deepEqual(events,['smoke staged','record','stop 0.1.0','swap','start 0.2.0']);
  } else {
    await assert.rejects(updater.apply({version:'0.2.0'}),{code:'runtime_missing'});
    assert.deepEqual(events,['smoke staged']);
    assert.equal(await version(s.installDir),'0.1.0');
  }
});

// Exercise the same exported TERM barrier used by bin/faravan, with fake owned handles and signals.
test('TERM waits for in-flight hostV1 startServer then owned stop before acknowledgement and exit', async t => {
  const {hostV1,hostLaunchWithCleanup} = await import('../lib/v1/host.mjs');
  const s = await install(t), signals = new EventEmitter(), pending = deferred(), entered = deferred(), stopped = deferred(), ended = deferred(), events = [];
  const circle = {id:'c1',origin:'http://10.23.4.10:8787',lanMode:true,pinnedRootFingerprint:'root',provisioningPath:join(s.root,'provisioning.json')};
  const launch = hostLaunchWithCleanup(signal=>hostV1({home:join(s.root,'host'),base:s.root,tunnel:'lan',signal},{
    portInUse:async()=>false,networkInterfaces:()=>({lan:[{family:'IPv4',address:'10.23.4.10',internal:false}]}),
    openDevice:async()=>({createCircle:async()=>circle,publishRoster:async()=>events.push('publish'),createInviteLinks:async()=>({short:'invite'})}),
    provision:async()=>{},
    startServer:async()=>{events.push('start entered');entered.resolve();return pending.promise;},
    waitReady:async()=>{events.push('ready');return {protocol_version:1,status:'listening',public_url:circle.origin};},
  }),{signals,acknowledge:()=>events.push('ack'),exit:code=>{events.push('exit '+code);ended.resolve();}});
  const rejected = launch.result.catch(error=>error);
  await entered.promise; signals.emit('SIGTERM'); signals.emit('SIGTERM');
  await Promise.resolve(); assert.deepEqual(events,['start entered']);
  pending.resolve({stop:async()=>{events.push('stop entered');await stopped.promise;events.push('stop finished');}});
  // Wait for the actual stop to begin, without allowing acknowledgement to race ahead of it.
  for(let i=0;i<20&&!events.includes('stop entered');i++) await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(events,['start entered','stop entered']);
  stopped.resolve(); await ended.promise;
  assert.equal((await rejected).code,'host_launch_aborted');
  assert.deepEqual(events,['start entered','stop entered','stop finished','ack','exit 0']);
  launch.dispose();
});

test('TERM after ready waits for owned stop and acknowledgement before exit', async () => {
  const {hostLaunchWithCleanup} = await import('../lib/v1/host.mjs');
  const signals = new EventEmitter(), stopped = deferred(), flushed = deferred(), ended = deferred(), events = [];
  const launch = hostLaunchWithCleanup(async()=>({process:{stop:async()=>{events.push('stop');await stopped.promise;events.push('stopped');}}}),
    {signals,acknowledge:async()=>{events.push('ack');await flushed.promise;events.push('flushed');},exit:code=>{events.push('exit '+code);ended.resolve();}});
  await launch.result; signals.emit('SIGTERM'); await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(events,['stop']); stopped.resolve(); await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(events,['stop','stopped','ack']); flushed.resolve(); await ended.promise;
  assert.deepEqual(events,['stop','stopped','ack','flushed','exit 0']); launch.dispose();
});

test('adopted host and failed owned stop never acknowledge cleanup', async () => {
  const {hostLaunchWithCleanup} = await import('../lib/v1/host.mjs');
  for(const hosted of [{process:null},{process:{stop:async()=>{throw new Error('not stopped');}}}]) {
    const signals = new EventEmitter(), ended = deferred(), events = [];
    const launch = hostLaunchWithCleanup(async()=>hosted,{signals,acknowledge:()=>events.push('ack'),exit:code=>{events.push(code);ended.resolve();}});
    await launch.result; signals.emit('SIGTERM'); await ended.promise;
    assert.deepEqual(events,[1]); launch.dispose();
  }
});

test('CLI wires the tested TERM barrier and waits for supervisor finish before cleanup proof', async () => {
  const source = await readFile(new URL('../bin/faravan',import.meta.url),'utf8');
  assert.match(source,/hostLaunchWithCleanup\(signal => hostV1\(\{home, base, signal,/);
  assert.match(source,/stop:async\(\)=>\{ supervised.stop\(\); await finished; \}/);
  assert.match(source,/fs.writeSync\(1, JSON.stringify\(\{type:'host_launch_stopped', token\}\)/);
});

test('unreadable cleanup acknowledgement is unverified rather than a rollback-authorizing filesystem error', async t => {
  const {startHostFromInstall} = await import('../lib/v1/host-command.mjs');
  const s = await install(t), launch = fakeLaunch({removeProof:true});
  await assert.rejects(startHostFromInstall({installDir:s.installDir, runtime:process.execPath,
    coordinatorHome:join(s.root,'coordinator'), spawnProcess:launch.spawn, timeoutMs:10, stopWaitMs:100}),
    {code:'launcher_unverified'});
});

// Merge of circle hosting and update restarts: a refusal with a reason code keeps its code for the owner. Its cleanup is
// still unverified, so the updater keeps the new install exactly as for launcher_unverified.
const REFUSAL = JSON.stringify({schema_version:1, type:'host_error', status:'failed', code:'tailscale_serve_unavailable',
  message:'Tailscale Serve is not available.'}) + '\n';
test('a host refusal keeps its reason code and is marked unverified when no cleanup proof follows', async t => {
  const {startHostFromInstall} = await import('../lib/v1/host-command.mjs');
  const s = await install(t), launch = fakeLaunch({readyLine:REFUSAL, verified:false});
  const error = await startHostFromInstall({installDir:s.installDir, runtime:process.execPath,
    coordinatorHome:join(s.root,'coordinator'), spawnProcess:launch.spawn, timeoutMs:2000, stopWaitMs:100}).catch(error=>error);
  assert.equal(error.code,'tailscale_serve_unavailable');
  assert.equal(error.message,'Tailscale Serve is not available.');
  assert.equal(error.cleanup_verified,false);
  // With a verified stop, the refusal is the whole answer.
  const proven = fakeLaunch({readyLine:REFUSAL});
  const verifiedError = await startHostFromInstall({installDir:s.installDir, runtime:process.execPath,
    coordinatorHome:join(s.root,'coordinator2'), spawnProcess:proven.spawn, timeoutMs:2000, stopWaitMs:100}).catch(error=>error);
  assert.equal(verifiedError.code,'tailscale_serve_unavailable');
  assert.equal(verifiedError.cleanup_verified,undefined);
});

test('an unverified refusal on the new version keeps the new install, without rollback', async t => {
  const {startHostFromInstall} = await import('../lib/v1/host-command.mjs');
  const s = await install(t), events = [], launch = fakeLaunch({events, readyLine:REFUSAL, verified:false});
  const updater = createUpdater({...s, ...swapSeams(events), hosts:hostFake(events,s.installDir,{
    records:[OWNER_RECORD,null],
    start:()=>startHostFromInstall({installDir:s.installDir,runtime:process.execPath,
      coordinatorHome:join(s.root,'coordinator'),spawnProcess:launch.spawn,timeoutMs:2000,stopWaitMs:100}),
  })});
  const error = await updater.apply({version:'0.2.0'}).catch(error=>error);
  assert.equal(error.code,'host_unverified');
  assert.equal(error.cause.code,'tailscale_serve_unavailable');
  assert.equal(await version(s.installDir),'0.2.0');
  assert.equal(events.includes('restore'),false);
});

// A launch whose host CLI fails by itself and exits, with no signal from the updater. `run` is the work under the real
// TERM barrier from bin/faravan; its acknowledge writes the token-bound line exactly as cmdHostV1 does.
async function selfExitingLaunch(run) {
  const {hostLaunchWithCleanup} = await import('../lib/v1/host.mjs');
  const launch = new EventEmitter();
  launch.pid = 424244;
  launch.kill = () => true;
  launch.unref = () => {};
  launch.spawn = (command, args, options) => {
    const token = options.env.FARAVAN_HOST_LAUNCH_TOKEN;
    const output = join(options.env.FARAVAN_COORDINATOR_HOME, 'host-op-' + token + '.out');
    const barrier = hostLaunchWithCleanup(run, {signals: new EventEmitter(), exit: () => {},
      acknowledge: () => appendFileSync(output, JSON.stringify({type: 'host_launch_stopped', token}) + '\n')});
    barrier.result.catch(() => setTimeout(() => launch.emit('exit', 1, null), 5));
    return launch;
  };
  return launch;
}
const selfExitUpdate = async (t, launch) => {
  const {startHostFromInstall} = await import('../lib/v1/host-command.mjs');
  const s = await install(t), events = [];
  let starts = 0;
  const updater = createUpdater({...s, ...swapSeams(events), hosts: hostFake(events, s.installDir, {
    records: [OWNER_RECORD, null],
    start: () => (++starts === 1
      ? startHostFromInstall({installDir: s.installDir, runtime: process.execPath, coordinatorHome: join(s.root, 'coordinator'),
        spawnProcess: launch.spawn, timeoutMs: 2000, stopWaitMs: 100})
      : undefined),
  })});
  return {s, events, error: await updater.apply({version: '0.2.0'}).catch(error => error)};
};

test('a host that fails by itself after stopping what it started is verified, so the update rolls back', async t => {
  const launch = await selfExitingLaunch(async () => { throw Object.assign(new Error('not ready'), {cleanupVerified: true}); });
  const {s, events, error} = await selfExitUpdate(t, launch);
  assert.equal(error.code, 'rolled_back');
  assert.equal(await version(s.installDir), '0.1.0');
  assert.equal((await savedState(s)).failedVersion, '0.2.0');
  assert.deepEqual(events.slice(-2), ['restore', 'start 0.1.0']);
});

test('a host that fails by itself without proof of cleanup is unverified, so the new install is kept', async t => {
  const launch = await selfExitingLaunch(async () => { throw Object.assign(new Error('not ready'), {cleanupVerified: false}); });
  const {s, events, error} = await selfExitUpdate(t, launch);
  assert.equal(error.code, 'host_unverified');
  assert.equal(error.cause.code, 'launcher_unverified');
  assert.equal(await version(s.installDir), '0.2.0');
  assert.equal(events.includes('restore'), false);
  assert.equal((await savedState(s)).failedVersion, undefined);
});

test('the failure path acknowledges once, only when cleanup is verified and the CLI has a token', async () => {
  const {hostLaunchWithCleanup} = await import('../lib/v1/host.mjs');
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const cases = [
    {name: 'verified', cleanupVerified: true, term: false, acks: 1},
    {name: 'unverified', cleanupVerified: false, term: false, acks: 0},
    {name: 'no flag', cleanupVerified: undefined, term: false, acks: 0},
    {name: 'verified, then TERM', cleanupVerified: true, term: true, acks: 1},
  ];
  for (const c of cases) {
    const signals = new EventEmitter(), acks = [], exits = [];
    const launch = hostLaunchWithCleanup(async () => { throw Object.assign(new Error('failed'), {cleanupVerified: c.cleanupVerified}); },
      {signals, acknowledge: () => acks.push('ack'), exit: code => exits.push(code)});
    await launch.result.catch(() => {}); await settle();
    if (c.term) { signals.emit('SIGTERM'); await settle(); }
    assert.equal(acks.length, c.acks, c.name);
    launch.dispose();
  }
  // The CLI's own acknowledge writes nothing without a token (a manual run).
  const source = await readFile(new URL('../bin/faravan', import.meta.url), 'utf8');
  assert.match(source, /if \(!token\) return;\n\s+fs\.writeSync\(1, JSON\.stringify\(\{type:'host_launch_stopped', token\}\)/);
});

test('the updater log records stop, swap and start in order, and the rollback when the new host does not start', async t => {
  const s = await install(t), logged = [], events = [];
  const updater = createUpdater({installDir: s.installDir, stateFile: s.stateFile, ...swapSeams(events), log: line => logged.push(line),
    hosts: hostFake(events, s.installDir)});
  await updater.apply({version: '0.2.0'});
  assert.deepEqual(logged, ['stopping the circle host', 'swapping in version 0.2.0', 'starting the circle host on version 0.2.0']);

  const r = await install(t), rolled = [], more = [];
  let starts = 0;
  const failing = createUpdater({installDir: r.installDir, stateFile: r.stateFile, ...swapSeams(more), log: line => rolled.push(line),
    hosts: hostFake(more, r.installDir, {records: [OWNER_RECORD, null], start: () => (++starts === 1 ? Promise.reject(new Error('not ready')) : undefined)})});
  await assert.rejects(failing.apply({version: '0.2.0'}), {code: 'rolled_back'});
  assert.deepEqual(rolled.map(line => line.split(':')[0].split(';')[0]), ['stopping the circle host', 'swapping in version 0.2.0',
    'starting the circle host on version 0.2.0', 'the circle host did not start on the new version', 'rolled back to the previous version']);
});

// A clock that moves only when the start sleeps. `sleeping` runs on each sleep, then the clock jumps past the deadline,
// so the line it writes lands after the last ordinary read and before the deadline check.
function lateLine(dir, line, {verified}) {
  const launch = fakeLaunch({verified});
  let clock = 0, token;
  const spawn = (command, args, options) => { token = options.env.FARAVAN_HOST_LAUNCH_TOKEN; return launch.spawn(command, args, options); };
  const sleep = async () => { writeFileSync(join(dir, 'host-op-' + token + '.out'), line, {flag: 'a'}); clock = 1000; };
  return {launch, opts: {spawnProcess: spawn, now: () => clock, sleep, timeoutMs: 500, stopWaitMs: 2000}};
}
const LATE_REFUSAL = JSON.stringify({schema_version: 1, type: 'host_error', status: 'failed', code: 'previous_coordinator_other_install', message: 'older copy'}) + '\n';

test('a refusal written in the last polling interval keeps its code when cleanup is verified', async t => {
  const {startHostFromInstall} = await import('../lib/v1/host-command.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'spk-restart-late-refusal-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const {launch, opts} = lateLine(dir, LATE_REFUSAL, {verified: true});
  const error = await startHostFromInstall({installDir: '/srv/new/lib/faravan', runtime: process.execPath, home: '/srv/app', coordinatorHome: dir, ...opts}).catch(e => e);
  assert.equal(error.code, 'previous_coordinator_other_install');
  assert.equal(error.status, 409);
  assert.equal(error.cleanup_verified, undefined);
  assert.deepEqual(launch.signals, ['SIGTERM']);
});

test('a refusal written in the last polling interval keeps its code and reports unverified cleanup', async t => {
  const {startHostFromInstall} = await import('../lib/v1/host-command.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'spk-restart-late-refusal-unverified-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const {opts} = lateLine(dir, LATE_REFUSAL, {verified: false});
  const error = await startHostFromInstall({installDir: '/srv/new/lib/faravan', runtime: process.execPath, home: '/srv/app', coordinatorHome: dir, ...opts}).catch(e => e);
  assert.equal(error.code, 'previous_coordinator_other_install');
  assert.equal(error.cleanup_verified, false);
});

test('a host_ready written in the last polling interval is returned and the launch is left running', async t => {
  const {startHostFromInstall} = await import('../lib/v1/host-command.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'spk-restart-late-ready-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const {launch, opts} = lateLine(dir, READY, {verified: true});
  const result = await startHostFromInstall({installDir: '/srv/new/lib/faravan', runtime: process.execPath, home: '/srv/app', coordinatorHome: dir, ...opts});
  assert.deepEqual(result, {circle_id: 'c1', origin: 'https://example.test'});
  assert.deepEqual(launch.signals, []);
});

// The launch exits by itself in the last polling interval, with no ready or refusal line.
function lateExit(dir, {proof}) {
  const launch = fakeLaunch();
  let clock = 0, token;
  const spawn = (command, args, options) => { token = options.env.FARAVAN_HOST_LAUNCH_TOKEN; return launch.spawn(command, args, options); };
  const sleep = async () => {
    if (proof) writeFileSync(join(dir, 'host-op-' + token + '.out'), JSON.stringify({type: 'host_launch_stopped', token}) + '\n', {flag: 'a'});
    launch.emit('exit', 1, null); clock = 1000;
  };
  return {launch, opts: {spawnProcess: spawn, now: () => clock, sleep, timeoutMs: 500, stopWaitMs: 2000}};
}

test('a launch that exits in the last polling interval is a host failure, not a timeout', async t => {
  const {startHostFromInstall} = await import('../lib/v1/host-command.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'spk-restart-late-exit-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const {launch, opts} = lateExit(dir, {proof: true});
  const error = await startHostFromInstall({installDir: '/srv/new/lib/faravan', runtime: process.execPath, home: '/srv/app', coordinatorHome: dir, ...opts}).catch(e => e);
  assert.equal(error.code, 'host_failed');
  assert.equal(error.status, 409);
  assert.deepEqual(launch.signals, []);

  const dir2 = await mkdtemp(join(tmpdir(), 'spk-restart-late-exit-unverified-'));
  t.after(() => rm(dir2, {recursive: true, force: true}));
  const unproven = lateExit(dir2, {proof: false});
  const error2 = await startHostFromInstall({installDir: '/srv/new/lib/faravan', runtime: process.execPath, home: '/srv/app', coordinatorHome: dir2, ...unproven.opts}).catch(e => e);
  assert.equal(error2.code, 'launcher_unverified');
  assert.equal(error2.cause.code, 'host_failed');
});

// Warning-only census: every process/filesystem observation is supplied, never a real process.
const censusProcess = (root, patch = {}) => ({pid: 77, start: '101', exe: root + '/runtime/bin/node',
  entry: root + '/bin/faravan-coordinator', ...patch});
const censusResult = (installDir, processes, {beforeProcesses = [], beforeIdentity = '1:10', afterIdentity = '1:20', records = []} = {}) =>
  unmanagedCoordinators({installDir, before: {installIdentity: beforeIdentity, processes: beforeProcesses},
    after: {installIdentity: afterIdentity, processes}, records});

test('unmanaged census identifies only coordinator runtimes in this install family', () => {
  const root = '/opt/faravan';
  for (const suffix of ['.prev', '.next', '.rollback-123']) {
    assert.equal(censusResult(root, [censusProcess(root + suffix)]).length, 1, suffix);
  }
  assert.equal(censusResult(root, [censusProcess(root, {exe: root + '/runtime/bin/node (deleted)'})]).length, 1);
  assert.equal(censusResult(root, [censusProcess(root, {exe: '/usr/bin/node', entry: root + '.prev/bin/faravan-coordinator'})]).length, 1);
  assert.equal(censusResult(root, [censusProcess(root + '-other.prev')]).length, 0);
  assert.equal(censusResult(root, [censusProcess(root + '.previous')]).length, 0);
  assert.equal(censusResult(root, [censusProcess(root + '.rollbackish')]).length, 0);
  assert.equal(censusResult(root, [censusProcess('/unrelated', {exe: '/unrelated/node (deleted)'})]).length, 0);
  assert.equal(censusResult(root, [censusProcess(root, {exe: '/usr/bin/node', entry: root + '.prev/tools/ordinary.mjs'})]).length, 0);
  assert.equal(censusResult(root, [censusProcess(root + '.prev', {entry: root + '.prev/bin/not-a-coordinator'})]).length, 0);
});

test('active path requires a retained process identity and a changed install identity', () => {
  const root = '/opt/faravan', p = censusProcess(root);
  assert.equal(censusResult(root, [p]).length, 0, 'active pathname alone proves nothing');
  assert.equal(censusResult(root, [p], {beforeProcesses: [p]}).length, 1, 'pre-swap process survived replacement');
  assert.equal(censusResult(root, [p], {beforeProcesses: [p], afterIdentity: '1:10'}).length, 0, 'rollback restored the same install');
  assert.equal(censusResult(root, [p], {beforeProcesses: [{...p, start: '99'}]}).length, 0, 'PID reused or coordinator restarted');
  assert.equal(censusResult(root, [p], {beforeProcesses: [p], afterIdentity: null}).length, 0, 'unknown identity is not stale evidence');
});

test('recorded coordinator excluded without a signal, while PID reuse is not excluded', () => {
  const root = '/opt/faravan', p = censusProcess(root + '.prev');
  assert.deepEqual(censusResult(root, [p], {records: [{pid: p.pid, owner: {start: p.start}}]}), []);
  assert.equal(censusResult(root, [p], {records: [{pid: p.pid, owner: {start: 'different'}}]}).length, 1);
  assert.equal(censusResult(root, [p], {records: [{pid: p.pid}]}).length, 1, 'a PID-only record cannot hide a recycled process');
});

test('filesystem snapshot skips other users, vanished PIDs, EACCES and identity races without process calls', async () => {
  let kill = 0, start = 0, service = 0, raced = 0;
  const statText = token => '77 (node) ' + ['S', ...Array(18).fill('0'), token].join(' ');
  const fs = {
    readdir: async () => ['self', '77', '78', '79', '80', '81'],
    stat: async path => path === '/opt/faravan' ? {dev: 1, ino: 10} : {uid: path === '/proc/78' ? 999 : 1000},
    readlink: async path => {
      if (path.startsWith('/proc/79/')) throw Object.assign(new Error('gone'), {code: 'ENOENT'});
      if (path.startsWith('/proc/80/')) throw Object.assign(new Error('denied'), {code: 'EACCES'});
      return '/opt/faravan/runtime/bin/node (deleted)';
    },
    readFile: async path => path.endsWith('/stat') ? statText(path.startsWith('/proc/81/') ? String(++raced) : '101')
      : '/usr/bin/node\0/opt/faravan/bin/faravan-coordinator\0',
    kill: () => { kill++; }, start: () => { start++; }, service: () => { service++; },
  };
  const snapshot = await coordinatorSnapshot({installDir: '/opt/faravan', uid: 1000, platform: 'linux', fs});
  assert.equal(snapshot.installIdentity, '1:10');
  assert.deepEqual(snapshot.processes.map(p => p.pid), [77]);
  assert.deepEqual([kill, start, service], [0, 0, 0]);
  assert.deepEqual(await coordinatorSnapshot({installDir: '/opt/faravan', uid: 1000, platform: 'linux',
    fs: {...fs, readdir: async () => { throw new Error('EACCES'); }}}), {installIdentity: '1:10', processes: []});
});

for (const mode of ['success', 'swap-failure', 'rollback']) test('unmanaged warning is saved once after ' + mode + ' without managing the process', async t => {
  const s = await install(t), logs = [], calls = [];
  const original = new Error('original swap failure');
  let samples = 0;
  const updater = createUpdater({...s, smoke: async () => { if (mode === 'rollback') throw new Error('smoke failed'); },
    census: async () => ({installIdentity: ++samples === 1 ? '1:10' : '1:20',
      processes: [censusProcess(s.installDir + '.prev')]}),
    hosts: {record: async () => null, censusRecords: async () => [],
      stop: async () => calls.push('kill'), start: async () => calls.push('start'), service: async () => calls.push('service')},
    renameSync:(from,to)=>{if(mode==='swap-failure'&&from.endsWith('.next'))throw original;return fsRenameSync(from,to);},
    log: message => logs.push(message),
  });
  if (mode === 'success') await updater.apply({version: '0.2.0'});
  else if (mode === 'swap-failure') await assert.rejects(updater.apply({version: '0.2.0'}), error => error === original);
  else await assert.rejects(updater.apply({version: '0.2.0'}), {code: 'rolled_back'});
  assert.equal(samples, 2);
  assert.deepEqual(calls, []);
  assert.equal(logs.filter(line => line === UNMANAGED_COORDINATOR_WARNING).length, 1);
  assert.deepEqual((await updater.status()).unmanagedCoordinators, [{pid: 77, start: '101'}]);
  assert.equal((await updater.status()).warning, UNMANAGED_COORDINATOR_WARNING);
  assert.equal((await savedState(s)).warning, UNMANAGED_COORDINATOR_WARNING);
});

test('census observation and persistence failures never replace the original update error', async t => {
  const s = await install(t), original = new Error('original swap failure');
  const updater = createUpdater({...s, smoke: async () => {}, census: async () => { throw new Error('EACCES'); },
    renameSync:(from,to)=>{if(from.endsWith('.next'))throw original;return fsRenameSync(from,to);}});
  await assert.rejects(updater.apply({version: '0.2.0'}), error => error === original);
  assert.equal((await updater.status()).warning, null);
});

test('record snapshot suppresses warning without calling the lifecycle record probe', async t => {
  const s = await install(t), logs = [], calls = [];
  const p = censusProcess(s.installDir + '.prev');
  const updater = createUpdater({...s, log: message => logs.push(message), smoke: async () => { throw new Error('bad smoke'); },
    census: async () => ({installIdentity: '1:10', processes: [p]}),
    hosts: {censusRecords: async () => [{pid: p.pid, owner: {start: p.start}}],
      record: async () => calls.push('record'), stop: async () => calls.push('kill'), start: async () => calls.push('start')}});
  await assert.rejects(updater.apply({version: '0.2.0'}), {code: 'rolled_back'});
  assert.deepEqual(calls, []);
  assert.equal((await updater.status()).warning, null);
  assert.equal(logs.includes(UNMANAGED_COORDINATOR_WARNING), false);
});

test('warning survives hosted rollback without changing recovery or its original cause', async t => {
  const s = await install(t), events = [], failure = new Error('new coordinator failed');
  let starts = 0;
  const updater = createUpdater({...s, ...swapSeams(events),
    hosts: hostFake(events, s.installDir, {records: [OWNER_RECORD, null],
      start: () => { if (++starts === 1) throw failure; }}),
    census: async () => ({installIdentity: '1:10', processes: [censusProcess(s.installDir + '.rollback-123')]}),
  });
  await assert.rejects(updater.apply({version: '0.2.0'}), error => error.code === 'rolled_back'
    && error.cause === failure && error.recovery.restarted === true);
  assert.equal(await version(s.installDir), '0.1.0');
  assert.equal(starts, 2, 'only the existing managed restart/rollback sequence runs');
  assert.equal((await savedState(s)).failedVersion, '0.2.0');
  assert.equal((await updater.status()).warning, UNMANAGED_COORDINATOR_WARNING);
});

test('saved hosted snapshot reads records without checking or signalling the PID', async t => {
  const {createHostedCoordinators} = await import('../lib/v1/hosted-coordinators.mjs');
  const fixture = await coordinatorFixture(t);
  const hosts = createHostedCoordinators({home: fixture.home, coordinatorHome: fixture.home, installDir: '/not-used'});
  assert.deepEqual(await hosts.censusRecords(), [{pid: 424242, owner: fixture.owner}]);
  await rm(fixture.status);
  assert.deepEqual(await hosts.censusRecords(), []);
});

test('a clean census clears a previous warning and diagnostic write failures do not mask swap errors', async t => {
  const s = await install(t);
  await mkdir(dirname(s.stateFile), {recursive: true});
  await writeFile(s.stateFile, JSON.stringify({warning: UNMANAGED_COORDINATOR_WARNING, unmanagedCoordinators: [{pid: 77}]}));
  const updater = createUpdater({...s, smoke: async () => {}, census: async () => ({installIdentity: '1:10', processes: []})});
  await updater.apply({version: '0.2.0'});
  assert.equal((await updater.status()).warning, null);
  assert.deepEqual((await updater.status()).unmanagedCoordinators, []);
  const second = await install(t), original = new Error('swap failed');
  await mkdir(second.stateFile, {recursive: true}); // state path is deliberately unwritable as a file
  const failed = createUpdater({...second, smoke: async () => {},
    census: async () => ({installIdentity: '1:10', processes: [censusProcess(second.installDir + '.prev')]}),
    renameSync:(from,to)=>{if(from.endsWith('.next'))throw original;return fsRenameSync(from,to);}});
  await assert.rejects(failed.apply({version: '0.2.0'}), error => error === original);
});

test('manual update prints one plain warning on success and failure; app status retains it', async () => {
  const {createUpdateService} = await import('../lib/v1/update-service.mjs');
  for (const fails of [false, true]) {
    const err = [], out = [];
    const updater = {
      check: async () => ({current: '0.1.0', manifest: {version: '0.2.0'}}),
      stage: async () => {}, apply: async () => { if (fails) throw new Error('failed swap'); },
      tick: async () => fails ? 'failed' : 'applied',
      status: async () => ({warning: UNMANAGED_COORDINATOR_WARNING, unmanagedCoordinators: [{pid: 77, start: '101'}]}),
    };
    assert.equal(await runUpdateCommand([], {updater, appRunning: async () => false,
      stdout: {write: text => out.push(text)}, stderr: {write: text => err.push(text)}}), fails ? 1 : 0);
    assert.equal(err.filter(text => text === UNMANAGED_COORDINATOR_WARNING + '\n').length, 1);
    const app = createUpdateService({updater, now: () => 0});
    await app.tick({});
    assert.equal(app.status().warning, UNMANAGED_COORDINATOR_WARNING);
    assert.equal(app.status().state, fails ? 'failed' : 'applied');
    if (fails) assert.ok(app.status().error, 'the warning does not replace update failure');
  }
});


test('a clean device_busy refusal rolls back and restarts the old host', async t => {
  const s = await install(t), events = [];
  let starts = 0;
  const updater = createUpdater({installDir:s.installDir, stateFile:s.stateFile, ...swapSeams(events),
    hosts:hostFake(events,s.installDir,{records:[OWNER_RECORD,null], start:()=>{
      if (++starts === 1) throw Object.assign(new Error('The device is busy. Start hosting again.'),{code:'device_busy'});
    }})});
  await assert.rejects(updater.apply({version:'0.2.0'}),{code:'rolled_back'});
  assert.deepEqual(events,['smoke staged','record','stop 0.1.0','swap','start 0.2.0','record','restore','start 0.1.0']);
  assert.equal(await version(s.installDir),'0.1.0');
});
