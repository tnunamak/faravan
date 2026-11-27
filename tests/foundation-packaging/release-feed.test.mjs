import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { stageRelease } from '../../packaging/release-feed.mjs';
import { verifyAndOpenRelease } from '../../packaging/release-verification.mjs';

const sha = 'a'.repeat(40);
const hash = value => createHash('sha256').update(value).digest('hex');
const docs = 'curl -fsSL https://example.invalid/releases/install.sh | sh\n' +
  '[public signed release list](https://example.invalid/releases/preview/update.json)';
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'release-feed-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const data = Buffer.from('synthetic graphical package');
  return { output: path.join(dir, 'site'), sourceSha: sha, expectedSourceSha: sha,
    installer: Buffer.from('#!/bin/sh\n# synthetic installer\n'), onboarding: docs,
    artifacts: [{ name: 'demo.deb', platform: 'linux', arch: 'x64', kind: 'deb',
      sourceSha: sha, sha256: hash(data), data }] };
}
test('stages documented bootstrap and immutable package metadata without signed-feed fabrication', async t => {
  const input = await fixture(t), manifest = await stageRelease(input);
  assert.deepEqual(await fs.readFile(path.join(input.output, 'releases/install.sh')), input.installer);
  const prefix = path.join(input.output, 'releases/releases', sha);
  assert.deepEqual(await fs.readFile(path.join(prefix, 'demo.deb')), input.artifacts[0].data);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(prefix, 'manifest.json'))), manifest);
  assert.equal(manifest.packages[0].url, 'https://example.invalid/releases/releases/' + sha + '/demo.deb');
  assert.equal(manifest.bootstrap.sha256, hash(input.installer));
  assert.equal(manifest.packages[0].sha256, hash(input.artifacts[0].data));
  assert.equal(manifest.packages[0].sourceSha, sha);
  assert.equal(manifest.packages[0].platform, 'linux');
  assert.equal(manifest.stagingOnly, true);
  await assert.rejects(fs.stat(path.join(input.output, 'releases/preview/update.json')), { code: 'ENOENT' });
});
test('the staged universal Mac ZIP opens from a signed envelope with its exact architecture', async t => {
  const input = await fixture(t);
  const name = 'Faravan-0.1.0-universal-unsigned.zip';
  const [artifact] = input.artifacts;
  Object.assign(artifact, { name, platform: 'darwin', arch: 'universal', kind: 'zip' });
  await stageRelease(input);
  const prefix = path.join(input.output, 'releases/releases', sha);
  const artifactBytes = await fs.readFile(path.join(prefix, name));
  const manifest = JSON.parse(await fs.readFile(path.join(prefix, 'manifest.json')));
  const envelope = { schemaVersion: 1, issuedAtMs: 900, expiresAtMs: 1100, manifest };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const trust = {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    sourceSha: sha, platform: 'darwin', arch: 'universal', kind: 'zip', name,
    baseURL: 'https://example.invalid/releases/',
    signedFeedURL: 'https://example.invalid/releases/preview/update.json', maxAgeMs: 200,
  };
  const calls = [];
  const effects = {
    now: () => 1000,
    verify: ({ publicKey, message, signature }) => verify(null, message, publicKey, signature),
    open: value => calls.push(value),
  };
  function signedEnvelope() {
    const envelopeBytes = Buffer.from(JSON.stringify(envelope));
    return { envelopeBytes, signature: sign(null, envelopeBytes, privateKey), artifactBytes };
  }

  const signed = signedEnvelope();
  await verifyAndOpenRelease(signed, trust, effects);
  assert.deepEqual(calls, [{
    bytes: artifact.data, name, platform: 'darwin', arch: 'universal', kind: 'zip',
    sourceSha: sha, sha256: artifact.sha256, size: artifact.data.length,
  }]);
  await assert.rejects(verifyAndOpenRelease(signed, { ...trust, arch: 'arm64' }, effects), /release_verification_failed/);
  await assert.rejects(verifyAndOpenRelease(signed, { ...trust, platform: 'linux', kind: 'deb' }, effects), /release_verification_failed/);
  await assert.rejects(verifyAndOpenRelease(signed, { ...trust, kind: 'dmg' }, effects), /release_verification_failed/);
  manifest.packages.push({ ...manifest.packages[0] });
  await assert.rejects(verifyAndOpenRelease(signedEnvelope(), trust, effects), /release_verification_failed/);
  assert.equal(calls.length, 1);
});

for (const [name, change, message] of [
  ['stale source', x => { x.expectedSourceSha = 'b'.repeat(40); }, /source SHA/],
  ['stale artifact', x => { x.artifacts[0].sourceSha = 'b'.repeat(40); }, /source SHA/],
  ['universal Linux package', x => { x.artifacts[0].arch = 'universal'; }, /invalid artifact metadata/],
  ['universal Mac DMG', x => {
    Object.assign(x.artifacts[0], { platform: 'darwin', arch: 'universal', kind: 'dmg' });
  }, /invalid artifact metadata/],
  ['missing artifact', x => { x.artifacts = []; }, /absent graphical/],
  ['missing bytes', x => { delete x.artifacts[0].data; }, /absent artifact/],
  ['wrong hash', x => { x.artifacts[0].sha256 = '0'.repeat(64); }, /hash mismatch/],
  ['wrong URL', x => { x.artifacts[0].url = 'https://elsewhere.invalid/demo.deb'; }, /URL mismatch/],
  ['documentation mismatch', x => { x.onboarding = docs.replace('/releases/preview/', '/other/preview/'); }, /URL mismatch/],
]) {
  test('rejects ' + name + ' before staging', async t => {
    const input = await fixture(t); change(input);
    await assert.rejects(stageRelease(input), message);
    await assert.rejects(fs.stat(input.output), { code: 'ENOENT' });
  });
}
test('cleans a partial write failure', async t => {
  const input = await fixture(t);
  let count = 0;
  const io = { ...fs, async writeFile(...args) {
    if (++count === 2) throw new Error('synthetic disk failure');
    return fs.writeFile(...args);
  } };
  await assert.rejects(stageRelease(input, io), /synthetic disk failure/);
  await assert.rejects(fs.stat(input.output), { code: 'ENOENT' });
});
test('concurrent staging cannot overwrite or delete the winning tree', async t => {
  const input = await fixture(t);
  const results = await Promise.allSettled([stageRelease(input), stageRelease(input)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.filter(x => x.status === 'rejected').length, 1);
  assert.deepEqual(await fs.readFile(path.join(input.output, 'releases/install.sh')), input.installer);
});
