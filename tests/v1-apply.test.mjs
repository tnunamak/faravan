import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, parseOne } from './helpers/v1-journey.mjs';
import { makeRepo, git } from './helpers/git-guest.mjs';
import { applyResult } from '../lib/v1/apply.mjs';
import { memoryIntentStore } from './helpers/apply-intents.mjs';

const bin = fileURLToPath(new URL('../bin/faravan', import.meta.url));
const exists = path => access(path).then(() => true, () => false);

async function create(f) {
  await f.provisionFromHome('owner');
  const made = await f.cli(['circle', 'create', f.origin, '--name', 'Synthetic circle']);
  assert.equal(made.code, 0, made.stderr);
  return [...f.circles.keys()].at(-1);
}
async function submitGit(f, circle, commit, prompt = 'Fix the greeting\nsecond line of detail') {
  return parseOne(await f.cli(['job', 'submit', '--yes', '--git', 'https://example.test/synthetic.git@' + commit, '--prompt', prompt, '--circle', circle, '--json'])).jobDigest;
}
async function run(f, cwd, args, extraEnv = {}) {
  const child = spawn(process.execPath, [bin, 'apply', ...args], { cwd, env: { ...await f.env('owner'), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
}
/** A real `git diff --binary` produced by editing a throwaway clone of the repo. */
async function patchFrom(repo, edit) {
  const copy = await mkdtemp(join(tmpdir(), 'faravan-patch-'));
  try {
    execFileSync('git', ['clone', '-q', repo.dir, copy]);
    await edit(copy); git(copy, 'add', '-A');
    return execFileSync('git', ['diff', '--binary', '--cached', '--no-renames', repo.commit], { cwd: copy, maxBuffer: 1 << 26 });
  } finally { await rm(copy, { recursive: true, force: true }); }
}
const greeting = copy => writeFile(join(copy, 'src/a.txt'), 'one\nTWO\nthree\nfour\n');
const hostile = path => Buffer.from(`diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+owned\n`);
const branches = (dir, glob = 'faravan/*') => git(dir, 'branch', '--list', glob);

async function scenario(t, { patch, mediaType = 'text/x-diff', receipt, base, tree = false } = {}) {
  const f = await fixture(t), circle = await create(f);
  const repo = await makeRepo(); t.after(() => rm(repo.dir, { recursive: true, force: true }));
  const id = await submitGit(f, circle, base ?? repo.commit);
  await f.complete(id, 'owner', { candidate: patch ?? await patchFrom(repo, greeting), candidateMediaType: mediaType,
    receipt: { harness: 'codex', harness_version: '1.2.3', model: 'example-model', duration_ms: 83000,
      ...(tree ? { candidate_format: 'tree' } : { candidate_format: 'diff', diffstat: { files: 1, insertions: 2, deletions: 1 } }), ...receipt } });
  return { f, circle, repo, id };
}

test('dry run reports what would happen and creates nothing', { timeout: 30000 }, async t => {
  const { f, repo, id } = await scenario(t);
  const before = git(repo.dir, 'for-each-ref');
  const result = await run(f, repo.dir, [id, '--dry-run']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Dry run: the patch applies cleanly \(1 file, \+2 -1\)/);
  assert.match(result.stdout, new RegExp('branch faravan/' + id.slice(7, 19)));
  assert.equal(git(repo.dir, 'for-each-ref'), before);
});

test('apply creates a new branch at the base with a commit built from the prompt and receipt', { timeout: 30000 }, async t => {
  const { f, repo, id } = await scenario(t);
  const result = await run(f, repo.dir, [id, '--json']);
  assert.equal(result.code, 0, result.stderr);
  const out = JSON.parse(result.stdout), branch = 'faravan/' + id.slice(7, 19);
  assert.equal(out.status, 'applied'); assert.equal(out.branch, branch); assert.equal(out.base, repo.commit);
  assert.equal(git(repo.dir, 'rev-parse', branch), out.commit);
  assert.equal(git(repo.dir, 'rev-parse', branch + '^'), repo.commit);
  assert.equal(git(repo.dir, 'show', branch + ':src/a.txt'), 'one\nTWO\nthree\nfour');
  const message = git(repo.dir, 'log', '-1', '--format=%B', branch);
  assert.equal(message.split('\n')[0], 'Fix the greeting', 'subject is the first line of the prompt');
  assert.match(message, /Agent: codex 1\.2\.3 · Model: example-model · Duration: 1m 23s/);
  assert.match(message, /Changes: 1 file, \+2 -1/);
  assert.equal(git(repo.dir, 'log', '-1', '--format=%an', branch), 'Test', 'the repository identity is used');
  const again = await run(f, repo.dir, [id]);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(git(repo.dir, 'rev-parse', branch), out.commit, 'a retry recognizes the exact published commit');
});

test('apply accepts the short job ID that run and job print', { timeout: 30000 }, async t => {
  const { f, repo, id } = await scenario(t);
  const result = await run(f, repo.dir, [id.slice(7, 15), '--dry-run', '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).job_digest, id);
});

test('apply never touches the current branch, index or uncommitted work', { timeout: 30000 }, async t => {
  const { f, repo, id } = await scenario(t);
  await writeFile(join(repo.dir, 'src/a.txt'), 'my own local edit\n');           // unstaged change to the very file the patch edits
  await writeFile(join(repo.dir, 'README.md'), 'staged edit\n'); git(repo.dir, 'add', 'README.md');
  await writeFile(join(repo.dir, 'untracked.txt'), 'scratch\n');
  const snapshot = () => ({ head: git(repo.dir, 'rev-parse', 'HEAD'), branch: git(repo.dir, 'branch', '--show-current'),
    status: git(repo.dir, 'status', '--porcelain=v2'), diff: git(repo.dir, 'diff'), cached: git(repo.dir, 'diff', '--cached') });
  const before = snapshot();
  const result = await run(f, repo.dir, [id, '--branch', 'review/agent']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(snapshot(), before);
  assert.equal(await readFile(join(repo.dir, 'src/a.txt'), 'utf8'), 'my own local edit\n');
  assert.equal(await readFile(join(repo.dir, 'untracked.txt'), 'utf8'), 'scratch\n');
  assert.equal(git(repo.dir, 'show', 'review/agent:src/a.txt'), 'one\nTWO\nthree\nfour');
  assert.match(result.stdout, /current branch and working tree were not changed/);
});

test('apply disables config-defined hooks without changing the repository config', { timeout: 30000 }, async t => {
  const { f, repo, id } = await scenario(t);
  const marker = join(repo.dir, '.config-hook-fired');
  // Multiple events, duplicate keys and a name containing dots exercise the
  // config event-list reset rather than just hooksPath or a single event.
  git(repo.dir, 'config', 'hook.review.agent.command', 'touch .config-hook-fired');
  git(repo.dir, 'config', '--add', 'hook.review.agent.event', 'pre-commit');
  git(repo.dir, 'config', '--add', 'hook.review.agent.event', 'reference-transaction');
  git(repo.dir, 'config', 'hook.review.agent.enabled', 'true');
  git(repo.dir, '-c', 'core.hooksPath=/dev/null', 'hook', 'run', '--ignore-missing', 'reference-transaction', '--', 'prepared');
  if (!await exists(marker)) { t.skip('installed Git does not execute config-defined hooks'); return; }
  await rm(marker);
  const before = await readFile(join(repo.dir, '.git/config'), 'utf8');
  const result = await run(f, repo.dir, [id, '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'applied');
  assert.equal(await exists(marker), false, 'reference publication must not execute configured commands');
  assert.equal(await readFile(join(repo.dir, '.git/config'), 'utf8'), before);
  // The unchanged config still runs when a person invokes Git normally.
  git(repo.dir, '-c', 'core.hooksPath=/dev/null', 'hook', 'run', '--ignore-missing', 'reference-transaction', '--', 'prepared');
  assert.equal(await exists(marker), true);
});

// This case wraps every Git call in several subprocesses. The guard bounds a hang under shared-host load.
test('apply resets every config-defined hook event, including names with "=", and ignores GIT_CONFIG', { timeout: 120000 }, async t => {
  const { f, repo, id } = await scenario(t);
  git(repo.dir, 'config', 'hook.review=agent.event', 'reference-transaction');
  git(repo.dir, 'config', 'hook.Mixed.Case.command', 'true');
  const shim = join(repo.dir, '.git-shim'), log = join(shim, 'log');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  await mkdir(shim);
  // Record the config each non-`config` git command sees, then run real git.
  await writeFile(join(shim, 'git'), `#!/bin/sh
for a; do case "$a" in -c|*=*) continue;; config) exec "${realGit}" "$@";; *) break;; esac; done
"${realGit}" config --get-all 'hook.review=agent.event' | tail -n 1 | sed 's/^/eq=[/;s/$/]/' >> "${log}"
"${realGit}" config --get-all 'hook.Mixed.Case.event' | tail -n 1 | sed 's/^/mixed=[/;s/$/]/' >> "${log}"
env | grep -c '^GIT_CONFIG=' | sed 's/^/legacy=/' >> "${log}"
exec "${realGit}" "$@"
`, { mode: 0o700 });
  const empty = join(shim, 'empty.cfg'); await writeFile(empty, '');
  const result = await run(f, repo.dir, [id, '--json'], { PATH: shim + ':' + process.env.PATH, GIT_CONFIG: empty });
  assert.equal(result.code, 0, result.stderr);
  const lines = (await readFile(log, 'utf8')).trim().split('\n');
  assert.ok(lines.length >= 3, "the shim saw the git commands apply ran");
  assert.deepEqual([...new Set(lines)].sort(), ['eq=[]', 'legacy=0', 'mixed=[]']);
});

test('apply works when HEAD has moved past the base commit', { timeout: 30000 }, async t => {
  const { f, repo, id } = await scenario(t);
  await writeFile(join(repo.dir, 'later.txt'), 'x\n'); git(repo.dir, 'add', '-A'); git(repo.dir, 'commit', '-q', '-m', 'later');
  const result = await run(f, repo.dir, [id]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(git(repo.dir, 'rev-parse', 'faravan/' + id.slice(7, 19) + '^'), repo.commit);
});

test('refuses when the repository does not contain the base commit', { timeout: 30000 }, async t => {
  const { f, id } = await scenario(t);
  const other = await makeRepo({ 'unrelated.txt': 'y\n' }); t.after(() => rm(other.dir, { recursive: true, force: true }));
  const result = await run(f, other.dir, [id]);
  assert.equal(result.code, 1); assert.match(result.stderr, /does not contain commit/);
  assert.equal(branches(other.dir), '');
  const outside = await mkdtemp(join(tmpdir(), 'faravan-notrepo-')); t.after(() => rm(outside, { recursive: true, force: true }));
  const nowhere = await run(f, outside, [id]);
  assert.equal(nowhere.code, 1); assert.match(nowhere.stderr, /inside the Git repository/);
});

test('refuses a base commit that exists but is not an ancestor of HEAD', { timeout: 30000 }, async t => {
  const { f, repo, id } = await scenario(t);
  git(repo.dir, 'checkout', '-q', '--orphan', 'elsewhere'); await writeFile(join(repo.dir, 'z.txt'), 'z\n'); git(repo.dir, 'add', '-A'); git(repo.dir, 'commit', '-q', '-m', 'unrelated');
  const result = await run(f, repo.dir, [id]);
  assert.equal(result.code, 1); assert.match(result.stderr, /does not contain commit/);
  assert.equal(branches(repo.dir), '');
});

for (const [name, path] of [['a .git path', '.git/hooks/post-checkout'], ['a nested .git path', 'vendor/.git/config'], ['a path traversal', '../escaped.txt'],
  ['an absolute path', '/tmp/faravan-absolute-escape.txt'], ['a mixed-case .git path', '.GiT/config']]) {
  test(`refuses a patch touching ${name} and writes nothing`, { timeout: 30000 }, async t => {
    const { f, repo, id } = await scenario(t, { patch: hostile(path) });
    const tree = git(repo.dir, 'status', '--porcelain=v2'), refs = git(repo.dir, 'for-each-ref');
    const result = await run(f, repo.dir, [id]);
    assert.equal(result.code, 1); assert.match(result.stderr, /unsafe patch/i);
    assert.equal(git(repo.dir, 'for-each-ref'), refs); assert.equal(git(repo.dir, 'status', '--porcelain=v2'), tree);
    assert.equal(await exists(join(repo.dir, '.git/hooks/post-checkout')), false);
    assert.equal(await exists(join(repo.dir, '..', 'escaped.txt')), false);
    assert.equal(await exists('/tmp/faravan-absolute-escape.txt'), false);
  });
}

test('refuses symlinks that point outside the repository and malformed patches', { timeout: 30000 }, async t => {
  const link = Buffer.from('diff --git a/l b/l\nnew file mode 120000\nindex 0000000..e69de29\n--- /dev/null\n+++ b/l\n@@ -0,0 +1 @@\n+/etc/passwd\n\\ No newline at end of file\n');
  for (const patch of [link, Buffer.from('this is not a patch\n'), Buffer.from('')]) {
    const { f, repo, id } = await scenario(t, { patch });
    const result = await run(f, repo.dir, [id]);
    assert.equal(result.code, 1, result.stdout); assert.equal(branches(repo.dir), '');
  }
});

test('refuses a patch that does not apply to the base, and a tree (non-diff) result', { timeout: 30000 }, async t => {
  const stale = Buffer.from('diff --git a/src/a.txt b/src/a.txt\nindex 1111111..2222222 100644\n--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1,3 +1,3 @@\n nope\n-not there\n+changed\n x\n');
  const a = await scenario(t, { patch: stale });
  const conflict = await run(a.f, a.repo.dir, [a.id]);
  assert.equal(conflict.code, 1); assert.match(conflict.stderr, /does not apply to the base commit/); assert.equal(branches(a.repo.dir), '');
  const b = await scenario(t, { mediaType: 'application/gzip', patch: Buffer.from('not used'), tree: true });
  const tree = await run(b.f, b.repo.dir, [b.id]);
  assert.equal(tree.code, 1); assert.match(tree.stderr, /full copy of the files/); assert.equal(branches(b.repo.dir), '');
});

test('usage errors exit 2 without contacting anything', { timeout: 30000 }, async t => {
  const { f, repo, id } = await scenario(t);
  for (const args of [[], [id, '--bogus'], ['sha256:short'], [id, '--branch'], [id, '--branch', '-x'], [id, '--branch', 'bad..name']]) {
    const result = await run(f, repo.dir, args);
    assert.equal(result.code, 2, args.join(' ') + result.stderr);
  }
  assert.equal(branches(repo.dir), '');
});

test('archive jobs match the lender snapshot by tree, not by commit', { timeout: 30000 }, async t => {
  const f = await fixture(t), circle = await create(f);
  const repo = await makeRepo(); t.after(() => rm(repo.dir, { recursive: true, force: true }));
  const id = parseOne(await f.cli(['job', 'submit', '--yes', '--source', repo.dir, '--prompt', 'Archive job', '--circle', circle, '--json'])).jobDigest;
  const patch = await patchFrom(repo, greeting), tree = git(repo.dir, 'rev-parse', 'HEAD^{tree}');
  await f.complete(id, 'owner', { candidate: patch, candidateMediaType: 'text/x-diff',
    receipt: { candidate_format: 'diff', diffstat: { files: 1, insertions: 2, deletions: 1 }, base_tree: tree } });
  await writeFile(join(repo.dir, 'later.txt'), 'x\n'); git(repo.dir, 'add', '-A'); git(repo.dir, 'commit', '-q', '-m', 'later');
  const ok = await run(f, repo.dir, [id]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(git(repo.dir, 'rev-parse', 'faravan/' + id.slice(7, 19) + '^'), repo.commit, 'branch starts at the commit whose tree was sent');

  const lost = await scenario(t); // different repository: no commit has the snapshot tree
  const other = await makeRepo({ 'q.txt': 'q\n' }); t.after(() => rm(other.dir, { recursive: true, force: true }));
  const missing = await run(f, other.dir, [id]);
  assert.equal(missing.code, 1); assert.match(missing.stderr, /No commit in this repository matches the snapshot/);
  void lost;
});

// Verify binding before any patch application, using a synthetic client.
test('apply retains an earlier job attempt and does not apply after verification rejects it',async t=>{
  const repo=await makeRepo();t.after(()=>rm(repo.dir,{recursive:true,force:true}));
  const digest='sha256:'+'1'.repeat(64),prior={job_digest:digest,attempt_id:'prior',generation:1,holder:'lender'};
  const events=[],signal=new AbortController().signal,before=git(repo.dir,'for-each-ref');
  const client={
    getJob:async(id,opts)=>{assert.equal(id,digest);assert.equal(opts.signal,signal);events.push('job');return {current_attempt:prior};},
    fetchResult:async(id,opts)=>{events.push('result');assert.equal(id,digest);assert.equal(opts.signal,signal);
      assert.equal(opts.includeMetadata,true);assert.deepEqual(opts.attempt,prior);assert.notEqual(opts.attempt,prior);
      prior.generation=2;assert.equal(opts.attempt.generation,1);throw Object.assign(new Error('mismatch'),{code:'stale_attempt'});}
  };
  const device={intentStore:memoryIntentStore(),selectCircle:async()=>({id:'circle'}),client:async()=>client};
  await assert.rejects(applyResult({digest,circle:'circle',repo:repo.dir,device,signal}),{code:'stale_attempt'});
  assert.deepEqual(events,['job','result']);assert.equal(git(repo.dir,'for-each-ref'),before);
});
