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
import { createStoreCoordinator, withFileLockSync } from '../lib/store-lock.mjs';
import { SANDBOX_MIN_AGE_MS } from '../lib/disk-sweep-plan.mjs';

// Failing sequences from the third safety review of the disk sweep, one group per defect
// class. Every test drives the real sweeper, ledger and store lock; the sbx command line is a
// fake, and a real child process stands in wherever a crash or a second process matters.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-delete-p1-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const hex = c => c.repeat(64);
const CUR = hex('a'), OLD = hex('c'), OTHER = hex('d');
const NOW = 1_800_000_000_000;
const AGED = new Date(NOW - 5 * SANDBOX_MIN_AGE_MS).toISOString();
const ASSEMBLED = 'docker.io/library/sandbox-kit-assembled';
const row = (tag, digest, extra = {}) => ({ id: digest.slice(0, 12), repository: ASSEMBLED, tag, flavor: 'codex', created_at: AGED, size: 1000, ...extra });
const ref = tag => `${ASSEMBLED}:${tag}`;
let counter = 0;
const fresh = () => { const dir = path.join(root, `case-${counter++}`); fs.mkdirSync(dir, { recursive: true }); return dir; };
const gateOf = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, what, ms = 4000) => { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await tick(); } };

// A fake sbx. `rmGate` holds the effect of the first removal (the command is "in flight" until
// released); `effectAfterAbort` makes the removal ignore the abort signal and land late.
function world({ templates = [], sandboxes = [], rmGate = null } = {}) {
  const state = { templates: [row('0a0a0a0a0a0a0a0a', CUR), ...templates], sandboxes: [...sandboxes], calls: [], times: [] };
  const log = args => { state.calls.push(args.join(' ')); state.times.push(Date.now()); };
  return {
    state,
    removedRefs: () => state.removed ?? [],
    sandboxRemovals: () => state.calls.filter(c => c.startsWith('rm ')),
    runSbx: async args => {
      log(args);
      const [a, b] = args;
      if (a === 'template' && b === 'ls') return { code: 0, stdout: JSON.stringify(state.templates), stderr: '' };
      if (a === 'ls') return { code: 0, stdout: JSON.stringify(state.sandboxes), stderr: '' };
      if (a === 'template' && b === 'rm') {
        const hit = state.templates.find(t => t.id === args[2] || `${t.repository}:${t.tag}` === args[2]);
        state.templates = state.templates.filter(t => t !== hit);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (a === 'rm') {
        (state.removed ??= []).push(args[2]);
        if (rmGate && state.calls.filter(c => c.startsWith('rm ')).length === 1) await rmGate.promise;
        state.sandboxes = state.sandboxes.filter(s => s.name !== args[2]);
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'unexpected ' + args.join(' ') };
    },
  };
}
function rig(w, { dir = fresh(), pins = [CUR], prepare, clock = { t: NOW }, caches = null, referenced = new Set(), retained, journal = { recorded: () => true }, coordinator, usage = null } = {}) {
  const file = path.join(dir, 'ledger.json');
  const now = () => clock.t;
  if (prepare) prepare(createDiskLedger({ file, now }), file);
  const ledger = createDiskLedger({ file, now });
  coordinator ??= createStoreCoordinator({ dir });
  const sweeper = createDiskSweeper({ ledger, coordinator, runSbx: w.runSbx, journal, pins: () => (typeof pins === 'function' ? pins() : pins),
    referenced: () => referenced, ...(retained ? { retained } : {}), caches, usage, measureFree: async () => null, now });
  return { ledger, sweeper, file, dir, clock, coordinator };
}
const own = (ledger, ...rows) => ledger.ownImages(rows.map(r => ({ ref: `${r.repository}:${r.tag}`, imageId: r.id })), 'created');
const migrated = ledger => { own(ledger, row('0a0a0a0a0a0a0a0a', CUR)); };
// A stopped sandbox old enough to remove, and the record the create path wrote for it.
const box = name => ({ name, id: `id-${name}`, status: 'stopped' });
const recordBox = (file, name, extra = {}) => createDiskLedger({ file, now: () => NOW - 6 * SANDBOX_MIN_AGE_MS }).recordSandbox(name, { pin: OLD, id: `id-${name}`, ...extra });
const BOX_A = 'wf-aaaaaaaaaaaaaaaa';

// ---------------------------------------------------------------- class 1: a live holder is never displaced

test('class 1: a coordinator inside exclusive() keeps the dispatch lock after the clock passes dispatchStaleMs', async () => {
  const dir = fresh();
  const clock = { t: NOW };
  const a = createStoreCoordinator({ dir, now: () => clock.t, dispatchStaleMs: 1000 });
  const b = createStoreCoordinator({ dir, now: () => clock.t, dispatchStaleMs: 1000 });
  const inside = gateOf();
  let aInside = false, bEntered = false;
  const first = a.exclusive(async () => { aInside = true; await inside.promise; aInside = false; });
  await until(() => aInside, 'A inside exclusive');
  clock.t += 10 * 60 * 60 * 1000;
  await assert.rejects(b.exclusive(async () => { bEntered = true; assert.equal(aInside, false, 'B entered while A was still inside'); }, { waitMs: 250 }), error => error.code === 'store_busy');
  assert.equal(bEntered, false, 'a live holder is never reclaimed by age');
  inside.release();
  await first;
});

test('class 1: a coordinator inside sweep() keeps the sweep lock after the clock passes sweepStaleMs', async () => {
  const dir = fresh();
  const clock = { t: NOW };
  const a = createStoreCoordinator({ dir, now: () => clock.t, sweepStaleMs: 1000 });
  const b = createStoreCoordinator({ dir, now: () => clock.t, sweepStaleMs: 1000 });
  const inside = gateOf();
  let aInside = false;
  const first = a.sweep(async () => { aInside = true; await inside.promise; aInside = false; });
  await until(() => aInside, 'A inside sweep');
  clock.t += 24 * 60 * 60 * 1000;
  let bRan = false;
  const second = await b.sweep(async () => { bRan = true; });
  assert.deepEqual(second, { skipped: 'store_busy' });
  assert.equal(bRan, false);
  inside.release();
  await first;
});

const HOLD_LEDGER_LOCK = `
import { withFileLockSync } from ${JSON.stringify(new URL('../lib/store-lock.mjs', import.meta.url).href)};
withFileLockSync(process.argv[1], () => { process.stdout.write('held\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); });
`;
const HOLD_DISPATCH = `
import { createStoreCoordinator } from ${JSON.stringify(new URL('../lib/store-lock.mjs', import.meta.url).href)};
const c = createStoreCoordinator({ dir: process.argv[1] });
await c.exclusive(() => new Promise(() => { setInterval(() => {}, 1000); process.stdout.write('held\\n'); }));
`;
function holder(script, arg) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, arg], { stdio: ['ignore', 'pipe', 'inherit'] });
  const ready = new Promise((resolve, reject) => { child.stdout.on('data', resolve); child.on('exit', () => reject(new Error('holder exited early'))); });
  return { child, ready };
}
const exited = child => new Promise(resolve => (child.exitCode !== null || child.signalCode ? resolve() : child.on('exit', resolve)));

