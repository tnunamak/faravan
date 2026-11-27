// Online calibration from lent jobs. A native-window job settles from the meter: its rise from the admission baseline over
// its plan-funded, priced cost gives an empirical conversion for that account and window. This is an upper envelope of what
// was seen, not a bound on the future rate. It is never a gate (no sample, no hold). The cost comes from the borrower's own
// output, so a sample can only raise a rate the account's own logs measured (learnedConversion).
//
// The filters are the log measurement's (lending-kappa-measure.mjs): only plan-funded use counts; only the account the reading
// names; only meters whose scope is known, and a per-model meter only for its own model family; a meter at 100% is censored;
// each sample is one attempt, so a copy counts once; a sample stands for MEASUREMENT_MAX_AGE_MS after it was taken. A rise of
// less than one shown point is no evidence: zero rise is never zero conversion.
import {durableJson} from '../durable-write.mjs';
import {readJsonState, StateUnknownError} from './state-read.mjs';
import {FAMILY, MEASUREMENT_MAX_AGE_MS, METER_RESOLUTION_POINTS, measurable} from './lending-kappa-measure.mjs';

const MICRO = 1_000_000;
const FULL_METER_MICRO = 100 * MICRO;
export const LENT_LABEL = 'measured from jobs you lent';

/**
 * One calibration sample, or the reason there is none. `attempt` is the durable ledger attempt (native-window resources),
 * `reading` the settlement observation, `usdMicro` the job's priced, plan-funded list cost, `accountId` the verified account the
 * attempt was admitted on.
 */
export function lentCalibrationSamples({attempt, reading, usdMicro, provider, model, accountId, now}) {
  if (!attempt || !Array.isArray(attempt.resources) || !attempt.resources.every(r => r.conversion === 'native_window'))
    return {samples: [], reason: 'not_native'};
  if (!(Number.isSafeInteger(usdMicro) && usdMicro > 0)) return {samples: [], reason: 'cost_unknown'};
  if (reading?.funding?.subscription_only !== 'proven') return {samples: [], reason: 'funding_unproven'};
  if (reading.identity?.verified !== true || typeof accountId !== 'string' || reading.identity.account_id !== accountId)
    return {samples: [], reason: 'account_mismatch'};
  if (reading.complete !== true || reading.refresh_succeeded !== true || reading.epoch !== attempt.epoch)
    return {samples: [], reason: 'reading_unusable'};
  // Lag can understate the rise, so only a reading taken after the sandbox was proven gone may settle the interval.
  if (!Number.isSafeInteger(attempt.cleanup_proof_persisted_at) || !(reading.observed_at >= attempt.cleanup_proof_persisted_at))
    return {samples: [], reason: 'interval_unsettled'};
  const samples = [];
  for (const ledger of attempt.resources) {
    if (ledger.skipped_periods > 0 || attempt.id.includes(':carry:') && ledger.skipped_periods === undefined) continue;
    const resource = `${provider}:${ledger.id}`;
    const family = FAMILY[resource];
    if (!measurable(resource) || family && !String(model ?? '').toLowerCase().includes(family)) continue;
    const seen = reading.resources.find(r => r.id === ledger.id);
    // The same window instance only: a reset in between makes the two readings incomparable.
    if (!seen || seen.instance !== ledger.instance || seen.resets_at !== ledger.resets_at || !Number.isSafeInteger(seen.used_micro)) continue;
    if (seen.used_micro >= FULL_METER_MICRO) continue;
    const rise = seen.used_micro - ledger.baseline_used_micro;
    if (rise < METER_RESOLUTION_POINTS * MICRO) continue;
    // k = (rise + q) / D, rounded up so it is an upper envelope of this interval.
    const upper = Math.ceil((rise + METER_RESOLUTION_POINTS * MICRO) * MICRO / usdMicro);
    if (!Number.isSafeInteger(upper) || upper <= 0) continue;
    samples.push({account: provider, resource, upper_micro: upper, lower_micro: null,
      binding: {account_sha256_16: accountId, since: null},
      evidence_end_at: reading.observed_at, expires_at: reading.observed_at + MEASUREMENT_MAX_AGE_MS,
      attempt_id: attempt.id,
      provenance: {method: 'lent-job', label: LENT_LABEL, source: 'live meter / job list-price USD',
        resolution_points: METER_RESOLUTION_POINTS, rise_micro: rise, usd_micro: usdMicro}});
  }
  return {samples, reason: samples.length ? null : 'no_measurable_rise', now};
}

/**
 * The conversion admission may use, from the account's own log measurement and its lent-job envelope. A lent sample's USD comes
 * from the job's own output (its result event or final guard line), which the borrower controls, and no host-side source prices
 * the job: the provider traffic leaves the sandbox through Docker's credential proxy, and the lender reads only the meter. So a
 * lent sample may only raise a trusted rate, which reserves more points per dollar. It never lowers one, and alone it never
 * sets one: an account with no log measurement stays in native-window mode, which lends in points against the live meter.
 */
export function learnedConversion({logged = null, lent = null} = {}) {
  if (!logged) return null;
  return lent && lent.upper_micro > logged.upper_micro ? lent : logged;
}

/**
 * The durable store of lent samples, keyed by account and resource. It keeps the highest unexpired envelope and the attempt
 * ids already counted, so a replayed settlement counts once.
 */
export function createLentKappaStore({file, now = Date.now} = {}) {
  let rows = {}, counted = new Set(), unknown = null;
  // Absent starts empty. A file that exists but cannot be read or parsed is an unknown envelope, never an empty one:
  // `unknown` is set, record and clear refuse to replace the file, and the app does not price from a partial picture.
  const loaded = readJsonState(file);
  if (loaded.state === 'unknown') unknown = loaded.error;
  else if (loaded.state === 'present') {
    const saved = loaded.value;
    if (saved && typeof saved === 'object' && saved.version === 1) {
      rows = saved.rows && typeof saved.rows === 'object' ? saved.rows : {};
      counted = new Set(Array.isArray(saved.counted) ? saved.counted.filter(id => typeof id === 'string') : []);
    } else unknown = new Error('unexpected shape');
  }
  const key = (accountId, resource) => `${accountId}/${resource}`;
  const save = () => durableJson(file, {version: 1, rows, counted: [...counted].slice(-512)});
  return {
    /** True when the saved file exists but could not be read; the envelope is then unknown, not empty. */
    get unknown() { return unknown !== null; },
    record(samples) {
      if (unknown) throw new StateUnknownError(file, unknown);
      let changed = false;
      for (const sample of samples ?? []) {
        if (counted.has(`${sample.attempt_id}/${sample.resource}`)) continue;
        counted.add(`${sample.attempt_id}/${sample.resource}`);
        const k = key(sample.binding.account_sha256_16, sample.resource), prior = rows[k];
        if (!prior || prior.expires_at <= now() || sample.upper_micro >= prior.upper_micro) rows[k] = sample;
        changed = true;
      }
      if (changed) save();
      return changed;
    },
    // The current envelope, or null. Expiry returns the window to native-window mode, never to a hold.
    current({accountId, resource}) {
      const row = rows[key(accountId, resource)];
      return row && row.expires_at > now() ? row : null;
    },
    // An explicit owner reset is the one way to replace an unreadable file.
    clear() { rows = {}; counted = new Set(); unknown = null; save(); },
  };
}
