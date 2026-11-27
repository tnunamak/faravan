import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRepo, git } from './helpers/git-guest.mjs';
import { memoryIntentStore } from './helpers/apply-intents.mjs';
import { applyForApp, ApplyError } from '../lib/v1/apply.mjs';
import { workingTreeForApp, removeBranchForApp, splitPatch } from '../lib/v1/result-actions.mjs';
import { parseUnifiedDiff } from '../lib/git-candidate.mjs';

// Apply to working tree, per-file apply and Remove this branch, against real temporary Git repositories.
const digest = 'sha256:' + 'a'.repeat(64);
const lines = n => Array.from({ length: n }, (_, i) => 'line ' + (i + 1)).join('\n') + '\n';
const FILES = { 'src/a.txt': lines(12), 'src/b.txt': 'bee\n', 'old.txt': 'gone soon\n', '.gitignore': 'secret.env\n' };
async function patchFrom(repo, edit) {
  const copy = await mkdtemp(join(tmpdir(), 'faravan-patch-'));
  try {
    execFileSync('git', ['clone', '-q', repo.dir, copy]);
    await edit(copy); execFileSync('git', ['add', '-A'], { cwd: copy });
    return execFileSync('git', ['diff', '--binary', '--cached', '--no-renames', repo.commit], { cwd: copy });
  } finally { await rm(copy, { recursive: true, force: true }); }
}
const work = async copy => {
  await writeFile(join(copy, 'src/a.txt'), lines(12).replace('line 2\n', 'LINE TWO\n'));
  await writeFile(join(copy, 'src/b.txt'), 'BEE\n');
  await rm(join(copy, 'old.txt'));
  await writeFile(join(copy, 'new.txt'), 'brand new\n');
};
const deviceFor = (patch, base, calls = []) => ({
  intentStore: memoryIntentStore(),
  selectCircle: async () => ({ id: 'circle' }),
  listCircles: async () => [{ id: 'circle' }],
  client: async () => ({
    getJob: async () => ({ current_attempt: { attempt_id: 'x' } }),
    fetchResult: async () => { calls.push('fetchResult'); return { bytes: patch, candidate: { media_type: 'text/x-diff' },
      receipt: { harness: 'codex', model: 'm', duration_ms: 1000 }, job: { source: { kind: 'git', commit: base }, prompt: { digest: 'x' } } }; },
    fetchArtifact: async () => { throw new Error('no prompt'); },
  }),
});
async function scenario(t) {
  const repo = await makeRepo(FILES); t.after(() => rm(repo.dir, { recursive: true, force: true }));
  const patch = await patchFrom(repo, work), calls = [];
  return { repo, patch, calls, device: deviceFor(patch, repo.commit, calls) };
}
const snapshot = dir => [git(dir, 'status', '--porcelain', '--untracked-files=all', '--ignored'), git(dir, 'for-each-ref'), git(dir, 'rev-parse', 'HEAD')];
const exists = p => access(p).then(() => true, () => false);
const refused = async (run) => { try { await run(); } catch (error) { assert.ok(error instanceof ApplyError, String(error)); return error.code; } assert.fail('expected a refusal'); };
const preview = (s, over = {}) => workingTreeForApp({ digest, circle: 'circle', repo: s.repo.dir, dryRun: true, device: s.device, ...over });
const apply = (s, p, files = null) => workingTreeForApp({ digest, circle: 'circle', repo: s.repo.dir, dryRun: false, files, expect: { head: p.head, current_branch: p.current_branch }, device: s.device });
const states = out => Object.fromEntries(out.files.map(f => [f.path, f.state]));

test('splitPatch gives one piece per parsed file, byte for byte', async t => {
  const { patch } = await scenario(t);
  const parts = splitPatch(patch);
  assert.equal(parts.length, parseUnifiedDiff(patch).files.length);
  assert.ok(Buffer.concat(parts).equals(patch));
});

test('the preview reads the verified result, gives each file a state and writes nothing', async t => {
  const s = await scenario(t), before = snapshot(s.repo.dir);
  const out = await preview(s);
  assert.equal(out.status, 'dry_run');
  assert.deepEqual(states(out), { 'new.txt': 'applies', 'old.txt': 'applies', 'src/a.txt': 'applies', 'src/b.txt': 'applies' });
  assert.deepEqual([out.head, out.current_branch, out.per_file], [s.repo.commit, 'main', true]);
  assert.ok(out.files.every(f => !('chunk' in f) && !('paths' in f)), 'patch bytes stay on the server');
  assert.deepEqual(s.calls, ['fetchResult']);
  assert.deepEqual(snapshot(s.repo.dir), before);
});

