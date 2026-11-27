import './helpers/no-browser.mjs';
import './helpers/removal-on.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createDiskLedger } from '../lib/disk-ledger.mjs';
import { createDiskSweeper } from '../lib/disk-sweep.mjs';
import { createStoreCoordinator } from '../lib/store-lock.mjs';
import { planSweep, SWEEP_MIN_AGE_MS, SANDBOX_MIN_AGE_MS } from '../lib/disk-sweep-plan.mjs';

// Acceptance cases from an independent test design, driven through the real sweeper, ledger
// and store lock with a fake sbx. Each case names the property it checks.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sweep-acceptance-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const hex = c => c.repeat(64);
const CUR = hex('a'), OLD = hex('c'), OTHER = hex('d'), THIRD = hex('e');
const NOW = 1_800_000_000_000;
const AGED = new Date(NOW - 5 * SANDBOX_MIN_AGE_MS).toISOString();
const ASSEMBLED = 'docker.io/library/sandbox-kit-assembled';
const FOREIGN = 'other.example/team/sandbox-kit-assembled';
const row = (repository, tag, digest, extra = {}) => ({ id: digest.slice(0, 12), repository, tag, flavor: 'codex', created_at: AGED, size: 1000, ...extra });
const mine = (tag, digest, extra) => row(ASSEMBLED, tag, digest, extra);
const ref = tag => `${ASSEMBLED}:${tag}`;
let counter = 0;
const fresh = () => path.join(root, `case-${counter++}`);
const gateOf = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

// A fake sbx. `gate` pauses the first removal. `liar` makes removal report success without removing.
function world({ templates = [], sandboxes = [], gate = null, liar = false } = {}) {
  const state = { templates: [mine('0a0a0a0a0a0a0a0a', CUR), ...templates], sandboxes: [...sandboxes], calls: [], onRm: null };
  return {
    state,
    removedRefs: () => state.removed ?? [],
    sandboxRemovals: () => state.calls.filter(c => c.startsWith('rm ')),
    runSbx: async args => {
      state.calls.push(args.join(' '));
      const [a, b] = args;
      if (a === 'template' && b === 'ls') return { code: 0, stdout: JSON.stringify(state.templates), stderr: '' };
      if (a === 'ls') return { code: 0, stdout: JSON.stringify(state.sandboxes), stderr: '' };
      if (a === 'template' && b === 'rm') {
        const hit = state.templates.find(t => t.id === args[2] || `${t.repository}:${t.tag}` === args[2]);
        if (!liar) state.templates = state.templates.filter(t => t !== hit);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (a === 'rm') {
        (state.removed ??= []).push(args[2]);
        if (gate && state.calls.filter(c => c.startsWith('rm ')).length === 1) await gate.promise;
        if (!liar) state.sandboxes = state.sandboxes.filter(s => s.name !== args[2]);
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'unexpected ' + args.join(' ') };
    },
  };
}
// `clock.t` is the fake wall clock; `pins` may be an array or a function.
function rig(w, { dir = fresh(), pins = [CUR], prepare, clock = { t: NOW }, caches = null, referenced = new Set(), journal = { recorded: () => true } } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'ledger.json');
  const now = () => clock.t;
  if (prepare) prepare(createDiskLedger({ file, now }), file);
  const ledger = createDiskLedger({ file, now });
  const coordinator = createStoreCoordinator({ dir });
  const sweeper = createDiskSweeper({ ledger, coordinator, runSbx: w.runSbx, journal, pins: () => (typeof pins === 'function' ? pins() : pins),
    referenced: () => referenced, caches, measureFree: async () => null, now });
  return { ledger, sweeper, file, dir, clock, coordinator };
}
const own = (ledger, ...rows) => ledger.ownImages(rows.map(r => ({ ref: `${r.repository}:${r.tag}`, imageId: r.id })), 'created');
// The upgrade migration already ran, and the image of the current pin (which the fake store always has) is recorded.
const migrated = ledger => { own(ledger, mine('0a0a0a0a0a0a0a0a', CUR)); };
// A stopped sandbox old enough to remove, and the record the create path wrote for it.
const box = name => ({ name, id: `id-${name}`, status: 'stopped' });
const recordBox = (file, name, extra = {}) => createDiskLedger({ file, now: () => NOW - 6 * SANDBOX_MIN_AGE_MS }).recordSandbox(name, { pin: OLD, id: `id-${name}`, ...extra });
const BOX_A = 'wf-aaaaaaaaaaaaaaaa', BOX_B = 'wf-bbbbbbbbbbbbbbbb', BOX_C = 'wf-cccccccccccccccc', BOX_D = 'wf-dddddddddddddddd';

