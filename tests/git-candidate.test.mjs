import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseScript, diffScript, parseBaseOutput, parseUnifiedDiff, diffstat, patchHazards, unsafePatchPath, DIFF_OUTPUT } from '../lib/git-candidate.mjs';
import { guestExec, makeRepo, git } from './helpers/git-guest.mjs';

const guest = async (dir, command) => { const handle = { scratch_dir: dir }; assert.equal(await guestExec(handle, command), true); return handle._lastExecStdout; };
const temp = async t => { const dir = await mkdtemp(join(tmpdir(), 'faravan-candidate-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };

test('archive workspace: base is committed in the guest and the diff is real git output', async t => {
  const dir = await temp(t);
  await mkdir(join(dir, 'src')); await writeFile(join(dir, 'src/a.txt'), 'one\ntwo\n'); await writeFile(join(dir, 'gone.txt'), 'bye\n');
  await mkdir(join(dir, '.wf-inputs')); await writeFile(join(dir, '.wf-inputs/x'), 'lender bookkeeping');
  const base = parseBaseOutput(await guest(dir, baseScript('.')));
  assert.match(base.base, /^[0-9a-f]{40}$/); assert.match(base.tree, /^[0-9a-f]{40}$/);
  await writeFile(join(dir, 'src/a.txt'), 'one\nTWO\nthree\n'); await writeFile(join(dir, 'new.bin'), Buffer.from([0, 1, 2, 255]));
  await rm(join(dir, 'gone.txt')); await mkdir(join(dir, '.wf-result'), { recursive: true });
  await guest(dir, diffScript('.', base.base));
  const diff = await readFile(join(dir, DIFF_OUTPUT));
  const parsed = parseUnifiedDiff(diff);
  assert.deepEqual(parsed.files.map(f => [f.path, f.status, f.binary]).sort(), [['gone.txt', 'deleted', false], ['new.bin', 'added', true], ['src/a.txt', 'modified', false]]);
  assert.deepEqual(diffstat(diff), { files: 3, insertions: 2, deletions: 2 }); // one added line plus one replaced line
  assert.equal(diff.includes('.wf-inputs'), false, 'lender bookkeeping directories are never part of the candidate');
  assert.deepEqual(patchHazards(parsed), []);
});

test('git source workspace: base is the cloned HEAD and the repo directory is diffed', async t => {
  const dir = await temp(t), repo = await makeRepo();
  t.after(() => rm(repo.dir, { recursive: true, force: true }));
  execFileSync('git', ['clone', '-q', repo.dir, join(dir, 'repo')]);
  const base = parseBaseOutput(await guest(dir, baseScript('repo')));
  assert.equal(base.base, repo.commit);
  await writeFile(join(dir, 'repo/README.md'), 'hello\nworld\n');
  await mkdir(join(dir, '.wf-result'));
  await guest(dir, diffScript('repo', base.base));
  assert.deepEqual(diffstat(await readFile(join(dir, DIFF_OUTPUT))), { files: 1, insertions: 1, deletions: 0 });
});

test('base script reports why a diff is unavailable instead of failing', async t => {
  const dir = await temp(t);
  await mkdir(join(dir, '.git'));
  assert.deepEqual(parseBaseOutput(await guest(dir, baseScript('.'))), { unavailable: 'archive_has_git' });
  assert.deepEqual(parseBaseOutput(await guest(dir, baseScript('repo'))), { unavailable: 'git_failed' });
  assert.deepEqual(parseBaseOutput('noise'), { unavailable: 'git_failed' });
  assert.throws(() => diffScript('.', 'not-a-commit'));
});

test('a hostile workspace config cannot run hooks or external diff programs in the guest scripts', async t => {
  const dir = await temp(t), marker = join(dir, 'ran');
  await writeFile(join(dir, 'f.txt'), 'a\n');
  const base = parseBaseOutput(await guest(dir, baseScript('.')));
  await mkdir(join(dir, '.git/hooks'), { recursive: true });
  await writeFile(join(dir, '.git/config'), `[core]\n\tfsmonitor = touch ${marker}\n[diff]\n\texternal = touch ${marker}\n`, { flag: 'a' });
  await writeFile(join(dir, 'f.txt'), 'b\n'); await mkdir(join(dir, '.wf-result'));
  await guest(dir, diffScript('.', base.base));
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('diff reader handles quoted paths, symlinks, mode changes and counts hunks exactly', async t => {
  const repo = await makeRepo({ 'a b.txt': 'x\n' });
  t.after(() => rm(repo.dir, { recursive: true, force: true }));
  await writeFile(join(repo.dir, 'a b.txt'), 'x\n--- looks like a header\n+++ and so does this\n');
  await writeFile(join(repo.dir, 'üñí.txt'), 'u\n');
  await symlink('target.txt', join(repo.dir, 'link'));
  await writeFile(join(repo.dir, 'run.sh'), '#!/bin/sh\n'); execFileSync('chmod', ['+x', join(repo.dir, 'run.sh')]);
  git(repo.dir, 'add', '-A');
  const diff = execFileSync('git', ['diff', '--binary', '--cached', '--no-renames', repo.commit], { cwd: repo.dir });
  const parsed = parseUnifiedDiff(diff);
  assert.deepEqual(parsed.files.map(f => f.path).sort(), ['a b.txt', 'link', 'run.sh', 'üñí.txt']);
  assert.equal(parsed.files.find(f => f.path === 'link').symlinkTarget, 'target.txt');
  assert.equal(parsed.files.find(f => f.path === 'a b.txt').insertions, 2, 'content that looks like headers is counted as content');
  assert.equal(parsed.files.find(f => f.path === 'run.sh').newMode, '100755');
});

test('diff reader and path rules reject hostile or malformed patches', () => {
  const hostile = path => `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`;
  for (const path of ['.git/config', 'sub/.git/hooks/pre-commit', '.GIT/config', '.git /x', '../escape', 'a/../../escape', '/etc/passwd']) {
    assert.notEqual(patchHazards(parseUnifiedDiff(hostile(path))).length, 0, path);
  }
  assert.deepEqual(patchHazards(parseUnifiedDiff(hostile('src/.gitignore'))), []);
  const link = t => `diff --git a/l b/l\nnew file mode 120000\n--- /dev/null\n+++ b/l\n@@ -0,0 +1 @@\n+${t}\n\\ No newline at end of file\n`;
  assert.equal(patchHazards(parseUnifiedDiff(link('/etc/passwd'))).length, 1);
  assert.equal(patchHazards(parseUnifiedDiff(link('../../x'))).length, 1);
  assert.equal(patchHazards(parseUnifiedDiff(link('inside.txt'))).length, 0);
  assert.equal(patchHazards(parseUnifiedDiff('diff --git a/m b/m\nnew file mode 160000\nindex 0000000..1111111\n')).length, 1);
  assert.equal(unsafePatchPath('src/ok.txt'), null);
  for (const bad of ['garbage\n', hostile('x').replace('@@ -0,0 +1 @@\n+x\n', '@@ -0,0 +1 @@\n'), hostile('x') + 'surprise\n', 'diff --git a/x\n']) {
    assert.throws(() => parseUnifiedDiff(bad), { code: 'invalid_patch' });
  }
});
