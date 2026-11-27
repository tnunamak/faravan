import {LIVE_QUOTA_STALE_MS} from './lending-quota-timing.mjs';
import {reconcileQuotaSnapshot} from './quota-registry.mjs';
// Opt-in adapter for research rules. No default rule, clock, I/O, or inferred burn-rate bound.
const MICRO = 1_000_000, HOUR = 3_600_000;
// Default live-meter guard interval. Admission accounts for reading age against headroom.
export const MAX_METER_AGE_MS = LIVE_QUOTA_STALE_MS;
const finite = (n, name, max = Infinity) => {
  if (!Number.isFinite(n) || n < 0 || n > max) throw evidenceError(VALIDATION_CODE[name], 'unknown ' + name);
  return n;
};
const micro = (n, name) => {
  if (!Number.isSafeInteger(n) || n < 0) throw evidenceError(VALIDATION_CODE[name], 'unknown ' + name);
  return n;
};
const VALIDATION_CODE = Object.freeze({
  "account-wide rate": "seam_unknown_account_wide_rate",
  "borrower lower": "seam_unknown_borrower_lower",
  "borrower spend": "seam_unknown_borrower_spend",
  "conversion": "seam_unknown_conversion",
  "dial": "seam_unknown_dial",
  "gross request": "seam_unknown_gross_request",
  "inflight": "seam_unknown_inflight",
  "ledger end": "seam_unknown_ledger_end",
  "ledger reservations": "seam_unknown_ledger_reservations",
  "ledger start": "seam_unknown_ledger_start",
  "ledger total": "seam_unknown_ledger_total",
  "meter": "seam_unknown_meter",
  "now": "seam_unknown_now",
  "observation": "seam_unknown_observation",
  "provider lag bound": "seam_unknown_provider_lag_bound",
  "represented time": "seam_unknown_represented_time",
  "rounding bound": "seam_unknown_rounding_bound",
  "rule lendable": "seam_unknown_rule_lendable",
  "stop": "seam_unknown_stop",
  "uncertainty": "seam_unknown_uncertainty",
  "wall": "seam_unknown_wall",
  "window length": "seam_unknown_window_length"
});
const idsOf = windows => Object.keys(windows);
const exact = (value, ids) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === ids.length && ids.every(id => Object.hasOwn(value, id));

// Interpret the supplied finite decimal bounds exactly before rounding UP once.
// Re-ceiling a binary floating product (e.g. 3 * .05) can invent a micro-point.
// No tolerance is used: a genuinely larger decimal bound must still hold.
function registryChargeMicro(cost, weight) {
  const ratio = value => {
    const [digits, exponent = '0'] = String(value).toLowerCase().split('e');
    const [whole, fraction = ''] = digits.split('.');
    const scale = fraction.length - Number(exponent);
    const numerator = BigInt(whole + fraction);
    return scale >= 0 ? [numerator, 10n ** BigInt(scale)]
      : [numerator * 10n ** BigInt(-scale), 1n];
  };
  const [costN, costD] = ratio(cost), [weightN, weightD] = ratio(weight);
  const numerator = costN * weightN * BigInt(MICRO), denominator = costD * weightD;
  return (numerator + denominator - 1n) / denominator;
}
const evidenceError = (code, message) => Object.assign(new TypeError(message), {code});

// Arbitrary injected callbacks can throw primitives, frozen errors or hostile
// getters. A caller can still obtain a stable hold code without rewriting the
// original exception or exposing its message as owner copy.
export function lendingRuleErrorCode(error) {
  try {
    const code = error?.code;
    if (typeof code === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(code)) return code;
  } catch { /* Unknown exceptions use the same generic hold code. */ }
  return 'seam_unexpected_error';
}