test('class 1: a live process holding the ledger lock is not displaced however far the clock runs ahead', async () => {
  const dir = fresh();
  const lockFile = path.join(dir, 'ledger.json.lock');
  const { child, ready } = holder(HOLD_LEDGER_LOCK, lockFile);
  try {
    await ready;
    let entered = false;
    assert.throws(() => withFileLockSync(lockFile, () => { entered = true; }, { timeoutMs: 300, now: () => NOW * 2 }), error => error.code === 'ledger_locked');
    assert.equal(entered, false);
  } finally { child.kill('SIGKILL'); await exited(child); }
  assert.equal(withFileLockSync(lockFile, () => 'ran', { timeoutMs: 1000 }), 'ran', 'a dead holder does not block');
});

test('class 1: a live process inside exclusive() is not displaced by another process whose clock is far ahead', async () => {
  const dir = fresh();
  const { child, ready } = holder(HOLD_DISPATCH, dir);
  try {
    await ready;
    const other = createStoreCoordinator({ dir, now: () => Date.now() + 365 * 24 * 60 * 60 * 1000 });
    let entered = false;
    await assert.rejects(other.exclusive(async () => { entered = true; }, { waitMs: 300 }), error => error.code === 'store_busy');
    assert.equal(entered, false);
  } finally { child.kill('SIGKILL'); await exited(child); }
});

