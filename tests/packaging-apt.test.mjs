import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, rename, writeFile, readFile, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, fixture, skip } from './helpers/apt-repo-fixture.mjs';

test('the repository has the layout, signatures and public key apt needs', {skip}, async t => {
  const f = await fixture(t);
  const repo = await f.build('0.1.0');
  for (const path of ['dists/stable/InRelease', 'dists/stable/Release', 'dists/stable/Release.gpg', 'dists/stable/main/binary-amd64/Packages.gz',
    'dists/stable/main/binary-amd64/Packages.xz', 'pool/main/s/faravan/faravan_0.1.0_amd64.deb', 'faravan-archive-keyring.gpg', 'faravan-archive-keyring.asc'])
    await access(join(repo, path));
  const release = await readFile(join(repo, 'dists/stable/Release'), 'utf8');
  assert.match(release, /^Origin: Faravan$/m);
  assert.match(release, /^Suite: stable$/m);
  assert.match(release, /main\/binary-amd64\/Packages\.gz/);
  const packages = await readFile(join(repo, 'dists/stable/main/binary-amd64/Packages'), 'utf8');
  assert.match(packages, /^Filename: pool\/main\/s\/faravan\/faravan_0\.1\.0_amd64\.deb$/m);
  assert.equal((await readFile(join(repo, 'faravan-archive-keyring.fingerprint'), 'utf8')).trim(), f.fpr);
  const published = (await run('gpg', ['--show-keys', '--with-colons', join(repo, 'faravan-archive-keyring.gpg')])).stdout;
  assert.equal(published.includes('sec:'), false, 'only the public key is published');
  assert.equal((await readFile(join(repo, 'faravan-archive-keyring.asc'), 'utf8')).includes('PRIVATE'), false);
});

test('a real apt client updates from the repository and sees a newer version (apt upgrade path)', {skip, timeout: 120000}, async t => {
  const f = await fixture(t);
  let repo = await f.build('0.1.0');
  const keyring = join(repo, 'faravan-archive-keyring.gpg');
  await f.apt(repo, keyring, ['update']);
  assert.match((await f.apt(repo, keyring, ['policy', 'faravan'], 'apt-cache')).stdout, /Candidate: 0\.1\.0/);
  repo = await f.build('0.1.0', '0.2.0');
  await f.apt(repo, keyring, ['update']);
  const policy = (await f.apt(repo, keyring, ['policy', 'faravan'], 'apt-cache')).stdout;
  assert.match(policy, /Candidate: 0\.2\.0/);
  // apt checks the package hash against the signed index when it downloads.
  await f.apt(repo, keyring, ['download', 'faravan']);
  await access(join(f.root, 'faravan_0.2.0_amd64.deb'));
});

test('apt refuses a tampered index, an unsigned index and a repository signed by another key', {skip, timeout: 120000}, async t => {
  const f = await fixture(t);
  const repo = await f.build('0.1.0');
  const keyring = join(repo, 'faravan-archive-keyring.gpg');
  const inRelease = join(repo, 'dists/stable/InRelease');
  const original = await readFile(inRelease, 'utf8');
  await writeFile(inRelease, original.replace('Suite: stable', 'Suite: evil'));
  await assert.rejects(f.apt(repo, keyring, ['update']), /signature|not signed|NO_PUBKEY|BADSIG|GPG/i, 'tampered InRelease');
  await writeFile(inRelease, original);
  await f.apt(repo, keyring, ['update']);
  // Without InRelease and Release.gpg the Release file is unsigned, and apt must refuse it.
  const detached = join(repo, 'dists/stable/Release.gpg'), signature = await readFile(detached);
  await rm(inRelease); await rm(detached);
  await assert.rejects(f.apt(repo, keyring, ['update']), /not signed|no longer signed|signature|GPG/i, 'an unsigned index');
  await writeFile(inRelease, original); await writeFile(detached, signature);
  await f.apt(repo, keyring, ['update']);

  const other = await fixture(t);
  const foreign = await other.build('9.9.9');
  await assert.rejects(f.apt(foreign, keyring, ['update']), /signature|NO_PUBKEY|GPG/i, 'a repository signed by an unknown key');
  // The rejected repository's packages never reached apt's view: the candidate is still the one from the trusted repository.
  const policy = (await f.apt(repo, keyring, ['policy', 'faravan'], 'apt-cache')).stdout;
  assert.doesNotMatch(policy, /9\.9\.9/);
  assert.match(policy, /Candidate: 0\.1\.0/);
});

const readOrNull = path => readFile(path, 'utf8').catch(() => null);
const packageVersions = async (repo, suite) => [...(await readFile(join(repo, `dists/${suite}/main/binary-amd64/Packages`), 'utf8')).matchAll(/^Version: (.+)$/gm)].map(m => m[1]);

