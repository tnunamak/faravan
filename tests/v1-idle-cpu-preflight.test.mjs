import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DockerSbxBackend } from '../lib/docker-backend.mjs';

// Idle availability polls must not respawn sbx every few seconds. Readiness rechecks before a job must.

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const HELP = [
  'Usage: sbx run [flags] AGENT PATH',
  'Flags:',
  '  -d, --detach                    Start the sandbox and print its ID without opening an agent session',
  '      --detach-keys string          Override the detach keys',
  '      --name string',
  '      --kit stringArray',
  '      --cpus',
  '      --memory',
  '      --skills',
  '      --static-mcp',
  '      --deny-network',
].join('\n');

function healthyRunner() {
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push({ command, args });
    if (args.join(' ') === 'run --help') return ok(HELP);
    if (args[0] === 'version') return ok('sbx version: v0.51.0 abc123');
    if (args[0] === 'diagnose') return ok('Daemon healthy\nDocker authentication healthy');
    if (args[0] === 'policy') return ok('Policy rules');
    if (command === 'dpkg-query') return ok('docker-sbx\tinstalled\t0.51.0\ndocker-ce\tinstalled\t28.0.0\ncontainerd.io\tinstalled\t2.1.0\n');
    if (command === 'docker') return ok('28.0.0');
    if (command === 'containerd') return ok('containerd github.com/containerd/containerd v2.1.0');
    return ok();
  };
  return { runCommand, probes: () => calls.filter(call => call.command === 'dpkg-query').length };
}

test('two idle readiness checks inside the TTL run sbx once; the job recheck always runs it', async () => {
  const stub = healthyRunner();
  let now = 0;
  const backend = new DockerSbxBackend({ monotonic: () => now });
  const idle = { cached: true, runCommand: stub.runCommand, platformName: 'linux' };
  assert.equal((await backend.lenderCapabilities(idle)).available, true);
  now = 30000;
  assert.equal((await backend.lenderCapabilities(idle)).available, true);
  assert.equal(stub.probes(), 1);
  assert.equal((await backend.lenderCapabilities({ runCommand: stub.runCommand, platformName: 'linux' })).available, true);
  assert.equal(stub.probes(), 2);
});

test('idle preflight reports fresh versus cached provenance with the original probe time', async () => {
  const stub = healthyRunner();
  let now = 0;
  const backend = new DockerSbxBackend({ monotonic: () => now });
  const idle = { cached: true, runCommand: stub.runCommand, platformName: 'linux' };
  const startedAt = Date.now();
  const fresh = await backend.lenderCapabilities(idle);
  assert.equal(fresh.available, true);
  assert.equal(fresh.preflight.cached, false);
  assert.equal(typeof fresh.preflight.probed_at, 'string');
  assert.ok(Date.parse(fresh.preflight.probed_at) >= startedAt);
  assert.ok(Date.parse(fresh.preflight.probed_at) <= Date.now());
  now = 50000;
  const reused = await backend.lenderCapabilities(idle);
  assert.equal(reused.available, true);
  assert.equal(reused.preflight.cached, true);
  assert.equal(reused.preflight.probed_at, fresh.preflight.probed_at);
  assert.equal(reused.preflight.diagnostics_observed_at, fresh.preflight.diagnostics_observed_at);
  assert.equal(fresh.preflight.cached, false);
  assert.equal(stub.probes(), 1);
  const forced = await backend.lenderCapabilities({ runCommand: stub.runCommand, platformName: 'linux' });
  assert.equal(forced.preflight.cached, false);
  assert.equal(stub.probes(), 2);
});

test('an idle check after the TTL probes again', async () => {
  const stub = healthyRunner();
  let now = 0;
  const backend = new DockerSbxBackend({ monotonic: () => now });
  const idle = { cached: true, runCommand: stub.runCommand, platformName: 'linux' };
  await backend.lenderCapabilities(idle);
  now = 60001;
  await backend.lenderCapabilities(idle);
  assert.equal(stub.probes(), 2);
});

test('a failed probe is never reused, so a broken sbx is seen on the next poll', async () => {
  let versionProbes = 0;
  const failing = async (command, args) => {
    if (command === 'dpkg-query') versionProbes++;
    if (args[0] !== 'version') return ok();
    return { code: 1, stdout: '', stderr: 'sbx: not found' };
  };
  const backend = new DockerSbxBackend({ monotonic: () => 0 });
  const idle = { cached: true, runCommand: failing, platformName: 'linux' };
  assert.equal((await backend.lenderCapabilities(idle)).available, false);
  assert.equal((await backend.lenderCapabilities(idle)).available, false);
  assert.equal(versionProbes, 2);
});

