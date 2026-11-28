import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiskLedger } from '../lib/disk-ledger.mjs';
import { readDiskReport, diskLines } from '../lib/disk-report.mjs';
import { showStatus } from '../lib/v1/status.mjs';

// Status and doctor read the record of the sbx HOME; a temporary one keeps these tests off the real store.
process.env.FARAVAN_SBX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-report-sbx-home-'));

const SWEEP = {
  at: Date.UTC(2026, 10, 7, 12, 0, 0), trigger: 'startup', durationMs: 40,
  scanned: { images: 3, sandboxes: 1, caches: 1, notOurs: 2 }, eligible: 2, removed: 1, expectedBytes: 2_400_000_000, reclaimedBytes: 1_200_000_000,
  kept: { current_pin: 1, previous_pin: 1 }, logsRotated: 0,
  categories: { images: { count: 2, listedBytes: 4_800_000_000 }, sandboxes: { count: 1 }, workspaces: { count: 3, bytes: 210_000_000 }, logs: { bytes: 4_000_000 }, caches: { bytes: 100_000_000 } },
  errors: [{ item: 'docker.io/library/sandbox-kit-assembled:aaaa', message: 'image in use' }],
};
function homeWith(t, sweep) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-report-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  if (sweep) createDiskLedger({ file: path.join(home, 'v1', 'disk-ledger.json') }).recordSweep(sweep);
  return home;
}

test('the report has per-category use and the last sweep with its errors', t => {
  const report = readDiskReport(homeWith(t, SWEEP));
  assert.deepEqual(Object.keys(report.categories), ['images', 'sandboxes', 'workspaces', 'logs', 'caches']);
  assert.equal(report.last_sweep.removed, 1);
  const text = diskLines(report).join('\n');
  assert.match(text, /images 2 \(4\.8 GB listed\) · sandboxes 1 · workspaces 3 \(210\.0 MB\) · logs 4\.0 MB · caches 100\.0 MB/);
  assert.match(text, /Last sweep:  2026-11-07T12:00:00\.000Z \(startup\) removed 1 of 2 eligible; the plan expected 2\.4 GB, net free-space change on the sandbox drive 1\.2 GB; kept: current_pin 1, previous_pin 1; 1 errors/);
  assert.match(text, /Error: docker\.io\/library\/sandbox-kit-assembled:aaaa: image in use/);
});

test('an unmeasured reclaim is said to be unmeasured, not zero', t => {
  const report = readDiskReport(homeWith(t, { ...SWEEP, reclaimedBytes: null }));
  assert.match(diskLines(report).join('\n'), /the plan expected 2\.4 GB, net free-space change on the sandbox drive unknown \(not measured\)/);
});

test('the plan figure and the measured figure are shown apart: a sweep that freed nothing says 0 B next to what it expected', t => {
  const text = diskLines(readDiskReport(homeWith(t, { ...SWEEP, expectedBytes: 99_000_000_000, reclaimedBytes: 0 }))).join('\n');
  assert.match(text, /the plan expected 99\.0 GB, net free-space change on the sandbox drive 0 B/);
});

test('a ledger written before the rename still shows its old planned figure as the plan figure', t => {
  const { expectedBytes, ...old } = SWEEP;
  const text = diskLines(readDiskReport(homeWith(t, { ...old, listedBytes: 2_400_000_000 }))).join('\n');
  assert.match(text, /the plan expected 2\.4 GB/);
});

test('before any sweep the report says so; with no ledger at all there is nothing to show', t => {
  const home = homeWith(t);
  assert.equal(readDiskReport(home), null);
  const empty = homeWith(t);
  createDiskLedger({ file: path.join(empty, 'v1', 'disk-ledger.json') }).acquireLease({ item: 'image:*', ttlMs: 1 });
  assert.deepEqual(diskLines(readDiskReport(empty)), ['Last sweep:  none yet']);
  assert.deepEqual(diskLines(null), []);
});

test('faravan status carries the disk report, in text and in json', async t => {
  const home = homeWith(t, SWEEP);
  const device = { keyId: 'k'.repeat(40), listCircles: async () => [] };
  const run = async argv => { let out = ''; await showStatus(argv, { home, device, storeFree: async () => null, fetch: async () => { throw new TypeError('no app'); }, stdout: { write: s => { out += s; } }, stderr: { write() {} } }); return out; };
  assert.match(await run([]), /Disk:\s+images 2/);
  const json = JSON.parse(await run(['--json']));
  assert.equal(json.disk.last_sweep.removed, 1);
  assert.equal(json.disk.categories.workspaces.count, 3);
});

