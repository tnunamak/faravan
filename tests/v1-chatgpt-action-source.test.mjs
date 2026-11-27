import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareChatgptSource, ChatgptSourceError } from '../lib/v1/chatgpt-action-source.mjs';
import { extractArchive } from '../lib/archive.mjs';
import {inspectRepo} from '../lib/v1/repo-source.mjs';
import { filterSourceArchive } from '../lib/source-filter.mjs';

const GIT_ENV = {...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t'};
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], {env: GIT_ENV, encoding: 'utf8'});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const scratch = async t => { const d = await mkdtemp(join(tmpdir(), 'faravan-source-test-')); t.after(() => rm(d, {recursive: true, force: true})); return d; };
const home = async t => { const d = await scratch(t); await mkdir(join(d, 'v1'), {mode: 0o700}); return d; };
const leftovers = async h => (await readdir(join(h, 'v1'))).filter(n => n.startsWith('chatgpt-source'));

for(const name of ['x=y','x\u2028y','x\u2029y']) for(const mode of ['inspection','preparation']) test('Unsafe Git filter '+JSON.stringify(name)+' cannot execute during '+mode,async t=>{
  const h=await home(t),repo=await makeRepo(t,{'a.txt':'a\n'}),markers=await scratch(t),marker=join(markers,'ran');
  git(repo,'config','filter.'+name+'.clean','touch '+marker+'; cat');
  await writeFile(join(repo,'.git/info/attributes'),'a.txt filter='+name+'\n');
  await writeFile(join(repo,'a.txt'),'b\n');
  await utimes(join(repo,'a.txt'),new Date(Date.now()+2000),new Date(Date.now()+2000));
  let prepared;
  try {prepared=await (mode==='inspection'?inspectRepo(repo):prepareChatgptSource({repo:{path:repo}},{home:h}));} catch { /* refusal is safe */ }
  await prepared?.cleanup?.();
  assert.deepEqual(await readdir(markers),[],'a configured command ran before local approval');
});
async function makeRepo(t, files = {'README.md': 'hello\n', 'src/a.js': 'export const a = 1;\n'}) {
  const dir = await scratch(t);
  git(dir, 'init', '-q', '-b', 'main');
  for (const [p, c] of Object.entries(files)) { await mkdir(join(dir, p, '..'), {recursive: true}); await writeFile(join(dir, p), c); }
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'one');
  return dir;
}
// What the executor would package: the canonical filtered source archive.
async function executionTree(repoPath) {
  const tar = execFileSync('git', ['-C', repoPath, 'archive', '--format=tar', 'HEAD'], {env: GIT_ENV, maxBuffer: 64 * 1024 * 1024});
  const out = await mkdtemp(join(tmpdir(), 'faravan-exec-'));
  await extractArchive(filterSourceArchive(tar).buffer, out, {preserveExecutable: true, allowGit: false});
  const tree = {};
  const walk = async (rel) => {
    for (const e of await readdir(join(out, rel), {withFileTypes: true})) {
      const p = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) await walk(p);
      else tree[p] = {sha256: sha(await readFile(join(out, p))), exec: ((await stat(join(out, p))).mode & 0o111) !== 0};
    }
  };
  await walk('');
  await rm(out, {recursive: true, force: true});
  return tree;
}

test('files: preview carries path, hash, size and exact text; input is cloned', async t => {
  const h = await home(t);
  const text = 'print("hi")\n', bin = Buffer.from([0, 1, 2, 255]);
  const input = {circle: 'Friends', prompt: 'p', files: [{path: 'a.py', base64: Buffer.from(text).toString('base64')}, {path: 'b.bin', base64: bin.toString('base64')}]};
  const before = structuredClone(input);
  const r = await prepareChatgptSource(input, {home: h});
  assert.deepEqual(r.input, input); assert.notEqual(r.input, input); assert.notEqual(r.input.files[0], input.files[0]);
  assert.deepEqual(input, before, 'caller input untouched');
  r.input.files[0].base64 = 'AAAA'; assert.equal(input.files[0].base64, before.files[0].base64);
  assert.equal(r.details.type, 'files');
  assert.deepEqual(r.details.files.map(f => [f.path, f.sha256, f.bytes, f.text]),
    [['a.py', sha(text), text.length, text], ['b.bin', sha(bin), 4, null]]);
  assert.equal(r.details.files[1].binary, true);
  await r.cleanup();
});