test('building one suite keeps the other suites, and each index lists only its own packages', {skip, timeout: 120000}, async t => {
  const f = await fixture(t);
  const repo = await f.buildSuite('stable', '1:0.1.0-1');
  const stableRelease = await readFile(join(repo, 'dists/stable/InRelease'), 'utf8');
  await f.buildSuite('preview', '1:0.2.0~preview.1-1');
  // The second build did not touch stable.
  assert.equal(await readFile(join(repo, 'dists/stable/InRelease'), 'utf8'), stableRelease, 'stable InRelease is unchanged');
  assert.deepEqual(await packageVersions(repo, 'stable'), ['1:0.1.0-1'], 'stable lists only the stable package');
  assert.deepEqual(await packageVersions(repo, 'preview'), ['1:0.2.0~preview.1-1'], 'preview lists only the preview package');
  // Both stay installable by a real apt client against their own signed Release.
  const keyring = join(repo, 'faravan-archive-keyring.gpg');
  await f.apt(repo, keyring, ['update']);
  assert.match((await f.apt(repo, keyring, ['policy', 'faravan'], 'apt-cache')).stdout, /Candidate: 1:0\.1\.0-1/);
  await f.apt(repo, keyring, ['update'], 'apt-get', 'preview');
  assert.match((await f.apt(repo, keyring, ['policy', 'faravan'], 'apt-cache', 'preview')).stdout, /Candidate: 1:0\.2\.0~preview\.1-1/);
  // Rebuilding stable with a newer package keeps preview, and the shared pool keeps both packages.
  const previewRelease = await readFile(join(repo, 'dists/preview/InRelease'), 'utf8');
  await f.buildSuite('stable', '1:0.1.0-1', '1:0.1.1-1');
  assert.equal(await readFile(join(repo, 'dists/preview/InRelease'), 'utf8'), previewRelease, 'preview InRelease is unchanged');
  assert.deepEqual((await packageVersions(repo, 'stable')).sort(), ['1:0.1.0-1', '1:0.1.1-1']);
  assert.deepEqual((await readdir(join(repo, 'pool/main/s/faravan'))).sort(),
    ['faravan_1:0.1.0-1_amd64.deb', 'faravan_1:0.1.1-1_amd64.deb', 'faravan_1:0.2.0~preview.1-1_amd64.deb']);
});

