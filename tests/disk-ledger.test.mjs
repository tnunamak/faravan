import './helpers/no-browser.mjs';
import './helpers/removal-on.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createDiskLedger } from '../lib/disk-ledger.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-ledger-test-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const hex = c => c.repeat(64);

test('a lease protects until released or expired; the file keeps it across a restart', () => {
  const file = path.join(dir, 'leases.json');
  let now = 1000;
  const ledger = createDiskLedger({ file, now: () => now });
  const id = ledger.acquireLease({ item: 'image:*', ttlMs: 500 });
  assert.equal(ledger.activeLeases().length, 1);
  assert.equal(createDiskLedger({ file, now: () => now }).activeLeases().length, 1, 'a crash after create keeps the lease');
  now = 1499;
  assert.equal(ledger.activeLeases().length, 1);
  now = 1500;
  assert.equal(ledger.activeLeases().length, 0, 'expired at its expiry');
  const second = ledger.acquireLease({ item: 'image:*', ttlMs: 10_000 });
  ledger.releaseLease(second);
  assert.equal(ledger.activeLeases().length, 0);
  assert.notEqual(id, second);
});

test('pin history: the previous release pins are remembered, and only two releases back is dropped', () => {
  const ledger = createDiskLedger({ file: path.join(dir, 'pins.json') });
  assert.deepEqual([...ledger.pinRoots().current], []);
  ledger.notePins([hex('a')]);
  assert.deepEqual([...ledger.pinRoots().current], [hex('a')]);
  assert.deepEqual([...ledger.pinRoots().previous], []);
  ledger.notePins([hex('a')]);
  assert.deepEqual([...ledger.pinRoots().previous], [], 'the same pins do not rotate history');
  ledger.notePins([hex('b'), hex('c')]);
  assert.deepEqual([...ledger.pinRoots().current].sort(), [hex('b'), hex('c')]);
  assert.deepEqual([...ledger.pinRoots().previous], [hex('a')]);
  ledger.notePins([hex('d')]);
  assert.deepEqual([...ledger.pinRoots().previous].sort(), [hex('b'), hex('c')], 'release a is now two releases old');
  const again = createDiskLedger({ file: path.join(dir, 'pins.json') });
  assert.deepEqual([...again.pinRoots().current], [hex('d')], 'history survives a restart');
});

test('sandbox records keep the pin they were made from and the time they were first recorded', () => {
  let now = 5000;
  const ledger = createDiskLedger({ file: path.join(dir, 'sandboxes.json'), now: () => now });
  ledger.recordSandbox('wf-0000000000000001', { pin: hex('a') });
  now = 9000;
  ledger.recordSandbox('wf-0000000000000002', { pin: null });
  assert.deepEqual(ledger.sandbox('wf-0000000000000001'), { pin: hex('a'), createdAt: 5000, cache: null, id: null });
  assert.deepEqual(ledger.sandbox('wf-0000000000000002'), { pin: null, createdAt: 9000, cache: null, id: null });
  ledger.forgetSandboxesExcept(new Set(['wf-0000000000000002']));
  assert.equal(ledger.sandbox('wf-0000000000000001'), null);
  assert.ok(ledger.sandbox('wf-0000000000000002'));
});

test('the last sweep is stored; a damaged file is reported, never reset, and never rewritten', () => {
  const file = path.join(dir, 'last.json');
  const ledger = createDiskLedger({ file });
  ledger.recordSweep({ at: 7, removed: 2 });
  assert.deepEqual(createDiskLedger({ file }).lastSweep(), { at: 7, removed: 2 });
  fs.writeFileSync(file, '{not json');
  const damaged = createDiskLedger({ file });
  assert.equal(damaged.lastSweep(), null);
  assert.equal(damaged.damaged, true, 'callers can tell leases may have been lost');
  assert.match(damaged.damage, /JSON/);
  assert.throws(() => damaged.recordSweep({ at: 8 }), error => error.code === 'ledger_damaged');
  assert.equal(fs.readFileSync(file, 'utf8'), '{not json', 'the damaged file is left as it was');
  fs.rmSync(file);
  assert.equal(damaged.damaged, false, 'once the file is gone the ledger starts fresh');
});

test('a ledger reads the file on every call, so two objects (two processes) see each other', () => {
  const file = path.join(dir, 'shared.json');
  const a = createDiskLedger({ file });
  const b = createDiskLedger({ file });
  const lease = b.acquireLease({ item: 'image:*', ttlMs: 60_000 });
  assert.equal(a.activeLeases().length, 1);
  a.renewLease(lease, 120_000);
  assert.ok(b.activeLeases()[0].expiresAt > Date.now() + 100_000);
  b.releaseLease(lease);
  assert.equal(a.activeLeases().length, 0);
});

test('records of owned images and caches carry a reason and are never rewritten', () => {
  const ledger = createDiskLedger({ file: path.join(dir, 'owned.json'), now: () => 5 });
  ledger.ownImages([{ ref: 'r:a', imageId: 'aaaaaaaaaaaa' }], 'created');
  ledger.ownImages([{ ref: 'r:a', imageId: 'bbbbbbbbbbbb' }, { ref: 'r:b', imageId: 'cccccccccccc' }], 'created');
  assert.deepEqual(ledger.ownedImages(), { 'r:a': { imageId: 'aaaaaaaaaaaa', reason: 'created', at: 5 }, 'r:b': { imageId: 'cccccccccccc', reason: 'created', at: 5 } });
  ledger.disownMissing({ images: new Set(['r:b']) });
  assert.deepEqual(Object.keys(ledger.ownedImages()), ['r:b']);
  ledger.ownCache('/cache/x', 'created');
  assert.deepEqual(ledger.ownedCaches(), { '/cache/x': { reason: 'created', at: 5 } });
});

test('an expired lease is listed for reconciliation until the sweep drops it', () => {
  let t = 1000;
  const ledger = createDiskLedger({ file: path.join(dir, 'expired.json'), now: () => t });
  const id = ledger.acquireLease({ item: 'image:*', ttlMs: 100 });
  t = 1099;
  assert.equal(ledger.expiredLeases().length, 0);
  t = 1100;
  assert.deepEqual(ledger.expiredLeases().map(lease => [lease.id, lease.startedAt]), [[id, 1000]]);
  ledger.dropLeases([id]);
  assert.equal(ledger.expiredLeases().length, 0);
});

test('concurrent writers in separate processes lose no update', async () => {
  const file = path.join(dir, 'processes.json');
  const module = new URL('../lib/disk-ledger.mjs', import.meta.url).href;
  const script = `import { createDiskLedger } from ${JSON.stringify(module)}; const l = createDiskLedger({ file: ${JSON.stringify(file)} }); for (let i = 0; i < 25; i++) { for (;;) { try { l.recordSandbox('wf-' + (process.pid * 100 + i).toString(16).padStart(16, '0'), { pin: 'a'.repeat(64) }); break; } catch (error) { if (error.code !== 'ledger_locked') throw error; } } }`;
  const run = () => new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', script], error => (error ? reject(error) : resolve())));
  await Promise.all([run(), run(), run()]);
  assert.equal(Object.keys(createDiskLedger({ file }).sandboxes()).length, 75);
});