test('apply all writes the files unstaged and leaves HEAD, the index and the branches alone', async t => {
  const s = await scenario(t), p = await preview(s), refs = git(s.repo.dir, 'for-each-ref');
  const out = await apply(s, p);
  assert.equal(out.status, 'applied');
  assert.deepEqual(out.undo, { restore: ['old.txt', 'src/a.txt', 'src/b.txt'].filter(x => out.undo.restore.includes(x)), remove: ['new.txt'] });
  assert.match(await readFile(join(s.repo.dir, 'src/a.txt'), 'utf8'), /LINE TWO/);
  assert.equal(await readFile(join(s.repo.dir, 'new.txt'), 'utf8'), 'brand new\n');
  assert.equal(await exists(join(s.repo.dir, 'old.txt')), false);
  assert.equal(git(s.repo.dir, 'diff', '--cached', '--name-only'), '', 'nothing staged');
  assert.equal(git(s.repo.dir, 'status', '--porcelain', '--untracked-files=all'), 'D old.txt\n M src/a.txt\n M src/b.txt\n?? new.txt');
  assert.deepEqual([git(s.repo.dir, 'rev-parse', 'HEAD'), git(s.repo.dir, 'for-each-ref')], [s.repo.commit, refs]);
});

test('per-file apply writes only the chosen files', async t => {
  const s = await scenario(t), p = await preview(s);
  const out = await apply(s, p, ['src/b.txt']);
  assert.deepEqual(out.applied, ['src/b.txt']);
  assert.equal(git(s.repo.dir, 'status', '--porcelain', '--untracked-files=all'), 'M src/b.txt');
});

test('a file you changed in a commit since the base merges three ways', async t => {
  const s = await scenario(t);
  await writeFile(join(s.repo.dir, 'src/a.txt'), lines(12).replace('line 11\n', 'eleven, mine\n'));
  git(s.repo.dir, 'commit', '-qam', 'mine');
  const p = await preview(s);
  assert.equal(states(p)['src/a.txt'], 'merges');
  await apply(s, p, ['src/a.txt']);
  const merged = await readFile(join(s.repo.dir, 'src/a.txt'), 'utf8');
  assert.match(merged, /LINE TWO/); assert.match(merged, /eleven, mine/);
});

test('a conflict is shown per file and refused without writing; other files still apply', async t => {
  const s = await scenario(t);
  await writeFile(join(s.repo.dir, 'src/a.txt'), lines(12).replace('line 2\n', 'my line two\n'));
  git(s.repo.dir, 'commit', '-qam', 'mine');
  const p = await preview(s), before = snapshot(s.repo.dir);
  assert.deepEqual(states(p), { 'new.txt': 'applies', 'old.txt': 'applies', 'src/a.txt': 'conflict', 'src/b.txt': 'applies' });
  assert.equal(await refused(() => apply(s, p)), 'patch_conflict');
  assert.deepEqual(snapshot(s.repo.dir), before, 'nothing written');
  await apply(s, p, ['src/b.txt', 'new.txt']);
  assert.equal(git(s.repo.dir, 'status', '--porcelain', '--untracked-files=all'), 'M src/b.txt\n?? new.txt');
});

