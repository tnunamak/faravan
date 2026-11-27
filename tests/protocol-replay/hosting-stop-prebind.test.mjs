// Home-lock guard and launcher-crash boundary regressions.
// Network stays fake; the gated child case runs the actual coordinator entry before bind.
import '../helpers/no-browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireCoordinatorProcessLock, acquireProcessLockSync, coordinatorProcessLockPath, processLockOwners } from '../../lib/v1/lock.mjs';
import { hostV1, stopV1Host, coordinatorLaunchEnv, RESTART_GENERATION_ENV, LAUNCH_GENERATION_ENV, assertCoordinatorLaunchGeneration, fenceCoordinatorRestart } from '../../lib/v1/host.mjs';

const origin = 'http://10.23.4.10:8787', root = 'sha256:' + 'a'.repeat(64);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('pre-bind live launcher: stop cannot succeed under its lock; failed-start cleanup prevents late bind',
  { timeout: 5000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'hosting-stop-prebind-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const home = join(dir, 'coordinator');
    await mkdir(home, { recursive: true, mode: 0o700 });
    const configPath = join(home, 'host.json');
    await writeFile(configPath, JSON.stringify({
      schema_version: 1, protocol_version: 1, port: 8787,
      status_path: join(home, 'status.json'), data_dir: join(home, 'data'),
      circle_id: 'c1', circle_ids: ['c1'], root_fingerprint: root,
      v1_origin: origin, reachability:{kind:'lan',publicUrl:origin}, host_wanted: true,
    }));
    const readConfig = async () => JSON.parse(await readFile(configPath, 'utf8'));
    const parked = deferred(), failStartup = deferred();
    let launchState, stopped = false, serving = false, stopCalls = 0, probes = 0, publishes = 0;
    const child = {
      async stop() { stopCalls++; stopped = true; serving = false; },
      releaseBind() { if (!stopped) serving = true; },
    };
    const failure = new Error('controlled pre-bind readiness failure');
    // 1. hostV1 holds host-v1 at lib/v1/host.mjs:148. Its initial launch at
    // :235 is unfenced (bin/faravan:321-324), but waitReady at :238 still holds
    // that lock. No status has been written and this fake child has not bound.
    const launched = hostV1({ home }, {
      openDevice: async () => ({
        selectCircle: () => ({ id: 'c1', origin, pinnedRootFingerprint: root }),
        publishRoster: async () => { publishes++; },
        createInviteLinks: async () => ({ short: 'invite' }),
      }),
      provision:async()=>{},portInUse:async()=>false,
      networkInterfaces:()=>({lan:[{family:'IPv4',address:'10.23.4.10',internal:false}]}),
      startServer: async (_config, _paths, state) => { launchState = state; return child; },
      waitReady: async () => { parked.resolve(); await failStartup.promise; throw failure; },
    });
    // Attach the rejection handler now, including on assertion-failure cleanup.
    const outcome = launched.then(value => ({ value }), error => ({ error }));
    const ownerStop = () => stopV1Host({ home }, {
      clearIntent: true, processExists: () => false, sleep: async () => {},
      portAnswers: async () => { probes++; return serving; },
      portListeners: async () => [], networkInterfaces: () => ({}),
    });
    try {
      await parked.promise;
      assert.equal(launchState.holdsLock(), true);
      assert.equal(coordinatorLaunchEnv({}, {
        fenced: !launchState.holdsLock(), stopGeneration: undefined,
      })[RESTART_GENERATION_ENV], undefined);
      // 2. The real stop path must acquire the SAME lock at host.mjs:348,
      // before saving intent/generation at :363. Do not remove/fake that lock.
      await assert.rejects(ownerStop(), 'stop must not report success under the live launch lock');
      assert.equal(probes, 0, 'stop must not reach port verification while launch owns the lock');
      assert.equal((await readConfig()).host_wanted, true);
      assert.equal((await readConfig()).stop_generation, undefined);
      assert.equal(stopCalls, 0);
      assert.equal(serving, false);
      // 3. A NORMAL launch failure cleans its owned handle at :258 BEFORE
      // releasing the lock at :264. This is deliberately NOT launcher death.
      failStartup.resolve();
      assert.equal((await outcome).error, failure);
      assert.equal(failure.cleanupVerified, true);
      assert.equal(stopCalls, 1);
      assert.equal(launchState.holdsLock(), false);
      assert.equal(publishes, 0);
      // 4. Only now can stop succeed (:363, :368-387, :409-410).
      await ownerStop();
      const saved = await readConfig();
      assert.equal(saved.host_wanted, false);
      assert.equal(typeof saved.stop_generation, 'string');
      assert.ok(probes > 0);
      // 5. Releasing the pre-bind child cannot resurrect the stopped seam.
      child.releaseBind();
      assert.equal(serving, false, 'no owned coordinator serves after successful stop');
    } finally {
      failStartup.resolve();
      await outcome;
    }
  });

