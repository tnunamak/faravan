import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hostV1, stopV1Host} from '../lib/v1/host.mjs';
import * as intent from '../lib/v1/host-intent.mjs';
import {startApp} from '../lib/v1/app.mjs';
import {syntheticBackend} from './helpers/v1-app-fixture.mjs';

// Bug: an automatic restart (app start, autostart, an update) was planned from host.json, then ran later without
// checking again, so an owner's Stop that ran in between was undone and the host came back.
async function wantedHost(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'spk-host-resume-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const home = join(root, 'app'), coordinator = join(home, 'coordinator');
  await mkdir(coordinator, {recursive: true});
  await writeFile(join(coordinator, 'host.json'), JSON.stringify({schema_version: 1, protocol_version: 1, port: 8787,
    status_path: join(coordinator, 'status.json'), circle_id: 'c1', reachability: {kind: 'url', publicUrl: 'https://circle.example'}, host_wanted: true, ...extra}));
  return {root, home, coordinator, config: join(coordinator, 'host.json')};
}
const ownerStop = home => stopV1Host({home}, {clearIntent: true, sleep: async () => {}, portAnswers: async () => false});
// Every step of a start records here; a refused restart reaches none of them.
function startSeams(steps) {
  const step = name => async () => { steps.push(name); throw new Error('the host started: ' + name); };
  return {openDevice: step('openDevice'), portInUse: step('portInUse'), startServer: step('startServer'), chooseReachability: step('chooseReachability')};
}
// A child sees only these variables, so no FARAVAN_* setting of the machine running the tests reaches it.
const cleanEnv = (f, extra) => ({PATH: process.env.PATH, HOME: f.root, FARAVAN_NO_BROWSER: '1', TZ: 'UTC', ...extra});
// The arguments the app and the updater pass for an automatic restart (none before this fix).
const resumeArgs = config => intent.resumeArgs?.(config) ?? [];
const {resumeWantedHost} = intent;
// `faravan host --resume <generation|initial>`, as bin/faravan reads it.
const resumeFrom = args => args[0] === '--resume' ? {stopGeneration: args[1] === 'initial' ? null : args[1]} : undefined;

test('a restart planned before the owner stopped is refused under the host lock, before anything starts', async t => {
  const f = await wantedHost(t);
  const planned = resumeArgs(JSON.parse(await readFile(f.config, 'utf8')));
  await ownerStop(f.coordinator);
  const before = await readFile(f.config, 'utf8');
  const steps = [];
  await assert.rejects(hostV1({home: f.coordinator, base: f.root, resume: resumeFrom(planned)}, startSeams(steps)), error => error.code === 'host_not_wanted');
  assert.deepEqual(steps, []);
  assert.equal(await readFile(f.config, 'utf8'), before, 'the refused restart changes nothing, so host_wanted stays false');
  const still = await wantedHost(t);
  const startSteps = [];
  await assert.rejects(hostV1({home: still.coordinator, base: still.root, resume: resumeFrom(resumeArgs(JSON.parse(await readFile(still.config, 'utf8'))))}, startSeams(startSteps)),
    /the host started: openDevice/);
  assert.deepEqual(startSteps, ['openDevice'], 'with no stop in between, the restart goes ahead');
});

test('any stop since the restart was planned refuses it, even one that kept the intent (an update)', async t => {
  const f = await wantedHost(t, {stop_generation: 'g0'});
  await stopV1Host({home: f.coordinator}, {sleep: async () => {}, portAnswers: async () => false});
  assert.equal(JSON.parse(await readFile(f.config, 'utf8')).host_wanted, true);
  const steps = [];
  await assert.rejects(hostV1({home: f.coordinator, base: f.root, resume: {stopGeneration: 'g0'}}, startSeams(steps)), error => error.code === 'host_not_wanted');
  assert.deepEqual(steps, []);
});

