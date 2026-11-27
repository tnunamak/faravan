import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, chmod, stat, rm, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ArchiveError, DEFAULT_ARCHIVE_POLICY, validateArchive, extractArchive } from '../lib/archive.mjs';

const exec = promisify(execFile);
function header(name, { type = '0', size = 0, mode = 0o644, link = '' } = {}) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  const octal = (value, start, width) => h.write(value.toString(8).padStart(width - 1, '0') + '\0', start, width, 'ascii');
  octal(mode, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
  octal(size, 124, 12); octal(0, 136, 12);
  h.fill(32, 148, 156); h.write(type, 156, 1); h.write(link, 157, 100);
  h.write('ustar\0', 257, 6); h.write('00', 263, 2);
  const sum = h.reduce((a, b) => a + b, 0);
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}
function member(name, options = {}, content = '') {
  const data = Buffer.from(content);
  return Buffer.concat([header(name, { size: data.length, ...options }), data, Buffer.alloc((512 - data.length % 512) % 512)]);
}
const tar = (...parts) => Buffer.concat([...parts, Buffer.alloc(1024)]);
function paxRecord(key, value) {
  const body = key + '=' + value + '\n';
  let n = Buffer.byteLength(body) + 2;
  while (n !== Buffer.byteLength(body) + String(n).length + 1) n = Buffer.byteLength(body) + String(n).length + 1;
  return n + ' ' + body;
}
const rejects = (bytes, code, options) => assert.throws(() => validateArchive(bytes, options), (e) => e instanceof ArchiveError && e.code === code);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'faravan-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('archive defaults are bounded and callers can only tighten limits', () => {
  assert.equal(DEFAULT_ARCHIVE_POLICY.maxEntries, 100000);
  assert.equal(DEFAULT_ARCHIVE_POLICY.maxTotalBytes, 2 * 1024 ** 3);
  assert.equal(DEFAULT_ARCHIVE_POLICY.maxFileBytes, 1024 ** 3);
  assert.equal(DEFAULT_ARCHIVE_POLICY.maxPathLength, 4096);
  rejects(tar(), 'malformed', { maxEntries: Infinity });
  rejects(tar(), 'malformed', { maxFileBytes: DEFAULT_ARCHIVE_POLICY.maxFileBytes + 1 });
});

test('system tar normal tree round-trips, including nested directories and executable mode', async (t) => {
  const root = await fixture(t);
  const source = join(root, 'source'), dest = join(root, 'dest');
  await mkdir(join(source, 'nested'), { recursive: true });
  await writeFile(join(source, 'nested', 'hello.txt'), 'hello\n');
  await writeFile(join(source, 'run.sh'), '#!/bin/sh\nexit 0\n');
  await chmod(join(source, 'run.sh'), 0o755);
  const { stdout } = await exec('tar', ['-cf', '-', '-C', source, '.'], { encoding: 'buffer' });
  const summary = validateArchive(stdout);
  assert.deepEqual(await extractArchive(stdout, dest, { preserveExecutable: true }), summary);
  assert.equal(summary.bytes, Buffer.byteLength('hello\n#!/bin/sh\nexit 0\n'));
  assert.equal(await readFile(join(dest, 'nested', 'hello.txt'), 'utf8'), 'hello\n');
  assert.equal((await stat(join(dest, 'nested'))).mode & 0o7777, 0o755);
  assert.equal((await stat(join(dest, 'nested', 'hello.txt'))).mode & 0o7777, 0o644);
  assert.equal((await stat(join(dest, 'run.sh'))).mode & 0o7777, 0o755);
});

for (const type of ['1', '2']) {
  test('rejects ' + (type === '1' ? 'hardlinks' : 'symlinks') + ' even with an internal target', () => {
    rejects(tar(member('link', { type, link: 'safe.txt' })), 'link_rejected');
  });
}
for (const name of ['/absolute', '../outside', 'a/../outside', 'a/../../outside', 'C:/absolute', '\\\\server\\file']) {
  test('rejects unsafe archive path ' + JSON.stringify(name), () => rejects(tar(member(name)), 'path_traversal'));
}
for (const type of ['3', '4', '6', '7', 'S', 'Z']) {
  test('rejects device/FIFO/special/unknown type ' + type, () => rejects(tar(member('special', { type })), 'bad_entry_type'));
}

