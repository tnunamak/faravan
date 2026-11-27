import './helpers/no-browser.mjs';
import './helpers/removal-off.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiskLedger } from '../lib/disk-ledger.mjs';
import { createDiskSweeper } from '../lib/disk-sweep.mjs';
import { createSweepScheduler } from '../lib/disk-sweep-schedule.mjs';
import { readDiskReport, diskLines } from '../lib/disk-report.mjs';
import { kitImageReport, SWEEP_MIN_AGE_MS, SANDBOX_MIN_AGE_MS } from '../lib/disk-sweep-plan.mjs';

test('kit retention is report-only and preserves newest and unproven images', () => {
  const image = (name, digit, daysAgo) => ({
    kind: 'image', ref: `${ASSEMBLED}:${name}`, imageId: digit.repeat(12),
    createdAt: daysAgo === null ? null : NOW - daysAgo * 86_400_000, bytes: 1000,
  });
  const [current, previous, newest, recent, older, unknown, undated] = [
    image('current', 'a', 8), image('previous', 'b', 7), image('newest', 'c', 1),
    image('recent', 'd', 2), image('older', 'e', 3), image('unknown', 'f', 4), image('undated', '0', null),
  ];
  const images = [older, current, unknown, newest, previous, undated, recent];
  const generation = item => ({ digests: [CUR], images: [{ imageId: item.imageId, inputDigest: CUR }] });
  const params = {
    images, owned: Object.fromEntries(images.filter(item => item !== unknown)
      .map(item => [item.ref, { imageId: item.imageId, kitInputDigest: CUR }])),
    generations: { current: generation(current), previous: generation(previous) },
    complete: true, now: NOW,
  };
  const report = kitImageReport(params);
  assert.equal(report.reportOnly, true);
  assert.deepEqual(report.images.filter(row => row.eligible).map(row => row.ref), [older.ref]);
  assert.deepEqual(Object.fromEntries(report.images.map(row => [row.ref, row.reason])), {
    [older.ref]: 'eligible', [current.ref]: 'current_kit', [unknown.ref]: 'not_owned',
    [newest.ref]: 'retained_recent', [previous.ref]: 'previous_kit', [undated.ref]: 'age_unknown',
    [recent.ref]: 'retained_recent',
  });
  for (const guards of [
    { sandboxes: new Map([['live', { status: 'running', pin: CUR }]]) },
    { sandboxes: new Map([['retained', { status: 'absent', pin: CUR }]]) },
    { leases: [{ item: 'sandbox:fixture', pin: CUR, expiresAt: NOW + 1 }] },
    { leases: [{ item: 'image:*', expiresAt: NOW + 1 }] },
    { complete: false }, { unresolved: true }, { generations: null },
    { images: [...images, { ...older, ref: `${ASSEMBLED}:unowned-alias` }] },
  ]) assert.equal(kitImageReport({ ...params, ...guards }).eligible, 0);
});

// This release reports disk use and what a cleanup could free. It deletes nothing. The code that
// can delete stays behind an explicit opt-in; removal defaults off.
const SETTING = 'FARAVAN_DISK_SWEEP_REMOVES_ARTIFACTS';
process.env[SETTING] = '0';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-report-only-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const GiB = 1024 ** 3;
const hex = c => c.repeat(64);
const CUR = hex('a'), OLD = hex('c');
const NOW = 1_800_000_000_000;
const ASSEMBLED = 'docker.io/library/sandbox-kit-assembled';
const aged = new Date(NOW - 5 * Math.max(SWEEP_MIN_AGE_MS, SANDBOX_MIN_AGE_MS)).toISOString();
const row = (tag, digest, size = 1000) => ({ repository: ASSEMBLED, tag, image_id: digest.slice(0, 12), size, created: aged });
let counter = 0;

function world({ templates = [], sandboxes = [], removeSandbox = () => true } = {}) {
  const state = { templates: [row('0a0a0a0a0a0a0a0a', CUR), ...templates], sandboxes: [...sandboxes], calls: [], argvCalls: [] };
  return {
    state,
    runSbx: async args => {
      state.calls.push(args.join(' '));
      state.argvCalls.push([...args]);
      const [a, b] = args;
      if (a === 'template' && b === 'ls') return { code: 0, stdout: JSON.stringify(state.templates), stderr: '' };
      if (a === 'ls') return { code: 0, stdout: JSON.stringify(state.sandboxes.map(sb => ({ id: `id-${sb.name}`, ...sb }))), stderr: '' };
      if (a === 'rm' && removeSandbox(args)) state.sandboxes = state.sandboxes.filter(sb => sb.name !== args[2]);
      if (a === 'template' && b === 'rm') state.templates = state.templates.filter(t => t.image_id !== args[2] && `${t.repository}:${t.tag}` !== args[2]);
      return { code: 0, stdout: '', stderr: '' }; // any other command "works", so a removal would show
    },
  };
}
const removalCalls = w => w.state.calls.filter(c => !/^(template ls|ls) /.test(c));

