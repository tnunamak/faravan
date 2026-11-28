import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import * as pool from '../lib/v1/lending-pool.mjs';

const other = 'claude:12345678-1234-4123-8123-123456789abc';

test('child ids preserve the whole account key and distinguish numeric slots', () => {
  assert.equal(typeof pool.parseChildId, 'function');
  assert.deepEqual(pool.parseChildId('claude'), {accountKey: 'claude', slot: null});
  assert.deepEqual(pool.parseChildId(other), {accountKey: other, slot: null});
  assert.deepEqual(pool.parseChildId('claude:0'), {accountKey: 'claude', slot: 0});
  assert.deepEqual(pool.parseChildId('codex:12'), {accountKey: 'codex', slot: 12});
  for (const accountKey of ['claude', 'codex', other]) {
    for (const slot of [0, 1, 12]) {
      assert.deepEqual(pool.parseChildId(accountKey + '#' + slot), {accountKey, slot});
    }
  }
  assert.equal(pool.parseChildId(other).slot, null);
});
