import './helpers/no-browser.mjs';
import {legacySandboxNameFor as testSandboxName} from '../lib/sandbox-name.mjs';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DockerSbxBackend } from '../lib/docker-backend.mjs';
import {withCleanCredentialScope} from './helpers/sbx-clean-scope.mjs';
import { writeCreateReceipt, fileSbx, testSbxRuntimeFields } from './helpers/sandbox-receipt-fixture.mjs';
import { buildValidatedJobSpec, runJob, resolveHarness } from '../lib/executor.mjs';
import { isGitCandidateScript } from '../lib/git-candidate.mjs';
import { CHECK_SKIPPED } from '../lib/protocol/verification.mjs';
import { CHECK_REMOVAL_RESERVE_MS, CHECK_STOP_MS } from '../lib/docker-backend.mjs';

// P9 fresh checks: the check runs in a NEW sandbox built from the returned source only.
// The emulator gives each sandbox its own workspace and its own tool directory (on PATH),
// and runs every guest command with the real shell, git and tar, so the backend's own
// inventory and verify command strings are exercised against real files.

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
// The image's own test runner. An agent can overwrite its sandbox copy; a fresh sandbox has this one again.
const PRISTINE_NPM = '#!/bin/sh\nif sh ./check_test.sh; then echo "# pass 1"; echo "# fail 0"; else echo "# pass 0"; echo "# fail 1"; exit 1; fi\n';
const BASELINE = {
  'src.sh': 'answer() { echo 41; }\n',
  'check_test.sh': '. ./src.sh\n[ "$(answer)" = 42 ]\n',
  '.gitignore': 'local.config\n',
};

