import { createHash } from 'node:crypto';

// Offline consumer boundary, not a signer or an update feed. Dependency:
// fv-outcome-bootstrap-first-open-1114 must wire its graphical open through this
// gate. No existing consumer is changed here. Real signer/OS qualification is
// still required; synthetic verifier tests cannot qualify a publisher.
//
// Conservative local envelope contract (not a change to release-feed shape):
// exact UTF-8 JSON bytes of {schemaVersion:1, issuedAtMs, expiresAtMs, manifest}
// are detached-signed. Trust/key and expected source/platform come from trusted
// caller configuration, NEVER the manifest. stagingOnly is retained as-is;
// only a true response from the configured verifier authenticates these bytes.
// The injected open MUST consume the supplied verified byte snapshot, not
// re-download by URL or reopen a mutable caller-owned pathname.
const fail = () => { throw new Error('release_verification_failed'); };
const bytes = value => Buffer.isBuffer(value) || value instanceof Uint8Array;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const integer = value => Number.isSafeInteger(value) && value >= 0;
function publicURL(value) {
  if (typeof value !== 'string') fail();
  let url;
  try { url = new URL(value); } catch { fail(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      /[%\\\\]/.test(url.pathname) || url.href !== value) fail();
  return url;
}
function fresh(envelope, now, maxAgeMs) {
  if (!integer(now) || !integer(envelope.issuedAtMs) || !integer(envelope.expiresAtMs) ||
      envelope.issuedAtMs > now || envelope.expiresAtMs <= now ||
      envelope.expiresAtMs <= envelope.issuedAtMs ||
      envelope.expiresAtMs - envelope.issuedAtMs > maxAgeMs ||
      now - envelope.issuedAtMs > maxAgeMs) fail();
}
export async function verifyAndOpenRelease(input, trust, effects) {
  if (!input || !trust || !effects || typeof effects.verify !== 'function' ||
      typeof effects.now !== 'function' || typeof effects.open !== 'function' ||
      !bytes(input.envelopeBytes) || !input.envelopeBytes.length ||
      !bytes(input.signature) || !input.signature.length ||
      !bytes(input.artifactBytes) || !input.artifactBytes.length) fail();
  // Snapshot caller state before the first await, including the pinned policy.
  const message = Buffer.from(input.envelopeBytes), signature = Buffer.from(input.signature);
  const artifact = Buffer.from(input.artifactBytes);
  const policy = { ...trust };
  if (bytes(policy.publicKey)) policy.publicKey = Buffer.from(policy.publicKey);
  const universalMacZip = policy.platform === 'darwin' && policy.kind === 'zip' && policy.arch === 'universal';
  if (!(typeof policy.publicKey === 'string' && policy.publicKey.length ||
        bytes(policy.publicKey) && policy.publicKey.length) ||
      !sha(policy.sourceSha) || !integer(policy.maxAgeMs) || policy.maxAgeMs === 0 ||
      !['linux', 'darwin'].includes(policy.platform) ||
      (!universalMacZip && !['x64', 'arm64'].includes(policy.arch)) ||
      !(policy.platform === 'linux' ? ['deb', 'AppImage'] : ['zip', 'dmg']).includes(policy.kind) ||
      typeof policy.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(policy.name) ||
      policy.name === 'manifest.json') fail();
  const base = publicURL(policy.baseURL), feed = publicURL(policy.signedFeedURL);
  if (!base.pathname.endsWith('/') || feed.origin !== base.origin ||
      !feed.pathname.startsWith(base.pathname)) fail();
  let envelope;
  try { envelope = JSON.parse(message.toString('utf8')); } catch { fail(); }
  if (!envelope || envelope.schemaVersion !== 1 || !envelope.manifest) fail();
  fresh(envelope, effects.now(), policy.maxAgeMs);
  let verified;
  try {
    verified = await effects.verify({
      publicKey: bytes(policy.publicKey) ? Buffer.from(policy.publicKey) : policy.publicKey,
      message: Buffer.from(message), signature: Buffer.from(signature),
    });
  } catch { fail(); }
  if (verified !== true) fail();
  const manifest = envelope.manifest;
  if (manifest.schemaVersion !== 1 || manifest.sourceSha !== policy.sourceSha ||
      manifest.signedFeedURL !== policy.signedFeedURL ||
      manifest.manifestURL !== new URL('releases/' + policy.sourceSha + '/manifest.json', base).href ||
      !Array.isArray(manifest.packages)) fail();
  const selected = manifest.packages.filter(item => item && item.name === policy.name);
  if (selected.length !== 1) fail();
  const item = selected[0];
  if (item.sourceSha !== policy.sourceSha || item.platform !== policy.platform ||
      item.arch !== policy.arch || item.kind !== policy.kind ||
      !integer(item.size) || item.size !== artifact.length ||
      typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) ||
      hash(artifact) !== item.sha256 ||
      item.url !== new URL('releases/' + policy.sourceSha + '/' + policy.name, base).href) fail();
  // The clock can advance during signature verification; do not open stale bytes.
  fresh(envelope, effects.now(), policy.maxAgeMs);
  return effects.open({ bytes: artifact, name: item.name, platform: item.platform,
    arch: item.arch, kind: item.kind, sourceSha: item.sourceSha,
    sha256: item.sha256, size: item.size });
}
