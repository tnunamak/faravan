import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createIdentityPinStore} from '../lib/v1/lending-identity-pin.mjs';
import {claudeAccountMatch} from '../lib/v1/lending-pace50-source.mjs';

const A = {account_sha256_16: '1111222233334444', email_sha256_16: 'aaaa0000bbbb1111'};
const B = {account_sha256_16: '9999888877776666', email_sha256_16: 'cccc2222dddd3333'};
const dir = t => { const d = mkdtempSync(join(tmpdir(), 'pin-')); t.after(() => rmSync(d, {recursive: true, force: true})); return d; };

test('the first verified account is pinned; another account is a mismatch until the pin is cleared', t => {
  const pins = createIdentityPinStore({directory: dir(t), now: () => 1});
  assert.equal(pins.expected('claude', null), null, 'no reading and no pin: unknown');
  assert.deepEqual(claudeAccountMatch(A, pins.expected('claude', A)), {verified: true, account_id: A.account_sha256_16, reason: null});
  assert.deepEqual(claudeAccountMatch(B, pins.expected('claude', B)), {verified: false, reason: 'identity_mismatch'});
  pins.clear('claude');
  assert.deepEqual(claudeAccountMatch(B, pins.expected('claude', B)), {verified: true, account_id: B.account_sha256_16, reason: null});
});

test('the pin survives a restart and keeps only the account hash', t => {
  const directory = dir(t);
  createIdentityPinStore({directory}).expected('claude', A);
  assert.deepEqual(createIdentityPinStore({directory}).expected('claude', B), {account_sha256_16: A.account_sha256_16});
  assert.doesNotMatch(readFileSync(join(directory, 'lending-identity-pins.json'), 'utf8'), new RegExp(A.email_sha256_16));
});

test('an unreadable pin file pins nothing and is never overwritten', t => {
  const directory = dir(t), path = join(directory, 'lending-identity-pins.json');
  writeFileSync(path, '{not json');
  const pins = createIdentityPinStore({directory});
  assert.equal(pins.expected('claude', A), null);
  pins.clear('claude');
  assert.equal(readFileSync(path, 'utf8'), '{not json');
});

test('a read-only lookup never enrolls an observed account', t => {
  const directory=dir(t), pins=createIdentityPinStore({directory});
  assert.equal(pins.peek('codex'),null);
  assert.equal(pins.peek('codex',A),null);
  pins.expected('codex',A);
  assert.deepEqual(pins.peek('codex'),{account_sha256_16:A.account_sha256_16});
});