// ---- ownership: both the record and the namespace are needed

test('case 1: only a sandbox that is recorded AND in the app naming AND in the journal is removed; each part alone changes nothing', async () => {
  const unrecorded = BOX_C;                       // in naming and journal, never recorded
  const w = world({ sandboxes: [box(BOX_A), box('my-own-box'), box(unrecorded), box(BOX_D)] });
  const { sweeper } = rig(w, { journal: { recorded: name => name !== BOX_D }, prepare: (ledger, file) => { migrated(ledger); recordBox(file, BOX_A); recordBox(file, 'my-own-box'); recordBox(file, BOX_D); } });
  const summary = await sweeper.run({ trigger: 'test' });
  assert.deepEqual(w.removedRefs(), [BOX_A]);
  assert.equal(summary.removed, 1);
  assert.equal(w.state.sandboxes.length, 3, 'the others are still there');
});

// ---- paths: a recorded cache is removed only when it is a real directory directly under the cache root

test('case 3: a symlink, a look-alike sibling root and an escaping path are never followed or removed; an aliased root is fine', async () => {
  const base = fresh();
  const cacheRoot = path.join(base, 'cache');
  const evilRoot = path.join(base, 'cache-evil');
  const outside = path.join(base, 'outside');
  for (const d of [cacheRoot, evilRoot, outside]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(outside, 'sentinel'), 'keep');
  const real = path.join(cacheRoot, hex('1'));
  const link = path.join(cacheRoot, hex('2'));
  const sibling = path.join(evilRoot, hex('3'));
  const escape = path.join(cacheRoot, '..', 'outside');
  fs.mkdirSync(real); fs.writeFileSync(path.join(real, 'x'), 'x');
  fs.symlinkSync(outside, link);
  fs.mkdirSync(sibling);
  const old = new Date(NOW - 5 * SANDBOX_MIN_AGE_MS);
  const w = world();
  // The test clock is far ahead of the file times, so everything is old enough.
  const { sweeper } = rig(w, { dir: base + '-ledger', caches: () => ({ root: cacheRoot, current: hex('9'), offer: true }), prepare: ledger => {
    migrated(ledger);
    for (const dir of [real, link, sibling, escape]) ledger.ownCache(dir, 'created');
  } });
  void old;
  await sweeper.run({ trigger: 'test' });
  assert.equal(fs.existsSync(real), false, 'the real recorded cache is removed');
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'keep', 'the symlink target is untouched');
  assert.ok(fs.existsSync(sibling), 'a directory under a look-alike root is untouched');
  const alias = path.join(base, 'alias');
  fs.symlinkSync(cacheRoot, alias);
  const aliasDir = path.join(alias, hex('4'));
  fs.mkdirSync(aliasDir);
  const second = rig(world(), { dir: base + '-ledger2', caches: () => ({ root: alias, current: hex('9'), offer: true }), prepare: ledger => { migrated(ledger); ledger.ownCache(aliasDir, 'created'); } });
  await second.sweeper.run({ trigger: 'test' });
  assert.equal(fs.existsSync(aliasDir), false, 'a path through an alias of the approved root is still valid');
});

// ---- leases and crashes

