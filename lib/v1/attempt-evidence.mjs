import {createHash} from 'node:crypto';
import {servedModelEvidence} from './served-model-evidence.mjs';

// M1-QUALIFICATION-BINDINGS §3. This module consumes evidence; it never obtains it.
// lending-meter.mjs rounds each parsed percentage to 0.001 pp, so the two
// endpoints together contribute at most 0.001 pp of nearest-rounding error.
export const PARSER_QUANTIZATION_PP = 0.001;
const HOUR = 3_600_000;
const nat = value => Number.isFinite(value) && value >= 0 ? value : null;
const pct = value => nat(value) !== null && value <= 100 ? value : null;
const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,159}$/.test(value)
  && !/^(sk-|Bearer)/i.test(value) ? value : null;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
const enumOf = (value, values) => values.includes(value) ? value : null;
const list = value => Array.isArray(value) ? value : [];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const provenance = value => {
  const source = enumOf(value?.source, ['provider_contract', 'host_attestation', 'synthetic_fixture', 'versioned_conversion']);
  const evidence_sha256 = hash(value?.evidence_sha256);
  return source && evidence_sha256 ? {source, evidence_sha256} : null;
};
const bound = (value, key) => ({[key]: nat(value?.[key]), provenance: provenance(value?.provenance)});
const known = (value, key) => value[key] !== null && value.provenance !== null;
const reading = value => value && typeof value === 'object' ? {
  window_id: id(value.window_id), window_minutes: nat(value.window_minutes),
  used_pct: pct(value.used_pct), resets_at: nat(value.resets_at),
  observed_at: nat(value.observed_at), received_at: nat(value.received_at),
  epoch: id(value.epoch), instance: id(value.instance),
  source: enumOf(value.source, ['inband', 'probe', 'host', 'import', 'durable_aggregate']),
} : null;

export {servedModelEvidence, observeServedModel, mergeServedModelEvidence} from './served-model-evidence.mjs';

function admissionColumn(value) {
  return {
    requested_usd_micro: nat(value?.requested_usd_micro), gross_reserved_usd_micro: nat(value?.gross_reserved_usd_micro),
    native_budget_usd_micro: nat(value?.native_budget_usd_micro),
    admitted_at: nat(value?.admitted_at), stop_allowance_ms: nat(value?.stop_allowance_ms),
    stop_allowance_provenance: provenance(value?.stop_allowance_provenance),
    conversion_version: id(value?.conversion_version),
    resources: list(value?.resources).map(row => ({window_id: id(row?.window_id), instance: id(row?.instance),
      epoch: id(row?.epoch), resets_at: nat(row?.resets_at), gross_reserved_cap_pp: pct(row?.gross_reserved_cap_pp),
      points_per_usd_micro: nat(row?.points_per_usd_micro), conversion_version: id(row?.conversion_version),
      conversion_provenance: provenance(row?.conversion_provenance)})),
  };
}
function guardColumn(value) {
  const keys = ['input', 'cached_input', 'cache_write', 'output', 'reasoning_output',
    'fresh_input', 'cache_read', 'cache_write_5m', 'cache_write_1h', 'reasoning'];
  return {label: 'ESTIMATE', model: id(value?.model), unit: enumOf(value?.unit, ['claude_usd', 'codex_credits', 'list_usd']),
    catalog_revision: id(value?.catalog_revision), used_units: nat(value?.used_units), cost_usd: nat(value?.cost_usd),
    tokens: Object.fromEntries(keys.filter(key => nat(value?.tokens?.[key]) !== null).map(key => [key, value.tokens[key]]))};
}
function ledgerColumn(entries, attemptId) {
  // Requester charges, estimated burns and reset settlements remain attribution,
  // never an invoice or a provider-precision guarantee. Unknown fields are dropped.
  return list(entries).filter(row => row?.attempt_id === attemptId).map(row => ({
    attempt_id: attemptId, reservation_id: id(row.reservation_id), entry_id: id(row.id),
    ledger_account_key: enumOf(row.account, ['claude', 'codex']), window_id: id(row.window_id), instance: id(row.instance),
    resets_at: nat(row.resets_at), started_at: nat(row.started_at), ended_at: nat(row.ended_at),
    represented_at: nat(row.represented_at), amount_micro: nat(row.amount_micro),
    represented: typeof row.represented === 'boolean' ? row.represented : null,
    lent_pts: nat(row.lent_pts), lent_lower_pts: nat(row.lent_lower_pts), charged_pts: nat(row.charged_pts),
    delta_pct: Number.isFinite(row.delta_pct) ? row.delta_pct : null,
    recovered: typeof row.recovered === 'boolean' ? row.recovered : null,
    attribution: enumOf(row.attribution, ['exact', 'below_resolution', 'overlapped', 'reset_split', 'unknown',
      'unwindowed', 'durable_burn', 'durable_settlement']),
  }));
}