test('files: unsafe paths, bad base64, duplicates and oversize are refused', async t => {
  const h = await home(t);
  const ok = Buffer.from('x').toString('base64');
  for (const path of ['../x', '/etc/passwd', 'a/../../b', '.git/config', 'sub/.GIT/hooks/x', 'a\\b', 'a\0b', '']) {
    await assert.rejects(prepareChatgptSource({files: [{path, base64: ok}]}, {home: h}), e => e instanceof ChatgptSourceError && e.code === 'invalid_source', path);
  }
  await assert.rejects(prepareChatgptSource({files: [{path: 'a', base64: '***'}]}, {home: h}), {code: 'invalid_source'});
  await assert.rejects(prepareChatgptSource({files: [{path: 'a', base64: ok}, {path: 'A', base64: ok}]}, {home: h}), {code: 'invalid_source'});
  const big = Buffer.alloc(21 * 1024 * 1024).toString('base64');
  await assert.rejects(prepareChatgptSource({files: [{path: 'big', base64: big}]}, {home: h}), {code: 'too_large'});
});

test('git url: preview shows url and pinned commit; unpinned or credentialed urls are refused', async t => {
  const h = await home(t);
  const commit = 'a'.repeat(40);
  const input = {git: {url: 'https://github.com/o/r.git', commit}, prompt: 'p'};
  const r = await prepareChatgptSource(input, {home: h});
  assert.deepEqual(r.details.git, {url: 'https://github.com/o/r.git', commit}); assert.equal(r.details.type, 'git');
  assert.deepEqual(r.input, input); assert.notEqual(r.input.git, input.git);
  for (const git of [{url: 'https://github.com/o/r.git'}, {url: 'https://github.com/o/r.git', commit: 'main'},
    {url: 'http://github.com/o/r.git', commit}, {url: 'https://user:pw@github.com/o/r.git', commit}, {url: 'ssh://x/y', commit}, {url: 'https://github.com/o/r.git', commit: 'A'.repeat(40)}]) {
    await assert.rejects(prepareChatgptSource({git}, {home: h}), {code: 'invalid_source'}, JSON.stringify(git));
  }
});

test('prompt only and conflicting sources', async t => {
  const h = await home(t);
  const r = await prepareChatgptSource({prompt: 'p'}, {home: h});
  assert.equal(r.details.type, 'none'); assert.deepEqual(r.input, {prompt: 'p'});
  await assert.rejects(prepareChatgptSource({files: [], git: {url: 'https://x/y', commit: 'a'.repeat(40)}}, {home: h}), {code: 'invalid_source'});
});

test('repo: the approved snapshot cannot be swapped by later changes to the original', async t => {
  const h = await home(t), repo = await makeRepo(t);
  const headBefore = git(repo, 'rev-parse', 'HEAD').trim();
  const r = await prepareChatgptSource({prompt: 'p', repo: {path: repo}}, {home: h});
  assert.equal(r.details.type, 'repo');
  assert.equal(r.details.repo.original_head, headBefore); assert.equal(r.details.repo.original_path, repo);
  assert.notEqual(r.input.repo.path, repo); assert.ok(r.input.repo.path.startsWith(join(h, 'v1')));
  assert.equal(r.input.repo.includeUncommitted, undefined);
  const approved = Object.fromEntries(r.details.files.map(f => [f.path, f.sha256]));
  assert.deepEqual(approved, {'README.md': sha('hello\n'), 'src/a.js': sha('export const a = 1;\n')});
  assert.equal(r.details.files.find(f => f.path === 'src/a.js').text, 'export const a = 1;\n');
  const exec1 = await executionTree(r.input.repo.path);
  assert.deepEqual(Object.fromEntries(Object.entries(exec1).map(([p, v]) => [p, v.sha256])), approved);
  // The attacker moves HEAD, rewrites the working tree and adds a file.
  await writeFile(join(repo, 'src/a.js'), 'steal();\n'); await writeFile(join(repo, 'evil.sh'), 'x');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'swap');
  await writeFile(join(repo, 'README.md'), 'worktree swap\n');
  assert.deepEqual(await executionTree(r.input.repo.path), exec1);
  assert.equal(git(r.input.repo.path, 'rev-parse', 'HEAD').trim(), r.details.repo.snapshot_commit);
  await r.cleanup();
});

test('repo: executable modes are preserved and shown', async t => {
  const h = await home(t), repo = await makeRepo(t, {'run.sh': '#!/bin/sh\necho hi\n', 'plain.txt': 'x\n'});
  await chmod(join(repo, 'run.sh'), 0o755); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'exec');
  const r = await prepareChatgptSource({repo: {path: repo}}, {home: h});
  assert.equal(r.details.files.find(f => f.path === 'run.sh').executable, true);
  assert.equal(r.details.files.find(f => f.path === 'plain.txt').executable, false);
  const tree = await executionTree(r.input.repo.path);
  assert.equal(tree['run.sh'].exec, true); assert.equal(tree['plain.txt'].exec, false);
  await r.cleanup();
});