// Three processes race to take over the lock of a holder that died. Each round the lock is
// left by a real process that was killed inside its critical section. A contender that sees
// another inside at the same time has broken mutual exclusion.
const CONTENDER = `
import fs from 'node:fs';
import path from 'node:path';
import { withFileLockSync } from ${JSON.stringify(new URL('../lib/store-lock.mjs', import.meta.url).href)};
const [lockFile, dir, name, rounds] = process.argv.slice(1);
const witness = path.join(dir, 'inside');
let violations = 0;
for (let round = 0; round < Number(rounds); round++) {
  while (!fs.existsSync(path.join(dir, 'go-' + round))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
  for (let i = 0; i < 8; i++) {
    try {
      withFileLockSync(lockFile, () => {
        try { fs.writeFileSync(witness, name, { flag: 'wx' }); } catch { violations++; return; }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
        fs.rmSync(witness, { force: true });
      }, { timeoutMs: 15000 });
    } catch { violations += 1000; }
  }
  fs.writeFileSync(path.join(dir, 'done-' + round + '-' + name), '');
}
process.stdout.write(String(violations));
`;
test('class 1: four contenders reclaiming the lock of a dead holder never run their critical sections together', { timeout: 120000 }, async () => {
  const dir = fresh();
  const lockFile = path.join(dir, 'ledger.json.lock');
  const rounds = 40;
  const names = ['x', 'y', 'z', 'w'];
  const kids = names.map(name => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CONTENDER, lockFile, dir, name, String(rounds)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    return { child, result: () => out };
  });
  try {
    for (let round = 0; round < rounds; round++) {
      const dead = holder(HOLD_LEDGER_LOCK, lockFile);
      await dead.ready;
      dead.child.kill('SIGKILL');
      await exited(dead.child);
      fs.writeFileSync(path.join(dir, `go-${round}`), '');
      await until(() => names.every(name => fs.existsSync(path.join(dir, `done-${round}-${name}`))), `round ${round}`, 30000);
    }
    await Promise.all(kids.map(({ child }) => exited(child)));
  } finally { for (const { child } of kids) child.kill('SIGKILL'); }
  const violations = kids.map(kid => Number(kid.result() || 0));
  assert.deepEqual(violations, [0, 0, 0, 0], 'no contender ever found another inside the lock');
});

// ---------------------------------------------------------------- class 2: attribution of a create

test('class 2: an expired create intent never owns an unrelated image made before the intent began', async () => {
  const U = row('1111111111111111', OLD, { created_at: new Date(NOW - 30 * 60 * 1000 - 30 * 1000).toISOString() });
  const w = world({ templates: [U] });
  const { sweeper, ledger } = rig(w, { prepare: l => {
    migrated(l);
    const early = createDiskLedger({ file: l.file, now: () => NOW - 30 * 60 * 1000 });
    early.acquireLease({ item: 'image:*', ttlMs: 1000 });
  } });
  await sweeper.run({ trigger: 'test' });
  assert.equal(ledger.ownedImages()[ref('1111111111111111')], undefined, 'an image 30 s older than the intent is not the create result');
  assert.deepEqual(w.removedRefs(), []);
});

