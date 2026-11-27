import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, lstat, mkdir, readFile, readlink, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appFixture, api, bounded } from './helpers/v1-app-fixture.mjs';
import { makeRepo, git } from './helpers/git-guest.mjs';
import { applyForApp } from '../lib/v1/apply.mjs';

const patch = Buffer.from('diff --git a/src/a.txt b/src/a.txt\n--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n');
const jobPath = digest => '/api/jobs/' + encodeURIComponent(digest);
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const bin = fileURLToPath(new URL('../bin/faravan', import.meta.url));

async function cliApply(s) {
  const child = spawn(process.execPath, [bin, 'apply', s.digest, '--circle', s.circle.id, '--json'], {
    cwd: s.repo.dir, env: await s.f.env('owner'), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout);
}

async function snapshot(repo) {
  return {
    head: await readFile(join(repo.dir, '.git/HEAD'), 'utf8'),
    index: (await readFile(join(repo.dir, '.git/index'))).toString('hex'),
    status: git(repo.dir, '--no-optional-locks', 'status', '--porcelain=v2'),
    source: await readFile(join(repo.dir, 'src/a.txt'), 'utf8'),
    staged: await readFile(join(repo.dir, 'README.md'), 'utf8'),
    untracked: await readFile(join(repo.dir, 'mine.txt'), 'utf8'),
  };
}

async function scenario(t) {
  const f = await appFixture(t), { owner, circle } = await f.connect();
  const repo = await makeRepo();
  const { jobDigest: digest } = await api(owner.app, '/api/jobs', { method: 'POST', body: {
    circle: circle.id, git: 'https://example.test/synthetic.git', commit: repo.commit,
    prompt: 'Change the greeting', harness: 'codex',
  } });
  await f.complete(digest, 'owner', { candidate: patch, candidateMediaType: 'text/x-diff',
    receipt: { candidate_format: 'diff', diffstat: { files: 1, insertions: 1, deletions: 1 } } });
  await writeFile(join(repo.dir, 'README.md'), 'my staged change\n'); git(repo.dir, 'add', 'README.md');
  await writeFile(join(repo.dir, 'src/a.txt'), 'my unstaged change\n');
  await writeFile(join(repo.dir, 'mine.txt'), 'my untracked file\n');
  await owner.app.close();
  return { f, owner, circle, repo, digest };
}

async function crashApply(t, s, mode) {
  const shim = join(s.f.root, 'git-shim'), armed = join(shim, 'armed'), marker = join(shim, 'crash.json');
  await mkdir(shim);
  await writeFile(join(shim, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const armed = fs.existsSync(${JSON.stringify(armed)});
const intents = armed && args.includes('update-ref') ? JSON.parse(fs.readFileSync(${JSON.stringify(join(s.owner.home, 'v1/circles', s.circle.id, 'intents.json'))}, 'utf8')) : null;
function crash() {
  fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({index: process.env.GIT_INDEX_FILE ?? null, intents}));
  process.kill(process.ppid, 'SIGKILL');
  process.exit(0);
}
if (armed && ${JSON.stringify(mode)} === 'partial-index' && args.includes('apply') && args.includes('--cached')) {
  fs.writeFileSync(process.env.GIT_INDEX_FILE, 'DIRC\\0partial');
  crash();
}
if (armed && ${JSON.stringify(mode)} === 'before-ref' && args.includes('update-ref')) crash();
const result = spawnSync(${JSON.stringify(realGit)}, args, {stdio: 'inherit'});
if (armed && ${JSON.stringify(mode)} === 'after-commit' && args.includes('commit-tree') && result.status === 0) crash();
if (armed && ${JSON.stringify(mode)} === 'after-ref' && args.includes('update-ref') && result.status === 0) crash();
process.exit(result.status ?? 1);
`, { mode: 0o700 });
  const child = fork(new URL('./helpers/apply-crash-app.mjs', import.meta.url), [], {
    env: { ...await s.f.env('owner'), CODEX_HOME: join(s.owner.home, '.codex'), CLAUDE_CONFIG_DIR: join(s.owner.home, '.claude'),
      PATH: shim + ':' + process.env.PATH, APPLY_TEST_HOME: s.owner.home, APPLY_TEST_ROOT: s.f.root },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  });
  const [app] = await bounded(Promise.race([
    once(child, 'message'), exited.then(() => { throw new Error('App exited before ready: ' + stderr); }),
  ]), 'crash app startup', 30000);
  const path = jobPath(s.digest) + '/apply';
  const preview = await api(app, path, { method: 'POST', body: { circle: s.circle.id, repo: s.repo.dir, dry_run: true } });
  await writeFile(armed, '');
  await assert.rejects(api(app, path, { method: 'POST', body: {
    circle: s.circle.id, repo: s.repo.dir, dry_run: false, expect: { preview_token: preview.preview_token },
  } }));
  assert.deepEqual(await bounded(exited, 'crashed app exit'), [null, 'SIGKILL']);
  return { preview, crash: JSON.parse(await readFile(marker, 'utf8')) };
}

test('startup reconciles a published Apply after SIGKILL before acknowledgement, exactly once', { timeout: 120000 }, async t => {
  const s = await scenario(t), before = await snapshot(s.repo);
  const { preview, crash } = await crashApply(t, s, 'after-ref');
  const commit = git(s.repo.dir, 'rev-parse', preview.branch);
  const journal = Object.values(crash.intents).filter(intent => intent.kind === 'apply');
  assert.equal(journal.length, 1, 'one durable intent exists before the ref command begins');
  assert.equal(journal[0].result.commit, commit);
  assert.equal(journal[0].result.base, s.repo.commit);
  assert.equal(journal[0].tree, git(s.repo.dir, 'rev-parse', commit + '^{tree}'));
  assert.equal(journal[0].ref, 'refs/heads/' + preview.branch);
  assert.equal((await stat(join(s.owner.home, 'v1/circles', s.circle.id, 'intents.json'))).mode & 0o777, 0o600);
  const metadata = JSON.parse(await readFile(join(s.owner.home, 'v1/job-meta.json'), 'utf8'));
  assert.equal(metadata[s.digest].applied, undefined, 'the killed app never saved its acknowledgement');
  const restarted = await s.f.start('owner');
  await assert.rejects(lstat(join(s.repo.dir, '.git/HEAD.lock')), {code:'ENOENT'});
  await assert.rejects(lstat(join(s.repo.dir, '.git/refs/heads/main.lock')), {code:'ENOENT'});
  const view = await api(restarted.app, jobPath(s.digest) + '?circle=' + s.circle.id);
  assert.equal(view.applied?.commit, commit, 'normal startup must recover the successful Apply');
  assert.equal(view.applied.branch, preview.branch);
  assert.equal(view.jobProjection.application.appliedBranch, preview.branch, 'the job page projection shows the recovered branch');
  const cli = await cliApply(s);
  assert.equal(cli.status, 'applied'); assert.equal(cli.commit, commit, 'CLI retry recognizes the same publication');
  const again = await api(restarted.app, jobPath(s.digest) + '/apply', { method: 'POST', body: {
    circle: s.circle.id, repo: s.repo.dir, dry_run: false, expect: { preview_token: preview.preview_token },
  } });
  assert.equal(again.status, 'applied'); assert.equal(again.commit, commit);
  await restarted.app.close();
  const twice = await s.f.start('owner');
  assert.deepEqual((await api(twice.app, jobPath(s.digest) + '?circle=' + s.circle.id)).applied, view.applied);
  assert.equal(git(s.repo.dir, 'for-each-ref', '--format=%(refname)', 'refs/heads/faravan/'), 'refs/heads/' + preview.branch);
  assert.deepEqual(await snapshot(s.repo), before, 'HEAD, real index and user files must be byte-for-byte unchanged');
});

test('a crash during a partially written private index leaves no visible change after startup', { timeout: 120000 }, async t => {
  const s = await scenario(t), before = await snapshot(s.repo), refs = git(s.repo.dir, 'for-each-ref');
  const { crash } = await crashApply(t, s, 'partial-index');
  assert.ok(crash.index && !crash.index.startsWith(s.repo.dir + '/'), 'the partial index is outside the user repository');
  assert.equal(await readFile(crash.index, 'utf8'), 'DIRC\0partial');
  const restarted = await s.f.start('owner');
  assert.equal((await api(restarted.app, jobPath(s.digest) + '?circle=' + s.circle.id)).applied, null);
  assert.equal(git(s.repo.dir, 'for-each-ref'), refs);
  assert.deepEqual(await snapshot(s.repo), before);
});

test('retry after a crash between commit creation and intent publication', { timeout: 120000 }, async t => {
  const s = await scenario(t), before = await snapshot(s.repo);
  const { crash } = await crashApply(t, s, 'after-commit');
  assert.equal(crash.intents, null);
  const restarted = await s.f.start('owner');
  const path = jobPath(s.digest) + '/apply';
  const preview = await api(restarted.app, path, {method:'POST',body:{circle:s.circle.id,repo:s.repo.dir,dry_run:true}});
  const result = await api(restarted.app, path, {method:'POST',body:{circle:s.circle.id,repo:s.repo.dir,dry_run:false,expect:{preview_token:preview.preview_token}}});
  assert.equal(result.status, 'applied');
  assert.deepEqual(await snapshot(s.repo), before);
});

test('retry recovers after a crash before the ref update', { timeout: 120000 }, async t => {
  const s = await scenario(t), before = await snapshot(s.repo), refs = git(s.repo.dir, 'for-each-ref');
  const { crash } = await crashApply(t, s, 'before-ref');
  assert.equal(Object.values(crash.intents).filter(intent => intent.kind === 'apply').length, 1);
  const restarted = await s.f.start('owner');
  assert.equal((await api(restarted.app, jobPath(s.digest) + '?circle=' + s.circle.id)).applied, null);
  await assert.rejects(lstat(join(s.repo.dir, '.git/refs/heads/main.lock')), {code:'ENOENT'});
  assert.equal(git(s.repo.dir, 'for-each-ref'), refs);
  assert.deepEqual(await snapshot(s.repo), before);
  const preview = await api(restarted.app, jobPath(s.digest) + '/apply', { method: 'POST', body: {
    circle: s.circle.id, repo: s.repo.dir, dry_run: true,
  } });
  const result = await api(restarted.app, jobPath(s.digest) + '/apply', { method: 'POST', body: {
    circle: s.circle.id, repo: s.repo.dir, dry_run: false, expect: { preview_token: preview.preview_token },
  } });
  assert.equal(result.status, 'applied');
  const intents = JSON.parse(await readFile(join(s.owner.home, 'v1/circles', s.circle.id, 'intents.json'), 'utf8'));
  assert.equal(Object.values(intents).filter(intent => intent.kind === 'apply').length, 1);
});

test('an existing Git HEAD lock is reported as a lock, not a changed preview', { timeout: 120000 }, async t => {
  const s = await scenario(t);
  const restarted = await s.f.start('owner');
  const path = jobPath(s.digest) + '/apply';
  const preview = await api(restarted.app, path, { method: 'POST', body: {
    circle: s.circle.id, repo: s.repo.dir, dry_run: true,
  } });
  const headLock = join(s.repo.dir, '.git/HEAD.lock');
  await writeFile(headLock, 'another Git process');
  const refused = await api(restarted.app, path, { method: 'POST', status: 409, body: {
    circle: s.circle.id, repo: s.repo.dir, dry_run: false, expect: { preview_token: preview.preview_token },
  } });
  assert.equal(refused.apply_code, 'apply_locked');
  assert.match(refused.message, /lock/i);
  assert.equal(await readFile(headLock, 'utf8'), 'another Git process');
});

test('a live Git transaction holding HEAD is reported and left intact', { timeout: 120000 }, async t => {
  const s = await scenario(t), restarted = await s.f.start('owner');
  const child = spawn(realGit, ['update-ref', '--stdin'], {cwd:s.repo.dir,stdio:['pipe','pipe','pipe']});
  const exited = once(child, 'exit');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  let output = '', error = '';
  child.stderr.on('data', bytes => { error += bytes; });
  const prepared = new Promise((resolve, reject) => {
    child.stdout.on('data', bytes => { output += bytes; if (output.includes('prepare: ok')) resolve(); });
    child.once('exit', () => reject(new Error('Git exited before preparing: ' + error)));
  });
  child.stdin.write('start\noption no-deref\nupdate HEAD ' + s.repo.commit + '\nprepare\n');
  await bounded(prepared, 'Git HEAD transaction', 30000);
  const lock = join(s.repo.dir, '.git/HEAD.lock');
  const before = await lstat(lock);
  const path = jobPath(s.digest) + '/apply';
  const preview = await api(restarted.app, path, {method:'POST',body:{circle:s.circle.id,repo:s.repo.dir,dry_run:true}});
  const refused = await api(restarted.app, path, {method:'POST',status:409,body:{circle:s.circle.id,repo:s.repo.dir,dry_run:false,expect:{preview_token:preview.preview_token}}});
  assert.equal(refused.apply_code, 'apply_locked');
  assert.equal((await lstat(lock)).ino, before.ino);
  child.stdin.end('abort\n');
  await exited;
});

test('a successful retry retires an unpublished intent', { timeout: 120000 }, async t => {
  const s = await scenario(t);
  await crashApply(t, s, 'before-ref');
  await unlink(join(s.repo.dir, '.git/HEAD.lock'));
  await new Promise(resolve => setTimeout(resolve, 1200));
  const restarted = await s.f.start('owner');
  const path = jobPath(s.digest) + '/apply';
  const preview = await api(restarted.app, path, { method: 'POST', body: { circle: s.circle.id, repo: s.repo.dir, dry_run: true } });
  const result = await api(restarted.app, path, { method: 'POST', body: {
    circle: s.circle.id, repo: s.repo.dir, dry_run: false, expect: { preview_token: preview.preview_token },
  } });
  assert.equal(result.status, 'applied');
  const intents = JSON.parse(await readFile(join(s.owner.home, 'v1/circles', s.circle.id, 'intents.json'), 'utf8'));
  assert.equal(Object.values(intents).filter(intent => intent.kind === 'apply').length, 1);
});

test('a surviving Git writer prevents recovery until it exits', { timeout: 120000 }, async t => {
  const s = await scenario(t), restarted = await s.f.start('owner');
  const child = spawn(realGit, ['update-ref', '--stdin'], { cwd: s.repo.dir, detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  const exited = once(child, 'exit');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const lock = join(s.repo.dir, '.git/HEAD.lock');
  const record = JSON.stringify({ kind:'faravan-apply-head-v1', host:hostname(), namespace:await readlink('/proc/self/ns/pid'), pid:2147483647, writer:child.pid, token:'test' });
  await symlink(record, lock);
  const path = jobPath(s.digest) + '/apply';
  const preview = await api(restarted.app, path, { method:'POST', body:{circle:s.circle.id,repo:s.repo.dir,dry_run:true} });
  const refused = await api(restarted.app, path, { method:'POST', status:409, body:{circle:s.circle.id,repo:s.repo.dir,dry_run:false,expect:{preview_token:preview.preview_token}} });
  assert.equal(refused.apply_code, 'apply_locked');
  assert.equal(await readlink(lock), record);
  child.stdin.end();
  await exited;
  const result = await api(restarted.app, path, { method:'POST', body:{circle:s.circle.id,repo:s.repo.dir,dry_run:false,expect:{preview_token:preview.preview_token}} });
  assert.equal(result.status, 'applied');
});

test('a published retry succeeds during a live writer and later reclaims its lock', { timeout: 120000 }, async t => {
  const s = await scenario(t), { preview } = await crashApply(t, s, 'after-ref');
  const commit = git(s.repo.dir, 'rev-parse', preview.branch);
  const lock = join(s.repo.dir, '.git/HEAD.lock');
  const refLock = join(s.repo.dir, '.git/refs/heads/main.lock');
  await unlink(lock);
  await unlink(refLock);
  const child = spawn(realGit, ['update-ref', '--stdin'], {cwd:s.repo.dir,detached:true,stdio:['pipe','ignore','ignore']});
  const exited = once(child, 'exit');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const record = JSON.stringify({kind:'faravan-apply-head-v1',host:hostname(),namespace:await readlink('/proc/self/ns/pid'),pid:2147483647,writer:child.pid,token:'test'});
  await symlink(record, lock);
  await symlink(record, refLock);
  const restarted = await s.f.start('owner');
  const path = jobPath(s.digest) + '/apply';
  const request = () => api(restarted.app, path, {method:'POST',body:{circle:s.circle.id,repo:s.repo.dir,dry_run:true}});
  assert.equal((await request()).commit, commit);
  assert.ok(await lstat(lock));
  assert.equal(await readlink(refLock), record);
  child.stdin.end();
  await exited;
  assert.equal((await request()).commit, commit);
  await assert.rejects(lstat(lock), {code:'ENOENT'});
  await assert.rejects(lstat(refLock), {code:'ENOENT'});
});

test('overlapping Applies return the same published commit', { timeout: 120000 }, async t => {
  const s = await scenario(t), restarted = await s.f.start('owner');
  const device = restarted.app.device, options = {digest:s.digest,circle:s.circle.id,repo:s.repo.dir,device};
  const preview = await applyForApp(options);
  const originalStore = device.intentStore;
  let arrived = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  device.intentStore = id => {
    const store = originalStore(id), set = store.set;
    store.set = async (key, value) => {
      await set(key, value);
      if (key.startsWith('apply:')) {
        if (++arrived === 2) release();
        await bounded(barrier, 'both Apply intents', 30000);
      }
    };
    return store;
  };
  const run = () => applyForApp({...options,dryRun:false,expect:{preview_token:preview.preview_token}});
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(a.status, 'applied');
  assert.equal(b.status, 'applied');
  assert.equal(a.commit, b.commit);
});

test('a winning Apply retains proof for an in-flight candidate until it stops', { timeout: 120000 }, async t => {
  const s = await scenario(t), restarted = await s.f.start('owner');
  const device = restarted.app.device, options = {digest:s.digest,circle:s.circle.id,repo:s.repo.dir,device};
  const preview = await applyForApp(options), originalStore = device.intentStore;
  let release, announce, first = true;
  const paused = new Promise(resolve => { announce = resolve; });
  const proceed = new Promise(resolve => { release = resolve; });
  device.intentStore = id => {
    const store = originalStore(id), set = store.set;
    store.set = async (key, value) => {
      await set(key, value);
      if (key.startsWith('apply:') && first) {
        first = false;
        announce();
        await bounded(proceed, 'release first Apply', 30000);
      }
    };
    return store;
  };
  const run = () => applyForApp({...options,dryRun:false,expect:{preview_token:preview.preview_token}});
  const pending = run();
  try {
    await bounded(paused, 'first Apply intent', 30000);
    await new Promise(resolve => setTimeout(resolve, 1200));
    const winner = await run();
    assert.equal(winner.status, 'applied');
    const candidates = (await originalStore(s.circle.id).list()).filter(intent => intent.kind === 'apply');
    assert.equal(candidates.length, 2, 'the in-flight candidate still has durable proof');
    assert.notEqual(candidates[0].result.commit, candidates[1].result.commit);
    release();
    assert.equal((await pending).commit, winner.commit);
    assert.equal((await originalStore(s.circle.id).list()).filter(intent => intent.kind === 'apply').length, 1);
  } finally { release(); await pending.catch(() => {}); }
});

test('a lock cleanup failure does not hide a successful publication', { timeout: 120000 }, async t => {
  const s = await scenario(t), restarted = await s.f.start('owner');
  const shim = join(s.f.root, 'cleanup-shim');
  await mkdir(shim);
  await writeFile(join(shim, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(realGit)}, args, {stdio:'inherit'});
if (args.includes('update-ref') && result.status === 0) fs.chmodSync(${JSON.stringify(join(s.repo.dir, '.git'))}, 0o555);
process.exit(result.status ?? 1);
`, {mode:0o700});
  const oldPath = process.env.PATH;
  process.env.PATH = shim + ':' + oldPath;
  try {
    const path = jobPath(s.digest) + '/apply';
    const preview = await api(restarted.app, path, {method:'POST',body:{circle:s.circle.id,repo:s.repo.dir,dry_run:true}});
    const result = await api(restarted.app, path, {method:'POST',body:{circle:s.circle.id,repo:s.repo.dir,dry_run:false,expect:{preview_token:preview.preview_token}}});
    assert.equal(result.status, 'applied');
    assert.equal(git(s.repo.dir, 'rev-parse', result.branch), result.commit);
  } finally {
    process.env.PATH = oldPath;
    await chmod(join(s.repo.dir, '.git'), 0o755);
  }
});

