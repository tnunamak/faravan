import './helpers/no-browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import cryptoCjs from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import * as p from '../lib/protocol/index.mjs';

const golden = JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json', import.meta.url)));
const pub = golden.keys.map(k => k.public_key);
const job = golden.objects.job.envelope;
const jobText = golden.objects.job.envelope_jcs;

// Count Ed25519 verifications and public-key imports made while fn runs (the protocol module reads node:crypto live).
function counting(fn) {
  const counts = { verify: 0, importKey: 0 };
  const { verify, createPublicKey } = cryptoCjs;
  cryptoCjs.verify = (...args) => { counts.verify++; return verify(...args); };
  cryptoCjs.createPublicKey = (...args) => { counts.importKey++; return createPublicKey(...args); };
  syncBuiltinESMExports();
  try { return { result: fn(), counts }; }
  finally {
    cryptoCjs.verify = verify; cryptoCjs.createPublicKey = createPublicKey;
    syncBuiltinESMExports();
  }
}

test('a repeated verification of the same signed envelope reuses the first result', () => {
  const first = counting(() => p.verifyEnvelope('job', structuredClone(job), pub[0]));
  assert.equal(first.result.ok, true);
  assert.ok(first.counts.verify > 0, 'the first verification must do the real work');

  const second = counting(() => p.verifyEnvelope('job', structuredClone(job), pub[0]));
  assert.deepEqual(second.result, first.result);
  assert.deepEqual(second.counts, { verify: 0, importKey: 0 });
});

test('a cached valid result never accepts a changed byte, signature, key or raw text', () => {
  assert.equal(p.verifyEnvelope('job', structuredClone(job), pub[0]).ok, true);

  const prompt = structuredClone(job);
  prompt.payload.prompt += ' ';
  assert.equal(p.verifyEnvelope('job', prompt, pub[0]).ok, false);

  const signature = structuredClone(job);
  const bytes = Buffer.from(signature.signature.value, 'base64url');
  bytes[10] ^= 1;
  signature.signature.value = bytes.toString('base64url');
  assert.equal(p.verifyEnvelope('job', signature, pub[0]).ok, false);

  assert.equal(p.verifyEnvelope('job', structuredClone(job), pub[1]).ok, false);

  const value = job.signature.value;
  const flipped = jobText.replace(value, (value[0] === 'A' ? 'B' : 'A') + value.slice(1));
  assert.notEqual(flipped, jobText);
  assert.equal(p.verifyEnvelope('job', flipped, pub[0]).ok, false);

  // The original, unchanged input still verifies after the rejected variants.
  assert.equal(p.verifyEnvelope('job', structuredClone(job), pub[0]).ok, true);
  assert.equal(p.verifyEnvelope('job', jobText, pub[0]).ok, true);
});

test('a cached result is a copy, so a caller cannot change what the next caller receives', () => {
  const first = p.verifyEnvelope('job', structuredClone(job), pub[0]);
  first.payload.prompt.media_type = 'mutated by caller';
  const second = p.verifyEnvelope('job', structuredClone(job), pub[0]);
  assert.deepEqual(second.payload.prompt, job.payload.prompt);
});