test('faravan doctor carries the disk report, in its result and in its lines', async t => {
  const { default: cli } = await import('../bin/faravan');
  const home = homeWith(t, SWEEP);
  const backend = { probeCapabilities: async () => ({ preflight: { ok: true, backend_id: 'docker-sbx', checks: [] } }), testWorkspace: async () => ({ ok: true }) };
  const { result } = await cli.sandboxPreflight({ report: false, quick: true, home, backendFactory: () => backend, storeFree: async () => null });
  assert.equal(result.disk.last_sweep.removed, 1);
  assert.deepEqual(Object.keys(result.disk.categories), ['images', 'sandboxes', 'workspaces', 'logs', 'caches']);
  const none = await cli.sandboxPreflight({ report: false, quick: true, home: homeWith(t), backendFactory: () => backend, storeFree: async () => null });
  assert.equal('disk' in none.result, false, 'no ledger, no field');
});

test('the report reads the record in the sbx HOME first, and the profile directory record only until it exists', t => {
  const home = homeWith(t, { ...SWEEP, trigger: 'profile' });
  const sbx = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-report-sbx-'));
  t.after(() => fs.rmSync(sbx, { recursive: true, force: true }));
  const ledgerFile = path.join(sbx, 'disk-ledger.json');
  assert.equal(readDiskReport(home, { ledgerFile }).last_sweep.trigger, 'profile', 'no store record yet: the earlier record is read');
  createDiskLedger({ file: ledgerFile }).recordSweep({ ...SWEEP, trigger: 'store' });
  assert.equal(readDiskReport(home, { ledgerFile }).last_sweep.trigger, 'store');
});

test('an earlier version-2 record is read as it is, never reported as damaged', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-report-v2-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'v1'), { recursive: true });
  fs.writeFileSync(path.join(home, 'v1', 'disk-ledger.json'), JSON.stringify({ version: 2, leases: {}, sandboxes: {}, pins: { current: [], previous: [] }, lastSweep: SWEEP, owned: { images: {}, caches: {} }, adopted: { images: null, caches: null } }));
  const report = readDiskReport(home);
  assert.equal(report.damaged, undefined);
  assert.equal(report.last_sweep.removed, 1);
});

import * as kitPlan from '../lib/disk-sweep-plan.mjs';
import { ownCreatedImages } from '../lib/disk-ownership.mjs';
import * as kitReport from '../lib/disk-report.mjs';
import { createDiskSweeper } from '../lib/disk-sweep.mjs';

const kitDigest = c => c.repeat(64);
// Image identities are full 64-hex IDs (387e4c3c0): a listing with a prefix ID is incomplete. Each image has a creation
// time, because the cap ranks obsolete images by age (6e3cf7f83, 5d4df6d2a).
const KIT_NOW = 1_800_000_000_000, KIT_DAY = 86_400_000;
const kitImage = (tag, c, daysAgo = 20) => ({ kind: 'image', id: 'image:' + tag,
  ref: 'docker.io/library/sandbox-kit-assembled:' + tag, imageId: c.repeat(64), createdAt: KIT_NOW - daysAgo * KIT_DAY, bytes: 100 });
