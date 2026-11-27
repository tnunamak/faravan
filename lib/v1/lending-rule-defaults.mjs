// Lead-chosen defaults and production attestations for the fluid rule. Pure: no I/O, no clock.
// The caller passes the live windows, the owner-trace rows and the evaluation time.
import {NATIVE_WINDOW_WEIGHTS, seedQuotaRegistry} from './quota-registry.mjs';
import {mapRuleEpisode} from './lending-rule-seam.mjs';

// Posting-finality calibration supplies this measured bound; no coverage release until it exists.
export const MEASURED_POSTING_LAG_MS = null;

export const PROVIDER_LAG_MS = 600000; // lead-chosen, easy to change
export const BURN_RATE_MARGIN = 1.5; // lead-chosen, easy to change: maxPointsPerHour = margin x highest hourly burn
export const COLD_START_POINTS_PER_HOUR = 20; // lead-chosen, easy to change: floor when a window has no owner history
export const ROUNDING_POINTS = 0.5; // lead-chosen: a meter shown in whole percent can be off by half a point

export const LAG_PROVENANCE = 'lead-chosen meter lag allowance';
export const ESTIMATED_RATE_PROVENANCE = 'estimated from owner history x1.5 (lead-chosen)';
export const COLD_START_RATE_PROVENANCE = 'cold-start default (lead-chosen)';
export const ROUNDING_PROVENANCE = 'lead-chosen: half a point for a whole-percent meter';
export const REGISTRY_PROVENANCE = 'live meter roster as the provider reported it, with each window\'s estimated conversion';

const HOUR = 3_600_000, WEEK = 168 * HOUR, MICRO = 1_000_000;

// Highest burn (points per hour) between adjacent trace points of one window in [now - 7 days, now].
// Same interval rule as the builder's observed rate.
function highestHourlyBurn(rows, windowId, now) {
  let rate = null;
  for (const row of rows) {
    if (row?.window_id !== windowId || !Array.isArray(row.trace)) continue;
    for (let i = 1; i < row.trace.length; i++) {
      const [before, usedBefore] = row.trace[i - 1], [at, used] = row.trace[i];
      if (before < now - WEEK || at > now || at <= before) continue;
      rate = Math.max(rate ?? 0, (used - usedBefore) * HOUR / (at - before));
    }
  }
  return rate;
}

/**
 * lagBounds inputs for buildRuleEvidence. `rows` is owner history; `liveRows` are the current windows' own
 * readings (see liveRateRows). With owner history the bound is margin x the highest burn in either. A window
 * with no owner history gets at least the cold-start rate: one live reading is not a history.
 */
export function lagBoundsFor({windows, rows, liveRows = [], now}) {
  const providerLagMs = {}, maxPointsPerHour = {};
  let coldStart = false;
  for (const window of windows) {
    const owned = highestHourlyBurn(rows, window.id, now), live = highestHourlyBurn(liveRows, window.id, now);
    const burn = Math.max(owned ?? 0, live ?? 0);
    providerLagMs[window.id] = PROVIDER_LAG_MS;
    if (owned === null) {
      coldStart = true;
      maxPointsPerHour[window.id] = Math.max(COLD_START_POINTS_PER_HOUR, BURN_RATE_MARGIN * burn);
    } else {
      maxPointsPerHour[window.id] = BURN_RATE_MARGIN * burn;
    }
  }
  return {providerLagMs, providerLagProvenance: LAG_PROVENANCE, maxPointsPerHour,
    rateProvenance: coldStart ? COLD_START_RATE_PROVENANCE : ESTIMATED_RATE_PROVENANCE};
}

// Each open window's own reading as one rate observation: a window starts at 0 at its anchor and reads
// used_micro now. That total includes borrower use, so it overstates the owner's burn (the safe side).
export function liveRateRows(windows, now) {
  return windows.filter(w => Number.isFinite(w?.anchor_at) && w.anchor_at < now && Number.isSafeInteger(w.used_micro))
    .map(w => ({window_id:w.id, start_at:w.anchor_at, resets_at:w.resets_at, length_ms:w.duration_ms,
      complete:false, censored:false, source:'live_meter', rounding_points:ROUNDING_POINTS,
      metadata:{measurement:'live meter reading'}, trace:[[w.anchor_at, 0], [now, Math.min(100, w.used_micro / MICRO)]]}));
}

// The rule reads only supported rows (fluid-protection keeps supported === true), so the builder gets the same view.
// Rate history additionally excludes censored rows, as the builder requires.
export function ruleHistoryFor(rows, now) {
  const history = rows.filter(row => mapRuleEpisode(row, now).supported);
  return {history, rateHistory: history.filter(row => row.censored === false)};
}

/**
 * A complete registry for this request, from the live roster: one limit per window the provider reported,
 * scoped as the meter vocabulary names it, weighted by the window's estimated conversion (points per USD).
 * Returns null when a window is outside the vocabulary or has no conversion; the builder then refuses by name.
 */
export function registryFor({provider, model, windows}) {
  const seed = seedQuotaRegistry({codexWindowMinutes: provider === 'codex' ? windows.map(w => w.duration_ms / 60000) : []});
  const limits = [];
  for (const w of windows) {
    const known = seed.limits.find(l => l.id === w.id && l.provider === provider);
    if (!known) return null;
    // A window with no measured conversion is held in its own points, so its limit carries no model weight.
    if (w.conversion === 'native_window' && w.kappa_micro === null) {
      limits.push({...structuredClone(known), reset:{kind:'fixed', anchorMs:w.resets_at},
        weights:{version:NATIVE_WINDOW_WEIGHTS, nativeUnit:known.unit, byModel:{}}});
      continue;
    }
    if (!Number.isSafeInteger(w.kappa_micro) || w.kappa_micro <= 0) return null;
    limits.push({...structuredClone(known), reset:{kind:'fixed', anchorMs:w.resets_at},
      weights:{version:'estimated-kappa/1', nativeUnit:'usd', byModel:{[model]: w.kappa_micro / MICRO}}});
  }
  return {version:'live-roster/1', complete:true, limits};
}

// A job's native cost is bounded by its own enforced cap.
export const nativeCostBounds = requestedUsdMicro => ({unit:'usd', lower:0, upper:requestedUsdMicro / MICRO});

/**
 * The rule's meter snapshot, from the same live windows the adapter decides on: the seam requires the snapshot to
 * be that exact reading. Lent points are the ledger entries for each window instance; reservations come from the
 * ledger's row for the same reset, else 0.
 */
export function liveSnapshot({account, windows, entries, ledgerWindows = []}) {
  return {account, windows: windows.map(w => {
    const ledgerRow = ledgerWindows.find(row => row.window_id === w.id && row.resets_at === w.resets_at);
    const lent = entries.filter(e => e.window_id === w.id && e.resets_at === w.resets_at)
      .reduce((sum, e) => sum + (Number.isFinite(e.lent_pts) ? e.lent_pts : 0), 0);
    return {window_id:w.id, window_minutes:w.duration_ms / 60000, used_pct:w.used_micro / MICRO, resets_at:w.resets_at,
      observed_at:w.observed_at, state:'open', lent_pct:lent, reserved_pct:ledgerRow?.reserved_pct ?? 0};
  })};
}
