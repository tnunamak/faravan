import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, chmod, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SOURCE_MEDIA_TYPE, packageSourceDirectory, SubmitError} from '../lib/source-package.mjs';
const execFileAsync = promisify(execFile);

async function makeGitRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'faravan-submit-src-'));
  await execFileAsync('git', ['-C', dir, 'init', '-q']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  await writeFile(join(dir, 'hello.txt'), 'hello world\n');
  await writeFile(join(dir, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(dir, 'ignored.txt'), 'should not appear in archive\n');
  await execFileAsync('git', ['-C', dir, 'add', 'hello.txt', '.gitignore']);
  await execFileAsync('git', ['-C', dir, 'commit', '-q', '-m', 'initial']);
  return dir;
}

test('packageSourceDirectory uses git archive for a git repo and excludes gitignored files', async () => {
  const dir = await makeGitRepo();
  const artifact = await packageSourceDirectory(dir);
  assert.equal(artifact.method, 'git-archive');
  assert.equal(artifact.media_type, SOURCE_MEDIA_TYPE);
  assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
  assert.equal(createHash('sha256').update(artifact.buffer).digest('hex'), artifact.sha256);
  assert.equal(artifact.bytes, artifact.buffer.length);

  // Verify contents via a fresh tar listing over the produced buffer.
  const tmp = await mkdtemp(join(tmpdir(), 'faravan-submit-listing-'));
  const tarPath = join(tmp, 'archive.tar');
  await writeFile(tarPath, artifact.buffer);
  const { stdout } = await execFileAsync('tar', ['-tf', tarPath]);
  assert.match(stdout, /hello\.txt/);
  assert.doesNotMatch(stdout, /ignored\.txt/);
  assert.doesNotMatch(stdout, /\.git\//);

  await rm(dir, { recursive: true, force: true });
  await rm(tmp, { recursive: true, force: true });
});

test('packageSourceDirectory falls back to plain tar for a non-git directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'faravan-submit-plain-'));
  await writeFile(join(dir, 'plain.txt'), 'plain content\n');
  const artifact = await packageSourceDirectory(dir);
  assert.equal(artifact.method, 'tar');
  assert.equal(createHash('sha256').update(artifact.buffer).digest('hex'), artifact.sha256);
  await rm(dir, { recursive: true, force: true });
});

test('packageSourceDirectory rejects a non-directory path', async () => {
  await assert.rejects(() => packageSourceDirectory('/definitely/does/not/exist'), SubmitError);
});


test('metadata roots are rejected before Git or plain packaging, even with misleading config', async t => {
  const dir=await makeGitRepo();t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const allowGit of [true,false])
    await assert.rejects(()=>packageSourceDirectory(join(dir,'.git'),{allowGit}),/Git metadata.*source/i);
});


test('ordinary source directories named config, objects and HEAD remain source', async t => {
  const dir=await mkdtemp(join(tmpdir(),'faravan-source-names-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const name of ['config','objects','HEAD']) {await mkdir(join(dir,name));await writeFile(join(dir,name,'source.js'),'ordinary source');}
  assert.equal((await packageSourceDirectory(dir,{allowGit:false})).method,'tar');
});


test('committed packaging does not traverse unreadable untracked directories', async t => {
  const dir=await makeGitRepo(), locked=join(dir,'untracked-volume');
  await mkdir(locked);await chmod(locked,0);
  t.after(async()=>{await chmod(locked,0o700);await rm(dir,{recursive:true,force:true});});
  assert.equal((await packageSourceDirectory(dir)).method,'git-archive');
});

test('committed binary bytes survive packaging and missing Git objects do not fall back to a working-tree tar', async t => {
  const dir = await makeGitRepo();
  t.after(() => rm(dir, {recursive:true, force:true}));
  const bytes = Buffer.from([0, 255, 128, 42, 10]);
  await writeFile(join(dir, 'binary.dat'), bytes);
  await execFileAsync('git', ['-C', dir, 'add', 'binary.dat']);
  await execFileAsync('git', ['-C', dir, 'commit', '-q', '-m', 'binary']);
  const {readArchiveEntries} = await import('../lib/archive.mjs');
  const artifact = await packageSourceDirectory(dir);
  assert.deepEqual(readArchiveEntries(artifact.buffer).find(entry => entry.name === 'binary.dat').data, bytes);
  const {stdout} = await execFileAsync('git', ['-C', dir, 'rev-parse', 'HEAD^{tree}']);
  const oid = stdout.trim();
  await rm(join(dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
  await assert.rejects(() => packageSourceDirectory(dir));
});
