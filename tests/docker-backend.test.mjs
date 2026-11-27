import './helpers/no-browser.mjs';
import {legacySandboxNameFor as testSandboxName} from '../lib/sandbox-name.mjs';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import {testSbxRuntimeFields} from './helpers/sandbox-receipt-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCb, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DockerSbxBackend as RuntimeDockerSbxBackend,
  sanitizedEnv,
  PREPARATION_BUDGET_MS,
  BACKEND_ID,
  SBX_RUN_OPTIONS,
  parseDockerAccount,
  _internal,
  PRIVATE_NETWORK_DENIES,
  REGISTRY_HOSTS,
  ENFORCED_LIMITS,
  UNENFORCED_LIMITS,
  parseNetworkPolicyDecision,
  admitDockerJob,
} from '../lib/docker-backend.mjs';
import { createSbxPolicy, sbxRunner } from './helpers/sbx-policy-model.mjs';
import { receiptedHandle, writeCreateReceipt, fakeSandboxDeadlines } from './helpers/sandbox-receipt-fixture.mjs';
import { validateJobSpec } from '../lib/runtime.mjs';
import { TUNNEL_ORIGIN } from '../lib/v1/guest-broker-tunnel.mjs';
import { loadImagePins } from '../lib/sbx-image-pins.mjs';
import { createDiskLedger } from '../lib/disk-ledger.mjs';
import { createDiskSweeper } from '../lib/disk-sweep.mjs';
import { createStoreCoordinator } from '../lib/store-lock.mjs';
import { REMOVE_ARTIFACTS_ENV } from '../lib/disk-sweep-setting.mjs';
import { getHarnessAdapter } from '../lib/harnesses/index.mjs';
import { buildValidatedJobSpec } from '../lib/executor.mjs';

// Every backend here keeps its disk store in its sbx HOME; a test that sets none gets a throwaway one, never the real store.
process.env.FARAVAN_SBX_HOME ??= fs.mkdtempSync(path.join(os.tmpdir(), 'wf-backend-sbx-home-'));

function preparedCommandBackend() {
  const backend=new DockerSbxBackend();backend.assertActive=async()=>{};backend._dispatchProtected=async(_h,s,launch)=>{s?.throwIfAborted();return launch();};return backend;
}

const execFile = promisify(execFileCb);
const SBX_RUN_HELP = SBX_RUN_OPTIONS.map((flag) => `      ${flag}`).join('\n');
let profile=0;
class DockerSbxBackend extends RuntimeDockerSbxBackend {
  constructor(options={}) {
    const home=path.join(process.env.FARAVAN_TEST_HOME,'backend-profile-'+(++profile));
    super({home,cleanupDirectory:path.join(home,'v1/sandbox-cleanup'),sandboxDeadlines:fakeSandboxDeadlines(),...options});
  }
}

function manualTimers() {
  const pending = new Set();
  return {
    setTimeout(callback, milliseconds) {
      const timer = {callback, milliseconds, unref() {}};
      pending.add(timer);
      return timer;
    },
    clearTimeout(timer) { pending.delete(timer); },
    advance(milliseconds) {
      for (const timer of [...pending].filter(timer => timer.milliseconds <= milliseconds)) {
        pending.delete(timer);
        timer.callback();
      }
    },
    fire(milliseconds) {
      const timers = [...pending].filter(timer => timer.milliseconds <= milliseconds);
      assert.equal(timers.length,1,'exactly one deadline must be due within the original budget');
      for (const timer of timers) {
        pending.delete(timer);
        timer.callback();
      }
    },
  };
}

async function waitForExec(calls) {
  const deadline=performance.now()+30000;
  do {
    const child=(await calls()).find(({args})=>args[0]==='exec'&&args.includes('sh'));
    if(child)return child;
    await new Promise(resolve=>setTimeout(resolve,25));
  } while(performance.now()<deadline);
  assert.fail('exec child did not become observable within 30 seconds');
}


const validJob = (overrides = {}) => ({
  job_id: 'job-docker-1',
  execution_scope: 'owner',
  image: 'wf-faravan-guest@sha256:0000000000000000000000000000000000000000000000000000000000000000',
  entrypoint: 'wf-guest-entrypoint',
  resources: { cpu: 2, memory_mib: 4096, storage_mib: 2048, wall_seconds: 3600, output_bytes: 10485760, network_bytes: 104857600, max_processes: 256 },
  inputs: [],
  output_manifest: [],
  egress: 'internet',
  provider_hosts: ['**.openai.com', '**.chatgpt.com'],
  ...overrides,
});

test('start forwards cancellation to its final optional policy-log read',async()=>{
  const backend=new DockerSbxBackend(),controller=new AbortController(),calls=[];
  backend._diskSentry=()=>({low:null});
  backend._runJobCommand=async(_handle,args,_onLog,options={})=>{
    calls.push({args,signal:options.signal});
    return {code:0,stdout:'',stderr:''};
  };
  await backend.start({...testSbxRuntimeFields(),sandbox_id:'identity-probe',_entrypoint:'true'},{signal:controller.signal});
  const log=calls.find(call=>call.args[0]==='policy'&&call.args[1]==='log');
  assert.ok(log);
  assert.equal(log.signal,controller.signal);
});

test('prepare recognizes an abort-signal options object as its second argument', async () => {
  const backend = new DockerSbxBackend(), controller = new AbortController();
  backend.admitJob = async () => {
    controller.abort();
    return {ok:false,code:'fixture',reason:'the preparation signal should abort first'};
  };
  await assert.rejects(backend.prepare(validJob(), {signal:controller.signal}), error => error.name === 'AbortError');
  assert.equal(backend._preparing,0,'an aborted prepare releases its in-flight count');
});

test('legacy Git source failures keep stable codes and cleanup', async () => {
  const backend = new DockerSbxBackend();
  const handle = { ...testSbxRuntimeFields(), job_id: 'fixture', sandbox_id: 'fixture', scratch_dir: '/unused', _resources: {}, _providerHosts: [] };
  await assert.rejects(backend.cloneGitSource(handle, { url: 'invalid' }),
    { code: 'git_source_invalid', message: 'git source must be a validated github.com HTTPS repository URL' });
  backend.prepare = async () => handle;
  let removed = 0;
  backend.destroy = async () => { removed++; return { removed: true }; };
  for (const copy of [false, true]) {
    backend._runJobCommand = async (_, args) => ({ code: copy && args[0] === 'exec' ? 0 : 1, stderr: 'fixture failure' });
    await assert.rejects(backend.cloneGitSource(handle, { url: 'https://github.com/example/repo' }), {
      code: copy ? 'git_source_transfer_failed' : 'git_source_unavailable',
      message: copy
        ? 'Could not transfer the sandbox-cloned Git repository into the task workspace: fixture failure'
        : 'Git repository clone failed inside the task sandbox. Set up GitHub access for a private repository, or verify the URL/ref: fixture failure',
    });
  }
  assert.equal(removed, 2);
});

test('job-path constructors cannot regress to bare uncoded throws', async () => {
  const backend = await readFile(new URL('../lib/docker-backend.mjs', import.meta.url), 'utf8');
  const executor = await readFile(new URL('../lib/executor.mjs', import.meta.url), 'utf8');
  const bareThrow = /throw\s+(?:new\s+)?Error\s*\(/;
  assert.doesNotMatch(backend, bareThrow);
  assert.doesNotMatch(executor.slice(executor.indexOf('export async function runJob(')), bareThrow);
  assert.match('throw new Error("fixture")', bareThrow, 'guard catches an uncoded constructor');
});

// --- sanitizedEnv: no sbx binary required -----------------------------------

test('sanitizedEnv strips SSH agent and DOCKER_HOST exactly', () => {
  const out = sanitizedEnv({ SSH_AUTH_SOCK: '/tmp/agent.sock', DOCKER_HOST: 'tcp://1.2.3.4:2375', KEEP_ME: 'yes' });
  assert.equal(out.SSH_AUTH_SOCK, undefined);
  assert.equal(out.DOCKER_HOST, undefined);
  assert.equal(out.KEEP_ME, 'yes');
});

test('parseDockerAccount reads account variants from ANSI-formatted sbx diagnose output and returns null when absent', () => {
  assert.equal(parseDockerAccount('\u001b[32mSigned in as rowan\u001b[0m'), 'rowan');
  assert.equal(parseDockerAccount('Authentication — authenticated as timodl'), 'timodl');
  assert.equal(parseDockerAccount('Docker account: timodl'), 'timodl');
  assert.equal(parseDockerAccount('You are signed in [username: timodl]'), 'timodl');
  assert.equal(parseDockerAccount('Docker authentication required'), null);
});

test('sanitizedEnv strips *_API_KEY and *_TOKEN patterns', () => {
  const out = sanitizedEnv({
    OPENAI_API_KEY: 'sk-x',
    ANTHROPIC_API_KEY: 'sk-y',
    GITHUB_TOKEN: 'ghp_x',
    RANDOM_TOKEN: 'z',
    PATH: '/usr/bin',
  });
  assert.equal(out.OPENAI_API_KEY, undefined);
  assert.equal(out.ANTHROPIC_API_KEY, undefined);
  assert.equal(out.GITHUB_TOKEN, undefined);
  assert.equal(out.RANDOM_TOKEN, undefined);
  assert.equal(out.PATH, '/usr/bin');
});

test('sanitizedEnv strips cloud provider and git credential-helper vars', () => {
  const out = sanitizedEnv({
    AWS_SECRET_ACCESS_KEY: 'a',
    AWS_ACCESS_KEY_ID: 'b',
    GCP_PROJECT: 'c',
    GOOGLE_APPLICATION_CREDENTIALS: 'd',
    AZURE_CLIENT_SECRET: 'e',
    GIT_ASKPASS: 'f',
    GIT_SSH_COMMAND: 'g',
    GH_TOKEN: 'h',
    NPM_TOKEN: 'i',
    DOCKER_CONFIG: 'j',
    HOME: '/home/dev',
  });
  for (const key of ['AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'GCP_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS', 'AZURE_CLIENT_SECRET', 'GIT_ASKPASS', 'GIT_SSH_COMMAND', 'GH_TOKEN', 'NPM_TOKEN', 'DOCKER_CONFIG']) {
    assert.equal(out[key], undefined, `${key} should have been stripped`);
  }
  assert.equal(out.HOME, '/home/dev');
});

test('sanitizedEnv is non-mutating and tolerates empty/undefined input', () => {
  const base = { SSH_AUTH_SOCK: '/x' };
  const out = sanitizedEnv(base);
  assert.equal(base.SSH_AUTH_SOCK, '/x', 'must not mutate the input object');
  assert.deepEqual(sanitizedEnv(undefined), {});
  assert.deepEqual(sanitizedEnv({}), {});
});

// --- scratch directory / sandbox naming -------------------------------------

test('scratch directory creation produces a unique, disposable directory per job', async () => {
  const scratchRoot = await mkdtemp(path.join(os.tmpdir(), 'wf-scratch-test-'));
  process.env.FARAVAN_SCRATCH_ROOT = scratchRoot;
  try {
    const backend = new DockerSbxBackend();
    const previousBin = process.env.FARAVAN_SBX_BIN;
    // prepare() calls `sbx run`; point at a stub that always succeeds so we
    // can isolate scratch-dir behavior without a real sbx install.
    const stubDir = await writeStub('run-ok', 'exit 0');
    process.env.FARAVAN_SBX_BIN = path.join(stubDir, 'sbx');
    try {
      const handleA = await backend.prepare(validJob({ job_id: 'job-a' }));
      const handleB = await backend.prepare(validJob({ job_id: 'job-b' }));
      assert.notEqual(handleA.scratch_dir, handleB.scratch_dir);
      assert.ok(handleA.scratch_dir.startsWith(scratchRoot));
      assert.match(handleA.scratch_dir, /wf-job-/);
      const stat = await import('node:fs/promises').then((m) => m.stat(handleA.scratch_dir));
      assert.ok(stat.isDirectory());
      await rm(handleA.scratch_dir, { recursive: true, force: true });
      await rm(handleB.scratch_dir, { recursive: true, force: true });
    } finally {
      if (previousBin === undefined) delete process.env.FARAVAN_SBX_BIN;
      else process.env.FARAVAN_SBX_BIN = previousBin;
      await rm(stubDir, { recursive: true, force: true });
    }
  } finally {
    delete process.env.FARAVAN_SCRATCH_ROOT;
    await rm(scratchRoot, { recursive: true, force: true });
  }
});

test('sandbox names are deterministic per job_id and distinct across jobs', () => {
  const a1 = testSandboxName('job-a');
  const a2 = testSandboxName('job-a');
  const b = testSandboxName('job-b');
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.match(a1, /^wf-[0-9a-f]{16}$/);
});

// --- output_manifest path safety --------------------------------------------

test('isSafeRelativeOutputPath rejects traversal, absolute paths, and NUL bytes', () => {
  assert.equal(_internal.isSafeRelativeOutputPath('work/result.patch'), true);
  assert.equal(_internal.isSafeRelativeOutputPath('../../etc/passwd'), false);
  assert.equal(_internal.isSafeRelativeOutputPath('/etc/passwd'), false);
  assert.equal(_internal.isSafeRelativeOutputPath('work/../../escape'), false);
  assert.equal(_internal.isSafeRelativeOutputPath('work/./x'), false);
  assert.equal(_internal.isSafeRelativeOutputPath('a\0b'), false);
  assert.equal(_internal.isSafeRelativeOutputPath(''), false);
  assert.equal(_internal.isSafeRelativeOutputPath(undefined), false);
});

test('collectDeclaredOutputs rejects an unsafe manifest path before touching sbx', async () => {
  const backend = new DockerSbxBackend();
  const scratchDir = await mkdtemp(path.join(os.tmpdir(), 'wf-collect-test-'));
  const handle = { ...testSbxRuntimeFields(), backend_id: BACKEND_ID, job_id: 'job-x', sandbox_id: 'wf-deadbeef', scratch_dir: scratchDir };
  try {
    await assert.rejects(
      () => backend.collectDeclaredOutputs(handle, ['../../etc/passwd']),
      /unsafe output path/,
    );
    await assert.rejects(
      () => backend.collectDeclaredOutputs(handle, ['/etc/passwd']),
      /unsafe output path/,
    );
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
});

test('collectDeclaredOutputs rejects a guest symlink instead of following it', async () => {
  const scratchDir = await mkdtemp(path.join(os.tmpdir(), 'wf-collect-symlink-'));
  const target = path.join(scratchDir, 'real-secret.txt');
  await writeFile(target, 'secret');
  const linkPath = path.join(scratchDir, 'result.patch');
  await symlink(target, linkPath);

  // Execute the actual guest-side guard locally against synthetic files.
  const stubDir = await writeStub('output-symlink', 'shift 3; exec "$@"');
  const previousBin = process.env.FARAVAN_SBX_BIN;
  process.env.FARAVAN_SBX_BIN = path.join(stubDir, 'sbx');
  try {
    const backend = preparedCommandBackend();
    const handle = { ...testSbxRuntimeFields(), backend_id: BACKEND_ID, job_id: 'job-y', sandbox_id: 'wf-cafebabe', scratch_dir: scratchDir };
    await assert.rejects(
      () => backend.collectDeclaredOutputs(handle, ['result.patch']),
      { code: 'output_copy_failed' },
    );
  } finally {
    if (previousBin === undefined) delete process.env.FARAVAN_SBX_BIN;
    else process.env.FARAVAN_SBX_BIN = previousBin;
    await rm(stubDir, { recursive: true, force: true });
    await rm(scratchDir, { recursive: true, force: true });
  }
});

test('output streaming and _copyIn use an ABSOLUTE guest path', async () => {
  // `sbx cp` rejects a relative container path outright ("container path
  // must be absolute (use SANDBOX:/path)") — confirmed live. The guest's
  // absolute workspace mirrors handle.scratch_dir (confirmed live: `sbx exec
  // <sandbox> -- pwd` inside a freshly-created sandbox returns the exact
  // host scratch_dir path). Both input copies and output streams resolve
  // declared relative paths against that guest workspace.
  const scratchDir = await mkdtemp(path.join(os.tmpdir(), 'wf-collect-abspath-'));

  const stubDir = await writeStub('cp-record', `
    echo "$@" >>"$WF_STUB_LOG"
    state="$(dirname "$0")/sandbox"
    if [ "$1" = run ] || [ "$1" = create ]; then for ((i=1;i<=$#;i++)); do if [ "\${!i}" = --name ]; then j=$((i+1)); printf '%s' "\${!j}" > "$state"; fi; done; fi
    if [ "$1" = rm ]; then rm -f "$state"; fi
    if [ "$1" = ls ]; then if [ -f "$state" ]; then printf '[{"name":"%s"}]' "$(cat "$state")"; else echo '[]'; fi; fi
    exit 0
  `);
  const logPath = path.join(stubDir, 'invocation.log');
  const previousBin = process.env.FARAVAN_SBX_BIN;
  process.env.FARAVAN_SBX_BIN = path.join(stubDir, 'sbx');
  process.env.WF_STUB_LOG = logPath;
  try {
    const backend = preparedCommandBackend();
    const handle = { ...testSbxRuntimeFields(), backend_id: BACKEND_ID, job_id: 'job-abspath', sandbox_id: 'wf-abspath', scratch_dir: scratchDir };
    await backend._copyIn(handle, { artifact_id: 'art-1', dest: 'inputs/task.md' });
    // The no-op stream is a valid empty regular output for this argv test.
    await backend.collectDeclaredOutputs(handle, ['result.txt']);

    const invocation = await import('node:fs/promises').then((m) => m.readFile(logPath, 'utf8'));
    const lines = invocation.trim().split('\n');
    assert.ok(lines[0].includes(`wf-abspath:${path.join(scratchDir, 'inputs/task.md')}`), `_copyIn must target an absolute guest path, got: ${lines[0]}`);
    assert.ok(lines[1].includes(`sh ${path.join(scratchDir, 'result.txt')}`), `output stream must source from an absolute guest path, got: ${lines[1]}`);
  } finally {
    if (previousBin === undefined) delete process.env.FARAVAN_SBX_BIN;
    else process.env.FARAVAN_SBX_BIN = previousBin;
    delete process.env.WF_STUB_LOG;
    await rm(stubDir, { recursive: true, force: true });
    await rm(scratchDir, { recursive: true, force: true });
  }
});

test('cloneGitSource clones anonymously in the GitHub kit sandbox, transfers the tree, and destroys the clone sandbox', async () => {
  const taskScratch = await mkdtemp(path.join(os.tmpdir(), 'wf-git-task-'));
  const cloneScratch = await mkdtemp(path.join(os.tmpdir(), 'wf-git-clone-'));
  const stubDir = await writeStub('git-clone-record', `
    echo "$@" >> "$WF_STUB_LOG"
    exit 0
  `);
  const logPath = path.join(stubDir, 'invocation.log');
  const previousBin = process.env.FARAVAN_SBX_BIN;
  process.env.FARAVAN_SBX_BIN = path.join(stubDir, 'sbx');
  process.env.WF_STUB_LOG = logPath;
  const taskHandle = { ...testSbxRuntimeFields(), backend_id: BACKEND_ID, job_id: 'job-git', sandbox_id: 'wf-task', scratch_dir: taskScratch };
  const cloneHandle = { ...testSbxRuntimeFields(), backend_id: BACKEND_ID, job_id: 'job-git-git', sandbox_id: 'wf-clone', scratch_dir: cloneScratch };
  try {
    const backend = new DockerSbxBackend();
    const prepared = [];
    let destroyed = null;
    backend.prepare = async (job) => { prepared.push(job); return cloneHandle; };
    backend.assertActive=async()=>{};backend._dispatchProtected=async(_h,signal,launch)=>{signal?.throwIfAborted();return launch();}; // Preparation and its admission are supplied by this fixture.
    backend.destroy = async (handle) => { destroyed = handle; };
    await backend.cloneGitSource(taskHandle, { url: 'https://github.com/octocat/Hello-World.git', ref: 'main' });

    assert.equal(prepared.length, 1);
    assert.equal(prepared[0].job_id, 'job-git-git');
    assert.equal(prepared[0].image, 'wf-gh-cli');
    assert.deepEqual(prepared[0].required_limits, ENFORCED_LIMITS);
    assert.equal(destroyed, cloneHandle);
    const invocations = await import('node:fs/promises').then((m) => m.readFile(logPath, 'utf8'));
    assert.match(invocations, /exec wf-clone -- sh -c git clone --depth 1 --branch 'main' 'https:\/\/github\.com\/octocat\/Hello-World\.git' repo/);
    assert.match(invocations, new RegExp(`cp wf-clone:${cloneScratch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\/repo ${taskScratch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\/repo`));
    assert.doesNotMatch(invocations, /gh repo clone/);
  } finally {
    if (previousBin === undefined) delete process.env.FARAVAN_SBX_BIN;
    else process.env.FARAVAN_SBX_BIN = previousBin;
    delete process.env.WF_STUB_LOG;
    await rm(stubDir, { recursive: true, force: true });
    await rm(taskScratch, { recursive: true, force: true });
    await rm(cloneScratch, { recursive: true, force: true });
  }
});

test('cloneGitSource falls back to kit-proxied gh only after anonymous Git transport fails', async () => {
  const taskScratch = await mkdtemp(path.join(os.tmpdir(), 'wf-git-task-'));
  const cloneScratch = await mkdtemp(path.join(os.tmpdir(), 'wf-git-clone-'));
  const stubDir = await writeStub('git-clone-fallback', `
    echo "$@" >> "$WF_STUB_LOG"
    case "$*" in *'git clone'*) exit 1 ;; *) exit 0 ;; esac
  `);
  const logPath = path.join(stubDir, 'invocation.log');
  const previousBin = process.env.FARAVAN_SBX_BIN;
  process.env.FARAVAN_SBX_BIN = path.join(stubDir, 'sbx');
  process.env.WF_STUB_LOG = logPath;
  const taskHandle = { ...testSbxRuntimeFields(), backend_id: BACKEND_ID, job_id: 'job-git-fallback', sandbox_id: 'wf-task', scratch_dir: taskScratch };
  const cloneHandle = { ...testSbxRuntimeFields(), backend_id: BACKEND_ID, job_id: 'job-git-fallback-git', sandbox_id: 'wf-clone', scratch_dir: cloneScratch };
  try {
    const backend = new DockerSbxBackend();
    backend.prepare = async () => cloneHandle;
    backend.assertActive=async()=>{};backend._dispatchProtected=async(_h,signal,launch)=>{signal?.throwIfAborted();return launch();};
    backend.destroy = async () => {};
    await backend.cloneGitSource(taskHandle, { url: 'https://github.com/octocat/Hello-World.git' });
    const invocations = await import('node:fs/promises').then((m) => m.readFile(logPath, 'utf8'));
    const anonymous = invocations.indexOf('git clone --depth 1');
    const authenticated = invocations.indexOf('gh repo clone');
    assert.ok(anonymous >= 0, 'must try anonymous Git transport first');
    assert.ok(authenticated > anonymous, 'gh must only run after anonymous clone fails');
  } finally {
    if (previousBin === undefined) delete process.env.FARAVAN_SBX_BIN;
    else process.env.FARAVAN_SBX_BIN = previousBin;
    delete process.env.WF_STUB_LOG;
    await rm(stubDir, { recursive: true, force: true });
    await rm(taskScratch, { recursive: true, force: true });
    await rm(cloneScratch, { recursive: true, force: true });
  }
});

// --- live-sbx-dependent behavior: stub executable or skip -------------------

async function sbxOnPath() {
  if (process.env.FARAVAN_LIVE_SBX_TESTS !== '1') return false;
  try {
    await execFile('sbx', ['version']);
    return true;
  } catch (error) {
    return error && error.code !== 'ENOENT';
  }
}

async function writeStub(name, body) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `wf-sbx-stub-${name}-`));
  const scriptPath = path.join(dir, 'sbx');
  const policy = `
if [ "$1 \${2:-}" = "daemon status" ]; then echo "Status: running"; exit 0; fi
if [ "$1 \${2:-}" = "secret ls" ]; then
  echo '{"secrets":[],"custom_secrets":[],"shadowed_services":[],"env_only_count":0}'
  exit 0
fi
if [ "$1" = "settings" ]; then
  if [ "\${2:-}" = get ] && [ "\${3:-}" = ssh.agentForwardingEnabled ]; then echo false; fi
  exit 0
fi
if [ "$1 \${2:-}" = "policy check" ]; then
  [ -z "\${WF_STUB_LOG:-}" ] || echo "$@" >> "$WF_STUB_LOG"
  case "\${!#}" in
    10.0.0.1|192.168.1.1|169.254.169.254|example.com|mcp-gateway.docker.internal:80|mcp-gateway.docker.internal:443) echo '{"allowed":false}' ;;
    *) echo '{"allowed":true}' ;;
  esac
  exit 0
fi
`;
  await writeFile(scriptPath, `#!/usr/bin/env bash\nset -euo pipefail\n${policy}\n${body}\n`);
  await chmod(scriptPath, 0o755);
  return dir;
}

