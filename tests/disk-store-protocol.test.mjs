import './helpers/no-browser.mjs';
import './helpers/removal-on.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiskLedger } from '../lib/disk-ledger.mjs';
import { createDiskSweeper } from '../lib/disk-sweep.mjs';
import { createStoreCoordinator } from '../lib/store-lock.mjs';
import { openDiskStore, diskLedgerFile } from '../lib/disk-store.mjs';
import { tryLock, tryLockAsync, stallHelper, killHelper } from '../lib/os-lock.mjs';
import { diskLines, diskReportOf } from '../lib/disk-report.mjs';
import { freshSandboxName } from '../lib/sandbox-name.mjs';
import { SANDBOX_MIN_AGE_MS } from '../lib/disk-sweep-plan.mjs';

// The store protocol: one store per sbx HOME, effects that are not terminal until a listing says so,
// a lock helper that cannot wedge its caller, and entries the app did not create are never touched.
// The real sweeper, ledger and lock are used; the sbx command line is a fake.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-store-protocol-'));
test.after(() => { killHelper(); fs.rmSync(root, { recursive: true, force: true }); });
const hex = c => c.repeat(64);
const CUR = hex('a'), OLD = hex('c'), OTHER = hex('d');
const NOW = 1_800_000_000_000;
const AGED = new Date(NOW - 5 * SANDBOX_MIN_AGE_MS).toISOString();
const ASSEMBLED = 'docker.io/library/sandbox-kit-assembled';
const row = (tag, digest, extra = {}) => ({ id: digest.slice(0, 12), repository: ASSEMBLED, tag, flavor: 'codex', created_at: AGED, size: 1000, ...extra });
const ref = tag => `${ASSEMBLED}:${tag}`;
let counter = 0;
const fresh = () => { const dir = path.join(root, `case-${counter++}`); fs.mkdirSync(dir, { recursive: true }); return dir; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const own = (ledger, ...rows) => ledger.ownImages(rows.map(r => ({ ref: `${r.repository}:${r.tag}`, imageId: r.id })), 'created');
const migrated = ledger => own(ledger, row('0a0a0a0a0a0a0a0a', CUR));

// A fake sbx. `rm` decides what `template rm` answers; `listing` can be made unreadable.
function world({ templates = [], sandboxes = [], rm = null, listing = null, sbxRm = null } = {}) {
  const state = { templates: [row('0a0a0a0a0a0a0a0a', CUR), ...templates], sandboxes: [...sandboxes], calls: [] };
  return {
    state,
    calls: prefix => state.calls.filter(call => call.startsWith(prefix)),
    runSbx: async args => {
      state.calls.push(args.join(' '));
      const [a, b] = args;
      if (a === 'template' && b === 'ls') return listing ? listing() : { code: 0, stdout: JSON.stringify(state.templates), stderr: '' };
      if (a === 'ls') return { code: 0, stdout: JSON.stringify(state.sandboxes), stderr: '' };
      if (a === 'template' && b === 'rm') {
        if (rm) return rm(args, state);
        state.templates = state.templates.filter(t => t.id !== args[2]);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (a === 'rm' && sbxRm) return sbxRm(args, state);
      if (a === 'rm') { state.sandboxes = state.sandboxes.filter(s => s.name !== args[2]); return { code: 0, stdout: '', stderr: '' }; }
      return { code: 1, stdout: '', stderr: 'unexpected ' + args.join(' '), exited: true };
    },
  };
}
function rig(w, { dir = fresh(), prepare, clock = { t: NOW }, caches = null, usage = null, retained } = {}) {
  const file = path.join(dir, 'ledger.json');
  const now = () => clock.t;
  if (prepare) prepare(createDiskLedger({ file, now }), file);
  const ledger = createDiskLedger({ file, now });
  const coordinator = createStoreCoordinator({ dir });
  const sweeper = createDiskSweeper({ ledger, coordinator, runSbx: w.runSbx, journal: { recorded: () => true }, pins: () => [CUR],
    referenced: () => new Set(), ...(retained ? { retained } : {}), caches, usage, measureFree: async () => null, now });
  return { ledger, sweeper, file, dir, clock, coordinator };
}
const recordedAged = (file, name, extra) => createDiskLedger({ file, now: () => NOW - 6 * SANDBOX_MIN_AGE_MS }).recordSandbox(name, { pin: OLD, ...extra });

// ---------------------------------------------------------------- one store per sbx HOME

test('store: every opener of one sbx HOME gets the same ledger and the same gate, whatever its profile', () => {
  const home = fresh();
  const a = openDiskStore({ home, legacyLedgerFile: path.join(fresh(), 'v1', 'disk-ledger.json') });
  const b = openDiskStore({ home, legacyLedgerFile: path.join(fresh(), 'v1', 'disk-ledger.json') });
  assert.equal(a.ledger, b.ledger);
  assert.equal(a.coordinator, b.coordinator);
  assert.equal(a.ledger.file, diskLedgerFile(home), 'the record lives in the sbx HOME');
  const other = openDiskStore({ home: fresh() });
  assert.notEqual(other.ledger, a.ledger);
});

test('store: a protection written through one opener is on disk for a process that reads the same HOME', () => {
  const home = fresh();
  openDiskStore({ home }).ledger.acquireLease({ item: 'sandbox:wf-aaaaaaaaaaaaaaaa', ttlMs: 60_000 });
  assert.equal(createDiskLedger({ file: diskLedgerFile(home) }).activeLeases().length, 1);
});

test('store: a store with no record owns nothing and is not damaged', () => {
  const store = openDiskStore({ home: fresh() });
  assert.equal(store.ledger.damaged, false);
  assert.deepEqual(store.ledger.ownedImages(), {});
});

test('store: an earlier release record in the profile directory is migrated under the gate: roots kept, ownership dropped, never damaged', async () => {
  const home = fresh();
  const legacy = path.join(fresh(), 'v1', 'disk-ledger.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  const at = NOW;
  fs.writeFileSync(legacy, JSON.stringify({
    version: 2, leases: {}, sandboxes: { 'wf-aaaaaaaaaaaaaaaa': { pin: OLD, createdAt: at, cache: null } },
    pins: { current: [CUR], previous: [] }, lastSweep: null,
    owned: { images: { [ref('1111111111111111')]: { imageId: OLD.slice(0, 12), reason: 'adopted', at } }, caches: {} },
  }));
  const before = fs.readFileSync(legacy, 'utf8');
  const store = openDiskStore({ home, legacyLedgerFile: legacy });
  assert.equal(store.ledger.damaged, false, 'a normal upgrade is not damage');
  assert.ok(store.ledger.sandbox('wf-aaaaaaaaaaaaaaaa'), 'the sandbox root is kept');
  assert.equal(store.ledger.sandbox('wf-aaaaaaaaaaaaaaaa').id, null, 'with no id it roots its image but is not removable');
  assert.deepEqual(store.ledger.ownedImages(), {}, 'ownership nobody proved is dropped, not adopted');
  await store.coordinator.exclusive(async () => { store.ledger.notePins([CUR]); });
  assert.equal(JSON.parse(fs.readFileSync(diskLedgerFile(home), 'utf8')).version, 3, 'the first change writes the new version into the HOME');
  assert.equal(fs.readFileSync(legacy, 'utf8'), before, 'the old file is never changed');
});

// ---------------------------------------------------------------- an effect is terminal only when proved

const BOX = 'wf-cccccccccccccccc';
const oldOwned = () => ({ box: { name: BOX, id: 'id-1', status: 'stopped' }, prepare: (l, f) => { migrated(l); recordedAged(f, BOX, { id: 'id-1' }); } });

test('effect: a transport error on a removal leaves the record open, and no clock closes it', async () => {
  const { box, prepare } = oldOwned();
  const w = world({ sandboxes: [box], sbxRm: () => { throw new Error('socket hang up'); } });
  const clock = { t: NOW };
  const { sweeper, ledger } = rig(w, { prepare, clock });
  await sweeper.run({ trigger: 'test' });
  assert.equal(ledger.openOps().length, 1);
  clock.t += 90 * 24 * 3600 * 1000;
  await sweeper.run({ trigger: 'test' });
  assert.ok(ledger.openOps().length >= 1, 'ninety days later the effect is still unknown');
  assert.equal(w.calls('rm ').length, 1, 'the command is never sent a second time');
});

test('effect: a command that timed out (no exit code) is unknown, not a refusal', async () => {
  const { box, prepare } = oldOwned();
  const w = world({ sandboxes: [box], sbxRm: () => ({ code: 124, stdout: '', stderr: 'timed out' }) });
  const { sweeper, ledger } = rig(w, { prepare });
  await sweeper.run({ trigger: 'test' });
  assert.equal(ledger.openOps().length, 1);
});

test('effect: a clean refusal (the command exited non-zero) is terminal and closes the record', async () => {
  const { box, prepare } = oldOwned();
  const w = world({ sandboxes: [box], sbxRm: () => ({ code: 1, stdout: '', stderr: 'in use', exited: true }) });
  const { sweeper, ledger } = rig(w, { prepare });
  await sweeper.run({ trigger: 'test' });
  assert.equal(ledger.openOps().length, 0);
});

test('effect: a command that exited 0 while the sandbox is still listed is not a removal', async () => {
  const { box, prepare } = oldOwned();
  const w = world({ sandboxes: [box], sbxRm: () => ({ code: 0, stdout: '', stderr: '' }) });
  const { sweeper, ledger } = rig(w, { prepare });
  const summary = await sweeper.run({ trigger: 'test' });
  assert.equal(summary.removed, 0);
  assert.equal(ledger.openOps().length, 1);
});

test('effect: an unreadable listing (EACCES) does not prove absence: the open record stays and nothing else is removed', async () => {
  const { box, prepare } = oldOwned();
  const w = world({ sandboxes: [box], listing: () => ({ code: 1, stdout: '', stderr: 'EACCES: permission denied', exited: true }) });
  const { sweeper, ledger } = rig(w, { prepare: (l, f) => { prepare(l, f); createDiskLedger({ file: f, now: () => NOW }).beginOp({ kind: 'sandbox', ref: BOX, sandboxId: 'id-1' }); } });
  await sweeper.run({ trigger: 'test' });
  assert.equal(ledger.openOps().length, 1, 'not proved gone');
  assert.deepEqual(w.calls('rm '), [], 'nothing is removed on a snapshot that cannot be read');
});

test('images and logs: the sweep never removes an image or rotates a log, whatever their age or size', async () => {
  const A = row('1111111111111111', OLD);
  const dir = fresh();
  const logs = path.join(dir, 'logs');
  fs.mkdirSync(logs);
  const big = path.join(logs, 'daemon.log');
  fs.writeFileSync(big, 'x'); fs.truncateSync(big, 6 * 1024 * 1024);
  const w = world({ templates: [A] });
  const { sweeper } = rig(w, { dir, usage: { logsDir: logs }, prepare: l => { migrated(l); own(l, A); } });
  await sweeper.run({ trigger: 'test' });
  assert.deepEqual(w.calls('template rm'), []);
  assert.equal(fs.existsSync(`${big}.1`), false);
  assert.ok(fs.existsSync(big));
});

// ---------------------------------------------------------------- sandbox identity

const sandboxCase = async ({ recordedId, listedId, status = 'stopped' }) => {
  const name = 'wf-cccccccccccccccc';
  const w = world({ sandboxes: [{ name, id: listedId, status }] });
  const { sweeper } = rig(w, { prepare: (l, f) => { migrated(l); recordedAged(f, name, { id: recordedId }); } });
  await sweeper.run({ trigger: 'test' });
  return w.calls('rm ');
};

test('sandbox: removed by name only when the id recorded at create is the id listed now and it is stopped', async () => {
  assert.deepEqual(await sandboxCase({ recordedId: 'id-1', listedId: 'id-1' }), ['rm --force wf-cccccccccccccccc']);
});
test('sandbox: a listed id that differs from the recorded one is another sandbox: not removed', async () => {
  assert.deepEqual(await sandboxCase({ recordedId: 'id-1', listedId: 'id-2' }), []);
});
test('sandbox: a record with no id (an earlier release, or an unreadable listing at create) is not removable', async () => {
  assert.deepEqual(await sandboxCase({ recordedId: null, listedId: 'id-1' }), []);
});
test('sandbox: a running sandbox is never removed, whatever its id', async () => {
  assert.deepEqual(await sandboxCase({ recordedId: 'id-1', listedId: 'id-1', status: 'running' }), []);
});

test('sandbox: the app never mints a name twice: each create gets a fresh random name, so a name with a record is never created again', () => {
  const names = new Set();
  for (let i = 0; i < 20_000; i++) names.add(freshSandboxName());
  assert.equal(names.size, 20_000);
  for (const name of names) assert.match(name, /^wf-[0-9a-f]{16}$/);
});

// ---------------------------------------------------------------- entries the app did not create are never touched

const lastSweepLines = ledger => diskLines(diskReportOf(ledger.lastSweep())).join('\n');

test('foreign image: an old assembled image nobody recorded survives and is reported as unknown, not touched', async () => {
  const F = row('9999999999999999', OTHER);
  const w = world({ templates: [F] });
  const { sweeper, ledger } = rig(w, { prepare: migrated });
  const summary = await sweeper.run({ trigger: 'test' });
  assert.deepEqual(w.calls('template rm'), []);
  assert.ok(w.state.templates.some(t => t.tag === '9999999999999999'));
  assert.equal(summary.notTouched.images.count, 1);
  assert.match(lastSweepLines(ledger), /Unknown, not touched: 1 image/);
});

test('foreign image: a look-alike repository is not ours even when its tag is recorded', async () => {
  const F = row('9999999999999999', OTHER, { repository: 'other.example/x/sandbox-kit-assembled' });
  const w = world({ templates: [F] });
  const { sweeper } = rig(w, { prepare: l => { migrated(l); l.ownImages([{ ref: 'other.example/x/sandbox-kit-assembled:9999999999999999', imageId: F.id }], 'created'); } });
  await sweeper.run({ trigger: 'test' });
  assert.deepEqual(w.calls('template rm'), []);
});

test('foreign image: a recorded tag that now names another image id is not ours any more', async () => {
  const mine = row('1111111111111111', OLD);
  const moved = row('1111111111111111', OTHER);
  const w = world({ templates: [moved] });
  const { sweeper } = rig(w, { prepare: l => { migrated(l); own(l, mine); } });
  await sweeper.run({ trigger: 'test' });
  assert.deepEqual(w.calls('template rm'), []);
});

test('foreign sandbox: an old stopped sandbox with no record survives and is reported as unknown, not touched', async () => {
  const name = 'wf-dddddddddddddddd';
  const w = world({ sandboxes: [{ name, id: 'x', status: 'stopped' }] });
  const { sweeper, ledger } = rig(w, { prepare: migrated });
  const summary = await sweeper.run({ trigger: 'test' });
  assert.deepEqual(w.calls('rm '), []);
  assert.equal(summary.notTouched.sandboxes.count, 1);
  assert.match(lastSweepLines(ledger), /Unknown, not touched: 1 sandbox/);
});

test('foreign sandbox: a sandbox outside the app naming survives even with a record and a matching id', async () => {
  const name = 'my-own-sandbox';
  const w = world({ sandboxes: [{ name, id: 'x', status: 'stopped' }] });
  const { sweeper } = rig(w, { prepare: (l, f) => { migrated(l); recordedAged(f, name, { id: 'x' }); } });
  await sweeper.run({ trigger: 'test' });
  assert.deepEqual(w.calls('rm '), []);
});

function cacheCase(record) {
  const dir = fresh();
  const cacheRoot = path.join(dir, 'guest-runtime');
  const D = hex('7');
  fs.mkdirSync(path.join(cacheRoot, D), { recursive: true });
  const old = new Date(NOW - 5 * 60 * 60 * 1000);
  fs.utimesSync(path.join(cacheRoot, D), old, old);
  const w = world({});
  const r = rig(w, { dir, caches: () => ({ root: cacheRoot, current: hex('f'), offer: true }), prepare: l => { migrated(l); if (record) l.ownCache(path.join(cacheRoot, D), 'created'); } });
  return { ...r, w, exists: () => fs.existsSync(path.join(cacheRoot, D)) };
}

test('foreign cache: a runtime directory nobody recorded survives and is reported as unknown, not touched', async () => {
  const c = cacheCase(false);
  const summary = await c.sweeper.run({ trigger: 'test' });
  assert.equal(c.exists(), true);
  assert.equal(summary.notTouched.caches.count, 1);
  assert.match(lastSweepLines(c.ledger), /Unknown, not touched: 1 cache/);
});

test('foreign cache: the recorded one, in contrast, is removed when nothing uses it', async () => {
  const c = cacheCase(true);
  await c.sweeper.run({ trigger: 'test' });
  assert.equal(c.exists(), false);
});

test('cache reuse: a runtime directory protected under the gate after the sweeper read its roots survives', async () => {
  const dir = fresh();
  const cacheRoot = path.join(dir, 'guest-runtime');
  const D = hex('8');
  fs.mkdirSync(path.join(cacheRoot, D), { recursive: true });
  const old = new Date(NOW - 5 * 60 * 60 * 1000);
  fs.utimesSync(path.join(cacheRoot, D), old, old);
  const w = world({});
  let reuse;
  const r = rig(w, { dir, prepare: l => { migrated(l); l.ownCache(path.join(cacheRoot, D), 'created'); },
    // The sweeper is in cache enumeration when a second process takes the gate and protects D for its job.
    caches: () => ({ root: cacheRoot, current: hex('f'), offer: true }) });
  const other = createStoreCoordinator({ dir });
  const second = createDiskLedger({ file: r.file, now: () => NOW });
  const slow = createDiskSweeper({ ledger: r.ledger, coordinator: r.coordinator, runSbx: async args => { if (args[0] === 'template' && args[1] === 'ls' && !reuse) { reuse = other.exclusive(async () => { second.acquireLease({ item: `cache:${path.join(cacheRoot, D)}`, ttlMs: 600_000 }); }); await reuse; } return w.runSbx(args); },
    journal: { recorded: () => true }, pins: () => [CUR], referenced: () => new Set(), caches: () => ({ root: cacheRoot, current: hex('f'), offer: true }), measureFree: async () => null, now: () => NOW });
  await slow.run({ trigger: 'test' });
  assert.equal(fs.existsSync(path.join(cacheRoot, D)), true, 'D is protected before it is reused, so the sweep keeps it');
});

// ---------------------------------------------------------------- the lock helper

test('lock: a request whose signal is already aborted is refused before the helper is asked', async () => {
  const file = path.join(fresh(), 'a.lock');
  await assert.rejects(tryLockAsync(file, { signal: AbortSignal.abort() }));
  const handle = await tryLockAsync(file, {});
  assert.ok(handle, 'the name was never taken by the refused request');
  handle.release();
});

test('lock: an abort while waiting gives the request up at once, and the lock is free afterwards', async () => {
  const file = path.join(fresh(), 'b.lock');
  const controller = new AbortController();
  stallHelper(400);
  const pending = tryLockAsync(file, { signal: controller.signal, timeoutMs: 5000 });
  setTimeout(() => controller.abort(), 30);
  const started = Date.now();
  await assert.rejects(pending);
  assert.ok(Date.now() - started < 300, 'the caller did not wait for the stalled helper');
  await sleep(500);
  const handle = await tryLockAsync(file, {});
  assert.ok(handle, 'a grant that arrived after the abort released itself');
  handle.release();
});

test('lock: a stalled helper cannot hold the caller past its own deadline, and the event loop keeps running', async () => {
  const dir = fresh();
  const coordinator = createStoreCoordinator({ dir });
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 20);
  stallHelper(1500);
  const started = Date.now();
  await assert.rejects(coordinator.exclusive(async () => {}, { signal: AbortSignal.timeout(300) }));
  const spent = Date.now() - started;
  clearInterval(timer);
  assert.ok(spent < 900, `the request ended at its cutoff (${spent} ms)`);
  assert.ok(ticks >= 5, `the main thread was not blocked (${ticks} ticks)`);
  await sleep(1400);
  await coordinator.exclusive(async () => {}, {});          // the store is usable again
});

test('lock: the synchronous attempt gives up within a bounded time when the helper is stalled', () => {
  const file = path.join(fresh(), 'c.lock');
  stallHelper(1200);
  const started = Date.now();
  assert.throws(() => tryLock(file), error => error.code === 'lock_unavailable');
  assert.ok(Date.now() - started < 1500, 'far below the old ten-second wait');
});

test('lock: when the helper stops, a held lock is reported lost and a waiting request fails closed', async () => {
  const file = path.join(fresh(), 'd.lock');
  const held = await tryLockAsync(file, {});
  assert.equal(held.held(), true);
  await sleep(1300);                                         // let an earlier stall end
  stallHelper(2000);
  const waiting = tryLockAsync(path.join(fresh(), 'e.lock'), { timeoutMs: 5000 });
  killHelper();
  await assert.rejects(waiting, error => error.code === 'lock_unavailable');
  assert.equal(held.held(), false, 'a lock the helper held is no longer claimed');
  held.release();
  const next = await tryLockAsync(path.join(fresh(), 'f.lock'), {});
  assert.ok(next, 'a new helper starts for the next request');
  next.release();
});