test('uncommitted changes, an ignored file in the way and a symlinked folder each block their file only', async t => {
  const s = await scenario(t);
  await writeFile(join(s.repo.dir, 'src/b.txt'), 'my edit\n');
  const outside = await mkdtemp(join(tmpdir(), 'faravan-outside-')); t.after(() => rm(outside, { recursive: true, force: true }));
  const patch = await patchFrom(s.repo, async copy => { await work(copy); await writeFile(join(copy, 'secret.env'), 'X=1\n'); execFileSync('git', ['add', '-f', 'secret.env'], { cwd: copy }); await mkdir(join(copy, 'linked')); await writeFile(join(copy, 'linked/x.txt'), 'x\n'); });
  const device = deviceFor(patch, s.repo.commit);
  await writeFile(join(s.repo.dir, 'secret.env'), 'MY_TOKEN=keep\n');
  await symlink(outside, join(s.repo.dir, 'linked'));
  const p = await preview({ ...s, device });
  assert.deepEqual([states(p)['src/b.txt'], states(p)['secret.env'], states(p)['linked/x.txt'], states(p)['src/a.txt']], ['yours', 'exists', 'unsafe', 'applies']);
  const tryApply = file => refused(() => workingTreeForApp({ digest, circle: 'circle', repo: s.repo.dir, dryRun: false, files: ['src/a.txt', file], expect: p, device }));
  let before = snapshot(s.repo.dir);
  assert.equal(await tryApply('src/b.txt'), 'dirty');
  assert.deepEqual(snapshot(s.repo.dir), before);
  git(s.repo.dir, 'checkout', '-q', '--', 'src/b.txt');
  before = snapshot(s.repo.dir);
  for (const [file, code] of [['secret.env', 'path_exists'], ['linked/x.txt', 'unsafe_path']]) assert.equal(await tryApply(file), code);
  assert.deepEqual(snapshot(s.repo.dir), before);
  assert.equal(await readFile(join(s.repo.dir, 'secret.env'), 'utf8'), 'MY_TOKEN=keep\n');
  assert.equal(await exists(join(outside, 'x.txt')), false);
});

test('a repository that moved since the preview writes nothing and shows the new state', async t => {
  const s = await scenario(t), p = await preview(s);
  await writeFile(join(s.repo.dir, 'later.txt'), 'x\n'); git(s.repo.dir, 'add', 'later.txt'); git(s.repo.dir, 'commit', '-qm', 'later');
  const before = snapshot(s.repo.dir);
  const out = await apply(s, p);
  assert.equal(out.status, 'changed'); assert.notEqual(out.head, p.head);
  assert.deepEqual(snapshot(s.repo.dir), before);
  assert.equal((await workingTreeForApp({ digest, circle: 'circle', repo: s.repo.dir, dryRun: false, device: s.device })).status, 'changed', 'no expectation, no write');
});

test('unknown files, empty selections and bad folders are refused', async t => {
  const s = await scenario(t), p = await preview(s);
  assert.equal(await refused(() => apply(s, p, ['../../etc/passwd'])), 'unknown_file');
  assert.equal(await refused(() => apply(s, p, [])), 'nothing_selected');
  assert.equal(await refused(() => preview(s, { repo: 'relative' })), 'repo_missing');
  const plain = await mkdtemp(join(tmpdir(), 'faravan-plain-')); t.after(() => rm(plain, { recursive: true, force: true }));
  assert.equal(await refused(() => preview(s, { repo: plain })), 'not_a_repository');
  assert.equal(await refused(() => preview(s, { digest: 'nope' })), 'invalid_job');
});

async function added(t) {
  const s = await scenario(t);
  const p = await applyForApp({ digest, circle: 'circle', repo: s.repo.dir, dryRun: true, device: s.device });
  const done = await applyForApp({ digest, circle: 'circle', repo: s.repo.dir, dryRun: false, expect: { preview_token: p.preview_token }, device: s.device });
  return { ...s, applied: { branch: done.branch, repo: done.repo, commit: done.commit } };
}

test('Remove this branch deletes the untouched branch Add as a branch made, and nothing else', async t => {
  const s = await added(t), ref = 'refs/heads/' + s.applied.branch;
  assert.equal((await removeBranchForApp({ digest, applied: s.applied, dryRun: true })).status, 'removable');
  assert.equal(git(s.repo.dir, 'for-each-ref', '--format=%(refname)', ref), ref, 'dry run keeps it');
  assert.equal((await removeBranchForApp({ digest, applied: s.applied })).status, 'removed');
  assert.equal(git(s.repo.dir, 'for-each-ref', '--format=%(refname)', ref), '');
  assert.equal(git(s.repo.dir, 'rev-parse', 'HEAD'), s.repo.commit);
  assert.equal((await removeBranchForApp({ digest, applied: s.applied })).status, 'gone');
});

