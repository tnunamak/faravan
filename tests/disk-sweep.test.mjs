import './helpers/no-browser.mjs';
import './helpers/removal-on.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiskLedger } from '../lib/disk-ledger.mjs';
import { createDiskSweeper } from '../lib/disk-sweep.mjs';
import { SWEEP_MIN_AGE_MS, SANDBOX_MIN_AGE_MS } from '../lib/disk-sweep-plan.mjs';
const LOG_MAX_BYTES = 5 * 1024 * 1024;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sweep-test-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const hex = c => c.repeat(64);
const CUR = hex('a'), PREV = hex('b'), OLD = hex('c');
const NOW = 1_800_000_000_000;
const AGED = new Date(NOW - 5 * SANDBOX_MIN_AGE_MS).toISOString();
const ASSEMBLED = 'docker.io/library/sandbox-kit-assembled';
const row = (tag, digest, extra = {}) => ({ repository: ASSEMBLED, tag, image_id: digest.slice(0, 12), size: 1000, created: AGED, ...extra });
let counter = 0;

// A fake sbx: a template list, a sandbox list, and calls it was given.
const ANCHOR = '0a0a0a0a0a0a0a0a';
function world({ templates = [], sandboxes = [], failRm = new Set(), freeSeries = [100, 100], anchor = true } = {}) {
  // An image of the current pin is always present, as it is on a machine that has created a sandbox since its last update.
  const hasCurrent = templates.some(t => t.image_id === CUR.slice(0, 12));
  const state = { templates: [...templates, ...(anchor && !hasCurrent ? [row(ANCHOR, CUR)] : [])], sandboxes: [...sandboxes], calls: [] };
  const free = [...freeSeries];
  return {
    state,
    runSbx: async args => {
      state.calls.push(args.join(' '));
      const [a, b] = args;
      if (a === 'template' && b === 'ls') return { code: 0, stdout: JSON.stringify(state.templates), stderr: '' };
      if (a === 'ls') return { code: 0, stdout: JSON.stringify(state.sandboxes.map(sb => ({ id: `id-${sb.name}`, ...sb }))), stderr: '' };
      if (a === 'template' && b === 'rm') {
        if (failRm.has(args[2]) || failRm.has(state.templates.find(t => (t.id ?? t.image_id) === args[2]) && `${state.templates.find(t => (t.id ?? t.image_id) === args[2]).repository}:${state.templates.find(t => (t.id ?? t.image_id) === args[2]).tag}`)) return { code: 1, exited: true, stdout: '', stderr: 'image in use' };
        const hit = state.templates.find(t => (t.id ?? t.image_id) === args[2] || `${t.repository}:${t.tag}` === args[2]); if (hit) (state.removed ??= []).push(`${hit.repository}:${hit.tag}`);
        state.templates = state.templates.filter(t => t !== hit);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (a === 'rm') { state.sandboxes = state.sandboxes.filter(s => s.name !== args[2]); return { code: 0, stdout: '', stderr: '' }; }
      return { code: 1, stdout: '', stderr: 'unexpected ' + args.join(' ') };
    },
    measureFree: async () => (free.length > 1 ? free.shift() : free[0]),
  };
}

function rig(w, { pins = [CUR], recorded = () => true, referenced = new Set(), now = () => NOW, caches, usage, prepare } = {}) {
  const ledger = createDiskLedger({ file: path.join(dir, `ledger-${counter++}.json`), now });
  prepare?.(ledger);
  ledger.ownImages(w.state.templates.map(t => ({ ref: `${t.repository}:${t.tag}`, imageId: t.id ?? t.image_id })), 'created');
  const journal = { recorded };
  const sweeper = createDiskSweeper({ ledger, runSbx: w.runSbx, journal, pins: () => pins, referenced: () => referenced, caches, usage, measureFree: w.measureFree, now });
  return { ledger, sweeper };
}
const ownedLedger = (w, file = path.join(dir, `ledger-${counter++}.json`)) => {
  const ledger = createDiskLedger({ file, now: () => NOW });
  ledger.ownImages(w.state.templates.map(t => ({ ref: `${t.repository}:${t.tag}`, imageId: t.image_id ?? t.id })), 'created');
  ageBoxes(ledger, w);
  return ledger;
};
// Stopped sandboxes this app made long enough ago to be removed, and the records its create path wrote.
const boxes = n => Array.from({ length: n }, (_, i) => ({ name: `wf-00000000000000b${i}`, status: 'stopped' }));
const ageBoxes = (ledger, w) => {
  const old = createDiskLedger({ file: ledger.file, now: () => NOW - 5 * SANDBOX_MIN_AGE_MS });
  for (const sb of w.state.sandboxes) if (/^wf-/.test(sb.name)) old.recordSandbox(sb.name, { pin: OLD, id: `id-${sb.name}` });
};
const refs = w => w.state.templates.map(t => t.tag).filter(tag => tag !== ANCHOR);
const removed = w => [...(w.state.removed ?? []), ...w.state.calls.filter(c => c.startsWith('rm ')).map(c => c.split(' ').pop())];

test('images are reported and kept, never removed, whatever their age or pin', async () => {
  const w = world({ templates: [row('1111111111111111', CUR), row('2222222222222222', PREV), row('3333333333333333', OLD)] });
  const { ledger, sweeper } = rig(w, { prepare: l => { l.notePins([PREV]); } });
  const summary = await sweeper.run({ trigger: 'test' });
  assert.deepEqual(refs(w), ['1111111111111111', '2222222222222222', '3333333333333333']);
  assert.equal(summary.removed, 0);
  assert.equal(summary.kept.image_cleanup_unavailable, 1);
  assert.deepEqual(ledger.lastSweep().trigger, 'test');
});

test('never touches an image the app does not own, even in the same list', async () => {
  const w = world({
    templates: [row('3333333333333333', OLD), { repository: 'myorg/their-app', tag: 'v1', image_id: 'deadbeef0000', size: 5, created: AGED }, { repository: 'docker.io/docker/sandbox-templates', tag: 'claude-code', image_id: 'feedfeedfeed', size: 5, created: AGED }],
  });
  const summary = await rig(w).sweeper.run({ trigger: 'test' });
  assert.deepEqual(removed(w), [], 'no image is removed, ours or foreign');
  assert.ok(w.state.templates.some(t => t.repository === 'myorg/their-app'));
  assert.equal(summary.scanned.notOurs, 2);
  assert.ok(!w.state.calls.some(c => /reset|prune|system/.test(c)), 'no broad command is ever issued');
});

test('never touches a sandbox the app did not make; its unknown image is kept too', async () => {
  const w = world({
    templates: [row('3333333333333333', OLD)],
    sandboxes: [{ name: 'my-own-sandbox', status: 'stopped' }, { name: 'wf-00000000000000aa', status: 'stopped' }],
  });
  const { sweeper } = rig(w, { recorded: name => name === 'wf-00000000000000aa', prepare: l => l.recordSandbox('wf-00000000000000aa', { pin: OLD }) });
  const summary = await sweeper.run({ trigger: 'test' });
  assert.ok(w.state.sandboxes.some(s => s.name === 'my-own-sandbox'));
  assert.equal(refs(w).length, 1, 'a sandbox of unknown origin may use any image');
  assert.equal(summary.kept.sandbox_of_unknown_image, 1);
});

test('mid-job: an image used by a running or a stopped sandbox is kept; a just-made one is kept', async () => {
  const w = world({
    templates: [row('3333333333333333', OLD), row('4444444444444444', hex('d'), { created: new Date(NOW - SWEEP_MIN_AGE_MS / 2).toISOString() })],
    sandboxes: [{ name: 'wf-0000000000000001', status: 'running' }, { name: 'wf-0000000000000002', status: 'stopped' }],
  });
  const { sweeper } = rig(w, { referenced: new Set(['wf-0000000000000002']), prepare: l => { l.recordSandbox('wf-0000000000000001', { pin: OLD }); l.recordSandbox('wf-0000000000000002', { pin: OLD }); } });
  await sweeper.run({ trigger: 'test' });
  assert.deepEqual(removed(w), []);
  assert.equal(refs(w).length, 2);
});

test('a failing removal is reported and does not stop the rest', async () => {
  const w = world({ sandboxes: boxes(2) });
  const bad = 'wf-00000000000000b0';
  const inner = w.runSbx;
  w.runSbx = async args => (args[0] === 'rm' && args[2] === bad ? { code: 1, exited: true, stdout: '', stderr: 'sandbox in use' } : inner(args));
  const { sweeper } = rig(w, { prepare: l => ageBoxes(l, w) });
  const summary = await sweeper.run({ trigger: 'test' });
  assert.equal(summary.removed, 1);
  assert.equal(summary.errors.length, 1);
  assert.match(summary.errors[0].message, /sandbox in use/);
  assert.equal(summary.errors[0].item, bad);
  assert.deepEqual(w.state.sandboxes.map(sb => sb.name), [bad]);
});

test('an unreadable template listing removes nothing and says why', async () => {
  const w = world({ templates: [row('3333333333333333', OLD)] });
  const bad = { ...w, runSbx: async args => (args[0] === 'template' && args[1] === 'ls' ? { code: 0, stdout: '{"surprise":true}', stderr: '' } : w.runSbx(args)) };
  const { sweeper } = rig(bad);
  const summary = await sweeper.run({ trigger: 'test' });
  assert.equal(summary.removed, 0);
  assert.equal(summary.errors[0].item, 'template-listing');
  assert.deepEqual(removed(w), []);
});

test('an unreadable sandbox listing keeps every image, because their use is unknown', async () => {
  const w = world({ templates: [row('3333333333333333', OLD)] });
  const bad = { ...w, runSbx: async args => (args[0] === 'ls' ? { code: 1, stdout: '', stderr: 'daemon down' } : w.runSbx(args)) };
  const { sweeper } = rig(bad);
  const summary = await sweeper.run({ trigger: 'test' });
  assert.equal(summary.removed, 0);
  assert.equal(summary.errors[0].item, 'sandbox-listing');
});

test('stopped orphan sandboxes: removed only when the journal proves them ours, old enough, and no job needs them', async () => {
  const names = ['wf-00000000000000a1', 'wf-00000000000000a2', 'wf-00000000000000a3', 'wf-00000000000000a4'];
  const w = world({ sandboxes: names.map(name => ({ name, status: 'stopped' })).concat([{ name: 'wf-00000000000000a5', status: 'running' }]) });
  const fresh = createDiskLedger({ file: path.join(dir, `ledger-aged-${counter++}.json`), now: () => NOW - 5 * SANDBOX_MIN_AGE_MS });
  for (const n of [...names, 'wf-00000000000000a5']) fresh.recordSandbox(n, { pin: null, id: `id-${n}` });
  const journal = { recorded: name => name !== 'wf-00000000000000a2' };
  const sweeper2 = createDiskSweeper({ ledger: fresh, runSbx: w.runSbx, journal, pins: () => [CUR], referenced: () => new Set(['wf-00000000000000a3']), measureFree: w.measureFree, now: () => NOW });
  const summary = await sweeper2.run({ trigger: 'test' });
  assert.deepEqual(removed(w).sort(), ['wf-00000000000000a1', 'wf-00000000000000a4']);
  assert.equal(summary.kept.running, 1);
  assert.equal(summary.kept.referenced_by_job_or_journal, 1);
});

test('a live lease keeps a sandbox the plan would remove; an expired one does not', async () => {
  const w = world({ sandboxes: boxes(1) });
  let now = NOW;
  const { sweeper, ledger } = rig(w, { now: () => now, prepare: l => ageBoxes(l, w) });
  const id = ledger.acquireLease({ item: 'sandbox:*', ttlMs: 60_000 });
  let summary = await sweeper.run({ trigger: 'test' });
  assert.equal(summary.removed, 0);
  assert.equal(summary.kept.create_in_flight, 1, 'the wildcard lease covers every sandbox');
  now = NOW + 60_001;
  summary = await sweeper.run({ trigger: 'test' });
  assert.equal(summary.removed, 1);
  assert.ok(id);
});

test('a lease taken between plan and removal still protects the item', async () => {
  const w = world({ sandboxes: boxes(1) });
  const { sweeper, ledger } = rig(w, { prepare: l => ageBoxes(l, w) });
  const original = w.runSbx;
  let leased = false;
  const racing = async args => {
    if (args[0] === 'ls' && !leased) { leased = true; const result = await original(args); ledger.acquireLease({ item: 'sandbox:*', ttlMs: 60_000 }); return result; }
    return original(args);
  };
  const racer = createDiskSweeper({ ledger, runSbx: racing, journal: { recorded: () => true }, pins: () => [CUR], referenced: () => new Set(), measureFree: w.measureFree, now: () => NOW });
  const summary = await racer.run({ trigger: 'test' });
  assert.equal(summary.removed, 0);
  assert.deepEqual(removed(w), []);
  assert.ok(sweeper);
});

test('reclaimed bytes come from measured free space; zero is reported as zero', async () => {
  const GiB = 1024 ** 3;
  const w = world({ sandboxes: boxes(1), freeSeries: [50 * GiB, 51 * GiB] });
  const first = await rig(w, { prepare: l => ageBoxes(l, w) }).sweeper.run({ trigger: 'test' });
  assert.equal(first.reclaimedBytes, 1 * GiB);
  const none = world({ sandboxes: boxes(1), freeSeries: [50 * GiB, 50 * GiB] });
  const second = await rig(none, { prepare: l => ageBoxes(l, none) }).sweeper.run({ trigger: 'test' });
  assert.equal(second.removed, 1);
  assert.equal(second.reclaimedBytes, 0, 'sbx kept the content: nothing was physically freed, and the report says so');
  const blind = world({ sandboxes: boxes(1) });
  const bl = createDiskLedger({ file: path.join(dir, `ledger-${counter++}.json`), now: () => NOW });
  ageBoxes(bl, blind);
  const third = await createDiskSweeper({ ledger: bl, runSbx: blind.runSbx, journal: { recorded: () => true }, pins: () => [CUR], referenced: () => new Set(), measureFree: async () => null, now: () => NOW }).run({ trigger: 'test' });
  assert.equal(third.reclaimedBytes, null, 'unmeasured is null, never a guess');
});

test('only one sweep runs at a time', async () => {
  const w = world({ sandboxes: boxes(1) });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const slow = async args => { if (args[0] === 'template' && args[1] === 'ls') await gate; return w.runSbx(args); };
  const sweeper = createDiskSweeper({ ledger: ownedLedger(w), runSbx: slow, journal: { recorded: () => true }, pins: () => [CUR], referenced: () => new Set(), measureFree: w.measureFree, now: () => NOW });
  const first = sweeper.run({ trigger: 'a' });
  const second = await sweeper.run({ trigger: 'b' });
  assert.deepEqual(second, { skipped: 'busy' });
  assert.equal(sweeper.running, true);
  release();
  assert.equal((await first).removed, 1);
  assert.equal(sweeper.running, false);
});

test('work per run is bounded; the rest waits for the next run', async () => {
  const w = world({ sandboxes: boxes(5) });
  const sweeper = createDiskSweeper({ ledger: ownedLedger(w), runSbx: w.runSbx, journal: { recorded: () => true }, pins: () => [CUR], referenced: () => new Set(), measureFree: w.measureFree, now: () => NOW, maxRemovals: 2 });
  const summary = await sweeper.run({ trigger: 'test' });
  assert.equal(summary.removed, 2);
  assert.equal(summary.kept.deferred_bounded_work, 3);
  assert.equal(w.state.sandboxes.length, 3);
});

test('superseded cache directories go; the current one stays; paths outside the cache root are refused', async () => {
  const cacheRoot = path.join(dir, 'guest-runtime');
  for (const name of [hex('1'), hex('2')]) { fs.mkdirSync(path.join(cacheRoot, name), { recursive: true }); fs.writeFileSync(path.join(cacheRoot, name, 'node'), 'x'.repeat(10)); }
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(outside);
  const w = world();
  const old = new Date(NOW - 5 * SANDBOX_MIN_AGE_MS);
  fs.utimesSync(path.join(cacheRoot, hex('1')), old, old);
  fs.utimesSync(path.join(cacheRoot, hex('2')), old, old);
  const { sweeper } = rig(w, { caches: { root: cacheRoot, current: hex('2') }, prepare: l => { l.ownCache(path.join(cacheRoot, hex('1')), 'created'); l.ownCache(path.join(cacheRoot, hex('2')), 'created'); } });
  const summary = await sweeper.run({ trigger: 'test' });
  assert.equal(fs.existsSync(path.join(cacheRoot, hex('1'))), false);
  assert.equal(fs.existsSync(path.join(cacheRoot, hex('2'))), true);
  assert.equal(fs.existsSync(outside), true);
  assert.equal(summary.removed, 1);
  assert.equal(summary.kept.current_cache, 1);
});

test('the summary reports use per category; logs are only measured and workspaces are never removed are measured, never removed', async () => {
  const base = fs.mkdtempSync(path.join(dir, 'usage-'));
  const scratchRoot = path.join(base, 'scratch');
  const logsDir = path.join(base, 'logs');
  const cacheRoot = path.join(base, 'guest-runtime');
  fs.mkdirSync(path.join(scratchRoot, 'wf-job-wf-0000000000000001-x'), { recursive: true });
  fs.writeFileSync(path.join(scratchRoot, 'wf-job-wf-0000000000000001-x', 'a'), 'x'.repeat(300));
  fs.mkdirSync(path.join(scratchRoot, 'someone-elses-dir'));
  fs.writeFileSync(path.join(scratchRoot, 'someone-elses-dir', 'b'), 'y'.repeat(999));
  fs.mkdirSync(logsDir);
  fs.writeFileSync(path.join(logsDir, 'launcher.log'), 'l'.repeat(LOG_MAX_BYTES + 10));
  fs.writeFileSync(path.join(logsDir, 'small.log'), 'tiny');
  fs.mkdirSync(path.join(cacheRoot, hex('1')), { recursive: true });
  fs.writeFileSync(path.join(cacheRoot, hex('1'), 'node'), 'n'.repeat(50));
  const w = world({ templates: [row('1111111111111111', CUR, { size: 700 }), row('3333333333333333', OLD, { size: 40 })], sandboxes: [{ name: 'wf-0000000000000001', status: 'running' }] });
  const { sweeper } = rig(w, { caches: { root: cacheRoot, current: hex('1') }, usage: { scratchRoot, logsDir, cacheRoot }, prepare: l => l.recordSandbox('wf-0000000000000001', { pin: CUR, id: 'id-wf-0000000000000001' }) });
  const summary = await sweeper.run({ trigger: 'test' });
  assert.deepEqual(summary.categories.images, { count: 2, listedBytes: 740, partial: false }, 'images are never removed');
  assert.deepEqual(summary.categories.sandboxes, { count: 1 });
  assert.deepEqual(summary.categories.workspaces, { count: 1, bytes: 300, partial: false }, 'only the app’s own job directories, and nothing deleted');
  assert.ok(fs.existsSync(path.join(scratchRoot, 'wf-job-wf-0000000000000001-x', 'a')));
  assert.ok(fs.existsSync(path.join(scratchRoot, 'someone-elses-dir', 'b')));
  assert.equal(summary.categories.caches.bytes, 50);
  assert.equal(summary.logsRotated, undefined);
  assert.equal(fs.existsSync(path.join(logsDir, 'launcher.log.1')), false, 'a log is never rotated');
  assert.ok(fs.existsSync(path.join(logsDir, 'launcher.log')));
  assert.ok(fs.existsSync(path.join(logsDir, 'small.log')));
  assert.equal(summary.categories.logs.bytes, LOG_MAX_BYTES + 10 + 4);
});