test('probeCapabilities reports unavailable (never throws) when sbx is missing', async () => {
  const previousBin = process.env.FARAVAN_SBX_BIN;
  process.env.FARAVAN_SBX_BIN = '/nonexistent/path/to/sbx-that-does-not-exist';
  try {
    const backend = new DockerSbxBackend();
    const report = await backend.probeCapabilities();
    assert.equal(report.available, false);
    assert.equal(report.backend_id, BACKEND_ID);
    assert.ok(Array.isArray(report.missing_prerequisites) && report.missing_prerequisites.length > 0);
    assert.match(report.install_hint, /^https:\/\//);
  } finally {
    if (previousBin === undefined) delete process.env.FARAVAN_SBX_BIN;
    else process.env.FARAVAN_SBX_BIN = previousBin;
  }
});

test('probeCapabilities reports available:true and forwards version via a stub sbx', async () => {
  const backend = new DockerSbxBackend();
  const report = await backend.probeCapabilities({
    platformName: 'darwin',
    sbxHomePath: '/Users/a/.wfsbx', userHome: '/Users/a',
    realpathPath: path => path === '/Users/a/Library/Keychains' || path === '/Users/a/.wfsbx/Library/Keychains' ? '/Users/a/Library/Keychains' : null,
    runCommand: async (_command, args) => {
      if (args.join(' ') === 'ls -q') return {code:0,stdout:''};
      if (args.join(' ') === 'run --help') return { code: 0, stdout: SBX_RUN_HELP };
      if (args[0] === 'version') return { code: 0, stdout: 'sbx version 0.51.0' };
      if (args[0] === 'diagnose') return { code: 0, stdout: 'Daemon healthy\nDocker authentication healthy' };
      if (args[0] === 'policy') return { code: 0, stdout: 'Policy rules' };
      throw new Error(`unexpected command: ${args.join(' ')}`);
    },
  });
  assert.equal(report.available, true);
  assert.equal(report.backend_id, BACKEND_ID);
  assert.match(report.version, /0\.51\.0/);
  assert.equal(report.preflight.ok, true);
});

test('prepare() admits a job only with host disk headroom, and stops one whose disk runs low while it is prepared', async () => {
  const stubDir = await writeStub('run-disk', `
    echo "$@" >>"$WF_STUB_LOG"
    state="$(dirname "$0")/sandbox"
    if [ "$1" = run ] || [ "$1" = create ]; then for ((i=1;i<=$#;i++)); do if [ "\${!i}" = --name ]; then j=$((i+1)); printf '%s' "\${!j}" > "$state"; fi; done; fi
    if [ "$1" = rm ]; then rm -f "$state"; fi
    if [ "$1" = ls ]; then if [ -f "$state" ]; then printf '[{"name":"%s"}]' "$(cat "$state")"; else echo '[]'; fi; fi
    exit 0
  `);
  const logPath = path.join(stubDir, 'invocation.log');
  const previousBin = process.env.FARAVAN_SBX_BIN;
  process.env.FARAVAN_SBX_BIN = path.join(stubDir, 'sbx');
  process.env.WF_STUB_LOG = logPath;
  const calls = async () => (await import('node:fs/promises').then((m) => m.readFile(logPath, 'utf8').catch(() => ''))).split('\n').filter(Boolean);
  try {
    const low = new DockerSbxBackend({ hostDisk: { free: async () => ({ free: 7 * 1024 ** 3 }) } });
    await assert.rejects(low.prepare(validJob({ job_id: 'job-disk-low' })), (error) => error.code === 'host_disk_low' && /at least 8 GiB/.test(error.message));
    assert.equal((await calls()).some((c) => c.startsWith('create ')), false, 'no sandbox is created without headroom');
    // Low before `sbx run`: the run is abandoned, so there is no sandbox to stop.
    let reads = 0;
    const early = new DockerSbxBackend({ killSandboxes: async () => false, hostDisk: { free: async () => ({ free: ++reads === 1 ? 20 * 1024 ** 3 : 1024 ** 3 }) } });
    await assert.rejects(early.prepare(validJob({ job_id: 'job-disk-early' })), (error) => error.code === 'host_disk_low');
    assert.equal((await calls()).some((c) => c.startsWith('create ')), false, 'a run abandoned before it starts creates nothing');
    // Low once the sandbox exists but before the job starts: the idle sandbox is halted, the job cannot start,
    // and destroy() removes it.
    // The drop waits for prepare() to return, so it cannot land inside prepare's own steps.
    let prepared = false;
    const draining = new DockerSbxBackend({ killSandboxes: async () => false, hostDisk: { free: async () => ({ free: prepared ? 1024 ** 3 : 20 * 1024 ** 3 }) } });
    const handle = await draining.prepare(validJob({ job_id: 'job-disk-drain' }));
    prepared = true;
    const stopped = async () => (await calls()).some((c) => /^stop wf-[0-9a-f]{16}$/.test(c));
    for (const ends = Date.now() + 10_000; !(await stopped()) && Date.now() < ends;) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(await stopped(), `the sandbox is halted, got ${JSON.stringify(await calls())}`);
    await assert.rejects(draining.start(handle), (error) => error.code === 'host_disk_low');
    await draining.destroy(handle);
    assert.ok((await calls()).some((c) => /^rm /.test(c)), 'and removed');
  } finally {
    if (previousBin === undefined) delete process.env.FARAVAN_SBX_BIN;
    else process.env.FARAVAN_SBX_BIN = previousBin;
    delete process.env.WF_STUB_LOG;
  }
});

test('Codex proxy preparation creates its workspace without starting the default agent session', async () => {
  const stubDir = await writeStub('codex-create-only', `
    echo "$@" >>"$WF_STUB_LOG"
    if [ "$1" = run ]; then touch "$WF_AGENT_EARLY_MARKER"; fi
    exit 0
  `);
  const logPath = path.join(stubDir, 'invocation.log');
  const marker = path.join(stubDir, 'agent-started-before-policy');
  const previous = { bin: process.env.FARAVAN_SBX_BIN, log: process.env.WF_STUB_LOG, marker: process.env.WF_AGENT_EARLY_MARKER };
  process.env.FARAVAN_SBX_BIN = path.join(stubDir, 'sbx');
  process.env.WF_STUB_LOG = logPath;
  process.env.WF_AGENT_EARLY_MARKER = marker;
  let backend, handle;
  try {
    backend = new DockerSbxBackend({guestRuntime:async()=>({dir:'/data/guest-runtime',node:'/data/guest-runtime/node',sha256:'0'.repeat(64)})});
    handle = await backend.prepare(validJob({ image: 'codex', auth_strategy: 'docker-native-oauth', execution_scope: 'owner' }));
    assert.equal(await readFile(marker).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }), false,
      'preparation must not start the kit default agent before policy verification');
    const calls = (await readFile(logPath, 'utf8')).split('\n').filter(Boolean);
    const creation = calls.find(line => line.startsWith('create '));
    assert.ok(creation.includes(handle.scratch_dir + ' /data/guest-runtime:ro'));
    assert.ok(creation, 'Codex proxy preparation uses sbx create');
    assert.ok(creation.indexOf('codex') < creation.indexOf(handle.scratch_dir), 'keep the disposable workspace after the selected agent');
    assert.ok(!creation.split(/\s+/).includes('-d'), 'create must not attach or start a session');
    assert.ok(creation.includes('--cpus 2 --memory 4096m --skills off'), 'keep the existing resource and skills controls');
  } finally {
    if (handle) await backend.destroy(handle);
    for (const [key, value] of Object.entries({ FARAVAN_SBX_BIN: previous.bin, WF_STUB_LOG: previous.log, WF_AGENT_EARLY_MARKER: previous.marker })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(stubDir, { recursive: true, force: true });
  }
});

test('prepare() invokes `sbx create` with the AGENT before the scratch-dir PATH, never a start flag or a real repo path', async () => {
  // Real sbx v0.50.1 shape: `sbx run [flags] [AGENT] [PATH...]` — the agent
  // positional comes BEFORE the workspace path. A prior revision of this
  // backend had these reversed (path before agent), which live UAT caught
  // as a real "not a sandbox or known agent" failure — see
  // docs/history/design/archive/FEDERATION_V0_UAT_REPORT.md "Owner UAT findings and fixes".
  const stubDir = await writeStub('run-record', `
    echo "$@" >>"$WF_STUB_LOG"
    state="$(dirname "$0")/sandbox"
    if [ "$1" = run ] || [ "$1" = create ]; then for ((i=1;i<=$#;i++)); do if [ "\${!i}" = --name ]; then j=$((i+1)); printf '%s' "\${!j}" > "$state"; fi; done; fi
    if [ "$1" = rm ]; then rm -f "$state"; fi
    if [ "$1" = ls ]; then if [ -f "$state" ]; then printf '[{"name":"%s"}]' "$(cat "$state")"; else echo '[]'; fi; fi
    exit 0
  `);
  const logPath = path.join(stubDir, 'invocation.log');
  const previousBin = process.env.FARAVAN_SBX_BIN;
  process.env.FARAVAN_SBX_BIN = path.join(stubDir, 'sbx');
  process.env.WF_STUB_LOG = logPath;
  try {
    const backend = new DockerSbxBackend();
    const job = validJob({ job_id: 'job-record' });
    const handle = await backend.prepare(job);
    const log = await import('node:fs/promises').then((m) => m.readFile(logPath, 'utf8'));
    const calls = log.split('\n').filter(Boolean);
    const invocation = calls.find((call) => /^(run|create) /.test(call));
    const actualOptions = [...new Set(invocation.split(/\s+/).filter((arg) => arg.startsWith('-')))];
    assert.deepEqual(actualOptions.sort(), SBX_RUN_OPTIONS.filter((flag) => flag !== '--kit' && flag !== '-d').sort(), 'doctor contract must cover every ordinary prepare() create option');
    // prepare() must ALSO wait for the sandbox to be genuinely exec-able
    // before returning (sbx run --detached returns before boot completes —
    // found live as "no sandbox named <id>" on the very next exec).
    assert.ok(calls.slice(1).some((c) => /^exec wf-[0-9a-f]{16} -- true$/.test(c)),
      `prepare() must readiness-probe the sandbox after sbx run, got calls: ${JSON.stringify(calls)}`);
    assert.match(invocation, /^create --name wf-[0-9a-f]{16} /);
    const afterName = invocation.replace(/^create --name wf-[0-9a-f]{16} /, '');
    assert.ok(afterName.includes(job.image), `agent/image must be present after flags, got: ${afterName}`);
    const imageIndex = invocation.indexOf(job.image);
    const scratchIndex = invocation.indexOf(handle.scratch_dir);
    assert.ok(imageIndex >= 0 && scratchIndex > imageIndex, 'sbx run must place the agent/image before the scratch-dir workspace path');
    assert.ok(!/(^| )-d( |$)/.test(invocation) && !invocation.includes('--detached') && !invocation.includes('--detach'), 'a created sandbox starts no session: prepare() only creates it, and later work reaches it through exec');
    assert.ok(invocation.includes(handle.scratch_dir), 'sbx run must receive the disposable scratch dir as workspace');
    assert.ok(!invocation.includes(process.cwd()), 'sbx run must never receive the repo checkout as workspace');
    await rm(handle.scratch_dir, { recursive: true, force: true });
  } finally {
    if (previousBin === undefined) delete process.env.FARAVAN_SBX_BIN;
    else process.env.FARAVAN_SBX_BIN = previousBin;
    delete process.env.WF_STUB_LOG;
    await rm(stubDir, { recursive: true, force: true });
  }
});

test('start() drives the entrypoint via `sbx exec SANDBOX -- sh -c ENTRYPOINT`, splitting a multi-word HarnessSpec command', async () => {
  // entrypoint is a full command STRING (e.g. 'codex exec --dangerously-
  // bypass-approvals-and-sandbox'), not a single guest binary name — a prior
  // revision passed it as one literal execFile argv element, which real
  // agents like Codex would receive as a single nonexistent binary name
  // rather than a parsed command line.
  const stubDir = await writeStub('exec-record', `
    echo "$@" >>"$WF_STUB_LOG"
    state="$(dirname "$0")/sandbox"
    if [ "$1" = run ] || [ "$1" = create ]; then for ((i=1;i<=$#;i++)); do if [ "\${!i}" = --name ]; then j=$((i+1)); printf '%s' "\${!j}" > "$state"; fi; done; fi
    if [ "$1" = rm ]; then rm -f "$state"; fi
    if [ "$1" = ls ]; then if [ -f "$state" ]; then printf '[{"name":"%s"}]' "$(cat "$state")"; else echo '[]'; fi; fi
    exit 0
  `);
  const logPath = path.join(stubDir, 'invocation.log');
  const previousBin = process.env.FARAVAN_SBX_BIN;
  process.env.FARAVAN_SBX_BIN = path.join(stubDir, 'sbx');
  process.env.WF_STUB_LOG = logPath;
  try {
    const backend = new DockerSbxBackend();
    const handle = { ...testSbxRuntimeFields(), backend_id: BACKEND_ID, job_id: 'job-start', sandbox_id: 'wf-startexec', scratch_dir: '/tmp/unused', _entrypoint: 'codex exec --dangerously-bypass-approvals-and-sandbox' };
    backend.assertActive=async()=>{};backend._dispatchProtected=async(_h,signal,launch)=>{signal?.throwIfAborted();return launch();};
    await backend.start(handle);
    const invocation = await import('node:fs/promises').then((m) => m.readFile(logPath, 'utf8'));
    const calls = invocation.trim().split('\n');
    assert.equal(calls[0], `exec wf-startexec -- sh -c ${handle._entrypoint}`);
    // After the agent runs, the backend reads what the sandbox actually reached (S5.5).
    assert.ok(calls.slice(1).every(call => call === 'policy log wf-startexec --json'), calls.join(' | '));
  } finally {
    if (previousBin === undefined) delete process.env.FARAVAN_SBX_BIN;
    else process.env.FARAVAN_SBX_BIN = previousBin;
    delete process.env.WF_STUB_LOG;
    await rm(stubDir, { recursive: true, force: true });
  }
});

for (const remains of [false, true]) {
  test('destroy() independently verifies removal via sbx ls and ' +
    (remains ? 'retains the journal when still listed' : 'closes the journal after target absence'), async () => {
    const name = 'wf-' + (remains ? 'b2' : 'a1').repeat(8);
    const sentinel = 'wf-' + 'c3'.repeat(8);
    const present = JSON.stringify([{ name, status: 'running' }, { name: sentinel, status: 'running' }]);
    const after = remains ? present : JSON.stringify([{ name: sentinel, status: 'running' }]);
    await withRecordedSbx(`
      dir="$(dirname "$0")"
      case "$1" in
        rm) touch "$dir/attempted" ;;
        ls)
          test -s "$(cat "$dir/row-path")"
          if [ -f "$dir/attempted" ]; then echo '${after}'; else echo '${present}'; fi
          ;;
        policy) if [ "$2" = ls ]; then echo '{"rules":[]}'; fi ;;
      esac
    `, async (dir, log) => {
      const cleanupDirectory = path.join(dir, 'cleanup');
      const backend = new DockerSbxBackend({ cleanupDirectory });
      const jobId = remains ? 'job-stuck' : 'job-destroy';
      const handle = await receiptedHandle(backend, {
        ...testSbxRuntimeFields(), backend_id: BACKEND_ID, job_id: jobId, sandbox_id: name,
      });
      const rowPath = path.join(cleanupDirectory, handle._cleanupId + '.json');
      const before = JSON.parse(await readFile(rowPath, 'utf8'));
      assert.equal(before.sandbox_id, name);
      assert.equal(before.compute_created, true);
      assert.equal(before.create_settled, true);
      await writeFile(path.join(dir, 'row-path'), rowPath);

      const receipt = await backend.destroy(handle);
      assert.equal(receipt.removed, !remains);
      if (remains) {
        const pending = JSON.parse(await readFile(rowPath, 'utf8'));
        assert.equal(pending._cleanupId, before._cleanupId);
        assert.equal(pending.sandbox_id, name);
        assert.equal(pending.compute_stopped, false);
      } else {
        assert.equal(receipt.scratch_removed, true);
        assert.equal(receipt.policy_removed, true);
        assert.equal(receipt.job_id, jobId);
        assert.equal(receipt.sandbox_id, name);
        assert.match(receipt.at, /^\d{4}-\d{2}-\d{2}T/);
        await assert.rejects(readFile(rowPath, 'utf8'), { code: 'ENOENT' });
      }
      const calls = (await log()).trim().split('\n');
      assert.deepEqual(calls.filter(call => /^(ls |rm )/.test(call)),
        ['ls --json', 'rm --force ' + name, 'ls --json']);
      assert.ok(calls.every(call => ['ls --json', 'rm --force ' + name, 'policy ls --json'].includes(call)),
        'unexpected command: ' + calls.join(' | '));
    });
  });
}

test('live sbx integration (real binary)', async (t) => {
  if (!(await sbxOnPath())) {
    console.log('SKIP: sbx not installed — skipping live sbx integration test');
    t.skip('sbx not installed');
    return;
  }
  const backend = new DockerSbxBackend();
  const report = await backend.probeCapabilities();
  assert.equal(typeof report.available, 'boolean');
  assert.equal(report.preflight.checks.length, 9);
});


