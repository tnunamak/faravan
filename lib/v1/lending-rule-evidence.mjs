import {seedQuotaRegistry, createQuotaRegistry} from './quota-registry.mjs';
import {buildLendingRuleState, mapRuleEpisode, lendingRuleErrorCode} from './lending-rule-seam.mjs';
import {repricedCommitmentMicro} from './lending-policy.mjs';
import {PROTECTION_POSITIONS} from './lending-objective.mjs';

// Pure boundary: all I/O and attestations belong to the caller. Never invoke a store.
const HOUR = 3_600_000, WEEK = 168 * HOUR, MICRO = 1_000_000;
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = x => typeof x === 'string' && x.trim().length > 0;
const nonnegative = x => Number.isFinite(x) && x >= 0;
const integer = x => Number.isSafeInteger(x) && x >= 0;
const valueFor = (value, id) => record(value) ? value[id] : value;
const fail = code => { throw Object.assign(new TypeError(code), {code}); };
const need = (condition, code) => { if (!condition) fail(code); };

// This is a backward-looking estimate, NOT an account-wide future rate guarantee.
function observedRate(rows, id, now) {
  let rate = null;
  for (const row of rows) {
    if (row?.window_id !== id) continue;
    need(row.censored === false && mapRuleEpisode(row, now).supported,
      'rule_evidence_rate_history_invalid');
    for (let i = 1; i < row.trace.length; i++) {
      const [before, usedBefore] = row.trace[i - 1], [at, used] = row.trace[i];
      // Never clip an interval to the cutoff or manufacture a reset baseline.
      if (before < now - WEEK || at > now || at <= before) continue;
      rate = Math.max(rate ?? 0, (used - usedBefore) * HOUR / (at - before));
    }
  }
  need(rate !== null && nonnegative(rate), 'rule_evidence_rate_history_missing');
  return rate;
}

/**
 * Return {ruleEvidence, ruleDial, diagnostics} or {refuse}. Inputs are detached,
 * same-boundary snapshots. providerLagMs/maxPointsPerHour may be scalars or
 * exact resource maps; provenance strings are mandatory caller attestations.
 * maxPointsPerHourEvidenceClass ('measured' or anything else, scalar or map) says whether the rate is a
 * measured bound; only 'measured' lets the seam raise the allowance above the setting's share.
 * rateHistory defaults to history (ownerTraces); neither is read from a store.
 * A complete account-specific registry is required: the seed is vocabulary only.
 */