// ---------------------------------------------------------------- class 4: damaged version-2 ledgers

function validState() {
  return {
    version: 3, leases: {}, sandboxes: {}, pins: { current: [CUR], previous: [OLD] }, lastSweep: null,
    owned: { images: {
      [ref('0a0a0a0a0a0a0a0a')]: { imageId: CUR.slice(0, 12), reason: 'created', at: 1 },
      [ref('3333333333333333')]: { imageId: OLD.slice(0, 12), reason: 'created', at: 1 },
    }, caches: {} },
    ops: {},
  };
}
const DAMAGES = {
  'previous is a string': s => { s.pins.previous = 'not-an-array'; },
  'current is a string': s => { s.pins.current = 'not-an-array'; },
  'pins is null': s => { s.pins = null; },
  'pins missing': s => { delete s.pins; },
  'previous missing': s => { delete s.pins.previous; },
  'owned missing': s => { delete s.owned; },
  'owned.images is an array': s => { s.owned.images = []; },
  'an owned image row is a string': s => { s.owned.images[ref('3333333333333333')] = 'yes'; },
  'owned.caches missing': s => { delete s.owned.caches; },
  'leases missing': s => { delete s.leases; },
  'leases is an array': s => { s.leases = []; },
  'a lease expiresAt is a string': s => { s.leases.x = { id: 'x', item: 'image:*', startedAt: 1, expiresAt: 'soon', agent: null, pin: null }; },
  'sandboxes is an array': s => { s.sandboxes = []; },
  'a sandbox pin is a number': s => { s.sandboxes['wf-aaaaaaaaaaaaaaaa'] = { pin: 7, createdAt: 1 }; },
  'ops missing': s => { delete s.ops; },
  'an operation row has no kind': s => { s.ops = { o: { id: 'o', ref: 'r', startedAt: 1 } }; },
  'an owned image id is a number': s => { s.owned.images[ref('3333333333333333')] = { imageId: 7, reason: 'created', at: 1 }; },
  'a sandbox cache is a number': s => { s.sandboxes['wf-aaaaaaaaaaaaaaaa'] = { pin: null, createdAt: 1, cache: 7 }; },
  'lastSweep is text': s => { s.lastSweep = 'done'; },
  'the version is 9': s => { s.version = 9; },
  'a pin is not a digest': s => { s.pins.previous = ['abc']; },
};
for (const [name, damage] of Object.entries(DAMAGES)) {
  test(`class 4: a version-3 ledger where ${name} keeps the rollback image and is left as it was`, async () => {
    const C = row('3333333333333333', OLD);
    const w = world({ templates: [C] });
    const state = validState();
    damage(state);
    const text = JSON.stringify(state);
    const { sweeper, ledger } = rig(w, { prepare: l => fs.writeFileSync(l.file, text) });
    const summary = await sweeper.run({ trigger: 'test' });
    assert.deepEqual(w.removedRefs(), [], 'the old owned rollback image is kept');
    assert.ok(summary.errors.some(error => error.item === 'ledger'), 'the damage is reported');
    assert.equal(ledger.damaged, true);
    assert.equal(fs.readFileSync(ledger.file, 'utf8'), text, 'damaged bytes are preserved');
  });
}

// ---------------------------------------------------------------- class 5: nothing overlaps a removal still in flight

test('class 5: a removal whose effect lands after the abort is finished before a second sweeper issues anything', async () => {
  const gate = gateOf();
  const w = world({ rmGate: gate, sandboxes: [box(BOX_A)] });
  const dir = fresh();
  const a = rig(w, { dir, prepare: (l, file) => { migrated(l); recordBox(file, BOX_A); } });
  const first = a.sweeper.run({ trigger: 'test' });
  await until(() => w.removedRefs().length === 1, 'the removal command');
  a.sweeper.abort();
  const before = w.state.calls.length;
  const b = rig(w, { dir, prepare: null });
  const second = await b.sweeper.run({ trigger: 'test' });
  assert.equal(second.skipped, 'store_busy', 'the store is still fenced by the removal in flight');
  assert.equal(w.state.calls.length, before, 'no sbx command is issued while the earlier removal is still running');
  // The effect lands now, after the abort; the first sweeper finishes it before it lets go.
  gate.release();
  await first.catch(() => {});
  const third = await b.sweeper.run({ trigger: 'test' });
  assert.notEqual(third.skipped, 'store_busy');
  assert.equal(w.state.calls.slice(before).some(c => c.startsWith('rm ')), false, 'the item that is already gone is never removed again');
});

