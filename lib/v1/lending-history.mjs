/**
 * Local lending history for the M1 objective allocator.
 *
 *   createLendingHistory({ home, account, ledger, now })
 *   history.record(reading)                -> { recorded, known, reason }
 *   history.weeklyScores(resource)        -> Map<provider reset epoch, score row>
 *   history.usageSamples(resource)        -> imported timestamped session usage samples
 *   history.resources()                   -> resource ids stored for this account
 *   history.completeWeekCount(resource)   -> number of complete uncensored weeks
 *   history.bootstrapFromSessionLogs(adapter) -> explicit opt-in import
 *
 * `completeWeekCount` counts only finite complete rows in the latest at most 26 completed weeks;
 * the caller supplies the display target N from its configured rank policy.
 * `known` means the sample can support an owner-usage label. A refusal, deferral, limit hit,
 * or missing censor evidence makes the sample unknown for calibration.
 *
 * `reading` is a lending-meter Reading plus `account_week_epoch` when the meter is not
 * weekly and `censoring: { complete, limit_reached, owner_refused, owner_deferred }`.
 * `complete` attests that the refusal/deferral facts for this interval were observed;
 * missing or incomplete evidence censors the account-week. Repeat any true fact on any
 * sample in the week. A true fact on any resource censors every resource label that week.
 *
 * Each score row is { epoch, start, end, resource, score, ownerUsagePct, complete,
 * reason, sampleCount, coveredDays, source }. `score` is the largest observed
 * upper bound on owner-only `used_pct` at the recorded sample times in that account-week;
 * it is not extrapolated to the reset. It is Infinity when the closed week is incomplete
 * or censored. We subtract only borrower burn proven by the ledger;
 * estimated or ambiguous charges contribute their lower bound (zero unless the ledger
 * explicitly supplies `lent_lower_pts`) and the ledger's `represented_at` proves inclusion
 * in the aggregate reading. A meter week is complete only when it has known
 * readings in all seven 24-hour bins and a reading within six hours of the reset. A finite
 * score therefore summarizes observed usage, not unobserved burn in the allowed tail. Shorter
 * resource windows also need a reading near every resource reset. Unknown or censored labels
 * stay in history as Infinity; the active week is omitted. Missing expected reset epochs
 * are emitted as incomplete Infinity rows, never as measured usage.
 * For non-weekly meter resources, pass `account_week_epoch` to align the reading with the
 * provider's weekly reset. Without it, readings are aligned by their timestamp to recorded
 * weekly windows. This is an observed usage label, not a conformal residual: the consuming
 * lane applies its frozen prediction and scale, then takes one maximum over the full
 * time/resource domain as `wholeWeekReserveBand` requires. This module does not compute
 * the conformal rank or claim its guarantee. No data leaves this machine.
 *
 * Session-log bootstrap is scheduled by the owner's local-learning setting. Its adapter may return the legacy
 * normalized labels or coverage-checked import rows. This module does not locate or read logs.
 * The ledger must provide entries() with lower-bound and represented-at provenance.
 */
import fs from 'node:fs';
import path from 'node:path';
import { join } from 'node:path';
import { configHome, saveJsonFile } from '../local-state.mjs';
import { acquireProcessLockSync } from './lock.mjs';
import { readJsonState, StateUnknownError } from './state-read.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const WEEK_MINUTES = 7 * 24 * 60;
const MAX_WEEK_TAIL_MS = 6 * HOUR_MS;
const RETAIN_WEEKS = 26;
const MAX_READINGS = 50000;
const MAX_BOOTSTRAP_ROWS = 4096;
const MAX_BOOTSTRAP_USAGE_SAMPLES = 50_000;
const MAX_WEEK_EPOCHS = 4096;
const SAME_RESET_MS = 60_000;
const MISSING_EPOCH_TOLERANCE_MS = 2 * DAY_MS;
const ACCOUNTS = new Set(['claude', 'codex']);
const RESOURCE_ID = /^[a-z0-9_:.-]{1,60}$/;
const finite = Number.isFinite;
const isImport = source => source === 'import' || source === 'import-open-window';
const sameReset = (a, b) => finite(a) && finite(b) && Math.abs(a - b) <= SAME_RESET_MS;
const sameOptionalReset = (a, b) => a === null || b === null ? a === b : sameReset(a, b);
const emptyData = account => ({ schema_version: 1, account, readings: [], bootstrap: [], usageSamples: [], weekEpochs: [] });

function validResource(value) {
  return typeof value === 'string' && RESOURCE_ID.test(value);
}

function canonicalWeekEpoch(epoch, data) {
  for (const known of data.weekEpochs) if (sameReset(known, epoch)) return known;
  for (const row of data.readings) if (sameReset(row.weekEpoch, epoch)) return row.weekEpoch;
  for (const row of data.bootstrap) if (sameReset(row.epoch, epoch)) return row.epoch;
  return epoch;
}

function rememberWeekEpochs(epochs, ...candidates) {
  const next = epochs.slice();
  for (const epoch of candidates) {
    if (!finite(epoch) || next.some(known => sameReset(known, epoch))) continue;
    next.push(epoch);
  }
  next.sort((a, b) => a - b);
  return next.length > MAX_WEEK_EPOCHS ? next.slice(-MAX_WEEK_EPOCHS) : next;
}

function normalizeCensoring(value) {
  const flags = ['limit_reached', 'owner_refused', 'owner_deferred'];
  const complete = value?.complete === true && flags.every(key => typeof value[key] === 'boolean');
  return {
    complete,
    limit_reached: value?.limit_reached === true,
    owner_refused: value?.owner_refused === true,
    owner_deferred: value?.owner_deferred === true,
  };
}

function validCensoring(value) {
  return value && typeof value.complete === 'boolean' &&
    typeof value.limit_reached === 'boolean' && typeof value.owner_refused === 'boolean' &&
    typeof value.owner_deferred === 'boolean';
}