test('case 6: an expired lease records nothing by itself and is dropped; an unrecorded image is never adopted', async () => {
  const started = NOW - 10 * 60 * 1000;
  const w = world();
  const clock = { t: NOW };
  const { sweeper, ledger } = rig(w, { clock, prepare: (l) => { migrated(l); } });
  // The crashed process left a lease that began ten minutes ago and has expired.
  const old = createDiskLedger({ file: ledger.file, now: () => started });
  old.acquireLease({ item: 'image:*', ttlMs: 60_000 });
  await sweeper.run({ trigger: 'test' });
  assert.equal(ledger.expiredLeases().length, 0, 'an expired lease protects nothing and is dropped');
  w.state.templates.push(mine('3333333333333333', OTHER, { created_at: new Date(started + 5000).toISOString() }));
  clock.t = NOW + 60 * 1000;
  await sweeper.run({ trigger: 'test' });
  assert.equal(ledger.ownedImages()[ref('3333333333333333')], undefined, 'an image no one recorded is never adopted');
  clock.t = NOW + 3 * 60 * 60 * 1000;
  await sweeper.run({ trigger: 'test' });
  assert.equal(ledger.expiredLeases().length, 0, 'no expired lease remains');
  assert.deepEqual(w.removedRefs(), [], 'and the unrecorded image is still there');
});

test('case 7: a lease whose holder died still protects until it expires; then the item is eligible', async () => {
  const clock = { t: NOW };
  const w = world({ sandboxes: [box(BOX_A)] });
  const { sweeper } = rig(w, { clock, prepare: (ledger, file) => {
    migrated(ledger); recordBox(file, BOX_A);
    const holder = createDiskLedger({ file, now: () => NOW - 10_000 });
    holder.acquireLease({ item: 'sandbox:*', ttlMs: 10 * 60 * 1000 }); // the holder is gone and never renews
  } });
  const before = await sweeper.run({ trigger: 'test' });
  assert.deepEqual(w.removedRefs(), [], 'a dead holder does not shorten its lease');
  assert.ok(before.kept.create_in_flight >= 1, 'the lease is the reason');
  clock.t = NOW + 10 * 60 * 1000 + 1;
  await sweeper.run({ trigger: 'test' });
  assert.deepEqual(w.removedRefs(), [BOX_A]);
});

test('case 8: exact boundaries of the lease expiry and of the minimum ages', () => {
  const roots = { current: new Set([CUR]), previous: new Set(), sandboxes: new Map(), referenced: new Set(), cacheKeep: new Set() };
  const anchor = { id: 'image:a', kind: 'image', ref: 'a', imageId: CUR.slice(0, 12), createdAt: 0, bytes: 1 };
  const image = (tag, age) => ({ id: `image:${tag}`, kind: 'image', ref: tag, imageId: OLD.slice(0, 12), createdAt: NOW - age, bytes: 1 });
  const verdict = (item, leases = []) => planSweep({ owned: [anchor, item], roots, leases, now: NOW }).delete.some(d => d.id === item.id) ? 'delete' : 'keep';
  assert.equal(verdict(image('exact', SWEEP_MIN_AGE_MS)), 'delete', 'an image exactly the minimum age is old enough');
  assert.equal(verdict(image('under', SWEEP_MIN_AGE_MS - 1)), 'keep');
  assert.equal(verdict(image('leased', 5 * SWEEP_MIN_AGE_MS), [{ id: 'l', item: 'image:*', expiresAt: NOW + 1 }]), 'keep', 'active lease protects an old item');
  assert.equal(verdict(image('expired', 5 * SWEEP_MIN_AGE_MS), [{ id: 'l', item: 'image:*', expiresAt: NOW }]), 'delete', 'a lease ends at its expiry instant');
  const sandbox = age => ({ id: 'sandbox:wf-aaaaaaaaaaaaaaaa', kind: 'sandbox', ref: 'wf-aaaaaaaaaaaaaaaa', status: 'stopped', createdAt: NOW - age, bytes: null });
  assert.equal(verdict(sandbox(SANDBOX_MIN_AGE_MS)), 'delete');
  assert.equal(verdict(sandbox(SANDBOX_MIN_AGE_MS - 1)), 'keep');
});