test('repo: source_hash is stable for equal bytes and changes with content or mode', async t => {
  const h = await home(t), repo = await makeRepo(t);
  const a = await prepareChatgptSource({repo: {path: repo}}, {home: h}), b = await prepareChatgptSource({repo: {path: repo}}, {home: h});
  assert.match(a.details.repo.source_hash, /^[0-9a-f]{64}$/);
  assert.equal(a.details.repo.source_hash, b.details.repo.source_hash);
  assert.equal(a.details.repo.snapshot_commit, b.details.repo.snapshot_commit, 'fixed author and date: same bytes, same commit');
  await writeFile(join(repo, 'README.md'), 'changed\n'); git(repo, 'commit', '-qam', 'c');
  const c = await prepareChatgptSource({repo: {path: repo}}, {home: h});
  assert.notEqual(a.details.repo.source_hash, c.details.repo.source_hash);
  await Promise.all([a, b, c].map(x => x.cleanup()));
});

test('repo: uncommitted files are listed, not sent, unless includeUncommitted is set', async t => {
  const h = await home(t), repo = await makeRepo(t);
  await writeFile(join(repo, '.gitignore'), 'ignored.txt\n'); git(repo, 'add', '.gitignore'); git(repo, 'commit', '-qm', 'ig');
  await writeFile(join(repo, 'README.md'), 'edited\n'); await writeFile(join(repo, 'new.txt'), 'new\n'); await writeFile(join(repo, 'ignored.txt'), 'nope\n');
  const off = await prepareChatgptSource({repo: {path: repo}}, {home: h});
  assert.equal(off.details.repo.include_uncommitted, false);
  assert.deepEqual(off.details.repo.uncommitted_not_sent.sort(), ['README.md', 'new.txt']);
  assert.equal(off.details.files.find(f => f.path === 'README.md').sha256, sha('hello\n'));
  assert.equal(off.details.files.some(f => f.path === 'new.txt'), false);
  const on = await prepareChatgptSource({repo: {path: repo, includeUncommitted: true}}, {home: h});
  assert.equal(on.details.repo.include_uncommitted, true);
  const byPath = Object.fromEntries(on.details.files.map(f => [f.path, f]));
  assert.equal(byPath['README.md'].sha256, sha('edited\n')); assert.equal(byPath['new.txt'].text, 'new\n');
  assert.equal(byPath['ignored.txt'], undefined);
  const tree = await executionTree(on.input.repo.path);
  assert.equal(tree['README.md'].sha256, sha('edited\n')); assert.equal(tree['new.txt'].sha256, sha('new\n')); assert.equal(tree['ignored.txt'], undefined);
  await writeFile(join(repo, 'README.md'), 'swapped after approval\n');
  assert.equal((await executionTree(on.input.repo.path))['README.md'].sha256, sha('edited\n'));
  await off.cleanup(); await on.cleanup();
});

test('repo: working-tree mode drops deleted files, keeps CRLF bytes and executable bit', async t => {
  const h = await home(t), repo = await makeRepo(t, {'gone.txt': 'x\n', 'crlf.txt': 'a\n'});
  await rm(join(repo, 'gone.txt')); await writeFile(join(repo, 'crlf.txt'), 'a\r\nb\r\n');
  await writeFile(join(repo, '.gitattributes'), '* text=auto eol=lf\n');
  await writeFile(join(repo, 'tool.sh'), '#!/bin/sh\n'); await chmod(join(repo, 'tool.sh'), 0o755);
  const r = await prepareChatgptSource({repo: {path: repo, includeUncommitted: true}}, {home: h});
  const by = Object.fromEntries(r.details.files.map(f => [f.path, f]));
  assert.equal(by['gone.txt'], undefined);
  assert.equal(by['crlf.txt'].sha256, sha('a\r\nb\r\n'), 'attributes never rewrite approved bytes');
  assert.equal(by['tool.sh'].executable, true);
  const tree = await executionTree(r.input.repo.path);
  assert.equal(tree['crlf.txt'].sha256, sha('a\r\nb\r\n')); assert.equal(tree['tool.sh'].exec, true);
  await r.cleanup();
});

