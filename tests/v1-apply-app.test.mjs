import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { watch, existsSync } from 'node:fs';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { makeRepo, git } from './helpers/git-guest.mjs';
import { memoryIntentStore } from './helpers/apply-intents.mjs';
import { applyForApp, applyResult, applyStateOf, APPLY_STATES, ApplyError } from '../lib/v1/apply.mjs';
import { opById } from '../lib/v1/ops/registry.mjs';
import { check } from '../lib/v1/ops/schema.mjs';

// U22: the web app's Add as a branch. Preview first, then the same inputs; a repository that changed writes nothing.
const digest = 'sha256:' + 'a'.repeat(64);
async function patchFrom(repo, edit) {
  const copy = await mkdtemp(join(tmpdir(), 'faravan-patch-'));
  try {
    execFileSync('git', ['clone', '-q', repo.dir, copy]);
    await edit(copy); git(copy, 'add', '-A');
    return execFileSync('git', ['diff', '--binary', '--cached', '--no-renames', repo.commit], { cwd: copy, maxBuffer: 1 << 26 });
  } finally { await rm(copy, { recursive: true, force: true }); }
}
const greeting = copy => writeFile(join(copy, 'src/a.txt'), 'one\nTWO\nthree\nfour\n');
const deviceFor = (patch, base) => ({
  intentStore: memoryIntentStore(),
  selectCircle: async () => ({ id: 'circle' }),
  client: async () => ({
    getJob: async () => ({ current_attempt: { attempt_id: 'x' } }),
    fetchResult: async () => ({ bytes: patch, candidate: { media_type: 'text/x-diff' },
      receipt: { harness: 'codex', harness_version: '1.2.3', model: 'm', duration_ms: 60000 }, job: { source: { kind: 'git', commit: base }, prompt: { digest: 'x' } } }),
    fetchArtifact: async () => { throw new Error('no prompt'); },
  }),
});
async function scenario(t, { patch, base } = {}) {
  const repo = await makeRepo(); t.after(() => rm(repo.dir, { recursive: true, force: true }));
  const p = patch ?? await patchFrom(repo, greeting);
  return { repo, device: deviceFor(p, base ?? repo.commit) };
}
const refs = dir => git(dir, 'for-each-ref');

async function waitForFile(path, timeoutMs = 30000) {
  if (existsSync(path)) return;
  let timer, watcher;
  try { await Promise.race([new Promise((resolve, reject) => {
    watcher = watch(dirname(path), (_event, filename) => {
      if (filename?.toString() === basename(path) && existsSync(path)) {
        watcher.close();
        resolve();
      }
    });
    watcher.on('error', reject);
    if (existsSync(path)) {
      watcher.close();
      resolve();
    }
  }), new Promise((_, reject) => { timer = setTimeout(() => { watcher?.close(); reject(new Error(`Timed out waiting for ${path}`)); }, timeoutMs); })]); }
  finally { clearTimeout(timer); watcher?.close(); }
}

