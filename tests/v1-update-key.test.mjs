import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import { UPDATE_PUBLIC_KEY } from '../lib/v1/update-key.mjs';

// A null or malformed key would leave every install unable to update itself,
// and a build without the key cannot receive one by update later.
test('the shipped update key is an Ed25519 public key', () => {
  assert.equal(typeof UPDATE_PUBLIC_KEY, 'string');
  const key = createPublicKey(UPDATE_PUBLIC_KEY);
  assert.equal(key.type, 'public');
  assert.equal(key.asymmetricKeyType, 'ed25519');
});
