import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwnerSettings } from '../../lib/v1/owner-settings.mjs';

// Conservative scope assumption: this is only a legacy cap-store preservation
// regression, NOT a model/effort selector or signed-selection integration test.
// Unknown strategy/order data must not be silently interpreted or discarded.
function fixture(t, text) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-settings-boundary-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'owner-settings.json');
  if (text !== undefined) fs.writeFileSync(file, text);
  return { directory, file, read: () => fs.readFileSync(file, 'utf8') };
}

test('conservative scope: unsupported strategy/order values survive construction and refused cap write', t => {
  const original = JSON.stringify({
    version: 1,
    values: { maxJobUsd: 7, strategy: 'future-strategy',
      accountOrder: ['missing', 'same-provider-a', 'same-provider-b'],
      modelOrder: ['missing-model', 'no-effort-model'] },
    audit: [{ at: 1, by: 'synthetic-owner', reason: 'saved future preferences', changed: {} }],
  }, null, 2) + '\n';
  const f = fixture(t, original);
  const settings = createOwnerSettings({ directory: f.directory, now: () => 2 });
  assert.equal(f.read(), original);
  assert.equal(settings.values(), null);
  assert.deepEqual(settings.limit(), { state: 'unreadable', maxJobUsd: null });
  assert.throws(() => settings.set({ by: 'synthetic-owner', reason: 'ordinary cap update', now: 3, maxJobUsd: 9 }),
    /unreadable_owner_settings/);
  assert.equal(f.read(), original);
  assert.deepEqual(fs.readdirSync(f.directory), ['owner-settings.json']);
});

test('conservative scope: unknown strategy prevents old-volume migration from erasing it', t => {
  const original = JSON.stringify({
    version: 1,
    values: { maxJobUsd: 7, weeklyOverrunPoints: 0.2, shortOverrunPoints: 0.1, strategy: 'not-understood' },
    audit: [{ at: 1, by: 'synthetic-owner', reason: 'preserve', changed: {} }],
  }) + '\n';
  const f = fixture(t, original);
  const settings = createOwnerSettings({ directory: f.directory, now: () => 99 });
  assert.deepEqual(settings.limit(), { state: 'unreadable', maxJobUsd: null });
  assert.equal(f.read(), original);
  assert.throws(() => settings.set({ by: 'synthetic-owner', reason: 'cap', now: 100, maxJobUsd: 8 }),
    /unreadable_owner_settings/);
  assert.equal(f.read(), original);
});

test('conservative scope: later unsupported saved values are re-read, not overwritten by a stale facade', t => {
  const f = fixture(t);
  const settings = createOwnerSettings({ directory: f.directory, now: () => 1 });
  assert.deepEqual(settings.limit(), { state: 'unset', maxJobUsd: null });
  settings.set({ by: 'synthetic-owner', reason: 'initial cap', now: 2, maxJobUsd: 6 });
  const later = JSON.stringify({ version: 1, values: { maxJobUsd: 6, strategy: 'later-unknown' },
    audit: [{ at: 3, by: 'synthetic-other-writer', reason: 'new preferences', changed: {} }] });
  fs.writeFileSync(f.file, later);
  assert.deepEqual(settings.limit(), { state: 'unreadable', maxJobUsd: null });
  assert.throws(() => settings.set({ by: 'synthetic-owner', reason: 'stale cap update', now: 4, maxJobUsd: 10 }),
    /unreadable_owner_settings/);
  assert.equal(f.read(), later);
});

test('conservative scope: recognized legacy cap edits retain audit and do not invent selection fields', t => {
  const audit = [{ at: 1, by: 'synthetic-owner', reason: 'initial', changed: { maxJobUsd: { from: null, to: 5 } } }];
  const f = fixture(t, JSON.stringify({ version: 1, values: { maxJobUsd: 5 }, audit }));
  const settings = createOwnerSettings({ directory: f.directory, now: () => 2 });
  assert.deepEqual(settings.set({ by: 'synthetic-owner', reason: 'raise cap', now: 3, maxJobUsd: 6 }), { maxJobUsd: 6 });
  assert.deepEqual(settings.limit(), { state: 'set', maxJobUsd: 6 });
  const saved = JSON.parse(f.read());
  assert.deepEqual(saved.values, { maxJobUsd: 6 });
  assert.deepEqual(saved.audit[0], audit[0]);
  assert.deepEqual(saved.audit[1], { at: 3, by: 'synthetic-owner', reason: 'raise cap',
    changed: { maxJobUsd: { from: 5, to: 6 } } });
});
