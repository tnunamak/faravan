/**
 * Conservative assumption: staged bytes are not graphical-install or trust evidence.
 * Offline fixtures only; no product receipt/API changes, installers, or host stores.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { stageRelease } from '../../packaging/release-feed.mjs';

const revision = 'a'.repeat(40);
const hash = data => createHash('sha256').update(data).digest('hex');
const onboarding = 'curl -fsSL https://example.invalid/preview/install.sh | sh\n' +
  '[public signed release list](https://example.invalid/preview/channel/update.json)';
const variants = [
  { platform: 'linux', arch: 'x64', kind: 'AppImage', name: 'preview.AppImage' },
  { platform: 'darwin', arch: 'arm64', kind: 'zip', name: 'preview.zip' },
];
async function fixture(t, variant = variants[0]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'graphical-stage-contract-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = Buffer.from('SYNTHETIC ONLY: ' + variant.platform);
  return {
    output: path.join(root, 'origin'), sourceSha: revision, expectedSourceSha: revision,
    installer: Buffer.from('# synthetic bootstrap, never executed\n'), onboarding,
    artifacts: [{ ...variant, sourceSha: revision, data, sha256: hash(data) }],
  };
}
const localPath = (input, url) => path.join(input.output, new URL(url).pathname.slice(1));

for (const variant of variants) {
  test('conservative ' + variant.platform + ' fixture verifies staged identity/checksum, not graphical trust', async t => {
    const input = await fixture(t, variant);
    const manifest = await stageRelease(input);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.sourceSha, revision);
    assert.equal(manifest.stagingOnly, true);
    assert.equal(manifest.packages.length, 1);
    const artifact = manifest.packages[0];
    assert.deepEqual(
      { platform: artifact.platform, arch: artifact.arch, kind: artifact.kind, name: artifact.name },
      variant,
    );
    assert.equal(artifact.sourceSha, revision);
    assert.equal(artifact.url, 'https://example.invalid/preview/releases/' + revision + '/' + variant.name);
    const downloadedFixture = await fs.readFile(localPath(input, artifact.url));
    assert.deepEqual(downloadedFixture, input.artifacts[0].data);
    assert.equal(hash(downloadedFixture), artifact.sha256);
    assert.equal(downloadedFixture.length, artifact.size);
    assert.deepEqual(JSON.parse(await fs.readFile(localPath(input, manifest.manifestURL))), manifest);
    assert.equal(manifest.bootstrap.sha256, hash(input.installer));
    assert.equal(manifest.bootstrap.size, input.installer.length);
    assert.deepEqual(await fs.readFile(localPath(input, manifest.bootstrap.url)), input.installer);
    // No signed feed is fabricated: this cannot establish installer/platform trust.
    await assert.rejects(fs.stat(localPath(input, manifest.signedFeedURL)), { code: 'ENOENT' });
    assert.equal(Object.hasOwn(manifest, 'signature'), false);
  });
}

test('tampered staged input is rejected before creating output; checksum is not signature validation', async t => {
  const input = await fixture(t);
  input.artifacts[0].data = Buffer.from('tampered fixture');
  await assert.rejects(stageRelease(input), /artifact hash mismatch/);
  await assert.rejects(fs.stat(input.output), { code: 'ENOENT' });
});

test('mismatched pinned artifact source is rejected before creating output', async t => {
  const input = await fixture(t);
  input.artifacts[0].sourceSha = 'b'.repeat(40);
  await assert.rejects(stageRelease(input), /stale artifact source SHA/);
  await assert.rejects(fs.stat(input.output), { code: 'ENOENT' });
});

test('failure after bootstrap and package writes removes the whole disposable tree', async t => {
  const input = await fixture(t);
  let completed = 0;
  const io = { ...fs, async writeFile(target, data, options) {
    if (++completed === 3) throw new Error('synthetic manifest write failure');
    return fs.writeFile(target, data, options);
  } };
  await assert.rejects(stageRelease(input, io), /synthetic manifest write failure/);
  assert.equal(completed, 3);
  await assert.rejects(fs.stat(input.output), { code: 'ENOENT' });
});

test('competing different platform stages leave only the winning manifest and package', async t => {
  const first = await fixture(t, variants[0]);
  const second = await fixture(t, variants[1]);
  second.output = first.output;
  const results = await Promise.allSettled([stageRelease(first), stageRelease(second)]);
  const winners = results.flatMap((result, index) => result.status === 'fulfilled' ? [index] : []);
  assert.equal(winners.length, 1);
  const winner = winners[0], loser = 1 - winner;
  const inputs = [first, second];
  const manifest = results[winner].value;
  assert.equal(results[loser].status, 'rejected');
  assert.equal(results[loser].reason.code, 'EEXIST');
  const disk = JSON.parse(await fs.readFile(localPath(first, manifest.manifestURL)));
  assert.deepEqual(disk, manifest);
  assert.equal(disk.packages[0].name, inputs[winner].artifacts[0].name);
  assert.deepEqual(await fs.readFile(localPath(first, disk.packages[0].url)), inputs[winner].artifacts[0].data);
  const artifactDir = path.dirname(localPath(first, disk.packages[0].url));
  assert.deepEqual((await fs.readdir(artifactDir)).sort(), ['manifest.json', inputs[winner].artifacts[0].name].sort());
});
