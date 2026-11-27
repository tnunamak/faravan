import './helpers/no-browser.mjs';
import './helpers/removal-on.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiskLedger } from '../lib/disk-ledger.mjs';
import { createDiskSweeper, MAX_RETAINED_LISTED } from '../lib/disk-sweep.mjs';
import { createSweepScheduler } from '../lib/disk-sweep-schedule.mjs';
import { createStoreCoordinator } from '../lib/store-lock.mjs';
import { diskLines, diskReportOf } from '../lib/disk-report.mjs';
import { SWEEP_MIN_AGE_MS, SANDBOX_MIN_AGE_MS } from '../lib/disk-sweep-plan.mjs';

// The conformance rulings for the sweep's removal code (kept behind its setting), each driven
// through the real sweeper, planner and ledger with a fake sbx:
//   1. Only the exact repository is ever the app's; roots are read again before each removal.
//   2. A surviving sandbox keeps its image and its runtime cache across an app restart.
//   3. Every sweep reads free space again after a removal; only a pressure sweep stops on it.
//   4. The free-space change is read after every effect, log rotation included.
//   5. Doctor names each kept item and what keeps it, within a bound.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sweep-conformance-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const GiB = 1024 ** 3;
const hex = c => c.repeat(64);
const CUR = hex('a'), LOOSE = hex('c'), USED = hex('d');
const NOW = 1_800_000_000_000;
const AGE = 5 * Math.max(SWEEP_MIN_AGE_MS, SANDBOX_MIN_AGE_MS);
const ASSEMBLED = 'docker.io/library/sandbox-kit-assembled';
const iso = ms => new Date(ms).toISOString();
const image = (tag, digest, { repository = ASSEMBLED, age = AGE, size = 1000 } = {}) => ({ id: digest.slice(0, 12), repository, tag, flavor: 'codex', created_at: iso(NOW - age), size });
let counter = 0;