test('class 5: abort during cache enumeration writes nothing to the ledger afterwards', async () => {
  const dir = fresh();
  const cacheRoot = path.join(dir, 'guest-runtime');
  const cacheDir = path.join(cacheRoot, hex('9'));
  fs.mkdirSync(cacheDir, { recursive: true });
  const w = world({});
  const holder = {};
  const { sweeper, ledger } = rig(w, { dir, prepare: l => { own(l, row('0a0a0a0a0a0a0a0a', CUR)); }, caches: () => ({ root: cacheRoot, current: hex('8'), offer: true }) });
  holder.sweeper = sweeper;
  const realOpendir = fs.promises.opendir;
  fs.promises.opendir = async (target, ...rest) => { if (String(target) === cacheRoot) holder.sweeper.abort(); return realOpendir.call(fs.promises, target, ...rest); };
  try { await sweeper.run({ trigger: 'test' }); } finally { fs.promises.opendir = realOpendir; }
  assert.deepEqual(ledger.ownedCaches(), {}, 'no cache was recorded after the abort');
});

// ---------------------------------------------------------------- class 6: roots re-read, restarts, retained jobs

function cacheRig({ names, w, retained, referenced, caches, extra = {} }) {
  const dir = fresh();
  const cacheRoot = path.join(dir, 'guest-runtime');
  const oldTime = new Date(NOW - 5 * 60 * 60 * 1000);
  for (const name of names) { fs.mkdirSync(path.join(cacheRoot, name), { recursive: true }); fs.utimesSync(path.join(cacheRoot, name), oldTime, oldTime); }
  const state = { current: hex('f'), offer: true };
  const r = rig(w, { dir, retained, referenced, caches: caches ? caches(cacheRoot, state) : () => ({ root: cacheRoot, current: state.current, offer: state.offer }),
    prepare: l => { migrated(l); for (const name of names) l.ownCache(path.join(cacheRoot, name), 'created'); }, ...extra });
  return { ...r, cacheRoot, state, exists: name => fs.existsSync(path.join(cacheRoot, name)) };
}

test('class 6: a cache provider that changes during a sweep is read again before each removal', async () => {
  const gate = gateOf();
  const w = world({});
  const D1 = hex('1'), D2 = hex('2');
  const c = cacheRig({ names: [D1, D2], w });
  // The first directory removal waits, so the provider can change while it is pending.
  const realRm = fs.promises.rm;
  let firstTarget = null;
  fs.promises.rm = async (target, ...rest) => { if (!firstTarget) { firstTarget = path.basename(target); await gate.promise; } return realRm.call(fs.promises, target, ...rest); };
  try {
    const run = c.sweeper.run({ trigger: 'test' });
    await until(() => firstTarget !== null, 'the first removal');
    const other = firstTarget === D1 ? D2 : D1;
    c.state.current = other; // the other directory is now the current runtime while the first removal is pending
    gate.release();
    await run;
    assert.equal(c.exists(other), true, 'the cache that became current during the sweep is kept');
  } finally { fs.promises.rm = realRm; }
  assert.equal(c.exists(firstTarget), false, 'the first one was removed');
});

