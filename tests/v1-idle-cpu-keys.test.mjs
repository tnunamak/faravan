import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../lib/protocol/index.mjs';
import { pointCheckStats } from '../lib/protocol/encoding.mjs';

// The curve check is pure in the 32 key bytes: a success is remembered, a failure is never remembered.

test('a key that passed its point check is not checked again', () => {
  const key = p.exportPublicKey(p.generateDeviceKeyPair().publicKey);
  const id = p.fingerprint(key);
  const afterFirst = pointCheckStats().runs;
  for (let i = 0; i < 20; i++) assert.equal(p.fingerprint(key), id);
  assert.equal(pointCheckStats().runs, afterFirst);
});

test('an invalid key is still rejected after valid keys are cached, and is never cached', () => {
  const valid = p.exportPublicKey(p.generateDeviceKeyPair().publicKey);
  p.fingerprint(valid);
  const invalid = Buffer.alloc(32, 0xff).toString('base64url');
  const before = pointCheckStats();
  assert.throws(() => p.fingerprint(invalid), { code: 'invalid_key' });
  assert.throws(() => p.fingerprint(invalid), { code: 'invalid_key' });
  const after = pointCheckStats();
  assert.equal(after.runs - before.runs, 2);
  assert.equal(after.cached, before.cached);
});

test('the successful-point memo stays bounded', () => {
  for (let i = 0; i < 600; i++) p.fingerprint(p.exportPublicKey(p.generateDeviceKeyPair().publicKey));
  assert.ok(pointCheckStats().cached <= 512, `cached ${pointCheckStats().cached}`);
});