// Of the owned obsolete images, the two newest are retained, so \"old\" is the only eligible one only when two newer ones exist.
function kitFixture() {
  const images = [kitImage('current', 'a', 8), kitImage('previous', 'b', 7), kitImage('old', 'c', 30), kitImage('foreign', 'd', 25),
    kitImage('retained-older', '1', 2), kitImage('retained-newest', '2', 1)];
  const generation = (digest, image) => ({ digests: [digest], images: [{ ...image, inputDigest: digest, at: 10 }] });
  return { images, owned: Object.fromEntries(images.filter(image => image.ref.split(':').pop() !== 'foreign')
      .map(image => [image.ref, { imageId: image.imageId, kitInputDigest: image.imageId[0].repeat(64) }])),
    generations: { current: generation(kitDigest('a'), images[0]), previous: generation(kitDigest('b'), images[1]) },
    complete: true, now: KIT_NOW, sandboxes: new Map() };
}
test('kit report: exact owned obsolete image only, current and previous protected', () => {
  const f = kitFixture(), result = kitPlan.kitImageReport(f);
  assert.deepEqual(result.images.map(row => row.reason), ['current_kit', 'previous_kit', 'eligible', 'not_owned', 'retained_recent', 'retained_recent']);
  assert.equal(result.listedBytes, 100);
  assert.equal(result.images[2].imageId, 'c'.repeat(64));
});
test('kit report: a second ref to a kept image ID is kept, and its size is never counted as reclaimable', () => {
  for (const kept of ['current', 'previous']) {
    const f = kitFixture(), source = kept === 'current' ? f.images[0] : f.images[1];
    const alias = { ...kitImage('alias-' + kept, 'e'), imageId: source.imageId, createdAt: source.createdAt };
    f.images.push(alias);
    f.owned[alias.ref] = { imageId: alias.imageId, kitInputDigest: alias.imageId[0].repeat(64) };
    const result = kitPlan.kitImageReport(f);
    assert.equal(result.images.at(-1).reason, kept + '_kit', 'the alias is kept for the same reason as its image');
    assert.equal(result.eligible, 1, 'only the old image is eligible');
    assert.equal(result.listedBytes, 100, 'the alias adds nothing to the estimate');
  }
});
test('kit report: either missing generation fails closed', () => {
  for (const key of ['current', 'previous']) {
    const f = kitFixture(); f.generations[key] = null;
    const result = kitPlan.kitImageReport(f);
    assert.equal(result.eligible, 0); assert.equal(result.mappingKnown, false);
  }
});
test('kit report: every configured digest needs an assembly and local kits stay unknown', () => {
  const f = kitFixture(); f.generations.current.digests.push(kitDigest('f'));
  assert.equal(kitPlan.kitImageReport(f).eligible, 0);
  f.generations.current.digests.pop(); f.generations.current.unknown = true;
  assert.equal(kitPlan.kitImageReport(f).eligible, 0);
});
test('kit report: incomplete inventory, create, sandbox and unresolved work each keep images', () => {
  const checks = [
    [{ complete: false }, 'inventory_incomplete'],
    [{ leases: [{ item: 'image:*', expiresAt: KIT_NOW + 100 }] }, 'create_in_flight'],
    [{ sandboxes: new Map([['sandbox', { pin: kitDigest('c') }]]) }, 'sandbox_present'],
    [{ unresolved: true }, 'work_unconfirmed'],
    [{ leases: [{ item: 'sandbox:job', expiresAt: KIT_NOW + 100 }] }, 'work_in_progress'],
  ];
  for (const [change, reason] of checks) {
    const result = kitPlan.kitImageReport({ ...kitFixture(), ...change });
    assert.equal(result.eligible, 0); assert.equal(result.images[2].reason, reason);
  }
});
test('kit report: changed tag identity and foreign repository lookalike are not owned', () => {
  const f = kitFixture(); f.images[2].imageId = 'e'.repeat(64);
  f.images.push({ ...kitImage('old', 'c'), ref: 'other.example/sandbox-kit-assembled:old' });
  const result = kitPlan.kitImageReport(f);
  assert.equal(result.eligible, 0);
  assert.equal(result.images[2].reason, 'not_owned'); assert.equal(result.images[6].reason, 'not_owned');
});
test('kit report: duplicate references count one image and unknown size stays unknown', () => {
  const f = kitFixture(); const alias = { ...f.images[2], ref: f.images[2].ref + '-alias' };
  f.images.push(alias); f.owned[alias.ref] = { imageId: alias.imageId, kitInputDigest: kitDigest('c') };
  assert.equal(kitPlan.kitImageReport(f).listedBytes, 100);
  alias.bytes = null; assert.equal(kitPlan.kitImageReport(f).listedBytes, null);
});
test('kit report: plain report names exact identities and says no removal', () => {
  const result = kitPlan.kitImageReport(kitFixture());
  const lines = kitReport.kitImageLines(result).join('\n');
  assert.match(lines, /Kit provenance inventory/); assert.match(lines, /current kit image/);
  assert.match(lines, /previous kit image/); assert.match(lines, /cannot prove it created/);
  assert.match(lines, /cccccccccccc/); assert.doesNotMatch(lines, /—|mapping_unknown/);
});
function kitLedger(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-generation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createDiskLedger({ file: path.join(dir, 'ledger.json'), now: () => 123 });
}
test('kit records: assembly writes exact identity, input digest and time and rotates together', t => {
  const ledger = kitLedger(t), image = kitImage('one', 'a');
  ledger.notePins([kitDigest('a')]);
  ownCreatedImages({ ledger, before: [], images: [image], generation: { digests: [kitDigest('a')], inputDigest: kitDigest('a') } });
  assert.deepEqual(ledger.kitGenerations().current.images, [{ ref: image.ref, imageId: image.imageId, inputDigest: kitDigest('a'), at: 123 }]);
  ledger.notePins([kitDigest('b')]);
  assert.equal(ledger.kitGenerations().previous.images[0].imageId, image.imageId);
  assert.deepEqual(ledger.kitGenerations().current.images, []);
  ledger.notePins([kitDigest('b')]);
  assert.equal(ledger.kitGenerations().previous.images.length, 1);
});
test('kit records: old ledger loads as unknown and initializes without inventing history', t => {
  const ledger = kitLedger(t);
  ledger.notePins([kitDigest('a')]);
  const state = JSON.parse(fs.readFileSync(ledger.file)); delete state.kitGenerations;
  fs.writeFileSync(ledger.file, JSON.stringify(state));
  assert.equal(ledger.damaged, false); assert.equal(ledger.kitGenerations(), null);
  ledger.notePins([kitDigest('a')]);
  assert.equal(ledger.kitGenerations().previous, null);
  assert.deepEqual(ledger.kitGenerations().current.images, []);
});
test('kit records: no ownership adoption on reuse or a changed tag and malformed record rejected', t => {
  const ledger = kitLedger(t), image = kitImage('one', 'a');
  ledger.notePins([kitDigest('a')]);
  ownCreatedImages({ ledger, before: [image.ref + '|' + image.imageId], images: [image], generation: { digests: [kitDigest('a')], inputDigest: kitDigest('a') } });
  assert.deepEqual(ledger.kitGenerations().current.images, []);
  const state = JSON.parse(fs.readFileSync(ledger.file));
  state.kitGenerations.current.images = [{ ref: image.ref, imageId: image.imageId, inputDigest: 'bad', at: 1 }];
  fs.writeFileSync(ledger.file, JSON.stringify(state)); assert.equal(ledger.damaged, true);
});
test('kit records: local assembly does not claim a registry mapping', t => {
  const ledger = kitLedger(t), image = kitImage('local', 'f');
  ledger.notePins([kitDigest('a')]);
  ownCreatedImages({ ledger, before: [], images: [image], generation: { digests: [kitDigest('a')], inputDigest: null } });
  assert.equal(ledger.kitGenerations().current.unknown, true);
});
test('kit report integration: sweep records report but still issues no image deletion', async t => {
  const ledger = kitLedger(t), f = kitFixture(), calls = [];
  // These are obsolete images (the old one and the two newest that are retained), recorded before these two generations.
  ledger.ownImages([f.images[2], f.images[4], f.images[5]], 'created', { digests: [kitDigest('c')], inputDigest: kitDigest('c') });
  for (const [digest, image] of [[kitDigest('b'), f.images[1]], [kitDigest('a'), f.images[0]]]) {
    ledger.notePins([digest]);
    ownCreatedImages({ ledger, before: [], images: [image], generation: { digests: [digest], inputDigest: digest } });
  }
  const sweeper = createDiskSweeper({ ledger,
    coordinator: { dir: ledger.dir, sweep: fn => fn(), exclusive: fn => fn({ held: () => true }) },
    runSbx: async args => { calls.push(args); return { code: 0, stdout: JSON.stringify(args[0] === 'template' ? f.images.map(image => ({
      repository: image.ref.slice(0, image.ref.lastIndexOf(':')), tag: image.ref.split(':').pop(), id: image.imageId, size: image.bytes, created_at: new Date(image.createdAt).toISOString(),
    })) : []) }; },
    journal: { recorded: () => false }, pins: () => [kitDigest('a')], referenced: () => new Set(),
    measureFree: async () => 1e12, now: () => 1800000000000, removeEligible: true, lockCheck: () => ({ ok: true }),
  });
  const summary = await sweeper.run({ trigger: 'test' });
  assert.equal(summary.kitImages.eligible, 1);
  assert.equal(ledger.lastSweep().kitImages.eligible, 1);
  // The sweep plan holds back every owned obsolete image (three here); the report marks only the oldest as outside retention.
  assert.equal(summary.removed, 0); assert.equal(summary.kept.image_cleanup_unavailable, 3);
  assert.ok(calls.every(args => args[0] === 'ls' || args[0] === 'template' && args[1] === 'ls'));
  assert.match(kitReport.diskLines(kitReport.diskReportOf(summary)).join('\n'), /Kit provenance inventory/);
});

