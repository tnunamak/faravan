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
import { planSweep, watermarkStep, SANDBOX_MIN_AGE_MS, WATERMARK_START_FREE_BYTES, WATERMARK_STOP_FREE_BYTES } from '../lib/disk-sweep-plan.mjs';

// The three rules the field research gives for local artifact disk use, each driven through the
// real planner, sweeper and ledger with a fake sbx:
//   1. Roots and leases decide what may be deleted. Age and size only order what is left.
//   2. A running job's lease lasts its whole run (the backend half of this is in docker-backend.test.mjs).
//   3. A pressure sweep starts below the start mark and ends at the stop mark; what it reclaimed
//      is measured from the store afterwards and kept apart from what the plan expected.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sweep-roots-leases-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const GiB = 1024 ** 3;
const hex = c => c.repeat(64);
const CUR = hex('a'), PREV = hex('b'), PINNED = hex('d'), LEASED = hex('e'), LOOSE = hex('c');
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const ASSEMBLED = 'docker.io/library/sandbox-kit-assembled';
const iso = ms => new Date(ms).toISOString();
const mine = (tag, digest, { age = 30 * DAY, size = 1000 } = {}) => ({ id: (digest === LOOSE ? tag : digest).slice(0, 12), repository: ASSEMBLED, tag, flavor: 'codex', created_at: iso(NOW - age), size });
const ref = tag => `${ASSEMBLED}:${tag}`;
let counter = 0;
const OLD_SANDBOX = iso(NOW - 5 * SANDBOX_MIN_AGE_MS);

// Stopped sandboxes this app made, `age` old, each freeing `size` bytes when it goes.
const loose = (n, { age = 30 * DAY, size = 1000, status = 'stopped' } = {}) => ({ name: `wf-00000000000000e${n}`, status, size, age });
const recordAll = (l, w, now = NOW) => {
  for (const sb of w.state.sandboxes) createDiskLedger({ file: l.file, now: () => now - sb.age }).recordSandbox(sb.name, { pin: CUR, id: `id-${sb.name}` });
};