test('class 6: a restarted or second app with no live-job state keeps runtime caches while a sandbox of unknown cache use runs', async () => {
  const w = world({ sandboxes: [{ name: 'wf-aaaaaaaaaaaaaaaa', status: 'running' }] });
  const D = hex('3');
  const c = cacheRig({ names: [D], w, referenced: new Set() });
  await c.sweeper.run({ trigger: 'test' });
  assert.equal(c.exists(D), true, 'the old cache may be mounted by the running sandbox, so it stays');
});

test('class 6: the same holds for a stopped sandbox whose cache use is unknown while its job is retained', async () => {
  const name = 'wf-bbbbbbbbbbbbbbbb';
  const w = world({ sandboxes: [{ name, status: 'stopped' }] });
  const D = hex('4');
  const c = cacheRig({ names: [D], w, retained: () => new Set([name]) });
  await c.sweeper.run({ trigger: 'test' });
  assert.equal(c.exists(D), true);
});

test('class 6: an unreadable retained-job root fails closed: nothing is removed and the ledger keeps its records', async () => {
  const w = world({ templates: [row('1111111111111111', OLD)] });
  const dir = fresh();
  const { sweeper, ledger } = rig(w, { dir, prepare: l => { migrated(l); own(l, row('1111111111111111', OLD)); },
    retained: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } });
  const summary = await sweeper.run({ trigger: 'test' });
  assert.deepEqual(w.removedRefs(), [], 'with the retained roots unknown, no image is removed');
  assert.deepEqual(w.sandboxRemovals(), []);
  assert.ok(ledger.ownedImages()[ref('1111111111111111')], 'its ledger record stays');
  assert.ok(summary.errors.some(error => /retained/i.test(`${error.item} ${error.message}`)), 'the unreadable root is reported, not hidden');
});

test('class 6: a retained, stopped sandbox is not removed even when it is old, journaled and not live', async () => {
  const name = 'wf-cccccccccccccccc';
  const w = world({ sandboxes: [{ name, status: 'stopped' }] });
  const { sweeper } = rig(w, { retained: () => new Set([name]),
    prepare: (l, f) => { migrated(l); createDiskLedger({ file: f, now: () => NOW - 6 * SANDBOX_MIN_AGE_MS }).recordSandbox(name, { pin: OLD }); } });
  await sweeper.run({ trigger: 'test' });
  assert.deepEqual(w.sandboxRemovals(), [], 'the retained job still refers to this sandbox');
});

// ---------------------------------------------------------------- widened from the fail-closed census (still open at the reviewed head)

test('census: a ledger record with no image id does not authorise removal by tag alone', async () => {
  const A = row('1111111111111111', OLD);
  const w = world({ templates: [A] });
  const { sweeper } = rig(w, { prepare: l => { migrated(l); l.ownImages([{ ref: ref('1111111111111111') }], 'created'); } });
  await sweeper.run({ trigger: 'test' });
  assert.deepEqual(w.removedRefs(), [], 'a name alone does not prove this is the image we recorded');
});

test('census: runtime cache directories nobody recorded are never adopted by the upgrade migration', async () => {
  const dir = fresh();
  const cacheRoot = path.join(dir, 'guest-runtime');
  const D = hex('5');
  fs.mkdirSync(path.join(cacheRoot, D), { recursive: true });
  const old = new Date(NOW - 5 * 60 * 60 * 1000);
  fs.utimesSync(path.join(cacheRoot, D), old, old);
  const w = world({});
  const { sweeper, ledger } = rig(w, { dir, caches: () => ({ root: cacheRoot, current: hex('8'), offer: true }), prepare: l => { own(l, row('0a0a0a0a0a0a0a0a', CUR)); } });
  await sweeper.run({ trigger: 'test' });
  assert.equal(fs.existsSync(path.join(cacheRoot, D)), true, 'an unrecorded cache is left alone');
  assert.deepEqual(ledger.ownedCaches(), {});
});