async function installGitBarrier(t) {
  const dir = await mkdtemp(join(tmpdir(), 'faravan-git-barrier-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entered = join(dir, 'entered'), release = join(dir, 'release'), finished = join(dir, 'finished');
  const wrapper = join(dir, 'git');
  const realGit = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  await writeFile(wrapper, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
const args = process.argv.slice(2);
let input;
if (args.includes('update-ref') && args.includes('--stdin') && process.env.FARAVAN_TEST_GIT_ENTERED) {
  input = readFileSync(0);
  writeFileSync(process.env.FARAVAN_TEST_GIT_ENTERED, 'ready');
  const release = process.env.FARAVAN_TEST_GIT_RELEASE;
  if (!existsSync(release)) await new Promise((resolve, reject) => {
    const watcher = watch(dirname(release), (_event, filename) => {
      if (filename?.toString() === basename(release) && existsSync(release)) { watcher.close(); resolve(); }
    });
    watcher.on('error', reject);
    if (existsSync(release)) { watcher.close(); resolve(); }
  });
}
const result = spawnSync(process.env.FARAVAN_TEST_REAL_GIT, args, input === undefined ? {stdio:'inherit'} : {stdio:['pipe','inherit','inherit'], input});
if (args.includes('update-ref') && args.includes('--stdin') && process.env.FARAVAN_TEST_GIT_FINISHED) writeFileSync(process.env.FARAVAN_TEST_GIT_FINISHED, 'done');
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`);
  await chmod(wrapper, 0o755);
  const oldEnv = {
    PATH: process.env.PATH,
    FARAVAN_TEST_GIT_ENTERED: process.env.FARAVAN_TEST_GIT_ENTERED,
    FARAVAN_TEST_GIT_RELEASE: process.env.FARAVAN_TEST_GIT_RELEASE,
    FARAVAN_TEST_REAL_GIT: process.env.FARAVAN_TEST_REAL_GIT,
    FARAVAN_TEST_GIT_FINISHED: process.env.FARAVAN_TEST_GIT_FINISHED,
  };
  process.env.PATH = dir + delimiter + process.env.PATH;
  process.env.FARAVAN_TEST_GIT_ENTERED = entered;
  process.env.FARAVAN_TEST_GIT_RELEASE = release;
  process.env.FARAVAN_TEST_REAL_GIT = realGit;
  process.env.FARAVAN_TEST_GIT_FINISHED = finished;
  t.after(() => {
    for (const [name, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  return { entered, release, finished };
}

test('the ops apply schemas describe the real preview token and its apply handoff', async t => {
  const { repo, device } = await scenario(t);
  const input = { digest, circle: 'circle', repo: repo.dir };
  const preview = await applyForApp({ ...input, dryRun: true, device });
  const previewOp = opById('jobs.apply_preview'), applyOp = opById('jobs.apply');
  assert.equal(preview.status, 'dry_run');
  assert.equal(typeof preview.preview_token, 'string');
  assert.equal(previewOp.output.properties.preview_token?.type, 'string',
    'the preview schema declares the token returned by the app');
  assert.equal(Object.hasOwn(previewOp.output.properties, 'expect'), false,
    'the preview schema does not advertise an expect object the app never returns');
  assert.equal(check(previewOp.output, preview), null);
  assert.equal(applyOp.input.properties.expect.properties?.preview_token?.type, 'string',
    'the apply schema describes where to send the preview token');
  const applyInput = { ...input, expect: { preview_token: preview.preview_token } };
  assert.equal(check(applyOp.input, applyInput), null);
  const done = await applyForApp({ ...applyInput, dryRun: false, device });
  assert.equal(done.status, 'applied');
  assert.equal(git(repo.dir, 'rev-parse', done.branch), done.commit);
});

test('the preview says where it would land, from what git reports, and writes nothing', async t => {
  const { repo, device } = await scenario(t), before = refs(repo.dir);
  const out = await applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: true, device });
  assert.equal(out.status, 'dry_run');
  assert.deepEqual([out.repo, out.branch, out.base, out.head, out.current_branch], [repo.dir, 'faravan/' + 'a'.repeat(12), repo.commit, repo.commit, 'main']);
  assert.deepEqual(out.files_changed, [{ path: 'src/a.txt', status: out.files_changed[0].status, insertions: 2, deletions: 1 }]);
  assert.equal(refs(repo.dir), before);
});

test('Add the branch with the preview’s state writes the branch and leaves the current branch alone', async t => {
  const { repo, device } = await scenario(t);
  const preview = await applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: true, device });
  const done = await applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: false, expect: { preview_token: preview.preview_token }, device });
  assert.equal(done.status, 'applied');
  assert.equal(done.branch, preview.branch, 'the write created exactly the branch shown by preview');
  assert.equal(git(repo.dir, 'rev-parse', done.branch), done.commit);
  assert.equal(refs(repo.dir).split('\n').length, 2, 'the write created one branch ref');
  assert.equal(git(repo.dir, 'rev-parse', 'main'), repo.commit, 'the current branch did not move');
  assert.equal(git(repo.dir, 'status', '--porcelain'), '');
});

test('the locked preview write creates nested current branch lock directories', async t => {
  const { repo, device } = await scenario(t);
  git(repo.dir, 'switch', '-q', '-c', 'feature/x');
  const preview = await applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: true, device });
  assert.equal(preview.current_ref, 'refs/heads/feature/x');
  const done = await applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: false,
    expect: { preview_token: preview.preview_token }, device });
  assert.equal(done.status, 'applied');
  assert.equal(git(repo.dir, 'rev-parse', 'feature/x'), repo.commit);
  assert.equal(git(repo.dir, 'rev-parse', preview.branch), done.commit);
});

test('a symbolic HEAD to a remote ref is checked without inventing a heads ref', async t => {
  const { repo, device } = await scenario(t);
  git(repo.dir, 'update-ref', 'refs/remotes/origin/main', repo.commit);
  git(repo.dir, 'symbolic-ref', 'HEAD', 'refs/remotes/origin/main');
  const preview = await applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: true, device });
  assert.equal(preview.current_branch, null);
  assert.equal(preview.current_ref, 'refs/remotes/origin/main');
  const done = await applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: false,
    expect: { preview_token: preview.preview_token }, device });
  assert.equal(done.status, 'applied');
  assert.equal(git(repo.dir, 'symbolic-ref', 'HEAD'), 'refs/remotes/origin/main');
});

test('a linked worktree cannot move a symbolic remote HEAD during the result transaction', { skip: process.platform === 'win32' }, async t => {
  const { repo, device } = await scenario(t);
  const other = join(await mkdtemp(join(tmpdir(), 'faravan-linked-remote-')), 'other');
  t.after(() => rm(dirname(other), { recursive: true, force: true }));
  git(repo.dir, 'worktree', 'add', '-q', '--detach', other, repo.commit);
  await writeFile(join(other, 'later.txt'), 'later\n');
  git(other, 'add', 'later.txt');
  git(other, 'commit', '-q', '-m', 'later');
  const later = git(other, 'rev-parse', 'HEAD');
  git(repo.dir, 'update-ref', 'refs/remotes/origin/main', repo.commit);
  git(repo.dir, 'symbolic-ref', 'HEAD', 'refs/remotes/origin/main');
  const preview = await applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: true, device });
  const barrier = await installGitBarrier(t);
  const write = applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: false,
    expect: { preview_token: preview.preview_token }, device });
  try {
    await waitForFile(barrier.entered);
    assert.throws(() => git(other, 'update-ref', 'refs/remotes/origin/main', later, repo.commit), /cannot lock ref|Unable to create|File exists/i);
  } finally {
    await writeFile(barrier.release, 'continue');
    await write;
  }
});

test('a local reftable setting is refused even when HEAD is detached', async t => {
  const { repo, device } = await scenario(t);
  git(repo.dir, 'switch', '-q', '--detach', repo.commit);
  const wrapperDir = await mkdtemp(join(tmpdir(), 'faravan-fake-git-config-'));
  const wrapper = join(wrapperDir, 'git');
  const realGit = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  await writeFile(wrapper, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('config') && args.includes('--local') && args.includes('extensions.refStorage')) {
  process.stdout.write('reftable\\n');
  process.exit(0);
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`);
  await chmod(wrapper, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = wrapperDir + delimiter + oldPath;
  t.after(async () => { process.env.PATH = oldPath; await rm(wrapperDir, { recursive: true, force: true }); });
  const preview = await applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: true, device });
  const result = await applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: false,
    expect: { preview_token: preview.preview_token }, device });
  assert.equal(result.status, 'changed');
  assert.equal(existsSync(join(repo.dir, '.git', 'refs', 'heads', preview.branch)), false);
});