// A fake sbx whose free space moves: each image removal returns `freesPerRemoval(size)` bytes.
function world({ templates = [], sandboxes = [], start = 100 * GiB, freed = size => size } = {}) {
  const state = { templates: [mine('0a0a0a0a0a0a0a0a', CUR, { age: 60 * DAY }), ...templates], sandboxes: [...sandboxes], calls: [], free: start };
  return {
    state,
    removedRefs: () => state.removed ?? [],
    runSbx: async args => {
      state.calls.push(args.join(' '));
      const [a, b] = args;
      if (a === 'template' && b === 'ls') return { code: 0, stdout: JSON.stringify(state.templates), stderr: '' };
      if (a === 'ls') return { code: 0, stdout: JSON.stringify(state.sandboxes.map(sb => ({ id: `id-${sb.name}`, ...sb }))), stderr: '' };
      if (a === 'template' && b === 'rm') {
        const gone = state.templates.find(t => t.id === args[2] || `${t.repository}:${t.tag}` === args[2]); if (gone) (state.removed ??= []).push(`${gone.repository}:${gone.tag}`);
        state.templates = state.templates.filter(t => t !== gone);
        state.free += freed(gone?.size ?? 0);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (a === 'rm') {
        const gone = state.sandboxes.find(sb => sb.name === args[2]);
        if (gone) (state.removed ??= []).push(gone.name);
        state.sandboxes = state.sandboxes.filter(sb => sb !== gone);
        state.free += freed(gone?.size ?? 0);
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'unexpected ' + args.join(' ') };
    },
    hostFree: async () => state.free,
    measureFree: async () => state.free,
  };
}
function rig(w, { pins = [CUR], maxRemovals, clock = { t: NOW }, prepare, stopFreeBytes } = {}) {
  const dir = path.join(root, `case-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'ledger.json');
  const now = () => clock.t;
  const ledger = createDiskLedger({ file, now });
  
  prepare?.(ledger);
  const ownAll = () => ledger.ownImages(w.state.templates.map(t => ({ ref: `${t.repository}:${t.tag}`, imageId: t.id })), 'created');
  ownAll();
  const sweeper = createDiskSweeper({ ledger, coordinator: createStoreCoordinator({ dir }), runSbx: w.runSbx, journal: { recorded: () => true }, pins: () => pins,
    referenced: () => new Set(), measureFree: w.measureFree, hostFree: w.hostFree, maxRemovals, stopFreeBytes, now });
  return { ledger, sweeper, clock };
}

// ---- 1. roots and leases decide; age and size only order

test('rule 1: an old, huge sandbox is kept when a lease or a job holds it, however low the disk is; the loose one goes', async () => {
  const huge = { age: 400 * DAY, size: 90 * GiB };
  const w = world({
    start: 1 * GiB,
    sandboxes: [loose(1, huge), loose(2, { ...huge, status: 'running' }), loose(3, huge)],
  });
  const { sweeper } = rig(w, { prepare: l => {
    recordAll(l, w);
    l.acquireLease({ item: 'sandbox:wf-00000000000000e1', ttlMs: 60_000 });
  } });
  const summary = await sweeper.run({ trigger: 'pressure' });
  assert.deepEqual(w.removedRefs(), ['wf-00000000000000e3'], 'only the unleased, stopped sandbox is removed, though the disk is nearly full and the others are as old and as big');
  assert.equal(summary.kept.running, 1);
  assert.equal(summary.kept.leased, 1);
});

test('rule 1: no age, no size and no pressure ever makes a rooted, leased or running thing eligible (planner level)', () => {
  const t = NOW;
  const item = (kind, id, extra = {}) => ({ id, kind, ref: id, createdAt: t - 900 * DAY, bytes: 500 * GiB, ...extra });
  const owned = [
    item('image', 'image:cur', { imageId: CUR.slice(0, 12) }),
    item('image', 'image:prev', { imageId: PREV.slice(0, 12) }),
    item('image', 'image:pinlease', { imageId: LEASED.slice(0, 12) }),
    item('image', 'image:named', { imageId: LOOSE.slice(0, 12) }),
    item('sandbox', 'sandbox:running', { ref: 'running', status: 'running' }),
    item('sandbox', 'sandbox:referenced', { ref: 'referenced', status: 'stopped' }),
    item('sandbox', 'sandbox:leased', { ref: 'leased', status: 'stopped' }),
  ];
  const plan = planSweep({
    owned,
    roots: { current: new Set([CUR]), previous: new Set([PREV]), sandboxes: new Map(), referenced: new Set(['referenced']), cacheKeep: new Set() },
    leases: [{ item: 'sandbox:leased', expiresAt: t + 1000 }, { item: 'image:named', expiresAt: t + 1000 }, { item: 'sandbox:x', pin: LEASED, expiresAt: t + 1000 }],
    now: t,
  });
  assert.deepEqual(plan.delete, [], 'nothing is eligible');
  assert.equal(plan.keep.length, owned.length);
});

test('rule 1: among items that are already unrooted and unleased, the oldest goes first and a tie goes to the larger; too-new ones stay', () => {
  const t = NOW;
  const loose = (tag, age, size) => ({ id: `image:${tag}`, kind: 'image', ref: tag, imageId: LOOSE.slice(0, 12), createdAt: t - age, bytes: size });
  const plan = planSweep({
    owned: [
      loose('young-big', 2 * DAY, 90 * GiB),
      loose('old-small', 40 * DAY, 1 * GiB),
      loose('old-big', 40 * DAY, 9 * GiB),
      loose('too-new', 60_000, 500 * GiB),
      { id: 'image:anchor', kind: 'image', ref: 'anchor', imageId: CUR.slice(0, 12), createdAt: t - 99 * DAY, bytes: 1 },
    ],
    roots: { current: new Set([CUR]), previous: new Set(), sandboxes: new Map(), referenced: new Set(), cacheKeep: new Set() },
    now: t,
  });
  assert.deepEqual(plan.delete.map(item => item.ref), ['old-big', 'old-small', 'young-big']);
  assert.deepEqual(plan.keep.map(item => [item.ref, item.reason]).sort(), [['anchor', 'current_pin'], ['too-new', 'too_new']]);
});

test('rule 1: when the work bound cuts a run short, the oldest candidates were the ones taken', async () => {
  const w = world({ sandboxes: [loose(1, { age: 3 * DAY }), loose(2, { age: 90 * DAY }), loose(3, { age: 30 * DAY })] });
  const { sweeper } = rig(w, { maxRemovals: 2, prepare: l => recordAll(l, w) });
  const summary = await sweeper.run({ trigger: 'startup' });
  assert.deepEqual(w.removedRefs(), ['wf-00000000000000e2', 'wf-00000000000000e3']);
  assert.equal(summary.kept.deferred_bounded_work, 1);
});

// ---- 2. a lease held by a running job protects its artifacts

test('rule 2: a job lease holds its sandbox while it is renewed, and stops holding when renewals stop', async () => {
  const w = world({ sandboxes: [loose(1, { age: 50 * DAY })] });
  const clock = { t: NOW };
  const ttl = 10 * 60 * 1000;
  let leaseId;
  const { sweeper, ledger } = rig(w, { clock, prepare: l => {
    recordAll(l, w);
    leaseId = l.acquireLease({ item: 'sandbox:wf-00000000000000e1', ttlMs: ttl });
  } });
  // The job runs for hours: each sweep finds the lease renewed.
  for (let step = 1; step <= 36; step++) {
    clock.t = NOW + step * 5 * 60 * 1000;
    assert.equal(ledger.renewLease(leaseId, ttl), true);
    const summary = await sweeper.run({ trigger: 'startup' });
    assert.equal(summary.removed, 0, `step ${step}: the job's sandbox stays`);
    assert.ok(summary.kept.leased >= 1, 'the leased sandbox is held');
  }
  assert.deepEqual(w.removedRefs(), []);
  // The process died: nobody renews. After the ttl the lease no longer holds, and the roots decide.
  clock.t += ttl + 1;
  assert.equal(ledger.renewLease(leaseId, ttl), false, 'an expired lease cannot be renewed');
  const after = await sweeper.run({ trigger: 'startup' });
  assert.equal(ledger.activeLeases().length, 0);
  assert.equal(after.kept.leased ?? 0, 0);
});