function world({ templates = [], sandboxes = [], start = 100 * GiB, freed = size => size } = {}) {
  const state = { templates: [image('0a0a0a0a0a0a0a0a', CUR, { age: 60 * AGE }), ...templates], sandboxes: [...sandboxes], calls: [], free: start, listFails: false };
  return {
    state,
    removedRefs: () => state.calls.filter(c => c.startsWith('template rm ')).map(c => c.split(' ')[2]),
    runSbx: async args => {
      state.calls.push(args.join(' '));
      const [a, b] = args;
      if (a === 'template' && b === 'ls') return { code: 0, stdout: JSON.stringify(state.templates), stderr: '' };
      if (a === 'ls') return state.listFails ? { code: 1, stdout: '', stderr: 'down' } : { code: 0, stdout: JSON.stringify(state.sandboxes.map(sb => ({ id: `id-${sb.name}`, ...sb }))), stderr: '' };
      if (a === 'template' && b === 'rm') {
        // Removal is by image id: every tag of that id goes with it.
        const gone = state.templates.filter(t => t.id === args[2] || `${t.repository}:${t.tag}` === args[2]);
        state.templates = state.templates.filter(t => !gone.includes(t));
        state.free += freed(gone.reduce((sum, t) => sum + t.size, 0));
        return { code: 0, stdout: '', stderr: '' };
      }
      if (a === 'rm') {
        const gone = state.sandboxes.filter(s => s.name === args[2]);
        state.sandboxes = state.sandboxes.filter(s => s.name !== args[2]);
        state.free += freed(gone.reduce((sum, t) => sum + (t.size ?? 0), 0));
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
    },
  };
}

function rig(w, { pins = [CUR], caches = null, usage = null, referenced = [], prepare, ownAll = true, hostFree, measureFree } = {}) {
  const dir = path.join(root, `case-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  const clock = { t: NOW };
  const ledger = createDiskLedger({ file: path.join(dir, 'ledger.json'), now: () => clock.t });
  prepare?.(ledger, clock);
  clock.t = NOW;
  if (ownAll) ledger.ownImages(w.state.templates.filter(t => t.repository === ASSEMBLED).map(t => ({ ref: `${t.repository}:${t.tag}`, imageId: t.id })), 'created');
  const sweeper = createDiskSweeper({ ledger, coordinator: createStoreCoordinator({ dir }), runSbx: w.runSbx, journal: { recorded: () => true }, pins: () => pins,
    referenced: () => new Set(referenced), caches, usage, measureFree: measureFree ?? (async () => w.state.free), hostFree: hostFree ?? (async () => w.state.free), now: () => NOW });
  return { ledger, sweeper, dir };
}

// ---- 1. ownership is the exact repository

test('ownership: an assembled image nobody recorded, and a look-alike repository, are never removed and show as not touched', async () => {
  const lookalike = image('9999999999999999', LOOSE, { repository: 'other/sandbox-kit-assembled' });
  const w = world({ templates: [image('1111111111111111', LOOSE), lookalike] });
  const { ledger, sweeper } = rig(w, { ownAll: false });
  const summary = await sweeper.run({ trigger: 'startup' });
  assert.deepEqual(ledger.ownedImages(), {}, 'nothing is adopted');
  assert.deepEqual(w.removedRefs(), []);
  assert.equal(summary.notTouched.images.count, 2, 'the unrecorded assembled image and the look-alike are reported as not touched');
  assert.equal(summary.scanned.notOurs, 1);
});

// ---- 1 (kept): roots are read again before each removal

test('roots: a job that roots a planned sandbox while an earlier removal runs keeps that sandbox', async () => {
  const stopped = name => ({ name, id: `id-${name}`, status: 'stopped' });
  const w = world({ sandboxes: [stopped('wf-00000000000000a1'), stopped('wf-00000000000000a2')] });
  const rooted = new Set();
  const inner = w.runSbx;
  // Removing the first sandbox is when a job starts to reference the second.
  w.runSbx = async args => { const out = await inner(args); if (args[0] === 'rm' && args[2] === 'wf-00000000000000a1') rooted.add('wf-00000000000000a2'); return out; };
  const { sweeper } = rig(w, {
    referenced: rooted,
    prepare: (l, clock) => { clock.t = NOW - 5 * AGE; l.recordSandbox('wf-00000000000000a1', { pin: CUR, id: 'id-wf-00000000000000a1' }); l.recordSandbox('wf-00000000000000a2', { pin: CUR, id: 'id-wf-00000000000000a2' }); },
  });
  const summary = await sweeper.run({ trigger: 'startup' });
  assert.deepEqual(w.state.sandboxes.map(s => s.name), ['wf-00000000000000a2'], 'the sandbox a job came to reference is still there');
  assert.equal(summary.kept.changed_before_removal, 1);
});

// ---- 2. a surviving sandbox roots its runtime cache across a restart

function cacheWorld({ sandboxes, referenced = [], listFails = false }) {
  const w = world({ sandboxes });
  w.state.listFails = listFails;
  const cacheRoot = path.join(root, `caches-${counter++}`);
  const oldCache = path.join(cacheRoot, hex('7'));
  const currentCache = path.join(cacheRoot, hex('8'));
  for (const dir of [oldCache, currentCache]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'runtime.bin'), 'x');
    const old = new Date(NOW - 5 * AGE);
    fs.utimesSync(dir, old, old);
  }
  // A restarted app: a new process with no memory of what it was preparing. Its only knowledge is the
  // ledger, the sandbox listing and the job and cleanup records.
  const out = rig(w, { caches: { root: cacheRoot, current: hex('8') }, referenced, prepare: l => { l.ownCache(oldCache, 'created'); l.ownCache(currentCache, 'created'); } });
  return { w, oldCache, currentCache, ...out };
}

test('restart: a surviving running sandbox keeps the older runtime cache it may use', async () => {
  const { oldCache, currentCache, sweeper } = cacheWorld({ sandboxes: [{ name: 'wf-00000000000000b1', status: 'running' }] });
  const summary = await sweeper.run({ trigger: 'startup' });
  assert.ok(fs.existsSync(oldCache), 'the older cache survives');
  assert.ok(fs.existsSync(currentCache));
  assert.equal(summary.notTouched.sandboxes.count, 1, 'the sandbox nobody recorded is reported, not touched');
});

test('restart: a stopped sandbox a job or the cleanup journal still names also keeps the cache', async () => {
  const { oldCache, sweeper } = cacheWorld({ sandboxes: [{ name: 'wf-00000000000000b2', status: 'stopped' }], referenced: ['wf-00000000000000b2'] });
  await sweeper.run({ trigger: 'startup' });
  assert.ok(fs.existsSync(oldCache));
});

test('restart: a journal entry whose sandbox is gone from the listing still keeps the cache', async () => {
  const { oldCache, sweeper } = cacheWorld({ sandboxes: [], referenced: ['wf-00000000000000b3'] });
  await sweeper.run({ trigger: 'startup' });
  assert.ok(fs.existsSync(oldCache));
});

test('restart: when the sandbox listing cannot be read, no cache is collected', async () => {
  const { oldCache, sweeper } = cacheWorld({ sandboxes: [], listFails: true });
  await sweeper.run({ trigger: 'startup' });
  assert.ok(fs.existsSync(oldCache));
});

test('restart: with no live or unresolved sandbox the older cache goes, and the current one stays', async () => {
  const { oldCache, currentCache, sweeper } = cacheWorld({ sandboxes: [] });
  const summary = await sweeper.run({ trigger: 'startup' });
  assert.equal(fs.existsSync(oldCache), false);
  assert.ok(fs.existsSync(currentCache));
  assert.equal(summary.removed, 1);
});

// ---- 3. startup and timer sweeps need no high-water gate; pressure sweeps keep hysteresis

// Stopped sandboxes this app made long ago; each frees `size` bytes when it goes.
const looseBoxes = (n, size = 0) => Array.from({ length: n }, (_, i) => ({ name: `wf-00000000000000c${i}`, id: `id-c${i}`, status: 'stopped', size }));
const recordLoose = boxes => (l, clock) => { clock.t = NOW - 5 * AGE; for (const b of boxes) l.recordSandbox(b.name, { pin: CUR, id: b.id }); };
function threeLoose() {
  const sandboxes = looseBoxes(3);
  return { w: world({ start: 100 * GiB, sandboxes }), prepare: recordLoose(sandboxes) };
}

test('schedule: the startup and the timer sweep run with plenty of free space and take every eligible item', async () => {
  for (const name of ['startup', 'timer']) {
    const { w, prepare } = threeLoose();
    const reads = [];
    const { sweeper } = rig(w, { prepare, hostFree: async () => { reads.push(w.state.free); return w.state.free; } });
    const summary = await sweeper.run({ trigger: name });
    assert.equal(summary.removed, 3, `${name}: all three go though 100 GiB is free`);
    assert.ok(reads.length >= 3, `${name}: free space is read again after each removal (${reads.length} reads)`);
  }
});

test('schedule: the scheduler starts the startup sweep without checking free space first', async () => {
  const order = [];
  const scheduler = createSweepScheduler({
    sweeper: { run: async ({ trigger }) => { order.push(trigger); return { trigger, errors: [] }; } },
    hostFree: async () => { order.push('free-read'); return 500 * GiB; },
    ready: Promise.resolve(),
    timers: { setTimeout: () => ({ unref() {} }), clearTimeout() {} },
  });
  scheduler.start();
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(order[0], 'startup', 'the sweep is the first thing that happens');
  await scheduler.stop();
});

test('schedule: a pressure sweep stops once free space is back at the stop mark', async () => {
  const sandboxes = looseBoxes(3, 12 * GiB);
  const w = world({ start: 9 * GiB, freed: size => size, sandboxes });
  const { sweeper } = rig(w, { prepare: recordLoose(sandboxes) });
  const summary = await sweeper.run({ trigger: 'pressure' });
  assert.equal(summary.removed, 1, '9 GiB + 12 GiB is past the 20 GiB stop mark after one removal');
  assert.equal(summary.kept.stopped_at_low_water, 2);
});

// ---- 4. the free-space change is read after every effect

test('measure: doctor calls the figure a net free-space change on the sandbox drive and keeps the plan figure apart', () => {
  const text = diskLines({ last_sweep: { at: NOW, trigger: 'timer', removes: true, removed: 1, eligible: 1, expectedBytes: 5000, reclaimedBytes: 700, kept: {}, errors: [] }, categories: null }).join('\n');
  assert.match(text, /the plan expected 5\.0 KB, net free-space change on the sandbox drive 700 B/);
  assert.doesNotMatch(text, /reclaimed/);
});

// ---- 5. doctor names what keeps each item

test('explain: each kept item names the sandbox, lease, pin or job that keeps it', async () => {
  const w = world({
    templates: [image('1111111111111111', USED), image('2222222222222222', hex('e')), image('3333333333333333', hex('f'))],
    sandboxes: [{ name: 'wf-00000000000000c1', status: 'running' }],
  });
  const { sweeper } = rig(w, { prepare: l => {
    l.recordSandbox('wf-00000000000000c1', { pin: USED, id: 'id-wf-00000000000000c1' });
  } });
  const summary = await sweeper.run({ trigger: 'startup' });
  const byRef = Object.fromEntries(summary.retained.map(item => [item.ref, item]));
  assert.match(byRef[`${ASSEMBLED}:1111111111111111`].heldBy, /^sandbox wf-00000000000000c1 uses it$/);
  assert.match(byRef['wf-00000000000000c1'].heldBy, /it is running/);
  assert.match(byRef[`${ASSEMBLED}:0a0a0a0a0a0a0a0a`].heldBy, /current image/);
  const text = diskLines(diskReportOf(summary), { listKept: true }).join('\n');
  assert.match(text, /image docker\.io\/library\/sandbox-kit-assembled:1111111111111111: kept because sandbox wf-00000000000000c1 uses it/);
  assert.doesNotMatch(diskLines(diskReportOf(summary)).join('\n'), /^Kept:/m, 'status keeps to counts; doctor lists the items');
});

test('explain: a job lease on an image names the lease holder, and a create in progress says so', async () => {
  const w = world({ templates: [image('2222222222222222', hex('e')), image('3333333333333333', hex('f'))] });
  const { sweeper } = rig(w, { prepare: l => { l.acquireLease({ item: 'sandbox:wf-00000000000000c2', ttlMs: 60 * 60 * 1000, pin: hex('e') }); } });
  const summary = await sweeper.run({ trigger: 'startup' });
  const held = summary.retained.find(item => item.ref === `${ASSEMBLED}:2222222222222222`);
  assert.match(held.heldBy, /sandbox wf-00000000000000c2/);
  const { sweeper: busy } = rig(world({ templates: [image('2222222222222222', hex('e'))] }), { prepare: l => { l.acquireLease({ item: 'image:*', ttlMs: 60 * 60 * 1000 }); } });
  const inFlight = await busy.run({ trigger: 'startup' });
  assert.ok(inFlight.retained.some(item => item.heldBy === 'a create in progress'));
});

test('explain: the kept list is bounded, held items come first, and the rest is counted', async () => {
  const count = MAX_RETAINED_LISTED + 7;
  const templates = Array.from({ length: count }, (_, i) => image(i.toString(16).padStart(16, '0'), USED));
  const w = world({ templates, sandboxes: [{ name: 'wf-00000000000000c1', status: 'running' }] });
  const { sweeper } = rig(w, { prepare: l => { l.recordSandbox('wf-00000000000000c1', { pin: USED, id: 'id-wf-00000000000000c1' }); } });
  const summary = await sweeper.run({ trigger: 'startup' });
  assert.equal(summary.retained.length, MAX_RETAINED_LISTED);
  assert.equal(summary.retainedTotal, count + 2, 'every image, the current image and the sandbox');
  assert.ok(summary.retained.every(item => item.heldBy), 'the list is filled with held items first');
  const text = diskLines(diskReportOf(summary), { listKept: true }).join('\n');
  assert.match(text, new RegExp(`and ${count + 2 - MAX_RETAINED_LISTED} more kept items`));
});

test('explain: an item kept only by the rule (too new) is listed after the held ones, without a holder', async () => {
  const w = world({ templates: [image('4444444444444444', LOOSE, { age: 1000 })] });
  const { sweeper } = rig(w);
  const summary = await sweeper.run({ trigger: 'startup' });
  const fresh = summary.retained.find(item => item.ref === `${ASSEMBLED}:4444444444444444`);
  assert.equal(fresh.heldBy, null);
  assert.match(diskLines(diskReportOf(summary), { listKept: true }).join('\n'), /kept because it is too new to remove/);
});

// ---- 6. removal mode reports honestly (rotation first, unknown sizes, signed change)

const SANDBOX_ID = '11111111-2222-3333-4444-555555555555';
const stoppedBox = { name: 'wf-00000000000000a1', id: SANDBOX_ID, status: 'stopped' };
const oldBox = (l, clock) => { clock.t = NOW - 5 * AGE; l.recordSandbox('wf-00000000000000a1', { pin: CUR, id: SANDBOX_ID }); };

test('unknown sizes: removing only an item with no measured size reports the figure as unknown, never 0 B', async () => {
  const w = world({ sandboxes: [stoppedBox] });
  const { sweeper } = rig(w, { prepare: oldBox });
  const summary = await sweeper.run({ trigger: 'startup' });
  assert.equal(summary.removed, 1);
  assert.equal(summary.expectedBytes, null);
  assert.match(diskLines({ last_sweep: summary, categories: null }).join('\n'), /the plan expected unknown/);
});

test('net change keeps its sign: a drop in free space is negative, an unreadable reading is null', async () => {
  const b1 = looseBoxes(1);
  const w = world({ sandboxes: b1 });
  let reads = 0;
  const { sweeper } = rig(w, { prepare: recordLoose(b1), measureFree: async () => (reads++ === 0 ? 9 * GiB : 8 * GiB), hostFree: async () => 50 * GiB });
  const summary = await sweeper.run({ trigger: 'startup' });
  assert.equal(summary.removed, 1);
  assert.equal(summary.reclaimedBytes, -GiB, 'the measured change is negative');
  assert.match(diskLines({ last_sweep: summary, categories: null }).join('\n'), /net free-space change on the sandbox drive -1\.1 GB/);
  const b2 = looseBoxes(1);
  const w2 = world({ sandboxes: b2 });
  let n = 0;
  const unreadable = rig(w2, { prepare: recordLoose(b2), measureFree: async () => { if (n++ === 0) return 9 * GiB; throw new Error('unreadable'); } });
  assert.equal((await unreadable.sweeper.run({ trigger: 'startup' })).reclaimedBytes, null);
});