test('a global reftable setting does not refuse a files repository', async t => {
  const { repo, device } = await scenario(t);
  const globalConfig = join(await mkdtemp(join(tmpdir(), 'faravan-global-config-')), 'config');
  t.after(() => rm(dirname(globalConfig), { recursive: true, force: true }));
  await writeFile(globalConfig, '[extensions]\n\trefStorage = reftable\n');
  const oldGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  t.after(() => { if (oldGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = oldGlobal; });
  const preview = await applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: true, device });
  const done = await applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: false,
    expect: { preview_token: preview.preview_token }, device });
  assert.equal(done.status, 'applied');
});

test('an existing HEAD lock error names the lock and explains how to retry', async t => {
  const { repo, device } = await scenario(t);
  const preview = await applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: true, device });
  const expected = { version: 1, repo: repo.dir, head: preview.head, current_branch: preview.current_branch,
    current_ref: preview.current_ref, branch: preview.branch, job_digest: digest, circle: 'circle', base: preview.base,
    patch_hash: preview.patch_hash };
  const headFile = join(repo.dir, '.git', 'HEAD');
  await writeFile(headFile + '.lock', 'occupied');
  await assert.rejects(applyResult({ digest, circle: 'circle', repo: repo.dir, dryRun: false, expectedPreview: expected, device }), error => {
    assert.equal(error.code, 'apply_locked');
    assert.match(error.message, /HEAD\.lock/);
    assert.match(error.message, /another Git operation may be running/i);
    assert.match(error.message, /try again once it finishes/i);
    return true;
  });
});

test('an existing current branch lock is reported and left untouched', async t => {
  const { repo, device } = await scenario(t);
  const preview = await applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: true, device });
  const expected = { version: 1, repo: repo.dir, head: preview.head, current_branch: preview.current_branch,
    current_ref: preview.current_ref, branch: preview.branch, job_digest: digest, circle: 'circle', base: preview.base,
    patch_hash: preview.patch_hash };
  const refLock = join(repo.dir, '.git', 'refs', 'heads', 'main.lock');
  await writeFile(refLock, 'occupied');
  await assert.rejects(applyResult({digest,circle:'circle',repo:repo.dir,dryRun:false,expectedPreview:expected,device}), error => {
    assert.equal(error.code, 'preview_lock_blocked');
    assert.match(error.message, /main\.lock/);
    return true;
  });
  assert.equal(await readFile(refLock, 'utf8'), 'occupied');
});

test('the app exposes an occupied HEAD lock instead of reporting a changed preview', async t => {
  const { repo, device } = await scenario(t);
  const preview = await applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: true, device });
  await writeFile(join(repo.dir, '.git', 'HEAD.lock'), 'foreign lock');
  await assert.rejects(applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: false,
    expect: { preview_token: preview.preview_token }, device }), error => {
    assert.match(error.message, /HEAD\.lock/);
    return true;
  });
});