// Use the real settlement method without constructing a backend or dispatching
// commands. The only command here is a fake, read-only image listing.
import { DockerSbxBackend as KitBackend } from '../lib/docker-backend.mjs';
// The two newest obsolete images the cap always retains. Without them a single obsolete image is retained too,
// and no settlement test could tell an image kept for its provenance from one kept for its age.
const r3Retained = () => [kitImage('retained-older', '1', 2), kitImage('retained-newest', '2', 1)];
const ownRetained = ledger => ledger.ownImages(r3Retained(), 'created', { digests: [kitDigest('c')], inputDigest: kitDigest('c') });
function r3Seed(t) {
  const ledger = kitLedger(t), current = kitImage('current', 'a', 8), previous = kitImage('previous', 'b', 7);
  ownRetained(ledger);
  for (const [inputDigest, image] of [[kitDigest('b'), previous], [kitDigest('a'), current]]) {
    ledger.notePins([inputDigest]);
    ownCreatedImages({ ledger, before: [], images: [image], generation: { digests: [inputDigest], inputDigest } });
  }
  return { ledger, current, previous };
}
function r3Backend(ledger, images, agents = { claude: 'sha256:' + kitDigest('a') }) {
  const backend = Object.create(KitBackend.prototype);
  Object.defineProperty(backend, 'diskLedger', { value: ledger });
  backend._imagePins = { agents };
  backend._diskRunSbx = async () => ({ code: 0, stdout: JSON.stringify(images.map(image => ({
    repository: image.ref.slice(0, image.ref.lastIndexOf(':')), tag: image.ref.split(':').pop(),
    id: image.imageId, size: image.bytes, created_at: '2020-01-01T00:00:00Z',
  }))) });
  return backend;
}
function r3Report(ledger, images) {
  return kitPlan.kitImageReport({ images: [...images, ...r3Retained()], owned: ledger.ownedImages(), generations: ledger.kitGenerations(),
    complete: true, sandboxes: new Map(), now: KIT_NOW });
}
for (const phase of ['before', 'after']) for (const failureAt of [1, 2, 3]) test(
  `kit settlement: crash ${phase} write ${failureAt} cannot expose a newly owned current image`, async t => {
    const { ledger, current, previous } = r3Seed(t), fresh = kitImage('new-current', 'd', 30);
    let writes = 0, released = false;
    const wrapped = Object.create(ledger);
    for (const name of ['ownImages', 'notePins', 'recordKitImages']) wrapped[name] = (...args) => {
      const fail = ++writes === failureAt;
      if (fail && phase === 'before') throw new Error('injected before commit');
      const result = ledger[name](...args);
      if (fail && phase === 'after') throw new Error('injected after commit');
      return result;
    };
    const backend = r3Backend(wrapped, [current, previous, fresh]);
    await backend._settleDiskCreate({ before: [current, previous].map(image => image.ref + '|' + image.imageId),
      run: { pin: kitDigest('a') }, gate: { release() { released = true; } } }, { created: true });
    assert.equal(released, true);
    const report = r3Report(createDiskLedger({ file: ledger.file, now: () => 123 }), [current, previous, fresh]);
    assert.equal(report.eligible, 0);
    assert.equal(report.images[2].eligible, false);
    assert.equal(writes, 1, 'settlement has one combined durable mutation, not independent ownership/pin/history writes');
    if (ledger.ownedImages()[fresh.ref]) assert.ok(ledger.kitGenerations().current.images.some(row => row.ref === fresh.ref && row.imageId === fresh.imageId));
  });