/**
 * Evidence is a caller-owned snapshot, taken at the same admission boundary as windows:
 * {snapshot: ledger.snapshot(account), entries: ledger.entries({account}),
 *  history: history.ownerTraces(), roundingPoints: {id: absolute error},
 *  lagBounds: {id: {providerLagMs, maxPointsPerHour, provenance, maxPointsPerHourEvidenceClass}},
 *  applicableResources: {account, provider, model, complete:true, ids:[...]}}.
 * The roster is bound to job.provider/model and independently checked against EVERY
 * snapshot row. Applicability and charges come from ruleEvidence.quotaRegistry, not an ad hoc
 * id list. The complete versioned registry is a trusted account-specific attestation;
 * the seed vocabulary alone is intentionally incomplete. job.nativeCostBounds is
 * required and must match the gross amount, including overshoot. The registry may
 * model rolling limits, but this epoch-based seam rejects them until supported.
 * maxPointsPerHour must be an externally justified ACCOUNT-WIDE upper bound, NOT
 * ledger.max_rate_pct_per_hour (a historical maximum is not a future bound).
 * observed_at is receipt time, NOT proof of provider coverage. providerLagMs is an
 * externally justified upper bound on intrinsic reporting delay at receipt. Total
 * unreported burn is bounded over reading age + providerLagMs. Every window needs
 * an explicit nonnegative lag bound and provenance, even at age zero; a rate bound
 * is required even at zero total delay. Zero lag is an explicit caller assertion,
 * never inferred from a fresh receipt. Rounding also requires an explicit bound.
 * committedMicro and reserved_pct may describe disjoint work: sum conservatively.
 * Overlapping work can be double-counted (a safe hold), never assumed identical.
 * All times supplied by the product are milliseconds; the pure interface uses epoch hours.
 */
function annotateFailure(error) {
  try {
    if (error instanceof Error && error.code === undefined) error.code = 'seam_unexpected_error';
  } catch { /* Frozen/untrusted errors and hostile proxies stay unchanged. */ }
  return error;
}
const finiteRecentRate = value => Number.isFinite(value) && value >= 0;