test('explicit recovery clears locks left by a killed preview owner and retry works', { skip: process.platform !== 'linux' }, async t => {
  const { repo, device } = await scenario(t);
  const preview = await applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: true, device });
  const patch = await patchFrom(repo, greeting);
  const patchFile = join(repo.dir, 'recovery-test.patch');
  const intentFile = join(repo.dir, '.git', 'recovery-test-intents.json');
  await writeFile(patchFile, patch);
  await writeFile(intentFile, '{}');
  const expected = { version: 1, repo: repo.dir, head: preview.head, current_branch: preview.current_branch,
    current_ref: preview.current_ref, branch: preview.branch, job_digest: digest, circle: 'circle', base: preview.base,
    patch_hash: preview.patch_hash };
  const barrier = await installGitBarrier(t);
  const source = `import { readFile, writeFile } from 'node:fs/promises';
import { applyResult } from ${JSON.stringify(new URL('../lib/v1/apply.mjs', import.meta.url).href)};
const {repo, digest, base, patchFile, intentFile, expected} = JSON.parse(process.env.RECOVERY_TEST);
const patch = await readFile(patchFile);
const store = {list:async()=>Object.values(JSON.parse(await readFile(intentFile,'utf8'))),
 set:async(k,v)=>{const values=JSON.parse(await readFile(intentFile,'utf8'));values[k]=v;await writeFile(intentFile,JSON.stringify(values));},
 delete:async()=>{}};
const device = {selectCircle:async()=>({id:'circle'}),intentStore:()=>store,client:async()=>({
 getJob:async()=>({current_attempt:{attempt_id:'x'}}),
 fetchResult:async()=>({bytes:patch,candidate:{media_type:'text/x-diff'},receipt:{},job:{source:{kind:'git',commit:base},prompt:{digest:'x'}}}),
 fetchArtifact:async()=>{throw new Error('no prompt');}})};
await applyResult({digest,circle:'circle',repo,device,expectedPreview:expected});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: {...process.env,
    RECOVERY_TEST: JSON.stringify({repo:repo.dir,digest,base:repo.commit,patchFile,intentFile,expected})}, stdio:'ignore' });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const { recoverPreviewLocks } = await import('../lib/v1/apply.mjs');
  try {
    await waitForFile(barrier.entered);
    child.kill('SIGKILL');
    await exited;
    await assert.rejects(recoverPreviewLocks({repo:repo.dir}), {code:'preview_lock_blocked'});
  } finally { await writeFile(barrier.release, 'continue'); }
  await waitForFile(barrier.finished);
  await new Promise(resolve => setTimeout(resolve, 100));
  await recoverPreviewLocks({repo:repo.dir});
  for (const [key, value] of Object.entries(JSON.parse(await readFile(intentFile, 'utf8')))) await device.intentStore('circle').set(key, value);
  const done = await applyForApp({digest,circle:'circle',repo:repo.dir,dryRun:false,
    expect:{preview_token:preview.preview_token},device});
  assert.equal(done.status, 'applied');
});

test('recovery preserves an unknown Git lock and reports its path', async t => {
  const { repo } = await scenario(t);
  const path = join(repo.dir, '.git', 'HEAD.lock');
  await writeFile(path, 'foreign lock');
  const { recoverPreviewLocks } = await import('../lib/v1/apply.mjs');
  await assert.rejects(recoverPreviewLocks({repo:repo.dir}), error => error.code === 'preview_lock_blocked' && error.message.includes(path));
  assert.equal(await readFile(path, 'utf8'), 'foreign lock');
});

test('explicit recovery recognizes a stopped legacy Apply lock', {skip:process.platform !== 'linux'}, async t => {
  const {repo} = await scenario(t), path = join(repo.dir, '.git', 'HEAD.lock');
  const {applyOwner} = await import('../lib/v1/apply-head-lock.mjs');
  const owner = {...applyOwner(),pid:2147483647,kind:'faravan-apply-head-v1',writer:null,token:'test'};
  await symlink(JSON.stringify(owner), path);
  const {recoverPreviewLocks} = await import('../lib/v1/apply.mjs');
  assert.equal((await recoverPreviewLocks({repo:repo.dir})).status, 'recovered');
  await assert.rejects(lstat(path), {code:'ENOENT'});
});

test('recovery does not remove a live preview owner lock', async t => {
  const { repo } = await scenario(t);
  const path = join(repo.dir, '.git', 'HEAD.lock');
  const { acquirePreviewLock } = await import('../lib/v1/preview-lock.mjs');
  const release = await acquirePreviewLock(path, join(repo.dir, '.git', 'faravan-preview-staging'));
  try {
    const { recoverPreviewLocks } = await import('../lib/v1/apply.mjs');
    await assert.rejects(recoverPreviewLocks({repo:repo.dir}), {code:'preview_lock_blocked'});
    assert.equal(existsSync(path), true);
  } finally { await release(); }
});

test('a concurrent recovery cannot remove the current guarded lock', async t => {
  const { repo } = await scenario(t);
  const path = join(repo.dir, '.git', 'HEAD.lock');
  const { acquirePreviewLock, previewGuard } = await import('../lib/v1/preview-lock.mjs');
  const guard = await previewGuard(join(repo.dir, '.git'));
  const release = await acquirePreviewLock(path, join(repo.dir, '.git', 'faravan-preview-staging'));
  try {
    const { recoverPreviewLocks } = await import('../lib/v1/apply.mjs');
    await assert.rejects(recoverPreviewLocks({repo:repo.dir}), {code:'preview_lock_blocked'});
    assert.equal(existsSync(path), true);
  } finally { await release(); guard(); }
});

test('recovery distinguishes a reused PID by process start time', {skip:process.platform !== 'linux'}, async t => {
  const { repo } = await scenario(t);
  const path = join(repo.dir, '.git', 'HEAD.lock');
  const { acquirePreviewLock } = await import('../lib/v1/preview-lock.mjs');
  await acquirePreviewLock(path, join(repo.dir, '.git', 'faravan-preview-staging'));
  const owner = JSON.parse(await readFile(path, 'utf8'));
  owner.start = String(BigInt(owner.start) + 1n);
  await writeFile(path, JSON.stringify(owner));
  const { recoverPreviewLocks } = await import('../lib/v1/apply.mjs');
  assert.equal((await recoverPreviewLocks({repo:repo.dir})).status, 'recovered');
  assert.equal(existsSync(path), false);
});

test('recovery recognizes an owner from an earlier boot on the same host', {skip:process.platform !== 'linux'}, async t => {
  const { repo } = await scenario(t);
  const path = join(repo.dir, '.git', 'HEAD.lock');
  const { acquirePreviewLock } = await import('../lib/v1/preview-lock.mjs');
  await acquirePreviewLock(path, join(repo.dir, '.git', 'faravan-preview-staging'));
  const owner = JSON.parse(await readFile(path, 'utf8'));
  owner.boot = 'previous-boot';
  await writeFile(path, JSON.stringify(owner));
  const { recoverPreviewLocks } = await import('../lib/v1/apply.mjs');
  assert.equal((await recoverPreviewLocks({repo:repo.dir})).status, 'recovered');
  assert.equal(existsSync(path), false);
});

test('a symbolic HEAD chain is refused without creating a result branch', async t => {
  const { repo, device } = await scenario(t);
  git(repo.dir, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/main');
  git(repo.dir, 'symbolic-ref', 'HEAD', 'refs/heads/alias');
  const preview = await applyForApp({digest,circle:'circle',repo:repo.dir,dryRun:true,device});
  const out = await applyForApp({digest,circle:'circle',repo:repo.dir,dryRun:false,expect:{preview_token:preview.preview_token},device});
  assert.equal(out.status, 'changed');
  assert.equal(refs(repo.dir).includes('refs/heads/faravan/'), false);
});

test('a failed ref lock release is reported separately and still releases HEAD.lock', async t => {
  const { repo, device } = await scenario(t);
  const preview = await applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: true, device });
  const expected = { version: 1, repo: repo.dir, head: preview.head, current_branch: preview.current_branch,
    current_ref: preview.current_ref, branch: preview.branch, job_digest: digest, circle: 'circle', base: preview.base,
    patch_hash: preview.patch_hash };
  const wrapperDir = await mkdtemp(join(tmpdir(), 'faravan-failing-git-release-'));
  const wrapper = join(wrapperDir, 'git');
  const realGit = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  const refLock = join(repo.dir, '.git', 'refs', 'heads', 'main.lock');
  await writeFile(wrapper, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, unlinkSync } from 'node:fs';
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status === 0 && args.includes('update-ref') && args.includes('--stdin')) {
  unlinkSync(${JSON.stringify(refLock)});
  mkdirSync(${JSON.stringify(refLock)});
}
process.exit(result.status ?? 1);
`);
  await chmod(wrapper, 0o755);
  const oldPath = process.env.PATH, oldWarn = console.warn, warnings = [];
  process.env.PATH = wrapperDir + delimiter + oldPath;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(async () => { process.env.PATH = oldPath; console.warn = oldWarn; await rm(wrapperDir, { recursive: true, force: true }); });
  const applied = await applyResult({ digest, circle: 'circle', repo: repo.dir, dryRun: false, expectedPreview: expected, device });
  assert.equal(applied.status, 'applied');
  assert.equal(git(repo.dir, 'rev-parse', applied.branch), applied.commit);
  assert.match(warnings.join('\n'), /branch lock cleanup failed.*main\.lock/i);
  assert.equal(existsSync(join(repo.dir, '.git', 'HEAD.lock')), false, 'HEAD lock release still runs after ref lock release fails');
});

