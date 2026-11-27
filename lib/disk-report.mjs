import fs from 'node:fs';
import path from 'node:path';
import { upgradeLedger } from './disk-ledger.mjs';
import { WATERMARK_START_FREE_BYTES } from './disk-sweep-plan.mjs';
import { REMOVAL_OFF_LINE } from './disk-sweep-setting.mjs';

// What `faravan status` and `faravan doctor` say about disk: per-category use, the last sweep
// and a low-space warning, read from the records file. A file read, not an app call, so it
// works whether or not the app is running.
//
// This release reports only. The last sweep says what a cleanup could free; it removes nothing,
// and the report says so. Every figure that cannot be known is shown as unknown, and one that is
// only partly known is shown as partial. None is ever shown as 0 or as complete by default.

// The report for one recorded sweep (ledger.lastSweep()), or none yet.
export function diskReportOf(sweep) {
  if (!sweep || typeof sweep !== 'object') return { last_sweep: null, categories: null };
  const { categories = null, ...rest } = sweep;
  return { last_sweep: rest, categories, measured_at: sweep.at ?? null, store_free_bytes: Number.isFinite(sweep.storeFreeBytes) ? sweep.storeFreeBytes : null };
}

// `ledgerFile` is the store record in the sbx HOME (lib/disk-store.mjs). An earlier release kept the
// same record in the profile directory; it is read, never changed, until the store record exists.
export function readDiskReport(home, { ledgerFile = null } = {}) {
  let text = null;
  for (const file of [ledgerFile, path.join(home, 'v1', 'disk-ledger.json')]) {
    if (!file) continue;
    try { text = fs.readFileSync(file, 'utf8'); break; }
    catch (error) {
      if (error.code !== 'ENOENT') return { damaged: true, damage: 'could not read the disk ledger' };
    }
  }
  if (text === null) return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) { return { damaged: true, damage: `not valid JSON (${error.message})` }; }
  const { state, problem } = upgradeLedger(parsed);
  // The file is left exactly as it is: the report only says that it cannot be trusted.
  return problem ? { damaged: true, damage: problem } : diskReportOf(state.lastSweep);
}

