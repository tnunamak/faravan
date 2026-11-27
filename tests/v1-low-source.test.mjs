import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageSourceDirectory } from '../lib/source-package.mjs';
import { fixture, parseOne } from './helpers/v1-journey.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {encoding: 'utf8'});
const listing = async (buffer) => {
  const dir = await mkdtemp(join(tmpdir(), 'faravan-low-list-')), file = join(dir, 'a.tar');
  await writeFile(file, buffer);
  const out = execFileSync('tar', ['-tf', file], {encoding: 'utf8'});
  await rm(dir, {recursive: true, force: true});
  return out;
};
async function repo(t) {
  const dir = await mkdtemp(join(tmpdir(), 'faravan-low-repo-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  git(dir, 'init', '-q'); await writeFile(join(dir, 'tracked.txt'), 'tracked\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'init');
  return dir;
}

test('L1: an untracked directory inside a git work tree is packaged with tar, not as an empty git archive', async t => {
  const dir = await repo(t);
  const inner = join(dir, 'uploads', 'x'); await mkdir(inner, {recursive: true});
  await writeFile(join(inner, 'a.txt'), 'uploaded\n');
  const artifact = await packageSourceDirectory(inner);
  assert.equal(artifact.method, 'tar');
  assert.match(await listing(artifact.buffer), /a\.txt/);
  assert.equal(artifact.uncommitted, undefined);
});

test('L1: a git source reports uncommitted and untracked paths instead of dropping them silently', async t => {
  const dir = await repo(t);
  await writeFile(join(dir, 'tracked.txt'), 'changed\n'); await writeFile(join(dir, 'new.txt'), 'new\n');
  const artifact = await packageSourceDirectory(dir);
  assert.equal(artifact.method, 'git-archive');
  assert.deepEqual([...artifact.uncommitted].sort(), ['new.txt', 'tracked.txt']);
  const clean = await repo(t);
  assert.deepEqual((await packageSourceDirectory(clean)).uncommitted, []);
});

test('L1: job submit --source warns on stderr (and in --json) about uncommitted work', async t => {
  const f = await fixture(t);
  await f.provisionFromHome('owner');
  const made = await f.cli(['circle', 'create', f.origin, '--name', 'Synthetic circle'], 'owner');
  assert.equal(made.code, 0, made.stderr);
  const circle = [...f.circles.keys()].at(-1), dir = await repo(t);
  await writeFile(join(dir, 'wip.txt'), 'wip\n');
  const human = await f.cli(['job', 'submit', '--yes', '--source', dir, '--prompt', 'p', '--circle', circle]);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stderr, /Uncommitted changes are NOT included.*wip\.txt/);
  const machine = parseOne(await f.cli(['job', 'submit', '--yes', '--source', dir, '--prompt', 'p2', '--circle', circle, '--json']));
  assert.match(machine.warnings[0], /wip\.txt/);
});