test('a detached HEAD stays detached while the preview result branch is created', async t => {
  const { repo, device } = await scenario(t);
  git(repo.dir, 'switch', '-q', '--detach', repo.commit);
  const preview = await applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: true, device });
  assert.equal(preview.current_branch, null);
  const done = await applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: false,
    expect: { preview_token: preview.preview_token }, device });
  assert.equal(done.status, 'applied');
  assert.equal(git(repo.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
  assert.equal(git(repo.dir, 'rev-parse', preview.branch), done.commit);
});

test('the final preview check holds the shared current ref against another worktree', { skip: process.platform === 'win32' }, async t => {
  const { repo, device } = await scenario(t);
  const other = join(await mkdtemp(join(tmpdir(), 'faravan-linked-worktree-parent-')), 'other');
  t.after(() => rm(dirname(other), { recursive: true, force: true }));
  git(repo.dir, 'worktree', 'add', '-q', '--detach', other, repo.commit);
  await writeFile(join(other, 'later.txt'), 'other worktree\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-q', '-m', 'other worktree update');
  const competingHead = git(other, 'rev-parse', 'HEAD');
  git(repo.dir, 'pack-refs', '--all');

  const preview = await applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: true, device });
  const barrier = await installGitBarrier(t);
  const write = applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: false,
    expect: { preview_token: preview.preview_token }, device });
  let done;
  try {
    await waitForFile(barrier.entered);
    const refsDuringWrite = spawnSync('git', ['for-each-ref', '--format=%(refname)', 'refs/heads/'], {cwd:repo.dir,encoding:'utf8'});
    assert.equal(refsDuringWrite.status, 0, refsDuringWrite.stderr);
    assert.doesNotMatch(refsDuringWrite.stderr, /broken ref|bad ref|ignoring.*ref/i);
    assert.doesNotMatch(refsDuringWrite.stdout, /faravan-apply/);
    assert.throws(() => git(other, 'update-ref', 'refs/heads/main', competingHead, repo.commit), /cannot lock ref|Unable to create|File exists/i,
      'the linked worktree cannot move a packed current branch while the result transaction is pending');
    assert.throws(() => git(repo.dir, 'switch', '-q', '--detach', competingHead), /HEAD\.lock|cannot lock ref/i,
      'the same worktree cannot move HEAD while the final check is protected');
  } finally {
    await writeFile(barrier.release, 'continue');
    done = await write;
  }

  assert.equal(done.status, 'applied');
  assert.equal(git(repo.dir, 'rev-parse', preview.branch), done.commit);
  assert.equal(git(repo.dir, 'rev-parse', 'main'), repo.commit);
  git(other, 'update-ref', 'refs/heads/main', competingHead, repo.commit);
  assert.equal(git(repo.dir, 'rev-parse', 'main'), competingHead, 'the shared ref lock is released after the result transaction');
});

test('an overlapping Apply waits for the guarded publication and returns its commit', { skip: process.platform === 'win32' }, async t => {
  const {repo, device} = await scenario(t);
  const preview = await applyForApp({digest,circle:'circle',repo:repo.dir,dryRun:true,device});
  const original = device.intentStore;
  let writes = 0, announce;
  const secondSaved = new Promise(resolve => { announce = resolve; });
  device.intentStore = id => {
    const store = original(id), set = store.set;
    store.set = async (key, value) => { await set(key, value); if (key.startsWith('apply:') && ++writes === 2) announce(); };
    return store;
  };
  const barrier = await installGitBarrier(t);
  const run = () => applyForApp({digest,circle:'circle',repo:repo.dir,dryRun:false,expect:{preview_token:preview.preview_token},device});
  const first = run();
  let second;
  try {
    await waitForFile(barrier.entered);
    second = run().then(value => ({value}), error => ({error}));
    let timer;
    try { await Promise.race([secondSaved, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('second intent not saved')), 30000); })]); }
    finally { clearTimeout(timer); }
    await new Promise(resolve => setTimeout(resolve, 800));
  } finally { await writeFile(barrier.release, 'continue'); }
  const winner = await first, other = await second;
  assert.ifError(other.error);
  assert.equal(other.value.status, 'applied');
  assert.equal(other.value.commit, winner.commit);
});

test('a preview token is required and cannot be moved to another repository', async t => {
  const { repo, device } = await scenario(t);
  const before = refs(repo.dir);
  const preview = await applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: true, device });
  assert.equal(typeof preview.preview_token, 'string');
  await assert.rejects(applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: false, device }), { code: 'preview_required' });
  assert.equal((await applyForApp({ digest, circle: 'circle', repo: repo.dir, branch: 'different-name', dryRun: false,
    expect: { preview_token: preview.preview_token }, device })).status, 'changed');
  const other = { dir: await mkdtemp(join(tmpdir(), 'faravan-destination-')) };
  t.after(() => rm(other.dir, { recursive: true, force: true }));
  execFileSync('git', ['clone', '-q', repo.dir, other.dir]);
  const otherBefore = refs(other.dir);
  assert.equal((await applyForApp({ digest, circle: 'circle', repo: other.dir, dryRun: false, expect: { preview_token: preview.preview_token }, device })).status, 'changed');
  assert.equal(refs(repo.dir), before);
  assert.equal(refs(other.dir), otherBefore);
});