async function withPolicyStub(mode, fn, backendOptions = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-policy-stub-'));
  const bin = path.join(dir, 'sbx');
  const logPath = path.join(dir, 'argv.jsonl');
  const script = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    "if (args[0] === 'daemon' && args[1] === 'status') { console.log('Status: running'); process.exit(0); }",
    'const mode = ' + JSON.stringify(mode) + ';',
    'if (args[0] === "secret") { console.log(\'{"secrets":[],"custom_secrets":[],"shadowed_services":[],"env_only_count":0}\'); process.exit(0); }',
    'if (args[0] === "settings") { if (args[1] === "get" && args[2] === "ssh.agentForwardingEnabled") console.log("false"); process.exit(0); }',
    'fs.appendFileSync(' + JSON.stringify(logPath) + ', JSON.stringify({ args, pid: process.pid }) + "\\n");',
    // Policy commands run against a stateful model of sbx's policy (global allowances, deny precedence), shared across invocations.
    "(async () => {",
    "  const { createSbxPolicy } = await import(" + JSON.stringify(new URL('./helpers/sbx-policy-model.mjs', import.meta.url).href) + ");",
    "  const model = createSbxPolicy({ statePath: " + JSON.stringify(path.join(dir, 'policy-state.json')) + " });",
    "  if (args[0] === 'run') model.createSandbox(args[args.indexOf('--name') + 1], { kitAllow: ['api.anthropic.com:443'],",
    "    denyNetwork: args.flatMap((arg, i) => arg === '--deny-network' ? [args[i + 1]] : []) });",
    "  if (args[0] === 'rm') model.removeSandbox(args.at(-1));",
    "  if (args[0] === 'policy') {",
    "    const result = model.run(args);",
    "    if (args[1] === 'check') {",
    "      const target = args.at(-1);",
    "      const denied = ['10.0.0.1', '192.168.1.1', '169.254.169.254', 'example.com', 'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org'].includes(target);",
    "      let allowed = JSON.parse(result.stdout).allowed;",
    "      if (mode === 'unknown' && denied) { console.log('{}'); return; }",
    "      if (mode === 'bad-private' && target === '10.0.0.1') allowed = true;",
    "      console.log(JSON.stringify({ allowed })); if (!allowed) process.exitCode = 1; // real sbx 0.48 exits 1 on deny",
    "      return;",
    "    }",
    "    process.stdout.write(result.stdout); process.stderr.write(result.stderr); if (result.code) process.exitCode = result.code;",
    "  } else if (args[0] === 'ls') {",
    "    console.log(JSON.stringify(Object.keys(model.state.sandboxes).map(name=>({name,status:'running'}))));",
    "  } else if (mode === 'slow' && args[0] === 'exec' && args.includes('sh')) {",
    "    setTimeout(() => {}, 120000);",
    "  } else if (args[0] === 'cp') {",
    "    fs.mkdirSync(require('node:path').dirname(args.at(-1)), { recursive: true });",
    "    fs.writeFileSync(args.at(-1), '123456');",
    "  }",
    "})();",
  ].join('\n');
  await writeFile(bin, script, { mode: 0o755 });
  const previous = process.env.FARAVAN_SBX_BIN;
  process.env.FARAVAN_SBX_BIN = bin;
  const backend = new DockerSbxBackend(backendOptions);
  const calls = async () => (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  try { await fn({ backend, calls }); } finally {
    if (previous === undefined) delete process.env.FARAVAN_SBX_BIN;
    else process.env.FARAVAN_SBX_BIN = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

for (const egress of ['internet', 'provider-only']) {
  test('policy argv, resource flags and verification ordering for ' + egress, async () => {
    await withPolicyStub('ok', async ({ backend, calls }) => {
      const job = validJob({ egress, github_access_required: true });
      const handle = await backend.prepare(job);
      try {
        await backend.start(handle);
        const argv = (await calls()).map((call) => call.args);
        const create = argv.find((args) => args[0] === 'create' || args[0] === 'run');
        const options = [...new Set(create.filter((arg) => arg.startsWith('-')))];
        assert.deepEqual(options.sort(), SBX_RUN_OPTIONS.filter((flag) => flag !== '-d').sort(), 'doctor contract must cover the conditional kit too; a created sandbox gets no start flag');
        for (const range of PRIVATE_NETWORK_DENIES) {
          assert.ok(create.some((arg, i) => arg === '--deny-network' && create[i + 1] === range), range);
        }
        for (const [flag, value] of [['--cpus', '2'], ['--memory', '4096m'], ['--skills', 'off']]) {
          assert.equal(create[create.indexOf(flag) + 1], value);
        }
        assert.equal(create.includes('--static-mcp'), false, 'sbx 0.48 rejects --static-mcp none; no static MCP set is passed');
        const deny = argv.find((args) => args[0] === 'policy' && args[1] === 'deny');
        assert.deepEqual(deny.slice(0, 5), ['policy', 'deny', 'network', '--sandbox', handle.sandbox_id]);
        // Non-internet jobs also deny every registry they did not name: sbx's global policy may allow them.
        const denied = deny[5].split(',');
        assert.deepEqual(denied.slice(0, egress === 'internet' ? undefined : PRIVATE_NETWORK_DENIES.length + 3), egress === 'internet' ? PRIVATE_NETWORK_DENIES
          : [...PRIVATE_NETWORK_DENIES, ...Object.values(REGISTRY_HOSTS).flat()]);
        // A restricted job also denies every inherited allowance it did not ask for (sbx's global default has ~190).
        if (egress !== 'internet') for (const host of ['**.amazonaws.com:443', '**.googleapis.com:443', 'github.com:443']) assert.ok(denied.includes(host), host);
        const allow = argv.find((args) => args[0] === 'policy' && args[1] === 'allow');
        assert.equal(allow.at(-1), egress === 'internet' ? '**' : job.provider_hosts.join(','));
        const checks = argv.flatMap((args, i) => args[0] === 'policy' && args[1] === 'check' ? [i] : []);
        const jobExec = argv.findIndex((args) => args[0] === 'exec' && args.includes('sh'));
        assert.equal(egress === 'internet' ? checks.length === 6 : checks.length >= 8 + 30, true,
          'provider-only also proves each registry host and each inherited allowance is denied');
        assert.ok(checks.every((i) => i < jobExec));
        assert.equal(handle._policyVerification['10.0.0.1'], 'denied');
        assert.equal(handle._policyVerification['api.openai.com'], 'allowed');
        assert.equal(handle._execution.egress_evidence, null);
        assert.deepEqual(handle._execution.enforced_limits, ENFORCED_LIMITS);
        assert.deepEqual(handle._execution.unenforced, UNENFORCED_LIMITS);
      } finally { await backend.destroy(handle); }
    });
  });
}

for (const mode of ['bad-private', 'unknown']) {
  test('policy verification fails closed and removes sandbox for ' + mode, async () => {
    await withPolicyStub(mode, async ({ backend, calls }) => {
      await assert.rejects(backend.prepare(validJob()), (error) => {
        assert.equal(error.code, 'policy_unenforceable');
        assert.equal(error.cleanup_receipt.removed, true);
        return true;
      });
      const argv = (await calls()).map((call) => call.args);
      assert.ok(argv.some((args) => args[0] === 'rm'));
      assert.equal(argv.some((args) => args[0] === 'exec' && args.includes('sh')), false);
    });
  });
}

for (const streaming of [false, true]) {
  test('wall deadline kills exec child and stops/removes sandbox, streaming=' + streaming, {timeout:120000}, async () => {
    const deadlineTimers=manualTimers();
    let elapsed=0;
    await withPolicyStub('slow', async ({ backend, calls }) => {
      const job = validJob();
      job.resources.wall_seconds = 1;
      const handle = await backend.prepare(job);
      const execution=backend.start(handle, streaming ? { onLog() {} } : {});
      // Attach the rejection handler before the explicit deadline can fire.
      execution.catch(()=>{});
      try {
        const child=await waitForExec(calls);
        assert.doesNotThrow(()=>process.kill(child.pid,0),'exec child is alive before expiry');
        elapsed=1000;deadlineTimers.fire(1000);
        await assert.rejects(execution, { code: 'wall_timeout' });
        const records = await calls();
        assert.ok(records.some(({ args }) => args[0] === 'stop'));
        assert.ok(records.some(({ args }) => args[0] === 'rm'));
        assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
        await assert.rejects(backend.start({ ...handle }), { code: 'wall_timeout' });
      } finally {
        // Clean up even if observation or an assertion fails before expiry.
        handle._deadline.controller.abort();
        await execution.catch(()=>{});
        await handle._deadline.cleanup;
        await backend.destroy(handle);
      }
    }, {deadlineTimers,monotonic:()=>elapsed});
  });
}

test('output limit rejects cumulative declared bytes, not just individual files', async () => {
  await withPolicyStub('ok', async ({ backend }) => {
    backend.streamOutput = async function* () { yield Buffer.alloc(6); };
    const job = validJob();
    job.resources.output_bytes = 10;
    const handle = await backend.prepare(job);
    try {
      await assert.rejects(backend.collectDeclaredOutputs(handle, ['first', 'second']), { code: 'output_too_large' });
    } finally { await backend.destroy(handle); }
  });
});

test('Gemini required endpoints pass the effective policy while unrelated Google products stay denied', async () => {
  const model = createSbxPolicy({ globalRules: [] });
  const required = ['generativelanguage.googleapis.com', 'oauth2.googleapis.com'];
  model.createSandbox('gemini-policy-fixture', { kitAllow: required });
  const backend = new DockerSbxBackend({ runCommand: async args => model.run(args) });
  const handle = { ...testSbxRuntimeFields(), sandbox_id: 'gemini-policy-fixture', _image: 'gemini', _egress: 'provider-only',
    _providerHosts: required, _registryHosts: [], _sourceHosts: [] };
  await backend._configureEgress(handle);
  for (const host of [...required, 'storage.googleapis.com', 'bigquery.googleapis.com']) {
    const result = model.run(['policy', 'check', 'network', '--sandbox', handle.sandbox_id, '--json', host]);
    assert.equal(JSON.parse(result.stdout).allowed, required.includes(host), host);
  }
});

test('strict policy JSON adapter rejects unknown, conflicting and failed decisions', () => {
  const parse = (value, code = 0) => parseNetworkPolicyDecision({ code, stdout: JSON.stringify(value) });
  assert.equal(parse({ allowed: true }), 'allowed');
  assert.equal(parse({ allowed: false }), 'denied');
  assert.equal(parse({ decision: 'ALLOW' }), 'allowed');
  assert.equal(parse({ verdict: 'blocked' }), 'denied');
  assert.equal(parse({ result: 'denied' }), 'denied');
  for (const value of [{}, [], null, { allowed: 'true' }, { result: 'unknown' }, { allowed: true, decision: 'deny' }]) {
    assert.equal(parse(value), 'unknown');
  }
  // sbx 0.48 exits 1 for a denied decision and still prints the JSON.
  assert.equal(parse({ allowed: false }, 1), 'denied');
  assert.equal(parse({ allowed: true }, 1), 'unknown');
  assert.equal(parse({ allowed: false }, 2), 'unknown');
  assert.equal(parseNetworkPolicyDecision({ code: 0, stdout: 'not JSON' }), 'unknown');
});

test('admission declines unenforceable limits and legacy opaque policy before side effects', () => {
  assert.equal(admitDockerJob(validJob()).ok, true);
  const legacy = validJob({ egress: undefined, egress_policy_id: 'wf-relay-v0', capability_token: 'old' });
  assert.equal(admitDockerJob(legacy).code, 'policy_unenforceable');
  for (const limit of UNENFORCED_LIMITS) assert.equal(admitDockerJob(validJob({ required_limits: [limit] })).code, limit === 'storage' ? 'storage_unenforceable' : 'limits_unenforceable');
  const tooSmall = validJob();
  tooSmall.resources.memory_mib = 256;
  assert.equal(admitDockerJob(tooSmall).code, 'limits_unenforceable');
});


async function withRecordedSbx(body, work) {
  const dir = await writeStub('v1-evidence', 'echo "$@" >> "$WF_STUB_LOG"\n' + body);
  const keys = ['FARAVAN_SBX_BIN', 'WF_STUB_LOG', 'FARAVAN_SBX_HOME'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.FARAVAN_SBX_BIN = path.join(dir, 'sbx');
  process.env.WF_STUB_LOG = path.join(dir, 'argv.log');
  process.env.FARAVAN_SBX_HOME = dir;
  try { await work(dir, () => readFile(path.join(dir, 'argv.log'), 'utf8')); }
  finally {
    for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    await rm(dir, {recursive:true, force:true});
  }
}

test('v1 pinned Git clones inside primary sandbox and records exact HEAD with no gh fallback', async () => {
  const commit = 'a'.repeat(40);
  await withRecordedSbx('case "$*" in *rev-parse*) echo ' + commit + ';; esac', async (_dir, log) => {
    const handle = { ...testSbxRuntimeFields(),sandbox_id:'wf-pinned',_execution:{}};
    await preparedCommandBackend().cloneGitSource(handle,{kind:'git',url:'https://example.com/project.git',commit});
    assert.equal(handle._execution.verified_commit,commit);
    const calls = (await log()).trim().split('\n');
    assert.equal(calls.length,3);
    assert.ok(calls.every(line=>line.startsWith('exec wf-pinned -- ')));
    assert.match(calls[0],/credential.helper= .*http.followRedirects=false .*clone --no-checkout -- 'https:\/\/example.com\/project.git' repo/);
    assert.match(calls[1],/checkout --detach/);
    assert.match(calls[2],/git -C repo rev-parse --verify HEAD$/);
    assert.ok(!calls.some(line=>line.includes('gh repo')||line.startsWith('run ')));
  });
});

test('v1 pinned Git rejects credentials and malformed commits before any command', async () => {
  const backend = new DockerSbxBackend();
  backend._runJobCommand = () => { throw new Error('must not execute'); };
  for (const source of [
    {url:'https://user:secret@example.com/repo',commit:'a'.repeat(40)},
    {url:'ssh://example.com/repo',commit:'a'.repeat(40)},
    {url:'https://example.com/repo?token=secret',commit:'a'.repeat(40)},
    {url:'https://example.com/repo',commit:'main'},
    {url:'https://example.com/repo'},
  ]) await assert.rejects(backend.cloneGitSource({}, {kind:'git',...source}),{code:'git_source_invalid'});
});

test('v1 pinned Git fails closed on mismatched, extra, missing or failed HEAD and clone failure', async () => {
  for (const output of ['b'.repeat(40), 'a'.repeat(40)+' extra', '', 'a'.repeat(40)+'\nnoise']) {
    await withRecordedSbx('case "$*" in *rev-parse*) printf "%s" ' + JSON.stringify(output) + ';; esac', async () => {
      const handle={ ...testSbxRuntimeFields(),sandbox_id:'wf-pinned',_execution:{}};
      await assert.rejects(preparedCommandBackend().cloneGitSource(handle,{kind:'git',url:'https://example.com/repo',commit:'a'.repeat(40)}),{code:'git_commit_mismatch'});
      assert.equal(handle._execution.verified_commit,undefined);
    });
  }
  await withRecordedSbx('exit 1', async (_dir,log)=>{
    await assert.rejects(preparedCommandBackend().cloneGitSource({...testSbxRuntimeFields(),sandbox_id:'wf-pinned'},{kind:'git',url:'https://example.com/repo',commit:'a'.repeat(40)}),{code:'git_source_unavailable'});
    assert.equal((await log()).trim().split('\n').length,1);
  });
});

test('reconcilePending removes only the attempt sandboxes its records created and proves absence with fresh listing', async () => {
  // `sbx ls --json` shape verified on sbx 0.50.1 and 0.48.0.
  const jobId='recovery-job', primary='wf-'+'1a'.repeat(8), auxiliary='wf-'+'2b'.repeat(8);
  // Names derived from the job are listed too: they are never removal authority.
  const listed=[primary,auxiliary,testSandboxName(jobId),testSandboxName(jobId+'-git'),'unrelated'];
  const ls=`out=""; for n in ${listed.join(' ')}; do grep -qx "$n" "$state" 2>/dev/null || out="$out\${out:+,}{\\"name\\":\\"$n\\",\\"status\\":\\"running\\"}"; done; echo "[$out]"`;
  await withRecordedSbx(`state="$(dirname "$0")/removed"\ncase "$1" in\nls) ${ls};;\nrm) echo "$3" >> "$state";;\nesac`, async (dir,log)=>{
    const cleanupDirectory=path.join(dir,'cleanup');
    const backend=new DockerSbxBackend({cleanupDirectory});
    for(const [job,name] of [[jobId,primary],[jobId+'-git',auxiliary]])
      await writeCreateReceipt(cleanupDirectory,{jobId:job,name,ownerScope:sandboxOwnerScope(),home:_internal.sbxHome(),scratchRoot:_internal.scratchRoot(),profileHome:backend._profileHome});
    const result=await backend.reconcilePending({owner_scope:sandboxOwnerScope(),sbx_home:_internal.sbxHome(),attemptId:'attempt-1',attempt:{attempt_id:'attempt-1'},jobId,sandboxId:primary});
    assert.equal(result.removed,true);
    assert.equal(result.attemptId,'attempt-1');
    const lines=(await log()).trim().split('\n');
    assert.deepEqual(lines.filter(line=>line.startsWith('rm ')).sort(),['rm --force '+primary,'rm --force '+auxiliary].sort());
    // Each removal is proven by a fresh listing, and each record cleans its own policies.
    assert.equal(lines.filter(line=>line==='ls --json').length,4);
    assert.equal(lines.filter(line=>line==='policy ls --json').length,2);
  });
});

test('a cleanup record written before runtimes were recorded is still removed, and an account record without a runtime is refused', async () => {
  const jobId='legacy-row-job', name='wf-'+'4d'.repeat(8);
  const body=`state="$(dirname "$0")/removed"\ncase "$1" in\nls) grep -qx ${name} "$state" 2>/dev/null && echo "[]" || echo '[{"name":"${name}","status":"running"}]';;\nrm) echo "$3" >> "$state";;\nesac`;
  for (const accountKey of [null,'claude:5b1f0c52-3d1a-4e6b-9c0e-7a2f4d8e1b36']) await withRecordedSbx(body, async (dir,log)=>{
    const cleanupDirectory=path.join(dir,'cleanup');
    const backend=new DockerSbxBackend({cleanupDirectory});
    const id=await writeCreateReceipt(cleanupDirectory,{jobId,name,ownerScope:sandboxOwnerScope(),home:_internal.sbxHome(),scratchRoot:_internal.scratchRoot(),profileHome:backend._profileHome});
    const file=path.join(cleanupDirectory,id+'.json'), row=JSON.parse(await readFile(file,'utf8'));
    delete row.sbx_runtime;if(accountKey)row.account_key=accountKey;
    await writeFile(file,JSON.stringify(row));
    const result=await backend.reconcilePending({owner_scope:sandboxOwnerScope(),sbx_home:_internal.sbxHome(),attemptId:'attempt-1',attempt:{attempt_id:'attempt-1'},jobId,sandboxId:name});
    assert.equal(result.removed,accountKey===null,'a default-account record with no runtime is removable; an account record with none fails closed');
    assert.equal((await log().catch(()=>'')).includes('rm --force '+name),accountKey===null);
  });
});

test('reconcilePending fails closed on unknown listing, rm success without disappearance and invalid identity', async () => {
  const jobId='recovery-job',primary='wf-'+'3c'.repeat(8);
  for (const body of ['exit 0','echo "unrecognized output"',"echo '[{\"name\":\""+primary+"\",\"status\":\"running\"}]'",'echo "[{]"','exit 1']) {
    await withRecordedSbx(body,async dir=>{
      const cleanupDirectory=path.join(dir,'cleanup');
      await writeCreateReceipt(cleanupDirectory,{jobId,name:primary,ownerScope:sandboxOwnerScope(),home:_internal.sbxHome(),scratchRoot:_internal.scratchRoot()});
      const pending={owner_scope:sandboxOwnerScope(),sbx_home:_internal.sbxHome(),attemptId:'attempt-1',attempt:{attempt_id:'attempt-1'},jobId};
      assert.equal((await new DockerSbxBackend({cleanupDirectory}).reconcilePending(pending)).removed,false);
    });
  }
  const backend=new DockerSbxBackend();
  const pending={owner_scope:sandboxOwnerScope(),sbx_home:_internal.sbxHome(),attemptId:'attempt-1',attempt:{attempt_id:'attempt-1'},jobId};
  assert.equal((await backend.reconcilePending({...pending,attemptId:'other'})).removed,false);
  assert.equal((await backend.reconcilePending({...pending,jobId:undefined})).removed,false);
});

test('protectionSummary is read-only, exposes preferred disk and blocks required disk, low host disk or unknown version', async () => {
  const calls=[];
  const options={platformName:'darwin',sbxHomePath:'/Users/a/.wfsbx',userHome:'/Users/a',realpathPath:path=>path==='/Users/a/Library/Keychains'||path==='/Users/a/.wfsbx/Library/Keychains'?'/Users/a/Library/Keychains':null,runCommand:async (_command,args)=>{
    calls.push(args.join(' '));
    if(args.join(' ')==='ls -q')return {code:0,stdout:''};
    if(args.join(' ')==='run --help')return {code:0,stdout:SBX_RUN_HELP};
    if(args[0]==='version')return {code:0,stdout:'sbx version 0.51.0'};
    if(args[0]==='diagnose')return {code:0,stdout:'Daemon healthy\nDocker authentication healthy'};
    if(args.join(' ')==='policy ls')return {code:0,stdout:'Policy rules'};
    throw new Error('unexpected mutating command');
  }};
  let free=20*1024**3, runtimeReady=true;
  const backend=new DockerSbxBackend({hostDisk:{free:async()=>({free})},guestRuntime:async()=>{if(!runtimeReady)throw new Error('missing runtime');return {node:'/data/node'};}});
  const requirements={egress:'internet',limits:{cpu:2,memory_bytes:4294967296,wall_seconds:1200,output_bytes:16777216,disk_bytes:4294967296},limit_modes:{disk_bytes:'preferred'}};
  const summary=await backend.protectionSummary(requirements,options);
  assert.equal(summary.satisfied,true);
  runtimeReady=false;
  const blocked=await backend.protectionSummary(requirements,options);
  assert.equal(blocked.satisfied,false);
  assert.equal(blocked.reason,'guard_runtime_unavailable');
  const runtimeCheck=blocked.preflight.checks.find(c=>c.name==='guard_runtime');
  assert.equal(runtimeCheck.ok,false);
  assert.match(runtimeCheck.detail,/Update Faravan.*reinstall Faravan/);
  runtimeReady=true;
  assert.equal((await backend.protectionSummary(requirements,options)).preflight.checks.some(c=>c.reason==='guard_runtime_unavailable'),false);
  assert.ok(summary.preflight.checks.some(c => c.name === 'host_disk' && c.ok));
  assert.equal(summary.preflight.checks.some(c => c.name === 'storage_enforcement'),false);
  assert.deepEqual(summary.limits.unenforced,['disk_bytes']);
  assert.equal(summary.version_gate.ok,true);
  assert.equal(summary.source,'read-only-preflight');
  assert.ok(calls.every(call=>['version','diagnose','ls -q','policy ls','run --help'].includes(call)));
  assert.equal((await backend.protectionSummary({...requirements,limit_modes:{}},options)).satisfied,false);
  assert.equal((await backend.protectionSummary({...requirements,egress:'unknown'},options)).satisfied,false);
  free=7*1024**3;
  const low=await backend.protectionSummary(requirements,options);
  assert.equal(low.satisfied,false);
  assert.equal(low.reason,'host_disk_low');
  assert.ok(low.preflight.checks.some(c => c.name === 'host_disk' && !c.ok && /low on disk space/.test(c.detail)));
  free=20*1024**3;
  const unknown={...options,runCommand:async (command,args)=>args[0]==='version'?{code:0,stdout:'unrecognized'}:options.runCommand(command,args)};
  assert.equal((await backend.protectionSummary(requirements,unknown)).satisfied,false);
  const malformedVersion={...options,runCommand:async (command,args)=>args[0]==='version'?{code:0,stdout:'sbx/0.41.0'}:options.runCommand(command,args)};
  assert.equal((await backend.lenderCapabilities(malformedVersion)).available,false);
  const malformedSummary=await backend.protectionSummary(requirements,malformedVersion);
  assert.equal(malformedSummary.satisfied,false);
  assert.equal(malformedSummary.version_gate.ok,false);
});

test('v1 pinned SHA256 source and failed HEAD are handled without executing guest git in tests', async () => {
  const commit='c'.repeat(64);
  await withRecordedSbx('case "$*" in *rev-parse*) echo '+commit+';; esac',async()=>{
    const handle={ ...testSbxRuntimeFields(),sandbox_id:'wf-pinned',_execution:{}};
    await preparedCommandBackend().cloneGitSource(handle,{kind:'git',url:'https://example.com/repo',object_format:'sha256',commit});
    assert.equal(handle._execution.verified_commit,commit);
  });
  await withRecordedSbx('case "$*" in *rev-parse*) exit 1;; esac',async()=>{
    const handle={ ...testSbxRuntimeFields(),sandbox_id:'wf-pinned',_execution:{verified_commit:'old'}};
    await assert.rejects(preparedCommandBackend().cloneGitSource(handle,{kind:'git',url:'https://example.com/repo',object_format:'sha1',commit:'a'.repeat(40)}),{code:'git_commit_mismatch'});
    assert.equal(handle._execution.verified_commit,undefined);
  });
});

test('reconciliation accepts an empty JSON listing but rejects tables, partial, duplicate or nameless output', async () => {
  const {parseSbxListing}=await import('../lib/docker-backend.mjs');
  const parse=stdout=>parseSbxListing({code:0,stdout});
  assert.deepEqual(parse('[]\n'),[]);
  assert.deepEqual(parse('[{"name":"wf-one","status":"running"}]'),['wf-one']);
  for(const stdout of ['', 'NAME STATUS\n', 'NAME STATUS\nwf-one running', '[{"name":"wf-one"},{"name":"wf-one"}]',
    '[{"status":"running"}]', '{"name":"wf-one"}', '[{"name":"../x"}]']) assert.equal(parse(stdout),null);
  const pending={owner_scope:sandboxOwnerScope(),sbx_home:_internal.sbxHome(),attemptId:'attempt',attempt:{attempt_id:'attempt'},jobId:'never-created'};
  await withRecordedSbx('echo "[]"',async(_dir,log)=>{
    pending.sbx_home=_internal.sbxHome();
    // No record reserved a name for this attempt, so no create was ever dispatched.
    assert.equal((await new DockerSbxBackend().reconcilePending(pending)).removed,true);
    assert.equal(await log().catch(()=>''),'','recovery runs no sbx command without a record');
  });
});

test('pinned HEAD rejects a second trailing newline rather than trimming unknown output', async () => {
  await withRecordedSbx('case "$*" in *rev-parse*) printf "'+'a'.repeat(40)+'\\n\\n";; esac',async()=>{
    await assert.rejects(preparedCommandBackend().cloneGitSource({...testSbxRuntimeFields(),sandbox_id:'wf-pinned'},{kind:'git',url:'https://example.com/repo',commit:'a'.repeat(40)}),{code:'git_commit_mismatch'});
  });
});

test('protection summary does not admit a Git source outside provider-only egress', async () => {
  const backend=new DockerSbxBackend({guestRuntime:async()=>({node:'/data/node'})});
  backend.lenderCapabilities=async()=>({available:true,egress:['internet','provider-only'],enforced_limits:['cpu'],max_limits:{cpu:256},
    preflight:{version:'sbx version 0.51.0',checks:[{name:'sbx_version',ok:true,status:'passed'}]}});
  const requirements={egress:'provider-only',limits:{cpu:2}};
  const source={kind:'git',url:'https://github.com/owner/repo',commit:'a'.repeat(40)};
  // S5.4: runJob installs github.com and codeload.github.com itself for a GitHub source,
  // so the provider's own hosts no longer have to cover GitHub.
  assert.equal((await backend.protectionSummary(requirements,{source,providerHosts:['**.openai.com']})).satisfied,true);
  const missing=await backend.protectionSummary(requirements,{source:{...source,url:'https://other.example/repo'},providerHosts:['**.openai.com']});
  assert.equal(missing.satisfied,false);
  assert.equal(missing.egress.source_reason,'git_source_egress_unsupported');
  assert.equal((await backend.protectionSummary(requirements,{source,providerHosts:['github.com']})).satisfied,true);
  assert.equal((await backend.protectionSummary(requirements,{source:{...source,url:'https://other.example/repo'},providerHosts:['github.com']})).satisfied,false);
  assert.equal((await backend.protectionSummary({...requirements,egress:'internet'},{source})).satisfied,true);
});

test('parseSbxListing reads real `sbx ls --json` output and fails closed on the 0.48 human table', async () => {
  const { parseSbxListing } = await import('../lib/docker-backend.mjs');
  const json = JSON.stringify([
    { name: 'wf-01e475ece1ec7edc', id: 'f6135deb-83a8-49c0-95f6-b39de4a543bc', agent: 'codex', status: 'stopped',
      workspaces: ['/x/wf-job-1'], created_at: '2026-07-22T17:53:01Z', workspace_missing: true, detached: true },
    { name: 'wf-8590dc61a1148b8d', agent: 'codex', status: 'running', detached: true },
  ], null, 2);
  assert.deepEqual(parseSbxListing({ code: 0, stdout: json, stderr: '' }), ['wf-01e475ece1ec7edc', 'wf-8590dc61a1148b8d']);
  assert.deepEqual(parseSbxListing({ code: 0, stdout: '[]', stderr: '' }), []);
  assert.equal(parseSbxListing({ code: 0, stdout: '[{"status":"running"}]', stderr: '' }), null);
  assert.equal(parseSbxListing({ code: 1, stdout: json, stderr: '' }), null);
  const table = 'SANDBOX               AGENT       STATUS                 PORTS   WORKSPACE        CREATED\n' +
    'wf-01e475ece1ec7edc   codex       ○ stopped (detached)           /x (missing)     2mo\n';
  assert.equal(parseSbxListing({ code: 0, stdout: table, stderr: '' }), null);
});

test('parseNetworkPolicyDecision reads the JSON body when sbx exits 1 for a denied decision', async () => {
  const { parseNetworkPolicyDecision } = await import('../lib/docker-backend.mjs');
  assert.equal(parseNetworkPolicyDecision({ code: 1, stdout: '{"allowed": false, "target": "10.0.0.1"}' }), 'denied');
  assert.equal(parseNetworkPolicyDecision({ code: 0, stdout: '{"allowed": true}' }), 'allowed');
  assert.equal(parseNetworkPolicyDecision({ code: 1, stdout: 'error: no such sandbox' }), 'unknown');
  assert.equal(parseNetworkPolicyDecision({ code: 2, stdout: '{"allowed": false}' }), 'unknown');
});

test('sbx commands get a closed stdin, so an agent that reads stdin cannot hang the run (live 2026-10-18)', { timeout: 20_000 }, async () => {
  const previousBin = process.env.FARAVAN_SBX_BIN;
  // The stub reads stdin to EOF before answering, like `codex exec` did
  // ("Reading additional input from stdin..."). An open pipe never reaches EOF.
  const stubDir = await writeStub('stdin-reader', 'cat >/dev/null; echo "[]"');
  process.env.FARAVAN_SBX_BIN = path.join(stubDir, 'sbx');
  try {
    const started = Date.now();
    assert.equal(await new DockerSbxBackend()._sandboxExists('wf-anything'), false);
    assert.ok(Date.now() - started < 10_000, 'stdin reached EOF instead of waiting for the 30 s timeout');
  } finally {
    if (previousBin === undefined) delete process.env.FARAVAN_SBX_BIN;
    else process.env.FARAVAN_SBX_BIN = previousBin;
    await rm(stubDir, { recursive: true, force: true });
  }
});

function workspaceRunner({ failure = '', failAt = 'create', listing = 'live', secretResult = '{"secrets":[],"custom_secrets":[],"shadowed_services":[],"env_only_count":0}' } = {}) {
  const calls = [], policy = createSbxPolicy();
  let sandbox,exists=false;
  const runCommand = async (args, options) => {
    calls.push({ args: [...args], options });
    if (args[0] === 'settings') return { code: 0, stdout: args[1] === 'get' && args[2] === 'ssh.agentForwardingEnabled' ? 'false' : '' };
    if (args[0] === 'secret') return { code: 0, stdout: secretResult, stderr: '' };
    if (args[0] === 'run' || args[0] === 'create') { sandbox = args[args.indexOf('--name') + 1];exists=!(args[0]===failAt&&failure); if (!(args[0] === failAt && failure)) policy.createSandbox(sandbox, { kitAllow: ['api.anthropic.com:443'] }); }
    if (args[0] === 'rm')exists=false;
    if (args[0] === 'policy') return policy.run(args);
    if (args[0] === failAt && failure) return { code: 1, exited: true, stderr: failure, stdout: '' };
    if (args[0] === 'ls') return { code: 0, stdout: listing === 'unknown' ? 'unexpected output' :
      JSON.stringify(listing === 'present'||listing==='live'&&exists ? [{ name: sandbox, status: 'running' }] : []), stderr: '' };
    if (args[0] === 'policy' && args[1] === 'check') {
      return { code: 0, stdout: JSON.stringify({ allowed: !['10.0.0.1', '192.168.1.1', '169.254.169.254', 'example.com', 'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org'].includes(args.at(-1)) }), stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { calls, runCommand };
}

function startHandle() {
  return { ...testSbxRuntimeFields(), backend_id: 'docker-sbx', job_id: 'synthetic-job', sandbox_id: 'synthetic-exec', scratch_dir: '/unused',
    _entrypoint: 'agent --run',
    _deadline: { controller: new AbortController(), expired: false, handles: new Set(), endsAt: performance.now() + 60_000 } };
}

test('testWorkspace shares prepare/start, minimal resources, disabled network and verified cleanup', async () => {
  const stub = workspaceRunner();
  const timers = manualTimers();
  const backend = new DockerSbxBackend({ runCommand: stub.runCommand, deadlineTimers: timers });
  const prepared = [];
  const prepare = backend.prepare.bind(backend);
  backend.prepare = async (job, options) => {
    assert.equal(options?.separatePreparationClock, true);
    prepared.push(job);
    return prepare(job, options);
  };
  const result = await backend.testWorkspace();
  assert.equal(result.ok, true);
  assert.equal(result.cause, null);
  assert.equal(result.detail, 'Faravan started and removed a test workspace.');
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].entrypoint, 'true');
  assert.equal(prepared[0].egress, 'provider-only');
  assert.equal(prepared[0].resources.cpu, 1);
  assert.equal(prepared[0].resources.memory_mib, 512);
  assert.equal(prepared[0].resources.wall_seconds, 60);
  assert.ok(stub.calls.some(({args}) => args[0] === 'exec' && args.slice(2).join(' ') === '-- sh -c true'));
  const remove = stub.calls.findIndex(({args}) => args[0] === 'rm');
  assert.ok(remove >= 0 && stub.calls.slice(remove + 1).some(({args}) => args[0] === 'ls'));
  assert.ok(!stub.calls.some(({args}) => args[0] === 'login'));
});

// Guest network witness: opt-in at prepare, run right after the egress policy is installed, additive to the host's own checks.
// `addresses` are the owned listeners. `control` and `hits` are one value for every listener, or a map by address.
function witnessWorkspace({ hits = 0, control = true, guestStdout, counts = [[0, 0], [0, 2]], portless = false, addresses = ['192.168.7.9'] } = {}) {
  const stub = workspaceRunner(), timers = manualTimers();
  const nonce = 'witness-nonce';
  const ports = Object.fromEntries(addresses.map((address, index) => [address, 40123 + index]));
  const healthy = address => typeof control === 'object' ? control[address] !== false : control;
  const hitsFor = address => typeof hits === 'object' ? hits[address] ?? 0 : hits;
  const queue = [...counts], seen = { witnessExec: [], listens: [], logs: 0, closed: 0 };
  const runCommand = async (args, options) => {
    if (args[0] === 'policy' && args[1] === 'log') {
      seen.logs += 1;
      stub.calls.push({ args: [...args], options });
      const [allowed, blocked] = queue.shift() ?? [0, 0];
      // Every endpoint shares this read's counts: one row per listener, exact address:port (port-less when portless).
      const rows = count => count ? addresses.map(address => ({ sandbox_id: args[2], host: portless ? address : address + ':' + ports[address], count })) : [];
      return { code: 0, stdout: JSON.stringify({ allowed: rows(allowed), blocked: rows(blocked) }), stderr: '' };
    }
    if (args[0] === 'exec' && args.includes('WITNESS_NONCE=' + nonce)) {
      stub.calls.push({ args: [...args], options });
      seen.witnessExec.push([...args]);
      const urls = args.find(arg => String(arg).startsWith('WITNESS_URLS=')).slice('WITNESS_URLS='.length).split(' ');
      const reply = urls.map((_, canary) => JSON.stringify({ schema: 1, nonce, canary: String(canary), direct: '52 000', configured: '0 403' })).join('\n') + '\n';
      return { code: 0, stdout: guestStdout ?? reply, stderr: '' };
    }
    return stub.runCommand(args, options);
  };
  const backend = new DockerSbxBackend({ runCommand, deadlineTimers: timers });
  const interfaces = { eth0: addresses.map(address => ({ address, family: 'IPv4', internal: false })) };
  backend._witnessOptions = { nonce, interfaces,
    listen: async address => {
      seen.listens.push(address);
      return { address, port: ports[address], url: `http://${address}:${ports[address]}/guest`, hits: () => hitsFor(address),
        control: async () => healthy(address), close: async () => { seen.closed += 1; } };
    } };
  return { backend, stub, seen };
}
const execIndex = (calls, test) => calls.findIndex(({ args }) => args[0] === 'exec' && test(args));

test('testWorkspace runs one guest network witness after the egress policy and before the workspace command, and reports it', async () => {
  const { backend, stub, seen } = witnessWorkspace();
  const prepare = backend.prepare.bind(backend);
  let option;
  backend.prepare = async (job, options) => { option = options.egressWitness; return prepare(job, options); };
  const result = await backend.testWorkspace();
  assert.equal(option, true);
  assert.equal(result.ok, true);
  assert.deepEqual([result.egress_witness.state, result.egress_witness.blockedDelta, result.egress_witness.allowedDelta], ['verified', 2, 0]);
  assert.deepEqual(result.egress_witness.uncovered, ['10.0.0.0/8', '172.16.0.0/12'], 'only the owned family is proven by the witness');
  assert.equal(seen.witnessExec.length, 1, 'exactly one guest command');
  const argv = seen.witnessExec[0];
  assert.deepEqual(argv.slice(0, 5), ['exec', '-e', 'WITNESS_URLS=http://192.168.7.9:40123/guest', '-e', 'WITNESS_NONCE=witness-nonce']);
  assert.deepEqual(argv.slice(6, 9), ['--', 'sh', '-c']);
  assert.equal(seen.closed, 1);
  const denyIndex = stub.calls.findIndex(({ args }) => args[0] === 'policy' && args[1] === 'deny');
  const witnessIndex = stub.calls.findIndex(({ args }) => args === seen.witnessExec[0] || args.join('\0') === argv.join('\0'));
  const workspaceIndex = execIndex(stub.calls, args => args.slice(2).join(' ') === '-- sh -c true');
  assert.ok(denyIndex >= 0 && denyIndex < witnessIndex && witnessIndex < workspaceIndex, 'after the policy is installed, before the workspace command');
  const isLog = call => call?.args[0] === 'policy' && call.args[1] === 'log';
  assert.ok(isLog(stub.calls[witnessIndex - 1]) && isLog(stub.calls[witnessIndex + 1]), 'a fresh policy log immediately before and after the guest command');
  assert.deepEqual([stub.calls[witnessIndex - 1].args.slice(2), stub.calls[witnessIndex + 1].args.slice(2)].map(rest => rest.length), [2, 2]);
  assert.equal(stub.calls[witnessIndex - 1].args[2], argv[5], 'scoped to the exact sandbox');
  assert.ok(stub.calls.some(({ args }) => args[0] === 'rm'), 'the test sandbox is still removed');
});

test('a guest that reaches the owned listener fails the workspace test before any workspace command, and the sandbox is removed', async () => {
  const { backend, stub, seen } = witnessWorkspace({ hits: 1 });
  const result = await backend.testWorkspace();
  assert.equal(result.ok, false);
  assert.equal(result.cause, 'unknown');
  assert.equal(execIndex(stub.calls, args => args.slice(2).join(' ') === '-- sh -c true'), -1, 'the workspace command never ran');
  assert.ok(stub.calls.some(({ args }) => args[0] === 'rm'));
  assert.equal(seen.closed, 1);
  const allowed = witnessWorkspace({ counts: [[0, 0], [1, 2]] });
  assert.equal((await allowed.backend.testWorkspace()).ok, false, 'an allowed decision for the owned address also fails');
});

test('a missing or ambiguous witness observation is reported inconclusive and never blocks or passes the workspace test', async () => {
  // Port-less rows could belong to other traffic from the sandbox to that address: never attributable to this run.
  for (const options of [{ guestStdout: 'garbage' }, { control: false }, { counts: [[0, 0], [0, 0]] }, { portless: true }]) {
    const { backend, seen } = witnessWorkspace(options);
    const result = await backend.testWorkspace();
    assert.equal(result.ok, true, JSON.stringify(options));
    assert.equal(result.egress_witness.state, 'inconclusive', JSON.stringify(options));
    if (options.control === false) assert.equal(seen.witnessExec.length, 0, 'no guest traffic without a healthy host control');
  }
});

test('preparation without the opt-in never starts a listener or a guest witness command', async () => {
  const { backend, seen } = witnessWorkspace();
  backend._witnessOptions.listen = async () => { throw new Error('a listener must not start'); };
  const fixture = gatedSentinelBackend({ wallSeconds: 60 });
  const prepared = fixture.backend.prepare(fixture.job, { separatePreparationClock: true });
  const outcome = prepared.then(handle => ({ handle }), error => ({ error }));
  await firstWave(fixture.held);
  await turns();
  await drainUntilSettled(outcome, fixture.held, fixture.release);
  const { handle, error } = await outcome;
  assert.equal(error, undefined);
  assert.equal(handle._egressWitness, undefined);
  assert.equal(seen.witnessExec.length, 0);
});

test('a multi-family host gets one canary per owned family under one guest command and two policy-log reads', async t => {
  const addresses = ['10.20.30.40', '172.20.0.5', '192.168.7.9'];
  const { backend, seen } = witnessWorkspace({ addresses });
  const result = await backend.testWorkspace();
  t.diagnostic(JSON.stringify({ state: result.egress_witness.state, canaries: result.egress_witness.canaries.length,
    guestExecs: seen.witnessExec.length, policyLogReads: seen.logs, listeners: seen.listens.length, closed: seen.closed,
    uncovered: result.egress_witness.uncovered }));
  assert.equal(result.ok, true);
  assert.deepEqual([result.egress_witness.state, result.egress_witness.blockedDelta, result.egress_witness.uncovered], ['verified', 6, []]);
  assert.deepEqual(result.egress_witness.canaries.map(canary => canary.address), addresses);
  assert.equal(seen.witnessExec.length, 1, 'one guest command for every canary');
  const urls = seen.witnessExec[0].find(arg => arg.startsWith('WITNESS_URLS=')).slice('WITNESS_URLS='.length).split(' ');
  assert.deepEqual(urls, addresses.map((address, index) => `http://${address}:${40123 + index}/guest`));
  // Two witness reads (before and after the one guest command) plus the teardown egress read that every run makes: 3, not a read per canary.
  assert.equal(seen.logs, 3, 'two witness reads and one teardown read, not a read per canary');
  assert.deepEqual([seen.listens, seen.closed], [addresses, 3]);
});

test('one canary without a healthy host control keeps the whole batch from starting', async () => {
  const addresses = ['10.20.30.40', '172.20.0.5', '192.168.7.9'];
  const { backend, seen } = witnessWorkspace({ addresses, control: { '172.20.0.5': false } });
  const result = await backend.testWorkspace();
  assert.equal(result.ok, true, 'an inconclusive witness never blocks');
  assert.deepEqual([result.egress_witness.state, result.egress_witness.reason], ['inconclusive', 'host_control_failed']);
  assert.equal(seen.witnessExec.length, 0, 'no guest traffic without every healthy host control');
  assert.equal(seen.logs, 1, 'no witness read: the one policy-log read is the teardown egress read that every run makes');
  assert.equal(seen.closed, 3, 'every listener is closed');
});

test('a partial guest reply to a multi-family batch is inconclusive, never a pass', async () => {
  const addresses = ['10.20.30.40', '172.20.0.5', '192.168.7.9'];
  const oneCanary = JSON.stringify({ schema: 1, nonce: 'witness-nonce', canary: '0', direct: '52 000', configured: '0 403' }) + '\n';
  const { backend, seen } = witnessWorkspace({ addresses, guestStdout: oneCanary });
  const result = await backend.testWorkspace();
  assert.equal(result.ok, true);
  assert.deepEqual([result.egress_witness.state, result.egress_witness.reason], ['inconclusive', 'guest_output_invalid']);
  assert.equal(seen.witnessExec.length, 1);
});

test('a leak to any one owned family fails the workspace test before its command runs', async () => {
  const addresses = ['10.20.30.40', '172.20.0.5', '192.168.7.9'];
  const { backend, stub } = witnessWorkspace({ addresses, hits: { '172.20.0.5': 1 } });
  const result = await backend.testWorkspace();
  assert.equal(result.ok, false);
  assert.equal(execIndex(stub.calls, args => args.slice(2).join(' ') === '-- sh -c true'), -1, 'the workspace command never ran');
  assert.ok(stub.calls.some(({ args }) => args[0] === 'rm'));
});

// Startup budget: how many watchdog proofs and sbx subprocesses one test workspace costs. Guest commands pass the production
// dispatch fence (beforeExec), so each one runs the same watchdog checks the agent's commands run.
test('startup budget: one test workspace freshly proves the watchdog at each launch and at run handoff', async t => {
  const stub = workspaceRunner();
  const counts = { guestExecs: 0, sbxSubprocesses: 0, sbx: {}, active: 0, activeSync: 0, identitySync: 0 };
  const runCommand = async (args, options) => {
    counts.sbxSubprocesses += 1;
    const kind = args[0] === 'policy' ? `policy ${args[1]}` : args[0];
    counts.sbx[kind] = (counts.sbx[kind] ?? 0) + 1;
    if (args[0] !== 'exec') return stub.runCommand(args, options);
    counts.guestExecs += 1;
    return options?.beforeExec ? options.beforeExec(() => stub.runCommand(args, options)) : stub.runCommand(args, options);
  };
  const backend = new DockerSbxBackend({ runCommand, deadlineTimers: manualTimers() });
  backend._injectedTransport = false; // this runner honors the same beforeExec hook as the native transport
  backend._witnessOptions = { interfaces: {} }; // no owned address: the witness starts no guest command
  const deadlines = backend.sandboxDeadlines, { active, activeSync, identitySync } = deadlines;
  deadlines.active = async row => { counts.active += 1; return active(row); };
  deadlines.activeSync = row => { counts.activeSync += 1; return activeSync(row); };
  if (identitySync) deadlines.identitySync = row => { counts.identitySync += 1; return identitySync(row); };
  const result = await backend.testWorkspace();
  t.diagnostic(JSON.stringify({ ok: result.ok, ...counts }));
  assert.equal(result.ok, true);
  assert.ok(counts.guestExecs >= 2, 'readiness and the workspace command are guest commands');
  assert.equal(counts.active, counts.guestExecs + 1, 'one live proof per guest launch and one at run handoff');
  assert.ok(counts.identitySync >= 2 * counts.guestExecs, 'the synchronous launch fence binds to the freshly proved guard');
});

test('protected dispatch refuses a stopped unit while the watchdog process is still visible', async () => {
  const backend = new DockerSbxBackend({ runCommand: workspaceRunner().runCommand, deadlineTimers: manualTimers() });
  const row = { _cleanupId: 'row-1', sandbox_id: 'synthetic-exec',
    deadline_at: Date.now() + 30_000, deadline_enforcer: { kind: 'systemd' } };
  const handle = { sandbox_id: row.sandbox_id };
  backend.cleanupJournal.authority = () => row;
  backend.cleanupJournal.admissionAuthority = () => row;
  backend.cleanupJournal.assertExecAllowed = () => {};
  backend.assertDeadlineTargetClear = () => {};
  let unitActive = true;
  let launches = 0;
  backend.sandboxDeadlines.identitySync = () => 'still-visible-watchdog';
  backend.sandboxDeadlines.active = async () => unitActive;
  const launch = () => { launches += 1; };
  await backend._dispatchProtected(handle, undefined, launch);
  unitActive = false;
  await assert.rejects(backend._dispatchProtected(handle, undefined, launch), { code: 'sandbox_start_failed' });
  assert.equal(launches, 1);
});

test('borrowed Codex safety job starts with the host proxy secret and does not use native generation', async () => {
  const adapter = getHarnessAdapter('codex');
  assert.equal(adapter.spec.auth_strategy, 'provider-file-generation', "the owner's native spec remains distinct");
  const listing = JSON.stringify({ secrets: [{ scope: 'global', type: 'service', name: 'openai' }], custom_secrets: [], shadowed_services: [], env_only_count: 0 });
  const stub = workspaceRunner({ secretResult: listing });
  const backend = new DockerSbxBackend({ runCommand: stub.runCommand, deadlineTimers: manualTimers() });
  const job = buildValidatedJobSpec({ taskDigest: '0'.repeat(64), harness: adapter.lendingSpec, entrypointWithPrompt: 'true',
    executionScope: 'borrowed', network: 'disabled', resources: { cpu: 1, memory_mib: 512, storage_mib: 512,
      wall_seconds: 60, output_bytes: 4096, network_bytes: 1, max_processes: 1 } });
  assert.equal(job.auth_strategy, 'docker-native-oauth');
  assert.equal(job.execution_scope, 'borrowed');
  const handle = await backend.prepare(job);
  try {
    assert.ok(stub.calls.some(({ args }) => args[0] === 'create'), 'sandbox creation succeeds without starting a default session when the proxy credential is present');
    assert.ok(!stub.calls.some(({ args }) => args[0] === 'secret' && args[1] === 'set'), 'no provider credential generation is published');
  } finally { await backend.destroy(handle); }
});

test('a failed entrypoint keeps its raw output and exit code on the error for local classification only', async () => {
  const stub = workspaceRunner();
  const runCommand = async (args, options) => args[0] === 'exec' && args.at(-1) === 'agent --run'
    ? { code: 1, stdout: 'agent stdout', stderr: 'agent stderr' } : stub.runCommand(args, options);
  const backend = new DockerSbxBackend({ runCommand });
  const handle = await backend.prepare(validJob());
  handle._entrypoint = 'agent --run';
  try {
    await assert.rejects(backend.start(handle), (error) => {
      assert.equal(error.exitCode, 1);
      assert.equal(error.stdout, 'agent stdout');
      assert.equal(error.stderr, 'agent stderr');
      assert.equal(error.code, 'entrypoint_start_failed');
      assert.equal(error.message, 'The agent could not be started. exit 1\nagent stderr');
      return true;
    });
  } finally {
    await backend.destroy(handle);
  }
});

test('entrypoint diagnostics keep only a bounded redacted tail of Codex error events', async () => {
  const stub = workspaceRunner();
  const token = 'secret_'.repeat(20);
  const stdout = [
    JSON.stringify({type:'item.completed',item:{text:'private agent reply'}}),
    ...Array.from({length:8},(_,i)=>JSON.stringify({type:'error',message:'failure '+i})),
    JSON.stringify({type:'turn.failed',error:{message:'Connection refused Bearer '+token}}),
  ].join('\n');
  const backend = new DockerSbxBackend({runCommand: async (args, options) =>
    args[0] === 'exec' && args.at(-1) === 'agent --run'
      ? {code:1,stdout,stderr:'proxy warning\n'} : stub.runCommand(args,options)});
  const handle = await backend.prepare(validJob());
  handle._entrypoint = 'agent --run';
  try {
    await assert.rejects(backend.start(handle), error => {
      assert.match(error.message,/Connection refused/);
      assert.match(error.message,/failure 7/);
      assert.doesNotMatch(error.message,/failure 0|private agent reply/);
      assert.ok(!error.message.includes(token));
      assert.ok(error.message.length < 2000);
      assert.equal(error.stdout,stdout,'raw output remains local for auth classification');
      return true;
    });
  } finally { await backend.destroy(handle); }
});

test('a host sbx process that exits 125 without a guest start signal is not execution evidence', async () => {
  await withRecordedSbx('case "$*" in *"agent --run"*) exit 125;; esac', async (_dir, log) => {
    let starts=0;
    const handle = startHandle();
    const backend=new DockerSbxBackend({guestRuntime:async()=>({node:'/data/node',sha256:'0'.repeat(64)})});
    backend.assertActive=async()=>{};backend._dispatchProtected=async(_h,s,launch)=>{s?.throwIfAborted();return launch();};
    await assert.rejects(backend.start(handle, {onExecutionStarted:()=>{starts++;}}),error=>{
      assert.equal(error.code, 'entrypoint_start_failed');
      assert.equal(error.exitCode, 125);
      assert.equal(error.message, 'The agent could not be started. exit 125');
      return true;
    });
    const calls = (await log()).trim().split('\n');
    assert.ok(calls.some(line => line.includes("/node' '/tmp/faravan-guard-") && line.includes('agent --run')),
      'the guarded launch command reached the sbx executable');
    assert.equal(starts,0,'a host transport spawn does not prove guest execution');
  });
});

test('missing sbx executable during runtime installation fails closed before launch', async () => {
  await withRecordedSbx('',async dir=>{
    const handle=startHandle();
    await rm(path.join(dir,'sbx'));
    const backend = new DockerSbxBackend({guestRuntime:async()=>({node:'/data/node',sha256:'0'.repeat(64)})});
    const invoked = [];
    const runJobCommand = backend._runJobCommand.bind(backend);
    backend._runJobCommand = (handle, args, ...rest) => { invoked.push([...args]); return runJobCommand(handle, args, ...rest); };
    let starts=0;
    await assert.rejects(backend.start(handle, {onExecutionStarted:()=>{starts++;}}), { code: 'guard_runtime_unavailable' });
    assert.equal(invoked.length, 1);
    assert.deepEqual(invoked[0].slice(0, 5), ['exec', 'synthetic-exec', '--', 'sh', '-c']);
    assert.match(invoked[0][5], /mkdir -p.*faravan-runtime/);
    assert.equal(starts,0,'guard installation failed before a guest start signal');
  });
});

for (const [stderr, cause] of [
  ['unknown flag: --detached\nsecret diagnostic', 'option_rejected'],
  ['no valid user session, sign in to Docker', 'not_signed_in'],
  ['KVM error: Permission denied', 'kvm'],
  ['image not found', 'image_unavailable'],
  ['operation timed out', 'timeout'],
  ['unexpected internal output', 'unknown'],
]) {
  test('testWorkspace classifies ' + cause + ' and never removes a sandbox its failed create did not prove', async () => {
    const stub = workspaceRunner({ failure: stderr });
    const backend = new DockerSbxBackend({ runCommand: stub.runCommand });
    const result = await backend.testWorkspace({ version: 'sbx version 0.48.0\nUNTRUSTED' });
    assert.equal(result.ok, false);
    assert.equal(result.cause, cause, 'an unproven cleanup keeps the start failure cause');
    assert.equal(result.cleanup, cause === 'not_signed_in' ? undefined : 'unverified');
    if (cause !== 'not_signed_in') assert.ok(stub.calls.some(({args}) => args[0] === 'ls'));
    assert.equal(stub.calls.some(({args}) => args[0] === 'rm'), false);
    if (cause === 'not_signed_in') {
      assert.equal(result.diagnostics, 'Sign in to Docker to lend.');
      assert.equal(backend.cleanupStatus().compute_cleanup_pending, 0);
      assert.doesNotMatch(result.diagnostics, /no valid user session/);
    } else assert.match(result.diagnostics, new RegExp(stderr.split('\n')[0]));
    assert.doesNotMatch(result.detail, /secret|UNTRUSTED|\n/);
    assert.ok(result.fix);
    if (cause === 'option_rejected') {
      assert.equal(result.detail, 'Docker Sandboxes 0.48.0 rejected an option Faravan uses.');
      assert.equal(result.fix, 'Update Faravan.');
    }
  });
}

for (const listing of ['unknown', 'present']) {
  test('testWorkspace refuses success with ' + listing + ' cleanup listing', async () => {
    const stub = workspaceRunner({ listing });
    const result = await new DockerSbxBackend({ runCommand: stub.runCommand }).testWorkspace();
    assert.equal(result.ok, false);
    assert.equal(result.cause, 'unknown');
    assert.match(result.detail, /could not confirm.*removed/);
  });
}

test('identity refresh survives a cold sandbox boot longer than thirty seconds', async () => {
  const { probeFaravanIdentity } = await import('../lib/executor.mjs');
  const timers = manualTimers(), stub = workspaceRunner();
  let elapsed = 0;
  const backend = new DockerSbxBackend({ deadlineTimers: timers, monotonic: () => elapsed,
    runCommand: async (args, options) => {
      const response = await stub.runCommand(args, options);
      if (args[0] === 'create') {
        elapsed = 35000;
        timers.advance(elapsed);
      }
      if (args[0] === 'exec' && args.at(-1).includes('FARAVAN_INSTALLED'))
        return {code:0, stdout:'FARAVAN_INSTALLED=1\n{"loggedIn":true,"authMethod":"claude.ai"}\n', stderr:''};
      return response;
    } });
  backend.lenderCapabilities = async () => ({available:true});
  const report = await probeFaravanIdentity({harnessNames:['claude-code-subscription'],
    backendFactory:() => backend, readDockerAccount:async () => null});
  assert.equal(elapsed,35000,'cold boot delay was injected into provider creation');
  assert.equal(report.providers[0].installed, true);
  assert.equal(report.providers[0].signedIn, true);
  assert.ok(stub.calls.some(({args}) => args[0] === 'ls'), 'probe sandbox is removed');
});

test('identity refresh probes workspace once and stops all provider probes when it fails', async () => {
  const { probeFaravanIdentity } = await import('../lib/executor.mjs');
  let probes = 0, factories = 0, gates = 0;
  const report = await probeFaravanIdentity({
    readDockerAccount: async () => 'example',
    backendFactory: () => {
      factories++;
      return { testWorkspace: async () => { probes++; return { ok: false, cause: 'option_rejected' }; },
        prepare: () => assert.fail('provider prepare must not run'),
        // Only the read-only gate before the workspace may ask; provider probes must not.
        lenderCapabilities: async () => { gates++; return { available: true }; } };
    },
  });
  assert.equal(probes, 1);
  assert.equal(factories, 1);
  assert.equal(gates, 1);
  assert.ok(report.providers.length > 0);
  assert.ok(report.providers.every(row => row.workspace_cause === 'option_rejected' &&
    row.installed === null && row.signedIn === null && row.authed === null));
  assert.equal(report.docker_account, 'example');
});

test('testWorkspace removes the sandbox when the true entrypoint fails', async () => {
  const stub = workspaceRunner();
  const result = await new DockerSbxBackend({ runCommand: (args, options) =>
    args[0] === 'exec' && args.includes('sh')
      ? { code: 1, stdout: '', stderr: 'unknown flag: --detached' }
      : stub.runCommand(args, options) }).testWorkspace();
  assert.equal(result.cause, 'option_rejected');
  assert.ok(stub.calls.some(({args}) => args[0] === 'ls'));
});

test('testWorkspace preparation deadline aborts setup and still removes the sandbox', async () => {
  const stub = workspaceRunner();
  const timers = manualTimers();
  const result = await new DockerSbxBackend({
    deadlineTimers: timers,
    runCommand: async (args, options) => {
      const response = await stub.runCommand(args, options);
      if (args[0] === 'create') {
        timers.advance(60_000);
        assert.equal(options.signal.aborted, false);
        timers.fire(PREPARATION_BUDGET_MS);
        assert.equal(options.signal.aborted, true);
      }
      return response;
    },
  }).testWorkspace();
  assert.equal(result.ok, false);
  assert.equal(result.cause, 'timeout');
  assert.ok(stub.calls.some(({args}) => args[0] === 'ls'));
  // The create returned success, so its receipt authorizes the removal.
  assert.ok(stub.calls.some(({args}) => args[0] === 'rm'));
  assert.equal(result.cleanup, undefined);
});

for (const phase of ['prepare', 'start', 'cleanup']) {
  test('testWorkspace caller cancellation while ' + phase + ' is held never returns late success', async () => {
    const stub = workspaceRunner();
    const backend = new DockerSbxBackend({runCommand: stub.runCommand, deadlineTimers: manualTimers()});
    const controller = new AbortController();
    let entered, release, owned, prepareSignal, startSignal, settled = false;
    const observed = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const cleaned = [], started = [];
    const prepare = backend.prepare.bind(backend), destroy = backend.destroy.bind(backend);
    backend.prepare = async (job, options) => {
      prepareSignal = options.signal;
      owned = await prepare(job, options);
      if (phase === 'prepare') { entered(); await gate; }
      return owned;
    };
    backend.start = async (handle, options) => {
      started.push(handle);
      startSignal = options?.signal;
      if (phase === 'start') { entered(); await gate; }
      // Model a command whose late reply reports success despite cancellation.
      return {ok: true};
    };
    backend.destroy = async handle => {
      cleaned.push(handle);
      if (phase === 'cleanup') { entered(); await gate; }
      return destroy(handle);
    };
    const check = backend.testWorkspace({signal: controller.signal}).finally(() => { settled = true; });
    try {
      await Promise.race([observed, check.then(() => assert.fail('settled before the held phase'))]);
      assert.equal(prepareSignal, controller.signal);
      controller.abort(Error('synthetic caller cancellation'));
      await Promise.resolve();
      assert.equal(settled, false, 'waits for late owned handle and cleanup');
      assert.deepEqual(cleaned, phase === 'cleanup' ? [owned] : []);
      assert.equal(stub.calls.some(({args}) => args[0] === 'rm'), false);
      release();
      const result = await check;
      assert.equal(result.ok, false, 'late completion must not publish success');
      assert.equal(result.cause, 'unknown', 'the workspace failure classifier owns caller-abort copy');
      assert.equal(started.length, phase === 'prepare' ? 0 : 1);
      if (started.length) {
        assert.equal(started[0], owned);
        assert.equal(startSignal, controller.signal);
      }
      assert.equal(cleaned.length, 1);
      assert.equal(cleaned[0], owned);
      const removals = stub.calls.filter(({args}) => args[0] === 'rm');
      assert.deepEqual(removals.map(({args}) => args.at(-1)), [owned.sandbox_id]);
    } finally {
      controller.abort();
      release();
      await check.catch(() => {});
    }
  });
}

test('prepare failures keep messages, stable codes and cleanup receipts', async () => {
  const previous = process.env.FARAVAN_SANDBOX_READY_TIMEOUT_MS;
  process.env.FARAVAN_SANDBOX_READY_TIMEOUT_MS = '-1';
  try {
    for (const ready of [false, true]) {
      const backend = new DockerSbxBackend({ deadlineTimers: manualTimers(),
        runCommand: async args => ({ code: 0, stdout: args[0] === 'settings' ? (args[1] === 'get' && args[2] === 'ssh.agentForwardingEnabled' ? 'false' : '') : '{"secrets":[],"custom_secrets":[],"shadowed_services":[],"env_only_count":0}' }) });
      let handle;
      backend._runJobCommand = async (value, args) => {
        handle = value;
        return { code: ready && args[0] === 'create' ? 0 : 1, stderr: 'fixture failure' };
      };
      backend.destroy = async value => {
        await rm(value.scratch_dir, { recursive: true, force: true });
        return { removed: true, scratch_removed: true };
      };
      await assert.rejects(backend.prepare(validJob({ job_id: 'prepare-failure-' + ready })), error => {
        assert.equal(error.code, ready ? 'sandbox_ready_timeout' : 'sandbox_start_failed');
        assert.equal(error.message, ready
          ? `sandbox ${handle.sandbox_id} never became ready after sbx create (boot may have failed): fixture failure`
          : `sbx create failed for sandbox ${handle.sandbox_id}: fixture failure`);
        assert.deepEqual(error.cleanup_receipt, { removed: true, scratch_removed: true });
        return true;
      });
    }
  } finally {
    if (previous === undefined) delete process.env.FARAVAN_SANDBOX_READY_TIMEOUT_MS;
    else process.env.FARAVAN_SANDBOX_READY_TIMEOUT_MS = previous;
  }
});

test('copy, output validation and stop failures have classified codes without live sbx', async () => {
  const backend = new DockerSbxBackend({ runCommand: async () => ({ code: 1, stderr: 'fixture failure' }),
    streamOutput: async function* () { throw Object.assign(new Error('fixture failure'), { code: 'output_copy_failed' }); } });
  const handle = await receiptedHandle(backend, { job_id: 'coded-errors' }), scratch_dir = handle.scratch_dir;
  backend._runJobCommand = async () => ({ code: 1, stderr: 'fixture failure' });
  try {
    await assert.rejects(backend._copyIn(handle, { artifact_id: 'input', dest: 'input' }),
      { code: 'input_copy_failed', message: 'sbx cp (input input -> input) failed: fixture failure' });
    await assert.rejects(backend.collectDeclaredOutputs(handle, ['../escape']),
      { code: 'output_path_invalid', message: 'refusing to collect unsafe output path: ../escape' });
    await assert.rejects(backend.collectDeclaredOutputs(handle, ['result']),
      { code: 'output_copy_failed', message: 'fixture failure' });
    await assert.rejects(backend.cancel(handle),
      { code: 'sandbox_stop_failed', message: 'sbx stop failed for sandbox ' + handle.sandbox_id + ': fixture failure' });
  } finally { await rm(scratch_dir, { recursive: true, force: true }); }
});

test('executor setup failures keep their messages and stable codes', async () => {
  const { runJob } = await import('../lib/executor.mjs');
  const backend = {
    admitJob: () => ({ ok: true }),
    probeCapabilities: async () => ({ available: false, missing_prerequisites: ['fixture'], install_hint: 'hint' }),
  };
  await assert.rejects(runJob({ jobSpec: validJob(), backend }),
    { code: 'sandbox_backend_unavailable', message: 'sandbox backend unavailable: fixture (hint)' });
  backend.probeCapabilities = async () => ({ available: true });
  backend.prepare = async () => ({ scratch_dir: '/unused' });
  backend.destroy = async () => ({ removed: true });
  await assert.rejects(runJob({ jobSpec: validJob(), backend, cloneGitSource: {} }),
    { code: 'git_source_unsupported', message: 'sandbox backend does not support Git repository task sources' });
  await assert.rejects(runJob({ jobSpec: validJob(), backend, signal: { aborted: true } }),
    { code: 'cancelled', message: 'cancelled' });
});

test('destroy removes only the verified-deleted sandbox network rules, retaining global and other sandbox rules', async () => {
  const own='wf-0123456789abcdef', calls=[];
  let rows=[{id:'own',scope:'sandbox:'+own,applies_to:'sandbox:'+own,resource_type:'network',status:'active',editable:true},
    {id:'global',scope:'all',applies_to:'all',resource_type:'network',status:'active',editable:true},
    {id:'other',scope:'sandbox:wf-other',applies_to:'sandbox:wf-other',resource_type:'network',status:'active',editable:true}];
  const backend=new DockerSbxBackend({runCommand:async args=>{
    calls.push(args);
    if(args[0]==='ls')return {code:0,stdout:'[]'};
    if(args[0]==='policy'&&args[1]==='ls')return {code:0,stdout:JSON.stringify({rules:rows})};
    if(args[0]==='policy'&&args[1]==='rm'){rows=rows.filter(r=>r.id!==args[args.indexOf('--id')+1]);return {code:0,stdout:''};}
    return {code:0,stdout:''};
  }});
  const result=await backend.destroy(await receiptedHandle(backend,{ ...testSbxRuntimeFields(),job_id:'policy-cleanup',sandbox_id:own}));
  assert.equal(result.policy_removed,true);
  assert.deepEqual(rows.map(r=>r.id),['global','other']);
  assert.equal(calls.filter(a=>a[0]==='policy'&&a[1]==='rm').length,1);
  assert.ok(calls.findIndex(a=>a[0]==='ls')<calls.findIndex(a=>a[0]==='policy'));
});

test('destroy never removes policies when sandbox disappearance is unverified',async()=>{
 const calls=[];const backend=new DockerSbxBackend({runCommand:async args=>{calls.push(args);return {code:args[0]==='ls'?1:0,stdout:''};}});
 const result=await backend.destroy(await receiptedHandle(backend,{job_id:'policy-unknown'}));
 assert.equal(result.removed,false);assert.equal(result.policy_removed,false);
 assert.equal(calls.some(a=>a[0]==='policy'),false);
});

// --- Provider-free verification (prepareCheck providerAccess:false) ----------------------------------------------------
// A lent job's check sandbox must not carry the lender's provider access. Omitting providerAccess keeps today's check.
// Every test points the sbx home and scratch root at a temp directory, so no real credential or provider config is read.

const PROVIDER_CHECK_ENV = ['FARAVAN_SBX_HOME', 'FARAVAN_SCRATCH_ROOT'];

async function withTempCheckHome(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'wf-check-home-'));
  const saved = Object.fromEntries(PROVIDER_CHECK_ENV.map((name) => [name, process.env[name]]));
  for (const name of PROVIDER_CHECK_ENV) process.env[name] = home;
  t.after(async () => {
    for (const name of PROVIDER_CHECK_ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

const secretListing = (secrets = []) => ({
  code: 0, stderr: '',
  stdout: JSON.stringify({ secrets, custom_secrets: [], shadowed_services: [], env_only_count: 0 }),
});

// The shipped file leaves gemini unpinned (no public digest); these tests exercise gemini's policy, not its pin.
const PINS_WITH_GEMINI = { ...loadImagePins(), agents: { ...loadImagePins().agents, gemini: 'sha256:' + '1'.repeat(64) } };
function providerCheckBackend({ secrets = [] } = {}) {
  const runner = sbxRunner(createSbxPolicy(), undefined, { secretResult: secretListing(secrets) });
  const backend = new DockerSbxBackend({ runCommand: runner.run, deadlineTimers: manualTimers(), home: process.env.FARAVAN_SBX_HOME,
    hostDisk: { free: async () => ({ free: 2 ** 40 }) }, imagePins: PINS_WITH_GEMINI });
  backend.monotonic = () => 0;
  return { backend, runner };
}

function providerCheckAgent({ image, authStrategy, scope = 'owner', egress = 'provider-only', providerHosts = ['**.openai.com'], registryHosts = [] }) {
  return { ...testSbxRuntimeFields(process.env.FARAVAN_SBX_HOME), job_id: 'job-check-1', sandbox_id: 'job-check-1-agent', _image: image, _executionScope: scope, _authStrategy: authStrategy,
    _resources: { ...validJob().resources }, _egress: egress, _providerHosts: providerHosts, _registryHosts: registryHosts, _sourceHosts: [],
    _mountless: false, _deadline: { endsAt: 600000 } };
}

// Replace one sbx command's answer; every other command reaches the policy model.
function answerSbx(backend, match, answer) {
  const real = backend.runSbx;
  backend.runSbx = (args, options) => (match(args) ? Promise.resolve(answer) : real(args, options));
}

// Run the guest-side proofs in a local shell whose environment is the guest's: sbx's modes and placeholders.
function withGuestEnvironment(backend, guest) {
  const proofs = [];
  const real = backend._runJobCommand.bind(backend);
  backend._runJobCommand = async (handle, args, ...rest) => {
    const command = args.at(-1);
    if (args[0] !== 'exec' || !command?.includes(':-}')) return real(handle, args, ...rest);
    const shell = spawnSync('sh', ['-c', command], { env: { PATH: process.env.PATH, ...guest }, encoding: 'utf8' });
    proofs.push({ command, code: shell.status });
    return { code: shell.status, stdout: shell.stdout, stderr: shell.stderr };
  };
  return proofs;
}

const policyList = (runner, action) => runner.calls.filter((args) => args[0] === 'policy' && args[1] === action).flatMap((args) => args.at(-1).split(','));
const startedSandbox = (runner) => runner.calls.some((args) => args[0] === 'create') &&
  !runner.calls.some(args => args[0] === 'run' && args.includes('-d'));
const providerEnvCheck = (runner, name) => runner.calls.some((args) => args[0] === 'exec' && args.some((arg) => arg.includes(`\${${name}:-}`)));

test('prepareCheck preserves the check spec and inherits its runtime', async (t) => {
  await withTempCheckHome(t);
  const { backend } = providerCheckBackend();
  const calls = [];
  backend.prepare = async (spec, deadline, options) => { calls.push({ spec, options }); return { sandbox_id: 'stub' }; };
  const agent = providerCheckAgent({ image: 'codex', authStrategy: 'provider-file-generation' });
  await backend.prepareCheck(agent);
  await backend.prepareCheck(agent, { cloneSource: false });
  const expected = { job_id: 'job-check-1-check', image: 'codex', entrypoint: 'true', inputs: [], output_manifest: [],
    execution_scope: 'owner', auth_strategy: 'provider-file-generation', resources: validJob().resources, egress: 'provider-only',
    provider_hosts: ['**.openai.com'], required_limits: [...ENFORCED_LIMITS] };
  assert.deepEqual(calls[0], { spec: expected, options: { sbxRuntime:agent._sbxRuntime,githubKit: false } });
  assert.deepEqual(calls[1], calls[0]);
});

for (const egress of ['provider-only', 'provider+registries', 'internet']) {
  test(`provider-free check for provider-file-generation has no credential and no provider host, egress ${egress}`, async (t) => {
    await withTempCheckHome(t);
    const { backend, runner } = providerCheckBackend();
    const agent = providerCheckAgent({ image: 'codex', authStrategy: 'provider-file-generation', egress,
      registryHosts: egress === 'provider+registries' ? ['registry.npmjs.org'] : [] });
    const check = await backend.prepareCheck(agent, { providerAccess: false });
    try {
      assert.equal(check._credentialEnv, undefined, 'no provider environment');
      assert.equal(runner.calls.some((args) => args[0] === 'cp'), false, 'no credential file is copied in');
      assert.equal(runner.calls.some((args) => args.some((arg) => /faravan-auth|CODEX_HOME=|OPENAI_API_KEY=/.test(arg))), false,
        'no provider path or variable reaches sbx');
      assert.ok(policyList(runner, 'deny').includes('**.openai.com'), 'the provider host is denied in the check sandbox');
      const allows = policyList(runner, 'allow');
      assert.equal(allows.includes('**'), false, 'the open internet is never allowed');
      assert.equal(allows.some((host) => host.includes('openai')), false, 'no provider host is allowed');
      assert.equal(check._policyVerification['api.openai.com'], 'denied');
      assert.ok(providerEnvCheck(runner, 'OPENAI_API_KEY'), 'the provider secret variables are proven absent');
      if (egress === 'provider+registries') assert.equal(check._policyVerification['registry.npmjs.org'], 'allowed', 'registries stay as today');
    } finally {
      await backend.destroy(check).catch(() => {});
    }
  });
}

// A lender-wide sign-in stays bound (sbx binds it per image), but the check denies its hosts and proves no secret reaches
// the guest. Each row: image, sbx service, auth strategy, egress, the provider hosts the spec names, a host the denial must
// cover, and the variable proven absent.
const INERT_PROVIDER_CASES = [
  ['codex', 'openai', 'docker-native-oauth', 'provider-only', ['**.openai.com', '**.chatgpt.com'], 'api.openai.com', 'OPENAI_API_KEY'],
  ['claude', 'anthropic', 'docker-native-oauth', 'provider-only', ['api.anthropic.com'], 'api.anthropic.com', 'ANTHROPIC_API_KEY'],
  ['claude', 'anthropic', 'docker-stored-secret', 'internet', ['api.anthropic.com'], 'api.anthropic.com', 'ANTHROPIC_API_KEY'],
  ['gemini', 'google', 'docker-stored-secret', 'provider-only', ['generativelanguage.googleapis.com', 'oauth2.googleapis.com'],
    'generativelanguage.googleapis.com', 'GEMINI_API_KEY'],
];

for (const [image, service, authStrategy, egress, providerHosts, denied, variable] of INERT_PROVIDER_CASES) {
  test(`provider-free check for ${authStrategy} (${image}, ${egress}) denies its provider hosts and carries no provider variable or file`, async (t) => {
    await withTempCheckHome(t);
    const { backend, runner } = providerCheckBackend({ secrets: [{ name: service, type: 'service', scope: '(global)' }] });
    const agent = providerCheckAgent({ image, authStrategy, scope: 'borrowed', egress, providerHosts });
    const check = await backend.prepareCheck(agent, { providerAccess: false });
    try {
      assert.equal(check._credentialEnv, undefined, 'no provider environment');
      assert.equal(runner.calls.some((args) => args[0] === 'cp'), false, 'no credential file is copied in');
      const denies = policyList(runner, 'deny');
      for (const host of providerHosts) assert.ok(denies.includes(host), `${host} is denied`);
      assert.equal(policyList(runner, 'allow').includes('**'), false, 'the open internet is never allowed');
      assert.equal(check._policyVerification[denied], 'denied', `${denied} is observed denied`);
      assert.ok(providerEnvCheck(runner, variable), `${variable} is proven absent in the guest`);
      assert.ok(startedSandbox(runner), 'the check sandbox starts');
    } finally {
      await backend.destroy(check).catch(() => {});
    }
  });
}

test('provider-free check for guest-env-api-key (opencode) denies its provider host and proves its key variable absent', async (t) => {
  await withTempCheckHome(t);
  const { backend, runner } = providerCheckBackend();
  const agent = providerCheckAgent({ image: 'opencode', authStrategy: 'guest-env-api-key', scope: 'owner', providerHosts: ['openrouter.ai'] });
  const check = await backend.prepareCheck(agent, { providerAccess: false });
  try {
    assert.equal(check._credentialEnv, undefined, 'no provider environment');
    assert.ok(policyList(runner, 'deny').includes('openrouter.ai'), 'the provider host is denied');
    assert.equal(check._policyVerification['openrouter.ai'], 'denied');
    assert.ok(providerEnvCheck(runner, 'OPENROUTER_API_KEY'), 'the key variable is proven absent');
  } finally {
    await backend.destroy(check).catch(() => {});
  }
});

test('a broker account job (pi) is prepared borrowed and proves every provider key variable absent; the floor still refuses it without the account flag', async (t) => {
  await withTempCheckHome(t);
  const { backend, runner } = providerCheckBackend();
  const job = { ...validJob(), job_id: 'job-pi-1', image: 'wf-pi', execution_scope: 'borrowed', auth_strategy: 'guest-env-api-key',
    egress: 'provider-only', provider_hosts: ['account-broker.invalid'] };
  await assert.rejects(backend.prepare(job, { providerAccess: false, brokerOnly: false }), { code: 'native_credentials_owner_only' });
  const handle = await backend.prepare(job, { providerAccess: false, brokerOnly: true, brokerHosts: [] });
  try {
    for (const variable of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY'])
      assert.ok(providerEnvCheck(runner, variable), `${variable} is proven absent in the guest`);
    assert.ok(startedSandbox(runner), 'the sandbox starts');
  } finally {
    await backend.destroy(handle).catch(() => {});
  }
});

// Realistic guest: sbx sets its mode variable (none or oauth) and the guest holds the placeholder, not a secret. The check
// must still start, because neither is a secret.
test('a provider-free codex check starts in a guest whose sbx mode is none and holds no key', async (t) => {
  await withTempCheckHome(t);
  const { backend, runner } = providerCheckBackend({ secrets: [{ name: 'openai', type: 'service', scope: '(global)' }] });
  const proofs = withGuestEnvironment(backend, { SBX_CRED_OPENAI_MODE: 'none' });
  const check = await backend.prepareCheck(providerCheckAgent({ image: 'codex', authStrategy: 'docker-native-oauth', scope: 'borrowed' }),
    { providerAccess: false });
  try {
    assert.ok(startedSandbox(runner), 'the check sandbox starts');
    assert.ok(proofs.some((p) => p.code === 0 && p.command.includes('${OPENAI_API_KEY:-}')), 'the openai proof passes in the guest');
  } finally {
    await backend.destroy(check).catch(() => {});
  }
});

test('a provider-free claude check starts in a guest holding only the sbx placeholder for its key', async (t) => {
  await withTempCheckHome(t);
  const { backend, runner } = providerCheckBackend({ secrets: [{ name: 'anthropic', type: 'service', scope: '(global)' }] });
  const proofs = withGuestEnvironment(backend, { SBX_CRED_ANTHROPIC_MODE: 'oauth', ANTHROPIC_API_KEY: 'proxy-managed', ANTHROPIC_AUTH_TOKEN: 'proxy-managed' });
  const check = await backend.prepareCheck(providerCheckAgent({ image: 'claude', authStrategy: 'docker-native-oauth', scope: 'borrowed',
    providerHosts: ['api.anthropic.com'] }), { providerAccess: false });
  try {
    assert.ok(startedSandbox(runner), 'the check sandbox starts');
    assert.ok(proofs.some((p) => p.code === 0 && p.command.includes('${ANTHROPIC_API_KEY:-}')), 'the key proof passes with placeholders');
  } finally {
    await backend.destroy(check).catch(() => {});
  }
});

test('a provider-free claude check accepts the OAuth placeholder forms and refuses a token that only ends with one', async (t) => {
  for (const [token, starts] of [['sk-ant-oat01-proxy-managed', true], ['sk-ant-ort01-proxy-managed', true], ['sk-ant-oat01-real-proxy-managed', false]]) {
    await withTempCheckHome(t);
    const { backend, runner } = providerCheckBackend({ secrets: [{ name: 'anthropic', type: 'service', scope: '(global)' }] });
    withGuestEnvironment(backend, { SBX_CRED_ANTHROPIC_MODE: 'oauth', CLAUDE_CODE_OAUTH_TOKEN: token, ANTHROPIC_AUTH_TOKEN: token });
    const agent = providerCheckAgent({ image: 'claude', authStrategy: 'docker-native-oauth', scope: 'borrowed', providerHosts: ['api.anthropic.com'] });
    if (starts) {
      const check = await backend.prepareCheck(agent, { providerAccess: false });
      try { assert.ok(startedSandbox(runner), `the check starts with ${token}`); } finally { await backend.destroy(check).catch(() => {}); }
    } else {
      await assert.rejects(backend.prepareCheck(agent, { providerAccess: false }), (error) => error.code === 'credential_scope_unenforceable');
    }
  }
});

test('a provider-free check refuses a guest that holds a real provider key, even behind the placeholder rule', async (t) => {
  await withTempCheckHome(t);
  const { backend, runner } = providerCheckBackend({ secrets: [{ name: 'openai', type: 'service', scope: '(global)' }] });
  withGuestEnvironment(backend, { SBX_CRED_OPENAI_MODE: 'none', OPENAI_API_KEY: 'sk-live-not-a-placeholder' });
  await assert.rejects(backend.prepareCheck(providerCheckAgent({ image: 'codex', authStrategy: 'docker-native-oauth', scope: 'borrowed' }),
    { providerAccess: false }), (error) => error.code === 'credential_scope_unenforceable' && /could use the openai sign-in/.test(error.message));
  assert.ok(runner.calls.some((args) => args[0] === 'rm'), 'the sandbox is removed');
});

for (const [image, service, authStrategy, egress, providerHosts, denied] of INERT_PROVIDER_CASES.filter(row => row[3] === 'provider-only')) {
  test(`provider-free check refuses ${authStrategy} (${image}) before the check runs when its provider denial is not verified`, async (t) => {
    await withTempCheckHome(t);
    const { backend, runner } = providerCheckBackend({ secrets: [{ name: service, type: 'service', scope: '(global)' }] });
    // The policy model denies the host; a stub answers "allowed" for the one host the denial must cover.
    answerSbx(backend, (args) => args[0] === 'policy' && args[1] === 'check' && args.at(-1) === denied,
      { code: 0, stdout: JSON.stringify({ allowed: true }), stderr: '' });
    const agent = providerCheckAgent({ image, authStrategy, scope: 'borrowed', egress, providerHosts });
    await assert.rejects(backend.prepareCheck(agent, { providerAccess: false }),
      (error) => error.code === 'credential_scope_unenforceable' && new RegExp(`could use the ${service} sign-in`).test(error.message));
    assert.ok(runner.calls.some((args) => args[0] === 'rm'), 'the sandbox that failed the proof is removed');
  });
}

test('provider-free check refuses when a provider secret variable is visible in the guest', async (t) => {
  await withTempCheckHome(t);
  const { backend, runner } = providerCheckBackend({ secrets: [{ name: 'openai', type: 'service', scope: '(global)' }] });
  answerSbx(backend, (args) => args[0] === 'exec' && args.some((arg) => arg.includes('${OPENAI_API_KEY:-}')), { code: 1, stdout: '', stderr: '' });
  const agent = providerCheckAgent({ image: 'codex', authStrategy: 'docker-native-oauth', scope: 'borrowed' });
  await assert.rejects(backend.prepareCheck(agent, { providerAccess: false }),
    (error) => error.code === 'credential_scope_unenforceable' && /could use the openai sign-in/.test(error.message));
  assert.ok(runner.calls.some((args) => args[0] === 'rm'), 'the sandbox is removed');
});

test('a provider-free check of an open job is clamped to the registries, never the open internet', async (t) => {
  await withTempCheckHome(t);
  const { backend, runner } = providerCheckBackend();
  const check = await backend.prepareCheck(providerCheckAgent({ image: 'codex', authStrategy: 'provider-file-generation', egress: 'internet' }),
    { providerAccess: false });
  try {
    const allows = policyList(runner, 'allow');
    assert.equal(allows.includes('**'), false, 'no ** allow');
    assert.ok(allows.includes('registry.npmjs.org') && allows.includes('pypi.org'), 'the npm and pypi registries stay reachable');
    assert.equal(allows.some((host) => host.includes('openai')), false, 'no provider host is allowed');
    assert.ok(policyList(runner, 'deny').includes('**.openai.com'), 'the provider host is denied');
    assert.equal(check._policyVerification['example.com'], 'denied', 'default-deny holds for hosts outside the registries');
  } finally {
    await backend.destroy(check).catch(() => {});
  }
});

test('an open Gemini job is clamped to the registries and starts provider-free', async (t) => {
  await withTempCheckHome(t);
  const { backend, runner } = providerCheckBackend({ secrets: [{ name: 'google', type: 'service', scope: '(global)' }] });
  const check = await backend.prepareCheck(providerCheckAgent({ image: 'gemini', authStrategy: 'docker-stored-secret', scope: 'borrowed', egress: 'internet',
    providerHosts: ['generativelanguage.googleapis.com'] }), { providerAccess: false });
  try {
    assert.ok(startedSandbox(runner), 'the check sandbox starts');
    assert.equal(policyList(runner, 'allow').includes('**'), false, 'no ** allow');
    assert.equal(check._policyVerification['generativelanguage.googleapis.com'], 'denied');
  } finally {
    await backend.destroy(check).catch(() => {});
  }
});

test('a provider-free check refuses when a provider deny is missing from the policy readback', async (t) => {
  await withTempCheckHome(t);
  const { backend } = providerCheckBackend();
  // The first readback is the baseline; the second, after the rules are installed, drops the provider deny.
  const read = backend._readPolicy.bind(backend);
  let reads = 0;
  backend._readPolicy = async (handle, failPolicy) => {
    const policy = await read(handle, failPolicy);
    reads += 1;
    return reads === 1 ? policy : { ...policy, ownDeny: policy.ownDeny.filter((rule) => rule !== '**.openai.com') };
  };
  await assert.rejects(backend.prepareCheck(providerCheckAgent({ image: 'codex', authStrategy: 'docker-native-oauth', scope: 'borrowed' }),
    { providerAccess: false }), { code: 'policy_unenforceable' });
});

test('a provider-free check of an image without a known provider is refused before any sbx command', async (t) => {
  await withTempCheckHome(t);
  const { backend, runner } = providerCheckBackend();
  await assert.rejects(backend.prepareCheck(providerCheckAgent({ image: 'wf-faravan-guest@sha256:0000000000000000000000000000000000000000000000000000000000000000', authStrategy: 'docker-native-oauth', scope: 'borrowed' }),
    { providerAccess: false }), { code: 'policy_unenforceable' });
  assert.equal(startedSandbox(runner), false, 'no sandbox is created');
});

test('a budgeted (lending) check is provider-free even when providerAccess is omitted', async (t) => {
  await withTempCheckHome(t);
  const { backend, runner } = providerCheckBackend();
  const lending = { ...providerCheckAgent({ image: 'codex', authStrategy: 'provider-file-generation' }), _lending: {} };
  const check = await backend.prepareCheck(lending);
  try {
    assert.ok(policyList(runner, 'deny').includes('**.openai.com'), 'the provider host is denied for a budgeted check');
    assert.ok(providerEnvCheck(runner, 'OPENAI_API_KEY'), 'the provider secret variables are proven absent');
  } finally {
    await backend.destroy(check).catch(() => {});
  }
});

test('an unbudgeted check with providerAccess omitted keeps the provider host allowed, not denied', async (t) => {
  await withTempCheckHome(t);
  const { backend, runner } = providerCheckBackend();
  const check = await backend.prepareCheck(providerCheckAgent({ image: 'codex', authStrategy: 'provider-file-generation' }));
  try {
    assert.equal(policyList(runner, 'deny').includes('**.openai.com'), false, 'the provider host is not denied');
    assert.ok(policyList(runner, 'allow').includes('**.openai.com'), 'the provider host stays allowed as today');
  } finally {
    await backend.destroy(check).catch(() => {});
  }
});

test('any providerAccess value other than true is provider-free in prepare', async (t) => {
  await withTempCheckHome(t);
  const { backend, runner } = providerCheckBackend();
  const spec = { job_id: 'job-check-1-check', image: 'codex', entrypoint: 'true', inputs: [], output_manifest: [],
    execution_scope: 'owner', auth_strategy: 'provider-file-generation', resources: validJob().resources, egress: 'provider-only',
    provider_hosts: ['**.openai.com'], required_limits: [...ENFORCED_LIMITS] };
  const handle = await backend.prepare(spec, null, { providerAccess: null });
  try {
    assert.ok(policyList(runner, 'deny').includes('**.openai.com'), 'a null providerAccess denies the provider host');
  } finally {
    await backend.destroy(handle).catch(() => {});
  }
});

test('a provider-free check of a GitHub CLI agent never starts, with or without providerAccess', async (t) => {
  await withTempCheckHome(t);
  const { backend, runner } = providerCheckBackend();
  const agent = providerCheckAgent({ image: 'wf-gh-cli', authStrategy: 'host-env-proxy', providerHosts: ['github.com'] });
  await assert.rejects(backend.prepareCheck(agent, { providerAccess: false }), { code: 'policy_unenforceable' });
  await assert.rejects(backend.prepareCheck(agent), { code: 'policy_unenforceable' });
  assert.equal(runner.calls.length, 0, 'no sbx command runs');
});

test('the same lender-wide sign-in is still prepared when providerAccess is omitted (today\'s behaviour)', async (t) => {
  await withTempCheckHome(t);
  const { backend, runner } = providerCheckBackend({ secrets: [{ name: 'openai', type: 'service', scope: '(global)' }] });
  const check = await backend.prepareCheck(providerCheckAgent({ image: 'codex', authStrategy: 'docker-native-oauth', scope: 'borrowed' }));
  try {
    assert.ok(startedSandbox(runner), 'the default check still starts its sandbox');
    assert.equal(providerEnvCheck(runner, 'OPENAI_API_KEY'), false, 'the default check runs no provider-variable proof');
  } finally {
    await backend.destroy(check).catch(() => {});
  }
});

test('a requester job spec cannot ask for a provider-free check', () => {
  assert.doesNotThrow(() => validateJobSpec(validJob()));
  for (const field of ['providerAccess', 'provider_access', 'check_mode']) {
    assert.throws(() => validateJobSpec({ ...validJob(), [field]: false }), /unknown|forbidden/i, field);
  }
});

test('DockerSbxBackend declares checkWithoutProvider true: every supported strategy is provider-free before a check runs', () => {
  assert.equal(new DockerSbxBackend().checkWithoutProvider, true);
});


test('a queued doctor workspace waits for the preceding auxiliary check to finish',async t=>{
 const backend=new DockerSbxBackend();let release,occupied=true,entered=false;
 const held=new Promise(resolve=>{release=resolve;});t.after(()=>release());
 const other=backend.withSandboxCheck(async()=>{await held;occupied=false;});
 backend._testWorkspace=async()=>{entered=true;assert.equal(occupied,false);return {ok:true};};
 const workspace=backend.testWorkspace();
 await new Promise(resolve=>setTimeout(resolve,30));assert.equal(entered,false);
 release();await other;assert.equal((await workspace).ok,true);
});

test('missing guest node before the guard starts is an actionable runtime blocker', async () => {
  await withRecordedSbx('case "$*" in *"agent --run"*) echo "sh: 1: node: not found" >&2; exit 127;; esac', async () => {
    const backend = new DockerSbxBackend({guestRuntime:async()=>({node:'/data/node',sha256:'0'.repeat(64)})});
    await assert.rejects(backend.start(startHandle(), {onExecutionStarted(){}}), error => error.code === 'guard_runtime_unavailable' && /Update Faravan/.test(error.message));
  });
});

for (const image of ['claude', 'codex', 'gemini', 'opencode', 'wf-gh-cli']) test(
  `preparation never starts a provider default session: ${image}`, async t => {
    await withTempCheckHome(t);
    const {backend, runner} = providerCheckBackend();
    const handle = await backend.prepare(validJob({image, execution_scope: image === 'opencode' ? 'owner' : 'borrowed',
      auth_strategy: image === 'wf-gh-cli' ? 'host-env-proxy' : image === 'codex' ? 'docker-native-oauth' : 'docker-stored-secret'}));
    try {
      const creation = runner.calls.find(args => ['run', 'create'].includes(args[0]));
      assert.ok(creation);
      assert.equal(creation[0], 'create');
      assert.equal(creation.includes('-d'), false);
      assert.ok(creation.includes(handle.scratch_dir), 'mounted workspace is preserved');
      assert.ok(runner.calls.some(args => args[0] === 'exec' && args.at(-1) === 'true'), 'readiness exec succeeds');
      assert.ok(runner.calls.some(args => args[0] === 'policy'), 'egress is configured');
    } finally { await backend.destroy(handle); }
  });
const SHIPPED_PINS = loadImagePins();
for (const agent of ['claude', 'codex']) test(`the create argv names the ${agent} kit by the shipped digest, never a floating tag`, async t => {
  await withTempCheckHome(t);
  const { backend, runner } = providerCheckBackend();
  const handle = await backend.prepare(validJob({ image: agent, execution_scope: 'borrowed', auth_strategy: agent === 'codex' ? 'docker-native-oauth' : 'docker-stored-secret' }));
  try {
    const creation = runner.calls.find(args => args[0] === 'create');
    const positional = `docker.io/sbx/${agent}@${SHIPPED_PINS.agents[agent]}`;
    assert.ok(creation.includes(positional), `argv carries ${positional}`);
    assert.ok(!creation.includes(agent), 'the bare agent name is not sent');
    assert.ok(!creation.some(arg => /:latest\b/.test(arg)), 'no floating tag');
    assert.ok(!creation.includes('--template'));
  } finally { await backend.destroy(handle); }
});
test('the template form keeps the agent name and passes the digest through --template', async t => {
  await withTempCheckHome(t);
  const { backend, runner } = providerCheckBackend();
  backend._imagePins = { ...SHIPPED_PINS, form: 'template' };
  const handle = await backend.prepare(validJob({ image: 'codex', execution_scope: 'borrowed', auth_strategy: 'docker-native-oauth' }));
  try {
    const creation = runner.calls.find(args => args[0] === 'create');
    const at = creation.indexOf('--template');
    assert.ok(at > 0);
    assert.equal(creation[at + 1], `docker.io/sbx/codex@${SHIPPED_PINS.agents.codex}`);
    assert.ok(creation.indexOf('codex') > at + 1, 'the agent positional follows the flags');
  } finally { await backend.destroy(handle); }
});
function ledgerSpy(events) {
  return {
    acquireLease: ({ item, ttlMs }) => { events.push(['lease', item, ttlMs]); return 'lease-1'; },
    releaseLease: id => { events.push(['release', id]); },
    recordSandbox: (name, { pin }) => { events.push(['record', name, pin]); },
    ownImages: () => {}, renewLease: () => true, openOps: () => [],
  };
}
const emptyTemplates = backend => answerSbx(backend, args => args[0] === 'template' && args[1] === 'ls', { code: 0, stdout: '[]', stderr: '' });
for (const agent of ['claude', 'codex']) test(`a ${agent} create is covered by a lease that ends once the sandbox is recorded with its pinned digest`, async t => {
  await withTempCheckHome(t);
  const events = [];
  const { backend, runner } = providerCheckBackend();
  backend.diskLedger = ledgerSpy(events);
  emptyTemplates(backend);
  const real = backend.runSbx;
  backend.runSbx = (args, options) => { if (args[0] === 'create') events.push(['create']); return real(args, options); };
  const handle = await backend.prepare(validJob({ image: agent, execution_scope: 'borrowed', auth_strategy: agent === 'codex' ? 'docker-native-oauth' : 'docker-stored-secret' }));
  try {
    assert.ok(runner.calls.some(args => args[0] === 'create'));
    const kinds = events.map(event => event[0]);
    assert.deepEqual(kinds, ['lease', 'create', 'record'], 'the run protection is written before the create is dispatched and stays until the job is destroyed');
    assert.equal(events[0][1], `sandbox:${handle.sandbox_id}`);
    assert.match(events[2][1], /^wf-[0-9a-f]{16}$/);
    assert.equal(events[2][2], SHIPPED_PINS.agents[agent].replace('sha256:', ''), 'the pin is the shipped index digest');
  } finally { await backend.destroy(handle); }
});
test('a failed create releases its lease and records no sandbox', async t => {
  await withTempCheckHome(t);
  const events = [];
  const { backend } = providerCheckBackend();
  backend.diskLedger = ledgerSpy(events);
  emptyTemplates(backend);
  answerSbx(backend, args => args[0] === 'create', { code: 1, stdout: '', stderr: 'boom' });
  await assert.rejects(backend.prepare(validJob({ image: 'codex', execution_scope: 'borrowed', auth_strategy: 'docker-native-oauth' })), /boom|start/);
  assert.deepEqual(events.map(event => event[0]), ['lease', 'release']);
});
test('a ledger that throws means no sandbox is created: protection comes before dispatch', async t => {
  await withTempCheckHome(t);
  const { backend, runner } = providerCheckBackend();
  const boom = () => { throw new Error('disk full'); };
  backend.diskLedger = { acquireLease: boom, releaseLease: boom, recordSandbox: boom, openOps: () => [] };
  emptyTemplates(backend);
  await assert.rejects(backend.prepare(validJob({ image: 'codex', execution_scope: 'borrowed', auth_strategy: 'docker-native-oauth' })), error => error.code === 'disk_protection_unavailable');
  assert.equal(runner.calls.some(args => args[0] === 'create' || args[0] === 'run'), false, 'nothing was dispatched');
});
// A create that waits until the test lets it go, so the test can look at the ledger while it is pending.
function pendingCreate(backend) {
  let release; const gate = new Promise(resolve => { release = resolve; });
  let started; const startedPromise = new Promise(resolve => { started = resolve; });
  const real = backend.runSbx;
  backend.runSbx = async (args, options) => { if (args[0] === 'create') { started(); await gate; } return real(args, options); };
  return { release, started: startedPromise };
}
const prepareJob = agent => validJob({ image: agent, execution_scope: 'borrowed', auth_strategy: agent === 'codex' ? 'docker-native-oauth' : 'docker-stored-secret' });

test('a create in one process is visible to another process reading the same ledger file (a lease is not an in-memory copy)', async t => {
  const home = await withTempCheckHome(t);
  const file = path.join(home, 'ledger.json');
  const app = createDiskLedger({ file });
  const { backend } = providerCheckBackend();
  backend.diskLedger = createDiskLedger({ file });
  emptyTemplates(backend);
  const create = pendingCreate(backend);
  const prepared = backend.prepare(prepareJob('codex'));
  await create.started;
  assert.equal(app.activeLeases().length, 1, 'the other ledger object sees the protection on disk');
  create.release();
  await backend.destroy(await prepared);
  assert.equal(app.activeLeases().length, 0, 'and sees it end');
});

test('a create that outlasts its first lease deadline is still covered: the gate is held until it ends, and the lease is admitted again after', async t => {
  const home = await withTempCheckHome(t);
  const ledger = createDiskLedger({ file: path.join(home, 'ledger.json') });
  const { backend } = providerCheckBackend();
  backend.diskLedger = ledger;
  backend.diskLease = { ttlMs: 400, renewMs: 40 };
  emptyTemplates(backend);
  const create = pendingCreate(backend);
  const prepared = backend.prepare(prepareJob('claude'));
  await create.started;
  await new Promise(resolve => setTimeout(resolve, 700));
  // Nothing else can take the store while the create runs, so no removal can be dispatched for it.
  await assert.rejects(backend._diskCoordinator().exclusive(async () => 'ran', { waitMs: 30 }), error => error.code === 'store_busy');
  create.release();
  const handle = await prepared;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.ok(ledger.activeLeases().some(lease => lease.item === `sandbox:${handle.sandbox_id}`), 'after the create the job holds a current lease again');
  await backend.destroy(handle);
  assert.equal(ledger.activeLeases().length, 0);
});

const runLeases = ledger => ledger.activeLeases().filter(lease => lease.item.startsWith('sandbox:'));

test('a running job holds a lease on its sandbox and its image pin for the whole run, renewed past the first ttl, and gives it up at destroy', async t => {
  const home = await withTempCheckHome(t);
  const file = path.join(home, 'ledger.json');
  const ledger = createDiskLedger({ file });
  const { backend } = providerCheckBackend();
  backend.diskLedger = ledger;
  backend.diskLease = { ttlMs: 400, renewMs: 40 };
  emptyTemplates(backend);
  const handle = await backend.prepare(prepareJob('claude'));
  try {
    const [first] = runLeases(ledger);
    assert.ok(first, 'the job holds a lease once its sandbox exists');
    assert.equal(first.item, `sandbox:${handle.sandbox_id}`);
    assert.equal(first.pin, SHIPPED_PINS.agents.claude.replace('sha256:', ''), 'the lease names the image the sandbox came from');
    await new Promise(resolve => setTimeout(resolve, 900));
    const [later] = runLeases(createDiskLedger({ file }));
    assert.ok(later, 'another process still sees the lease after more than two ttls');
    assert.equal(later.id, first.id);
    assert.ok(later.expiresAt > first.expiresAt + 400, 'it was renewed while the job ran');
  } finally { await backend.destroy(handle); }
  assert.deepEqual(runLeases(ledger), [], 'destroy ends the lease');
});

test('a job lease that was dropped while the process was stalled is taken again at the next renewal', async t => {
  const home = await withTempCheckHome(t);
  // This case explicitly drops the lease. Host preparation time must not expire it first.
  const now = Date.now();
  const ledger = createDiskLedger({ file: path.join(home, 'ledger.json'), now: () => now });
  const { backend } = providerCheckBackend();
  backend.diskLedger = ledger;
  backend.diskLease = { ttlMs: 400, renewMs: 40 };
  emptyTemplates(backend);
  const handle = await backend.prepare(prepareJob('codex'));
  try {
    const [first] = runLeases(ledger);
    assert.ok(first, 'prepare holds a sandbox lease until the test drops it');
    ledger.dropLeases([first.id]);
    assert.deepEqual(runLeases(ledger), []);
    await new Promise(resolve => setTimeout(resolve, 150));
    const [again] = runLeases(ledger);
    assert.ok(again, 'the lease is back');
    assert.notEqual(again.id, first.id);
    assert.equal(again.item, first.item);
    assert.equal(again.pin, first.pin);
  } finally { await backend.destroy(handle); }
  assert.deepEqual(runLeases(ledger), []);
});

test('a job that failed after its sandbox existed leaves no lease behind', async t => {
  const home = await withTempCheckHome(t);
  const ledger = createDiskLedger({ file: path.join(home, 'ledger.json') });
  const { backend } = providerCheckBackend();
  backend.diskLedger = ledger;
  emptyTemplates(backend);
  const handle = await backend.prepare(prepareJob('claude'));
  assert.equal(runLeases(ledger).length, 1);
  await backend.destroy(handle);
  await backend.destroy(handle).catch(() => {});
  assert.deepEqual(runLeases(ledger), []);
  assert.equal(ledger.expiredLeases().filter(lease => lease.item.startsWith('sandbox:')).length, 0);
});

// The removal code is kept behind one setting that is off by default. These tests cover that code, so they turn it on.
function withRemovalOn(t) {
  process.env[REMOVE_ARTIFACTS_ENV] = '1';
  t.after(() => { delete process.env[REMOVE_ARTIFACTS_ENV]; });
}

test('a create records the exact assembled image it produced as owned', async t => {
  withRemovalOn(t);
  const home = await withTempCheckHome(t);
  const ledger = createDiskLedger({ file: path.join(home, 'ledger.json') });
  const { backend } = providerCheckBackend();
  backend.diskLedger = ledger;
  const real = backend.runSbx;
  const ASSEMBLED = 'docker.io/library/sandbox-kit-assembled';
  let listed = false;
  let created = false;
  backend.runSbx = async (args, options) => {
    if (args[0] === 'create') created = true;
    if (args[0] === 'template' && args[1] === 'ls') {
      listed = true;
      return { code: 0, stderr: '', stdout: JSON.stringify([
        ...(created ? [{ id: '6'.repeat(64), repository: ASSEMBLED, tag: 'newnewnewnewnew1', flavor: 'claude', created_at: new Date(Date.now() + 1000).toISOString(), size: 1 }] : []),
        { id: '4'.repeat(64), repository: 'docker.io/docker/sandbox-templates', tag: 'claude-code-docker', flavor: 'claude-code-docker', created_at: new Date(Date.now() + 1000).toISOString(), size: 1 },
      ]) };
    }
    return real(args, options);
  };
  await backend.destroy(await backend.prepare(prepareJob('claude')));
  assert.ok(listed, 'the backend looked at what the create produced');
  assert.deepEqual(Object.keys(ledger.ownedImages()), [`${ASSEMBLED}:newnewnewnewnew1`]);
  assert.equal(ledger.ownedImages()[`${ASSEMBLED}:newnewnewnewnew1`].reason, 'created');
});

test('a listing that cannot be read records no ownership, and the job protection still ends at destroy', async t => {
  withRemovalOn(t);
  const home = await withTempCheckHome(t);
  const ledger = createDiskLedger({ file: path.join(home, 'ledger.json') });
  const { backend } = providerCheckBackend();
  backend.diskLedger = ledger;
  answerSbx(backend, args => args[0] === 'template' && args[1] === 'ls', { code: 0, stdout: 'not json', stderr: '' });
  await backend.destroy(await backend.prepare(prepareJob('claude')));
  assert.equal(ledger.activeLeases().length, 0, 'the job protection ended at destroy');
  assert.deepEqual(ledger.ownedImages(), {}, 'nothing is recorded from a listing that could not be read');
});

test('a lease that cannot be written means no create and no ownership record', async t => {
  await withTempCheckHome(t);
  const events = [];
  const { backend, runner } = providerCheckBackend();
  backend.diskLedger = { ...ledgerSpy(events), acquireLease: () => { throw new Error('disk full'); }, ownImages: (...args) => { events.push(['own', args]); } };
  emptyTemplates(backend);
  await assert.rejects(backend.prepare(prepareJob('claude')), error => error.code === 'disk_protection_unavailable');
  assert.deepEqual(events.filter(event => event[0] === 'own'), [], 'no record is made around a create that had no durable intent');
  assert.equal(runner.calls.some(args => args[0] === 'create'), false);
});

test('a failed create plus an unrelated image of the same repository made in the same minute records no ownership', async t => {
  const home = await withTempCheckHome(t);
  const ledger = createDiskLedger({ file: path.join(home, 'ledger.json') });
  const { backend } = providerCheckBackend();
  backend.diskLedger = ledger;
  const real = backend.runSbx;
  const ASSEMBLED = 'docker.io/library/sandbox-kit-assembled';
  let listed = 0;
  backend.runSbx = async (args, options) => {
    if (args[0] === 'template' && args[1] === 'ls') {
      listed++;
      // Somebody else's image of the same repository, created just after the lease began.
      return { code: 0, stderr: '', stdout: JSON.stringify([{ id: '611f52fac7bf', repository: ASSEMBLED, tag: 'someone-elses-image', flavor: 'claude', created_at: new Date(Date.now() + 1000).toISOString(), size: 1 }]) };
    }
    return real(args, options);
  };
  answerSbx(backend, args => args[0] === 'create', { code: 1, stdout: '', stderr: 'boom' });
  await assert.rejects(backend.prepare(prepareJob('claude')), /boom|start/);
  assert.deepEqual(ledger.ownedImages(), {}, 'no image is recorded as ours on the strength of its timestamp');
  assert.ok(listed >= 1, 'the backend compares listings, so a look happened and found nothing new');
  assert.equal(ledger.activeLeases().length + ledger.expiredLeases().length, 0, 'the lease still ended');
});

test('the disk reading the sweep and the warning use is the drive that holds the sandbox store, not the smallest of all the drives a job touches', async t => {
  await withTempCheckHome(t);
  const store = 90 * 1024 ** 3;
  const other = 3 * 1024 ** 3;
  // The job guard watches several drives; one of them is nearly full. The store is not on it.
  const hostDisk = { free: async () => ({ free: other, volumes: [{ path: '/other', free: other, memory: false }, { path: '/store', free: store, memory: false }] }) };
  const { backend } = providerCheckBackend();
  backend.hostDisk = hostDisk;
  backend.storeDisk = { free: async () => ({ free: store, volumes: [{ path: '/store', free: store, memory: false }] }) };
  const adapters = backend.diskSweepAdapters();
  assert.equal(await adapters.hostFree(), store);
  assert.equal(await adapters.measureFree(), store, 'a sweep gain is measured on the store only; other drives are not summed in');
  backend.storeDisk = { free: async () => { throw new Error('no statfs'); } };
  await assert.rejects(adapters.measureFree(), /store|statfs/, 'an unreadable store reading is an error, never a number');
});

test('a guest runtime directory is recorded as owned when it is written', async t => {
  const home = await withTempCheckHome(t);
  const ledger = createDiskLedger({ file: path.join(home, 'ledger.json') });
  const dir = path.join(home, 'cache', 'a'.repeat(64));
  const backend = new DockerSbxBackend({ guestRuntime: async () => ({ dir, node: path.join(dir, 'node'), sha256: '0'.repeat(64), created: true }) });
  backend.diskLedger = ledger;
  await backend.guestRuntime({});
  assert.deepEqual(ledger.ownedCaches()[dir]?.reason, 'created');
});

test('a guest runtime directory that already existed is never recorded as owned', async t => {
  const home = await withTempCheckHome(t);
  const ledger = createDiskLedger({ file: path.join(home, 'ledger.json') });
  const dir = path.join(home, 'cache', 'b'.repeat(64));
  const backend = new DockerSbxBackend({ guestRuntime: async () => ({ dir, node: path.join(dir, 'node'), sha256: '0'.repeat(64), created: false }) });
  backend.diskLedger = ledger;
  await backend.guestRuntime({});
  assert.deepEqual(ledger.ownedCaches(), {});
});

test('the disk sweep adapters offer only exact-name sbx access, the live handles as references, and the shipped digests', async t => {
  await withTempCheckHome(t);
  const { backend } = providerCheckBackend();
  const adapters = backend.diskSweepAdapters();
  const digests = adapters.pins();
  assert.ok(digests.includes(SHIPPED_PINS.agents.codex.replace('sha256:', '')));
  assert.ok(digests.every(digest => /^[0-9a-f]{64}$/.test(digest)));
  assert.equal(adapters.journal, backend.cleanupJournal);
  assert.equal(adapters.referenced().size, 0);
  assert.deepEqual(Object.keys(adapters.usage), ['scratchRoot', 'logsDir', 'cacheRoot']);
  assert.ok(adapters.usage.logsDir.endsWith(path.join('v1', 'logs')));
  assert.equal(adapters.caches() === null || typeof adapters.caches().root === 'string', true);
});
test('an agent with no checked-in digest is refused before any workspace or sbx call', async t => {
  await withTempCheckHome(t);
  const runner = sbxRunner(createSbxPolicy());
  const backend = new DockerSbxBackend({ runCommand: runner.run, deadlineTimers: manualTimers(), home: process.env.FARAVAN_SBX_HOME,
    hostDisk: { free: async () => ({ free: 2 ** 40 }) } });
  await assert.rejects(backend.prepare(validJob({ image: 'gemini', execution_scope: 'borrowed', auth_strategy: 'docker-stored-secret' })),
    error => error.code === 'policy_unenforceable' && /gemini/.test(error.message));
  assert.ok(!runner.calls.some(args => ['create', 'run'].includes(args[0])), 'no sandbox was created');
});
test('every create dispatch gets a fresh name, whatever its job or owner',async()=>{
  const {freshSandboxName}=await import('../lib/sandbox-name.mjs');
  const names=new Set(Array.from({length:64},()=>freshSandboxName()));
  assert.equal(names.size,64);
  for(const name of names)assert.match(name,/^wf-[0-9a-f]{16}$/);
});

test('failed create with unreadable inventory retains its cleanup obligation',async()=>{
  const mutations=[];
  const backend=new DockerSbxBackend({deadlineTimers:manualTimers(),runCommand:async args=>{
    if(args[0]==='rm'||args[0]==='policy'&&args[1]==='rm')mutations.push(args);
    return {code:0,stdout:args[0]==='settings'?(args[1]==='get'&&args[2]==='ssh.agentForwardingEnabled'?'false':''):'{"secrets":[],"custom_secrets":[],"shadowed_services":[],"env_only_count":0}'};
  }});
  // The create is dispatched and its command fails: whether it materialized is unknown.
  backend._runJobCommand=async(_handle,_args,_onLog,options={})=>{options.onDispatch?.();const result={code:1,stderr:'name already exists'};options.onResult?.(result);return result;};
  await assert.rejects(backend.prepare(validJob({job_id:'shared-job'})),error=>{assert.equal(error.code,'sandbox_start_failed');assert.equal(error.cleanup_receipt.removed,false);return true;});
  assert.deepEqual(mutations,[]);
});

test('disk halt never SIGKILLs an unmapped foreign shim on the same HOME',async()=>{
  const {killIdentitySandboxes}=await import('../lib/docker-backend.mjs');
  const root=await mkdtemp(path.join(os.tmpdir(),'disk-foreign-shim-'));
  await mkdir(path.join(root,'424242'));
  await writeFile(path.join(root,'424242','cmdline'),'containerd-shim-nerdbox-v1\0foreign\0');
  await writeFile(path.join(root,'424242','environ'),'HOME=/shared\0');
  const original=process.kill,calls=[];process.kill=(...args)=>{calls.push(args);return true;};
  try {
    const backend=new DockerSbxBackend({killSandboxes:()=>killIdentitySandboxes({procRoot:root,home:'/shared'}),diskTimers:{
      setTimeout(callback){return {handle:setImmediate(callback),unref(){}};},clearTimeout(timer){clearImmediate(timer.handle);},
    }});
    backend.cancel=async()=>new Promise(()=>{});
    await assert.rejects(backend._haltForDisk({sandbox_id:'own-sandbox'},{created:true}),{code:'sandbox_stop_failed'});
    assert.equal(await killIdentitySandboxes({procRoot:root,home:'/shared'}),false);
    assert.deepEqual(calls,[]);
  }
  finally{process.kill=original;await rm(root,{recursive:true,force:true});}
});

// --- Disk collection safety: lease admission, create attribution, retained roots ---------------------------------------
const DISK_ASSEMBLED = 'docker.io/library/sandbox-kit-assembled';
const diskImage = (tag, digest, createdAtMs) => ({ id: digest.slice(0, 12), repository: DISK_ASSEMBLED, tag, flavor: 'codex', created_at: new Date(createdAtMs).toISOString(), size: 1000 });
const diskDispatched = runner => runner.calls.filter(args => args[0] === 'create' || args[0] === 'run');
const listTemplates = (backend, rows) => answerSbx(backend, args => args[0] === 'template' && args[1] === 'ls', { code: 0, stdout: JSON.stringify(rows), stderr: '' });
const throwingAdmission = ledger => Object.create(ledger, { acquireLease: { value: () => { throw new Error('disk full'); } } });


for (const scenario of ['complete', 'empty-before', 'incomplete-before', 'incomplete-after']) test(
  `disk create attribution uses exact full inventory: ${scenario}`, async () => {
    const fullArgs = ['template', 'ls', '--all', '--digests', '--no-trunc', '--json'];
    const old = { repository: DISK_ASSEMBLED, tag: 'old-kit', id: 'a'.repeat(64) };
    const fresh = { repository: DISK_ASSEMBLED, tag: 'new-kit', id: 'b'.repeat(64) };
    const oldRows = scenario === 'empty-before' ? [] : [old];
    const newRows = [...oldRows, fresh];
    const calls = [], owned = [];
    let creating = true, releases = 0;
    const listing = async args => {
      assert.equal(creating, true, 'both snapshots are inside the held gate');
      calls.push(args);
      const rows = calls.length === 1 ? oldRows : newRows;
      const exact = JSON.stringify(args) === JSON.stringify(fullArgs);
      const incomplete = (scenario === 'incomplete-before' && calls.length === 1)
        || (scenario === 'incomplete-after' && calls.length === 2);
      const data = !exact || (incomplete && calls.length === 2) ? rows.map(row => ({ ...row, id: row.id.slice(0, 12) }))
        : incomplete ? { images: rows } : rows;
      return { code: 0, stdout: JSON.stringify(data), stderr: '' };
    };
    const handle = { _sbxRuntime: {} }, signal = new AbortController().signal;
    const gate = { release() { assert.equal(creating, true); creating = false; releases++; } };
    const fixture = {
      diskLedger: { damaged: false, ownImages: (records, reason) => owned.push({ records, reason }) },
      _diskCoordinator: () => ({ acquire: async options => { assert.equal(options.signal, signal); return gate; } }),
      _removalConflicts: () => false,
      _leaseHold: () => ({ pin: null }),
      _kitGenerationForReport: () => null,
      runSbx: (args, options) => {
        assert.equal(options.signal, signal);
        assert.equal(options.sbxRuntime, handle._sbxRuntime);
        return listing(args);
      },
      _diskRunSbx: (args, _options, accountHandle) => {
        assert.equal(accountHandle, handle);
        return listing(args);
      },
    };
    const hold = await RuntimeDockerSbxBackend.prototype._admitDiskJob.call(fixture, 'fixture', null, signal, null, handle);
    await RuntimeDockerSbxBackend.prototype._settleDiskCreate.call(fixture, hold, { created: true }, handle);
    assert.equal(releases, 1);
    assert.deepEqual(calls, scenario === 'incomplete-before' ? [fullArgs] : [fullArgs, fullArgs]);
    assert.deepEqual(hold.before, scenario === 'incomplete-before' ? null
      : scenario === 'empty-before' ? [] : [`${DISK_ASSEMBLED}:old-kit|${old.id}`]);
    assert.deepEqual(owned, scenario.startsWith('incomplete') ? [] : [
      { records: [{ ref: `${DISK_ASSEMBLED}:new-kit`, imageId: fresh.id }], reason: 'created' },
    ]);
  });

test('disk collection: a lease that cannot be written means no create or run is dispatched', async t => {
  const home = await withTempCheckHome(t);
  const { backend, runner } = providerCheckBackend();
  backend.diskLedger = throwingAdmission(createDiskLedger({ file: path.join(home, 'ledger.json') }));
  emptyTemplates(backend);
  await assert.rejects(backend.prepare(prepareJob('codex')));
  assert.deepEqual(diskDispatched(runner), [], 'no sandbox command ran without a durable lease');
});

test('disk collection: a coordinator that fails admission means no create or run is dispatched', async t => {
  const home = await withTempCheckHome(t);
  const { backend, runner } = providerCheckBackend();
  backend.diskLedger = createDiskLedger({ file: path.join(home, 'ledger.json') });
  backend._diskCoordinator = () => ({ dir: home, exclusive: async () => { throw Object.assign(new Error('The sandbox store is busy.'), { code: 'store_busy' }); }, sweep: async () => ({ skipped: 'store_busy' }) });
  emptyTemplates(backend);
  await assert.rejects(backend.prepare(prepareJob('codex')));
  assert.deepEqual(diskDispatched(runner), []);
});

test('disk collection: a run lease that cannot be written does not let the job go on unprotected', async t => {
  const home = await withTempCheckHome(t);
  const { backend, runner } = providerCheckBackend();
  const real = createDiskLedger({ file: path.join(home, 'ledger.json') });
  let calls = 0;
  backend.diskLedger = Object.create(real, { acquireLease: { value: args => { if (++calls > 0) throw new Error('disk full'); return real.acquireLease(args); } } });
  emptyTemplates(backend);
  const outcome = await backend.prepare(prepareJob('codex')).then(handle => ({ handle }), error => ({ error }));
  if (outcome.handle) await backend.destroy(outcome.handle);
  assert.ok(outcome.error, 'prepare refused the job instead of running it without a run lease');
  assert.equal(runner.calls.some(args => args[0] === 'run' && args.includes('-d')), false, 'the job was never started');
});

test('disk collection: a failed admission racing a second sweeper never lets the create reuse an image the sweeper removes', async t => {
  const home = await withTempCheckHome(t);
  const { backend } = providerCheckBackend();
  const OLDDIGEST = 'c'.repeat(64), CURDIGEST = 'a'.repeat(64);
  const aged = Date.now() - 24 * 3600 * 1000;
  const reused = diskImage('1111111111111111', OLDDIGEST, aged);
  const file = path.join(home, 'ledger.json');
  const setup = createDiskLedger({ file });
  
  setup.ownImages([{ ref: `${DISK_ASSEMBLED}:1111111111111111`, imageId: reused.id }, { ref: `${DISK_ASSEMBLED}:0a0a0a0a0a0a0a0a`, imageId: CURDIGEST.slice(0, 12) }], 'created');
  backend.diskLedger = throwingAdmission(createDiskLedger({ file }));
  let templates = [diskImage('0a0a0a0a0a0a0a0a', CURDIGEST, aged), reused];
  const events = [];
  const releaseCreate = (() => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; })();
  const real = backend.runSbx;
  backend.runSbx = async (args, options) => {
    if (args[0] === 'template' && args[1] === 'ls') return { code: 0, stderr: '', stdout: JSON.stringify(templates) };
    if (args[0] === 'create') { events.push('create'); await releaseCreate.promise; }
    return real(args, options);
  };
  const prepared = backend.prepare(prepareJob('codex')).then(handle => ({ handle }), error => ({ error }));
  for (let i = 0; i < 50 && !events.includes('create'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  const sweeper = createDiskSweeper({
    ledger: createDiskLedger({ file }), coordinator: createStoreCoordinator({ dir: home }), journal: { recorded: () => true },
    pins: () => [CURDIGEST], referenced: () => new Set(),
    runSbx: async args => {
      if (args[0] === 'template' && args[1] === 'ls') return { code: 0, stderr: '', stdout: JSON.stringify(templates) };
      if (args[0] === 'ls') return { code: 0, stderr: '', stdout: '[]' };
      if (args[0] === 'template' && args[1] === 'rm') { events.push('removed'); templates = templates.filter(row => `${row.repository}:${row.tag}` !== args[2]); return { code: 0, stdout: '', stderr: '' }; }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    },
    measureFree: async () => null,
  });
  await sweeper.run({ trigger: 'test' });
  releaseCreate.release();
  const outcome = await prepared;
  if (outcome.handle) await backend.destroy(outcome.handle);
  assert.equal(events.includes('create') && events.includes('removed'), false, `a create ran on an image another sweeper removed: ${events.join(',')}`);
});

test('disk collection: an unrelated same-repository image made before a failed create is never recorded as owned', async t => {
  const home = await withTempCheckHome(t);
  const ledger = createDiskLedger({ file: path.join(home, 'ledger.json') });
  
  const { backend } = providerCheckBackend();
  backend.diskLedger = ledger;
  listTemplates(backend, [diskImage('2222222222222222', 'd'.repeat(64), Date.now() - 30 * 1000)]);
  answerSbx(backend, args => args[0] === 'create', { code: 1, stdout: '', stderr: 'boom' });
  await assert.rejects(backend.prepare(prepareJob('codex')));
  assert.deepEqual(ledger.ownedImages(), {}, 'an image that exists because of someone else is not ours');
});

test('disk collection: a successful create does not own an unrelated image made 30 seconds before it began', async t => {
  const home = await withTempCheckHome(t);
  const ledger = createDiskLedger({ file: path.join(home, 'ledger.json') });
  
  const { backend } = providerCheckBackend();
  backend.diskLedger = ledger;
  listTemplates(backend, [diskImage('2222222222222222', 'd'.repeat(64), Date.now() - 30 * 1000)]);
  await backend.destroy(await backend.prepare(prepareJob('codex')));
  assert.equal(ledger.ownedImages()[`${DISK_ASSEMBLED}:2222222222222222`], undefined);
});

test('disk collection: unrelated scratch entries do not hide retained job roots', async t => {
  const home = await withTempCheckHome(t);
  const { backend } = providerCheckBackend();
  const scratch = path.join(home, 'scratch');
  await mkdir(scratch);
  const original = process.env.FARAVAN_SCRATCH_ROOT;
  process.env.FARAVAN_SCRATCH_ROOT = scratch;
  t.after(() => {
    if (original === undefined) delete process.env.FARAVAN_SCRATCH_ROOT;
    else process.env.FARAVAN_SCRATCH_ROOT = original;
  });
  for (let i = 0; i < 20_001; i++) fs.writeFileSync(path.join(scratch, `unrelated-${i}`), '');
  await mkdir(path.join(scratch, 'wf-job-wf-00000000000000a1-example'));
  assert.deepEqual([...backend.diskSweepAdapters().retained()], ['wf-00000000000000a1']);
});

test('disk collection: an unreadable retained-job root makes the adapter fail closed instead of reporting no retained jobs', async t => {
  const home = await withTempCheckHome(t);
  const { backend } = providerCheckBackend();
  const scratchFile = path.join(home, 'scratch-is-a-file');
  await writeFile(scratchFile, 'x');
  const saved = process.env.FARAVAN_SCRATCH_ROOT;
  process.env.FARAVAN_SCRATCH_ROOT = scratchFile;
  t.after(() => { process.env.FARAVAN_SCRATCH_ROOT = saved; });
  const adapters = backend.diskSweepAdapters();
  const ledger = createDiskLedger({ file: path.join(home, 'ledger.json') });
  const OLDDIGEST = 'c'.repeat(64), CURDIGEST = 'a'.repeat(64);
  const aged = Date.now() - 24 * 3600 * 1000;
  
  const only = diskImage('1111111111111111', OLDDIGEST, aged);
  ledger.ownImages([{ ref: `${DISK_ASSEMBLED}:1111111111111111`, imageId: only.id }, { ref: `${DISK_ASSEMBLED}:0a0a0a0a0a0a0a0a`, imageId: CURDIGEST.slice(0, 12) }], 'created');
  const templates = [diskImage('0a0a0a0a0a0a0a0a', CURDIGEST, aged), only];
  const removed = [];
  const sweeper = createDiskSweeper({
    ledger, coordinator: createStoreCoordinator({ dir: home }), journal: { recorded: () => true }, pins: () => [CURDIGEST], referenced: () => new Set(),
    retained: adapters.retained,
    runSbx: async args => {
      if (args[0] === 'template' && args[1] === 'ls') return { code: 0, stderr: '', stdout: JSON.stringify(templates) };
      if (args[0] === 'ls') return { code: 0, stderr: '', stdout: '[]' };
      if (args[0] === 'template' && args[1] === 'rm') { removed.push(args[2]); return { code: 0, stdout: '', stderr: '' }; }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    },
    measureFree: async () => null,
  });
  const summary = await sweeper.run({ trigger: 'test' });
  assert.deepEqual(removed, [], 'with the retained roots unreadable nothing is removed');
  assert.ok(summary.errors.length > 0, 'the unreadable root is reported');
  assert.ok(ledger.ownedImages()[`${DISK_ASSEMBLED}:1111111111111111`], 'and the ledger keeps its record');
});

for (const failingMethod of ['ownImages', 'recordKitImages']) test(
  `report-only ${failingMethod} failure never blocks create or changes its pinned sandbox record`, async t => {
    await withTempCheckHome(t);
    const events = [];
    const { backend, runner } = providerCheckBackend();
    let attempted = 0;
    let generation = null;
    backend.diskLedger = {
      ...ledgerSpy(events),
      ownImages() { if (failingMethod === 'ownImages') { attempted++; throw new Error('report unavailable'); } },
      recordKitImages() { attempted++; throw new Error('report unavailable'); },
      kitGenerations: () => generation,
    };
    emptyTemplates(backend);
    const real = backend.runSbx;
    let created = false;
    backend.runSbx = (args, options) => {
      if (args[0] === 'create') { created = true; events.push(['create']); }
      if (args[0] === 'template' && args[1] === 'ls' && created && failingMethod === 'ownImages')
        return Promise.resolve({ code: 0, stdout: JSON.stringify([{ repository: 'docker.io/library/sandbox-kit-assembled',
          tag: 'new-current', id: 'd'.repeat(64), size: 100 }]) });
      return real(args, options);
    };
    const handle = await backend.prepare(prepareJob('claude'));
    try {
      assert.ok(runner.calls.some(args => args[0] === 'create'));
      assert.deepEqual(events.map(event => event[0]), ['lease', 'create', 'record']);
      assert.equal(events[2][2], SHIPPED_PINS.agents.claude.replace('sha256:', ''));
      assert.equal(attempted, 1, 'the failing reporting operation was actually attempted after create');
      assert.equal(backend.diskLedger.kitGenerations(), null);
    } finally { await backend.destroy(handle); }
    assert.equal(events.filter(event => event[0] === 'release').length, 1);
  });

// The ordinary post-install sentinel checks run as one bounded group. A fake sbx holds each `policy check` reply until the
// test releases it, so how many are in flight, in what order, and when anything else may start are all observable.
const turns = async (count = 40) => { for (let i = 0; i < count; i++) await new Promise(resolve => setImmediate(resolve)); };
function gatedSentinelBackend({ wallSeconds = 100 } = {}) {
  const model = createSbxPolicy(), runner = sbxRunner(model, undefined, { secretResult: secretListing([]) });
  const timers = manualTimers(), order = [], held = [], gate = { flip: new Set(), inFlight: 0, maxInFlight: 0, started: [] };
  const clock = { now: 0 };
  const runCommand = async (args, options) => {
    order.push([...args]);
    if (args[0] !== 'policy' || args[1] !== 'check') return runner.run(args, options);
    const target = args.at(-1);
    gate.started.push(target);
    gate.maxInFlight = Math.max(gate.maxInFlight, ++gate.inFlight);
    const entry = { target };
    held.push(entry);
    await new Promise(resolve => { entry.release = resolve; });
    gate.inFlight--;
    // A sandbox that no longer exists answers nothing (the policy model would otherwise conjure an empty one).
    if (!Object.hasOwn(model.state.sandboxes, args[args.indexOf('--sandbox') + 1])) return { code: 1, stdout: '', stderr: 'no such sandbox' };
    const real = await runner.run(args, options), allowed = JSON.parse(real.stdout).allowed;
    return gate.flip.has(target) ? { ...real, stdout: JSON.stringify({ allowed: !allowed }) } : real;
  };
  const backend = new DockerSbxBackend({ runCommand, deadlineTimers: timers, home: process.env.FARAVAN_SBX_HOME,
    hostDisk: { free: async () => ({ free: 2 ** 40 }) } });
  backend.monotonic = () => clock.now;
  const job = validJob({ image: 'codex', auth_strategy: 'docker-native-oauth', egress: 'provider-only', provider_hosts: ['**.openai.com'],
    resources: { ...validJob().resources, wall_seconds: wallSeconds } });
  // Release what is held now, in the given order, and let the freed workers pick up the next checks.
  const release = async (pick = entries => entries) => { const now = pick([...held]); for (const entry of now) { held.splice(held.indexOf(entry), 1); entry.release(); } await turns(); return now.map(entry => entry.target); };
  // The sentinel phase is the first unbroken run of policy checks (the baseline listing and installs come before, the readback after).
  const sentinelRun = () => { const first = order.findIndex(args => args[0] === 'policy' && args[1] === 'check');
    const rest = order.slice(first); const end = rest.findIndex(args => !(args[0] === 'policy' && args[1] === 'check'));
    return (end < 0 ? rest : rest.slice(0, end)).map(args => args.at(-1)); };
  return { backend, model, timers, order, held, gate, clock, job, release, sentinelRun };
}
// The first wave fills the cap; a serial phase never gets there, so fail instead of waiting.
async function firstWave(held) {
  const until = Date.now() + 3000;
  while (held.length < 8) { assert.ok(Date.now() < until, `only ${held.length} checks in flight, expected the cap of 8`); await turns(1); }
}
const guestLaunches = order => order.filter(args => args[0] === 'exec' && args.includes('sh'));
const removals = (order, name) => order.filter(args => args[0] === 'rm' && args.at(-1) === name);

test('post-install sentinel checks run together within the worker cap and nothing is dispatched until every one passes', async (t) => {
  await withTempCheckHome(t);
  const { backend, order, held, gate, job, release, sentinelRun } = gatedSentinelBackend();
  const prepared = backend.prepare(job);
  prepared.catch(() => {});
  await firstWave(held);
  await turns();
  assert.equal(held.length, 8, 'the first wave fills the existing cap and no more');
  assert.equal(gate.maxInFlight, 8);
  const installIndex = order.findIndex(args => args[0] === 'policy' && args[1] === 'allow');
  assert.ok(installIndex >= 0 && order.findIndex(args => args[0] === 'policy' && args[1] === 'check') > installIndex, 'checks follow the installs');
  const listingsBefore = order.filter(args => args[0] === 'policy' && args[1] === 'ls').length;
  // Count release rounds until the phase ends (the post-install listing is the first non-check command after the run).
  const phaseEnded = () => { const first = order.findIndex(args => args[0] === 'policy' && args[1] === 'check');
    return order.slice(first).some(args => !(args[0] === 'policy' && args[1] === 'check')); };
  let rounds = 0;
  while (!phaseEnded() && rounds < 20) { await release(); rounds++; }
  const sentinels = sentinelRun();
  while (held.length) await release();
  assert.ok(sentinels.length > 8, 'the restricted job has more sentinels than one wave holds');
  assert.deepEqual(gate.started.slice(0, sentinels.length), sentinels, 'every witness is checked once, started in list order');
  assert.equal(rounds, Math.ceil(sentinels.length / 8), 'completion waves drop from one per witness to one per cap');
  assert.ok(rounds < sentinels.length);
  assert.ok(sentinels.includes('10.0.0.1') && sentinels.includes('mcp-gateway.docker.internal:443') && sentinels.includes('example.com'));
  const handle = await prepared;
  try {
    for (const target of sentinels) assert.ok(Object.hasOwn(handle._policyVerification, target), `${target} is recorded`);
    assert.deepEqual(Object.keys(handle._policyVerification).slice(0, sentinels.length), sentinels, 'recorded in list order');
    const firstGuest = order.findIndex(args => args[0] === 'exec' && args.includes('sh'));
    const lastSentinel = order.findLastIndex(args => args[0] === 'policy' && args[1] === 'check');
    assert.ok(firstGuest < 0 || firstGuest > lastSentinel, 'no guest command before the last sentinel');
    assert.equal(order.filter(args => args[0] === 'policy' && args[1] === 'ls').length, listingsBefore + 1, 'one post-install listing, after the checks');
  } finally { await backend.destroy(handle).catch(() => {}); }
});

test('a failing sentinel reports the first failure in list order, stops dequeuing, settles in-flight checks and cleans only the owned row', async (t) => {
  await withTempCheckHome(t);
  const { backend, model, order, held, gate, job, release } = gatedSentinelBackend();
  model.createSandbox('foreign-row', { kitAllow: [] });
  const prepared = backend.prepare(job), outcome = prepared.then(() => null, error => error);
  await firstWave(held);
  await turns();
  const first = held.map(entry => entry.target);
  // Two witnesses disagree; the later one answers first.
  gate.flip.add(first[2]); gate.flip.add(first[5]);
  const startedBeforeFailure = gate.started.length;
  let settled = false; outcome.then(() => { settled = true; });
  await release(entries => entries.filter(entry => entry.target === first[5]));
  await turns();
  assert.equal(settled, false, 'the phase does not fail while other started checks are still in flight');
  assert.equal(gate.started.length, startedBeforeFailure, 'no further check starts after a failure');
  await release();
  const error = await outcome;
  assert.equal(error?.code, 'policy_unenforceable');
  assert.match(error.message, new RegExp(`for ${first[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`), 'the lowest list index is the one reported');
  assert.equal(gate.started.length, startedBeforeFailure, 'nothing queued was started during the drain');
  assert.deepEqual(Object.keys(error.policy_verification), first.slice(0, 3), 'recorded verification stops at the first failing witness');
  assert.equal(guestLaunches(order).length, 0, 'no job starts');
  assert.ok(model.state.sandboxes['foreign-row'], 'a foreign sandbox is untouched');
  assert.equal(order.filter(args => args[0] === 'rm' && args.at(-1) === 'foreign-row').length, 0);
  const owned = Object.keys(model.state.sandboxes).filter(name => name !== 'foreign-row');
  assert.deepEqual(owned, [], 'the owned sandbox was removed');
  assert.equal(order.filter(args => args[0] === 'rm').length, 1, 'exactly one removal');
});

test('a last check that returns after the absolute deadline refuses, dispatches nothing and cleans only the original row', async (t) => {
  await withTempCheckHome(t);
  const { backend, model, timers, order, held, gate, clock, job, release } = gatedSentinelBackend({ wallSeconds: 100 });
  model.createSandbox('foreign-row', { kitAllow: [] });
  const prepared = backend.prepare(job), outcome = prepared.then(() => null, error => error);
  await firstWave(held);
  await turns();
  const names = () => Object.keys(model.state.sandboxes).filter(name => name !== 'foreign-row');
  const [owned] = names();
  assert.ok(owned);
  // Every witness answers in time except the last one of the first wave; the deadline passes while it is outstanding.
  const last = held[held.length - 1].target;
  await release(entries => entries.filter(entry => entry.target !== last));
  await turns();
  clock.now = 100_000;
  timers.fire(100_000);
  await turns();
  await release();
  while (held.length) await release();
  const error = await outcome;
  assert.equal(error?.code, 'wall_timeout');
  assert.equal(guestLaunches(order).length, 0, 'no job starts');
  assert.ok(model.state.sandboxes['foreign-row'], 'a foreign row survives');
  assert.deepEqual(names(), [], 'the original row is gone');
  assert.equal(removals(order, owned).length, 1, 'cleanup removed the original row exactly once');
  assert.equal(order.filter(args => args[0] === 'rm' && args.at(-1) !== owned).length, 0, 'nothing else was removed');
});

test('a replacement sandbox created while the checks were outstanding is never removed by the refused job', async (t) => {
  await withTempCheckHome(t);
  const { backend, model, timers, order, held, clock, job, release } = gatedSentinelBackend({ wallSeconds: 100 });
  const prepared = backend.prepare(job), outcome = prepared.then(() => null, error => error);
  await firstWave(held);
  await turns();
  const [owned] = Object.keys(model.state.sandboxes);
  clock.now = 100_000;
  timers.fire(100_000);
  await turns(60);
  // The deadline cleanup took the original row; a different sandbox now holds that name.
  assert.deepEqual(Object.keys(model.state.sandboxes), [], 'the original row was removed at the deadline');
  model.createSandbox(owned, { kitAllow: [] });
  await release();
  while (held.length) await release();
  const error = await outcome;
  assert.equal(error?.code, 'wall_timeout');
  assert.equal(guestLaunches(order).length, 0);
  assert.ok(model.state.sandboxes[owned], 'the replacement under the same name survives');
  assert.equal(removals(order, owned).length, 1, 'only the original removal ran');
});

// Keeps releasing held policy checks until the preparation settles: the next wave of checks starts after a release, so
// an empty queue only means it has not arrived yet.
async function drainUntilSettled(settled, held, release) {
  const until = Date.now() + 10_000;
  let done = false;
  settled.then(() => { done = true; });
  while (!done) {
    assert.ok(Date.now() < until, 'preparation did not settle');
    if (held.length) await release(); else await turns(5);
  }
}

// Separate preparation clock. Preparation has its own fixed bound; the wall_seconds run clock starts at the agent handoff
// (start), and every phase is also capped by the caller's lease (wallRemainingMs) and the reserved outer deadline.
async function preparedUnderClock({ wallSeconds = 60, prepareOptions = {}, at = 70_000 } = {}) {
  const fixture = gatedSentinelBackend({ wallSeconds });
  const prepared = fixture.backend.prepare(fixture.job, { separatePreparationClock: true, ...prepareOptions });
  const outcome = prepared.then(handle => ({ handle }), error => ({ error }));
  await firstWave(fixture.held);
  await turns();
  fixture.clock.now = at;
  await drainUntilSettled(outcome, fixture.held, fixture.release);
  return { ...fixture, outcome };
}

test('preparation runs on its own bounded clock, not on wall_seconds', async (t) => {
  await withTempCheckHome(t);
  const { timers, outcome, clock } = await preparedUnderClock({ at: 70_000 });
  const { handle, error } = await outcome;
  assert.equal(error, undefined, 'a preparation longer than wall_seconds is not a wall timeout');
  assert.equal(clock.now, 70_000);
  assert.equal(handle._deadline.phase, 'prepare');
  assert.equal(handle._deadline.endsAt, PREPARATION_BUDGET_MS, 'preparation ends at its fixed bound from entry');
  timers.fire(PREPARATION_BUDGET_MS);
  assert.equal(handle._deadline.expired, true, 'the armed timer is the preparation bound');
});

test('the run clock starts at the agent handoff and is capped by the signed lease', async (t) => {
  await withTempCheckHome(t);
  const { backend, timers, outcome } = await preparedUnderClock({ at: 70_000, prepareOptions: { wallRemainingMs: () => 3_600_000 } });
  const { handle } = await outcome;
  assert.equal(handle._deadline.endsAt, PREPARATION_BUDGET_MS);
  await backend.start(handle);
  assert.equal(handle._deadline.phase, 'run');
  assert.equal(handle._deadline.endsAt, 70_000 + 60_000, 'wall_seconds counted from the handoff, not from entry');
  timers.fire(60_000);
  assert.equal(handle._deadline.expired, true, 'the single re-armed timer ends the run, the preparation timer is gone');
});

test('a lease that ends before the run budget is never extended by the handoff', async (t) => {
  await withTempCheckHome(t);
  const { backend, outcome } = await preparedUnderClock({ at: 50_000, prepareOptions: { wallRemainingMs: () => 90_000 } });
  const { handle } = await outcome;
  assert.equal(handle._deadline.endsAt, 90_000, 'preparation is capped at the lease');
  assert.equal(handle._deadline.runClock.outerEndsAt, 90_000, 'the reserved outer end is capped at the lease');
  await backend.start(handle);
  assert.equal(handle._deadline.endsAt, 90_000, 'handoff at 50 s plus 60 s would pass the lease, so the lease wins');
});

test('the external deadline is reserved for the outer bound once and never renewed by the handoff', async (t) => {
  await withTempCheckHome(t);
  const { backend, outcome } = await preparedUnderClock({ at: 10_000, prepareOptions: { wallRemainingMs: () => 3_600_000 } });
  const { handle } = await outcome;
  const reserved = handle.deadline_at;
  assert.ok(reserved > 0);
  await backend.start(handle);
  assert.equal(handle.deadline_at, reserved, 'the durable supervisor deadline is unchanged by the handoff');
  assert.equal(handle._deadline.runClock.outerEndsAt, PREPARATION_BUDGET_MS + 60_000);
});

test('an expired preparation is refused at the handoff and the run clock never starts', async (t) => {
  await withTempCheckHome(t);
  const { backend, order, outcome, clock } = await preparedUnderClock({ at: 70_000 });
  const { handle } = await outcome;
  clock.now = PREPARATION_BUDGET_MS;
  await assert.rejects(backend.start(handle), { code: 'wall_timeout' });
  assert.equal(handle._deadline.phase, 'prepare', 'refused before the run clock could start');
  assert.equal(handle._deadline.endsAt, PREPARATION_BUDGET_MS, 'no new clock renewed the expired attempt');
  assert.equal(guestLaunches(order).length, 0, 'nothing launched in the guest');
});

test('preparation expiry at its own bound removes only the owned row', async (t) => {
  await withTempCheckHome(t);
  const { backend, model, timers, order, held, clock, job, release } = gatedSentinelBackend({ wallSeconds: 60 });
  model.createSandbox('foreign-row', { kitAllow: [] });
  const prepared = backend.prepare(job, { separatePreparationClock: true }), outcome = prepared.then(() => null, error => error);
  await firstWave(held);
  await turns();
  const [owned] = Object.keys(model.state.sandboxes).filter(name => name !== 'foreign-row');
  clock.now = 70_000;
  timers.advance(60_000);
  await turns();
  assert.ok(model.state.sandboxes[owned], 'wall_seconds alone does not remove it');
  clock.now = PREPARATION_BUDGET_MS;
  timers.fire(PREPARATION_BUDGET_MS);
  await turns(60);
  await drainUntilSettled(outcome, held, release);
  const error = await outcome;
  assert.equal(error?.code, 'wall_timeout');
  assert.equal(guestLaunches(order).length, 0);
  assert.ok(model.state.sandboxes['foreign-row'], 'a foreign row survives');
  assert.equal(removals(order, owned).length, 1, 'the owned row was removed exactly once');
  assert.equal(order.filter(args => args[0] === 'rm' && args.at(-1) !== owned).length, 0, 'nothing else was removed');
});

test('check sandboxes share the agent state and a handoff never rebases them', async () => {
  const backend = new DockerSbxBackend({});
  const state = { phase: undefined, endsAt: 5_000, timer: null, runClock: undefined };
  backend._beginRunClock({ _deadline: state });
  assert.equal(state.endsAt, 5_000);
  assert.equal(state.phase, undefined);
});

test('a handoff without an acknowledged durable watchdog never starts the run clock or the guest', async (t) => {
  await withTempCheckHome(t);
  const { backend, order, outcome } = await preparedUnderClock({ at: 70_000 });
  const { handle } = await outcome;
  backend.sandboxDeadlines.active = async () => false; // the independent watchdog is no longer acknowledged
  await assert.rejects(backend.start(handle), { code: 'sandbox_start_failed' });
  assert.equal(handle._deadline.phase, 'prepare', 'the preparation clock and its protection stay in place');
  assert.equal(handle._deadline.endsAt, PREPARATION_BUDGET_MS);
  assert.equal(guestLaunches(order).length, 0, 'no guest launch');
});

test('a job that did not ask for the separate clock keeps one combined wall from entry', async (t) => {
  await withTempCheckHome(t);
  const { backend, order, held, release, job, clock } = gatedSentinelBackend({ wallSeconds: 60 });
  const prepared = backend.prepare(job, { wallRemainingMs: () => 3_600_000 });
  const outcome = prepared.then(handle => ({ handle }), error => ({ error }));
  await firstWave(held);
  await turns();
  clock.now = 10_000;
  await drainUntilSettled(outcome, held, release);
  const { handle } = await outcome;
  assert.equal(handle._deadline.endsAt, 60_000, 'wall_seconds from entry, as before');
  assert.equal(handle._deadline.phase, 'run');
  assert.equal(handle._deadline.runClock, null);
  await backend.start(handle);
  assert.equal(handle._deadline.endsAt, 60_000, 'start does not rebase a combined wall');
  void order;
});

test('host bookkeeping commands before the agent run on the preparation clock and are not the handoff', async (t) => {
  await withTempCheckHome(t);
  const { backend, outcome, clock } = await preparedUnderClock({ at: 70_000, prepareOptions: { wallRemainingMs: () => 3_600_000 } });
  const { handle } = await outcome;
  // The executor reuses start() on the same handle for source checks, the status probe and the git base.
  handle._bookkeeping = true;
  try {
    await backend.start(handle);
    await backend.start(handle);
  } finally { delete handle._bookkeeping; }
  assert.equal(handle._deadline.phase, 'prepare', 'bookkeeping did not start the run clock');
  assert.equal(handle._deadline.endsAt, PREPARATION_BUDGET_MS);
  clock.now = PREPARATION_BUDGET_MS;
  handle._bookkeeping = true;
  await assert.rejects(backend.start(handle), { code: 'wall_timeout' }, 'bookkeeping is still bound by the preparation clock');
  delete handle._bookkeeping;
  clock.now = 70_000;
  await backend.start(handle);
  assert.equal(handle._deadline.phase, 'run', 'the agent start is the handoff');
  assert.equal(handle._deadline.endsAt, 70_000 + 60_000);
});

// The signed broker-account route reaches the same backend preparation through prepareAccountRun.
function accountRunInputs(overrides = {}) {
  const job = { ...validJob(), job_id: 'job-pi-clock', image: 'wf-pi', execution_scope: 'borrowed', auth_strategy: 'guest-env-api-key',
    egress: 'provider-only', provider_hosts: ['account-broker.invalid'], resources: { ...validJob().resources, wall_seconds: 60 } };
  return { job, options: { selection: { accountId: 'account-1', providerId: 'pi' }, brokerOrigin: TUNNEL_ORIGIN,
    attempt: { jobId: 'job-pi-clock', attemptId: 'attempt-1', generation: 1, leaseProof: { signedEnvelope: '{}' } }, ...overrides } };
}

test('an account run prepared with the caller lease clock gets the bounded preparation and the run clock at the handoff', async (t) => {
  await withTempCheckHome(t);
  const { backend } = providerCheckBackend();
  let now = 0;
  backend.monotonic = () => now;
  const { job, options } = accountRunInputs({ separatePreparationClock: true, wallRemainingMs: () => 3_600_000 });
  const handle = await backend.prepareAccountRun(job, options);
  try {
    assert.equal(handle._deadline.phase, 'prepare');
    assert.equal(handle._deadline.endsAt, PREPARATION_BUDGET_MS);
    assert.equal(handle._deadline.runClock.wallMs, 60_000);
    assert.equal(handle._deadline.runClock.outerEndsAt, PREPARATION_BUDGET_MS + 60_000, 'one reserved outer end for the independent supervisor');
    now = 70_000; // a preparation and launch authority exchange longer than wall_seconds, still inside its own bound
    await backend.start(handle);
    assert.equal(handle._deadline.phase, 'run');
    assert.equal(handle._deadline.endsAt, 70_000 + 60_000, 'wall_seconds counted from the handoff');
  } finally { await backend.destroy(handle).catch(() => {}); }
});

test('an account run without the lease clock, or with a half of it, keeps the one combined wall', async (t) => {
  await withTempCheckHome(t);
  for (const extra of [{}, { separatePreparationClock: true }, { wallRemainingMs: () => 3_600_000 }]) {
    const { backend } = providerCheckBackend();
    const { job, options } = accountRunInputs(extra);
    const handle = await backend.prepareAccountRun(job, options);
    try {
      assert.equal(handle._deadline.phase, 'run', JSON.stringify(Object.keys(extra)));
      assert.equal(handle._deadline.endsAt, 60_000, 'wall_seconds from prepare entry');
      assert.equal(handle._deadline.runClock, null);
    } finally { await backend.destroy(handle).catch(() => {}); }
  }
});

test('an account attempt whose lease already ended is refused before any sandbox exists, and a clipped lease clips both phases', async (t) => {
  await withTempCheckHome(t);
  const expired = providerCheckBackend();
  const a = accountRunInputs({ separatePreparationClock: true, wallRemainingMs: () => 0 });
  await assert.rejects(expired.backend.prepareAccountRun(a.job, a.options), { code: 'wall_timeout' });
  assert.equal(expired.runner.calls.some(args => args[0] === 'create'), false, 'no sandbox was created for an ended attempt');
  const { backend } = providerCheckBackend();
  const b = accountRunInputs({ separatePreparationClock: true, wallRemainingMs: () => 40_000 });
  const handle = await backend.prepareAccountRun(b.job, b.options);
  try {
    assert.equal(handle._deadline.endsAt, 40_000, 'preparation is clipped to the lease');
    assert.equal(handle._deadline.runClock.outerEndsAt, 40_000, 'the reserved outer end is clipped to the lease');
    await backend.start(handle);
    assert.equal(handle._deadline.endsAt, 40_000, 'the handoff never extends the lease');
  } finally { await backend.destroy(handle).catch(() => {}); }
});

test('an account handoff without the acknowledged independent watchdog never starts the guest or the run clock', async (t) => {
  await withTempCheckHome(t);
  const { backend, runner } = providerCheckBackend();
  const { job, options } = accountRunInputs({ separatePreparationClock: true, wallRemainingMs: () => 3_600_000 });
  const handle = await backend.prepareAccountRun(job, options);
  try {
    const launches = () => runner.calls.filter(args => args[0] === 'exec' && args.includes('sh')).length;
    const before = launches();
    backend.sandboxDeadlines.active = async () => false;
    await assert.rejects(backend.start(handle), { code: 'sandbox_start_failed' });
    assert.equal(handle._deadline.phase, 'prepare');
    assert.equal(launches(), before, 'no guest launch');
  } finally { await backend.destroy(handle).catch(() => {}); }
});
