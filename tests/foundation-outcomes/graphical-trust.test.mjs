import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyAndOpenRelease } from '../../packaging/release-verification.mjs';

const sha = 'a'.repeat(40);
const digest = data => createHash('sha256').update(data).digest('hex');
function fixture() {
  const data = Buffer.from('synthetic graphical artifact');
  const manifest = { schemaVersion: 1, stagingOnly: true, sourceSha: sha,
    bootstrap: { url: 'https://release.invalid/install.sh', size: 1, sha256: 'b'.repeat(64) },
    signedFeedURL: 'https://release.invalid/feed.json',
    manifestURL: 'https://release.invalid/releases/' + sha + '/manifest.json',
    packages: [{ name: 'app.deb', platform: 'linux', arch: 'x64', kind: 'deb',
      sourceSha: sha, sha256: digest(data), size: data.length,
      url: 'https://release.invalid/releases/' + sha + '/app.deb' }] };
  const envelope = { schemaVersion: 1, issuedAtMs: 900, expiresAtMs: 1100, manifest };
  const input = { envelopeBytes: Buffer.from(JSON.stringify(envelope)),
    signature: Buffer.from('fixture detached signature'), artifactBytes: data };
  const pinned = { publicKey: 'synthetic pinned public key', sourceSha: sha,
    platform: 'linux', arch: 'x64', kind: 'deb', name: 'app.deb',
    baseURL: 'https://release.invalid/', signedFeedURL: manifest.signedFeedURL, maxAgeMs: 200 };
  const signedBytes = Buffer.from(input.envelopeBytes);
  const calls = [];
  const effects = { now: () => 1000,
    // Exact-byte fake, not a cryptographic qualification or a real signature.
    verify: async ({ publicKey, message, signature }) => publicKey === pinned.publicKey &&
      message.equals(signedBytes) && signature.equals(Buffer.from('fixture detached signature')),
    open: async value => { calls.push(value); return 'opened'; } };
  return { input, pinned, effects, calls, envelope };
}
function rewrite(f, edit) {
  edit(f.envelope);
  f.input.envelopeBytes = Buffer.from(JSON.stringify(f.envelope));
}
test('conservative assumption: detached exact-byte envelope authenticates unchanged staging manifest before open', async () => {
  const f = fixture();
  const result = await verifyAndOpenRelease(f.input, f.pinned, f.effects);
  assert.equal(result, 'opened');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].bytes, f.input.artifactBytes);
  assert.equal(f.calls[0].sourceSha, sha);
  assert.equal(f.envelope.manifest.stagingOnly, true); // never relabel staging as a shipped release
});
const cases = [
  ['tampered signed metadata', f => rewrite(f, e => { e.manifest.packages[0].name = 'other.deb'; })],
  ['missing signature', f => { f.input.signature = null; }],
  ['bare staging manifest', f => { f.input.envelopeBytes = Buffer.from(JSON.stringify(f.envelope.manifest)); }],
  ['wrong pinned public key', f => { f.effects.verify = async () => false; }],
  ['verifier unavailable', f => { delete f.effects.verify; }],
  ['verifier throws', f => { f.effects.verify = async () => { throw Error('unavailable'); }; }],
  ['truthy nonboolean verification', f => { f.effects.verify = async () => ({ ok: true }); }],
  ['expired envelope', f => { f.effects.now = () => 1100; }],
  ['future envelope', f => { f.effects.now = () => 899; }],
  ['policy maximum age', f => { f.pinned.maxAgeMs = 50; }],
  ['wrong expected source', f => { f.pinned.sourceSha = 'b'.repeat(40); }],
  ['wrong platform', f => { f.pinned.platform = 'darwin'; }],
  ['wrong arch', f => { f.pinned.arch = 'arm64'; }],
  ['tampered artifact', f => { f.input.artifactBytes[0] ^= 1; }],
  ['wrong artifact size', f => { f.input.artifactBytes = Buffer.concat([f.input.artifactBytes, Buffer.from('x')]); }],
  ['wrong pinned feed', f => { f.pinned.signedFeedURL = 'https://other.invalid/feed.json'; }],
];
for (const [name, mutate] of cases) test(name + ' fails without opening', async () => {
  const f = fixture(); mutate(f);
  await assert.rejects(() => verifyAndOpenRelease(f.input, f.pinned, f.effects));
  assert.equal(f.calls.length, 0);
});
test('authenticated but wrong artifact URL is rejected', async () => {
  const f = fixture(); rewrite(f, e => { e.manifest.packages[0].url = 'https://other.invalid/app.deb'; });
  f.effects.verify = async () => true; // isolate post-signature source validation
  await assert.rejects(() => verifyAndOpenRelease(f.input, f.pinned, f.effects));
  assert.equal(f.calls.length, 0);
});
test('authenticated duplicate selection is rejected', async () => {
  const f = fixture(); rewrite(f, e => { e.manifest.packages.push({ ...e.manifest.packages[0] }); });
  f.effects.verify = async () => true;
  await assert.rejects(() => verifyAndOpenRelease(f.input, f.pinned, f.effects));
  assert.equal(f.calls.length, 0);
});
test('expiry during asynchronous verification prevents open', async () => {
  const f = fixture(); let now = 1000; f.effects.now = () => now;
  f.effects.verify = async () => { now = 1100; return true; };
  await assert.rejects(() => verifyAndOpenRelease(f.input, f.pinned, f.effects));
  assert.equal(f.calls.length, 0);
});
test('caller and verifier mutation cannot substitute opened artifact or signed payload', async () => {
  const f = fixture(), original = Buffer.from(f.input.artifactBytes);
  const verify = f.effects.verify;
  f.effects.verify = async args => {
    const valid = await verify(args);
    args.message.fill(0); f.input.artifactBytes.fill(0);
    f.input.envelopeBytes.fill(0); f.pinned.sourceSha = 'b'.repeat(40);
    return valid;
  };
  await verifyAndOpenRelease(f.input, f.pinned, f.effects);
  assert.deepEqual(f.calls[0].bytes, original);
  assert.equal(f.calls[0].sourceSha, sha);
});