test('moving HEAD while the write pass waits cannot claim success or create a branch', async t => {
  const { repo } = await scenario(t);
  let entered, resume;
  const atWrite = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { resume = resolve; });
  let hold = false;
  const device = deviceFor(await patchFrom(repo, greeting), repo.commit);
  const originalClient = await device.client();
  device.client = async () => ({ ...originalClient, fetchArtifact: async () => {
    if (hold) { entered(); await held; }
    throw new Error('no prompt');
  } });
  const preview = await applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: true, device });
  const before = refs(repo.dir);
  hold = true;
  const write = applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: false, expect: { preview_token: preview.preview_token }, device });
  await atWrite;
  await writeFile(join(repo.dir, 'later.txt'), 'x\n'); git(repo.dir, 'add', '-A'); git(repo.dir, 'commit', '-q', '-m', 'later');
  resume();
  assert.equal((await write).status, 'changed', 'a stale preview cannot claim branch success');
  assert.equal(refs(repo.dir).includes('refs/heads/faravan/'), before.includes('refs/heads/faravan/'), 'the write did not create a ref');
});

test('a changed verified patch invalidates the preview token', async t => {
  const { repo, device } = await scenario(t);
  const preview = await applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: true, device });
  const otherPatch = Buffer.from((await patchFrom(repo, copy => writeFile(join(copy, 'src/a.txt'), 'ONE\ntwo\nthree\n'))).toString());
  assert.equal((await applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: false,
    expect: { preview_token: preview.preview_token }, device: deviceFor(otherPatch, repo.commit) })).status, 'changed');
  assert.equal(refs(repo.dir).includes('refs/heads/faravan/'), false);
});

test('a concurrent same-name branch is never overwritten', async t => {
  const { repo } = await scenario(t);
  let entered, resume;
  const atWrite = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { resume = resolve; });
  let hold = false;
  const device = deviceFor(await patchFrom(repo, greeting), repo.commit);
  const originalClient = await device.client();
  device.client = async () => ({ ...originalClient, fetchArtifact: async () => {
    if (hold) { entered(); await held; }
    throw new Error('no prompt');
  } });
  const preview = await applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: true, device });
  const competitor = git(repo.dir, 'rev-parse', 'HEAD');
  hold = true;
  const write = applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: false,
    expect: { preview_token: preview.preview_token }, device });
  await atWrite;
  git(repo.dir, 'branch', preview.branch, competitor);
  resume();
  await assert.rejects(write, { code: 'branch_exists' });
  assert.equal(git(repo.dir, 'rev-parse', preview.branch), competitor, 'the competing ref stays at its original commit');
});

test('a repository that changed since the preview writes nothing and shows the new state', async t => {
  const { repo, device } = await scenario(t);
  const preview = await applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: true, device });
  await writeFile(join(repo.dir, 'later.txt'), 'x\n'); git(repo.dir, 'add', '-A'); git(repo.dir, 'commit', '-q', '-m', 'later');
  const before = refs(repo.dir);
  assert.equal((await applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: false, expect: { preview_token: preview.preview_token }, device })).status, 'changed');
  assert.equal(refs(repo.dir), before, 'no branch was written');
  git(repo.dir, 'switch', '-q', '-c', 'feature/checkout');
  assert.equal((await applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: false, expect: { preview_token: preview.preview_token }, device })).status, 'changed', 'a different current branch counts too');
});

test('each refusal is its own state: repo missing, base missing, branch exists, conflict, unsafe, no changes', async t => {
  const refused = async (run) => { try { await run(); } catch (error) { assert.ok(error instanceof ApplyError, String(error)); return [error.code, applyStateOf(error.code)]; } assert.fail('expected a refusal'); };
  const { repo, device } = await scenario(t);
  // the folder moved, is not a folder, is relative, or is not a repository
  assert.deepEqual(await refused(() => applyForApp({ digest, circle: 'circle', repo: join(repo.dir, 'gone'), dryRun: true, device })), ['repo_missing', 'job.apply-repo-missing']);
  assert.deepEqual(await refused(() => applyForApp({ digest, circle: 'circle', repo: 'relative/dir', dryRun: true, device })), ['repo_missing', 'job.apply-repo-missing']);
  const plain = await mkdtemp(join(tmpdir(), 'faravan-plain-')); t.after(() => rm(plain, { recursive: true, force: true }));
  assert.deepEqual(await refused(() => applyForApp({ digest, circle: 'circle', repo: plain, dryRun: true, device })), ['not_a_repository', 'job.apply-repo-missing']);
  // the version the job started from is not in this repository
  const other = deviceFor(await patchFrom(repo, greeting), 'b'.repeat(40));
  assert.deepEqual(await refused(() => applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: true, device: other })), ['base_missing', 'job.apply-base-missing']);
  // a branch of that name is already there
  git(repo.dir, 'branch', 'faravan/' + 'a'.repeat(12));
  assert.deepEqual(await refused(() => applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: true, device })), ['branch_exists', 'job.apply-branch-exists']);
  git(repo.dir, 'branch', '-q', '-D', 'faravan/' + 'a'.repeat(12));
  // the changes do not apply to that version
  const conflicting = Buffer.from((await patchFrom(repo, greeting)).toString().replace(' one\n', ' uno\n'));
  assert.deepEqual(await refused(() => applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: true, device: deviceFor(conflicting, repo.commit) })), ['patch_conflict', 'job.apply-conflict']);
  // they write outside the project
  const hostile = Buffer.from('diff --git a/../x b/../x\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/../x\n@@ -0,0 +1 @@\n+owned\n');
  assert.deepEqual(await refused(() => applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: true, device: deviceFor(hostile, repo.commit) })), ['unsafe_patch', 'job.apply-unsafe']);
  // the agent made no changes
  assert.deepEqual(await refused(() => applyForApp({ digest, circle: 'circle', repo: repo.dir, dryRun: true, device: deviceFor(Buffer.alloc(0), repo.commit) })), ['no_changes', 'job.no-changes']);
});