function validReadingRow(row) {
  return row && validResource(row.resource) &&
    (row.windowMinutes === null || finite(row.windowMinutes) && row.windowMinutes > 0) &&
    (row.resourceResetEpoch === null || finite(row.resourceResetEpoch) && row.resourceResetEpoch >= 0) &&
    (row.weekEpoch === null || finite(row.weekEpoch) && row.weekEpoch >= 0) && finite(row.observedAt) && row.observedAt >= 0 &&
    (row.usedPct === null || finite(row.usedPct) && row.usedPct >= 0 && row.usedPct <= 100) &&
    validCensoring(row.censoring) &&
    (row.ownerLowerUsagePct === undefined || row.ownerLowerUsagePct === null ||
      finite(row.ownerLowerUsagePct) && row.ownerLowerUsagePct >= 0 && row.ownerLowerUsagePct <= 100) &&
    typeof row.known === 'boolean' && (row.meterOpen === undefined || typeof row.meterOpen === 'boolean') &&
    (row.ownerUsagePct === null || finite(row.ownerUsagePct) && row.ownerUsagePct >= 0 && row.ownerUsagePct <= 100) &&
    (row.known ? finite(row.ownerUsagePct) && row.reason === null : row.ownerUsagePct === null && typeof row.reason === 'string');
}

function validBootstrapRow(row) {
  return row && validResource(row.resource) && finite(row.epoch) && row.epoch >= 0 &&
    (row.ownerUsagePct === null || finite(row.ownerUsagePct) && row.ownerUsagePct >= 0 && row.ownerUsagePct <= 100) &&
    validCensoring(row.censoring) &&
    typeof row.complete === 'boolean' &&
    (row.complete ? finite(row.ownerUsagePct) : row.ownerUsagePct === null) &&
    (row.reason === null || typeof row.reason === 'string') &&
    (row.week_start === undefined || finite(row.week_start) && row.week_start >= 0 && row.week_start < row.epoch) &&
    (row.source === undefined || isImport(row.source)) &&
    (row.coverage_ratio === undefined || row.coverage_ratio === null ||
      finite(row.coverage_ratio) && row.coverage_ratio >= 0 && row.coverage_ratio <= 1) &&
    (row.usage_samples === undefined || Array.isArray(row.usage_samples) &&
      row.usage_samples.length <= MAX_BOOTSTRAP_USAGE_SAMPLES && row.usage_samples.every(sample =>
        sample && typeof sample.session_id === 'string' && sample.session_id.length > 0 && sample.session_id.length <= 128 &&
        (sample.message_id === undefined || sample.message_id === null || typeof sample.message_id === 'string' &&
          sample.message_id.length > 0 && sample.message_id.length <= 512) &&
        finite(sample.at) && sample.at >= (row.week_start ?? row.epoch - WEEK_MS) && sample.at < row.epoch &&
        finite(sample.points) && sample.points >= 0 && typeof sample.model === 'string' &&
        sample.model.length > 0 && sample.model.length <= 128));
}

function validUsageSampleRow(sample) {
  return sample && validResource(sample.resource) && finite(sample.account_week_id) && sample.account_week_id >= 0 &&
    finite(sample.week_start) && sample.week_start >= 0 && sample.week_start < sample.account_week_id &&
    typeof sample.session_id === 'string' && sample.session_id.length > 0 && sample.session_id.length <= 128 &&
    (sample.message_id === undefined || sample.message_id === null || typeof sample.message_id === 'string' &&
      sample.message_id.length > 0 && sample.message_id.length <= 512) &&
    finite(sample.at) && sample.at >= sample.week_start && sample.at < sample.account_week_id &&
    finite(sample.points) && sample.points >= 0 && typeof sample.model === 'string' &&
    sample.model.length > 0 && sample.model.length <= 128 &&
    (sample.coverage_ratio === undefined || sample.coverage_ratio === null ||
      finite(sample.coverage_ratio) && sample.coverage_ratio >= 0 && sample.coverage_ratio <= 1) &&
    (sample.source === undefined || isImport(sample.source));
}

function usageSampleKey(sample) {
  return JSON.stringify([sample.resource, sample.account_week_id, sample.session_id, sample.at, sample.message_id ?? null]);
}

function readData(file, account) {
  // Absent starts empty. A file that exists but cannot be read, parsed or checked is unknown, never empty: every reader and
  // every write throws StateUnknownError and the saved bytes stay until the owner repairs or removes the file.
  const saved = readJsonState(file);
  if (saved.state === 'absent') return emptyData(account);
  if (saved.state === 'unknown') throw new StateUnknownError(file, saved.error);
  const data = saved.value;
  if (data?.schema_version !== 1 || data.account !== account || !Array.isArray(data.readings) ||
      !Array.isArray(data.bootstrap) || !Array.isArray(data.weekEpochs) || data.weekEpochs.length > MAX_WEEK_EPOCHS ||
      !data.weekEpochs.every(epoch => finite(epoch) && epoch >= 0) || data.readings.length > MAX_READINGS ||
      data.bootstrap.length > MAX_BOOTSTRAP_ROWS || !data.readings.every(validReadingRow) ||
      !data.bootstrap.every(validBootstrapRow) ||
      data.usageSamples !== undefined && (!Array.isArray(data.usageSamples) || data.usageSamples.length > MAX_BOOTSTRAP_USAGE_SAMPLES ||
        !data.usageSamples.every(validUsageSampleRow)) ||
      data.bootstrap.reduce((sum, row) => sum + (Array.isArray(row.usage_samples) ? row.usage_samples.length : 0), 0) +
        (data.usageSamples?.length ?? 0) >
        MAX_BOOTSTRAP_USAGE_SAMPLES) throw new StateUnknownError(file, new Error('invalid lending history'));
  return data.usageSamples === undefined ? {...data, usageSamples:[]} : data;
}