test('census: a sandbox name listed twice with contradicting states is not removed', async () => {
  const name = 'wf-dddddddddddddddd';
  const w = world({ sandboxes: [{ name, status: 'stopped' }, { name, status: 'running' }] });
  const { sweeper } = rig(w, { prepare: (l, f) => { migrated(l); createDiskLedger({ file: f, now: () => NOW - 6 * SANDBOX_MIN_AGE_MS }).recordSandbox(name, { pin: OLD }); } });
  await sweeper.run({ trigger: 'test' });
  assert.deepEqual(w.sandboxRemovals(), []);
});

test('census: lock file contents mean nothing: the kernel lock decides, so a garbage file neither blocks nor is trusted', async () => {
  const dir = fresh();
  fs.writeFileSync(path.join(dir, 'disk-dispatch.lock'), '{not json');
  const c = createStoreCoordinator({ dir });
  let entered = false;
  await c.exclusive(async () => { entered = true; }, { waitMs: 250 });
  assert.equal(entered, true);
});

test('census: logs are not rotated while the ledger is damaged', async () => {
  const dir = fresh();
  const logs = path.join(dir, 'logs');
  fs.mkdirSync(logs);
  const big = path.join(logs, 'daemon.log');
  fs.writeFileSync(big, 'x'); fs.truncateSync(big, 6 * 1024 * 1024);
  fs.writeFileSync(`${big}.1`, 'older');
  const w = world({});
  const { sweeper } = rig(w, { dir, usage: { logsDir: logs }, prepare: l => fs.writeFileSync(l.file, '{"version":2,"leases":') });
  await sweeper.run({ trigger: 'test' });
  assert.equal(fs.readFileSync(`${big}.1`, 'utf8'), 'older', 'the older copy is not replaced while the ledger is damaged');
});

// ---------------------------------------------------------------- the model's tests that the classes above do not cover

test('model 6/18: an image id that two listed tags share is never removed by id, even when one tag is recorded', async () => {
  const A = row('1111111111111111', OLD);
  const B = row('2222222222222222', OLD);            // same image id under another tag, never recorded
  const w = world({ templates: [A, B] });
  const { sweeper } = rig(w, { prepare: l => { migrated(l); own(l, A); } });
  const summary = await sweeper.run({ trigger: 'test' });
  assert.deepEqual(w.removedRefs(), [], 'removing the shared id would also remove the other tag');
  assert.ok(summary.errors.length >= 1 || summary.removed === 0);
  assert.equal(w.state.templates.length, 3);
});

test('model 12: killing a writer at any point of its ledger commits leaves a whole old or a whole new ledger, never a torn one', { timeout: 60000 }, async () => {
  const file = path.join(fresh(), 'ledger.json');
  const module = new URL('../lib/disk-ledger.mjs', import.meta.url).href;
  const script = `import { createDiskLedger } from ${JSON.stringify(module)}; const l = createDiskLedger({ file: ${JSON.stringify(file)} }); for (let i = 0; ; i++) l.recordSandbox('wf-' + i.toString(16).padStart(16, '0'), { pin: ${JSON.stringify(CUR)} });`;
  for (let round = 0; round < 6; round++) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
    await sleep(60 + round * 25);
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
    const ledger = createDiskLedger({ file });
    assert.equal(ledger.damaged, false, `round ${round}: the ledger parses and validates after the kill`);
  }
  assert.ok(Object.keys(createDiskLedger({ file }).sandboxes()).length > 0);
});

test('model 13: a store whose ledger file is missing owns nothing, so old assembled images are not removed', async () => {
  const w = world({ templates: [row('1111111111111111', OLD), row('2222222222222222', OTHER)] });
  const { sweeper, ledger } = rig(w, {});
  fs.rmSync(ledger.file, { force: true });
  const summary = await sweeper.run({ trigger: 'test' });
  assert.deepEqual(w.removedRefs(), []);
  assert.equal(summary.removed, 0);
});