test('repo: symlinks are omitted and listed; nothing outside the repo is read', async t => {
  const h = await home(t), repo = await makeRepo(t), outside = await scratch(t);
  await writeFile(join(outside, 'secret.txt'), 'TOP SECRET');
  await symlink(join(outside, 'secret.txt'), join(repo, 'link.txt'));
  await symlink(outside, join(repo, 'dirlink'));
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'links');
  for (const includeUncommitted of [false, true]) {
    const r = await prepareChatgptSource({repo: {path: repo, includeUncommitted}}, {home: h});
    assert.deepEqual(r.details.files.map(f => f.path).sort(), ['README.md', 'src/a.js']);
    assert.deepEqual(r.details.repo.omitted.map(o => o.path).sort(), ['dirlink', 'link.txt']);
    assert.ok(r.details.repo.omitted.every(o => o.reason === 'symlink'));
    assert.equal(JSON.stringify(r.details).includes('TOP SECRET'), false);
    assert.equal(Object.keys(await executionTree(r.input.repo.path)).some(p => p.includes('link')), false);
    await r.cleanup();
  }
});

test('repo: a path swapped for a symlink to a directory elsewhere is not followed (working tree)', async t => {
  const h = await home(t), repo = await makeRepo(t, {'d/x.txt': 'inside\n', 'keep.txt': 'k\n'}), outside = await scratch(t);
  await writeFile(join(outside, 'x.txt'), 'OUTSIDE');
  await rm(join(repo, 'd'), {recursive: true}); await symlink(outside, join(repo, 'd'));
  const r = await prepareChatgptSource({repo: {path: repo, includeUncommitted: true}}, {home: h});
  assert.equal(JSON.stringify(r.details).includes('OUTSIDE'), false);
  assert.equal(JSON.stringify(await executionTree(r.input.repo.path)).includes(sha('OUTSIDE')), false);
  await r.cleanup();
});

test('repo: hostile .git config and hooks never run, and nothing of .git reaches the snapshot', async t => {
  const h = await home(t), repo = await makeRepo(t, {'a.txt': 'a\n', '.gitattributes': '* filter=pwn\n'});
  const marker = join(await scratch(t), 'ran');
  const cfg = join(repo, '.git/config');
  await writeFile(cfg, (await readFile(cfg, 'utf8')) +
    `[filter "pwn"]\n\tsmudge = touch ${marker}-smudge\n\tclean = touch ${marker}-clean\n\tprocess = touch ${marker}-process\n\trequired = true\n` +
    `[core]\n\tfsmonitor = touch ${marker}-fsmonitor\n\thooksPath = ${join(repo, 'hooks')}\n` +
    `[remote "origin"]\n\turl = https://user:SECRETTOKEN@example.com/r.git\n`);
  await mkdir(join(repo, 'hooks'));
  for (const hook of ['post-checkout', 'post-commit', 'pre-commit', 'reference-transaction']) {
    await writeFile(join(repo, 'hooks', hook), `#!/bin/sh\ntouch ${marker}-${hook}\n`); await chmod(join(repo, 'hooks', hook), 0o755);
  }
  await writeFile(join(repo, 'dirty.txt'), 'd\n');
  for (const includeUncommitted of [false, true]) {
    const r = await prepareChatgptSource({repo: {path: repo, includeUncommitted}}, {home: h});
    const parent = join(marker, '..');
    assert.deepEqual((await readdir(parent)).filter(n => n.startsWith('ran')), [], 'no hostile command executed');
    const snap = r.input.repo.path;
    const config = await readFile(join(snap, '.git/config'), 'utf8');
    assert.equal(/SECRETTOKEN|pwn|fsmonitor|hooksPath|remote/.test(config), false);
    assert.equal(JSON.stringify(r.details).includes('SECRETTOKEN'), false);
    const hooks = await readdir(join(snap, '.git/hooks')).catch(() => []);
    assert.deepEqual(hooks.filter(n => !n.endsWith('.sample')), []);
    assert.equal(git(snap, 'rev-list', '--count', 'HEAD').trim(), '1');
    assert.equal(git(snap, 'log', '-1', '--format=%an <%ae> %G?').trim().endsWith('N'), true, 'commit is unsigned');
    assert.equal(Object.keys(await executionTree(snap)).some(p => p.startsWith('.git/') || p === '.git'), false);
    await r.cleanup();
  }
});

test('repo: private directory, cleanup, and failures leave nothing behind', async t => {
  const h = await home(t), repo = await makeRepo(t);
  const r = await prepareChatgptSource({repo: {path: repo}}, {home: h});
  const root = r.input.repo.path;
  assert.equal((await readdir(join(h, 'v1'))).filter(n => n.startsWith('chatgpt-source')).length, 1);
  const dir = join(h, 'v1', (await leftovers(h))[0]);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  await r.cleanup(); await r.cleanup();
  assert.deepEqual(await leftovers(h), []);
  await assert.rejects(lstat(root), {code: 'ENOENT'});
  // failures: not a repo, no commits, too many files, too large
  const plain = await scratch(t);
  await assert.rejects(prepareChatgptSource({repo: {path: plain}}, {home: h}), e => e instanceof ChatgptSourceError);
  const empty = await scratch(t); git(empty, 'init', '-q', '-b', 'main');
  await assert.rejects(prepareChatgptSource({repo: {path: empty}}, {home: h}), e => e instanceof ChatgptSourceError);
  assert.deepEqual(await leftovers(h), []);
});