test('app start that boots before the owner stops, but whose host starts after, leaves hosting stopped', {timeout: 60000}, async t => {
  const f = await wantedHost(t);
  const names = ['FARAVAN_COORDINATOR_HOME', 'FARAVAN_COORDINATOR_HOME'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  t.after(() => { for (const name of names) if (saved[name] !== undefined) process.env[name] = saved[name]; });
  const steps = [];
  let done;
  const outcome = new Promise(resolve => { done = resolve; });
  const app = await startApp({home: f.home, origin: null, port: 0, freshLending: 'off', adapters: [], updater: null, env: {},
    backendFactory: () => syntheticBackend(f.root), fetch: async () => { throw new Error('offline'); },
    startHost: async (ctx, args) => {
      // The restart's own process is slow to start: the owner's Stop runs first.
      await ownerStop(ctx.coordinatorHome);
      try { return await hostV1({home: ctx.coordinatorHome, base: f.root, resume: resumeFrom(args)}, startSeams(steps)); }
      catch (error) { done(error.code); throw error; }
    }});
  try {
    assert.equal(await Promise.race([outcome, new Promise((_, reject) => setTimeout(() => reject(new Error('no restart ran')), 20000).unref())]), 'host_not_wanted');
    assert.deepEqual(steps, []);
    assert.equal(JSON.parse(await readFile(f.config, 'utf8')).host_wanted, false);
  } finally { await app.close(); }
});

test('the app reads a refused restart as "not wanted", not as a failure', async t => {
  const f = await wantedHost(t);
  const result = await resumeWantedHost({coordinatorHome: f.coordinator, processExists: () => false,
    start: async () => { throw Object.assign(new Error('Hosting was stopped by its owner, so it was not started again.'), {code: 'host_not_wanted'}); }});
  assert.deepEqual(result, {resumed: false, reason: 'not_wanted'});
});

test('faravan host --resume refuses with host_not_wanted after the owner stopped, and starts nothing', async t => {
  const f = await wantedHost(t);
  const planned = resumeArgs(JSON.parse(await readFile(f.config, 'utf8')));
  await ownerStop(f.coordinator);
  const result = await new Promise(resolve => execFile(process.execPath, [fileURLToPath(new URL('../bin/faravan', import.meta.url)), 'host', ...planned, '--json'], {
    env: cleanEnv(f, {FARAVAN_COORDINATOR_HOME: f.coordinator, FARAVAN_HOME: f.home}), encoding: 'utf8', timeout: 30000},
  (error, stdout, stderr) => resolve({code: error?.code ?? 0, stdout, stderr})));
  // Before this fix the command had no --resume, so it printed usage and no JSON at all.
  const line = JSON.parse(result.stdout.trim().split('\n').at(-1) || '{}');
  assert.equal(line.type, 'host_error', result.stdout + result.stderr);
  assert.equal(line.code, 'host_not_wanted');
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(await readFile(f.config, 'utf8')).host_wanted, false);
  await assert.rejects(readFile(join(f.coordinator, 'status.json')), {code: 'ENOENT'});
});

test('an update restarts its host only while no stop has run since its own, and an owner stop keeps it stopped', async t => {
  const {createHostedCoordinators} = await import('../lib/v1/hosted-coordinators.mjs');
  const f = await wantedHost(t, {stop_generation: 'g0'});
  // The new install's `faravan host` records its arguments. Like the real one, it refuses a --resume after a stop
  // and otherwise reports a started host.
  const installDir = join(f.root, 'install'), argsFile = join(f.root, 'host-args.json');
  await mkdir(join(installDir, 'bin'), {recursive: true});
  await writeFile(join(installDir, 'bin', 'faravan'), `const fs = require('node:fs'); const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
if (args.includes('--resume')) { console.log(JSON.stringify({type: 'host_error', code: 'host_not_wanted', message: 'stopped by its owner'})); process.exit(1); }
console.log(JSON.stringify({type: 'host_ready', status: 'ready'}));
`);
  const hosts = createHostedCoordinators({home: f.home, coordinatorHome: f.coordinator, installDir});
  // The update's stop (here refused, so it changed nothing) fixes the generation its restart may run at.
  await assert.rejects(hosts.stop({pid: 1, owner: {pid: 1}}));
  await ownerStop(f.coordinator);
  assert.deepEqual(await hosts.start(), {status: 'not_wanted'}, 'the host stays stopped, and that is not an update failure');
  assert.deepEqual(JSON.parse(await readFile(argsFile, 'utf8')), ['host', '--resume', 'g0', '--json']);
});

test('the supervisor does not restart a crashed coordinator after a stop', async t => {
  const {supervisorMayRestart} = await import('../lib/v1/host.mjs');
  assert.equal(typeof supervisorMayRestart, 'function');
  const f = await wantedHost(t, {stop_generation: 'g0'});
  assert.equal(supervisorMayRestart(f.config, 'g0'), true);
  await ownerStop(f.coordinator);
  assert.equal(supervisorMayRestart(f.config, 'g0'), false);
});

// Bug: the supervisor checked the intent, then spawned the coordinator directly. An owner's stop that ran between the
// check and the spawn succeeded, and the restarted coordinator served the circle again.
const coordinatorBin = fileURLToPath(new URL('../bin/faravan-coordinator', import.meta.url));
async function servedHost(t, extra = {}) {
  const f = await wantedHost(t, {port: 0, data_dir: null, v1_origin: 'http://127.0.0.1:9', reachability: {kind: 'url', publicUrl: 'http://127.0.0.1:9'}, stop_generation: 'g0', ...extra});
  const config = JSON.parse(await readFile(f.config, 'utf8'));
  await writeFile(f.config, JSON.stringify({...config, data_dir: join(f.coordinator, 'tasks')}));
  return f;
}
function launchCoordinator(f, env, timeoutMs = 15000) {
  return new Promise(resolve => {
    const child = execFile(process.execPath, [coordinatorBin, '--host-config', f.config], {env: cleanEnv(f, env), encoding: 'utf8'},
      (error, stdout, stderr) => { clearTimeout(timer); resolve({code: error ? (error.code ?? error.signal) : 0, stdout, stderr, timedOut}); });
    let timedOut = false;
    // A coordinator that went on to serve is stopped here, after the timeout shows it did not refuse.
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  });
}