test('overlapping Applies report publication even when lock cleanup fails', { timeout: 120000 }, async t => {
  const s = await scenario(t), restarted = await s.f.start('owner');
  const shim = join(s.f.root, 'concurrent-cleanup-shim');
  await mkdir(shim);
  await writeFile(join(shim, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(realGit)}, args, {stdio:'inherit'});
if (args.includes('update-ref') && result.status === 0) fs.chmodSync(${JSON.stringify(join(s.repo.dir, '.git'))}, 0o555);
process.exit(result.status ?? 1);
`, {mode:0o700});
  const device = restarted.app.device, options = {digest:s.digest,circle:s.circle.id,repo:s.repo.dir,device};
  const preview = await applyForApp(options), originalStore = device.intentStore;
  let first = true, release, announce;
  const paused = new Promise(resolve => { announce = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  device.intentStore = id => {
    const store = originalStore(id), set = store.set;
    store.set = async (key, value) => {
      await set(key, value);
      if (key.startsWith('apply:') && first) { first = false; announce(); await bounded(gate, 'release first Apply', 30000); }
    };
    return store;
  };
  const oldPath = process.env.PATH, oldWarn = console.warn, diagnostics = [];
  process.env.PATH = shim + ':' + oldPath;
  console.warn = (...args) => diagnostics.push(args.join(' '));
  let pending;
  try {
    const run = () => applyForApp({...options,dryRun:false,expect:{preview_token:preview.preview_token}});
    pending = run();
    await bounded(paused, 'first Apply intent', 30000);
    await new Promise(resolve => setTimeout(resolve, 1200));
    const winner = await run();
    const candidates = (await originalStore(s.circle.id).list()).filter(intent => intent.kind === 'apply');
    assert.equal(candidates.length, 2);
    assert.notEqual(candidates[0].result.commit, candidates[1].result.commit);
    release();
    const loser = await pending;
    assert.equal(winner.status, 'applied');
    assert.equal(loser.status, 'applied');
    assert.equal(loser.commit, winner.commit);
    assert.equal(git(s.repo.dir, 'rev-parse', winner.branch), winner.commit);
    const remaining = (await originalStore(s.circle.id).list()).filter(intent => intent.kind === 'apply');
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].result.commit, winner.commit);
    assert.match(diagnostics.join('\n'), /HEAD lock.*cleanup.*EACCES/i);
    assert.ok(await lstat(join(s.repo.dir, '.git/HEAD.lock')), 'the abandoned lock is preserved');
  } finally {
    release();
    await pending?.catch(() => {});
    process.env.PATH = oldPath;
    console.warn = oldWarn;
    await chmod(join(s.repo.dir, '.git'), 0o755);
  }
});

test('a Git publication failure is not reported as a changed repository', { timeout: 120000 }, async t => {
  const s = await scenario(t), restarted = await s.f.start('owner');
  const shim = join(s.f.root, 'publication-shim');
  await mkdir(shim);
  await writeFile(join(shim, 'git'), `#!${process.execPath}
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('update-ref')) { process.stderr.write('simulated ref storage failure\\n'); process.exit(1); }
const result = spawnSync(${JSON.stringify(realGit)}, args, {stdio:'inherit'});
process.exit(result.status ?? 1);
`, {mode:0o700});
  const oldPath = process.env.PATH;
  process.env.PATH = shim + ':' + oldPath;
  try {
    const path = jobPath(s.digest) + '/apply';
    const preview = await api(restarted.app, path, {method:'POST',body:{circle:s.circle.id,repo:s.repo.dir,dry_run:true}});
    const result = await api(restarted.app, path, {method:'POST',status:409,body:{circle:s.circle.id,repo:s.repo.dir,dry_run:false,expect:{preview_token:preview.preview_token}}});
    assert.equal(result.apply_code, 'apply_publish_failed');
    assert.equal(result.state, 'job.apply-failed');
  } finally { process.env.PATH = oldPath; }
});

test('a same-name branch at a different commit is refused even when its tree matches', { timeout: 120000 }, async t => {
  const s = await scenario(t), before = await snapshot(s.repo);
  const { preview } = await crashApply(t, s, 'after-ref');
  const tree = git(s.repo.dir, 'rev-parse', preview.branch + '^{tree}');
  const unrelated = git(s.repo.dir, 'commit-tree', tree, '-p', s.repo.commit, '-m', 'An unrelated commit');
  git(s.repo.dir, 'update-ref', 'refs/heads/' + preview.branch, unrelated);
  const restarted = await s.f.start('owner');
  assert.equal((await api(restarted.app, jobPath(s.digest) + '?circle=' + s.circle.id)).applied, null);
  const refused = await api(restarted.app, jobPath(s.digest) + '/apply', { method: 'POST', status: 409, body: {
    circle: s.circle.id, repo: s.repo.dir, dry_run: true,
  } });
  assert.equal(refused.apply_code, 'branch_exists');
  assert.equal(git(s.repo.dir, 'rev-parse', preview.branch), unrelated);
  assert.deepEqual(await snapshot(s.repo), before);
});

test('a matching ref cannot reconcile with a different journaled tree', { timeout: 120000 }, async t => {
  const s = await scenario(t);
  const { preview } = await crashApply(t, s, 'after-ref');
  const store = s.owner.app.device.intentStore(s.circle.id);
  const intent = (await store.list()).find(intent => intent.kind === 'apply');
  const key = Object.entries(JSON.parse(await readFile(join(s.owner.home, 'v1/circles', s.circle.id, 'intents.json'), 'utf8')))
    .find(([, value]) => value.kind === 'apply')[0];
  await store.set(key, { ...intent, tree: git(s.repo.dir, 'rev-parse', s.repo.commit + '^{tree}') });
  const commit = git(s.repo.dir, 'rev-parse', preview.branch), refs = git(s.repo.dir, 'for-each-ref');
  const restarted = await s.f.start('owner');
  assert.equal((await api(restarted.app, jobPath(s.digest) + '?circle=' + s.circle.id)).applied, null);
  const refused = await api(restarted.app, jobPath(s.digest) + '/apply', { method: 'POST', status: 409, body: {
    circle: s.circle.id, repo: s.repo.dir, dry_run: true,
  } });
  assert.equal(refused.apply_code, 'branch_exists');
  assert.equal(git(s.repo.dir, 'rev-parse', preview.branch), commit);
  assert.equal(git(s.repo.dir, 'for-each-ref'), refs);
});

test('concurrent HEAD lock refuses without pinning Add as a branch',async t=>{
 const s=await scenario(t),{app}=await s.f.start('owner');
 const path=jobPath(s.digest)+'/apply',body={circle:s.circle.id,repo:s.repo.dir};
 const preview=await api(app,path,{method:'POST',body:{...body,dry_run:true}});
 const lock=join(s.repo.dir,'.git/HEAD.lock');await writeFile(lock,'native git operation');
 const {createApi}=await import('../ui/v1/src/api.mjs');
 const {applyWriteRecord}=await import('../ui/v1/src/result-actions.mjs');
 const ui=createApi(app.token,(path,options)=>fetch(app.origin+path,options));
 const record=applyWriteRecord(ui,s.circle.id,s.digest);
 await record.submit(preview,async input=>{
   try {return await ui.post('jobs/'+encodeURIComponent(s.digest)+'/apply',{circle:s.circle.id,...input});}
   catch(error){throw Object.assign(error,{refused:error.applyRefusal});}
 });
 assert.equal(record.state.error.outcome,'not_applied');
 assert.equal(record.state.phase,'refused');assert.equal(record.clear(),true);
 await unlink(lock);
 const result=await api(app,path,{method:'POST',body:{...body,dry_run:false,expect:{preview_token:preview.preview_token}}});
 assert.equal(result.status,'applied');
});