test('a branch with new commits, checked out, or not holding this job is left alone', async t => {
  const s = await added(t), ref = 'refs/heads/' + s.applied.branch;
  assert.equal(await refused(() => removeBranchForApp({ digest: 'sha256:' + 'b'.repeat(64), applied: s.applied })), 'not_our_commit');
  git(s.repo.dir, 'switch', '-q', s.applied.branch);
  assert.equal(await refused(() => removeBranchForApp({ digest, applied: s.applied })), 'branch_checked_out');
  await writeFile(join(s.repo.dir, 'mine.txt'), 'x\n'); git(s.repo.dir, 'add', 'mine.txt'); git(s.repo.dir, 'commit', '-qm', 'mine');
  git(s.repo.dir, 'switch', '-q', 'main');
  assert.equal(await refused(() => removeBranchForApp({ digest, applied: s.applied })), 'branch_moved');
  assert.notEqual(git(s.repo.dir, 'rev-parse', ref), s.applied.commit, 'still there with your commit');
  assert.equal(await refused(() => removeBranchForApp({ digest, applied: { ...s.applied, branch: '--force' } })), 'not_applied');
  assert.equal(await refused(() => removeBranchForApp({ digest, applied: null })), 'not_applied');
});

test('the working tree must be clean: a change to any tracked file, staged or not, stops the apply; untracked files elsewhere do not', async t => {
  const s = await scenario(t);
  await writeFile(join(s.repo.dir, 'scratch.log'), 'untracked\n');
  const tidy = await preview(s);
  assert.deepEqual(tidy.working_tree, { clean: true, changed: [], more: 0 });
  await writeFile(join(s.repo.dir, 'README.extra'), 'x\n'); git(s.repo.dir, 'add', 'README.extra');
  await writeFile(join(s.repo.dir, '.gitignore'), 'secret.env\nmine\n');
  const p = await preview(s);
  assert.deepEqual(p.working_tree, { clean: false, changed: ['.gitignore', 'README.extra'], more: 0 });
  assert.equal(states(p)['src/b.txt'], 'applies', 'per-file states stay informative');
  const before = snapshot(s.repo.dir);
  assert.equal(await refused(() => apply(s, p, ['src/b.txt'])), 'dirty');
  assert.deepEqual(snapshot(s.repo.dir), before, 'nothing written');
  git(s.repo.dir, 'reset', '-q'); git(s.repo.dir, 'checkout', '-q', '--', '.gitignore');
  const again = await preview(s);
  assert.equal((await apply(s, again, ['src/b.txt'])).status, 'applied', 'untracked README.extra and scratch.log are fine');
});

test('assume-unchanged and skip-worktree flags cannot hide edits from working-tree apply',async t=>{
 for(const flag of ['--assume-unchanged','--skip-worktree']) {
  const s=await scenario(t);git(s.repo.dir,'update-index',flag,'src/a.txt');
  await writeFile(join(s.repo.dir,'src/a.txt'),'private local edit\n');
  assert.equal(await refused(()=>preview(s)),'index_flags');
  assert.equal(await readFile(join(s.repo.dir,'src/a.txt'),'utf8'),'private local edit\n');
 }
});
test('returned attributes and existing conversion filters cannot run during a working-tree apply',async t=>{
 const s=await scenario(t);
 const attrs=await patchFrom(s.repo,async copy=>{await writeFile(join(copy,'.gitattributes'),'*.txt filter=faravan-test\n');await writeFile(join(copy,'src/a.txt'),'new\n');});
 const withAttrs={...s,device:deviceFor(attrs,s.repo.commit)};
 assert.equal(await refused(()=>preview(withAttrs)),'attributes');
 await writeFile(join(s.repo.dir,'.gitattributes'),'*.txt filter=faravan-test\n');git(s.repo.dir,'add','.gitattributes');git(s.repo.dir,'commit','-qm','Configure local attributes');
 const marker=join(s.repo.dir,'filter-ran');
 git(s.repo.dir,'config','filter.faravan-test.smudge','touch '+marker);
 assert.equal(await refused(()=>preview(s)),'attributes');assert.equal(await exists(marker),false);
});

test('result symlinks cannot expose repository metadata',async t=>{
 const s=await scenario(t),patch=await patchFrom(s.repo,copy=>symlink('.git/config',join(copy,'linked-config')));
 assert.equal(await refused(()=>preview({...s,device:deviceFor(patch,s.repo.commit)})),'unsafe_patch');
});