function ownerUsagePct(reading, account, ledger) {
  if (reading.state !== 'open') return { value: null, reason: 'meter_unknown' };
  if (!finite(reading.window_minutes) || reading.window_minutes <= 0 ||
      !finite(reading.used_pct) || reading.used_pct < 0 || reading.used_pct > 100 ||
      !finite(reading.resets_at) || reading.resets_at <= reading.observed_at) {
    return { value: null, reason: 'invalid_meter_reading' };
  }
  const windowStart = reading.resets_at - reading.window_minutes * 60_000;
  if (!finite(windowStart)) return { value: null, reason: 'invalid_meter_reading' };

  let charges;
  try {
    charges = ledger.entries({ account, window_id: reading.window_id });
  } catch {
    return { value: null, reason: 'ledger_unavailable' };
  }
  if (!Array.isArray(charges)) return { value: null, reason: 'ledger_unavailable' };
  const matchingCharges = [];
  for (const charge of charges) {
    if (!charge) return { value: null, reason: 'ledger_ambiguous' };
    if (!finite(charge.resets_at)) {
      if (!finite(charge.started_at) || !finite(charge.ended_at) || charge.started_at > charge.ended_at)
        return { value: null, reason: 'ledger_ambiguous' };
      // A null reset is ambiguous only when this charge could be in the meter's cumulative window.
      if (charge.started_at <= reading.observed_at && charge.ended_at > windowStart)
        return { value: null, reason: 'ledger_ambiguous' };
      continue;
    }
    if (sameReset(charge.resets_at, reading.resets_at)) matchingCharges.push(charge);
  }

  let borrowerLowerBound = 0;
  for (const charge of matchingCharges) {
    if (!charge || !finite(charge.started_at) || !finite(charge.ended_at) ||
        charge.started_at > charge.ended_at || !finite(charge.lent_pts) || charge.lent_pts < 0)
      return { value: null, reason: 'ledger_ambiguous' };
    if (charge.ended_at > reading.observed_at) continue;
    // A finished job can still be absent from a lagging provider meter. Only subtract after
    // the ledger's post-charge aggregate observation is present in this reading.
    if (charge.represented_at !== undefined && charge.represented_at !== null &&
        (!finite(charge.represented_at) || charge.represented_at < charge.ended_at))
      return { value: null, reason: 'ledger_ambiguous' };
    if (charge.ended_at > reading.observed_at || !finite(charge.represented_at) ||
        charge.represented_at > reading.observed_at) continue;
    const lowerBound = charge.lent_lower_pts ?? (charge.attribution === 'exact' ? charge.lent_pts : 0);
    if (!finite(lowerBound) || lowerBound < 0 || lowerBound > charge.lent_pts)
      return { value: null, reason: 'ledger_ambiguous' };
    borrowerLowerBound += lowerBound;
  }
  if (borrowerLowerBound > reading.used_pct + 0.001) return { value: null, reason: 'ledger_exceeds_meter' };
  // entries() excludes active holds and may contain estimates, so it cannot prove
  // a borrower upper bound. Require a caller-attested complete bound, including
  // active/unrecorded spend, bound to this exact account/window/reset/observation.
  const bound = reading.borrower_upper_bound;
  const lowerKnown = bound?.complete === true && bound.account === account &&
    bound.window_id === reading.window_id && bound.resets_at === reading.resets_at &&
    bound.observed_at === reading.observed_at && finite(bound.upper_points) &&
    bound.upper_points >= borrowerLowerBound && typeof bound.provenance === 'string' &&
    bound.provenance.trim() && finite(reading.rounding_points) &&
    reading.rounding_points >= 0 && reading.rounding_points <= 100;
  return { value: Math.max(0, reading.used_pct - borrowerLowerBound),
    lowerValue: lowerKnown ? Math.max(0, reading.used_pct - reading.rounding_points - bound.upper_points) : null,
    reason: null };
}

function movedResetEpochs(readings) {
  const byResource = new Map();
  for (const row of readings) {
    if (row.windowMinutes !== WEEK_MINUTES || row.weekEpoch === null) continue;
    const rows = byResource.get(row.resource) ?? [];
    rows.push(row);
    byResource.set(row.resource, rows);
  }
  const moved = new Set();
  for (const rows of byResource.values()) {
    rows.sort((a, b) => a.observedAt - b.observedAt);
    for (let i = 1; i < rows.length; i++) {
      const previous = rows[i - 1], current = rows[i];
      if (!sameReset(previous.resourceResetEpoch, current.resourceResetEpoch) &&
          current.observedAt < previous.resourceResetEpoch && previous.weekEpoch !== null)
        moved.add(previous.weekEpoch);
    }
  }
  return moved;
}

function shortWindowCoverageReason(rows, windowMinutes, start, end) {
  const windowMs = windowMinutes * 60_000;
  const tailMs = Math.min(HOUR_MS, windowMs / 5);
  const byReset = [];
  for (const row of rows) {
    if (!finite(row.resourceResetEpoch)) return 'unknown_resource_reset';
    let group = byReset.find(item => sameReset(item.epoch, row.resourceResetEpoch));
    if (!group) byReset.push(group = { epoch: row.resourceResetEpoch, rows: [] });
    group.rows.push(row);
  }
  const resets = byReset.sort((a, b) => a.epoch - b.epoch);
  if (!resets.length || resets[0].epoch - start > windowMs + SAME_RESET_MS) return 'missing_resource_windows';
  for (let i = 1; i < resets.length; i++) {
    if (resets[i].epoch - resets[i - 1].epoch > windowMs + SAME_RESET_MS) return 'missing_resource_windows';
  }
  for (const reset of resets) {
    const boundary = Math.min(reset.epoch, end);
    const last = Math.max(...reset.rows.map(row => row.observedAt));
    if (boundary - last > tailMs) return 'missing_window_end';
  }
  const lastWeekReading = Math.max(...rows.map(row => row.observedAt));
  if (end - lastWeekReading > tailMs) return 'missing_week_end';
  return null;
}