test('rule 2: a lease taken after the plan, before the removal, still saves the sandbox of a running job', async () => {
  const w = world({ sandboxes: [loose(1, { age: 50 * DAY })] });
  const { ledger } = rig(w, { prepare: l => recordAll(l, w) });
  const original = w.runSbx;
  let taken = false;
  const racing = createDiskSweeper({ ledger, coordinator: createStoreCoordinator({ dir: ledger.dir }), journal: { recorded: () => true }, pins: () => [CUR], referenced: () => new Set(),
    measureFree: w.measureFree, hostFree: w.hostFree, now: () => NOW,
    runSbx: async args => {
      if (args[0] === 'ls' && !taken) { taken = true; const result = await original(args); ledger.acquireLease({ item: 'sandbox:wf-00000000000000e1', ttlMs: 60_000 }); return result; }
      return original(args);
    } });
  const summary = await racing.run({ trigger: 'startup' });
  assert.equal(summary.removed, 0);
  assert.deepEqual(w.removedRefs(), []);
});

// ---- 3. hysteresis and measured reclaim

test('rule 3: the start mark is below the stop mark, and free space between them neither starts nor stops anything by itself', () => {
  assert.ok(WATERMARK_START_FREE_BYTES < WATERMARK_STOP_FREE_BYTES);
  let collecting = false;
  const seen = [];
  for (const free of [25, 12, 9.9, 12, 15, 19.9, 20, 12, 10.1, 9]) {
    collecting = watermarkStep({ freeBytes: free * GiB, collecting });
    seen.push(collecting);
  }
  //            25     12     9.9   12    15    19.9  20     12     10.1   9
  assert.deepEqual(seen, [false, false, true, true, true, true, false, false, false, true]);
});

test('rule 3: a pressure sweep stops removing once free space is back at the stop mark; later sandboxes wait', async () => {
  const w = world({
    start: 5 * GiB,
    sandboxes: [1, 2, 3, 4, 5, 6].map(n => loose(n, { age: (60 - n) * DAY, size: 4 * GiB })),
  });
  const { sweeper } = rig(w, { prepare: l => recordAll(l, w) });
  const summary = await sweeper.run({ trigger: 'pressure' });
  // 5 -> 9 -> 13 -> 17 -> 21 GiB: the fourth removal reaches the stop mark.
  assert.equal(summary.removed, 4);
  assert.equal(summary.kept.stopped_at_low_water, 2);
  assert.equal(w.state.free, 21 * GiB);
  assert.equal(w.state.sandboxes.length, 2);
});

test('rule 3: a pressure sweep that finds free space already at the stop mark removes nothing', async () => {
  const w = world({ start: 25 * GiB, sandboxes: [loose(1, { size: 4 * GiB })] });
  const { sweeper } = rig(w, { prepare: l => recordAll(l, w) });
  const summary = await sweeper.run({ trigger: 'pressure' });
  assert.equal(summary.removed, 0);
  assert.equal(summary.kept.stopped_at_low_water, 1);
  assert.deepEqual(w.removedRefs(), []);
});

test('rule 3: a startup or timer sweep is not a pressure sweep: it removes every eligible sandbox', async () => {
  const w = world({ start: 5 * GiB, sandboxes: [1, 2, 3, 4, 5, 6].map(n => loose(n, { size: 4 * GiB })) });
  const { sweeper } = rig(w, { prepare: l => recordAll(l, w) });
  const summary = await sweeper.run({ trigger: 'timer' });
  assert.equal(summary.removed, 6);
  assert.equal(summary.kept.stopped_at_low_water, undefined);
});

test('rule 3: the reclaimed figure is read from the store after the sweep', async () => {
  // The sandboxes list 80 GiB; the store gains only 3 GiB, because the layers are shared.
  const w = world({
    start: 50 * GiB,
    freed: size => size / (40 * GiB) * 1.5 * GiB,
    sandboxes: [loose(1, { size: 40 * GiB }), loose(2, { size: 40 * GiB })],
  });
  const { sweeper, ledger } = rig(w, { prepare: l => recordAll(l, w) });
  const summary = await sweeper.run({ trigger: 'startup' });
  assert.equal(summary.reclaimedBytes, 3 * GiB);
  assert.equal(ledger.lastSweep().reclaimedBytes, 3 * GiB, 'what doctor reads is the measured one');
});

test('rule 3: a reading that cannot be taken after the sweep leaves the reclaimed figure unknown, never zero', async () => {
  const w = world({ start: 50 * GiB, sandboxes: [loose(1, { size: 4 * GiB })] });
  let reads = 0;
  w.measureFree = async () => { if (++reads > 1) throw new Error('statfs failed'); return 50 * GiB; };
  const { sweeper } = rig(w, { prepare: l => recordAll(l, w) });
  const summary = await sweeper.run({ trigger: 'startup' });
  assert.equal(summary.removed, 1);
  assert.equal(summary.reclaimedBytes, null);
});