test('repo: more than 1000 files and more than 20 MiB are refused with bounded errors, both modes', async t => {
  const h = await home(t);
  const many = await makeRepo(t);
  await mkdir(join(many, 'm'));
  for (let i = 0; i < 1001; i++) await writeFile(join(many, 'm', 'f' + i), String(i));
  git(many, 'add', '-A'); git(many, 'commit', '-qm', 'many');
  const big = await makeRepo(t);
  await writeFile(join(big, 'big.bin'), Buffer.alloc(21 * 1024 * 1024, 7)); git(big, 'add', '-A'); git(big, 'commit', '-qm', 'big');
  const dirty = await makeRepo(t);
  for (const repo of [many, big]) for (const includeUncommitted of [false, true]) {
    await assert.rejects(prepareChatgptSource({repo: {path: repo, includeUncommitted}}, {home: h}),
      e => e instanceof ChatgptSourceError && e.code === 'too_large' && e.message.length < 300, repo + includeUncommitted);
    assert.deepEqual(await leftovers(h), []);
  }
  await writeFile(join(dirty, 'huge.bin'), Buffer.alloc(21 * 1024 * 1024, 1));
  await assert.rejects(prepareChatgptSource({repo: {path: dirty, includeUncommitted: true}}, {home: h}), {code: 'too_large'});
  assert.deepEqual(await leftovers(h), []);
});

test('repo: preparing a preview does not modify the original repository or the input', async t => {
  const h = await home(t), repo = await makeRepo(t);
  await writeFile(join(repo, 'dirty.txt'), 'd\n');
  const snapshot = () => ({status: git(repo, 'status', '--porcelain', '--untracked-files=all'), head: git(repo, 'rev-parse', 'HEAD'),
    refs: git(repo, 'for-each-ref'), top: execFileSync('ls', ['-A', repo]).toString(), cfg: execFileSync('cat', [join(repo, '.git/config')]).toString()});
  const before = snapshot(), input = {repo: {path: repo, includeUncommitted: true}, prompt: 'p'}, inputBefore = structuredClone(input);
  const r = await prepareChatgptSource(input, {home: h});
  assert.deepEqual(snapshot(), before); assert.deepEqual(input, inputBefore);
  await r.cleanup();
});

test('repo: text previews flag hidden characters and omit oversized text', async t => {
  const h = await home(t);
  const repo = await makeRepo(t, {'sneaky.js': 'const x = 1;‮ // evil\n', 'blob.txt': 'a'.repeat(2 * 1024 * 1024)});
  const r = await prepareChatgptSource({repo: {path: repo}}, {home: h});
  const by = Object.fromEntries(r.details.files.map(f => [f.path, f]));
  assert.equal(by['sneaky.js'].hidden_characters, true); assert.equal(by['sneaky.js'].text, 'const x = 1;‮ // evil\n');
  assert.equal(by['blob.txt'].text, null); assert.equal(by['blob.txt'].text_omitted, 'too_large'); assert.equal(by['blob.txt'].bytes, 2 * 1024 * 1024);
  await r.cleanup();
});

// ---- review repairs -----------------------------------------------------------------------------------------

async function namedRepo(t, name, files = {'a.txt': 'a\n', 'src/b.js': 'b\n'}) {
  const parent = await scratch(t), dir = join(parent, name);
  await mkdir(dir);
  git(dir, 'init', '-q', '-b', 'main');
  for (const [p, c] of Object.entries(files)) { await mkdir(join(dir, p, '..'), {recursive: true}); await writeFile(join(dir, p), c); }
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'one');
  return dir;
}

test('repo: a folder named like our scratch directories (verify, view.git, snapshot) is sent as itself', async t => {
  const h = await home(t);
  for (const name of ['verify', 'view.git', 'snapshot', '.git']) for (const includeUncommitted of [false, true]) {
    if (name === '.git') continue;
    const repo = await namedRepo(t, name);
    const r = await prepareChatgptSource({repo: {path: repo, includeUncommitted}}, {home: h});
    assert.deepEqual(r.details.files.map(f => f.path), ['a.txt', 'src/b.js'], name);
    assert.equal(r.details.repo.name, name);
    assert.deepEqual(Object.keys(await executionTree(r.input.repo.path)).sort(), ['a.txt', 'src/b.js'], name);
    await r.cleanup();
  }
});