export function buildLendingRuleState(input) {
  try { return buildState(input); } catch (error) { throw annotateFailure(error); }
}
function buildState(input) {
  const {now, windows, job, ruleDial, ruleEvidence: evidence} = input;
  finite(now, 'now'); finite(ruleDial, 'dial', 1);
  const ids = idsOf(windows);
  if (!ids.length) throw evidenceError('seam_quota_windows_required', 'quota windows required');
  if (!evidence || !Array.isArray(evidence.snapshot?.windows) || !Array.isArray(evidence.entries) ||
      !Array.isArray(evidence.history)) throw evidenceError('seam_unknown_rule_evidence', 'unknown rule evidence');
  const account = evidence.snapshot.account;
  if (typeof account !== 'string' || !account) throw evidenceError('seam_unknown_account', 'unknown account');
  const roster = evidence.applicableResources;
  if (!roster || roster.complete !== true || roster.account !== account ||
      (input.account !== undefined && input.account !== account) ||
      !['claude', 'codex'].includes(job.provider) || typeof job.model !== 'string' || !job.model.trim() ||
      roster.provider !== job.provider || roster.model !== job.model || !Array.isArray(roster.ids))
    throw evidenceError('seam_unknown_applicable_resource_roster', 'unknown applicable resource roster');
  const snapshotIds = evidence.snapshot.windows.map(row => row?.window_id);
  if (snapshotIds.some(id => typeof id !== 'string' || !id) || new Set(snapshotIds).size !== snapshotIds.length)
    throw evidenceError('seam_ambiguous_meter_identity', 'ambiguous meter identity');
  // The registry is independent of observed rows: a missing applicable meter cannot
  // disappear from the expected roster. Unknown definitions/weights fail closed.
  if (!evidence.quotaRegistry) throw evidenceError('quota_registry_missing', 'unknown quota registry');
  const registryState = reconcileQuotaSnapshot(evidence.quotaRegistry, job, evidence.snapshot, now);
  if (!registryState.supported) throw evidenceError(
    registryState.rows.some(row => row.reason === 'unknown_native_cost')
      ? 'native_cost_bound_unknown' : 'quota_registry_unsupported',
    'unsupported quota registry evidence');
  const applicable = registryState.rows.filter(row => row.applicable === true).map(row => row.id);
  const sameIds = (a, b) => a.length === b.length && new Set(a).size === a.length && a.every(id => b.includes(id));
  if (!sameIds(roster.ids, applicable) || !sameIds(ids, applicable))
    throw evidenceError('seam_incomplete_applicable_resource_roster', 'incomplete applicable resource roster');
  // A rule must evaluate the exact gross request that will be reserved, never just
  // its native budget or a cheap average call. Overshoot is already IN this gross.
  const grossUsd = micro(job.requestedUsdMicro, 'gross request');
  const gross = {}, mapped = [];
  for (const id of ids) {
    const w = windows[id], rows = evidence.snapshot.windows.filter(row => row.window_id === id);
    if (rows.length !== 1) throw evidenceError('seam_ambiguous_meter_identity', 'ambiguous meter identity');
    const r = rows[0];
    if (r.state !== 'open' || r.resets_at !== w.resetAtMs ||
        Math.round(finite(r.used_pct, 'meter', 100) * MICRO) !== w.usedMicro)
      throw evidenceError('seam_incompatible_meter_snapshot', 'incompatible meter snapshot');
    const length = finite(r.window_minutes, 'window length') / 60;
    if (length <= 0 || !Number.isSafeInteger(w.durationMs) || w.durationMs !== r.window_minutes * 60_000 ||
        (w.anchorAtMs !== undefined && w.anchorAtMs !== r.resets_at - w.durationMs))
      throw evidenceError('seam_incompatible_window_length', 'incompatible window length');
    const at = finite(r.observed_at, 'observation');
    const age = now - at;
    if (age < 0 || at < r.resets_at - length * HOUR || r.resets_at <= now)
      throw evidenceError('seam_unknown_meter_age', 'unknown meter age');
    const rounding = finite(evidence.roundingPoints?.[id], 'rounding bound', 100);
    const bound = evidence.lagBounds?.[id];
    if (!bound || typeof bound.provenance !== 'string' || !bound.provenance.trim())
      throw evidenceError('seam_unknown_account_wide_lag_bound', 'unknown account-wide lag bound');
    const providerLagMs = finite(bound.providerLagMs, 'provider lag bound');
    const totalDelay = age + providerLagMs;
    const maxPointsPerHour = finite(bound.maxPointsPerHour, 'account-wide rate');
    const lag = maxPointsPerHour * totalDelay / HOUR;
    let borrowerUpper = 0, representedLower = 0;
    for (const e of evidence.entries) {
      if (e.account !== account || e.window_id !== id) continue;
      finite(e.started_at, 'ledger start'); finite(e.ended_at, 'ledger end');
      if (e.started_at > e.ended_at || e.ended_at > now) throw evidenceError('seam_unknown_ledger_interval', 'unknown ledger interval');
      if (!Number.isFinite(e.resets_at)) {
        if (e.ended_at > r.resets_at - length * HOUR) throw evidenceError('seam_ambiguous_ledger_reset', 'ambiguous ledger reset');
        continue;
      }
      if (e.resets_at !== r.resets_at) continue;
      const upper = finite(e.lent_pts, 'borrower spend');
      const lower = finite(e.lent_lower_pts ?? (e.attribution === 'exact' ? upper : 0), 'borrower lower', upper);
      borrowerUpper += upper;
      if (e.represented_at !== null && e.represented_at !== undefined) {
        finite(e.represented_at, 'represented time');
        if (e.represented_at < e.ended_at) throw evidenceError('seam_invalid_represented_time', 'invalid represented time');
        if (e.represented_at <= at) representedLower += lower;
      }
    }
    if (Math.abs(finite(r.lent_pct, 'ledger total') - borrowerUpper) > 1e-6)
      throw evidenceError('seam_inconsistent_ledger_snapshot', 'inconsistent ledger snapshot');
    if (representedLower > r.used_pct + rounding) throw evidenceError('seam_ledger_exceeds_meter', 'ledger exceeds meter');
    const inflight = micro(w.committedMicro, 'inflight') / MICRO +
      finite(r.reserved_pct, 'ledger reservations');
    const used_lo = Math.max(0, r.used_pct - rounding - borrowerUpper);
    const used_hi = Math.min(100, Math.max(0, r.used_pct + rounding - representedLower) + lag);
    mapped.push({id, length_h:length, reset_h:r.resets_at / HOUR,
      total_lo:Math.max(0, r.used_pct - rounding),
      total_hi:Math.min(100, r.used_pct + rounding + lag),
      borrower_settled_hi:borrowerUpper, borrower_represented_lo:representedLower,
      owner_lo:used_lo, owner_hi:used_hi,
      // R2 envelope: only a measured rate may raise the allowance above the setting's share. An estimated,
      // inferred or unclassified rate leaves the key out, so the rule keeps its conservative cap.
      ...(bound.maxPointsPerHourEvidenceClass === 'measured'
        ? {owner_envelope_hi:Math.min(100, used_hi + maxPointsPerHour * (r.resets_at - now) / HOUR)} : {}),
      ...(finiteRecentRate(bound.recentMeterRate) ? {recentMeterRate:bound.recentMeterRate} : {}),
      used_lo, used_hi, borrower_used:borrowerUpper, inflight_gross:inflight,
      reading_age_h:age / HOUR, provider_lag_bound_h:providerLagMs / HOUR});
    const registryRow = registryState.rows.find(row => row.id === id);
    const definition = evidence.quotaRegistry.limits.find(row => row.id === id);
    if (definition.unit !== 'quota_percent' || definition.capacity !== 100)
      throw evidenceError('rule_seam_quota_unit_unsupported', 'unsupported rule seam quota unit');
    // This adapter's downstream accounting uses percent points. Native registry
    // charges must agree with its independently supplied gross conversion.
    if (registryRow.reset.kind === 'rolling') throw evidenceError('rule_seam_rolling_unsupported', 'rolling quota unsupported by rule seam');
    // A native-window job has no measured conversion, so it has no gross in points. The rule then judges availability with a
    // zero-size job, and its allowance becomes the reservation in window points; the live meter guard holds the job to it.
    if (w.pointsPerUsdMicro === null && w.conversion === 'native_window') {
      if (registryRow.nativeWindow !== true) throw evidenceError('quota_registry_charge_mismatch', 'incompatible registry charge');
      gross[id] = 0; continue;
    }
    if (registryRow.nativeWindow === true) throw evidenceError('seam_unknown_conversion', 'unknown conversion');
    const k = micro(w.pointsPerUsdMicro, 'conversion');
    if (k === 0) throw evidenceError('seam_unknown_conversion', 'unknown conversion');
    const points = (BigInt(grossUsd) * BigInt(k) + BigInt(MICRO - 1)) / BigInt(MICRO);
    if (points > BigInt(Number.MAX_SAFE_INTEGER)) throw evidenceError('seam_unsafe_gross', 'unsafe gross');
    gross[id] = Number(points) / MICRO;
    const registryPoints = registryChargeMicro(job.nativeCostBounds.upper,
      definition.weights.byModel[job.model]);
    if (points !== registryPoints)
      throw evidenceError('quota_registry_charge_mismatch', 'incompatible registry charge');
  }
  const history = evidence.history.filter(row => ids.includes(row.window_id))
    .map(row => mapRuleEpisode(row, now));
  return {contract_version:2, now_h:now / HOUR, dial:ruleDial, windows:mapped, history,
    job:{gross,
      ...(grossUsd > 0 && ids.every(id => windows[id].conversion === 'native_window') ? {costBasis:'native_window'} : {}),
      duration_h:(finite(job.wallMs, 'wall') + finite(job.uncertaintyMs, 'uncertainty') +
      finite(job.stopMs, 'stop')) / HOUR}};
}