test('a cached preflight is never served across a change of sbx home or runner', async t => {
  const first = healthyRunner(), second = healthyRunner();
  const previous = process.env.FARAVAN_SBX_HOME;
  t.after(() => { if (previous === undefined) delete process.env.FARAVAN_SBX_HOME; else process.env.FARAVAN_SBX_HOME = previous; });
  const backend = new DockerSbxBackend({ monotonic: () => 0 });
  process.env.FARAVAN_SBX_HOME = '/tmp/faravan-idle-cache-a';
  await backend.lenderCapabilities({ cached: true, runCommand: first.runCommand, platformName: 'linux' });
  process.env.FARAVAN_SBX_HOME = '/tmp/faravan-idle-cache-b';
  await backend.lenderCapabilities({ cached: true, runCommand: first.runCommand, platformName: 'linux' });
  assert.equal(first.probes(), 2);
  await backend.lenderCapabilities({ cached: true, runCommand: second.runCommand, platformName: 'linux' });
  assert.equal(second.probes(), 1);
});

test('cached calls with different explicit environments inside the TTL probe twice', async () => {
  const stub = healthyRunner();
  const backend = new DockerSbxBackend({ monotonic: () => 0 });
  const idle = { cached: true, runCommand: stub.runCommand, platformName: 'linux' };
  assert.equal((await backend.lenderCapabilities({ ...idle, env: { HOME: '/tmp/preflight-env-a' } })).available, true);
  assert.equal(stub.probes(), 1);
  assert.equal((await backend.lenderCapabilities({ ...idle, env: { HOME: '/tmp/preflight-env-b' } })).available, true);
  assert.equal(stub.probes(), 2);
});

test('a cached idle success keeps the diagnostic evidence that the app readiness read uses', async () => {
  const stub = healthyRunner();
  const backend = new DockerSbxBackend({ monotonic: () => 0 });
  await backend.lenderCapabilities({ cached: true, runCommand: stub.runCommand, platformName: 'linux' });
  await backend.lenderCapabilities({ cached: true, runCommand: stub.runCommand, platformName: 'linux' });
  const observed = await backend.lenderCapabilities({ observation: true, runCommand: stub.runCommand, platformName: 'linux' });
  assert.equal(observed.preflight.checks.find(check => check.name === 'sbx_diagnostics' && !check.ok), undefined);
  assert.equal(observed.available, true);
});