test('pax local and global path overrides are validated after applying metadata', () => {
  for (const type of ['x', 'g']) {
    rejects(tar(member('pax', { type }, paxRecord('path', '../escape')), member('innocent')), 'path_traversal');
    assert.deepEqual(validateArchive(tar(member('pax', { type }, paxRecord('path', 'nested/safe')), member('unused', {}, 'ok'))), { entries: 1, bytes: 2 });
  }
});
test('pax size and GNU long names use the same limits and path policy', async (t) => {
  const root = await fixture(t);
  const name = 'nested/' + 'a'.repeat(120);
  const bytes = tar(member('././@LongLink', { type: 'L' }, name + '\0'), member('short', {}, 'long name'));
  assert.deepEqual(await extractArchive(bytes, join(root, 'out')), { entries: 1, bytes: 9 });
  assert.equal(await readFile(join(root, 'out', name), 'utf8'), 'long name');
  rejects(tar(member('long', { type: 'L' }, '../escape\0'), member('safe')), 'path_traversal');
  rejects(tar(member('pax', { type: 'x' }, paxRecord('size', '9999')), member('safe')), 'too_large', { maxFileBytes: 10 });
  rejects(tar(member('pax', { type: 'x' }, paxRecord('GNU.sparse.map', '0,1')), member('safe')), 'bad_entry_type');
});
test('rejects too many entries, total/file declared sizes, and path length', () => {
  rejects(tar(member('a'), member('b')), 'too_large', { maxEntries: 1 });
  rejects(tar(member('a', {}, 'ab'), member('b', {}, 'cd')), 'too_large', { maxTotalBytes: 3 });
  rejects(tar(header('huge', { size: 1000 })), 'too_large', { maxFileBytes: 4 });
  rejects(tar(member('abcde')), 'too_large', { maxPathLength: 4 });
});
test('gzip input is bounded and round-trips', async (t) => {
  const root = await fixture(t);
  const bytes = gzipSync(tar(member('hello', {}, 'gzip')));
  assert.deepEqual(await extractArchive(bytes, join(root, 'out')), { entries: 1, bytes: 4 });
  assert.equal(await readFile(join(root, 'out', 'hello'), 'utf8'), 'gzip');
  rejects(bytes, 'too_large', { maxTotalBytes: 3 });
  rejects(gzipSync(Buffer.alloc(20000)), 'too_large', { maxTotalBytes: 0, maxEntries: 0 });
  rejects(bytes.subarray(0, bytes.length - 5), 'malformed');
});
test('rejects malformed checksums, truncation, embedded NUL, pax lengths and dangling metadata', () => {
  const bad = tar(member('ok'));
  bad[0] ^= 1;
  rejects(bad, 'malformed');
  rejects(tar(header('short', { size: 2048 })), 'malformed');
  rejects(tar(member('nul\0suffix')), 'malformed');
  rejects(tar(member('pax', { type: 'x' }, '99 path=foo\n'), member('ok')), 'malformed');
  rejects(tar(member('long', { type: 'L' }, 'foo\0')), 'malformed');
  rejects(member('unterminated'), 'malformed');
  rejects(Buffer.alloc(0), 'malformed');
  rejects(Buffer.concat([tar(member('ok')), Buffer.from('hidden')]), 'malformed');
});
test('rejects duplicate files and file/directory or ancestor collisions', () => {
  rejects(tar(member('a'), member('./a')), 'duplicate_entry');
  rejects(tar(member('a', { type: '5' }), member('a')), 'duplicate_entry');
  rejects(tar(member('a'), member('a', { type: '5' })), 'duplicate_entry');
  rejects(tar(member('a/b'), member('a')), 'duplicate_entry');
});
test('strips setuid, setgid and sticky and preserves only executable intent', async (t) => {
  const root = await fixture(t);
  await extractArchive(tar(member('exec', { mode: 0o7777 }, 'x'), member('plain', { mode: 0o7666 }, 'y'), member('dir', { type: '5', mode: 0o7777 })), root, { preserveExecutable: true });
  assert.equal((await stat(join(root, 'exec'))).mode & 0o7777, 0o755);
  assert.equal((await stat(join(root, 'plain'))).mode & 0o7777, 0o644);
  assert.equal((await stat(join(root, 'dir'))).mode & 0o7777, 0o755);
});
test('validates the whole archive before any destination creation or member write', async (t) => {
  const root = await fixture(t), dest = join(root, 'absent');
  await assert.rejects(extractArchive(tar(member('safe', {}, 'safe'), member('../outside')), dest), { code: 'path_traversal' });
  assert.deepEqual(await readdir(root), []);
});
test('never overwrites a pre-existing file or follows a pre-existing destination link', async (t) => {
  const root = await fixture(t), dest = join(root, 'dest'), outside = join(root, 'outside');
  await mkdir(dest); await mkdir(outside);
  await writeFile(join(dest, 'existing'), 'original');
  await assert.rejects(extractArchive(tar(member('existing', {}, 'replacement')), dest), { code: 'destination_conflict' });
  assert.equal(await readFile(join(dest, 'existing'), 'utf8'), 'original');
  await symlink(outside, join(dest, 'link'));
  await assert.rejects(extractArchive(tar(member('link/file', {}, 'data')), dest), { code: 'destination_conflict' });
  await symlink(outside, join(root, 'root-link'));
  await assert.rejects(extractArchive(tar(member('file')), join(root, 'root-link')), { code: 'destination_conflict' });
  assert.deepEqual(await readdir(outside), []);
});