/** Validate untrusted rule output and enforce physical fit independently of its yes/no. */
export function evaluateLendingRule(input, decide) {
  try { return evaluateRule(input, decide); } catch (error) { throw annotateFailure(error); }
}
function evaluateRule(input, decide) {
  if (typeof decide !== 'function') throw evidenceError('seam_rule_must_be_a_function', 'rule must be a function');
  const state = buildLendingRuleState(input);
  // Cloning isolates mutations by an injected candidate from admission/accounting evidence.
  const result = decide(structuredClone(state));
  const ids = state.windows.map(w => w.id);
  if (typeof result?.admit !== 'boolean' || !exact(result.lendable, ids) ||
      typeof result.reason !== 'string' || !result.reason.trim() || result.reason.length > 500 ||
      /[\r\n]/.test(result.reason)) throw evidenceError('seam_invalid_rule_decision', 'invalid rule decision');
  const lendableMicro = {}, limitingCodes = new Set();
  for (const w of state.windows) {
    const claimed = finite(result.lendable[w.id], 'rule lendable', 100);
    // Owner upper + ALL borrower spend + reservations is deliberately conservative
    // when meter attribution is incomplete: no double-subtraction of borrowed use.
    const physical = Math.max(0, 100 - w.used_hi - w.borrower_used - w.inflight_gross);
    const ruleCap = Math.floor(claimed * MICRO), physicalCap = Math.floor(physical * MICRO);
    const productCap = Math.max(0, 100 * MICRO - input.windows[w.id].usedMicro -
      (input.windows[w.id].uncertaintyMicro ?? 0) - input.windows[w.id].committedMicro);
    lendableMicro[w.id] = Math.min(ruleCap, physicalCap, productCap);
    if (Math.round(state.job.gross[w.id] * MICRO) > lendableMicro[w.id]) {
      // Keep the accounting formula above unchanged. Ties choose the independent
      // physical cap, then the product cap, then the rule's allowance.
      limitingCodes.add(lendableMicro[w.id] === physicalCap ? 'seam_physical_room'
        : lendableMicro[w.id] === productCap ? 'seam_product_room' : 'seam_rule_allowance');
    }
  }
  const native = ids.every(id => input.windows[id].conversion === 'native_window');
  if (native) for (const id of ids) if (lendableMicro[id] <= 0) limitingCodes.add('seam_native_no_room');
  const fits = native ? ids.every(id => lendableMicro[id] > 0)
    : ids.every(id => Math.round(state.job.gross[id] * MICRO) <= lendableMicro[id]);
  let suppliedCode;
  try { suppliedCode = result.reasonCode; } catch { /* Optional metadata cannot change admission. */ }
  const candidateCode = typeof suppliedCode === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(suppliedCode)
    ? suppliedCode : (result.admit ? 'seam_lend' : 'seam_rule_hold');
  // A cap must never display a candidate's lending sentence on a held decision.
  const reasonCode = fits ? candidateCode : limitingCodes.size === 1 ? [...limitingCodes][0] : 'seam_resource_fit';
  return {state, admitted:result.admit && fits, reason:result.reason.trim(), lendableMicro, reasonCode,
    fit:fits, grossUsdMicro:input.job.requestedUsdMicro,
    reservePointsMicro:Object.fromEntries(ids.map(id => [id, native ? lendableMicro[id] : Math.round(state.job.gross[id] * MICRO)]))};
}