function weekRow(resource, epoch, readings, bootstrap, movedEpochs) {
  const imported = bootstrap.find(row => row.resource === resource && sameReset(row.epoch, epoch));
  const start = imported?.week_start ?? epoch - WEEK_MS;
  const accountRows = readings.filter(row => row.weekEpoch !== null
    ? sameReset(row.weekEpoch, epoch)
    : row.observedAt >= start && row.observedAt < epoch);
  const rows = readings.filter(row => row.resource === resource &&
    (row.weekEpoch !== null ? sameReset(row.weekEpoch, epoch) : row.observedAt >= start && row.observedAt < epoch));
  const dayBins = new Set();
  for (const row of rows) {
    if (row.observedAt >= start && row.observedAt < epoch) dayBins.add(Math.floor((row.observedAt - start) / DAY_MS));
  }
  let reason = null;
  if (accountRows.some(row => row.censoring.limit_reached || row.censoring.owner_refused || row.censoring.owner_deferred))
    reason = 'owner_demand_censored';
  else if (accountRows.some(row => !row.censoring.complete)) reason = 'demand_evidence_unknown';
  else if (movedEpochs.has(epoch)) reason = 'reset_moved';
  else if (rows.some(row => !row.known)) reason = rows.find(row => !row.known).reason ?? 'unknown_reading';
  else if (rows.some(row => row.observedAt < start || row.observedAt >= epoch)) reason = 'reading_outside_week';
  else if (rows.length && dayBins.size < 7) reason = 'missing_days';
  else if (!rows.length && !imported) reason = 'missing_readings';
  else if (rows.length && epoch - Math.max(...rows.map(row => row.observedAt)) > MAX_WEEK_TAIL_MS) reason = 'missing_week_end';
  else if (new Set(rows.map(row => row.windowMinutes)).size > 1) reason = 'window_length_changed';
  else if (rows.length && rows[0].windowMinutes !== WEEK_MINUTES)
    reason = shortWindowCoverageReason(rows, rows[0].windowMinutes, start, epoch);

  let score = null;
  if (!reason && rows.length) {
    let resetEpoch = null, previousUsage;
    for (const row of rows.slice().sort((a, b) => a.observedAt - b.observedAt)) {
      if (row.windowMinutes === WEEK_MINUTES) {
        if (!sameReset(resetEpoch, row.resourceResetEpoch)) {
          resetEpoch = row.resourceResetEpoch;
          previousUsage = undefined;
        }
        // The normalized owner upper bound can drop when a later ledger entry proves
        // borrower burn was present in the aggregate; only the provider meter must be monotone.
        if (previousUsage !== undefined && row.usedPct + 0.001 < previousUsage) {
          reason = 'owner_usage_decreased';
          break;
        }
        previousUsage = row.usedPct;
      }
    }
    if (!reason) score = Math.max(...rows.map(row => row.ownerUsagePct));
  }

  if (imported) {
    if (!imported.censoring.complete || imported.censoring.limit_reached ||
        imported.censoring.owner_refused || imported.censoring.owner_deferred)
      reason = reason ?? 'bootstrap_censored';
    if (!reason && rows.length && imported.complete && Math.abs(score - imported.ownerUsagePct) > 0.001)
      reason = 'conflicting_sources';
    if (!rows.length) {
      if (imported.complete) score = imported.ownerUsagePct;
      else reason = imported.reason ?? 'bootstrap_incomplete';
    }
  }
  const complete = reason === null && finite(score);
  return {
    epoch, start, end: epoch, resource,
    score: complete ? score : Infinity,
    ownerUsagePct: complete ? score : null,
    complete,
    reason: complete ? null : reason ?? 'unknown_reading',
    sampleCount: rows.length,
    coveredDays: dayBins.size,
    source: rows.length ? imported ? 'meter+session_log_bootstrap' : 'meter'
      : imported ? imported.source ?? 'session_log_bootstrap' : 'missing',
    ...(isImport(imported?.source) ? {coverage_ratio:imported.coverage_ratio ?? null, ...(imported.calibration_window ? {calibration_window:imported.calibration_window} : {})} : {}),
  };
}

