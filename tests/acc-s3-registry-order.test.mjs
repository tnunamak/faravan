import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createAccountRegistry} from '../lib/v1/lending-accounts.mjs';

// Slice 3, behaviors 1 and 2, on the account registry (lib/v1/lending-accounts.mjs).
const T = Date.parse('2026-11-01T12:00:00Z');
function registry(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-s3-registry-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  let at = T;
  return createAccountRegistry({file: path.join(dir, 'accounts.json'), now: () => at++});
}
const add = (r, label) => r.add({provider: 'claude', label, origin: {}, key: label});

// (1) Fails today: add() creates the account with enabled:true, so a second account would start lending at once.
test('each newly added account starts off, so a second account for one provider lends nothing until the owner turns it on', t => {
  const r = registry(t);
  const first = add(r, 'first');
  const second = add(r, 'second');
  const a = (first.account ?? first), b = (second.account ?? second);
  assert.equal(r.get(a.id).enabled, false, 'the new first account starts off');
  assert.equal(r.get(b.id).enabled, false, 'the new second account starts off');
  assert.deepEqual(r.list().filter(x => x.enabled), [], 'nothing lends until the owner turns an account on');
});

// (2) Fails today: with two enabled accounts resolve() answers {ok:false, reason:'ambiguous'}; the wanted answer is the first
// enabled account in the owner's order (default order: creation order). Seam for reordering: registry.setOrder(provider, ids).
test('with several enabled accounts the first in the owner\'s order is chosen, then the next when it is off', t => {
  const r = registry(t);
  const a = add(r, 'first'), b = add(r, 'second');
  const [ida, idb] = [(a.account ?? a).id, (b.account ?? b).id];
  r.setEnabled(ida, true); r.setEnabled(idb, true);
  const chosen = r.resolve({provider: 'claude'});
  assert.equal(chosen.ok, true, `an order picks one account instead of refusing: ${JSON.stringify(chosen)}`);
  assert.equal(chosen.account.id, ida, 'the first account in the order is chosen');
  r.setEnabled(ida, false);
  assert.equal(r.resolve({provider: 'claude'}).account?.id, idb, 'the next enabled account is chosen when the first is off');
  if (typeof r.setOrder === 'function') {
    r.setEnabled(ida, true);
    r.setOrder('claude', [idb, ida]);
    assert.equal(r.resolve({provider: 'claude'}).account?.id, idb, 'a new order puts the second account first');
  }
});