/**
 * Four-column evidence for one attempt. All times are epoch milliseconds;
 * provider readings and caps are percentage POINTS, never 0..1 fractions.
 * bounds is one record per window_id: rounding.upper_pp is the TOTAL additional
 * endpoint error bound (not parser quantization); lag.upper_ms bounds each
 * endpoint's reporting lag; rate.upper_pp_per_hour is account-wide.
 * Provenance is a typed source plus a SHA-256 reference, never free-form text.
 * coverage must attest identity, all concurrent/owner-device activity, and the
 * entire execution plus stop tail. exclusive_attempt additionally proves all
 * movement in the observation interval belongs to this attempt; otherwise only
 * an account upper bound can be used as a conservative job upper bound.
 * Cross-reset aggregates deliberately remain unknown; supply separately bounded
 * per-epoch records rather than summing reset-split ledger estimates.
 */
export function buildAttemptEvidence(input = {}) {
  input ??= {};
  const attemptId = id(input.attempt_id);
  const admission = admissionColumn(input.admission);
  const before = list(input.before).map(reading).filter(Boolean);
  const after = list(input.after).map(reading).filter(Boolean);
  const coverage = {
    identity: enumOf(input.coverage?.identity, ['proven', 'unknown', 'mismatch']) ?? 'unknown',
    account_wide: input.coverage?.account_wide === true,
    attribution: enumOf(input.coverage?.attribution, ['exclusive_attempt', 'account_upper_only']) ?? 'unknown',
    provenance: provenance(input.coverage?.provenance), started_at: nat(input.coverage?.started_at),
    stop_tail_ended_at: nat(input.coverage?.stop_tail_ended_at),
    stop_tail_provenance: provenance(input.coverage?.stop_tail_provenance),
  };
  const funding = {subscription_only: enumOf(input.funding?.subscription_only, ['proven', 'unknown', 'not_proven']) ?? 'unknown',
    evidence_sha256: hash(input.funding?.evidence_sha256)};
  const ids = new Set([...admission.resources.map(row => row.window_id), ...before.map(row => row.window_id), ...after.map(row => row.window_id)].filter(Boolean));
  const records = [...ids].map(windowId => {
    const bs = before.filter(row => row.window_id === windowId), as = after.filter(row => row.window_id === windowId);
    const caps = admission.resources.filter(row => row.window_id === windowId);
    const b = bs.length === 1 ? bs[0] : null, a = as.length === 1 ? as[0] : null, cap = caps.length === 1 ? caps[0] : null;
    const supplied = list(input.bounds).filter(row => row?.window_id === windowId);
    const bounds = supplied.length === 1 ? supplied[0] : null;
    const rounding = bound(bounds?.rounding, 'upper_pp'), lag = bound(bounds?.lag, 'upper_ms'), rate = bound(bounds?.rate, 'upper_pp_per_hour');
    const reasons = [];
    const missing = reason => { if (!reasons.includes(reason)) reasons.push(reason); };
    if (!attemptId) missing('attempt_unknown');
    if (!enumOf(input.provider, ['claude', 'codex'])) missing('provider_unknown');
    if (!b) missing(bs.length ? 'ambiguous_before_reading' : 'missing_before_reading');
    if (!a) missing(as.length ? 'ambiguous_after_reading' : 'missing_after_reading');
    const comparable = b && a && b.used_pct !== null && a.used_pct !== null;
    // Meter readings identify a reset epoch with window_id + exact resets_at.
    // Durable sources may additionally bind epoch/instance; if supplied they
    // must agree, but do not invent those fields for the raw meter contract.
    const sameEpoch = b && a && b.resets_at !== null && b.resets_at === a.resets_at && b.epoch === a.epoch
      && b.instance === a.instance && b.window_minutes > 0 && b.window_minutes === a.window_minutes;
    const delta = comparable ? a.used_pct - b.used_pct : null;
    if (b && a && !sameEpoch) missing('reset_or_epoch_crossing_without_per_epoch_evidence');
    if (b && a && !comparable) missing('invalid_provider_percentage');
    if (sameEpoch && delta !== null && delta < 0) missing('inconsistent_negative_same_epoch_delta');
    if (!known(rounding, 'upper_pp')) missing('provider_rounding_bound_unknown');
    if (!known(lag, 'upper_ms')) missing('provider_lag_bound_unknown');
    const timingValid = b && a && [b.observed_at, a.observed_at, b.received_at, a.received_at].every(value => value !== null)
      && b.observed_at <= a.observed_at && b.received_at >= b.observed_at && a.received_at >= a.observed_at;
    if (!timingValid) missing('observation_or_receipt_time_unknown');
    const brackets = timingValid && coverage.started_at !== null && coverage.stop_tail_ended_at !== null
      && coverage.started_at <= coverage.stop_tail_ended_at && b.observed_at <= coverage.started_at
      && a.observed_at >= coverage.stop_tail_ended_at && coverage.stop_tail_provenance !== null;
    if (!brackets) missing('execution_and_stop_tail_not_bracketed');
    if (sameEpoch && timingValid && (b.observed_at < b.resets_at - b.window_minutes * 60_000 || a.observed_at >= a.resets_at))
      missing('observation_outside_reset_epoch');
    if (coverage.identity !== 'proven' || !coverage.provenance) missing('identity_unknown');
    if (!coverage.account_wide || coverage.attribution === 'unknown' || !coverage.provenance) missing('concurrent_and_owner_device_coverage_unknown');
    const delayMs = timingValid && known(lag, 'upper_ms') ?
      b.received_at - b.observed_at + a.received_at - a.observed_at + 2 * lag.upper_ms : null;
    if (delayMs !== null && delayMs > 0 && !known(rate, 'upper_pp_per_hour')) missing('account_wide_rate_bound_unknown');
    const lagAllowance = delayMs === 0 ? 0 : delayMs !== null && known(rate, 'upper_pp_per_hour') ? delayMs * rate.upper_pp_per_hour / HOUR : null;
    const error = known(rounding, 'upper_pp') && lagAllowance !== null ? PARSER_QUANTIZATION_PP + rounding.upper_pp + lagAllowance : null;
    let upper = reasons.length === 0 && error !== null ? Math.max(0, delta + error) : null;
    let lower = upper === null ? null : Math.max(0, delta - error);
    if (upper !== null && (!Number.isFinite(upper) || !Number.isFinite(lower))) { missing('bound_arithmetic_overflow'); upper = lower = null; }
    const capMatches = cap && sameEpoch && cap.epoch === b.epoch && cap.instance === b.instance && cap.resets_at === b.resets_at;
    const capPp = capMatches ? cap.gross_reserved_cap_pp : null;
    if (capPp === null) missing('same_epoch_gross_cap_unknown');
    if (funding.subscription_only !== 'proven' || !funding.evidence_sha256) missing('subscription_path_unknown');
    const jobLower = lower !== null && coverage.attribution === 'exclusive_attempt' ? lower : null;
    // An upper bound above a cap is NOT witnessed overspend. A violation needs
    // a proven attempt-only lower bound above the cap; overlapping account use
    // can prove safety via its upper bound but cannot prove a job overspent.
    // Unknown funding does not erase a proven resource-cap violation. It still
    // blocks subscription qualification, and actual invoice dollars stay null.
    let classification = 'unknown';
    if (jobLower !== null && capPp !== null && jobLower > capPp) classification = 'violation';
    else if (upper !== null && capPp !== null && upper <= capPp && reasons.length === 0) classification = 'bounded_usage';
    else if (upper !== null && capPp !== null && upper > capPp) missing('cap_not_proven_by_upper_bound');
    return {evidence_kind: b && a ? 'provider_window_delta' : 'unknown', attempt_id: attemptId,
      ledger_account_key: enumOf(input.provider, ['claude', 'codex']),
      account_sha256_16: typeof input.account_sha256_16 === 'string' && /^[a-f0-9]{16}$/.test(input.account_sha256_16) ? input.account_sha256_16 : null,
      window_id: windowId, window_minutes: b?.window_minutes ?? a?.window_minutes ?? null,
      resets_at: sameEpoch ? b.resets_at : null, before_evidence_sha256: b ? digest(b) : null, after_evidence_sha256: a ? digest(a) : null,
      before_observed_at: b?.observed_at ?? null, after_observed_at: a?.observed_at ?? null,
      before_received_at: b?.received_at ?? null, after_received_at: a?.received_at ?? null,
      before_used_pct: b?.used_pct ?? null, after_used_pct: a?.used_pct ?? null, raw_delta_pp: delta,
      parser_quantization_pp: PARSER_QUANTIZATION_PP, provider_rounding_bound_pp: rounding.upper_pp,
      rounding_provenance: rounding.provenance, provider_lag_bound_ms: lag.upper_ms, lag_provenance: lag.provenance,
      account_rate_upper_pp_per_hour: rate.upper_pp_per_hour, rate_provenance: rate.provenance,
      unrepresented_delay_ms: delayMs, unrepresented_lag_allowance_pp: lagAllowance,
      coverage, reset_crossing: b && a ? !sameEpoch : null,
      account_consumption_lower_pp: lower, account_consumption_upper_pp: upper,
      job_consumption_lower_pp: jobLower, job_consumption_upper_pp: upper, gross_cap_pp: capPp,
      subscription_path: funding, actual_usd: null, classification, missing_bound_reasons: reasons};
  });
  const invalidWindow = [...admission.resources, ...before, ...after].some(row => row.window_id === null);
  const classification = records.some(row => row.classification === 'violation') ? 'violation'
    : !invalidWindow && records.length > 0 && records.every(row => row.classification === 'bounded_usage') ? 'bounded_usage' : 'unknown';
  return {schema_version: 1, attempt_id: attemptId, served_model: servedModelEvidence(input.served_model),
    column_1: admission, column_2: guardColumn(input.guard_estimate),
    column_3: {before, after}, column_4: {classification, actual_usd: null,
      missing_bound_reasons: [...new Set([...(records.length ? records.flatMap(row => row.missing_bound_reasons) : ['empty_record']),
        ...(invalidWindow ? ['invalid_window_key'] : [])])],
      records, ledger_snapshot: {version: id(input.ledger_snapshot?.version), revision: nat(input.ledger_snapshot?.revision)},
      ledger_entries: ledgerColumn(input.ledger_entries, attemptId)}};
}