// Only ordinary directories and files in this test's owned fixture trees.
function treeBytes(dir) {
  const entries = [];
  function visit(relative) {
    const absolute = path.join(dir, relative);
    const info = fs.lstatSync(absolute);
    if (info.isDirectory()) {
      entries.push([relative, 'directory']);
      for (const name of fs.readdirSync(absolute).sort()) visit(path.join(relative, name));
    } else {
      assert.equal(info.isFile(), true, 'fixture contains only ordinary files');
      entries.push([relative, 'file', fs.readFileSync(absolute).toString('hex')]);
    }
  }
  visit('');
  return entries;
}

function seedCache(cache) {
  fs.mkdirSync(path.join(cache, 'nested', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(cache, 'root.bin'), Buffer.from([0, 17, 255, 42]));
  fs.writeFileSync(path.join(cache, 'nested', 'sentinel.txt'), 'retain the nested cache bytes\n');
  fs.writeFileSync(path.join(cache, 'nested', 'deeper', 'sentinel.bin'), Buffer.from([93, 0, 201, 7]));
  // The real plan ages the cache directory by mtime; age it AFTER creating children.
  const old = new Date(NOW - 30 * 24 * 3600 * 1000);
  fs.utimesSync(cache, old, old);
}

function rig(w, { free = 5 * GiB, caches = null, usage = null, ownImages = false } = {}) {
  const dir = path.join(root, `case-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  const ledger = createDiskLedger({ file: path.join(dir, 'ledger.json'), now: () => NOW });
  if (ownImages) { ledger.ownImages(w.state.templates.map(t => ({ ref: `${t.repository}:${t.tag}`, imageId: t.image_id })), 'created'); }
  const sweeper = createDiskSweeper({ ledger, runSbx: w.runSbx, journal: { recorded: () => true }, pins: () => [CUR], referenced: () => new Set(),
    caches, usage, measureFree: async () => free, now: () => NOW });
  return { ledger, sweeper, dir };
}

test('no trigger removes anything while the setting is off: not an image, a sandbox, a cache or a log', async () => {
  for (const trigger of ['startup', 'timer', 'pressure', 'doctor']) {
    const base = path.join(root, `files-${counter++}`);
    const cacheRoot = path.join(base, 'cache');
    const cache = path.join(cacheRoot, hex('7'));
    const logs = path.join(base, 'logs');
    seedCache(cache);
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, 'big.log'), Buffer.alloc(6 * 1024 * 1024, 'report-only-log-sentinel\\n'));
    const w = world({ templates: [row('1111111111111111', OLD, 2 * GiB), row('2222222222222222', hex('d'), 1 * GiB)], sandboxes: [{ name: 'wf-00000000000000a1', status: 'stopped' }] });
    const { sweeper, ledger } = rig(w, { ownImages: true, caches: () => ({ root: cacheRoot, current: hex('9'), offer: true }), usage: { logsDir: logs } });
    ledger.ownCache(cache, 'created');
    // The sandbox was recorded long ago, from the current image, so it is old enough to be a candidate.
    createDiskLedger({ file: ledger.file, now: () => NOW - 10 * 3600 * 1000 }).recordSandbox('wf-00000000000000a1', { pin: CUR, id: 'id-wf-00000000000000a1', cache: path.join(cacheRoot, hex('9')) });
    ledger.acquireLease({ item: 'image:*', ttlMs: 60_000, pin: CUR });
    const readLedger = () => JSON.parse(fs.readFileSync(ledger.file, 'utf8'));
    const beforeLedger = readLedger();
    assert.equal(Object.keys(beforeLedger.leases).length, 1, `${trigger}: nonempty live lease witness`);
    assert.deepEqual(beforeLedger.ops, {}, trigger);
    assert.equal(beforeLedger.lastSweep, null, trigger);
    const beforeTemplates = structuredClone(w.state.templates);
    const beforeSandboxes = structuredClone(w.state.sandboxes);
    const intents = [];
    const beginOp = ledger.beginOp.bind(ledger);
    ledger.beginOp = (...args) => { intents.push(args); return beginOp(...args); };
    const before = treeBytes(base);
    const summary = await sweeper.run({ trigger });
    assert.deepEqual(treeBytes(base), before, `${trigger}: every relative path and byte is preserved`);
    assert.deepEqual(summary.errors, [], trigger);
    assert.deepEqual(w.state.argvCalls, [['template', 'ls', '--json'], ['template', 'ls', '--json'], ['ls', '--json']],
      `${trigger}: only the ordered preliminary and planning listings ran`);
    assert.deepEqual(w.state.templates, beforeTemplates, `${trigger}: images are untouched`);
    assert.deepEqual(w.state.sandboxes, beforeSandboxes, `${trigger}: sandboxes are untouched`);
    assert.deepEqual(intents, [], `${trigger}: no transient removal intent was recorded`);
    assert.equal(summary.removed, 0, trigger);
    assert.equal(fs.existsSync(cache), true, `${trigger}: the cache is still there`);
    assert.deepEqual(fs.readdirSync(logs), ['big.log'], `${trigger}: the log was not rotated`);
    assert.equal(summary.removes, false);
    assert.equal(summary.eligible, 1, `${trigger}: the plan still names the sandbox; images are never in it`);
    assert.equal(summary.kept.live_sandbox, 1, `${trigger}: the cache is held while a sandbox is in the listing`);
    assert.equal(summary.expectedPartial, true, 'the sandbox has no size, and the figure says so');
    const afterLedger = readLedger();
    for (const field of ['version', 'owned', 'sandboxes', 'leases', 'ops']) {
      assert.deepEqual(afterLedger[field], beforeLedger[field], `${trigger}: ledger ${field} is unchanged`);
    }
    assert.deepEqual(afterLedger.pins, { current: [CUR], previous: [] }, `${trigger}: current pin bookkeeping persists`);
    assert.deepEqual(afterLedger.lastSweep, summary, `${trigger}: the real sweep summary persists`);
    const ledgerBytes = fs.readFileSync(ledger.file);
    const { last_sweep: report } = readDiskReport(base, { ledgerFile: ledger.file });
    assert.equal(report.trigger, trigger);
    assert.equal(report.eligible, summary.eligible);
    assert.equal(report.removes, false);
    assert.equal(report.removed, 0);
    assert.deepEqual(fs.readFileSync(ledger.file), ledgerBytes, `${trigger}: reporting itself does not write the ledger`);
  }
});

test('report-only does not restore a lease released during its first inventory', async () => {
  const w = world();
  const list = w.runSbx;
  let entered, unblock, first = true;
  const firstInventory = new Promise(resolve => { entered = resolve; });
  const parked = new Promise(resolve => { unblock = resolve; });
  w.runSbx = async args => {
    if (first) {
      first = false;
      assert.deepEqual(args, ['template', 'ls', '--json']);
      entered();
      await parked;
    }
    return list(args);
  };
  const { ledger, sweeper } = rig(w);
  const released = ledger.acquireLease({ item: 'image:*', ttlMs: 60_000, pin: CUR });
  const sibling = ledger.acquireLease({ item: 'sandbox:wf-00000000000000a1', ttlMs: 60_000, pin: CUR });
  const readLedger = () => JSON.parse(fs.readFileSync(ledger.file, 'utf8'));
  const before = readLedger();
  assert.deepEqual(Object.keys(before.leases).sort(), [released, sibling].sort());
  const survivor = { [sibling]: before.leases[sibling] };
  assert.equal(before.lastSweep, null);
  const run = sweeper.run({ trigger: 'startup' });
  const within = async (work, phase) => {
    let timer;
    try {
      return await Promise.race([work, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(phase + ' timed out')), 10_000);
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    await within(Promise.race([firstInventory, run.then(() => {
      throw new Error('sweep completed before entering the parked inventory');
    })]), 'first inventory');
    const other = createDiskLedger({ file: ledger.file, now: () => NOW });
    other.releaseLease(released);
    assert.deepEqual(readLedger().leases, survivor, 'the second writer persisted only the sibling before resume');
  } finally { unblock(); }
  const summary = await within(run, 'report-only sweep completion');
  const after = readLedger();
  assert.deepEqual(after.leases, survivor, 'report-only does not resurrect the lease or rewrite the sibling');
  assert.deepEqual(after.ops, before.ops, 'no removal operation persisted');
  assert.deepEqual(after.lastSweep, summary, 'the real report persisted after the second writer');
  assert.deepEqual(summary.errors, []);
  assert.equal(summary.removes, false);
  assert.equal(summary.removed, 0);
  const isTemplateList = args => args.length === 3 && args.join(' ') === 'template ls --json';
  const firstTemplate = w.state.argvCalls.findIndex(isTemplateList);
  const planningTemplate = w.state.argvCalls.findIndex((args, i) => i > firstTemplate && isTemplateList(args));
  const planningSandbox = w.state.argvCalls.findIndex((args, i) => i > planningTemplate && args.length === 2 && args.join(' ') === 'ls --json');
  assert.ok(firstTemplate >= 0 && planningTemplate > firstTemplate && planningSandbox > planningTemplate,
    'the parked preliminary listing precedes the planning template and sandbox listings');
  assert.deepEqual(removalCalls(w), []);
});

test('the plan names an old cache when no sandbox is live, and still deletes nothing', async () => {
  const base = path.join(root, `files-${counter++}`);
  const cacheRoot = path.join(base, 'cache');
  const cache = path.join(cacheRoot, hex('7'));
  seedCache(cache);
  const w = world();
  const { sweeper, ledger } = rig(w, { caches: () => ({ root: cacheRoot, current: hex('9'), offer: true }) });
  ledger.ownCache(cache, 'created');
  const before = treeBytes(base);
  const summary = await sweeper.run({ trigger: 'startup' });
  assert.equal(summary.eligible, 1);
  assert.equal(summary.scanned.caches, 1);
  assert.equal(summary.removes, false);
  assert.equal(summary.removed, 0);
  assert.equal(summary.expectedBytes, null, 'the actual cache plan does not claim a measured size');
  assert.equal(summary.expectedPartial, true);
  assert.equal(summary.reclaimedBytes, null);
  assert.deepEqual(summary.errors, []);
  assert.equal(fs.existsSync(cache), true);
  assert.deepEqual(treeBytes(base), before, 'eligible cache contents and paths are unchanged');
  assert.deepEqual(w.state.argvCalls, [['template', 'ls', '--json'], ['template', 'ls', '--json'], ['ls', '--json']],
    'clean report-only startup dispatches only the ordered listing calls');
  assert.deepEqual(removalCalls(w), []);

  // Read the ledger the real disabled sweep persisted, not a manufactured summary.
  const ledgerBytes = fs.readFileSync(ledger.file);
  const report = readDiskReport(base, { ledgerFile: ledger.file });
  assert.equal(report.last_sweep.eligible, 1);
  assert.equal(report.last_sweep.removes, false);
  assert.equal(report.last_sweep.removed, 0);
  assert.equal(report.last_sweep.expectedBytes, null);
  assert.equal(report.last_sweep.reclaimedBytes, null);
  const lines = diskLines(report);
  assert.ok(lines.some(line => line.startsWith('Cleanup:') && line.toLowerCase().includes('cleanup is turned off on this computer')));
  assert.match(lines.join('\\n'), /found 1 items a cleanup would remove; could free: unknown/);
  assert.doesNotMatch(lines.join('\\n'), /measured reclaimed|net free-space change|freed [0-9]|removed [0-9]+ of/);
  assert.deepEqual(fs.readFileSync(ledger.file), ledgerBytes, 'reporting preserves the persisted ledger bytes');
});

test('pressure polling reports an eligible cache without changing it', async t => {
  const cacheRoot = path.join(root, `pressure-cache-${counter++}`);
  const cache = path.join(cacheRoot, hex('7'));
  seedCache(cache);
  const w = world();
  const { sweeper, ledger } = rig(w, { caches: () => ({ root: cacheRoot, current: hex('9'), offer: true }) });
  ledger.ownCache(cache, 'created');
  const intents = [];
  const beginOp = ledger.beginOp.bind(ledger);
  ledger.beginOp = (...args) => { intents.push(args); return beginOp(...args); };

  let at = 0;
  const timers = [];
  const pressureArmed = Promise.withResolvers();
  const clock = {
    setTimeout(fn, ms) { const handle = { fn, at: at + ms }; timers.push(handle); if (ms === 10 * 60 * 1000) pressureArmed.resolve(); return handle; },
    clearTimeout(handle) { handle.dead = true; },
  };
  const scheduler = createSweepScheduler({
    sweeper, hostFree: async () => 1 * GiB, ready: Promise.resolve(),
    timers: clock, random: () => 0.5, now: () => at,
  });
  t.after(() => scheduler.stop());
  const readLedger = () => JSON.parse(fs.readFileSync(ledger.file, 'utf8'));
  const readPublic = () => readDiskReport(cacheRoot, { ledgerFile: ledger.file }).last_sweep;
  const beforeCache = treeBytes(cacheRoot);
  scheduler.start();
  await pressureArmed.promise;
  assert.equal(readPublic()?.trigger, 'startup');
  const beforePressure = readLedger();
  const callOffset = w.state.argvCalls.length;
  const beforeListings = structuredClone([w.state.templates, w.state.sandboxes]);

  at = 10 * 60 * 1000;
  const pressure = timers.find(handle => !handle.dead && handle.at === at);
  assert.ok(pressure, 'the scheduler armed its pressure poll');
  await pressure.fn();

  const afterPressure = readLedger();
  const { lastSweep, ...afterOwnership } = afterPressure;
  const { lastSweep: startupSweep, ...beforeOwnership } = beforePressure;
  assert.equal(startupSweep.trigger, 'startup');
  assert.equal(lastSweep.trigger, 'pressure');
  assert.equal(lastSweep.eligible, 1);
  assert.equal(lastSweep.scanned.caches, 1);
  assert.equal(lastSweep.removes, false);
  assert.equal(lastSweep.removed, 0);
  assert.equal(lastSweep.reclaimedBytes, null);
  assert.deepEqual(lastSweep.errors, []);
  assert.deepEqual(afterOwnership, beforeOwnership);
  assert.deepEqual(treeBytes(cacheRoot), beforeCache);
  assert.deepEqual([w.state.templates, w.state.sandboxes], beforeListings);
  assert.deepEqual(w.state.argvCalls.slice(callOffset).sort(), [
    ['ls', '--json'], ['template', 'ls', '--json'], ['template', 'ls', '--json'],
  ]);
  assert.deepEqual(intents, []);
  assert.deepEqual(removalCalls(w), []);
  const ledgerBytes = fs.readFileSync(ledger.file);
  const report = readPublic();
  assert.deepEqual([report.trigger, report.eligible, report.removes, report.removed, report.reclaimedBytes],
    ['pressure', 1, false, 0, null]);
  assert.deepEqual(fs.readFileSync(ledger.file), ledgerBytes);
});

test('the plan is the removal plan: an image no record names is not in it, and shows as not touched', async () => {
  const w = world({ templates: [row('1111111111111111', OLD, 2 * GiB)] });
  const { sweeper } = rig(w);
  const summary = await sweeper.run({ trigger: 'startup' });
  assert.equal(summary.eligible, 0);
  assert.equal(summary.notTouched.images.count, 2, 'the current image and the old one are both unrecorded');
});

test('a complete report-only listing replaces the prior partial observation', async () => {
  const w = world();
  const list = w.runSbx;
  let failListing = true;
  w.runSbx = async args => {
    const observation = await list(args);
    return failListing && args[0] === 'ls' ? { code: 1, stdout: '', stderr: 'synthetic listing failed' } : observation;
  };
  const { sweeper, ledger, dir } = rig(w, { ownImages: true });
  const readLedger = () => JSON.parse(fs.readFileSync(ledger.file, 'utf8'));
  const readPublic = () => readDiskReport(dir, { ledgerFile: ledger.file }).last_sweep;
  const beforeWorld = structuredClone([w.state.templates, w.state.sandboxes]);
  const intents = [];
  const beginOp = ledger.beginOp.bind(ledger);
  ledger.beginOp = (...args) => { intents.push(args); return beginOp(...args); };

  const partial = await sweeper.run({ trigger: 'startup' });
  assert.equal(partial.listingsComplete, false);
  assert.equal(partial.expectedPartial, true);
  assert.equal(partial.expectedBytes, null);
  const { lastSweep: first, ...beforeOwnership } = readLedger();
  assert.deepEqual(first, partial);
  const firstReport = readPublic();
  assert.deepEqual([firstReport.trigger, firstReport.expectedPartial, firstReport.expectedBytes],
    ['startup', true, null]);

  failListing = false;
  const callsBefore = w.state.argvCalls.length;
  const complete = await sweeper.run({ trigger: 'timer' });
  const recoveredCalls = w.state.argvCalls.slice(callsBefore);
  assert.ok(recoveredCalls.some(args => args[0] === 'ls' && args[1] === '--json'));
  assert.ok(recoveredCalls.some(args => args[0] === 'template' && args[1] === 'ls'));
  assert.equal(complete.scanned.images, beforeWorld[0].length);
  assert.equal(complete.eligible, 0);
  assert.equal(complete.listingsComplete, true);
  assert.equal(complete.expectedPartial, false);
  assert.equal(complete.expectedBytes, 0);
  assert.deepEqual(complete.errors, []);
  const { lastSweep: latest, ...afterOwnership } = readLedger();
  assert.deepEqual(latest, complete);
  assert.deepEqual(afterOwnership, beforeOwnership);
  const bytes = fs.readFileSync(ledger.file);
  const latestReport = readPublic();
  assert.deepEqual([latestReport.trigger, latestReport.expectedPartial, latestReport.expectedBytes],
    ['timer', false, 0]);
  for (const result of [partial, complete, firstReport, latestReport]) {
    assert.deepEqual([result.removes, result.removed, result.reclaimedBytes], [false, 0, null]);
  }
  assert.deepEqual(fs.readFileSync(ledger.file), bytes);
  assert.deepEqual([w.state.templates, w.state.sandboxes], beforeWorld);
  assert.deepEqual(intents, []);
  assert.deepEqual(removalCalls(w), []);
});

test('a sweep records no ownership: no upgrade adoption', async () => {
  const w = world({ templates: [row('1111111111111111', OLD)] });
  const { sweeper, ledger } = rig(w);
  await sweeper.run({ trigger: 'startup' });
  await sweeper.run({ trigger: 'timer' });
  assert.deepEqual(ledger.ownedImages(), {});
  assert.deepEqual(ledger.ownedCaches(), {});
});

test('with the setting on, the same sweep removes a stopped sandbox this app recorded (the code is kept and still works)', async () => {
  process.env[SETTING] = '1';
  try {
    const unrelated = { name: 'wf-00000000000000b2', status: 'stopped' };
    const name = 'wf-00000000000000a1';
    const id = `id-${name}`;
    const dispatchOps = [];
    const w = world({ templates: [row('1111111111111111', OLD)], sandboxes: [
      { name, status: 'stopped' }, unrelated,
    ], removeSandbox: () => { dispatchOps.push(readLedger().ops); return true; } });
    const cacheRoot = path.join(root, `enabled-cache-${counter++}`);
    const cache = path.join(cacheRoot, hex('9'));
    seedCache(cache);
    const beforeCache = treeBytes(cacheRoot);
    const beforeImages = structuredClone(w.state.templates);
    const { sweeper, ledger } = rig(w, { ownImages: true, caches: () => ({ root: cacheRoot, current: hex('9'), offer: true }) });
    const readLedger = () => JSON.parse(fs.readFileSync(ledger.file, 'utf8'));
    ledger.ownCache(cache, 'created');
    createDiskLedger({ file: ledger.file, now: () => NOW - 10 * 3600 * 1000 }).recordSandbox('wf-00000000000000a1', { pin: CUR, id: 'id-wf-00000000000000a1' });
    const summary = await sweeper.run({ trigger: 'startup' });
    assert.equal(summary.removed, 1);
    assert.equal(summary.removes, true);
    assert.equal(summary.eligible, 1);
    assert.deepEqual(summary.errors, []);
    assert.deepEqual(w.state.argvCalls.filter(args => args[0] !== 'ls' && !(args[0] === 'template' && args[1] === 'ls')),
      [['rm', '--force', 'wf-00000000000000a1']], 'one exact owned-sandbox removal, no other destructive command');
    assert.equal(dispatchOps.length, 1, 'one journal snapshot at fake dispatch');
    assertSandboxIntent(dispatchOps[0], name, id);
    const [operationId] = Object.keys(dispatchOps[0]);
    assert.equal(Object.hasOwn(readLedger().ops, operationId), false,
      'verified removal closes the exact persisted operation');
    assert.deepEqual(w.state.sandboxes, [unrelated], 'the owned sandbox is actually absent and the unrelated one remains');
    assert.deepEqual(w.state.templates, beforeImages, 'all retained image identities remain');
    const reopened = createDiskSweeper({
      ledger: createDiskLedger({file:ledger.file}),
      runSbx: w.runSbx,
      journal: {recorded: () => true},
      pins: () => [CUR],
      referenced: () => new Set(),
      measureFree: async () => 5 * GiB,
      now: () => NOW,
    });
    const again = await reopened.run({trigger:'timer'});
    assert.deepEqual(again.errors, []);
    assert.equal(again.removed, 0);
    assert.equal(again.reclaimedBytes, 0);
    const report = readDiskReport(cacheRoot, {ledgerFile:ledger.file}).last_sweep;
    assert.equal(report.trigger, 'timer');
    assert.equal(report.removed, 0);
    assert.equal(report.reclaimedBytes, 0);
    assert.equal(dispatchOps.length, 1, 'the reopened sweep issues no second removal');
    assert.deepEqual(w.state.sandboxes, [unrelated]);
    assert.deepEqual(w.state.templates, beforeImages);
    assert.deepEqual(treeBytes(cacheRoot), beforeCache, 'the unrelated cache paths and bytes remain');
  } finally { process.env[SETTING] = '0'; }
});

function assertSandboxIntent(ops, name, id) {
  const [entry] = Object.entries(ops);
  assert.equal(Object.keys(ops).length, 1, 'exactly one unresolved removal intent');
  const [key, intent] = entry;
  assert.equal(intent.id, key);
  assert.equal(intent.kind, 'sandbox');
  assert.equal(intent.ref, name);
  assert.equal(intent.sandboxId, id, 'the persisted intent binds the exact sandbox ID');
}

test('a successful rm that leaves its exact sandbox listed remains unresolved without redispatch', async () => {
  process.env[SETTING] = '1';
  try {
    const name = 'wf-00000000000000a1';
    const id = `id-${name}`;
    const sandbox = { name, status: 'stopped' };
    const dispatchOps = [];
    const w = world({ sandboxes: [sandbox], removeSandbox: () => {
      dispatchOps.push(readOps());
      return false; // The fake still returns exit 0, but its listing retains the same identity.
    } });
    const { sweeper, ledger } = rig(w);
    createDiskLedger({ file: ledger.file, now: () => NOW - 10 * 3600 * 1000 })
      .recordSandbox(name, { pin: CUR, id });
    const readOps = () => JSON.parse(fs.readFileSync(ledger.file, 'utf8')).ops;

    const first = await sweeper.run({ trigger: 'startup' });
    assert.equal(first.removes, true);
    assert.equal(first.eligible, 1);
    assert.equal(first.removed, 0);
    assert.deepEqual(w.state.sandboxes, [sandbox]);
    assert.deepEqual(removalCalls(w), [`rm --force ${name}`]);
    assert.equal(dispatchOps.length, 1);
    assertSandboxIntent(dispatchOps[0], name, id);
    assert.deepEqual(readOps(), dispatchOps[0], 'unproven removal keeps the original intent');

    const second = await sweeper.run({ trigger: 'timer' });
    assert.equal(second.removed, 0);
    assert.deepEqual(w.state.sandboxes, [sandbox]);
    assert.deepEqual(removalCalls(w), [`rm --force ${name}`], 'no second dispatch while still listed');
    assert.deepEqual(readOps(), dispatchOps[0], 'reconciliation leaves the same intent open');
  } finally { process.env[SETTING] = '0'; }
});

// ---- the report

function homeWith(t, sweep) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-ro-report-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  createDiskLedger({ file: path.join(home, 'v1', 'disk-ledger.json') }).recordSweep(sweep);
  return home;
}
const SWEEP = { at: Date.UTC(2026, 10, 7, 12), trigger: 'startup', durationMs: 5, scanned: { images: 3, sandboxes: 0, caches: 0, notOurs: 0 }, eligible: 2, removed: 0, removes: false,
  expectedBytes: 2_400_000_000, reclaimedBytes: null, kept: {}, logsRotated: 0, errors: [],
  categories: { images: { count: 3, listedBytes: 4_800_000_000 }, sandboxes: { count: 0 }, workspaces: null, logs: null, caches: null } };

test('the report says what a cleanup could free and says plainly that cleanup is turned off', t => {
  const text = diskLines(readDiskReport(homeWith(t, SWEEP))).join('\n');
  assert.match(text, /could free 2\.4 GB/);
  assert.match(text, /cleanup is turned off on this computer/i);
  assert.ok(text.includes('Disk cleanup is turned off on this computer: Faravan reports the disk space it could free but removes no sandboxes or caches.'));
  assert.doesNotMatch(text, /measured reclaimed 0 B|freed 0/);
  assert.doesNotMatch(text, /FARAVAN_DISK_SWEEP_REMOVES_ARTIFACTS/);
});

test('an unknown size is shown as unknown and a partial size as partial, never as zero or complete', t => {
  const unknown = diskLines(readDiskReport(homeWith(t, { ...SWEEP, expectedBytes: null }))).join('\n');
  assert.match(unknown, /could free: unknown/);
  const partial = diskLines(readDiskReport(homeWith(t, { ...SWEEP, expectedPartial: true }))).join('\n');
  assert.match(partial, /could free at least 2\.4 GB \(some sizes unknown\)/);
  const cats = diskLines(readDiskReport(homeWith(t, { ...SWEEP, categories: { ...SWEEP.categories,
    workspaces: { count: 3, bytes: 210_000_000, partial: true }, logs: { bytes: 4_000_000, partial: true }, caches: { bytes: 100_000_000, partial: true } } }))).join('\n');
  assert.match(cats, /workspaces 3 \(210\.0 MB, partial\)/);
  assert.match(cats, /logs 4\.0 MB \(partial\)/);
  assert.match(cats, /caches 100\.0 MB \(partial\)/);
});

// ---- the scheduler

test('a timer that was armed before a failure waits for the shared backoff instead of starting a sweep', async () => {
  let t = 0;
  const timers = [];
  const clock = { setTimeout: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; }, clearTimeout: h => { h.dead = true; } };
  const runs = [];
  const sweeper = { run: async ({ trigger }) => { runs.push([trigger, t]); return { errors: trigger === 'pressure' ? [{ item: 'x', message: 'boom' }] : [] }; }, abort() {} };
  const scheduler = createSweepScheduler({ sweeper, hostFree: async () => 1 * GiB, ready: Promise.resolve(), timers: clock, random: () => 0.5, now: () => t });
  scheduler.start();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(runs.map(r => r[0]), ['startup']);
  // Ten minutes on, a pressure sweep fails and sets the backoff.
  t = 10 * 60 * 1000;
  const pressure = timers.find(h => !h.dead && h.at === t);
  await pressure.fn();
  assert.deepEqual(runs.map(r => r[0]), ['startup', 'pressure']);
  // Six hours on, the timer that was armed at startup fires inside that backoff.
  t = 6 * 60 * 60 * 1000;
  const sixHour = timers.find(h => !h.dead && h.at === t);
  assert.ok(sixHour, 'the six hour timer is armed');
  await sixHour.fn();
  assert.deepEqual(runs.map(r => r[0]), ['startup', 'pressure'], 'no sweep started inside the backoff');
  await scheduler.stop();
});

// ---- a damaged record file is reported, never repaired or trusted

const VALID = () => ({ version: 3, leases: {}, sandboxes: {}, pins: { current: [], previous: [] }, lastSweep: null, owned: { images: {}, caches: {} }, ops: {} });
const LEASE = { id: 'l1', item: 'image:*', startedAt: 1, expiresAt: 2, agent: null, pin: null };
const edit = fn => { const state = VALID(); fn(state); return state; };
const without = (state, key) => { delete state[key]; return state; };
const DAMAGED = {
  'a leases list instead of a map': edit(s => { s.leases = []; }),
  'a lease whose expiry is text': edit(s => { s.leases.l1 = { ...LEASE, expiresAt: 'soon' }; }),
  'a lease with no item': edit(s => { const { item, ...rest } = LEASE; s.leases.l1 = rest; }),
  'a lease filed under another id': edit(s => { s.leases.other = LEASE; }),
  'a sandbox pin that is a number': edit(s => { s.sandboxes.a = { pin: 5, createdAt: 1 }; }),
  'a sandbox with no creation time': edit(s => { s.sandboxes.a = { pin: null }; }),
  'pins.current as text': edit(s => { s.pins.current = 'abc'; }),
  'pins with no previous list': edit(s => { delete s.pins.previous; }),
  'owned images as a list': edit(s => { s.owned.images = []; }),
  'an owned image with no reason': edit(s => { s.owned.images.x = { imageId: null, at: 1 }; }),
  'an owned cache with a text time': edit(s => { s.owned.caches['/c'] = { reason: 'created', at: 'x' }; }),
  'an operation record with no kind': edit(s => { s.ops.o = { id: 'o', ref: 'r', startedAt: 1 }; }),
  'no leases key': without(VALID(), 'leases'),
  'no owned key': without(VALID(), 'owned'),
  'no ops key': without(VALID(), 'ops'),
  'no lastSweep key': without(VALID(), 'lastSweep'),
  'a lastSweep that is text': edit(s => { s.lastSweep = 'done'; }),
  'a list at the top': [],
};

for (const [name, content] of Object.entries(DAMAGED)) test(`a version-3 file with ${name} is reported as damaged and its bytes are kept`, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-damaged-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'v1', 'disk-ledger.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = JSON.stringify(content);
  fs.writeFileSync(file, bytes);
  const ledger = createDiskLedger({ file });
  assert.equal(ledger.damaged, true);
  assert.throws(() => ledger.recordSweep({ at: 1 }), /damaged/);
  assert.throws(() => ledger.acquireLease({ item: 'image:*', ttlMs: 1 }), /damaged/);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'the file is exactly as it was found');
  const report = readDiskReport(home);
  assert.equal(report.damaged, true);
  assert.match(diskLines(report).join('\n'), /disk records damaged/);
  // A sweep, even one that is allowed to remove, removes nothing and says why.
  process.env[SETTING] = '1';
  try {
    const w = world({ templates: [row('1111111111111111', OLD, 1000)] });
    const sweeper = createDiskSweeper({ ledger, runSbx: w.runSbx, journal: { recorded: () => true }, pins: () => [CUR], referenced: () => new Set(), measureFree: async () => 5 * GiB, now: () => NOW });
    const summary = await sweeper.run({ trigger: 'startup' });
    assert.equal(summary.removed, 0);
    assert.deepEqual(w.state.argvCalls, [['template', 'ls', '--json'], ['ls', '--json']],
      'damaged ledger skips bookkeeping and only lists the plan snapshot');
    assert.deepEqual(removalCalls(w), []);
    assert.ok(summary.errors.some(error => error.item === 'ledger'), 'the damage is reported as an error');
  } finally { process.env[SETTING] = '0'; }
  assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'and still untouched');
});

test('a well-formed version-3 file, including one with a running job lease, is not damaged', t => {
  const ledger = createDiskLedger({ file: path.join(root, `ok-${counter++}.json`) });
  ledger.acquireLease({ item: 'sandbox:wf-0000000000000001', ttlMs: 1000, pin: CUR });
  ledger.acquireLease({ item: 'image:*', ttlMs: 1000 });
  ledger.recordSandbox('wf-0000000000000001', { pin: CUR });
  ledger.ownImages([{ ref: 'a:b', imageId: null }], 'created');
  ledger.ownCache('/c', 'created');
  ledger.notePins([CUR]);
  assert.equal(ledger.damaged, false);
});

test('report-only sweep preserves an acquisition made while the fake inventory is held', { timeout: 30000 }, async () => {
  const w = world({ templates: [row('1111111111111111', OLD)] });
  let holdInventory;
  const held = new Promise(resolve => { holdInventory = resolve; });
  let listingReached;
  const entered = new Promise(resolve => { listingReached = resolve; });
  const list = w.runSbx;
  w.runSbx = async args => {
    if (args[0] === 'template' && args[1] === 'ls') {
      listingReached();
      await held;
    }
    return list(args);
  };
  const { ledger, sweeper } = rig(w, { ownImages: true });
  const before = JSON.parse(fs.readFileSync(ledger.file, 'utf8'));
  assert.deepEqual(before.leases, {});

  const sweep = sweeper.run({ trigger: 'startup' });
  let summary, acquired;
  try {
    await Promise.race([
      entered,
      sweep.then(() => assert.fail('sweep returned before reaching the inventory barrier')),
    ]);
    const writer = createDiskLedger({ file: ledger.file, now: () => NOW });
    writer.acquireLease({ item: 'image:*', ttlMs: 60_000, pin: CUR });
    acquired = JSON.parse(fs.readFileSync(ledger.file, 'utf8')).leases;
    assert.equal(Object.keys(acquired).length, 1, 'the other writer acquired a lease while inventory was held');
  } finally {
    holdInventory();
    summary = await sweep;
  }

  assert.deepEqual(JSON.parse(fs.readFileSync(ledger.file, 'utf8')).leases, acquired);
  assert.equal(summary.removes, false);
  assert.equal(summary.removed, 0);
  assert.deepEqual(removalCalls(w), [], 'inventory checks did not dispatch a removal');
});

// ---- the setting: removal is off unless explicitly set to 1

test('the removal setting is off unless it is exactly 1: unset, empty and junk values all report only', async () => {
  const { removalEnabled, REMOVAL_OFF_LINE } = await import('../lib/disk-sweep-setting.mjs');
  assert.equal(removalEnabled({}), false);
  assert.equal(removalEnabled({ [SETTING]: '' }), false);
  for (const junk of ['yes', 'true', 'on', '2', 'maybe', '0', 'false']) assert.equal(removalEnabled({ [SETTING]: junk }), false, junk);
  assert.equal(removalEnabled({ [SETTING]: '1' }), true);
  assert.equal(removalEnabled({ [SETTING]: ' 1 ' }), true);
  assert.match(REMOVAL_OFF_LINE, /turned off on this computer/);
});