// Everything a client could read: each suite's signed files, the shared pool and the public key files.
async function snapshot(repo) {
  const entries = [];
  const walk = async dir => {
    for (const entry of (await readdir(dir, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { entries.push(path + '/'); await walk(path); } else entries.push(path + '\0' + (await readFile(path)).toString('base64'));
    }
  };
  await walk(repo);
  return entries.map(entry => entry.slice(repo.length)).join('\n');
}

test('a build that fails leaves the existing repository exactly as it was', {skip, timeout: 120000}, async t => {
  const f = await fixture(t);
  const repo = await f.buildSuite('stable', '0.1.0');
  await f.buildSuite('preview', '0.1.0');
  const before = await snapshot(repo);
  assert.match(before, /dists\/stable\/InRelease/);

  const base = ['--out', repo, '--gnupghome', f.gnupg, '--suite', 'preview'];
  const good = await f.deb('0.2.0'), arm = await f.deb('0.3.0', 'arm64'), duplicate = await f.deb('0.4.0');
  // A signing failure comes after the whole suite is built, so it is the case that used to leave nothing behind.
  await assert.rejects(run(f.script, [...base, '--key', 'no-such-key@example.invalid', good]), /secret key|No secret key|signing failed/i);
  await assert.rejects(run(f.script, [...base, '--key', f.fpr, good, arm]), /not an amd64 package/);
  await assert.rejects(run(f.script, [...base, '--key', f.fpr, join(f.root, 'missing.deb')]), /no such file/);
  await assert.rejects(run(f.script, [...base, '--key', f.fpr, good, duplicate, duplicate]), /share the file name/);
  await assert.rejects(run(f.script, ['--out', repo, '--gnupghome', f.gnupg, '--suite', '../stable', '--key', f.fpr, good]), /invalid suite name/);
  assert.equal(await snapshot(repo), before, 'every failed build left both suites, the pool and the key files untouched');
  assert.deepEqual((await readdir(repo)).filter(name => name.startsWith('.candidate')), [], 'no candidate directory is left behind');
});

// A stand-in for one tool that fails on a chosen argument list, and passes everything else to the real one.
async function failingTool(t, name, when) {
  const dir = await mkdtemp(join(tmpdir(), 'spk-shim-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const real = (await run('sh', ['-c', 'command -v ' + name])).stdout.trim();
  await writeFile(join(dir, name), `#!/bin/sh\ncase "$*" in ${when}) echo "injected failure: ${name} $*" >&2; exit 1;; esac\nexec ${real} "$@"\n`, {mode: 0o755});
  return {...process.env, PATH: dir + ':' + process.env.PATH};
}

test('a failure after signing, while the suite or the key files are put in place, changes nothing published', {skip, timeout: 120000}, async t => {
  const f = await fixture(t);
  const repo = await f.buildSuite('stable', '0.1.0');
  await f.buildSuite('preview', '0.1.0');
  const before = await snapshot(repo);
  const next = await f.deb('0.2.0');
  const args = ['--out', repo, '--gnupghome', f.gnupg, '--suite', 'preview', '--key', f.fpr, next];

  // Exporting the public key fails after the suite is signed and before anything is published.
  await assert.rejects(run(f.script, args, {env: await failingTool(t, 'gpg', '*--export*')}), /injected failure/);
  assert.equal(await snapshot(repo), before, 'a failed key export changed the repository');

  // The second rename fails after the old suite was set aside: the old suite must come back, not be deleted with the candidate.
  // Only the swap starts its arguments with "-T ". A bare "-T" also matched a scratch path such as faravan-tests-T..., and
  // then failed the earlier mv of the candidate's Release file. The quotes keep the space literal in the shell case pattern.
  await assert.rejects(run(f.script, args, {env: await failingTool(t, 'mv', '"-T "*.candidate*dists/preview*')}), /previous preview was restored/);
  const after = await snapshot(repo);
  assert.equal(after.includes('dists/preview/InRelease'), true, 'the last good preview suite is still served');
  assert.equal(after.includes('.previous'), false, 'the set-aside copy was put back');
  assert.equal(after.includes('dists/preview/preview'), false, 'no nested suite directory');
  // Only the pool gained the new package; both suites are byte-identical to before.
  const suites = text => text.split('\n').filter(line => line.startsWith('/dists/')).join('\n');
  assert.equal(suites(after), suites(before));
  await f.buildSuite('preview', '0.1.0'); // and the repository still builds afterwards
});

test('a published .deb name is immutable, for the suite that owns it as well as for the others', {skip, timeout: 120000}, async t => {
  const f = await fixture(t);
  const repo = await f.buildSuite('stable', '0.1.0');
  const pooled = join(repo, 'pool/main/s/faravan/faravan_0.1.0_amd64.deb');
  const original = await readFile(pooled);
  const rebuilt = await f.deb('0.1.0', 'amd64', 'rebuilt with other bytes');
  assert.notDeepEqual(await readFile(rebuilt), original, 'the rebuilt package differs');
  const args = ['--out', repo, '--gnupghome', f.gnupg, '--key', f.fpr];

  for (const suite of ['preview', 'stable'])
    await assert.rejects(run(f.script, [...args, '--suite', suite, rebuilt]), /refusing to replace faravan_0\.1\.0_amd64\.deb/, suite);
  assert.deepEqual(await readFile(pooled), original, 'the pool keeps the bytes the signed index names');
  const keyring = join(repo, 'faravan-archive-keyring.gpg');
  await f.apt(repo, keyring, ['update']);
  await f.apt(repo, keyring, ['download', 'faravan']); // the suite still downloads with a valid hash
  // The same bytes again are fine (a rebuild of the index), and a new version needs no replacement.
  await run(f.script, [...args, '--suite', 'stable', await f.deb('0.1.0')]);
  await run(f.script, [...args, '--suite', 'stable', await f.deb('0.1.0'), await f.deb('0.1.1')]);
});

test('the published key is never changed in place, with one suite or several', {skip, timeout: 120000}, async t => {
  const f = await fixture(t);
  const repo = await f.buildSuite('stable', '0.1.0');
  const other = await fixture(t);
  const before = await snapshot(repo);
  const next = await other.deb('0.2.0');
  for (const suite of ['preview', 'stable'])
    await assert.rejects(run(f.script, ['--out', repo, '--gnupghome', other.gnupg, '--suite', suite, '--key', other.fpr, next]), /refusing to sign with a different key/, suite);
  assert.equal(await snapshot(repo), before, 'a refused key change touched nothing');
  // A rotation is a new repository.
  await run(f.script, ['--out', join(f.root, 'rotated'), '--gnupghome', other.gnupg, '--key', other.fpr, next]);
});

test('a build stopped between the two directory renames is recovered by the next one', {skip, timeout: 120000}, async t => {
  const f = await fixture(t);
  const repo = await f.buildSuite('stable', '0.1.0');
  await rename(join(repo, 'dists/stable'), join(repo, 'dists/.previous-stable.4242')); // what an interrupted swap leaves
  await assert.rejects(access(join(repo, 'dists/stable')));
  await f.buildSuite('stable', '0.1.0', '0.1.1');
  assert.deepEqual((await packageVersions(repo, 'stable')).sort(), ['0.1.0', '0.1.1']);
  assert.deepEqual((await readdir(join(repo, 'dists'))).sort(), ['stable'], 'nothing is left in dists/');
});