test('a fresh failure replaces a cached success, so the next idle poll probes again', async () => {
  const stub = healthyRunner();
  let broken = false;
  const runCommand = async (command, args) => broken && args[0] === 'version' ? { code: 1, stdout: '', stderr: 'sbx: not found' } : stub.runCommand(command, args);
  const backend = new DockerSbxBackend({ monotonic: () => 0 });
  const idle = { cached: true, runCommand, platformName: 'linux' };
  assert.equal((await backend.lenderCapabilities(idle)).available, true);
  broken = true;
  assert.equal((await backend.lenderCapabilities({ runCommand, platformName: 'linux' })).available, false);
  assert.equal((await backend.lenderCapabilities(idle)).available, false);
  assert.equal(stub.probes(), 3);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('a failed observation invalidates an idle success inside the TTL', async () => {
  const stub = healthyRunner();
  const observedPolicy = deferred(), observationStarted = deferred();
  let policies = 0, now = 0;
  const missing = { code: 1, stdout: '', stderr: 'sbx: not found' };
  const runCommand = (command, args) => {
    if (args.join(' ') === 'policy ls') {
      policies++;
      if (policies === 2) {
        observationStarted.resolve();
        return observedPolicy.promise;
      }
      if (policies > 2) return Promise.resolve(missing);
    }
    return stub.runCommand(command, args);
  };
  const backend = new DockerSbxBackend({ monotonic: () => now });
  const idle = { cached: true, runCommand, platformName: 'linux' };
  assert.equal((await backend.lenderCapabilities(idle)).available, true);
  now = 10000;
  const observation = backend.lenderCapabilities({ observation: true, runCommand, platformName: 'linux' });
  await observationStarted.promise;
  observedPolicy.resolve(missing);
  assert.equal((await observation).available, false);
  now = 30000;
  assert.equal((await backend.lenderCapabilities(idle)).available, false);
  assert.equal(policies, 3);
  assert.equal(stub.probes(), 3);
});

test('a fresh failure fences every caller of an older in-flight idle probe', async () => {
  const stub = healthyRunner();
  const oldVersion = deferred(), idleStarted = deferred();
  let versions = 0;
  const runCommand = (command, args) => {
    if (args.length === 1 && args[0] === 'version') {
      versions++;
      if (versions === 1) {
        idleStarted.resolve();
        return oldVersion.promise;
      }
      return Promise.resolve({ code: 1, stdout: '', stderr: 'sbx: not found' });
    }
    return stub.runCommand(command, args);
  };
  const backend = new DockerSbxBackend({ monotonic: () => 0 });
  const idle = { cached: true, runCommand, platformName: 'linux' };
  const first = backend.lenderCapabilities(idle);
  await idleStarted.promise;
  const shared = backend.lenderCapabilities(idle);
  assert.equal((await backend.lenderCapabilities({ runCommand, platformName: 'linux' })).available, false);
  oldVersion.resolve(ok('sbx version: v0.51.0 abc123'));
  const reports = await Promise.all([first, shared]);
  assert.equal(reports[0].available, false);
  assert.equal(reports[1].available, false);
  assert.ok(versions >= 3);
  assert.equal(stub.probes(), versions);
});

test('a fresh failure fences an idle result waiting on storage', async () => {
  const stub = healthyRunner();
  const storageStarted = deferred(), releaseStorage = deferred();
  let broken = false, versions = 0;
  const runCommand = (command, args) => {
    if (args.length === 1 && args[0] === 'version') {
      versions++;
      if (broken) return Promise.resolve({ code: 1, stdout: '', stderr: 'sbx: not found' });
    }
    return stub.runCommand(command, args);
  };
  const storage = { available: () => {
    storageStarted.resolve();
    return releaseStorage.promise;
  } };
  const backend = new DockerSbxBackend({ monotonic: () => 0, storage });
  const first = backend.lenderCapabilities({ cached: true, runCommand, platformName: 'linux' });
  await storageStarted.promise;
  broken = true;
  assert.equal((await backend.lenderCapabilities({ runCommand, platformName: 'linux' })).available, false);
  releaseStorage.resolve(true);
  assert.equal((await first).available, false);
  assert.equal(versions, 3);
});

test('failed_unkeyed_bypass_invalidates_prior_idle_success', async () => {
  const stub = healthyRunner();
  let broken = false;
  const runCommand = (command, args) => broken && args[0] === 'version'
    ? Promise.resolve({ code: 1, stdout: '', stderr: 'sbx: not found' })
    : stub.runCommand(command, args);
  const backend = new DockerSbxBackend({ monotonic: () => 0 });
  const idle = { cached: true, runCommand, platformName: 'linux' };
  assert.equal((await backend.lenderCapabilities(idle)).available, true);
  broken = true;
  const failed = await backend.lenderCapabilities({ ...idle, commandTimeoutMs: 15000 });
  assert.equal(failed.available, false);
  assert.equal(failed.preflight.cached, false);
  const next = await backend.lenderCapabilities(idle);
  assert.equal(next.available, false);
  assert.equal(next.preflight.cached, false);
  assert.equal(stub.probes(), 3);
});

test('newer_failure_fences_older_fresh_success', async t => {
  for (const observation of [false, true]) await t.test(observation ? 'observation' : 'fresh', async () => {
    const stub = healthyRunner(), diskStarted = deferred(), releaseDisk = deferred();
    let broken = false, diskReads = 0;
    const runCommand = (command, args) => broken && args[0] === 'version'
      ? Promise.resolve({ code: 1, stdout: '', stderr: 'sbx: not found' })
      : stub.runCommand(command, args);
    const backend = new DockerSbxBackend({ monotonic: () => 0 });
    const options = { runCommand, platformName: 'linux' };
    if (observation) assert.equal((await backend.lenderCapabilities(options)).available, true);
    const healthyDisk = { name: 'host_disk', ok: true, reason: null };
    backend._hostDiskCheck = () => {
      if (++diskReads === 1) { diskStarted.resolve(); return releaseDisk.promise; }
      return Promise.resolve({ ...healthyDisk });
    };
    const older = backend.lenderCapabilities({ ...options, observation });
    await diskStarted.promise;
    broken = true;
    assert.equal((await backend.lenderCapabilities(options)).available, false);
    releaseDisk.resolve({ ...healthyDisk });
    const result = await older;
    assert.equal(result.available, false);
    assert.equal(result.preflight.cached, false);
    assert.equal(diskReads, 3, 'obsolete success must probe again, then return failure without self-retrying');
  });
});

test('newer_disk_failure_fences_older_idle_disk_success', async () => {
  const stub = healthyRunner(), diskStarted = deferred(), releaseDisk = deferred();
  let diskReads = 0;
  const backend = new DockerSbxBackend({ monotonic: () => 0 });
  backend._hostDiskCheck = () => {
    if (++diskReads === 1) { diskStarted.resolve(); return releaseDisk.promise; }
    return Promise.resolve({ name: 'host_disk', ok: false, reason: 'host_disk_low' });
  };
  const options = { runCommand: stub.runCommand, platformName: 'linux' };
  const older = backend.lenderCapabilities({ ...options, cached: true });
  await diskStarted.promise;
  assert.equal((await backend.lenderCapabilities(options)).available, false);
  releaseDisk.resolve({ name: 'host_disk', ok: true, reason: null });
  const result = await older;
  assert.equal(result.available, false);
  assert.equal(result.reason, 'host_disk_low');
  assert.equal(result.preflight.cached, false);
  assert.equal(diskReads, 3, 'the older healthy disk snapshot cannot win over the newer failure');
  assert.equal(stub.probes(), 3);
});