function emulator(t, { agentCleanup = true, onVerify } = {}) {
  const events = [], sandboxes = [], checkOptions = [];
  let mono = 0;
  async function boot(name, entrypoint) {
    const root = await mkdtemp(join(tmpdir(), 'p9-fresh-' + name + '-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'ws')); await mkdir(join(root, 'bin'));
    await writeFile(join(root, 'bin', 'npm'), PRISTINE_NPM, { mode: 0o755 });
    const handle = {...testSbxRuntimeFields(), sandbox_id: name, job_id: name, scratch_dir: join(root, 'ws'), _root: root, _entrypoint: entrypoint,
      _deadline: { endsAt: Infinity }, _execution: {} };
    sandboxes.push(handle);
    return handle;
  }
  const sh = (handle, command) => {
    if (handle.destroyed) throw new Error('command after destroy in ' + handle.sandbox_id);
    const r = spawnSync('sh', ['-c', command], { cwd: handle.scratch_dir, encoding: 'utf8',
      env: { ...process.env, ...GIT_ENV, PATH: join(handle._root, 'bin') + ':' + process.env.PATH, SANDBOX_BIN: join(handle._root, 'bin') } });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const backend = {
    ensureGuestRuntime:async()=>({node:process.execPath,sha256:(await import('node:crypto')).createHash('sha256').update(readFileSync(process.execPath)).digest('hex')}),
    monotonic: () => 0,
    deadlineTimers: { setTimeout, clearTimeout },
    admitJob: async () => ({ ok: true }),
    probeCapabilities: async () => ({ available: true }),
    async prepare(spec) { events.push('prepare:agent'); return boot('agent', spec.entrypoint); },
    async prepareCheck(agent, options) {
      events.push('prepare:check');
      checkOptions.push(options);
      assert.equal(agent.destroyed, true, 'the agent sandbox is gone before a check sandbox exists');
      return boot('check', 'true');
    },
    async start(handle) {
      const kind = isGitCandidateScript(handle._entrypoint) ? 'script' : handle._entrypoint.startsWith('mkdir -p .wf-result') ? 'pack' : 'agent';
      events.push('start:' + handle.sandbox_id + ':' + kind);
      const r = sh(handle, handle._entrypoint);
      if (r.code !== 0) throw Object.assign(new Error('exec failed: ' + r.stderr), { code: 'entrypoint_start_failed' });
      handle._lastExecStdout = r.stdout;
    },
    async _runJobCommand(handle, args) { return sh(handle, args.at(-1)); },
    async verificationFiles(handle, workdir) {
      events.push('inventory:' + handle.sandbox_id);
      return DockerSbxBackend.prototype.verificationFiles.call(this, handle, workdir);
    },
    async verify(handle, options) {
      events.push('checks:' + handle.sandbox_id);
      onVerify?.(handle);
      const observed = await DockerSbxBackend.prototype.verify.call(this, handle, options);
      mono += 1234;
      return observed;
    },
    async collectDeclaredOutputs(handle, manifest) {
      events.push('collect:' + handle.sandbox_id);
      return manifest.map(path => ({ path, bytes_content: readFileSync(join(handle.scratch_dir, path)) }));
    },
    async cancel(handle) { events.push('cancel:' + handle.sandbox_id); },
    async destroy(handle) {
      events.push('destroy:' + handle.sandbox_id);
      handle.destroyed = true;
      const removed = handle.sandbox_id === 'agent' ? agentCleanup : true;
      return { sandbox_id: handle.sandbox_id, removed, scratch_removed: true };
    },
  };
  return { backend, events, sandboxes, checkOptions, durationNow: () => mono };
}

const materialize = async scratch => {
  for (const [name, content] of Object.entries(BASELINE)) await writeFile(join(scratch, name), content);
};
const job = agentScript => buildValidatedJobSpec({ taskDigest: 'f'.repeat(64), harness: resolveHarness('codex'),
  entrypointWithPrompt: agentScript, verify: { cmd: 'npm test' } });

// Fixes nothing, and makes its own sandbox's test runner always pass.
const CHEATING_AGENT = 'printf "#!/bin/sh\\necho \\"# pass 1\\"; echo \\"# fail 0\\"\\n" > "$SANDBOX_BIN/npm"';
// Fixes the source, edits the test, and leaves an untracked ignored config behind.
const FIXING_AGENT = [
  'printf "answer() { echo 42; }\\n" > src.sh',
  'printf ". ./src.sh\\n[ \\"\\$(answer)\\" = 42 ] && [ ! -e local.config ]\\n" > check_test.sh',
  'echo private > local.config',
].join(' && ');

for (const gitDiff of [true, false]) {
  test('P9 a tampered tool outside the returned source cannot make a failing check pass, gitDiff=' + gitDiff, async t => {
    const e = emulator(t);
    const result = await runJob({ jobSpec: job(CHEATING_AGENT), backend: e.backend, materializeSource: materialize, gitDiff, durationNow: e.durationNow });
    assert.equal(result.candidate.format, gitDiff ? 'diff' : 'tree');
    assert.equal(result.checks[0].exit, 1, 'the pristine runner in the fresh sandbox sees the unfixed source');
    assert.equal(result.checks[0].summary, '0 passed, 1 failed');
    assert.equal(result.checks[0].observed_by, 'sandbox');
    assert.deepEqual(result.checks[0].changed_test_files, []);
  });

  test('P9 checks run on the returned source in a new sandbox after the agent sandbox is removed, gitDiff=' + gitDiff, async t => {
    let seen;
    const e = emulator(t, { onVerify: h => { seen = {
      src: readFileSync(join(h.scratch_dir, 'src.sh'), 'utf8'),
      local: existsSync(join(h.scratch_dir, 'local.config')),
      leftovers: spawnSync('sh', ['-c', 'ls -A | grep "^\\.wf-check" || true'], { cwd: h.scratch_dir, encoding: 'utf8' }).stdout,
    }; } });
    const result = await runJob({ jobSpec: job(FIXING_AGENT), backend: e.backend, materializeSource: materialize, gitDiff, durationNow: e.durationNow });
    const agentEvents = e.events.slice(0, e.events.indexOf('destroy:agent') + 1);
    assert.deepEqual(agentEvents.filter(x => !x.startsWith('start:agent:script')),
      ['prepare:agent', 'inventory:agent', 'start:agent:agent', ...(gitDiff ? [] : ['start:agent:pack']), 'collect:agent', 'destroy:agent']);
    const checkEvents = e.events.slice(agentEvents.length);
    assert.equal(checkEvents[0], 'prepare:check');
    assert.deepEqual(checkEvents.slice(-3), ['inventory:check', 'checks:check', 'destroy:check']);
    assert.ok(!checkEvents.some(x => x === 'start:check:agent'), 'no agent command runs in the check sandbox');
    assert.equal(seen.src, 'answer() { echo 42; }\n');
    // A diff never carries an untracked ignored file; a tree carries the whole returned workspace.
    assert.equal(seen.local, !gitDiff);
    assert.equal(seen.leftovers, '', 'the candidate bytes are removed before the check runs');
    assert.equal(result.checks[0].exit, gitDiff ? 0 : 1);
    assert.deepEqual(result.checks[0].changed_test_files, gitDiff ? ['check_test.sh'] : ['check_test.sh', 'local.config']);
    assert.equal(result.cleanupReceipt.removed, true);
    assert.equal(result.cleanupReceipt.check_cleanup.sandbox_id, 'check');
    assert.ok(e.sandboxes.every(h => h.destroyed));
  });
}

test('P9 changed test and config files are disclosed from what the check actually ran on', async t => {
  const e = emulator(t);
  const agent = 'printf "{}\\n" > package.json && mkdir -p tests && echo x > tests/new.test.sh && rm check_test.sh && echo y > notes.txt';
  const result = await runJob({ jobSpec: job(agent), backend: e.backend, materializeSource: materialize, gitDiff: true });
  assert.deepEqual(result.checks[0].changed_test_files, ['check_test.sh', 'package.json', 'tests/new.test.sh']);
});

test('P9 check timing: monotonic duration around the check and the timeout the backend enforced; the receipt times the agent only', async t => {
  const e = emulator(t);
  const result = await runJob({ jobSpec: job('true'), backend: e.backend, materializeSource: materialize, gitDiff: true, durationNow: e.durationNow });
  assert.equal(result.checks[0].duration_ms, 1234);
  assert.equal(result.checks[0].timeout_ms, 180000);
  assert.equal(result.execution.duration_ms, 0, 'the 1234 ms of checks are not agent execution time');
  assert.ok(Date.parse(result.execution.finished_at) >= Date.parse(result.execution.started_at));
});

test('P9 unknown check timing stays absent', async t => {
  const e = emulator(t);
  const real = e.backend.verify;
  for (const timeout of [undefined, -1, 1.5, '180000', Number.MAX_SAFE_INTEGER + 1]) {
    e.backend.verify = async (h, o) => { const observed = await real.call(e.backend, h, o); if (timeout === undefined) delete observed.timeout_ms; else observed.timeout_ms = timeout; return observed; };
    const result = await runJob({ jobSpec: job('true'), backend: e.backend, materializeSource: materialize, gitDiff: true });
    assert.equal('duration_ms' in result.checks[0], false, 'no monotonic clock, no duration');
    assert.equal('timeout_ms' in result.checks[0], false, 'no valid enforced timeout, no timeout: ' + timeout);
  }
  e.backend.verify = async (h, o) => ({ ...await real.call(e.backend, h, o), timeout_ms: 0 });
  const zero = await runJob({ jobSpec: job('true'), backend: e.backend, materializeSource: materialize, gitDiff: true });
  assert.equal(zero.checks[0].timeout_ms, 0);
});

const skippedCheck = skipped => ({ cmd: 'npm test', exit: null, timed_out: false, parser: null, summary: '', skipped, changed_test_files: [], observed_by: 'sandbox' });

test('P9 a baseline that does not match the agent base keeps the work and skips the check with fixed words', async t => {
  const e = emulator(t);
  let calls = 0;
  const drifting = async scratch => { await materialize(scratch); if (calls++) await writeFile(join(scratch, 'src.sh'), 'answer() { echo 42; }\n'); };
  const result = await runJob({ jobSpec: job('true'), backend: e.backend, materializeSource: drifting, gitDiff: true, durationNow: e.durationNow });
  assert.deepEqual(result.checks, [skippedCheck(CHECK_SKIPPED.source)]);
  assert.equal(result.candidate.format, 'diff');
  assert.equal(result.cleanupReceipt.removed, true);
  assert.ok(!e.events.includes('checks:check'));
  assert.ok(e.sandboxes.every(h => h.destroyed));
});

test('P9 a returned patch that will not apply skips the check without leaking the raw error', async t => {
  const e = emulator(t);
  const collect = e.backend.collectDeclaredOutputs;
  e.backend.collectDeclaredOutputs = async (h, manifest) => (await collect(h, manifest)).map(file => ({ ...file, bytes_content: Buffer.from('diff --git a/x b/x\nSECRET-RAW-ERROR\n') }));
  const result = await runJob({ jobSpec: job('echo changed > src.sh'), backend: e.backend, materializeSource: materialize, gitDiff: true });
  assert.deepEqual(result.checks, [skippedCheck(CHECK_SKIPPED.source)]);
  assert.doesNotMatch(JSON.stringify(result.checks), /SECRET|patch|error/i);
  assert.ok(e.sandboxes.every(h => h.destroyed));
});

for (const [name, error, skipped] of [
  ['cannot start', Object.assign(new Error('raw boot output'), { code: 'sandbox_ready_timeout', cleanup_receipt: { removed: true } }), CHECK_SKIPPED.workspace],
  ['has no time left', Object.assign(new Error('raw deadline'), { code: 'wall_timeout' }), CHECK_SKIPPED.time],
])
test('P9 a check sandbox that ' + name + ' keeps the work and says why no check ran', async t => {
  const e = emulator(t);
  e.backend.prepareCheck = async () => { throw error; };
  const result = await runJob({ jobSpec: job('true'), backend: e.backend, materializeSource: materialize, gitDiff: true, durationNow: e.durationNow });
  assert.deepEqual(result.checks, [skippedCheck(skipped)]);
  assert.equal(result.cleanupReceipt.removed, true);
});

test('P9 a check sandbox whose failed prepare could not remove it makes the cleanup unverified', async t => {
  const e = emulator(t);
  e.backend.prepareCheck = async () => { throw Object.assign(new Error('boot'), { code: 'sandbox_ready_timeout', cleanup_receipt: { removed: false } }); };
  const result = await runJob({ jobSpec: job('true'), backend: e.backend, materializeSource: materialize, gitDiff: true });
  assert.equal(result.checks[0].skipped, CHECK_SKIPPED.workspace);
  assert.equal(result.cleanupReceipt.removed, false);
});

test('P9 no time left for the command is a skipped check, not a timed-out one, with no timing', async t => {
  const e = emulator(t);
  e.backend.monotonic = () => 1000;
  const prepareCheck = e.backend.prepareCheck;
  e.backend.prepareCheck = async agent => { const h = await prepareCheck(agent); h._deadline = { endsAt: 1500 }; return h; };
  const result = await runJob({ jobSpec: job('true'), backend: e.backend, materializeSource: materialize, gitDiff: true, durationNow: e.durationNow });
  assert.equal(result.checks[0].skipped, CHECK_SKIPPED.time);
  assert.equal(result.checks[0].timed_out, false);
  assert.equal('duration_ms' in result.checks[0], false);
  assert.equal('timeout_ms' in result.checks[0], false);
});

test('P9 unverified agent cleanup never opens a check sandbox', async t => {
  const e = emulator(t, { agentCleanup: false });
  await assert.rejects(runJob({ jobSpec: job('true'), backend: e.backend, materializeSource: materialize, gitDiff: true }),
    error => { assert.equal(error.code, 'cessation_unverified'); assert.equal(error.cleanupReceipt.removed, false); return true; });
  assert.ok(!e.events.includes('prepare:check'));
});

test('P9 cancellation during checks stops and removes the check sandbox', async t => {
  const controller = new AbortController();
  const e = emulator(t, { onVerify: () => controller.abort(Object.assign(new Error('cancelled'), { code: 'cancelled' })) });
  await assert.rejects(runJob({ jobSpec: job('true'), backend: e.backend, materializeSource: materialize, gitDiff: true, signal: controller.signal }),
    error => { assert.equal(error.code, 'cancelled'); assert.equal(error.cleanupReceipt.removed, true); return true; });
  assert.ok(e.events.includes('cancel:check'));
  assert.equal(e.events.filter(x => x === 'destroy:check').length, 1);
  assert.equal(e.events.filter(x => x === 'destroy:agent').length, 1);
});

test('P9 cancellation while the check sandbox is being prepared still removes it', async t => {
  const controller = new AbortController();
  const e = emulator(t);
  const prepareCheck = e.backend.prepareCheck;
  e.backend.prepareCheck = async agent => { const h = await prepareCheck(agent); controller.abort(Object.assign(new Error('cancelled'), { code: 'cancelled' })); return h; };
  await assert.rejects(runJob({ jobSpec: job('true'), backend: e.backend, materializeSource: materialize, gitDiff: true, signal: controller.signal }), { code: 'cancelled' });
  assert.ok(e.events.includes('destroy:check'));
  assert.ok(!e.events.includes('checks:check'));
});

test('P9 a backend without a fresh check sandbox cannot accept checks', async () => {
  const backend = { verify: async () => ({}), verificationFiles: async () => '', prepare: () => assert.fail('must decline before preparing') };
  await assert.rejects(runJob({ jobSpec: job('true'), backend }), { code: 'policy_unenforceable' });
});

test('P9 a filtered pinned Git tree is checked inside the repository without cloning history again', async t => {
  const { makeRepo, git } = await import('./helpers/git-guest.mjs');
  const repo = await makeRepo(BASELINE);
  t.after(() => rm(repo.dir, { recursive: true, force: true }));
  const e = emulator(t);
  const clones = [];
  const prepareCheck = e.backend.prepareCheck, opened = [];
  e.backend.prepareCheck = async (agent, options) => { opened.push(options); return prepareCheck(agent); };
  e.backend.cloneGitSource = async (handle, source) => {
    clones.push(handle.sandbox_id);
    assert.equal(source.commit, repo.commit);
    git(handle.scratch_dir, 'clone', '-q', repo.dir, 'repo');
    git(join(handle.scratch_dir, 'repo'), 'checkout', '-q', '--detach', source.commit);
  };
  const result = await runJob({ jobSpec: job('cd repo && printf "answer() { echo 42; }\\n" > src.sh'), backend: e.backend, gitDiff: true,
    cloneGitSource: { kind: 'git', url: 'https://example.test/repo.git', commit: repo.commit } });
  assert.deepEqual(clones, ['agent']);
  assert.deepEqual(opened, [{ cloneSource: false }]);
  // A tree candidate of the same Git job is the whole returned workspace: no clone, so no GitHub window.
  clones.length = 0; opened.length = 0;
  const tree = await runJob({ jobSpec: job('cd repo && printf "answer() { echo 42; }\\n" > src.sh'), backend: e.backend, gitDiff: false,
    cloneGitSource: { kind: 'git', url: 'https://example.test/repo.git', commit: repo.commit } });
  assert.deepEqual(clones, ['agent']);
  assert.deepEqual(opened, [{ cloneSource: false }]);
  assert.equal(tree.checks[0].exit, 0);
  assert.equal(result.candidate.format, 'tree');
  assert.equal(result.checks[0].exit, 0);
});

test('P9 an unverified check sandbox removal makes the whole cleanup unverified', async t => {
  const e = emulator(t);
  const destroy = e.backend.destroy;
  e.backend.destroy = async h => ({ ...await destroy(h), removed: h.sandbox_id !== 'check' });
  const result = await runJob({ jobSpec: job('true'), backend: e.backend, materializeSource: materialize, gitDiff: true });
  assert.equal(result.cleanupReceipt.removed, false);
  assert.equal(result.cleanupReceipt.check_cleanup.removed, false);
});

// --- DockerSbxBackend ---------------------------------------------------------

function manualTimers() {
  const pending = new Set();
  return {
    pending,
    setTimeout(callback, milliseconds) { const timer = { callback, milliseconds, unref() {} }; pending.add(timer); return timer; },
    clearTimeout(timer) { pending.delete(timer); },
  };
}

test('P9 backend check sandbox: same image, limits and network as the agent, no GitHub kit, own name', async () => {
  const backend = new DockerSbxBackend();
  const prepared = [];
  backend.monotonic = () => 0;
  backend.prepare = async (spec, deadline, options) => { prepared.push([spec, deadline, options]); return { sandbox_id: 'x' }; };
  const deadline = { endsAt: 600000 };
  const agent = {...testSbxRuntimeFields(), job_id: 'job-1', sandbox_id: 'wf-agent', _image: 'codex', _resources: { cpu: 2, memory_mib: 4096, wall_seconds: 600 },
    _egress: 'provider+registries', _providerHosts: ['**.openai.com'], _registryHosts: ['registry.npmjs.org'],
    _sourceHosts: ['github.com', 'codeload.github.com'], _deadline: deadline };
  await backend.prepareCheck(agent, { cloneSource: true });
  await backend.prepareCheck(agent);
  const [[spec, own, options], [treeSpec]] = prepared;
  assert.equal(treeSpec.source_hosts, undefined, 'no clone, no GitHub window left open during the check');
  assert.equal(own.endsAt, 600000 - CHECK_REMOVAL_RESERVE_MS, 'the check ends before the job deadline, with time to remove it');
  assert.deepEqual(options, { sbxRuntime:agent._sbxRuntime,githubKit: false });
  assert.equal(spec.job_id, 'job-1-check');
  assert.equal(spec.image, 'codex');
  assert.equal(spec.entrypoint, 'true');
  assert.deepEqual(spec.resources, agent._resources);
  assert.equal(spec.egress, 'provider+registries');
  assert.deepEqual(spec.provider_hosts, ['**.openai.com']);
  assert.deepEqual(spec.registries, ['npm']);
  assert.deepEqual(spec.source_hosts, ['github.com', 'codeload.github.com']);
  assert.equal(spec.github_access_required, undefined);
  assert.deepEqual(spec.inputs, []);
});

test('P9 backend check sandbox arms its own timer for the remaining job time, less the removal reserve', async () => {
  let clock = 0;
  const timers = manualTimers();
  const backend = new DockerSbxBackend({ deadlineTimers: timers, monotonic: () => clock,
    runCommand: async args => args[0] === 'secret' ? { code:0, stdout:'{"secrets":[],"custom_secrets":[],"shadowed_services":[],"env_only_count":0}' } : args[0] === 'settings' ? { code:0, stdout:args[1] === 'get' && args[2] === 'ssh.agentForwardingEnabled' ? 'false' : '' } : args[0] === 'ls' ? { code: 0, stdout: '[]', stderr: '' } : { code: 1, stdout: '', stderr: 'stub' } });
  backend._resolveCompute = async () => ({ removed: true });
  const deadline = { controller: new AbortController(), expired: false, cleanup: null, handles: new Set(), endsAt: 600000 };
  const agent = {...testSbxRuntimeFields(), job_id: 'job-2', sandbox_id: 'a', scratch_dir: join(tmpdir(), 'p9-missing-' + process.pid), _deadline: deadline,
    _executionScope: 'owner' };
  deadline.handles.add(agent);
  deadline.timer = timers.setTimeout(() => {}, 600000);
  await backend.destroy(agent);
  assert.equal(timers.pending.size, 0, 'destroying the last sandbox clears the timer');
  clock = 450000;
  const seen = [];
  backend._runJobCommand = async (_h, args) => { seen.push([...timers.pending].map(timer => timer.milliseconds)); return { code: 1, stdout: '', stderr: 'stub run' }; };
  await assert.rejects(backend.prepareCheck({ ...agent, _image: 'codex', _resources: { cpu: 1, memory_mib: 512, storage_mib: 512, wall_seconds: 600, output_bytes: 1, network_bytes: 1, max_processes: 1 },
    _egress: 'internet', _providerHosts: ['**.openai.com'] }), { code: 'sandbox_start_failed' });
  assert.deepEqual(seen[0], [150000 - CHECK_REMOVAL_RESERVE_MS], 'only the remaining job time is armed for the check sandbox');
  clock = 600000;
  await assert.rejects(backend.prepareCheck({ ...agent, _image: 'codex', _resources: { cpu: 1, memory_mib: 512, storage_mib: 512, wall_seconds: 600, output_bytes: 1, network_bytes: 1, max_processes: 1 },
    _egress: 'internet', _providerHosts: ['**.openai.com'] }), { code: 'wall_timeout' });
  assert.equal(seen.length, 1, 'an exhausted deadline creates no sandbox');
});

test('P9 backend verify reports the timeout it enforced, and none when the check could not run', async () => {
  let clock = 0;
  const backend = new DockerSbxBackend({ monotonic: () => clock });
  backend._runJobCommand = async () => ({ code: 0, stdout: 'ok', stderr: '' });
  const handle = { sandbox_id: 'c', _deadline: { endsAt: 600000 } };
  assert.equal((await backend.verify(handle, { cmd: 'npm test', workdir: '.' })).timeout_ms, 180000);
  clock = 570000;
  assert.equal((await backend.verify(handle, { cmd: 'npm test', workdir: '.' })).timeout_ms, 30000 - CHECK_STOP_MS);
  clock = 599500;
  assert.deepEqual(await backend.verify(handle, { cmd: 'npm test', workdir: '.' }), { exit: null, timed_out: false, stdout: '', skipped: 'time' });
});

test('P9 crash recovery removes a leftover check sandbox and its Git helper through their own receipts', async t => {
  const removed = [];
  const { _internal } = await import('../lib/docker-backend.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'p9-journal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const check = 'wf-' + 'c'.repeat(16), helper = 'wf-' + 'd'.repeat(16);
  for (const [jobId, name] of [['job-3-check', check], ['job-3-check-git', helper]])
    await writeCreateReceipt(directory, { jobId, name, ownerScope: sandboxOwnerScope(), home: _internal.sbxHome(), scratchRoot: process.env.FARAVAN_SCRATCH_ROOT || tmpdir() });
  // Names derived from the job are never authority to remove a sandbox.
  let listing = [check, helper, testSandboxName('job-3-check'), testSandboxName('job-3-check-git'), 'wf-unrelated'];
  const backend = new DockerSbxBackend({ cleanupDirectory: directory, runCommand: async args => {
    if (args[0] === 'ls') return { code: 0, stdout: JSON.stringify(listing.map(name => ({ name }))), stderr: '' };
    if (args[0] === 'rm') { removed.push(args.at(-1)); listing = listing.filter(name => name !== args.at(-1)); }
    return { code: 0, stdout: '', stderr: '' };
  } });
  const result = await backend.reconcilePending({ owner_scope:sandboxOwnerScope(),sbx_home:_internal.sbxHome(), attemptId: 'a1', jobId: 'job-3', attempt: { attempt_id: 'a1' } });
  assert.equal(result.removed, true);
  assert.deepEqual(removed.sort(), [check, helper].sort());
});

test('P9 an unrepresentable measured check duration stays absent', async t => {
  const e=emulator(t);let calls=0;
  const result=await runJob({jobSpec:job('true'),backend:e.backend,materializeSource:materialize,gitDiff:true,
    durationNow:()=>++calls===4?Number.MAX_SAFE_INTEGER+1:0});
  assert.equal('duration_ms' in result.checks[0],false);
});

// --- independent review P2s ----------------------------------------------------

function manualClock(start = 0) {
  const pending = new Set();
  let now = start;
  return {
    pending,
    monotonic: () => now,
    timers: {
      setTimeout(callback, milliseconds) { const timer = { callback, milliseconds, at: now + milliseconds, unref() {} }; pending.add(timer); return timer; },
      clearTimeout(timer) { pending.delete(timer); },
    },
    // Moves the clock and fires every timer that is due, as a real clock would.
    advance(milliseconds) {
      now += milliseconds;
      for (const timer of [...pending].filter(timer => timer.at <= now).sort((a, b) => a.at - b.at)) { pending.delete(timer); timer.callback(); }
    },
  };
}
const checkResources = { cpu: 1, memory_mib: 512, storage_mib: 512, wall_seconds: 600, output_bytes: 1, network_bytes: 1, max_processes: 1 };

test('P2-1 a check sandbox never gets the GitHub task kit, for the real gh-cli image or a GitHub-access agent', async t => {
  const runs = [],home=await mkdtemp(join(tmpdir(),'verification-kit-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  // Cleanup listings belong to this complete fake too. A kit-refusal check
  // must not read another case's retained policy debt or a real daemon.
  const sbx=fileSbx(home);
  const backend = new DockerSbxBackend({home,runCommand:withCleanCredentialScope(sbx.run),deadlineTimers:manualClock().timers,monotonic:()=>0});
  backend._resolveCompute = async () => ({ removed: true });
  backend._runJobCommand = async (_h, args) => { if (args[0] === 'create') runs.push(args); return { code: 1, stdout: '', stderr: 'stub' }; };
  const agent = image => ({...testSbxRuntimeFields(), job_id: 'job-gh', sandbox_id: 'a', scratch_dir: join(tmpdir(), 'none'), _image: image, _resources: checkResources,
    _executionScope: 'owner',
    _egress: 'internet', _providerHosts: ['**.github.com', '**.githubusercontent.com'],
    _deadline: { controller: new AbortController(), expired: false, cleanup: null, handles: new Set(), endsAt: 600000, timer: null } });
  // The agent image the gh-cli harness really uses: its agent exists only through the kit, so no check sandbox can start.
  assert.equal(resolveHarness('gh-cli').image, 'wf-gh-cli');
  await assert.rejects(backend.prepareCheck(agent('wf-gh-cli')), { code: 'policy_unenforceable' });
  assert.deepEqual(runs, [], 'nothing was started for a gh-cli check');
  // A Codex agent that had GitHub access: the check sandbox is started without the kit.
  await assert.rejects(backend.prepareCheck(agent('codex')), { code: 'sandbox_start_failed' });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].includes('--kit'), false);
  // Even a direct prepare of the kit image refuses when the caller asks for no kit.
  await assert.rejects(backend.prepare({ job_id: 'j', image: 'wf-gh-cli', entrypoint: 'true', inputs: [], output_manifest: [], resources: checkResources,
    execution_scope: 'owner',
    egress: 'internet', provider_hosts: ['**.github.com'], required_limits: ['cpu', 'memory', 'wall', 'output'] }, null, { githubKit: false }), { code: 'policy_unenforceable' });
  assert.equal(runs.length, 1);
});

test('P2-1 a gh-cli job that asks for checks is declined at admission, before any agent work', async () => {
  const { admitDockerJob } = await import('../lib/docker-backend.mjs');
  const harness = resolveHarness('gh-cli');
  const withChecks = buildValidatedJobSpec({ taskDigest: 'e'.repeat(64), harness, entrypointWithPrompt: 'gh --version', verify: { cmd: 'npm test' } });
  assert.deepEqual([admitDockerJob(withChecks).ok, admitDockerJob(withChecks).code], [false, 'policy_unenforceable']);
  assert.equal(admitDockerJob(buildValidatedJobSpec({ taskDigest: 'e'.repeat(64), harness, entrypointWithPrompt: 'gh --version' })).ok, true);
});

test('P2-3 a check that exits 124 or 137 by itself is not a timeout', async () => {
  for (const code of [124, 137]) {
    const clock = manualClock();
    const backend = new DockerSbxBackend({ deadlineTimers: clock.timers, monotonic: clock.monotonic });
    const commands = [];
    backend._runJobCommand = async (_h, args) => { commands.push(args.at(-1)); return { code, stdout: 'killed by its own timeout', stderr: '' }; };
    const observed = await backend.verify({ sandbox_id: 'c', _deadline: { endsAt: 600000 } }, { cmd: 'timeout 1 sleep 5', workdir: '.' });
    assert.equal(observed.exit, code);
    assert.equal(observed.timed_out, false, 'only the host watchdog can say the check timed out');
    assert.equal(observed.timeout_ms, 180000);
    assert.doesNotMatch(commands[0], /\/usr\/bin\/timeout/, 'no guest timeout binary decides the limit');
    assert.equal(clock.pending.size, 0, 'the watchdog is cleared when the command ends');
  }
});

test('P2-3 the host watchdog stops a check at its limit, cancels the sandbox, and only then reports a timeout', {timeout: 5000}, async () => {
  const clock = manualClock(570000);
  const backend = new DockerSbxBackend({ deadlineTimers: clock.timers, monotonic: clock.monotonic });
  let started, cancelled = 0;
  const running = new Promise(resolve => { started = resolve; });
  backend._runJobCommand = (_h, _args, _onLog, options) => new Promise(resolve => {
    started();
    // The guest prints a forged marker; only the host timer counts.
    options?.signal?.addEventListener('abort', () => resolve({ code: 0, stdout: 'TIMED_OUT=0 # pass 9', stderr: '' }), { once: true });
  });
  backend.cancel = async () => { cancelled++; };
  const handle = { sandbox_id: 'c', _deadline: { endsAt: 600000 } };
  const verifying = backend.verify(handle, { cmd: 'sleep 999', workdir: '.' });
  await running;
  const [watchdog] = clock.pending;
  assert.equal(watchdog.milliseconds, 30000 - CHECK_STOP_MS, 'the limit leaves time to stop the sandbox before its deadline');
  clock.advance(watchdog.milliseconds);
  const observed = await verifying;
  assert.deepEqual(observed, { exit: null, timed_out: true, timeout_ms: 30000 - CHECK_STOP_MS, stdout: '' });
  assert.equal(cancelled, 1);
});

test('P2-2 the check deadline is the earlier of the sandbox and caller deadlines, less the removal reserve', async () => {
  const clock = manualClock(500000);
  const backend = new DockerSbxBackend({ deadlineTimers: clock.timers, monotonic: clock.monotonic });
  const prepared = [];
  backend.prepare = async (spec, deadline, options) => { prepared.push({ spec, deadline, options }); return { sandbox_id: 'x' }; };
  const agent = {...testSbxRuntimeFields(), job_id: 'job-1', _image: 'codex', _resources: checkResources, _egress: 'internet', _providerHosts: ['**.openai.com'],
    _deadline: { endsAt: 620000 } };
  await backend.prepareCheck(agent, { remainingMs: 100000 }); // the caller's own wall deadline is earlier: 600000 here
  await backend.prepareCheck(agent, { remainingMs: 500000 });
  await backend.prepareCheck(agent);
  assert.deepEqual(prepared.map(p => p.deadline.endsAt), [600000 - CHECK_REMOVAL_RESERVE_MS, 620000 - CHECK_REMOVAL_RESERVE_MS, 620000 - CHECK_REMOVAL_RESERVE_MS]);
  assert.notEqual(prepared[0].deadline, agent._deadline, 'the check has its own deadline and timer');
  assert.deepEqual(prepared[0].options, { sbxRuntime:agent._sbxRuntime,githubKit: false });
  await assert.rejects(backend.prepareCheck(agent, { remainingMs: CHECK_REMOVAL_RESERVE_MS }), { code: 'wall_timeout' });
  assert.equal(prepared.length, 3, 'no sandbox when the reserve leaves no time');
});

test('P2-2 a check that runs to its limit returns the finished candidate and a timed-out check inside the caller wall', {timeout: 10000}, async t => {
  const clock = manualClock(0);
  const e = emulator(t);
  const callerWallEnd = 600000; // the lender armed its wall timer before the agent sandbox existed
  e.backend.monotonic = clock.monotonic;
  e.backend.deadlineTimers = clock.timers;
  const prepareCheck = e.backend.prepareCheck;
  let checkHandle;
  e.backend.prepareCheck = async (agent, options) => {
    // The real backend computes the check deadline; the emulator only supplies the sandboxes.
    const deadline = await new Promise((resolve, reject) => {
      const probe = new DockerSbxBackend({ deadlineTimers: clock.timers, monotonic: clock.monotonic });
      probe.prepare = async (_spec, d) => { resolve(d); return {}; };
      probe.prepareCheck({ ...agent, _deadline: { endsAt: 620000 } }, options).catch(reject);
    });
    checkHandle = await prepareCheck(agent, options);
    checkHandle._deadline = deadline;
    return checkHandle;
  };
  const run = e.backend._runJobCommand;
  e.backend._runJobCommand = (h, args, onLog, options) => args.at(-1).includes('npm test')
    ? new Promise(resolve => options.signal.addEventListener('abort', () => resolve({ code: 137, stdout: '', stderr: '' }), { once: true }))
    : run(h, args);
  e.backend.verify = (h, o) => { const pending = DockerSbxBackend.prototype.verify.call(e.backend, h, o); setImmediate(() => clock.advance(Math.min(...[...clock.pending].map(x => x.at)) - clock.monotonic())); return pending; };
  const result = await runJob({ jobSpec: job('printf "answer() { echo 42; }\\n" > src.sh'), backend: e.backend, materializeSource: materialize, gitDiff: true,
    durationNow: clock.monotonic, wallRemainingMs: () => callerWallEnd - clock.monotonic(),
    onStage: stage => { if (stage === 'checks') clock.advance(480000 - clock.monotonic()); } }); // the agent ran until here
  assert.equal(result.candidate.format, 'diff');
  assert.match(result.collected[0].bytes_content.toString(), /echo 42/);
  assert.equal(e.checkOptions[0].remainingMs, callerWallEnd - 480000, 'the caller deadline reaches the check sandbox');
  const [check] = result.checks;
  assert.deepEqual([check.exit, check.timed_out, check.timeout_ms], [null, true, callerWallEnd - CHECK_REMOVAL_RESERVE_MS - CHECK_STOP_MS - 480000]);
  assert.ok(480000 + check.timeout_ms + CHECK_STOP_MS + CHECK_REMOVAL_RESERVE_MS <= callerWallEnd, 'stop and removal fit before the caller wall deadline');
  assert.ok(clock.monotonic() < callerWallEnd);
  assert.ok(e.events.includes('cancel:check'));
  assert.equal(result.cleanupReceipt.removed, true);
});

test('typed output checks rebuild the original source and add only the returned output folder',async t=>{
  const e=emulator(t);
  const source=async dir=>{
    await materialize(dir);
    await writeFile(join(dir,'check_test.sh'),'[ "$(cat faravan-output/answer.txt)" = 42 ]\n');
  };
  const result=await runJob({jobSpec:job("mkdir -p faravan-output; printf 42 > faravan-output/answer.txt; printf 'exit 1\\n' > check_test.sh"),
    backend:e.backend,materializeSource:source,outputDir:'faravan-output'});
  assert.equal(result.checks[0].exit,0,'check sees original tests and the returned output');
  assert.equal(result.checks[0].skipped,undefined);
  assert.deepEqual(result.checks[0].changed_test_files,[],'source edits outside the returned folder are not applied');
});

test('typed Git output checks clone the source again and extract outputs inside the repository',async t=>{
  const e=emulator(t);let clones=0,checkOptions;
  const prepare=e.backend.prepareCheck;
  e.backend.prepareCheck=(agent,options)=>{checkOptions=options;return prepare(agent,options);};
  e.backend.cloneGitSource=async handle=>{
    clones++;const repo=join(handle.scratch_dir,'repo');await mkdir(repo);await materialize(repo);
    await writeFile(join(repo,'check_test.sh'),'[ "$(cat faravan-output/answer.txt)" = 42 ]\n');
    for(const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','source']])assert.equal(spawnSync('git',args,{cwd:repo,env:{...process.env,...GIT_ENV}}).status,0);
  };
  const result=await runJob({jobSpec:job('cd repo && mkdir -p faravan-output && printf 42 > faravan-output/answer.txt'),
    backend:e.backend,cloneGitSource:{url:'https://github.com/example/test.git',commit:'1'.repeat(40)},outputDir:'faravan-output'});
  assert.equal(clones,2);assert.equal(checkOptions.cloneSource,true);
  assert.equal(result.checks[0].exit,0);assert.equal(result.checks[0].skipped,undefined);
});

test('filtered pinned Git checks restore the project root and verify the chosen subdirectory in a fresh sandbox', async t => {
  const e = emulator(t);
  e.backend.cloneGitSource = async handle => {
    await mkdir(join(handle.scratch_dir, 'repo', 'packages', 'app'), {recursive:true});
    await writeFile(join(handle.scratch_dir, 'repo', 'packages', 'app', 'check_test.sh'), '[ -f fixed.txt ] && [ ! -d ../../.git ]\n');
    const r = spawnSync('git', ['init', '-q', 'repo'], {cwd:handle.scratch_dir, env:{...process.env,...GIT_ENV}});
    assert.equal(r.status, 0);
    for (const args of [['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','source']]) {
      assert.equal(spawnSync('git', ['-C','repo',...args], {cwd:handle.scratch_dir,env:{...process.env,...GIT_ENV}}).status, 0);
    }
  };
  const result = await runJob({jobSpec:job('echo fixed > repo/packages/app/fixed.txt'), backend:e.backend,
    cloneGitSource:{url:'https://github.com/example/repo',commit:'a'.repeat(40)}, workingDirectory:'packages/app'});
  assert.equal(result.checks[0].exit, 0);
  assert.equal(result.checks[0].skipped, undefined);
  assert.ok(e.events.indexOf('destroy:agent') < e.events.indexOf('checks:check'));
  assert.equal(existsSync(join(e.sandboxes[1].scratch_dir,'repo','.git')), false);
  assert.equal(readFileSync(join(e.sandboxes[1].scratch_dir,'repo','packages','app','fixed.txt'),'utf8'), 'fixed\n');
});