export function buildRuleEvidence(options = {}) {
  try {
    need(record(options), 'rule_evidence_options_missing');
    const {evidence, entries, history, quotaRegistry, registryProvenance,
      providerLagMs, providerLagProvenance, maxPointsPerHour, rateProvenance, maxPointsPerHourEvidenceClass,
      roundingPoints, roundingProvenance, position, job} = options;
    need(record(evidence) && record(evidence.input) && record(evidence.state),
      'rule_evidence_boundary_missing');
    const {now, request, input, state} = evidence;
    need(nonnegative(now), 'rule_evidence_now_missing');
    need(record(request) && ['claude', 'codex'].includes(request.provider) && text(request.model),
      'rule_evidence_request_identity_missing');
    need(text(input.account) && state.account === input.account, 'rule_evidence_account_mismatch');
    need(Object.hasOwn(PROTECTION_POSITIONS, position), 'rule_evidence_position_missing');
    need(Array.isArray(input.windows) && input.windows.length > 0, 'rule_evidence_windows_missing');
    need(Array.isArray(state.attempts), 'rule_evidence_attempts_missing');
    need(Array.isArray(entries), 'rule_evidence_entries_missing');
    need(Array.isArray(history), 'rule_evidence_history_missing');
    const rateHistory = options.rateHistory ?? history;
    need(Array.isArray(rateHistory), 'rule_evidence_rate_history_missing');
    need(record(quotaRegistry) && quotaRegistry.complete === true && text(registryProvenance),
      'rule_evidence_registry_unattested');
    const registry = createQuotaRegistry(quotaRegistry);
    // Validate known names against the seed, but NEVER promote an observed subset
    // into a complete registry or invent reset mechanics/model weights.
    const seed = seedQuotaRegistry({codexWindowMinutes: input.windows
      .filter(() => request.provider === 'codex').map(w => w.duration_ms / 60000)});
    const snapshot = options.ledgerSnapshot ?? evidence.observation;
    need(record(snapshot) && snapshot.account === input.account && Array.isArray(snapshot.windows),
      'rule_evidence_snapshot_missing');
    need(text(providerLagProvenance), 'rule_evidence_provider_lag_provenance_missing');
    need(text(rateProvenance), 'rule_evidence_rate_provenance_missing');
    need(text(roundingProvenance), 'rule_evidence_rounding_provenance_missing');
    need(record(job) && integer(job.requestedUsdMicro) && record(job.nativeCostBounds),
      'rule_evidence_native_cost_missing');
    need(integer(request.requested_usd_micro) && job.requestedUsdMicro === request.requested_usd_micro,
      'rule_evidence_gross_mismatch');
    const windows = {}, lagBounds = {}, rounding = {}, historicalMax = {};
    for (const w of input.windows) {
      need(text(w?.id) && !Object.hasOwn(windows, w.id), 'rule_evidence_window_identity');
      need(seed.limits.some(l => l.id === w.id && l.provider === request.provider),
        'rule_evidence_window_vocabulary_unknown');
      need(text(w.instance) && text(w.epoch) && w.account === input.account,
        'rule_evidence_window_scope');
      let committed = 0;
      for (const attempt of state.attempts) {
        need(Array.isArray(attempt?.resources), 'rule_evidence_attempt_resources_missing');
        for (const resource of attempt.resources) {
          if (resource.id !== w.id || resource.instance !== w.instance || resource.epoch !== w.epoch) continue;
          need(integer(resource.held_micro) && integer(resource.unrepresented_micro),
            'rule_evidence_commitments_unknown');
          committed += repricedCommitmentMicro(resource,w.conversion === 'native_window' ? null : w.kappa_micro);
          need(integer(committed), 'rule_evidence_commitments_unknown');
        }
      }
      const native = w.conversion === 'native_window';
      need(integer(w.used_micro) && (native ? w.kappa_micro === null : integer(w.kappa_micro) && w.kappa_micro > 0) &&
        integer(w.duration_ms) && w.duration_ms > 0 && nonnegative(w.resets_at) &&
        nonnegative(w.anchor_at) && w.resets_at - w.anchor_at === w.duration_ms,
        'rule_evidence_window_fields_missing');
      const providerLag = valueFor(providerLagMs, w.id), rate = valueFor(maxPointsPerHour, w.id);
      const providerRounding = valueFor(roundingPoints, w.id);
      need(nonnegative(providerLag), 'rule_evidence_provider_lag_unknown');
      need(nonnegative(rate), 'rule_evidence_rate_bound_unknown');
      // 0.001 pp is output quantization. Per endpoint nearest-rounding error is
      // 0.0005 pp; a provider's separate error must be supplied, never assumed 0.
      need(nonnegative(providerRounding) && providerRounding + .0005 <= 100,
        'rule_evidence_provider_rounding_unknown');
      historicalMax[w.id] = observedRate(rateHistory, w.id, now);
      need(rate >= historicalMax[w.id], 'rule_evidence_rate_bound_below_history');
      lagBounds[w.id] = {providerLagMs: providerLag, maxPointsPerHour: rate,
        maxPointsPerHourEvidenceClass: valueFor(maxPointsPerHourEvidenceClass, w.id),
        provenance: `Provider lag: ${providerLagProvenance}; account-wide future rate: ${rateProvenance}`};
      rounding[w.id] = providerRounding + .0005;
      windows[w.id] = {kind:w.kind, known:true, fresh:true, compatible:true,
        usedMicro:w.used_micro, committedMicro:committed, pointsPerUsdMicro:native ? null : w.kappa_micro,
        ...(native ? {conversion:'native_window'} : {}),
        resetAtMs:w.resets_at, anchorAtMs:w.anchor_at, durationMs:w.duration_ms};
    }
    for (const row of history) need(record(row) && mapRuleEpisode(row, now).supported,
      'rule_evidence_history_invalid');
    const ids = Object.keys(windows);
    const ruleEvidence = {quotaRegistry:registry,
      snapshot:structuredClone(snapshot), entries:structuredClone(entries), history:structuredClone(history),
      applicableResources:{account:input.account, provider:request.provider, model:request.model, complete:true, ids},
      roundingPoints:rounding, lagBounds};
    const ruleDial = PROTECTION_POSITIONS[position].epsilon;
    // Use the seam's actual validator, not a second approximation of its contract.
    buildLendingRuleState({now, account:input.account, windows, ruleEvidence, ruleDial,
      job:{...job, provider:request.provider, model:request.model,
        wallMs:request.wall_ms, stopMs:request.stop_ms, uncertaintyMs:request.uncertainty_ms}});
    return {ruleEvidence, ruleDial, windows, diagnostics:{historicalMaxPointsPerHour:historicalMax,
      historicalRateIsFutureBound:false, registryProvenance, roundingProvenance,
      parserQuantizationPoints:.001, parserEndpointErrorPoints:.0005}};
  } catch (error) {
    return {refuse:lendingRuleErrorCode(error)};
  }
}