test('every refusal code the apply command has maps to exactly one state, and an unknown one to a generic failure', () => {
  assert.deepEqual(Object.keys(APPLY_STATES).sort(), ['apply_locked', 'base_missing', 'base_unknown', 'branch_exists', 'no_changes', 'not_a_repository', 'patch_conflict', 'patch_invalid', 'preview_lock_blocked', 'repo_missing', 'unsafe_patch']);
  assert.equal(applyStateOf('apply_locked'), 'job.apply-locked');
  assert.equal(applyStateOf('preview_lock_blocked'), 'job.apply-lock-blocked');
  assert.equal(applyStateOf('commit_failed'), 'job.apply-failed');
  assert.equal(applyStateOf(undefined), 'job.apply-failed');
});


// Worktree regressions use a separate process so a killed writer loses all memory.
async function worktreeProcess(t, { mode, repo, patch, root }) {
  const { mkdir } = await import('node:fs/promises');
  const shim = join(root, 'shim');
  await mkdir(shim, { recursive: true });
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  await writeFile(join(shim, 'git'), [
    '#!' + process.execPath,
    "const fs = require('node:fs'), {spawnSync} = require('node:child_process');",
    'const args = process.argv.slice(2);',
    "if (process.env.WORKTREE_MODE === 'switch' && args.includes('restore') && (!process.env.GIT_WORK_TREE === process.env.WORKTREE_REPO)) {",
    '  const switched = spawnSync(' + JSON.stringify(realGit) + ", ['switch','-q','-c','other'], {stdio:'inherit'});",
    '  if (switched.status !== 0) process.exit(switched.status ?? 1);',
    '}',
    "if (process.env.WORKTREE_MODE === 'crash' && args.includes('restore') && (!process.env.GIT_WORK_TREE === process.env.WORKTREE_REPO)) {",
    "  const cut = args.findIndex(arg => arg === '--pathspec-from-file=-');",
    "  const first = args.slice(0, cut).concat('--', 'src/a.txt'); fs.readFileSync(0);",
    '  const result = spawnSync(' + JSON.stringify(realGit) + ", first, {stdio:'inherit'});",
    '  if (result.status !== 0) process.exit(result.status ?? 1);',
    "  process.kill(process.ppid, 'SIGKILL'); process.exit(0);",
    '}',
    'const result = spawnSync(' + JSON.stringify(realGit) + ", args, {stdio:'inherit'});",
    "if (result.status === 0 && args.includes('check-attr') && process.env.WORKTREE_MODE === 'edit') {",
    "  const countFile = process.env.WORKTREE_ROOT + '/checks';",
    "  const count = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8') : 0) + 1;",
    '  fs.writeFileSync(countFile, String(count));',
    "  if (count === 2) fs.writeFileSync(process.env.WORKTREE_REPO + '/src/a.txt', 'my late edit\\n');",
    '}',
    'process.exit(result.status ?? 1);',
  ].join('\n'), { mode: 0o700 });
  await writeFile(join(root, 'input.json'), JSON.stringify({repo:repo.dir,base:repo.commit,patch:patch.toString('base64'),mode,root}));
  const source = [
    "import fs from 'node:fs';",
    "import {execFileSync} from 'node:child_process';",
    "import {syncBuiltinESMExports} from 'node:module';",
    "const input = JSON.parse(fs.readFileSync(process.env.WORKTREE_ROOT + '/input.json'));",
    'const rename = fs.renameSync;',
    'fs.renameSync = (from, to) => { rename(from, to);',
    "  if (input.mode === 'crash' && to === input.repo + '/src/a.txt') process.kill(process.pid, 'SIGKILL'); };",
    'syncBuiltinESMExports();',
    "const data = input.root + '/intents.json';",
    'const read = () => fs.existsSync(data) ? JSON.parse(fs.readFileSync(data)) : {};',
    'const save = rows => {',
    "  const fd = fs.openSync(data + '.tmp', 'w', 0o600);",
    '  try { fs.writeFileSync(fd, JSON.stringify(rows)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }',
    "  fs.renameSync(data + '.tmp', data);",
    "  const dir = fs.openSync(input.root, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }",
    '};',
    'const store = {list:async()=>Object.values(read()), set:async(key,value)=>{',
    '  save({...read(),[key]:value});',
    // Hold persistence completion across a real branch switch with identical file bytes.
    "  if (input.mode === 'switch' && value.kind === 'worktree-apply') {",
    "    await new Promise(resolve=>setImmediate(resolve));",
    "    execFileSync('git',['switch','-q','-c','other'],{cwd:input.repo});",
    '  }',
    '},',
    '  delete:async key=>{const rows=read();delete rows[key];save(rows);}};',
    'const device = {',
    "  listCircles:async()=>[{id:'circle'}], selectCircle:async()=>({id:'circle'}), intentStore:()=>store,",
    '  client:async()=>({',
    "    getJob:async()=>({current_attempt:{attempt_id:'x'}}),",
    "    fetchResult:async()=>({bytes:Buffer.from(input.patch,'base64'),candidate:{media_type:'text/x-diff'},",
    "      receipt:{candidate_format:'diff'},job:{source:{kind:'git',commit:input.base},prompt:{digest:'x'}}})",
    '  })',
    '};',
    'const {workingTreeForApp} = await import(' + JSON.stringify(new URL('../lib/v1/result-actions.mjs',import.meta.url).href) + ');',
    'const {reconcileApplies} = await import(' + JSON.stringify(new URL('../lib/v1/apply.mjs',import.meta.url).href) + ');',
    "if (input.mode === 'recover') await reconcileApplies(device);",
    'else { try {',
    "  const out = await workingTreeForApp({digest:'sha256:'+'a'.repeat(64),circle:'circle',repo:input.repo,",
    "    device,dryRun:false,expect:{head:input.base,current_branch:'main'}});",
    '  process.stdout.write(JSON.stringify(out));',
    '} catch (error) { process.stdout.write(JSON.stringify({code:error.code,message:error.message})); } }',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module','-e',source], {
    env:{...process.env,PATH:shim+delimiter+process.env.PATH,WORKTREE_MODE:mode,WORKTREE_ROOT:root,WORKTREE_REPO:repo.dir},
    stdio:['ignore','pipe','pipe'],
  });
  let stdout='',stderr='';
  child.stdout.on('data',b=>stdout+=b); child.stderr.on('data',b=>stderr+=b);
  const {once} = await import('node:events');
  const ended = once(child,'close');
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  const [code,signal]=await ended;
  return {code,signal,stdout,stderr};
}
async function worktreeCase(t) {
  const repo=await makeRepo({'src/a.txt':'old a\n','src/b.txt':'old b\n','src/c.txt':'old c\n'});
  const root=await mkdtemp(join(tmpdir(),'faravan-worktree-journal-'));
  t.after(async()=>{await rm(repo.dir,{recursive:true,force:true});await rm(root,{recursive:true,force:true});});
  const patch=await patchFrom(repo,async copy=>{
    for(const name of ['a','b','c'])await writeFile(join(copy,'src',name+'.txt'),'new '+name+'\n');
  });
  return {repo,root,patch};
}
const worktreeBytes=async repo=>Promise.all(['a','b','c'].map(name=>readFile(join(repo.dir,'src',name+'.txt'),'utf8')));