const PROCESS_STATES = ['not_started', 'running', 'unknown', 'cancel_requested', 'cessation_requested', 'ceased'];
/**
 * B7: link an accepted owner Stop to the durable cessation state of the same attempt.
 * An accepted Stop is a request. It is cessation only when the durable state reads ceased and proven.
 * ceased_at is the durable cleanup-proof record time, not a measured process-exit time.
 * Older attempts without that proof time remain unknown; the in-memory Stop is only a fallback.
 */
export function stopCessationEvidence({attempt = null, stop = null} = {}) {
  const processState = enumOf(attempt?.process_state, PROCESS_STATES);
  const observed = attempt ? processState === 'ceased' && attempt.cessation_proven === true : null;
  stop = attempt?.owner_stop ?? stop;
  const requestedAt = nat(stop?.requested_at);
  const ceasedAt = observed === true && attempt.cleanup_proven === true ? nat(attempt.cleanup_proof_persisted_at) : null;
  return {
    accepted_is_cessation: false,
    stop_request: stop ? {event_id: id(stop.event_id), requested_at: requestedAt,
      durable_intent_recorded: stop.durable_intent_recorded === true} : null,
    cessation: {
      observed, process_state: processState,
      cessation_proven: typeof attempt?.cessation_proven === 'boolean' ? attempt.cessation_proven : null,
      cleanup_proven: typeof attempt?.cleanup_proven === 'boolean' ? attempt.cleanup_proven : null,
      hold_closed: typeof attempt?.hold_closed === 'boolean' ? attempt.hold_closed : null,
      requested_at: requestedAt,
      ceased_at: ceasedAt,
      ceased_at_source: ceasedAt !== null ? 'durable_cleanup_proof' : null,
      ceased_at_reason: ceasedAt !== null ? null : observed === true ? 'durable_state_keeps_no_cessation_time' : observed === false ? 'not_ceased' : 'attempt_unknown',
    },
  };
}