test('a crash restart the supervisor chose before an owner stop does not start the coordinator', {timeout: 60000}, async t => {
  const {supervisorMayRestart = (file, generation) => JSON.parse(readFileSync(file, 'utf8')).stop_generation === generation} = await import('../lib/v1/host.mjs');
  const f = await servedHost(t);
  // 1. The supervisor checks: hosting is wanted at generation g0, so it decides to restart.
  assert.equal(supervisorMayRestart(f.config, 'g0'), true);
  // 2. Before it spawns, the owner's stop runs to completion.
  await ownerStop(f.coordinator);
  // 3. The supervisor spawns the coordinator, with the generation it saw.
  const result = await launchCoordinator(f, {FARAVAN_COORDINATOR_RESTART_GENERATION: 'g0'});
  assert.equal(result.timedOut, false, 'the coordinator went on to serve: ' + result.stdout + result.stderr);
  assert.equal(result.code, 3, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).code, 'host_not_wanted');
  await assert.rejects(readFile(join(f.coordinator, 'status.json')), {code: 'ENOENT'}, 'it never recorded itself as starting');
});

test('a crash restart with no stop since records itself under the host lock, then starts', async t => {
  const host = await import('../lib/v1/host.mjs');
  const {acquireProcessLockSync} = await import('../lib/v1/lock.mjs');
  assert.equal(typeof host.fenceCoordinatorRestart, 'function');
  const f = await servedHost(t);
  const lock = join(f.coordinator, 'host-v1');
  let lockWhileRecording = null;
  const fenced = await host.fenceCoordinatorRestart({configFile: f.config, env: {FARAVAN_COORDINATOR_RESTART_GENERATION: 'g0'},
    // A stop now waits for the lock, then finds this process in the status file and stops it.
    writeStarting: () => { try { acquireProcessLockSync(lock)(); lockWhileRecording = 'free'; } catch (error) { lockWhileRecording = error.code; } }});
  assert.equal(fenced, true);
  assert.equal(lockWhileRecording, 'lock_busy', 'the start is recorded while the host lock is held');
  acquireProcessLockSync(lock)();
  assert.equal(await host.fenceCoordinatorRestart({configFile: f.config, env: {}}), false, 'a first launch, made under hostV1\'s lock, is not fenced');
});

test('only coordinator launches made after hostV1 released the host lock carry the restart generation', async t => {
  const host = await import('../lib/v1/host.mjs');
  const f = await wantedHost(t);
  await rm(f.config);
  let launchState, heldDuringStart;
  const device = {selectCircle: async () => null,
    createCircle: async origin => ({id: 'c1', origin, pinnedRootFingerprint: 'fp', provisioningPath: join(f.root, 'provision.json')})};
  await assert.rejects(hostV1({home: f.coordinator, base: f.root, name: 'Circle', tunnel:'lan'}, {
    networkInterfaces:()=>({lan:[{family:'IPv4',address:'10.23.4.10',internal:false}]}),
    openDevice: async () => device, provision: async () => {}, portInUse: async () => false,
    startServer: async (_config, _paths, state) => { launchState = state; heldDuringStart = state?.holdsLock?.(); throw new Error('stop here'); }}), /stop here/);
  assert.equal(heldDuringStart, true, 'the first launch runs under hostV1\'s lock');
  assert.equal(launchState.holdsLock(), false, 'a later crash restart does not');
  // Every managed launch carries its launch generation; only a launch after the lock is released also carries the restart fence.
  const inherited = {PATH: '/bin', FARAVAN_COORDINATOR_RESTART_GENERATION: 'stale', FARAVAN_COORDINATOR_LAUNCH_GENERATION: 'stale'};
  assert.deepEqual(host.coordinatorLaunchEnv(inherited, {fenced: false, stopGeneration: 'g0'}), {PATH: '/bin', FARAVAN_COORDINATOR_LAUNCH_GENERATION: 'g0'});
  assert.deepEqual(host.coordinatorLaunchEnv(inherited, {fenced: true, stopGeneration: 'g0'}),
    {PATH: '/bin', FARAVAN_COORDINATOR_LAUNCH_GENERATION: 'g0', FARAVAN_COORDINATOR_RESTART_GENERATION: 'g0'});
  assert.deepEqual(host.coordinatorLaunchEnv({}, {fenced: true}),
    {FARAVAN_COORDINATOR_LAUNCH_GENERATION: 'initial', FARAVAN_COORDINATOR_RESTART_GENERATION: 'initial'});
});