test('worktree preserves an edit after the final dirtiness check and reports its path',{timeout:120000,skip:process.platform==='win32'},async t=>{
  const s=await worktreeCase(t),out=await worktreeProcess(t,{...s,mode:'edit'});
  assert.equal(out.code,0,out.stderr);
  assert.equal(JSON.parse(out.stdout).code,'worktree_conflict');
  assert.match(JSON.parse(out.stdout).message,/src\/a\.txt/);
  assert.deepEqual(await worktreeBytes(s.repo),['my late edit\n','old b\n','old c\n']);
});
test('worktree startup recovers a process crash after the first of three replacements',{timeout:120000,skip:process.platform==='win32'},async t=>{
  const s=await worktreeCase(t),crashed=await worktreeProcess(t,{...s,mode:'crash'});
  assert.equal(crashed.signal,'SIGKILL',crashed.stderr);
  assert.deepEqual(await worktreeBytes(s.repo),['new a\n','old b\n','old c\n']);
  const recovered=await worktreeProcess(t,{...s,mode:'recover'});
  assert.equal(recovered.code,0,recovered.stderr);
  assert.deepEqual(await worktreeBytes(s.repo),['new a\n','new b\n','new c\n']);
  const again=await worktreeProcess(t,{...s,mode:'recover'});
  assert.equal(again.code,0,again.stderr);
  assert.deepEqual(await worktreeBytes(s.repo),['new a\n','new b\n','new c\n']);
});
test('worktree recovery preserves a later user edit and keeps its journal',{timeout:120000,skip:process.platform==='win32'},async t=>{
  const s=await worktreeCase(t),crashed=await worktreeProcess(t,{...s,mode:'crash'});
  assert.equal(crashed.signal,'SIGKILL',crashed.stderr);
  await writeFile(join(s.repo.dir,'src/b.txt'),'my recovery edit\n');
  const recovered=await worktreeProcess(t,{...s,mode:'recover'});
  assert.equal(recovered.code,0,recovered.stderr);
  assert.deepEqual(await worktreeBytes(s.repo),['new a\n','my recovery edit\n','old c\n']);
  const records=Object.values(JSON.parse(await readFile(join(s.root,'intents.json'),'utf8')));
  assert.ok(records.some(row=>row.kind==='worktree-apply'),'conflicting recovery retains durable old and new bytes');
});
test('mutation timeout does not unlock a still-running worktree restore',async()=>{
  // Exercise the actual serializer without starting unrelated app services.
  const source=await readFile(new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
  const block=source.slice(source.indexOf('  const serialize=(fn,'),source.indexOf('  // Choosing an agent'));
  const serialize=new Function('options','fail',
    'let mutation=Promise.resolve(),closed=false,inFlight;const mutationTimeoutMs=5;\n'+block+'\nreturn serialize;'
  )({},code=>{throw new Error(code);});
  let finishRestore,enteredSecond=false;
  const restore=new Promise(resolve=>{finishRestore=resolve;});
  const first=serialize(()=>restore,'timeout',5,true);
  await assert.rejects(first,{code:'timeout'});
  const second=serialize(async()=>{enteredSecond=true;},'timeout',1000);
  try {
    await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(enteredSecond,false,'timed-out work still owns the mutation lane');
  } finally {finishRestore();await second;}
  assert.equal(enteredSecond,true);
});

test('worktree rechecks the preview after journal persistence changes branches',{timeout:120000,skip:process.platform==='win32'},async t=>{
  const s=await worktreeCase(t),out=await worktreeProcess(t,{...s,mode:'switch'});
  assert.equal(out.code,0,out.stderr);
  assert.equal(git(s.repo.dir,'branch','--show-current'),'other');
  assert.equal(JSON.parse(out.stdout).status,'changed');
  assert.deepEqual(await worktreeBytes(s.repo),['old a\n','old b\n','old c\n']);
  assert.equal(git(s.repo.dir,'status','--porcelain'),'');
  const records=Object.values(JSON.parse(await readFile(join(s.root,'intents.json'),'utf8')));
  assert.equal(records.some(row=>row.kind==='worktree-apply'),false,'no file was written and the obsolete journal is removed');
});