test('kit settlement: invalid or missing generation inputs invalidate history in the ownership write', async t => {
  for (const agents of [null, [], { claude: 'bad' }]) {
    const { ledger, current, previous } = r3Seed(t), fresh = kitImage('unknown-input', 'd', 30);
    await r3Backend(ledger, [current, previous, fresh], agents)._settleDiskCreate({
      before: [current, previous].map(image => image.ref + '|' + image.imageId), run: { pin: kitDigest('a') }, gate: { release() {} },
    }, { created: true });
    assert.ok(ledger.ownedImages()[fresh.ref]);
    assert.equal(r3Report(ledger, [current, previous, fresh]).mappingKnown, false);
    assert.equal(r3Report(ledger, [current, previous, fresh]).eligible, 0);
  }
});
test('kit rollback: old-style pin rotation keeps ownership leases and sandbox roots readable', t => {
  const { ledger, current, previous } = r3Seed(t);
  const lease = ledger.acquireLease({ item: 'sandbox:job', pin: kitDigest('a'), ttlMs: 10000 });
  ledger.recordSandbox('job', { pin: kitDigest('a'), id: 'sbx-job' });
  const state = JSON.parse(fs.readFileSync(ledger.file));
  state.pins = { current: [kitDigest('b')], previous: [kitDigest('a')] };
  fs.writeFileSync(ledger.file, JSON.stringify(state));
  const again = createDiskLedger({ file: ledger.file, now: () => 123 });
  assert.equal(again.damaged, false);
  assert.deepEqual(again.ownedImages(), state.owned.images);
  assert.equal(again.activeLeases()[0].id, lease);
  assert.equal(again.sandbox('job').id, 'sbx-job');
  assert.deepEqual(again.kitGenerations(), { current: null, previous: null });
  assert.equal(r3Report(again, [current, previous]).eligible, 0);
  const fresh = kitImage('rebuilt', 'e', 30);
  ownCreatedImages({ ledger: again, before: [], images: [fresh],
    generation: { digests: [kitDigest('b')], inputDigest: kitDigest('b') } });
  assert.equal(again.damaged, false);
  assert.equal(again.kitGenerations().current.images[0].ref, fresh.ref);
  assert.equal(again.kitGenerations().previous, null);
});
test('kit settlement: legacy ledger still accepts the original ownership call', async () => {
  let args, released = false;
  const image = kitImage('legacy', 'e');
  const ledger = { ownImages(...value) { args = value; } };
  await r3Backend(ledger, [image])._settleDiskCreate({ before: [], run: { pin: kitDigest('a') },
    gate: { release() { released = true; } } }, { created: true });
  assert.equal(args.length, 2);
  assert.deepEqual(args[0], [{ ref: image.ref, imageId: image.imageId }]);
  assert.equal(released, true);
});