function size(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown';
  if (bytes < 0) return `-${size(-bytes)}`;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

const partialMark = entry => (entry?.partial ? ', partial' : '');

// What a cleanup could free, in words that keep unknown and partial apart from a plain figure.
// An earlier release recorded the plan figure as listedBytes.
const planned = sweep => {
  const bytes = sweep.expectedBytes ?? sweep.listedBytes;
  return Number.isFinite(bytes) ? `${sweep.expectedPartial === true ? 'at least ' : ''}${size(bytes)}` : 'unknown';
};

function couldFree(bytes, partial) {
  if (!Number.isFinite(bytes)) return 'could free: unknown';
  return partial ? `could free at least ${size(bytes)} (some sizes unknown)` : `could free ${size(bytes)}`;
}

// ---- the low-space warning

// The warning, or null. `freeBytes` is the free space on the drive that holds the sandbox images:
// a live reading when the caller has one, else the one the last sweep recorded (undefined). An
// unreadable reading (null) gives no warning here: free space the app cannot read is reported
// elsewhere, and "low" is not claimed without a reading.
export function diskWarningOf(report, freeBytes, { startFreeBytes = WATERMARK_START_FREE_BYTES } = {}) {
  const free = freeBytes === undefined ? (report?.store_free_bytes ?? null) : freeBytes;
  if (!Number.isFinite(free) || free >= startFreeBytes) return null;
  // Damaged records cannot be trusted for any per-kind figure or the cleanup estimate: those say unknown.
  // The free-space reading is live and independent of them, so the warning stays.
  const categories = report?.damaged ? null : (report?.categories ?? null);
  const sweep = report?.damaged ? null : (report?.last_sweep ?? null);
  const known = value => (Number.isFinite(value) ? value : null);
  const by_kind = {
    images: { count: categories?.images ? known(categories.images.count) : null, bytes: known(categories?.images?.listedBytes), partial: categories?.images?.partial === true },
    sandboxes: { count: categories?.sandboxes ? known(categories.sandboxes.count) : null, bytes: null, partial: false },
    caches: { bytes: known(categories?.caches?.bytes), partial: categories?.caches?.partial === true },
    logs: { bytes: known(categories?.logs?.bytes), partial: categories?.logs?.partial === true },
  };
  const could = sweep ? { bytes: known(sweep.expectedBytes), partial: sweep.expectedPartial === true } : { bytes: null, partial: false };
  const withBytes = (label, entry) => {
    if (entry.bytes === null) return `${label} unknown`;
    return `${label} ${entry.partial ? 'at least ' : ''}${size(entry.bytes)}`;
  };
  const images = by_kind.images.count === null ? 'images unknown'
    : `images ${by_kind.images.count} (${by_kind.images.bytes === null ? 'size unknown' : `${by_kind.images.partial ? 'at least ' : ''}${size(by_kind.images.bytes)}`})`;
  const sandboxes = by_kind.sandboxes.count === null ? 'sandboxes unknown' : `sandboxes ${by_kind.sandboxes.count} (size unknown)`;
  const lines = [
    freeBytes === undefined
      ? `Last disk measurement: ${size(free)} was free on the drive that holds the sandbox images.`
      : `Low disk space: ${size(free)} is free on the drive that holds the sandbox images.`,
    `  What uses space: ${[images, sandboxes, withBytes('caches', by_kind.caches), withBytes('logs', by_kind.logs)].join(', ')}.`,
    `  A cleanup ${couldFree(could.bytes, could.partial)}. ${sweep?.removes === false ? 'Disk cleanup is turned off on this computer, so free space on that drive yourself.' : 'Free space on that drive to keep lending.'}`,
  ];
  return { kind: 'disk_space_low', free_bytes: free, by_kind, could_free_bytes: could.bytes, could_free_partial: could.partial, as_of: sweep?.at ?? null, lines, text: lines.join(' ') };
}

// The report with the warning for a free-space reading added (see diskWarningOf).
export function withDiskWarning(report, freeBytes) {
  if (!report) return report;
  const free = freeBytes === undefined ? report.store_free_bytes : freeBytes;
  return { ...report, store_free_bytes: Number.isFinite(free) ? free : null, warning: diskWarningOf(report, freeBytes) };
}

// For the commands that read the records file: the report plus a live free-space reading. With no
// records at all there is no report, unless the drive is low, which is worth saying either way.
export function withFreeReading(report, freeBytes) {
  const combined = withDiskWarning(report ?? { last_sweep: null, categories: null }, freeBytes);
  return report || combined?.warning ? combined : null;
}

// For the running app, which holds the ledger object: a damaged ledger is reported as damaged.
export function liveDiskReport(ledger, freeBytes) {
  const { lastSweep, damage } = ledger.sweepSnapshot();
  const report = damage === null ? diskReportOf(lastSweep) : { damaged: true, damage };
  // Until the scheduler reports, only the last sweep holds a recorded reading.
  return withDiskWarning(report, freeBytes ?? null);
}

const KIND_WORD = { image: 'image', sandbox: 'sandbox', cache: 'cache' };
const KEPT_REASON_WORD = {
  too_new: 'it is too new to remove',
  age_unknown: 'its age is unknown',
  identity_unknown: 'its identity is unknown',
  mapping_unverified: 'the image identity reading is not confirmed yet',
  status_unknown: 'its state is unknown',
};

// The kept items the last sweep named, each with what keeps it. Doctor shows them; status shows counts.
function keptLines(sweep) {
  const items = Array.isArray(sweep.retained) ? sweep.retained : [];
  if (!items.length) return [];
  const lines = ['Kept:'];
  for (const item of items) {
    const why = item.heldBy ?? KEPT_REASON_WORD[item.reason] ?? String(item.reason).replace(/_/g, ' ');
    lines.push(`  ${KIND_WORD[item.kind] ?? item.kind} ${item.ref}: kept because ${why}`);
  }
  const total = Number.isFinite(sweep.retainedTotal) ? sweep.retainedTotal : items.length;
  if (total > items.length) lines.push(`  and ${total - items.length} more kept items`);
  return lines;
}

// Entries Faravan did not create, or cannot prove it created. They use disk, and Faravan does not remove them.
function notTouchedLines(sweep) {
  const touched = sweep.notTouched;
  if (!touched || typeof touched !== 'object') return [];
  const parts = [];
  const word = { images: 'image', sandboxes: 'sandbox', caches: 'cache', removals: 'sandbox whose removal never reported that it finished' };
  for (const [kind, row] of Object.entries(touched)) {
    // A count with `partial` is a lower bound: the listing it came from was not read in full.
    if (!(row?.count > 0) && !row?.partial) continue;
    if (kind === 'logs') continue;
    const label = row.count === 1 ? word[kind] ?? kind : `${word[kind] ?? kind}s`;
    const count = `${row.partial ? 'at least ' : ''}${row.count ?? 0}`;
    if (!(row.count > 0) && row.partial) { parts.push(`${word[kind] ?? kind}s not fully listed`); continue; }
    parts.push(`${count} ${label}${Number.isFinite(row.bytes) ? ` (${size(row.bytes)})` : ''}`);
  }
  return parts.length ? [`Unknown, not touched: ${parts.join(', ')}: used, not app-removable. Faravan did not create them, or cannot prove it did.`] : [];
}

// `listKept` adds the per-item list of kept items (doctor); the counts by reason are always there.
export function diskLines(report, { listKept = false } = {}) {
  if (!report) return [];
  const lines = [];
  if (report.warning) lines.push(...report.warning.lines);
  if (report.damaged) { lines.push(`Disk:        disk records damaged (${report.damage}); they are kept as they are, and nothing was changed.`); return lines; }
  const { categories, last_sweep: sweep } = report;
  if (categories) {
    const images = categories.images ?? {};
    const imageBytes = Number.isFinite(images.listedBytes) ? `${size(images.listedBytes)} listed${partialMark(images)}` : 'size unknown';
    const parts = [Number.isFinite(images.count) ? `images ${images.count} (${imageBytes})` : 'images unknown', Number.isFinite(categories.sandboxes?.count) ? `sandboxes ${categories.sandboxes.count}` : 'sandboxes unknown'];
    const spaces = categories.workspaces;
    if (spaces) parts.push(Number.isFinite(spaces.count) ? `workspaces ${spaces.count} (${size(spaces.bytes)}${partialMark(spaces)})` : 'workspaces unknown');
    if (categories.logs) parts.push(`logs ${size(categories.logs.bytes)}${categories.logs.partial ? ' (partial)' : ''}`);
    if (categories.caches) parts.push(`caches ${size(categories.caches.bytes)}${categories.caches.partial ? ' (partial)' : ''}`);
    lines.push('Disk:        ' + parts.join(' · '));
  }
  if (!sweep) { lines.push('Last sweep:  none yet'); return lines; }
  const kept = Object.entries(sweep.kept ?? {}).map(([reason, n]) => `${reason} ${n}`).join(', ') || 'nothing';
  const heading = `Last sweep:  ${new Date(sweep.at).toISOString()} (${sweep.trigger})`;
  const details = `kept: ${kept}; ${sweep.errors?.length ?? 0} errors`;
  const eligible = sweep.eligible ?? 'unknown';
  if (sweep.removes === false) {
    const found = Number.isFinite(sweep.eligible)
      ? `found ${sweep.listingsComplete === false ? 'at least ' : ''}${eligible} items a cleanup would remove`
      : 'could not count items a cleanup would remove';
    lines.push(`${heading} ${found}; ${couldFree(sweep.expectedBytes, sweep.expectedPartial)}; ${details}`);
    lines.push(`Cleanup:     ${REMOVAL_OFF_LINE}`);
  } else if (sweep.removes === true || Number.isFinite(sweep.removed) || Number.isFinite(sweep.reclaimedBytes)) {
    const removal = Number.isFinite(sweep.removed) ? `removed ${sweep.removed} of ${eligible} eligible` : 'removal count unknown';
    const change = Number.isFinite(sweep.reclaimedBytes) ? size(sweep.reclaimedBytes) : 'unknown (not measured)';
    lines.push(`${heading} ${removal}; the plan expected ${planned(sweep)}, net free-space change on the sandbox drive ${change}; ${details}`);
  } else {
    lines.push(`${heading} removal was not recorded; ${details}`);
  }
  lines.push(...kitImageLines(sweep.kitImages));
  lines.push(...notTouchedLines(sweep));
  if (listKept) lines.push(...keptLines(sweep));
  for (const error of sweep.errors ?? []) lines.push(`  Error: ${error.item}: ${error.message}`);
  return lines;
}



// A separate estimate. Image removal remains disabled in the sweep.
export function kitImageLines(report) {
  if (!report || !Array.isArray(report.images)) return [];
  const why = {
    origin_unknown: 'the kit this image came from is unknown',
    not_owned: 'Faravan cannot prove it created this image',
    inventory_incomplete: 'the full list could not be read',
    create_in_flight: 'a sandbox is being created',
    work_unconfirmed: 'earlier work has not been confirmed finished',
    mapping_unknown: 'the current and previous kit images are not fully known',
    current_kit: 'it is a current kit image',
    previous_kit: 'it is a previous kit image, kept for rollback',
    sandbox_present: 'a sandbox or retained job may use it',
    work_in_progress: 'work is still in progress',
  };
  const lines = ['Kit provenance inventory (separate from the storage cap).',
    report.mappingKnown ? '  Current and previous kit images are recorded.' : '  Current and previous kit images are not fully known. Nothing is eligible.',
    `  Listed size of eligible images: ${size(report.listedBytes)}. Shared data means actual freed space may be smaller.`];
  for (const row of report.images)
    lines.push(`  ${row.ref}, image ${row.imageId ?? 'unknown'}, ${size(row.bytes)}: ${row.eligible ? 'eligible by provenance' : 'kept because ' + (why[row.reason] ?? 'its use is unknown')}.`);
  return lines;
}