test('case 9: a lease that was dropped is not resurrected by a renewal, and releasing one lease never releases another', () => {
  const dir = fresh(); fs.mkdirSync(dir);
  const ledger = createDiskLedger({ file: path.join(dir, 'ledger.json') });
  const first = ledger.acquireLease({ item: 'image:*', ttlMs: 60_000 });
  ledger.dropLeases([first]);
  assert.equal(ledger.renewLease(first, 60_000), false, 'a stale holder cannot bring its lease back');
  const second = ledger.acquireLease({ item: 'image:*', ttlMs: 60_000 });
  ledger.releaseLease(first);
  assert.deepEqual(ledger.activeLeases().map(l => l.id), [second], 'the stale holder cannot release the successor');
});

// ---- the store lock across real processes

const CHILD = `
import { createStoreCoordinator } from ${JSON.stringify(new URL('../lib/store-lock.mjs', import.meta.url).href)};
const c = createStoreCoordinator({ dir: process.argv[1] });
const which = process.argv[2];
const hold = () => new Promise(() => { setInterval(() => {}, 1000); process.stdout.write('held\\n'); });
if (which === 'sweep') await c.sweep(hold); else await c.exclusive(hold);
`;
function holder(dir, which) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, dir, which], { stdio: ['ignore', 'pipe', 'inherit'] });
  const ready = new Promise((resolve, reject) => { child.stdout.on('data', resolve); child.on('exit', () => reject(new Error('holder exited early'))); });
  return { child, ready };
}
const exited = child => new Promise(resolve => (child.exitCode !== null || child.signalCode ? resolve() : child.on('exit', resolve)));

test('case 10: a sweep in another process excludes this one; after that process is killed the lock is taken over', async () => {
  const dir = fresh(); fs.mkdirSync(dir);
  const { child, ready } = holder(dir, 'sweep');
  await ready;
  const mineCoordinator = createStoreCoordinator({ dir });
  assert.deepEqual(await mineCoordinator.sweep(async () => 'ran'), { skipped: 'store_busy' }, 'a live holder in another process excludes the sweep');
  child.kill('SIGKILL');
  await exited(child);
  assert.equal(await mineCoordinator.sweep(async () => 'ran'), 'ran', 'a dead holder does not block the store');
});

test('case 10: the dispatch lock excludes another process, and is released by that process dying', async () => {
  const dir = fresh(); fs.mkdirSync(dir);
  const { child, ready } = holder(dir, 'dispatch');
  await ready;
  const mineCoordinator = createStoreCoordinator({ dir });
  await assert.rejects(mineCoordinator.exclusive(async () => 'ran', { waitMs: 150 }), error => error.code === 'store_busy');
  child.kill('SIGKILL');
  await exited(child);
  assert.equal(await mineCoordinator.exclusive(async () => 'ran', { waitMs: 2000 }), 'ran');
});

// ---- plan, then act: the world may change in between

test('case 11: a create that waits for a removal in progress gets its lease first, so the next candidate is no longer removable', async () => {
  const gate = gateOf();
  const w = world({ gate, sandboxes: [box(BOX_A), box(BOX_B)] });
  const { sweeper, ledger, coordinator } = rig(w, { prepare: (l, file) => { migrated(l); recordBox(file, BOX_A); recordBox(file, BOX_B); } });
  const run = sweeper.run({ trigger: 'test' });
  while (w.removedRefs().length < 1) await tick();
  // A create now asks for the coordination point the removal holds.
  const events = [];
  const create = coordinator.exclusive(async () => { events.push('lease'); return ledger.acquireLease({ item: 'sandbox:*', ttlMs: 60_000 }); }, { waitMs: 5000 });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(events, [], 'the create waits while a removal is in flight');
  gate.release();
  await create;
  await run;
  assert.equal(w.removedRefs().length, 1, 'the create wins the next turn; the second candidate stays');
});