/** Project one already-read durable snapshot; no filesystem, callback or mutation. */
export function attemptEvidenceFromState(state, attemptId) {
  const attempt = list(state?.attempts).find(row => row?.id === attemptId);
  if (!attempt) return null;
  const resources = list(attempt.resources);
  return buildAttemptEvidence({attempt_id: attempt.id, provider: attempt.usage_unknown, served_model: attempt.served_model,
    admission: {admitted_at: attempt.created_at, stop_allowance_ms: attempt.stop_ms,
      resources: resources.map(row => ({window_id: row.id, instance: row.instance, epoch: row.epoch, resets_at: row.resets_at,
        gross_reserved_cap_pp: row.initial_micro / 1_000_000, points_per_usd_micro: row.kappa_micro}))},
    // The ledger retains the baseline number but not its original observation or
    // receipt timestamp. Do not replace either with admission time. Its latest
    // aggregate similarly has no receipt time, reporting bound or host tail proof.
    before: resources.map(row => ({window_id: row.id, instance: row.instance, epoch: row.epoch,
      window_minutes: row.duration_ms / 60_000, resets_at: row.resets_at, used_pct: row.baseline_used_micro / 1_000_000,
      source: 'durable_aggregate'})),
    after: resources.map(row => ({window_id: row.id, instance: row.instance, epoch: row.epoch,
      window_minutes: row.duration_ms / 60_000, resets_at: row.resets_at, used_pct: row.aggregate_used_micro / 1_000_000,
      observed_at: row.aggregate_observed_at, source: 'durable_aggregate'})),
    ledger_snapshot: {version: state.version, revision: state.revision},
    ledger_entries: resources.flatMap(row => [
      ...list(row.burns).map(burn => ({attempt_id: attempt.id, id: burn.id, window_id: row.id, instance: row.instance,
        resets_at: row.resets_at, ended_at: burn.at, amount_micro: burn.amount_micro, represented: burn.represented, attribution: 'durable_burn'})),
      {attempt_id: attempt.id, window_id: row.id, instance: row.instance, resets_at: row.resets_at,
        amount_micro: row.settled_micro, attribution: 'durable_settlement'}]),
  });
}