// These are the pre-generation writer's notePins/ownImages bodies, with a
// synchronous file adapter in place of its existing locked update wrapper.
function oldKitWriter(file) {
  const read = () => JSON.parse(fs.readFileSync(file));
  const update = fn => { const state = read(); fn(state); fs.writeFileSync(file, JSON.stringify(state)); };
  return {
    notePins(digests) {
      const next = [...new Set(digests)].sort();
      if (next.length === 0) return;
      update(state => {
        if (JSON.stringify(next) === JSON.stringify([...state.pins.current].sort())) return;
        state.pins = { current: next, previous: state.pins.current };
      });
    },
    ownImages(entries, reason) {
      if (entries.length === 0) return;
      const at = 456;
      update(state => { for (const { ref, imageId = null } of entries) state.owned.images[ref] ??= { imageId, reason, at }; });
    },
  };
}
test('kit provenance: unchanged-pin old writer adds an unknown-origin image, never an eligible one', t => {
  const { ledger, current, previous } = r3Seed(t), fresh = kitImage('old-writer-new', 'f', 30);
  const old = oldKitWriter(ledger.file);
  old.notePins([kitDigest('a')]);
  old.ownImages([fresh], 'created');
  const again = createDiskLedger({ file: ledger.file, now: () => 123 });
  assert.equal(again.damaged, false);
  const result = r3Report(again, [current, previous, fresh]);
  assert.equal(result.mappingKnown, true, 'unchanged pins alone cannot prove the new image attribution');
  assert.equal(result.images[2].reason, 'origin_unknown');
  assert.equal(result.images[2].eligible, false);
  assert.equal(result.eligible, 0);
  assert.match(kitReport.kitImageLines(result).join('\n'), /kit this image came from is unknown/);
  assert.equal(again.ownedImages()[current.ref].kitInputDigest, kitDigest('a'), 'old writer preserves unknown fields');
});
test('kit provenance: new attributed images retain current previous and obsolete classifications', t => {
  const ledger = kitLedger(t);
  ownRetained(ledger);
  const images = [kitImage('old', 'c', 30), kitImage('previous', 'b', 7), kitImage('current', 'a', 8)];
  for (const image of images) {
    const inputDigest = kitDigest(image.imageId[0]);
    ownCreatedImages({ ledger, before: [], images: [image], generation: { digests: [inputDigest], inputDigest } });
  }
  const again = createDiskLedger({ file: ledger.file, now: () => 123 });
  for (const image of images) assert.equal(again.ownedImages()[image.ref].kitInputDigest, kitDigest(image.imageId[0]));
  assert.deepEqual(r3Report(again, images).images.map(row => row.reason), ['eligible', 'previous_kit', 'current_kit', 'retained_recent', 'retained_recent']);
});
test('kit provenance: existing old ownership is not retroactively stamped', t => {
  const { ledger, current, previous } = r3Seed(t), image = kitImage('legacy', 'd', 30);
  oldKitWriter(ledger.file).ownImages([image], 'created');
  ledger.ownImages([image], 'created', { digests: [kitDigest('a')], inputDigest: kitDigest('a') });
  assert.equal(ledger.ownedImages()[image.ref].kitInputDigest, undefined);
  assert.equal(r3Report(ledger, [current, previous, image]).images[2].reason, 'origin_unknown');
});
test('kit provenance: missing or malformed provenance stays loadable and ineligible', t => {
  for (const value of [undefined, null, '', 1, 'bad']) {
    const { ledger, current, previous } = r3Seed(t);
    const state = JSON.parse(fs.readFileSync(ledger.file));
    state.owned.images[current.ref].kitInputDigest = value;
    fs.writeFileSync(ledger.file, JSON.stringify(state));
    assert.equal(ledger.damaged, false);
    assert.equal(r3Report(ledger, [current, previous]).images[0].reason, 'origin_unknown');
  }
});