// Launcher death is represented by an already-free host-v1 gate and a surviving
// coordinator's real lifetime gate. Its process identity and exit are controlled
// seams, not a real process kill or a wall-clock wait.
test('crashed launcher: stop finds and verifies a locked child before status or bind', async t => {
  const home = await mkdtemp(join(tmpdir(), 'hosting-stop-orphan-'));
  let release;
  t.after(async () => { release?.(); await rm(home, {recursive:true, force:true}); });
  const configPath = join(home, 'host.json');
  await writeFile(configPath, JSON.stringify({schema_version:1, protocol_version:1,
    port:8787, status_path:join(home, 'status.json'), host_wanted:true}));
  release = acquireCoordinatorProcessLock(home);
  let alive = true, signalled = 0, serving = false;
  const identityOptions = {platform:'linux',
    readlink:file => file.endsWith('/exe') ? process.execPath : 'pid:[test]',
    readFile:file => file.endsWith('/cmdline')
      ? [process.execPath, fileURLToPath(new URL('../../bin/faravan-coordinator', import.meta.url)), '--host-config', configPath].join('\0') + '\0'
      : file.endsWith('/boot_id') ? 'test-boot' : process.pid + ' (node) ' + ['S', ...Array(18).fill('0'), '42'].join(' '),
    probe:() => { if (!alive) throw Object.assign(new Error(), {code:'ESRCH'}); }};
  await stopV1Host({home}, {clearIntent:true, identityOptions,
    signal:(pid, signal) => {
      assert.equal(pid, process.pid); assert.equal(signal, 'SIGTERM');
      signalled++; alive = false; release();
    },
    sleep:async () => assert.fail('exit is deterministic'),
    portAnswers:async () => serving, portListeners:async () => [], networkInterfaces:() => ({})});
  assert.equal(signalled, 1);
  assert.equal(alive, false);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).host_wanted, false);
  if (alive) serving = true; // releasing the delayed bind cannot revive the child
  assert.equal(serving, false);
});

test('stop between child spawn and lock registration prevents the actual child from binding', {timeout:10000}, async t => {
  const home = await mkdtemp(join(tmpdir(), 'hosting-stop-before-lock-'));
  let child, closed;
  t.after(async () => {
    if (child?.exitCode === null) child.kill();
    if (closed) await closed;
    await rm(home, {recursive:true, force:true});
  });
  const configPath = join(home, 'host.json'), statusPath = join(home, 'status.json');
  await writeFile(configPath, JSON.stringify({schema_version:1, protocol_version:1,
    port:0, status_path:statusPath, host_wanted:true}));
  const guard = join(home, 'before-lock.cjs'), bound = join(home, 'bound');
  // Preload stops before the entry's imports/lock. Stdin, not elapsed time,
  // releases it only after the owner's stop has finished.
  await writeFile(guard, `
    const fs = require('node:fs');
    fs.writeSync(1, 'before-lock\\n');
    fs.readSync(0, Buffer.alloc(1), 0, 1, null);
    require('node:net').Server.prototype.listen = function () {
      fs.writeFileSync(${JSON.stringify(bound)}, 'bound');
      throw new Error('unexpected bind');
    };
  `);
  const env = coordinatorLaunchEnv({...process.env,
    NODE_OPTIONS:(process.env.NODE_OPTIONS ?? '') + ' --require ' + JSON.stringify(guard)},
    {fenced:false, stopGeneration:undefined});
  assert.equal(env[LAUNCH_GENERATION_ENV], 'initial');
  child = spawn(process.execPath,
    [fileURLToPath(new URL('../../bin/faravan-coordinator', import.meta.url)), '--host-config', configPath],
    {env, stdio:['pipe','pipe','pipe']});
  let stdout = '', stderr = '';
  child.stdin.on('error', () => {});
  child.stderr.on('data', chunk => { stderr += chunk; });
  closed = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', resolve);
  });
  closed.catch(() => {});
  await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('before-lock\n')) resolve(); });
    child.once('error', reject);
    child.once('exit', () => reject(new Error('child exited before the gate: ' + stderr)));
  });
  assert.deepEqual(processLockOwners(coordinatorProcessLockPath(home)), []);
  await stopV1Host({home}, {clearIntent:true, portAnswers:async () => false, portListeners:async () => []});
  assert.equal(existsSync(statusPath), false);
  child.stdin.end('x');
  assert.equal(await closed, 3, stderr);
  const refusal = stdout.trim().split('\n').filter(line => line !== 'before-lock').map(line => JSON.parse(line));
  assert.equal(refusal.length, 1, stderr);
  assert.equal(refusal[0].code, 'host_not_wanted');
  assert.equal(existsSync(bound), false);
  assert.equal(existsSync(statusPath), false);
});

test('an explicit initial start after a prior stop checks its snapshot without waiting on the parent gate', async t => {
  const home = await mkdtemp(join(tmpdir(), 'hosting-current-generation-'));
  let releaseHost, releaseCoordinator;
  t.after(async () => { releaseCoordinator?.(); releaseHost?.(); await rm(home, {recursive:true, force:true}); });
  const configPath = join(home, 'host.json');
  await writeFile(configPath, JSON.stringify({protocol_version:1, host_wanted:false, stop_generation:'earlier-stop'}));
  releaseHost = acquireProcessLockSync(join(home, 'host-v1'));
  releaseCoordinator = acquireCoordinatorProcessLock(home);
  const inherited = {[RESTART_GENERATION_ENV]:'old', [LAUNCH_GENERATION_ENV]:'old'};
  const env = coordinatorLaunchEnv(inherited, {fenced:false, stopGeneration:'earlier-stop'});
  assert.equal(env[RESTART_GENERATION_ENV], undefined);
  assert.equal(env[LAUNCH_GENERATION_ENV], 'earlier-stop');
  assert.doesNotThrow(() => assertCoordinatorLaunchGeneration(configPath, env));
  assert.equal(await fenceCoordinatorRestart({configFile:configPath, env, lockTimeoutMs:0}), false);
  const restart = coordinatorLaunchEnv(env, {fenced:true, stopGeneration:'earlier-stop'});
  assert.equal(restart[RESTART_GENERATION_ENV], 'earlier-stop');
  assert.equal(restart[LAUNCH_GENERATION_ENV], 'earlier-stop');
});