test('pax local empty attributes cancel global overrides for one entry', () => {
  const bytes = tar(
    member('global', { type: 'g' }, paxRecord('path', '../unused-global')),
    member('local', { type: 'x' }, paxRecord('path', '')),
    member('safe', {}, 'ok'),
  );
  assert.deepEqual(validateArchive(bytes), { entries: 1, bytes: 2 });
});

test('results drop executable bits unless the caller opts in', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wf-archive-noexec-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await extractArchive(tar(member('run.sh', { mode: 0o755 }, '#!/bin/sh\n')), root);
  assert.equal((await stat(join(root, 'run.sh'))).mode & 0o7777, 0o644);
});

test('a .git path at any depth is rejected unless allowed', () => {
  for (const name of ['.git/config', 'sub/.git/hooks/post-checkout', 'a/.GIT/x']) {
    assert.throws(() => validateArchive(tar(member(name, {}, 'x'))), (error) => error instanceof ArchiveError && error.code === 'git_rejected', name);
  }
  assert.doesNotThrow(() => validateArchive(tar(member('.git/config', {}, 'x')), { allowGit: true }));
});

test('paths deeper than the limit and case or Unicode collisions are rejected', () => {
  const deep = Array.from({ length: 65 }, (_, i) => 'd' + i).join('/');
  assert.throws(() => validateArchive(tar(member('pax', { type: 'x' }, paxRecord('path', deep)), member('unused', {}, 'x'))), (error) => error.code === 'too_large');
  assert.throws(() => validateArchive(tar(member('README.md', {}, 'a'), member('readme.md', {}, 'b'))), (error) => error.code === 'duplicate_entry');
  assert.throws(() => validateArchive(tar(member('caf\u00e9.txt', {}, 'a'), member('cafe\u0301.txt', {}, 'b'))), (error) => error.code === 'duplicate_entry');
});

test('megabytes of zero padding after the end marker are rejected', () => {
  const padded = Buffer.concat([tar(member('a', {}, 'x')), Buffer.alloc(2 * 1024 * 1024)]);
  assert.throws(() => validateArchive(padded), (error) => error.code === 'too_large');
});

test('a required output root covers every regular file, directory and PAX-renamed entry before extraction',async t=>{
 const options={requiredRoot:'faravan-output'};
 validateArchive(tar(member('.', {type:'5'}),member('faravan-output/ok.txt',{},'ok')),options);
 for(const bytes of [tar(member('unexpected.js',{},'bad')),tar(member('outside/',{type:'5'})),tar(member('pax',{type:'x'},paxRecord('path','outside.txt')),member('unused',{},'bad'))]){
  rejects(bytes,'path_traversal',options);
  const root=await fixture(t);await assert.rejects(extractArchive(bytes,root,options),{code:'path_traversal'});assert.deepEqual(await readdir(root),[]);
 }
});