for (const live of [false, true]) test(live
  ? 'store cap keeps an image while a live sandbox can reference it'
  : 'store cap removes old unreferenced images until runtime usage fits', async t => {
  const ledger = kitLedger(t), f = kitFixture(), removed = [];
  const now = 1_800_000_000_000;
  const [current, previous, oldest] = f.images;
  const obsolete = [oldest, kitImage('newer-old', 'd'), kitImage('retained-old', 'e'),
    kitImage('retained-new', 'f')];
  const rows = [...obsolete, current, previous].map((image, i) => ({
    repository: image.ref.slice(0, image.ref.lastIndexOf(':')), tag: image.ref.split(':').pop(),
    id: image.imageId[0].repeat(64), size: 100, created_at: new Date(now - (20 - i) * 86400000).toISOString(),
  }));
  for (const image of [...obsolete, previous, current]) {
    const inputDigest = kitDigest(image.imageId[0]);
    ledger.notePins([inputDigest]);
    ownCreatedImages({ledger,before:[],images:[{...image,imageId:image.imageId[0].repeat(64)}],
      generation:{digests:[inputDigest],inputDigest}});
  }
  let usage = 600;
  const sweeper = createDiskSweeper({ledger,
    coordinator:{dir:ledger.dir,sweep:fn=>fn(),exclusive:fn=>fn({held:()=>true})},
    journal:{recorded:()=>false}, pins:()=>[kitDigest('a')], referenced:()=>new Set(),
    measureFree:async()=>10_000, now:()=>now, removeEligible:false,
    retentionLimitBytes:400, lockCheck:()=>({ok:true}),
    runSbx:async args=>{
      const reply = value => ({code:0,stdout:JSON.stringify(value)});
      if (args[0]==='df') return reply({summaries:[{type:'Images',size:usage}]});
      if (args[0]==='ls') return reply(live ? [{name:'active',id:'active-id',status:'running'}] : []);
      if (args[1]==='ls') return reply(rows);
      assert.deepEqual(args.slice(0,3),['template','rm','--force']);
      const id=args[3].replace(/^sha256:/,'');
      const index=rows.findIndex(row=>row.id===id);
      assert.ok(index>=0);
      removed.push(rows[index].tag);
      rows.splice(index,1);
      usage-=100;
      return reply({});
    },
  });
  await sweeper.run({trigger:'test'});
  assert.deepEqual(removed,live ? [] : [oldest.ref.split(':').pop(), 'newer-old']);
  assert.equal(usage,live ? 600 : 400);
});