async function hostileFilterConfig(dir, marker) {
  const body = `[filter "pwn"]\n\tsmudge = touch ${marker}-smudge\n\tclean = touch ${marker}-clean\n\tprocess = touch ${marker}-process\n`;
  await writeFile(join(dir, 'filters.cfg'), body);
  return body;
}

test('repo: filter drivers defined in an included config file never run (local include and global config)', async t => {
  const h = await home(t), markers = await scratch(t), marker = join(markers, 'ran');
  for (const where of ['include', 'global']) {
    const repo = await makeRepo(t, {'a.txt': 'a\n', '.gitattributes': 'a.txt filter=pwn\n'});
    const cfgDir = await scratch(t);
    await hostileFilterConfig(cfgDir, marker + '-' + where);
    const old = process.env.GIT_CONFIG_GLOBAL;
    if (where === 'include') await writeFile(join(repo, '.git/config'), (await readFile(join(repo, '.git/config'), 'utf8')) + `[include]\n\tpath = ${join(cfgDir, 'filters.cfg')}\n`);
    else process.env.GIT_CONFIG_GLOBAL = join(cfgDir, 'filters.cfg');
    t.after(() => { if (old === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = old; });
    // Same size, different bytes: git must compare content, which is when it runs a clean filter.
    await writeFile(join(repo, 'a.txt'), 'b\n');
    for (const includeUncommitted of [false, true]) {
      const r = await prepareChatgptSource({repo: {path: repo, includeUncommitted}}, {home: h});
      await r.cleanup();
    }
    if (where === 'global') { if (old === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = old; }
    assert.deepEqual((await readdir(markers)).filter(n => n.includes(where)), [], where + ' config ran a command');
  }
});

test('repo: a submodule with a hostile fsmonitor is not entered by the preview', async t => {
  const h = await home(t), markers = await scratch(t), marker = join(markers, 'ran-sub');
  const repo = await makeRepo(t);
  const sub = join(repo, 'sub');
  await mkdir(sub); git(sub, 'init', '-q', '-b', 'main'); await writeFile(join(sub, 'f'), 'x'); git(sub, 'add', '.'); git(sub, 'commit', '-qm', 's');
  const subHead = git(sub, 'rev-parse', 'HEAD').trim();
  git(repo, 'update-index', '--add', '--cacheinfo', `160000,${subHead},sub`);
  await writeFile(join(repo, '.gitmodules'), '[submodule "sub"]\n\tpath = sub\n\turl = https://example.invalid/sub.git\n');
  git(repo, 'add', '.gitmodules'); git(repo, 'commit', '-qm', 'sub');
  await writeFile(join(sub, '.git/config'), (await readFile(join(sub, '.git/config'), 'utf8')) + `[core]\n\tfsmonitor = touch ${marker}\n`);
  await writeFile(join(sub, 'f'), 'dirty');
  for (const includeUncommitted of [false, true]) {
    const r = await prepareChatgptSource({repo: {path: repo, includeUncommitted}}, {home: h});
    assert.equal(r.details.files.some(f => f.path.startsWith('sub/')), false);
    await r.cleanup();
  }
  assert.deepEqual(await readdir(markers), []);
});

test('files: credential files are omitted from the preview and from what executes', async t => {
  const h = await home(t), b64 = s => Buffer.from(s).toString('base64');
  const input = {prompt: 'p', files: [{path: 'app.js', base64: b64('x')}, {path: '.env', base64: b64('KEY=1')}, {path: 'cfg/.npmrc', base64: b64('t')},
    {path: 'k/server.pem', base64: b64('pem')}, {path: 'node_modules/x/i.js', base64: b64('n')}]};
  const r = await prepareChatgptSource(input, {home: h});
  assert.deepEqual(r.details.files.map(f => f.path), ['app.js']);
  assert.deepEqual(r.details.excluded.sort(), ['.env', 'cfg/.npmrc', 'k/server.pem', 'node_modules/x/i.js']);
  assert.deepEqual(r.input.files.map(f => f.path), ['app.js']);
  assert.equal(input.files.length, 5, 'caller input untouched');
  await assert.rejects(prepareChatgptSource({files: [{path: '.env', base64: b64('K=1')}]}, {home: h}), {code: 'empty_source'});
});

test('repo: credential files are omitted and listed in both modes, never sent', async t => {
  const h = await home(t);
  const repo = await makeRepo(t, {'a.txt': 'a\n', '.env': 'TOKEN=SECRETVALUE\n', 'keys/server.pem': 'PEMSECRET\n', '.ssh/config': 'SSHSECRET\n'});
  await writeFile(join(repo, '.env.local'), 'LOCALSECRET\n'); await writeFile(join(repo, 'b.txt'), 'b\n');
  for (const includeUncommitted of [false, true]) {
    const r = await prepareChatgptSource({repo: {path: repo, includeUncommitted}}, {home: h});
    const shown = JSON.stringify(r.details);
    for (const s of ['SECRETVALUE', 'PEMSECRET', 'SSHSECRET', 'LOCALSECRET']) assert.equal(shown.includes(s), false, s);
    const omitted = r.details.repo.omitted.filter(o => o.reason === 'secret_file').map(o => o.path).sort();
    assert.deepEqual(omitted, includeUncommitted ? ['.env', '.env.local', '.ssh/config', 'keys/server.pem'] : ['.env', '.ssh/config', 'keys/server.pem']);
    const tree = Object.keys(await executionTree(r.input.repo.path));
    assert.equal(tree.some(p => /env|pem|ssh/.test(p)), false);
    await r.cleanup();
  }
});

test('abort: a cancelled signal stops preparation, rejects as aborted and leaves nothing behind', async t => {
  const h = await home(t), repo = await makeRepo(t);
  const pre = AbortSignal.abort();
  await assert.rejects(prepareChatgptSource({repo: {path: repo}}, {home: h, signal: pre}), {code: 'aborted'});
  await assert.rejects(prepareChatgptSource({files: [{path: 'a', base64: 'AAAA'}]}, {home: h, signal: pre}), {code: 'aborted'});
  assert.deepEqual(await leftovers(h), []);
  for (const includeUncommitted of [false, true]) for (const delay of [0, 15, 40]) {
    const c = new AbortController(), started = prepareChatgptSource({repo: {path: repo, includeUncommitted}}, {home: h, signal: c.signal});
    setTimeout(() => c.abort(), delay);
    const outcome = await started.then(r => r, e => e);
    if (outcome instanceof Error) assert.equal(outcome.code, 'aborted');
    else await outcome.cleanup();
    assert.deepEqual(await leftovers(h), [], 'delay ' + delay);
  }
});

test('renamed Git history is excluded from explicit ChatGPT source files', async t => {
 const h=await home(t),bundle=Buffer.from('# v2 git bundle\nsynthetic history');
 const prepared=await prepareChatgptSource({circle:'Friends',prompt:'p',files:[{path:'notes.bin',base64:bundle.toString('base64')},{path:'main.js',base64:Buffer.from('ok').toString('base64')}]},{home:h});
 t.after(()=>prepared.cleanup());
 assert.deepEqual(prepared.details.excluded,['notes.bin']);
 assert.deepEqual(prepared.details.files.map(f=>f.path),['main.js']);
});

for (const includeUncommitted of [false, true]) {
 test(`renamed Git history is omitted from repo approval and sent bytes (working tree: ${includeUncommitted})`, async t => {
  const h=await home(t),repo=await makeRepo(t,{'main.js':'ok','notes.bin':'# v2 git bundle\nsynthetic history','data.bin':Buffer.from('5041434b0000000200000000','hex')});
  const prepared=await prepareChatgptSource({repo:{path:repo,includeUncommitted}},{home:h});
  t.after(()=>prepared.cleanup());
  assert.deepEqual(prepared.details.files.map(f=>f.path),['main.js']);
  assert.deepEqual(prepared.details.repo.omitted.filter(f=>f.reason==='not_source').map(f=>f.path).sort(),['data.bin','notes.bin']);
  const sent=await executionTree(prepared.input.repo.path);
  assert.deepEqual(Object.keys(sent),prepared.details.files.map(f=>f.path));
  assert.equal(sent['main.js'].sha256,prepared.details.files[0].sha256);
 });
}

test('repo: isolated ChatGPT preparation ignores malicious include/filter/fsmonitor/remote configuration', async t => {
  const h = await home(t), markers = await scratch(t);
  const bytes = Buffer.from([0, 255, 128, 13, 10, 1]);
  const repo = await makeRepo(t, {'a.bin': bytes, '.gitattributes': '* filter=hostile\n', 'sub/b.txt': 'nested\n'});
  const cfg = join(markers, 'included.cfg'), marker = join(markers, 'executed');
  // A deliberately unenumerable filter key is inert inside the isolated helper.
  // The old ChatGPT path refuses it while reading executable repository config.
  await writeFile(cfg, '[filter "x=y"]\n clean = "touch '+marker+'; cat"\n' +
    '[filter "hostile"]\n clean = "touch '+marker+'; cat"\n smudge = "touch '+marker+'; cat"\n' +
    '[core]\n fsmonitor = "touch '+marker+'-monitor"\n' +
    '[remote "origin"]\n url = "ext::touch '+marker+'"\n promisor = true\n');
  git(repo, 'config', 'include.path', cfg);
  await writeFile(join(repo, 'a.bin'), Buffer.from([1, 2, 3]));
  const prepared = await prepareChatgptSource({repo: {path: join(repo, 'sub')}}, {home: h});
  t.after(() => prepared.cleanup());
  assert.deepEqual(prepared.details.files.map(f => f.path), ['.gitattributes', 'a.bin', 'sub/b.txt']);
  assert.equal(prepared.details.repo.original_path, repo);
  assert.equal(prepared.details.repo.branch, 'main');
  assert.deepEqual(prepared.details.repo.uncommitted_not_sent, ['a.bin']);
  const archived = execFileSync('git', ['-C', prepared.input.repo.path, 'show', 'HEAD:a.bin'], {env: GIT_ENV});
  assert.deepEqual(archived, bytes, 'archive and sealed snapshot preserve exact binary bytes');
  assert.deepEqual(await readdir(markers), ['included.cfg']);
  // Negative control: the same included filter really is executable outside the boundary.
  git(repo, '-c', 'core.fsmonitor=false', 'hash-object', '--path=a.bin', join(repo, 'a.bin'));
  assert.equal((await lstat(marker)).isFile(), true);
  await rm(marker);
  git(repo, 'status', '--porcelain', '--ignore-submodules=all');
  assert.equal((await lstat(marker+'-monitor')).isFile(), true, 'the configured fsmonitor sentinel is live');
});

test('repo: missing local objects never invoke a configured promisor remote', async t => {
  const h = await home(t), markers = await scratch(t);
  const repo = await makeRepo(t, {'local.txt': 'local object\n'});
  const blob = git(repo, 'rev-parse', 'HEAD:local.txt').trim();
  const marker = join(markers, 'transport');
  git(repo, 'config', 'remote.origin.url', 'ext::touch '+marker);
  git(repo, 'config', 'remote.origin.promisor', 'true');
  git(repo, 'config', 'extensions.partialClone', 'origin');
  git(repo, 'config', 'protocol.ext.allow', 'always');
  await rm(join(repo, '.git/objects', blob.slice(0, 2), blob.slice(2)));
  await assert.rejects(prepareChatgptSource({repo: {path: repo}}, {home: h}), {code: 'source_unreadable'});
  assert.deepEqual(await readdir(markers), []);
  assert.deepEqual(await leftovers(h), []);
  // Negative control uses only the local ext sentinel, never a network address.
  assert.throws(() => git(repo, '-c', 'protocol.ext.allow=always', 'ls-remote', 'ext::touch '+marker));
  assert.equal((await lstat(marker)).isFile(), true);
});

test('repo: committed source remains available when the index is empty', async t => {
  const h = await home(t), repo = await makeRepo(t, {'main.txt': 'committed bytes\n'});
  git(repo, 'rm', '--cached', 'main.txt');
  const prepared = await prepareChatgptSource({repo: {path: repo}}, {home: h});
  t.after(() => prepared.cleanup());
  assert.deepEqual(prepared.details.files.map(f => f.path), ['main.txt']);
  assert.equal(git(prepared.input.repo.path, 'show', 'HEAD:main.txt'), 'committed bytes\n');
});

test('repo: a nested starting path sends the whole filtered committed export', async t => {
  const h = await home(t);
  const binary = Buffer.from([0, 255, 128, 13, 10, 1]);
  const repo = await makeRepo(t, {
    '.gitattributes': 'docs/omitted.txt export-ignore\n',
    'docs/omitted.txt': 'ordinary draft omitted from Git export\n',
    'sibling.txt': 'committed sibling\n',
    'src/item.bin': binary,
  });
  await writeFile(join(repo, 'sibling.txt'), 'dirty working sibling\n');
  const prepared = await prepareChatgptSource({repo: {path: join(repo, 'src')}}, {home: h});
  t.after(() => prepared.cleanup());
  const expected = await executionTree(repo);
  assert.deepEqual(Object.keys(expected).sort(), ['.gitattributes', 'sibling.txt', 'src/item.bin']);
  assert.deepEqual(prepared.details.files.map(row => row.path).sort(), Object.keys(expected).sort());
  assert.deepEqual(await executionTree(prepared.input.repo.path), expected, 'approved and packaged names and bytes match the committed export');
  const snapshot = prepared.input.repo.path;
  assert.deepEqual(execFileSync('git', ['-C', snapshot, 'show', 'HEAD:src/item.bin'], {env: GIT_ENV}), binary);
  assert.equal(git(snapshot, 'show', 'HEAD:sibling.txt'), 'committed sibling\n');
});