test('case 13: an update with no readable pins keeps the old roots', async () => {
  const w = world({ templates: [] });
  let pins = [CUR];
  const { sweeper } = rig(w, { pins: () => pins, prepare: migrated });
  await sweeper.run({ trigger: 'test' });
  pins = [];
  await sweeper.run({ trigger: 'test' });
  assert.deepEqual(w.removedRefs(), [], 'the current-pin image survives a read that found no pins');
});

test('case 17: a ledger of an unknown version means no removal and the file is left as it was', async () => {
  const A = mine('1111111111111111', OLD);
  const w = world({ templates: [A] });
  const dir = fresh(); fs.mkdirSync(dir);
  const text = JSON.stringify({ version: 3, owned: { images: { [ref('1111111111111111')]: { imageId: OLD.slice(0, 12) } } } });
  const { sweeper, file } = rig(w, { dir, prepare: (l, file) => fs.writeFileSync(file, text) });
  const summary = await sweeper.run({ trigger: 'test' });
  assert.deepEqual(w.removedRefs(), []);
  assert.ok(summary.errors.some(error => error.item === 'ledger'));
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('case 18: a sandbox whose listed id is not the recorded one is not ours, before or during a sweep', async () => {
  const rebound = { name: BOX_A, id: 'another-id', status: 'stopped' };
  const w = world({ sandboxes: [rebound] });
  const { sweeper } = rig(w, { prepare: (ledger, file) => { migrated(ledger); recordBox(file, BOX_A); } });
  await sweeper.run({ trigger: 'test' });
  assert.deepEqual(w.removedRefs(), [], 'the recorded id no longer matches');

  const gate = gateOf();
  const w2 = world({ gate, sandboxes: [box(BOX_A), box(BOX_B)] });
  const { sweeper: sweeper2 } = rig(w2, { prepare: (ledger, file) => { migrated(ledger); recordBox(file, BOX_A); recordBox(file, BOX_B); } });
  const run = sweeper2.run({ trigger: 'test' });
  while (w2.removedRefs().length < 1) await tick();
  w2.state.sandboxes = w2.state.sandboxes.map(t => (t.name === BOX_B ? { ...t, id: 'replaced' } : t));
  gate.release();
  await run;
  assert.equal(w2.removedRefs().length, 1, 'a name that now means another sandbox is not removed');
});

test('case 21: a pressure sweep with everything rooted removes nothing and says so', async () => {
  const w = world({ templates: [], sandboxes: [{ name: 'wf-aaaaaaaaaaaaaaaa', status: 'running' }] });
  const { sweeper } = rig(w, { prepare: migrated });
  const summary = await sweeper.run({ trigger: 'pressure' });
  assert.equal(summary.removed, 0);
  assert.deepEqual(w.removedRefs().concat(w.sandboxRemovals()), []);
});

test('case 27: a removal that reports success while the item is still listed is not counted as removed', async () => {
  const w = world({ liar: true, sandboxes: [box(BOX_A)] });
  const { sweeper } = rig(w, { prepare: (ledger, file) => { migrated(ledger); recordBox(file, BOX_A); } });
  const summary = await sweeper.run({ trigger: 'test' });
  assert.equal(summary.removed, 0, 'no false removed count');
  assert.ok(summary.errors.some(error => error.item === BOX_A && /still listed/i.test(error.message)), 'the failure is visible');
});

test('case 27: a removal that works is counted once, after the item is verified gone', async () => {
  const w = world({ sandboxes: [box(BOX_A)] });
  const { sweeper } = rig(w, { prepare: (ledger, file) => { migrated(ledger); recordBox(file, BOX_A); } });
  const summary = await sweeper.run({ trigger: 'test' });
  assert.equal(summary.removed, 1);
  assert.deepEqual(summary.errors, []);
});
