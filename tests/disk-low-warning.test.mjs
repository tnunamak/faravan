import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiskLedger } from '../lib/disk-ledger.mjs';
import { readDiskReport, diskLines, diskWarningOf, withFreeReading } from '../lib/disk-report.mjs';
import { WATERMARK_START_FREE_BYTES } from '../lib/disk-sweep-plan.mjs';
import { showStatus } from '../lib/v1/status.mjs';
import { createNotificationFeed, notificationSettings, validNotificationRoute } from '../lib/v1/notifications.mjs';

// When free space on the drive that holds the sandbox store falls below the pressure mark, the app says so
// in plain words, with what uses the space by kind and what a cleanup could free. It never stays quiet.
const GiB = 1024 ** 3;
const LOW = 8 * GiB;
const BANNED = /\b(?:lease|claim|attempt|receipt|verdict|settled|coordinator|collective|harness|roster|key id|fingerprint|sealed|ledger|sweep)\b/i;

const SWEEP = {
  at: Date.UTC(2026, 10, 7, 12), trigger: 'pressure', durationMs: 5, scanned: { images: 6, sandboxes: 3, caches: 1, notOurs: 0 }, eligible: 4, removed: 0, removes: false,
  expectedBytes: 2_400_000_000, expectedPartial: false, storeFreeBytes: LOW, reclaimedBytes: null, kept: {}, logsRotated: 0, errors: [],
  categories: { images: { count: 6, listedBytes: 4_800_000_000, partial: false }, sandboxes: { count: 3 }, workspaces: null,
    logs: { bytes: 4_000_000, partial: false }, caches: { bytes: 210_000_000, partial: false } },
};
function homeWith(t, sweep) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-low-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  if (sweep) createDiskLedger({ file: path.join(home, 'v1', 'disk-ledger.json') }).recordSweep(sweep);
  return home;
}

test('a low reading produces a warning with the bytes for each kind and what a cleanup could free', t => {
  const report = readDiskReport(homeWith(t, SWEEP));
  const warning = diskWarningOf(report, LOW);
  assert.ok(warning, 'a warning');
  assert.equal(warning.free_bytes, LOW);
  assert.deepEqual(warning.by_kind.images, { count: 6, bytes: 4_800_000_000, partial: false });
  assert.deepEqual(warning.by_kind.sandboxes, { count: 3, bytes: null, partial: false }, 'sandbox size cannot be read, so it is null, not zero');
  assert.deepEqual(warning.by_kind.caches, { bytes: 210_000_000, partial: false });
  assert.deepEqual(warning.by_kind.logs, { bytes: 4_000_000, partial: false });
  assert.equal(warning.could_free_bytes, 2_400_000_000);
  const text = warning.lines.join('\n');
  assert.match(text, /Low disk space: 8\.6 GB is free on the drive that holds the sandbox images/);
  assert.match(text, /images 6 \(4\.8 GB\), sandboxes 3 \(size unknown\), caches 210\.0 MB, logs 4\.0 MB/);
  assert.match(text, /A cleanup could free 2\.4 GB\. Disk cleanup is turned off on this computer/);
  assert.doesNotMatch(text, BANNED);
});

test('an unknown figure says unknown: not zero, not left out', t => {
  const unknown = { ...SWEEP, expectedBytes: null, categories: { images: { count: 6, listedBytes: null, partial: true }, sandboxes: { count: 3 }, workspaces: null, logs: null, caches: { bytes: 50_000_000, partial: true } } };
  const text = diskWarningOf(readDiskReport(homeWith(t, unknown)), LOW).lines.join('\n');
  assert.match(text, /images 6 \(size unknown\)/);
  assert.match(text, /caches at least 50\.0 MB/);
  assert.match(text, /logs unknown/);
  assert.match(text, /A cleanup could free: unknown\./);
  assert.doesNotMatch(text, /\b0 B\b/);
  const partial = diskWarningOf(readDiskReport(homeWith(t, { ...SWEEP, expectedPartial: true })), LOW).lines.join('\n');
  assert.match(partial, /could free at least 2\.4 GB \(some sizes unknown\)/);
});

test('with no scan on record at all, a low reading still warns and says every figure is unknown', () => {
  const warning = diskWarningOf(null, LOW);
  assert.ok(warning);
  assert.match(warning.lines.join('\n'), /images unknown, sandboxes unknown, caches unknown, logs unknown/);
  assert.match(warning.lines.join('\n'), /could free: unknown/);
});

test('there is no warning at or above the pressure mark, nor when the reading is unreadable', t => {
  const report = readDiskReport(homeWith(t, SWEEP));
  assert.equal(diskWarningOf(report, WATERMARK_START_FREE_BYTES), null);
  assert.equal(diskWarningOf(report, 500 * GiB), null);
  assert.equal(diskWarningOf(report, null), null, 'free space the app cannot read is not called low');
  assert.ok(diskWarningOf(report, WATERMARK_START_FREE_BYTES - 1));
});