test('model 15: a cache removal left open by a process that died is closed by the next sweep, and the directory is planned again from what it is now', async () => {
  const w = world({});
  const c = cacheRig({ names: [hex('1')], w });
  createDiskLedger({ file: c.file, now: () => NOW }).beginOp({ kind: 'cache', ref: path.join(c.cacheRoot, hex('1')) });
  assert.equal(c.ledger.openOps().length, 1);
  await c.sweeper.run({ trigger: 'test' });
  assert.equal(c.exists(hex('1')), false, 'the directory is removed by the new sweep');
  assert.equal(c.ledger.openOps().length, 0, 'the old record is closed');
});

test('model 16: after an abort, the sweeper reports the removal it could not stop as unresolved until the command ends', async () => {
  const gate = gateOf();
  const w = world({ rmGate: gate, sandboxes: [box(BOX_A)] });
  const { sweeper } = rig(w, { prepare: (l, file) => { migrated(l); recordBox(file, BOX_A); } });
  const run = sweeper.run({ trigger: 'test' });
  await until(() => w.removedRefs().length === 1, 'the removal command');
  sweeper.abort();
  assert.equal(sweeper.unresolved, 1, 'a command that may still land is counted');
  gate.release();
  await run.catch(() => {});
  assert.equal(sweeper.unresolved, 0);
});

test('model 24: a cache that two sandboxes share stays while either still uses it', async () => {
  const D = hex('6');
  const w = world({ sandboxes: [{ name: 'wf-aaaaaaaaaaaaaaaa', status: 'running' }] });
  const c = cacheRig({ names: [D], w });
  const dir = path.join(c.cacheRoot, D);
  const record = createDiskLedger({ file: c.file, now: () => NOW - 6 * SANDBOX_MIN_AGE_MS });
  record.recordSandbox('wf-aaaaaaaaaaaaaaaa', { pin: CUR, cache: dir });
  record.recordSandbox('wf-bbbbbbbbbbbbbbbb', { pin: CUR, cache: dir });     // the other job already ended
  await c.sweeper.run({ trigger: 'test' });
  assert.equal(c.exists(D), true, 'the running sandbox still mounts it');
});

test('model 26: a cache directory too large to list within the bound is unknown: no cache is removed and the sweep says so', async () => {
  const names = Array.from({ length: 60 }, (_, i) => i.toString(16).padStart(2, '0').repeat(32));
  const w = world({});
  const c = cacheRig({ names, w, extra: {} });
  const bounded = createDiskSweeper({ ledger: c.ledger, coordinator: c.coordinator, runSbx: w.runSbx, journal: { recorded: () => true }, pins: () => [CUR], referenced: () => new Set(),
    caches: () => ({ root: c.cacheRoot, current: hex('f'), offer: true }), accounting: { maxEntries: 20 }, measureFree: async () => null, now: () => NOW });
  const summary = await bounded.run({ trigger: 'test' });
  assert.equal(names.filter(name => c.exists(name)).length, 60, 'none was removed');
  assert.ok(summary.errors.some(error => /cache/i.test(`${error.item} ${error.message}`)), 'the incomplete listing is reported');
});

test('model 4: the lock primitive proves itself on this host, and a sweeper whose lock does not prove removes nothing', async () => {
  const { selfTest } = await import('../lib/os-lock.mjs');
  assert.deepEqual(selfTest(fresh()), { ok: true });
  const A = row('1111111111111111', OLD);
  const w = world({ templates: [A] });
  const { ledger } = rig(w, { prepare: l => { migrated(l); own(l, A); } });
  const sweeper = createDiskSweeper({ ledger, runSbx: w.runSbx, journal: { recorded: () => true }, pins: () => [CUR], referenced: () => new Set(),
    lockCheck: () => ({ ok: false, reason: 'two locks on one name were both granted' }), measureFree: async () => null, now: () => NOW });
  const summary = await sweeper.run({ trigger: 'test' });
  assert.deepEqual(w.removedRefs(), []);
  assert.ok(summary.errors.some(error => error.item === 'lock'));
});