export function createLendingHistory({ home = configHome(), account, ledger, now = Date.now } = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new TypeError('lending history needs an absolute home');
  if (!ACCOUNTS.has(account)) throw new TypeError('lending history needs account claude or codex');
  if (!ledger || typeof ledger.entries !== 'function')
    throw new TypeError('lending history needs a lending ledger');
  if (typeof now !== 'function') throw new TypeError('lending history needs a clock function');

  const file = join(home, 'v1', 'lending-history-' + account + '.json');
  const lockFile = file + '.lock';
  let data; // every operation re-reads the file; an unreadable file fails the operation, not construction
  const persist = next => {
    saveJsonFile(file, next, {base:home});
    data = next;
  };

  function withWriteLock(action) {
    const deadline = performance.now() + 2000;
    let release;
    for (;;) {
      try { release = acquireProcessLockSync(lockFile); break; }
      catch (error) {
        if (error.code !== 'lock_busy' || performance.now() >= deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    try {
      data = readData(file, account);
      return action();
    } finally { release(); }
  }

  function record(reading) {
    if (!reading || typeof reading !== 'object' || !validResource(reading.window_id) ||
        !finite(reading.observed_at) || reading.observed_at < 0) throw new TypeError('invalid lending meter reading identity');
    return withWriteLock(() => {
      const rawWeekEpoch = finite(reading.account_week_epoch) && reading.account_week_epoch >= 0 ? reading.account_week_epoch
        : reading.window_minutes === WEEK_MINUTES && finite(reading.resets_at) && reading.resets_at >= 0 ? reading.resets_at : null;
      let weekEpoch = rawWeekEpoch === null ? null : canonicalWeekEpoch(rawWeekEpoch, data);
      const rollover = finite(reading.resets_at) && reading.observed_at >= reading.resets_at;
      if (rollover && weekEpoch !== null && weekEpoch <= reading.observed_at)
        weekEpoch = canonicalWeekEpoch(weekEpoch + WEEK_MS, data);
      const weekEpochs = rememberWeekEpochs(data.weekEpochs, weekEpoch);
      const usage = ownerUsagePct(reading, account, ledger);
      const censoring = normalizeCensoring(reading.censoring);
      const hasCensor = censoring.limit_reached || censoring.owner_refused || censoring.owner_deferred;
      const evidenceReason = hasCensor ? 'owner_demand_censored'
        : censoring.complete ? null : 'demand_evidence_unknown';
      const row = {
        resource: reading.window_id,
        meterOpen: reading.state === 'open',
        windowMinutes: finite(reading.window_minutes) && reading.window_minutes > 0 ? reading.window_minutes : null,
        resourceResetEpoch: finite(reading.resets_at) && reading.resets_at >= 0 ? reading.resets_at : null,
        weekEpoch,
        observedAt: reading.observed_at,
        usedPct: finite(reading.used_pct) && reading.used_pct >= 0 && reading.used_pct <= 100 ? reading.used_pct : null,
        ownerUsagePct: usage.value,
        ownerLowerUsagePct: usage.lowerValue ?? null,
        known: usage.value !== null && !rollover && evidenceReason === null,
        reason: rollover ? 'rollover_reading' : evidenceReason ?? usage.reason,
        censoring,
        // Capture provenance at ingestion; old rows never acquire synthetic evidence.
        episode: {
          start_at: finite(reading.resets_at) && finite(reading.window_minutes)
            ? reading.resets_at - reading.window_minutes * 60_000 : null,
          source: typeof reading.source === 'string' ? reading.source : null,
          rounding_points: finite(reading.rounding_points) ? reading.rounding_points : null,
          measurement: typeof reading.metadata?.measurement === 'string' ? reading.metadata.measurement : null,
        },
      };
      if (rollover || evidenceReason) row.ownerUsagePct = null;
      if (weekEpoch !== null && (reading.observed_at < weekEpoch - WEEK_MS || reading.observed_at >= weekEpoch)) {
        row.ownerUsagePct = null;
        row.known = false;
        row.reason = 'reading_outside_week';
      }

      const duplicate = data.readings.findIndex(old => old.resource === row.resource &&
        sameOptionalReset(old.resourceResetEpoch, row.resourceResetEpoch) && sameOptionalReset(old.weekEpoch, row.weekEpoch) &&
        old.observedAt === row.observedAt);
      if (duplicate >= 0) {
        const old = data.readings[duplicate];
        if (old.meterOpen === row.meterOpen && old.windowMinutes === row.windowMinutes && old.usedPct === row.usedPct && old.known === row.known &&
            old.ownerUsagePct === row.ownerUsagePct &&
            (old.ownerLowerUsagePct ?? null) === row.ownerLowerUsagePct && old.reason === row.reason &&
            JSON.stringify(old.censoring) === JSON.stringify(row.censoring) &&
            JSON.stringify(old.episode) === JSON.stringify(row.episode))
          return { recorded: false, known: old.known, reason: old.reason };
        row.ownerUsagePct = null;
        row.known = false;
        row.reason = 'conflicting_duplicate';
        row.censoring = {
          complete: old.censoring.complete && row.censoring.complete,
          limit_reached: old.censoring.limit_reached || row.censoring.limit_reached,
          owner_refused: old.censoring.owner_refused || row.censoring.owner_refused,
          owner_deferred: old.censoring.owner_deferred || row.censoring.owner_deferred,
        };
        const readings = data.readings.slice();
        readings[duplicate] = row;
        persist({ ...data, readings, weekEpochs });
        return { recorded: true, known: false, reason: row.reason };
      }

      const current = now();
      const cutoff = finite(current) ? current - (RETAIN_WEEKS + 1) * WEEK_MS : -Infinity;
      const retained = data.readings.filter(reading => reading.observedAt >= cutoff);
      if (retained.length >= MAX_READINGS) {
        if (weekEpochs.length !== data.weekEpochs.length) persist({ ...data, weekEpochs });
        return { recorded: false, known: false, reason: 'history_full' };
      }
      retained.push(row);
      retained.sort((a, b) => a.observedAt - b.observedAt);
      persist({ ...data, readings: retained, weekEpochs });
      return { recorded: true, known: row.known, reason: row.reason };
    });
  }

  function weeklyScores(resource) {
    if (!validResource(resource)) throw new TypeError('invalid lending resource');
    // Read projections must not replace the writer's working state or retain returned nested rows.
    const data = readData(file, account);
    const current = now();
    if (!finite(current)) return new Map();
    const epochs = new Set(data.weekEpochs);
    for (const row of data.readings) if (row.weekEpoch !== null) epochs.add(row.weekEpoch);
    for (const row of data.bootstrap) epochs.add(row.epoch);
    const ordered = [...epochs].sort((a, b) => a - b);
    const earliestNeeded = current - (RETAIN_WEEKS + 1) * WEEK_MS;
    const hasNearbyAnchor = expected => ordered.some(epoch => Math.abs(epoch - expected) <= MISSING_EPOCH_TOLERANCE_MS);
    for (let i = 1; i < ordered.length; i++) {
      const previous = ordered[i - 1], next = ordered[i];
      const gap = next - previous;
      if (gap <= WEEK_MS + MISSING_EPOCH_TOLERANCE_MS) continue;
      // A reset shifted by a few days is still one reset cycle. Infer only the
      // complete cycles between the observed anchors, not every earlier calendar slot.
      const cycleCount = Math.round(gap / WEEK_MS);
      const firstStep = Math.max(1, Math.ceil((earliestNeeded - previous) / WEEK_MS));
      const lastStep = cycleCount - 1;
      for (let step = firstStep; step <= lastStep; step++) {
        const missingEpoch = previous + step * WEEK_MS;
        if (missingEpoch <= current && !hasNearbyAnchor(missingEpoch)) epochs.add(missingEpoch);
      }
    }
    const latestAnchor = ordered.at(-1);
    if (latestAnchor <= current) {
      const firstStep = Math.max(1, Math.ceil((earliestNeeded - latestAnchor) / WEEK_MS));
      const lastStep = Math.floor((current - latestAnchor) / WEEK_MS);
      for (let step = firstStep; step <= lastStep; step++) epochs.add(latestAnchor + step * WEEK_MS);
    }
    const completed = [...epochs].filter(epoch => epoch <= current).sort((a, b) => a - b).slice(-RETAIN_WEEKS);
    const moved = movedResetEpochs(data.readings);
    return new Map(completed.map(epoch => [epoch, weekRow(resource, epoch, data.readings, data.bootstrap, moved)]));
  }

  function completeWeekCount(resource) {
    return [...weeklyScores(resource).values()].filter(row => row.complete).length;
  }

  function resources() {
    const data = readData(file, account);
    return [...new Set([...data.readings.map(row => row.resource), ...data.bootstrap.map(row => row.resource),
      ...data.usageSamples.map(row => row.resource)])].sort();
  }

  // These timestamped import samples are raw message usage, not fixed-exposure K increments.
  // A caller must group them into complete, predeclared slots before any K estimation.
  function usageSamples(resource) {
    if (resource !== undefined && !validResource(resource)) throw new TypeError('invalid lending resource');
    const data = readData(file, account);
    const rows = new Map();
    for (const row of data.bootstrap) if (isImport(row.source) && Array.isArray(row.usage_samples)) {
      for (const sample of row.usage_samples) {
        const normalized = {resource:row.resource, account_week_id:row.epoch,
          week_start:row.week_start ?? row.epoch - WEEK_MS, session_id:sample.session_id,
          message_id:sample.message_id ?? null, at:sample.at,
          points:sample.points, model:sample.model, coverage_ratio:row.coverage_ratio ?? null, source:'import'};
        rows.set(usageSampleKey(normalized), normalized);
      }
    }
    for (const sample of data.usageSamples) rows.set(usageSampleKey(sample), sample);
    return [...rows.values()].filter(sample => resource === undefined || sample.resource === resource)
      .sort((a, b) => a.at - b.at);
  }

  function bootstrapFromSessionLogs(adapter) {
    if (!adapter || typeof adapter.readWeeklyUsage !== 'function') throw new TypeError('session-log adapter needs readWeeklyUsage()');
    const rows = adapter.readWeeklyUsage();
    if (!Array.isArray(rows) || rows.length > MAX_BOOTSTRAP_ROWS) throw new TypeError('invalid session-log adapter result');
    const usageRows = adapter.readUsageSamples === undefined ? [] : adapter.readUsageSamples();
    if (!Array.isArray(usageRows) || usageRows.length > MAX_BOOTSTRAP_USAGE_SAMPLES || !usageRows.every(validUsageSampleRow))
      throw new TypeError('invalid session-log usage sample adapter result');
    const sampleWeekRows = adapter.readUsageSampleWeeks === undefined
      ? rows.filter(row => isImport(row?.source)).map(row => ({resource:row.resource, account_week_id:row.account_week_id}))
      : adapter.readUsageSampleWeeks();
    if (!Array.isArray(sampleWeekRows) || sampleWeekRows.length > MAX_BOOTSTRAP_ROWS || !sampleWeekRows.every(row =>
      row && validResource(row.resource) && finite(row.account_week_id) && row.account_week_id >= 0))
      throw new TypeError('invalid session-log usage sample week adapter result');
    const current = now();
    if (!finite(current)) throw new TypeError('session-log bootstrap needs a finite current time');
    return withWriteLock(() => {
      const imported = [];
      const replacedSampleWeeks = sampleWeekRows.map(row => ({resource:row.resource,
        account_week_id:canonicalWeekEpoch(row.account_week_id, data)}));
      const incomingSamples = usageRows.map(sample => ({...sample,
        account_week_id:canonicalWeekEpoch(sample.account_week_id, data), source:'import'}));
      const replacesWeek = (resource, epoch) => replacedSampleWeeks.some(week =>
        week.resource === resource && sameReset(week.account_week_id, epoch));
      const seenEpochs = [];
      for (const row of rows) {
        if (isImport(row?.source)) {
          const epochValue = row.account_week_id;
          const epoch = finite(epochValue) ? epochValue : null;
          const censored = row.censored === true;
          const validScore = censored ? row.score === Infinity : finite(row.score) && row.score >= 0 && row.score <= 100;
          const validCoverage = row.coverage_ratio === null || finite(row.coverage_ratio) &&
            row.coverage_ratio >= 0 && row.coverage_ratio <= 1;
          const validUsageSamples = row.usage_samples === undefined || Array.isArray(row.usage_samples) &&
            row.usage_samples.length <= MAX_BOOTSTRAP_USAGE_SAMPLES && row.usage_samples.every(sample =>
              sample && typeof sample.session_id === 'string' && sample.session_id.length > 0 && sample.session_id.length <= 128 &&
              (sample.message_id === undefined || sample.message_id === null || typeof sample.message_id === 'string' &&
                sample.message_id.length > 0 && sample.message_id.length <= 512) &&
              finite(sample.at) && sample.at >= row.week_start && sample.at < epoch &&
              finite(sample.points) && sample.points >= 0 && typeof sample.model === 'string' &&
              sample.model.length > 0 && sample.model.length <= 128);
          if (!validResource(row.resource) || epoch === null || epoch > current ||
              !finite(row.week_start) || row.week_start < 0 || typeof row.censored !== 'boolean' ||
              !validScore || !validCoverage || !validUsageSamples) {
            throw new TypeError('session-log adapter must return valid coverage-checked import rows');
          }
          const meterReadingExists = data.readings.some(reading => reading.resource === row.resource &&
            (reading.weekEpoch !== null ? sameReset(reading.weekEpoch, epoch)
              : reading.observedAt >= row.week_start && reading.observedAt < epoch));
          if (meterReadingExists) continue;
          let canonicalEpoch = canonicalWeekEpoch(epoch, data);
          const priorEpoch = seenEpochs.find(value => sameReset(value, canonicalEpoch));
          if (priorEpoch !== undefined) canonicalEpoch = priorEpoch;
          seenEpochs.push(canonicalEpoch);
          imported.push({resource:row.resource, epoch:canonicalEpoch,
            week_start:row.week_start,
            ownerUsagePct:censored ? null : row.score, complete:!censored,
            reason:censored ? row.incomplete === true ? 'import_incomplete'
              : row.coverage_ratio === null ? 'import_coverage_unknown' : 'import_coverage_low' : null,
            censoring:{complete:true, limit_reached:false, owner_refused:false, owner_deferred:false},
            source:row.source, coverage_ratio:row.coverage_ratio,
            ...(row.calibration_window ? {calibration_window:row.calibration_window} : {}),
            usage_samples:censored ? [] : row.usage_samples ?? []});
          continue;
        }
        const censoring = normalizeCensoring(row?.censoring);
        if (!row || !validResource(row.resource) || !finite(row.epoch) || row.epoch > current ||
            row.complete !== true || !finite(row.owner_usage_pct) || row.owner_usage_pct < 0 ||
            row.owner_usage_pct > 100 || !censoring.complete || censoring.limit_reached ||
            censoring.owner_refused || censoring.owner_deferred) {
          throw new TypeError('session-log adapter must return complete, uncensored normalized weekly usage');
        }
        let epoch = canonicalWeekEpoch(row.epoch, data);
        const priorEpoch = seenEpochs.find(value => sameReset(value, epoch));
        if (priorEpoch !== undefined) epoch = priorEpoch;
        seenEpochs.push(epoch);
        imported.push({ resource: row.resource, epoch, ownerUsagePct: row.owner_usage_pct,
          complete: true, reason: null, censoring });
      }
      let added = 0;
      let changed = false;
      const bootstrap = data.bootstrap.slice();
      for (let index = 0; index < bootstrap.length; index++) {
        const row = bootstrap[index];
        if (Array.isArray(row.usage_samples) && row.usage_samples.length && replacesWeek(row.resource, row.epoch)) {
          bootstrap[index] = {...row, usage_samples:[]};
          changed = true;
        }
      }
      for (const row of imported) {
        const index = bootstrap.findIndex(old => old.resource === row.resource && sameReset(old.epoch, row.epoch));
        if (index < 0) { bootstrap.push(row); added++; }
        else if (isImport(row.source)) {
          if (JSON.stringify(bootstrap[index]) !== JSON.stringify(row)) {
            bootstrap[index] = row;
            changed = true;
          }
        }
        else if (bootstrap[index].ownerUsagePct !== row.ownerUsagePct) {
          bootstrap[index] = { resource: row.resource, epoch: row.epoch, ownerUsagePct: null,
            complete: false, reason: 'conflicting_bootstrap', censoring: row.censoring };
          changed = true;
        }
      }
      if (bootstrap.length > MAX_BOOTSTRAP_ROWS) throw new TypeError('session-log history is too large');
      const previousSamples = data.usageSamples ?? [];
      const usageSamples = previousSamples.filter(sample => !replacesWeek(sample.resource, sample.account_week_id));
      const sampleIndexes = new Map(usageSamples.map((sample, index) => [usageSampleKey(sample), index]));
      const legacySampleKeys = new Set(bootstrap.flatMap(row => isImport(row.source) && Array.isArray(row.usage_samples)
        ? row.usage_samples.map(sample => usageSampleKey({resource:row.resource, account_week_id:row.epoch,
          session_id:sample.session_id, message_id:sample.message_id, at:sample.at})) : []));
      let samplesChanged = usageSamples.length !== previousSamples.length;
      for (const sample of incomingSamples) {
        const key = usageSampleKey(sample), index = sampleIndexes.get(key);
        if (index !== undefined) {
          if (JSON.stringify(usageSamples[index]) !== JSON.stringify(sample)) {
            usageSamples[index] = sample;
            samplesChanged = true;
          }
        } else if (!legacySampleKeys.has(key)) {
          sampleIndexes.set(key, usageSamples.length);
          usageSamples.push(sample);
          samplesChanged = true;
        }
      }
      if (bootstrap.reduce((sum, row) => sum + (row.usage_samples?.length ?? 0), 0) + usageSamples.length > MAX_BOOTSTRAP_USAGE_SAMPLES)
        throw new TypeError('session-log usage sample history is too large');
      const weekEpochs = rememberWeekEpochs(data.weekEpochs, ...imported.map(row => row.epoch),
        ...replacedSampleWeeks.map(row => row.account_week_id), ...incomingSamples.map(row => row.account_week_id));
      if (added || changed || imported.length || samplesChanged) persist({ ...data, bootstrap, usageSamples, weekEpochs });
      return added;
    });
  }

  // Explicitly injected rules only. Never fabricate a start sample or reset endpoint.
  // Censored account-weeks retain identity/reasons, but expose no usable owner trace.
  function ownerTraces() {
    const data = readData(file, account);
    const groups = new Map(), current = now();
    const censored = data.readings.filter(row => !row.censoring.complete ||
      row.censoring.limit_reached || row.censoring.owner_refused || row.censoring.owner_deferred);
    const weekCensored = row => censored.some(bad => bad.weekEpoch !== null
      ? sameReset(bad.weekEpoch, row.weekEpoch)
      : bad.observedAt >= row.weekEpoch - WEEK_MS && bad.observedAt < row.weekEpoch);
    for (const row of data.readings) {
      if (row.weekEpoch === null || row.observedAt > current || !finite(row.resourceResetEpoch)) continue;
      const key = JSON.stringify([row.resource, row.resourceResetEpoch]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    return [...groups.values()].map(rows => {
      const first = rows[0], bad = rows.some(weekCensored);
      const consistent = rows.every(row => row.episode &&
        JSON.stringify(row.episode) === JSON.stringify(first.episode) &&
        row.windowMinutes === first.windowMinutes);
      const evidence = consistent ? first.episode : null;
      const trace = bad ? [] : rows.filter(row => row.known)
        .map(row => [row.observedAt, row.ownerUsagePct]).sort((a, b) => a[0] - b[0]);
      // Keep the existing upper-valued trace unchanged. Only separately recorded
      // lower observations may support OPEN probes; legacy rows gain no evidence.
      const known = rows.filter(row => row.known).sort((a, b) => a.observedAt - b.observedAt);
      const lower = !bad && evidence && known.length >= 2 &&
        known[0].observedAt === evidence.start_at && known[0].ownerLowerUsagePct === 0 &&
        known.every(row => finite(row.ownerLowerUsagePct))
        ? known.map(row => [row.observedAt, row.ownerLowerUsagePct]) : null;
      const last = trace.at(-1)?.[0];
      return {window_id:first.resource, trace,
        ...(lower ? {owner_lower_trace:lower} : {}),
        start_at:evidence?.start_at ?? null, resets_at:first.resourceResetEpoch,
        length_ms:evidence && finite(first.windowMinutes) ? first.windowMinutes * 60_000 : null,
        complete:!bad && last === first.resourceResetEpoch && last <= current,
        censored:bad, source:evidence?.source ?? null,
        rounding_points:evidence?.rounding_points ?? null,
        metadata:{measurement:evidence?.measurement ?? null,
          ...(bad ? {excluded_reason:'account_week_censored'} : {})},
        tail_unobserved_ms:finite(last) ? Math.max(0, first.resourceResetEpoch - last) : null};
    });
  }


  // Total-meter spans for conversion calibration, independent of owner-only history scores.
  // Coalesce sub-three-point rises; never invent a zero at a reset or cross window instances.
  function recentMeterRate(resource, reset, at) {
    const hour = 3_600_000;
    const rows = readData(file, account).readings.filter(row =>
      row.resource === resource && row.resourceResetEpoch === reset &&
      row.meterOpen === true && finite(row.usedPct) &&
      row.observedAt >= at - 24 * hour && row.observedAt <= at)
      .sort((a, b) => a.observedAt - b.observedAt);
    const first = rows[0], last = rows.at(-1);
    if (!first || at - last.observedAt > 2 * hour ||
        last.observedAt - first.observedAt < 20 * hour ||
        rows.some((row, i) => i > 0 && row.usedPct < rows[i - 1].usedPct)) return null;
    // Include whole-point meter rounding and any borrower use in the demand estimate.
    return (last.usedPct - first.usedPct + 1) * hour / (last.observedAt - first.observedAt);
  }

  function meterSpans() {
    const data = readData(file, account), groups = new Map(), current = now();
    for (const row of data.readings) {
      if (!(row.known || row.meterOpen === true) || !finite(row.usedPct) ||
          !finite(row.resourceResetEpoch) || row.observedAt > current) continue;
      const key = JSON.stringify([row.resource, row.resourceResetEpoch]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const spans = [];
    for (const rows of groups.values()) {
      rows.sort((a,b) => a.observedAt - b.observedAt);
      let before = rows[0];
      for (const row of rows.slice(1)) {
        if (row.usedPct < before.usedPct) { before = row; continue; }
        if (row.observedAt <= before.observedAt || row.usedPct - before.usedPct < 3) continue;
        spans.push({account, resource:`${account}:${row.resource}`, start_at:before.observedAt,
          end_at:row.observedAt, meter_points:row.usedPct - before.usedPct, end_points:row.usedPct});
        before = row;
      }
    }
    return spans;
  }

  // Return only a usable, still-open observation, never a synthetic zero reading.
  // Aggregate meter usage includes borrowers: that lowers coverage conservatively.
  function currentWindows() {
    const data = readData(file, account);
    const latest = new Map(), current = now();
    for (const row of data.readings) {
      if (!(row.known || row.meterOpen === true) || !finite(row.usedPct) || row.usedPct <= 0 ||
          !finite(row.weekEpoch) || row.weekEpoch <= current ||
          !finite(row.resourceResetEpoch) || row.resourceResetEpoch <= current ||
          !finite(row.windowMinutes) || row.observedAt > current) continue;
      const previous = latest.get(row.resource);
      if (!previous || previous.observedAt < row.observedAt) latest.set(row.resource, row);
    }
    return [...latest.values()].map(row => ({account, resource:`${account}:${row.resource}`,
      account_week_id:row.weekEpoch, start_at:row.resourceResetEpoch-row.windowMinutes*60_000,
      end_at:row.resourceResetEpoch, observed_at:row.observedAt, meter_points:row.usedPct}));
  }

  function deleteImportedHistory() {
    return withWriteLock(() => {
      const bootstrap = data.bootstrap.filter(row => !isImport(row.source));
      const usageSamples = data.usageSamples.filter(row => !isImport(row.source));
      // Preserve readings, ledger and reset anchors: disabling learning cannot erase meter evidence.
      persist({...data, bootstrap, usageSamples});
    });
  }


  return { meterSpans, recentMeterRate, currentWindows, deleteImportedHistory, record, weeklyScores, usageSamples, ownerTraces, resources, completeWeekCount, bootstrapFromSessionLogs };
}