test('without a live reading, the reading recorded by the last scan is used', t => {
  assert.ok(diskWarningOf(readDiskReport(homeWith(t, SWEEP))), 'the recorded reading is low');
  assert.equal(diskWarningOf(readDiskReport(homeWith(t, { ...SWEEP, storeFreeBytes: 50 * GiB }))), null);
  assert.equal(diskWarningOf(readDiskReport(homeWith(t, { ...SWEEP, storeFreeBytes: null }))), null);
});

test('faravan status says it, in text and in json', async t => {
  const home = homeWith(t, SWEEP);
  const device = { keyId: 'k'.repeat(40), listCircles: async () => [] };
  const run = async (argv, storeFree) => { let out = ''; await showStatus(argv, { home, device, storeFree, fetch: async () => { throw new TypeError('no app'); }, stdout: { write: s => { out += s; } }, stderr: { write() {} } }); return out; };
  const text = await run([], async () => LOW);
  assert.match(text, /Low disk space: 8\.6 GB is free/);
  assert.match(text, /images 6 \(4\.8 GB\), sandboxes 3 \(size unknown\), caches 210\.0 MB, logs 4\.0 MB/);
  assert.match(text, /A cleanup could free 2\.4 GB/);
  const json = JSON.parse(await run(['--json'], async () => LOW));
  assert.equal(json.disk.warning.kind, 'disk_space_low');
  assert.equal(json.disk.warning.by_kind.images.bytes, 4_800_000_000);
  const fine = JSON.parse(await run(['--json'], async () => 200 * GiB));
  assert.equal(fine.disk.warning, null);
  assert.doesNotMatch(await run([], async () => 200 * GiB), /Low disk space/);
  assert.doesNotMatch(await run([], async () => null), /Low disk space/);
});

test('faravan status warns on a low drive even before any scan was recorded', async t => {
  const home = homeWith(t);
  const device = { keyId: 'k'.repeat(40), listCircles: async () => [] };
  let out = '';
  await showStatus([], { home, device, storeFree: async () => LOW, fetch: async () => { throw new TypeError('no app'); }, stdout: { write: s => { out += s; } }, stderr: { write() {} } });
  assert.match(out, /Low disk space: 8\.6 GB is free/);
  assert.match(out, /images unknown/);
});

test('faravan doctor says it too', async t => {
  const { default: cli } = await import('../bin/faravan');
  const home = homeWith(t, SWEEP);
  const backend = { probeCapabilities: async () => ({ preflight: { ok: true, backend_id: 'docker-sbx', checks: [] } }), testWorkspace: async () => ({ ok: true }) };
  const { result } = await cli.sandboxPreflight({ report: false, quick: true, home, backendFactory: () => backend, storeFree: async () => LOW });
  assert.equal(result.disk.warning.could_free_bytes, 2_400_000_000);
  const none = await cli.sandboxPreflight({ report: false, quick: true, home: homeWith(t), backendFactory: () => backend, storeFree: async () => LOW });
  assert.ok(none.result.disk.warning, 'a low drive is reported even with no records');
  const fine = await cli.sandboxPreflight({ report: false, quick: true, home: homeWith(t), backendFactory: () => backend, storeFree: async () => 200 * GiB });
  assert.equal('disk' in fine.result, false);
});

test('the same warning reaches the notification feed once a day, with a route the app opens', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-low-feed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.UTC(2026, 10, 7, 9);
  const feed = await createNotificationFeed(dir, { now: () => clock });
  const settings = notificationSettings();
  const warning = diskWarningOf(readDiskReport(homeWith(t, SWEEP)), LOW);
  const start = feed.read().cursor;
  await feed.diskWarning(warning, settings);
  await feed.diskWarning(warning, settings);
  const read = feed.read(start);
  assert.equal(read.notifications.length, 1, 'ten-minute checks do not repeat it within a day');
  const [note] = read.notifications;
  assert.equal(note.kind, 'disk_space_low');
  assert.equal(note.category, 'lending_attention');
  assert.equal(note.body, warning.text);
  assert.ok(validNotificationRoute(note.route));
  assert.doesNotMatch(`${note.title} ${note.body}`, BANNED);
  clock += 24 * 3600 * 1000;
  await feed.diskWarning(warning, settings);
  assert.equal(feed.read(start).notifications.length, 2, 'it comes again the next day if the drive is still low');
  await feed.diskWarning(null, settings);
  assert.equal(feed.read(start).notifications.length, 2);
});

test('withFreeReading adds nothing when there are no records and the drive is fine', () => {
  assert.equal(withFreeReading(null, 200 * GiB), null);
  assert.ok(withFreeReading(null, LOW).warning);
});

test('the report lines of a low drive say it first and carry the rest of the report', t => {
  const report = withFreeReading(readDiskReport(homeWith(t, SWEEP)), LOW);
  const lines = diskLines(report);
  assert.match(lines[0], /^Low disk space/);
  assert.ok(lines.some(line => /^Disk:/.test(line)));
  assert.ok(lines.some(line => /Disk cleanup is turned off on this computer/.test(line)));
});