/** Input traces are absolute milliseconds. Missing metadata never becomes an endpoint. */
export function mapRuleEpisode(row, now) {
  const unsupported = [];
  const number = (key, positive = false) => {
    const v = row[key];
    if (!Number.isFinite(v) || v < 0 || (positive && v === 0)) {
      unsupported.push(key); return null;
    }
    return v;
  };
  const start = number('start_at'), reset = number('resets_at'), length = number('length_ms', true);
  const complete = typeof row.complete === 'boolean' ? row.complete : null;
  const censored = typeof row.censored === 'boolean' ? row.censored : null;
  if (complete === null) unsupported.push('complete');
  if (censored === null) unsupported.push('censored');
  if (row.metadata?.excluded_reason === 'account_week_censored') unsupported.push('account_week_censored');
  const source = typeof row.source === 'string' && row.source.trim() ? row.source : null;
  if (source === null) unsupported.push('source');
  const rounding = number('rounding_points');
  if (rounding !== null && rounding > 100) unsupported.push('rounding_points');
  const measurement = typeof row.metadata?.measurement === 'string' && row.metadata.measurement.trim()
    ? row.metadata.measurement : null;
  if (measurement === null) unsupported.push('metadata.measurement');
  if (start !== null && reset !== null && length !== null && reset - start !== length)
    unsupported.push('episode identity');
  if (complete === true && reset !== null && reset > now) unsupported.push('future completion');
  const raw = Array.isArray(row.trace) ? structuredClone(row.trace) : null;
  let trace = null, previousAt = -Infinity, previousUse = -Infinity;
  if (raw && start !== null && reset !== null) {
    trace = [];
    for (const sample of raw) {
      if (!Array.isArray(sample) || sample.length !== 2 || !Number.isFinite(sample[0]) ||
          !Number.isFinite(sample[1]) || sample[0] < start || sample[0] > reset || sample[0] > now ||
          sample[0] < previousAt || sample[1] < previousUse || sample[1] < 0 || sample[1] > 100) {
        unsupported.push('trace'); trace = null; break;
      }
      previousAt = sample[0]; previousUse = sample[1];
      trace.push([(sample[0] - start) / HOUR, sample[1]]);
    }
    if (trace && (trace.length < 2 || trace[0][0] !== 0 || trace[0][1] !== 0 ||
        (complete === true && trace.at(-1)[0] !== length / HOUR))) unsupported.push('trace endpoints');
  } else unsupported.push('trace');
  // Optional, independently lower-bounded owner observations. Require the same
  // observed timestamps, never borrow an endpoint from the upper-valued trace.
  let lowerTrace = null, previousLower = -Infinity;
  const lower = row.owner_lower_trace;
  if (trace && Array.isArray(lower) && lower.length === trace.length && lower.length >= 2 &&
      // Array.from turns a missing slot into undefined, so a sparse array fails here instead of being skipped.
      Array.from(lower).every((sample, i) => {
        if (!Array.isArray(sample) || sample.length !== 2 || sample[0] !== raw[i][0] ||
            !Number.isFinite(sample[1]) || sample[1] < 0 || sample[1] < previousLower ||
            sample[1] > raw[i][1]) return false;
        previousLower = sample[1]; return true;
      }) && lower[0][1] === 0)
    lowerTrace = lower.map(([at, use]) => [(at - start) / HOUR, use]);
  return {window_id:row.window_id, supported:unsupported.length === 0, unsupported,
    ...(lowerTrace ? {owner_lower_trace:lowerTrace} : {}),
    start_h:start === null ? null : start / HOUR, reset_h:reset === null ? null : reset / HOUR,
    length_h:length === null ? null : length / HOUR, complete, open:complete === null ? null : !complete,
    censored, source, rounding_points:rounding, metadata:{measurement}, trace, raw_trace_ms:raw,
    ...(Object.hasOwn(row, 'tail_unobserved_ms') ? {tail_unobserved_h:
      Number.isFinite(row.tail_unobserved_ms) && row.tail_unobserved_ms >= 0
        ? row.tail_unobserved_ms / HOUR : null} : {})};
}
