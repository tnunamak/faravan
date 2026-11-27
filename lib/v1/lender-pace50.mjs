import {MEASURED_POSTING_LAG_MS} from './lending-rule-defaults.mjs';
import {PROVIDER_PERCENT_UNCERTAINTY_MICRO, RESET_JITTER_MS} from './quota-registry.mjs';
import {NATIVE_SETTLEMENT_DELAY_MS, skippedPeriods, lateCarryBound, mayHaveSpentPast, settlementEligibility, durableCessationBound,
  coldWindowAccountWeekProven, coldWindowResetOmissionProven, coldWindowResetProven} from './lending-policy.mjs';
import {readingAgeReserve, readingHeadroomMs} from './lending-reading-age.mjs';
// The lender's only allocator is the durable objective candidate. It talks only
// to the durable adapter and the trusted source. It never calls the legacy ledger. A test counts legacy calls on
// the candidate path, so any legacy call here is a failure, not a silent double count.
import {savePriceSnapshot, readPriceSnapshot, prunePriceSnapshots, pinPriceSnapshot} from './lending-price-store.mjs';
import {createPace50Adapter} from './lending-pace50-adapter.mjs';
import {mergeServedModelEvidence, observeServedModel} from './attempt-evidence.mjs';
import {paceInputFromObservation, observationProofFailures, sanitizeProbeFailure} from './lending-pace50-source.mjs';
import {admissionRefreshClass, isDeferredObservation} from './lending-probe.mjs';
import {MAX_METER_AGE_MS} from './lending-rule-seam.mjs';
import {createNativeGuard} from './lending-native-guard.mjs';
import {lentCalibrationSamples} from './lending-kappa-lent.mjs';
import {DEFAULT_OWNER_MAX_JOB_USD} from './owner-settings.mjs';
import {LINES, REASON_LINE, budgetLimitCopy, claudeModelName, fundingHoldCopy} from './lending-status-copy.mjs';
import {weightsFor} from './lending-manager.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';
import {claudeCallHeadroomUsd, DEFAULT_RUN_MODEL, normalizeGuardUsage, emptyTokens, jobUsage, meterJob, parseClaudeStream, priceCodexCredits, priceListUsd,
  priceRowFor, pricedModelIds, publicBudgetReceipt, currentPriceCatalog, effectivePriceCatalog, withPriceCatalog} from './lending-meter.mjs';
import {contextPriceTiers} from './litellm-prices.mjs';

const MICRO = 1000000;
const SWEEP_BACKOFF_MS = [30_000, 120_000, 300_000];
// Stop and meter uncertainty come from the trusted observation, not from a
// volume-based chunk ceiling.
// A micro-unit count rounded up. The 6-place rounding keeps binary float noise from adding a micro-unit to an exact value.
const microCeil = (usd) => Math.ceil(Number((usd * MICRO).toFixed(6)));
// The backend inventory has this long to answer a cessation check. Past it the answer is unknown, which is not proof.
const RECONCILE_MS = 20000;
// One provider read may serve the gate and reserve of a single admission. It is short enough to stay inside the policy freshness window.
export const ADMISSION_READING_MS = 30000;
// Provider usage can lag execution. Date the settling reading from the durable cleanup proof, including after restart.
export {NATIVE_SETTLEMENT_DELAY_MS};

// Preserve named evidence failures across the route boundary. They are actionable holds, not one catch-all quota state.
export const SEAM_UNKNOWN = new Set(['account_busy', 'probe_deferred', 'refresh_failed', 'identity_unknown', 'identity_mismatch', 'account_week_mapping_unknown', 'epoch_unknown',
  'resources_incomplete', 'funding_unknown', 'executor_unknown', 'stop_bound_unknown', 'conversion_unknown', 'history_unknown',
  'queue_unknown', 'owner_scenarios_unknown', 'friend_value_unknown', 'objective_evidence_unknown', 'owner_settings_unreadable',
  'strategy_config_unknown', 'demand_model_unavailable', 'demand_model_coupling_unknown', 'demand_model_invalid',
  'demand_model_exact_usage_required']);
const RESERVE = new Set(['no_useful_quote', 'budget_too_small', 'request_too_large', 'strategy_limit', 'resource_reset_margin', 'cross_window_exposure_unreconciled',
  'attempt_in_flight', 'cross_epoch_rate_unknown', 'job_epoch_incompatible', 'owner_reserve', 'owner_harm', 'defer',
  'no_value', 'chunk_value_unknown', 'exceeds_spare', 'reset', 'usage_unknown']);

export function reserveRecheckNeeded(nextEvaluationAtMs, offerDeadline, now) {
  return Number.isSafeInteger(nextEvaluationAtMs) && Number.isSafeInteger(offerDeadline) &&
    offerDeadline > now && (nextEvaluationAtMs <= now || nextEvaluationAtMs >= offerDeadline);
}

// Deadlines belong to this accepted observation, never a cache TTL.
function presentCapacityWait(projection, observation, accountKey) {
  if (projection.admitted !== false || projection.reason !== 'owner_reserve') return projection;
  const validDeadline = value => Number.isSafeInteger(value) && value > 0 && value <= 8.64e15;
  const choices = [];
  if (observation?.refresh_succeeded === true && observation.complete === true) {
    const probe = sanitizeProbeFailure(observation.probe);
    if (validDeadline(probe?.retry_at)) choices.push({at:probe.retry_at, source:'probe_retry_at'});
    for (const resource of observation.resources ?? [])
      if (resource.state === 'open' && validDeadline(resource.resets_at))
        choices.push({at:resource.resets_at, source:'window_reset'});
  }
  choices.sort((a,b) => a.at-b.at);
  const next = choices[0];
  return {...projection, wait:{accountKey, reason:'owner_reserve',
    strategyId:projection.objective?.strategyId ?? null,
    nextEvaluationAtMs:next?.at ?? null, source:next?.source ?? 'unknown'}};
}

// Clock samples are values so production and reducer tests use the same durable reset event.
export function windowResetSettlementEvent({attempt, resourceIds, at, clockAt, updatedAt, reading}) {
  const cold=attempt.resources.some(r=>resourceIds.includes(r.id)&&r.cold_open===true);
  return {type:'window_reset_settled',event_id:`${attempt.id}:reset:${resourceIds.join('+')}`,
    at:Math.max(at,clockAt,updatedAt??0),attempt_id:attempt.id,resource_ids:resourceIds,
    authoritative_cessation:true,...(cold?{reading}:{})};
}

// True when a live guard reading shows a reserved window risen from its admission baseline by at least the job's
// reservation. The rise counts all use of the account, so the owner's own use can end a lent job early, never late.
// A reading of a later window instance (a reset time more than a minute later) counts from zero: all its use is new.
export function liveReservationSpent(resources, windows) {
  if (!Array.isArray(resources) || !Array.isArray(windows)) return false;
  const second = value => { const ms = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(ms) ? Math.floor(ms / 1000) : null; };
  return resources.some(r => {
    const live = windows.find(w => w?.window_id === r?.id);
    if (!live || !Number.isFinite(live.used_pct) || !Number.isSafeInteger(r.baseline_used_micro) ||
        !Number.isSafeInteger(r.initial_micro)) return false;
    const liveReset = second(live.resets_at), reservedReset = second(r.resets_at);
    const baseline = liveReset !== null && reservedReset !== null && liveReset - reservedReset > 60 ? 0 : r.baseline_used_micro;
    return Math.ceil(live.used_pct * 1_000_000) - baseline >= r.initial_micro;
  });
}

export function declineCodeFor(reason) {
  if (SEAM_UNKNOWN.has(reason) || reason === 'account_ledger_unisolated') return reason;
  if (RESERVE.has(reason)) return 'quota_reserve';
  if (reason === 'owner_present') return 'user_active';
  if (reason === 'stopped' || reason === 'paused' || reason === 'adapter_frozen') return 'paused';
  if (reason === 'deadline') return 'job_expired';
  if (reason === 'controls' || reason === 'arm_failed' || reason === 'launch_not_authorized') return 'readiness_changed';
  if (reason === 'model_not_lendable') return 'model_not_lendable';
  if (reason === 'quota_unknown' || reason === 'quota_reserve') return reason;
  if (reason === 'model_unpriced') return 'model_not_lendable';
  if (reason === 'invalid_request' || reason === 'job_unknown') return 'invalid_request';
  if (['gate_closed', 'revision_conflict', 'observation_order', 'schedule_action_unsafe'].includes(reason)) return 'readiness_changed';
  if (['native_attempt_in_flight', 'window_not_open'].includes(reason)) return reason;
  if (['reading_stale', 'reading_unknown', 'resource_unknown', 'window_timing_unknown'].includes(reason)) return 'quota_unknown';
  if (['evidence_unknown', 'native_budget_unknown', 'objective_evidence_invalid', 'protection_source_inconsistent'].includes(reason)) return 'objective_evidence_unknown';
  if (['resource_roster_unknown', 'resource_identity', 'weekly_resource_mapping'].includes(reason)) return 'resources_incomplete';
  if (reason === 'account_week_identity') return 'account_week_mapping_unknown';
  if (reason === 'window_origin_unknown') return 'unreadable_window_origin';
  if (reason === 'cross_reset_conversion_mismatch') return 'conversion_unknown';
  if (reason === 'meter_coverage_required') return 'meter_unavailable';
  if (reason === 'aggregate_observation_regressed') return 'observation_changed';
  return 'internal_error';
}

// These candidate refusals come from the durable objective or its evidence seam. A rule can still be reviewed by a person
// in ask mode; accepting the card runs the same durable reserve check again before any execution starts.
export function isObjectiveReviewHold(reason) {
  return ['quota_unknown','quota_reserve','native_attempt_in_flight','window_not_open'].includes(reason) || SEAM_UNKNOWN.has(reason);
}

// Per-attempt handles. Effects from the adapter reach the lender's running job only through this registry.
export function createCandidateRegistry() {
  const entries = new Map();
  const entry = (attemptId) => {
    if (!entries.has(attemptId)) entries.set(attemptId, {authorized: false, stop: null, cancelled: null,
      cleanupRemoved: null, cleanupPersistence: null});
    return entries.get(attemptId);
  };
  return {
    entry,
    peek: (attemptId) => entries.get(attemptId) ?? null,
    bind(attemptId, {stop}) {
      entry(attemptId).stop = stop;
    },
    unbind(attemptId) {
      entry(attemptId).stop = null;
    },
    cancelled: (attemptId) => entry(attemptId).cancelled,
    // A running job stops now. Work not yet started is marked, so the lender declines before it starts.
    request(attemptId, reason) {
      const handle = entry(attemptId);
      if (handle.stop) return handle.stop(reason);
      else handle.cancelled ??= reason;
    },
  };
}

// Convert the objective's native USD ceiling to Codex credits using the
// conservative minimum credits-per-dollar ratio across token classes.
function codexCreditsForUsd(model, usd, catalog) {
  const ratios = [];
  const row = priceRowFor(model, catalog)?.[1];
  if (!row) return null;
  const prompts = [0, ...contextPriceTiers(row).map(tier => tier.threshold + 1)];
  for (const prompt of prompts) for (const key of ['fresh_input', 'cache_read', 'output']) {
    const tokens = {...emptyTokens(), [key]: 1_000_000};
    const credits = priceCodexCredits(model, tokens, {catalog});
    const dollars = priceListUsd(model, tokens, {catalog, calls: [{...tokens, prompt}]});
    if (!credits.priced || !dollars.priced || dollars.usd <= 0) return null;
    ratios.push(credits.credits / dollars.usd);
  }
  return usd * Math.min(...ratios);
}

// The guard enforces the native budget in the provider's own metered unit.
export function lendingBudgetFor({provider, model, limit, catalog}) {
  if (provider === 'claude') return priceRowFor(model, catalog) ? {agent: 'claude', budget: {unit: 'claude_usd', limit}} : null;
  const weights = weightsFor(model, catalog);
  const credits = weights ? codexCreditsForUsd(model, limit, catalog) : null;
  return credits === null ? null : {agent: 'codex', budget: {unit: 'codex_credits', limit: credits, weights}};
}

// The priced Claude models this computer can bound with a native call budget.
const lendableCatalogs = new WeakMap();
export function lendableModelsFor(provider, {ownerCapUsd = null} = {}) {
  if (provider !== 'claude') return null;
  const catalog = currentPriceCatalog();
  let models = lendableCatalogs.get(catalog);
  if (!models) {
    models = pricedModelIds().filter(model => model.startsWith('claude-'))
      .map(model => [model, claudeCallHeadroomUsd(model)])
      .filter(([, headroom]) => Number.isFinite(headroom));
    lendableCatalogs.set(catalog, models);
  }
  return models.filter(([, headroom]) => !Number.isFinite(ownerCapUsd) || headroom < ownerCapUsd)
    .map(([model]) => model);
}

// A saved job cap must cover one full worst-case call before the objective can issue any provider budget. The UI edits cents, so
// report the first cent value strictly above the engine's micro-dollar worst-call bound. This is derived from the same price row and
// reachable prompt/output limits that admission uses; unpriced models have no usable minimum.
export function minimumMaxJobUsdForModel(model) {
  const headroomUsd = claudeCallHeadroomUsd(model);
  if (!Number.isFinite(headroomUsd) || headroomUsd < 0) return null;
  const worstCallMicroUsd = Math.ceil(headroomUsd * MICRO);
  return (Math.floor(worstCallMicroUsd / (MICRO / 100)) + 1) / 100;
}

// Defaults used when the owner has saved no run model.
export {DEFAULT_RUN_MODEL};

// Keep the base default when it covers a call; otherwise keep that work budget
// above the catalog's call allowance. Round in micro-dollars before adding dollars.
export function defaultOwnerMaxJobUsdForModel(provider, model = null) {
  const headroom = provider === 'claude' ? claudeCallHeadroomUsd(model ?? DEFAULT_RUN_MODEL.claude) : 0;
  return Number.isFinite(headroom) && headroom >= DEFAULT_OWNER_MAX_JOB_USD
    ? (Math.ceil(headroom * MICRO) + DEFAULT_OWNER_MAX_JOB_USD * MICRO) / MICRO : DEFAULT_OWNER_MAX_JOB_USD;
}

export function borrowerBudgetWarning(job) {
  if (!job?.requirements?.harness?.includes('claude-code-subscription')) return null;
  const models = job.requirements.model?.any_of;
  // Multiple allowed models can have different minimums. Name a model only when the job chose one.
  if (!Array.isArray(models) || models.length !== 1) return null;
  const model = models[0], minimumUsd = minimumMaxJobUsdForModel(model), limitUsd = job.budget_v1?.max_list_usd;
  return Number.isFinite(limitUsd) && Number.isFinite(minimumUsd) && limitUsd < minimumUsd
    ? budgetLimitCopy({source:'borrower', model, minimumUsd, limitUsd}, {borrower:true}).line : null;
}

export function ownerModelLimitSummary(ownerCapUsd) {
  if (!Number.isFinite(ownerCapUsd)) return null;
  const minimum = minimumMaxJobUsdForModel(DEFAULT_RUN_MODEL.claude);
  if (!Number.isFinite(minimum) || ownerCapUsd >= minimum) return null;
  const models = lendableModelsFor('claude', {ownerCapUsd});
  const names = [...new Set(models.map(claudeModelName))];
  return `At $${ownerCapUsd.toFixed(2)} ${names.length === 1 ? 'only ' : ''}${names.join(', ') || 'no Claude'} jobs fit. ${claudeModelName(DEFAULT_RUN_MODEL.claude)} jobs need at least $${minimum.toFixed(2)}.`;
}

function observationFallbackModel(provider, model) {
  if (provider !== 'claude' || model) return model;
  return (lendableModelsFor(provider) ?? []).reduce((best, candidateModel) => {
    const candidateMinimum = minimumMaxJobUsdForModel(candidateModel);
    const bestMinimum = best === null ? Infinity : minimumMaxJobUsdForModel(best);
    return Number.isFinite(candidateMinimum) && candidateMinimum < bestMinimum ? candidateModel : best;
  }, null);
}

// Cessation for an attempt. A bound job stops now. An unbound attempt (for example, one left by a crash) is checked against
// the backend inventory through the lender's durable pending record. An unknown inventory is not proof.
export function attemptCessation({registry, backend = null, pendingRecords = () => []}) {
  return async (attemptId, reason) => {
    await registry.request(attemptId, reason);
    const handle = registry.entry(attemptId);
    if (handle.stop || typeof backend?.reconcilePending !== 'function') return;
    const pending = pendingRecords().find((record) => record.attemptId === attemptId);
    if (!pending) return;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), RECONCILE_MS);
    let proof = null;
    try {
      proof = await new Promise((resolve, reject) => {
        controller.signal.addEventListener('abort', () => resolve(null), {once: true});
        backend.reconcilePending(structuredClone(pending), {signal: controller.signal}).then(resolve, reject);
      });
    } catch {
      proof = null;
    } finally {
      clearTimeout(deadline);
    }
    handle.cleanupRemoved ||= proof?.removed === true && proof.attemptId === attemptId;
  };
}

export function candidateEffects({registry, now, backend = null, pendingRecords = () => []}) {
  const cessation = attemptCessation({registry, backend, pendingRecords});
  return {
    arm_cessation_deadline: async (effect) => {
      const timer = setTimeout(() => registry.request(effect.attempt_id, 'cessation_deadline'),
        Math.max(0, effect.deadline_at - effect.stop_bound_ms - effect.uncertainty_ms - now()));
      timer.unref?.();
      return () => clearTimeout(timer);
    },
    launch_chunk: async (effect) => {
      registry.entry(effect.attempt_id).authorized = true;
    },
    open_short_window: async () => {
      throw new Error('quiet opening is not offered to the lender candidate');
    },
    cancel_pending_attempt: async (effect) => {
      await cessation(effect.attempt_id, 'cancelled');
    },
    request_cessation: async (effect) => {
      await cessation(effect.attempt_id, effect.reason ?? 'cessation');
    },
    request_fresh_complete_reconciliation: async (effect) => {
      registry.entry(effect.attempt_id).reconcileRequested = true;
    },
  };
}

// The signed borrower request supplies its own spend ceiling. The owner's cap is
// a separate trusted setting. Neither one selects the objective's chunk size.
export function jobRequest({attemptId, jobId, job, provider = 'claude', model = null, effort, plan = null,
  ownerLimitUsd = null, stopMs, uncertaintyMs = 0}) {
  const wallSeconds = job?.requirements?.limits?.wall_seconds;
  const expires = Date.parse(job?.expires_at ?? '');
  const requestedUsdMicro = Number.isFinite(job?.budget_v1?.max_list_usd) && job.budget_v1.max_list_usd >= 0
    ? microCeil(job.budget_v1.max_list_usd) : null;
  const ownerMaxJobUsdMicro = Number.isFinite(ownerLimitUsd) && ownerLimitUsd >= 0 ? microCeil(ownerLimitUsd) : null;
  return {
    attempt_id: attemptId, job_id: jobId, provider, model, plan,
    ...(effort === undefined ? {} : {effort}),
    circle: typeof job?.payload?.circle === 'string' ? job.payload.circle : typeof job?.circle === 'string' ? job.circle : null,
    requested_usd_micro: requestedUsdMicro, owner_max_job_usd_micro: ownerMaxJobUsdMicro,
    wall_ms: Number.isFinite(wallSeconds) && wallSeconds > 0 ? Math.ceil(wallSeconds * 1000) : 0,
    stop_ms: Number.isSafeInteger(stopMs) && stopMs >= 0 ? stopMs : 0,
    uncertainty_ms: Number.isSafeInteger(uncertaintyMs) && uncertaintyMs >= 0 ? uncertaintyMs : 0,
    expires_at: Number.isFinite(expires) ? expires : null, resumable: true,
  };
}

// Age matters only when plausible unseen spend could consume the remaining headroom.
export const currentFor = (observation, at) => observation?.resources?.length > 0 &&
  observation.resources.every(r => Number.isFinite(r?.observed_at) && r.observed_at <= at &&
    r.used_micro + (r.uncertainty_micro ?? 0) + readingAgeReserve(r, at) < 100 * MICRO);

// The durable policy still prices headroom and checks every resource binding.
export function usableAdmissionEvidence(observation, request, at, baseline = null, {headroom = true} = {}) {
  const attempt = observation?.latest_attempt;
  const failures = observationProofFailures(observation ?? {});
  if (failures.length) return failures[0];
  if (Number.isFinite(observation?.stop?.proven_until) && at >= observation.stop.proven_until) return 'stop_bound_unknown';
  const refreshClass = admissionRefreshClass(attempt);
  // Retained, already-normalized facts use the same age reserve whether the
  // rate is measured or the unchanged default estimate. Failed refresh metadata
  // remains intact; invalidation is still an independent admission veto.
  if (attempt?.invalidated || refreshClass === 'invalidating') return 'refresh_failed';
  if (headroom && !currentFor(observation, at)) return 'budget_too_small';
  if (baseline && (baseline.identity?.account_id !== observation.identity?.account_id ||
      baseline.epoch !== observation.epoch || baseline.account_week_id !== observation.account_week_id ||
      baseline.account_plan?.plan !== observation.account_plan?.plan)) return 'job_epoch_incompatible';
  const span = (request?.wall_ms ?? 0) + (request?.stop_ms ?? observation.stop_bound_ms) +
    (request?.uncertainty_ms ?? observation.uncertainty_ms);
  if (observation.resources.some(r => at + span >= r.resets_at)) return 'resource_reset_margin';
  return null;
}

// The source's latest-attempt facts for the provider's first account. Another account's key is passed as a third argument, whole.
const evidenceFor = (source, observation, {provider, accountKey}) => accountKey && accountKey !== provider
  ? source?.admissionEvidence?.(observation, provider, accountKey) : source?.admissionEvidence?.(observation, provider);

// Product freshness setting for quota accounting, independent of the admission research.
const ACCOUNTING_READING_MAX_AGE_MS = 60_000;
// A cold probe took 20 to 36 s on the test hosts. The lender's claim lease is 120 s, renewed every 30 s (lender.mjs).
export const PENDING_READING_WAIT_MS = 60_000;
// A reading the probe may act on: complete, successful, with a known epoch and within the product age limit.
export const freshReading = (observed, at) => observed?.complete === true && observed.refresh_succeeded === true &&
  typeof observed.epoch === 'string' && Number.isSafeInteger(observed.observed_at) && observed.observed_at <= at &&
  at - observed.observed_at <= ACCOUNTING_READING_MAX_AGE_MS ? observed : null;

// The adapter observes trusted facts, then asks a trusted evidence provider for
// history, owner demand, queue load, and useful chunk values. Missing evidence holds.
export function candidateBuildInput({source, windowOrigins = null, lendingInstances = () => [], lentAttemptLive = () => true,
  coldBindings = () => [], checkingAttempt = () => null, objectiveInputFor = null, history = null, clock = null}) {
  return async ({state, request, now: startedAt, context, snapshotOnly = false}) => {
    // Judging a job needs a reading the rule accepts as current; a status check may use the saved one.
    const forStatus = snapshotOnly && request?.status_snapshot === true && request?.objective_status === true;
    const args = {provider: context?.provider, ...(context?.accountKey ? {accountKey: context.accountKey} : {}), model: forStatus ? request.status_evidence_model : request?.model,
      plan: request?.plan, now: startedAt,
      ...(request?.job_id ? {admissionOnly:true} : {})};
    // A status snapshot must never fall through to observing, even if the cache expires here.
    const localOnly = snapshotOnly || request?.status_snapshot === true;
    const observed = localOnly ? source.observeSnapshot?.(args, {forStatus}) : await source.observe(args);
    // The evidence time is read after observing, so the age the rule judges includes the time the observation took. A probe
    // stamps its readings when the usage answer arrives, which can be after `startedAt`.
    const judgedAt = () => (typeof clock === 'function' ? Math.max(startedAt, clock()) : startedAt);
    const now = judgedAt();
    if (localOnly && observed == null) return {refuse: 'objective_evidence_unknown'};
    // A pure offer preview cannot record newly observed window origins or mutate cached evidence.
    const observation = withHeldColdScope(snapshotOnly ? structuredClone(observed)
      : withWindowOrigins(observed, {windowOrigins, lendingInstances, lentAttemptLive, coldBindings, checkingAttempt, now}), state, now);
    const input = paceInputFromObservation(observation, {now, context: context ?? {}});
    if (input.refuse) return input;
    const evidenceFailure = usableAdmissionEvidence(observation, request, now, null, {headroom:false});
    if (evidenceFailure) return {refuse:evidenceFailure};
    // Provider identity was verified against the enrolled provider account above. Durable candidate history is
    // device-scoped, so a provider account hash never becomes a durable state or ledger key.
    input.weekly_account_id = observation.identity.account_id;
    input.account = state.account;
    input.windows = input.windows.map(window => ({...window, account: state.account}));
    const builder = objectiveInputFor ?? source?.objectiveInputFor;
    if (typeof builder !== 'function') return {refuse: 'objective_evidence_unknown'};
    const providerHistory = typeof history === 'function'
      ? history(context?.accountKey ?? context?.provider, {snapshotOnly}) : history ?? source?.history;
    const weeklyScores = new Map();
    for (const resource of input.windows) {
      if (weeklyScores.has(resource.id)) continue;
      let rows = null;
      try { rows = await providerHistory?.weeklyScores?.(resource.id); } catch { /* pace is the fixed fallback */ }
      weeklyScores.set(resource.id, rows instanceof Map ? (snapshotOnly ? structuredClone(rows) : rows) : new Map());
    }
    const band = jointHistoryBand({weeklyScores, input, provider: context?.provider, plan: request?.plan});
    const builtObjective = await builder({state, request, now, context: context ?? {}, observation, input,
      history: providerHistory, weeklyScores, band, snapshotOnly});
    const objective = snapshotOnly ? structuredClone(builtObjective) : builtObjective;
    if (!objective || typeof objective !== 'object') return {refuse: 'objective_evidence_unknown'};
    if (typeof objective.refuse === 'string') return {refuse: objective.refuse};
    objective.position ??= context?.protectionPosition;
    objective.strategy ??= context?.strategy;
    objective.strategyParams ??= context?.strategyParams;
    objective.job ??= {};
    objective.job = {...objective.job, model: request?.model ?? DEFAULT_RUN_MODEL[context?.provider],
      statusProjection:request?.objective_status === true,
      minimumMaxJobUsd: context?.provider === 'claude' ? minimumMaxJobUsdForModel(request?.model ?? DEFAULT_RUN_MODEL.claude) : null,
      requestedUsdMicro: request?.requested_usd_micro ?? objective.job.requestedUsdMicro ?? null,
      wallMs: request?.wall_ms, stopMs: request?.stop_ms ?? input.stop_bound_ms,
      uncertaintyMs: request?.uncertainty_ms ?? input.uncertainty_ms};
    objective.ownerMaxJobUsdMicro = request?.owner_max_job_usd_micro ?? null;
    if (!Array.isArray(objective.band?.weeks)) objective.band = band;
    const finalObservation = evidenceFor(source, observation, context) ?? observation;
    const failure = usableAdmissionEvidence(finalObservation, request, judgedAt());
    if (failure && failure !== 'budget_too_small') return {refuse:failure};
    return {...input, objective, admission_headroom_failure:failure};
  };
}

// The frozen no-process-model score is a joint maximum of each resource's observed owner upper-use
// fraction. A scale of 100 quota points maps that fraction to the physical 100-point window. Missing or
// censored resource-weeks remain +Infinity in the complete joint domain.
function jointHistoryBand({weeklyScores, input, provider, plan}) {
  const resources = input.windows;
  const domain = resources.map(resource => `${resource.id}@decision`);
  const epochs = [...new Set(resources.flatMap(resource => [...weeklyScores.get(resource.id).keys()]))]
    .filter(Number.isFinite).sort((a, b) => a - b);
  const epochId = `m1-whole-week-owner-usage-v1/${provider}/${plan}`;
  const procedure = 'joint-max-utilization/zero-forecast/scale-100-v1';
  const weeks = epochs.map(end => {
    const upperScores = {};
    let complete = true;
    for (const resource of resources) {
      const row = weeklyScores.get(resource.id).get(end);
      const score = row?.score;
      const finite = row?.complete === true && Number.isFinite(score) && score >= 0 && score <= 100;
      complete &&= finite;
      upperScores[`${resource.id}@decision`] = finite ? score / 100 : Infinity;
    }
    return {id: `provider-week:${end}`, end, epoch: epochId, procedure, complete, upperScores};
  });
  const weekly = resources.find(resource => resource.kind === 'weekly');
  return {weekStart: weekly.anchor_at, epoch: epochId, procedure, domain, weeks,
    forecasts: resources.map(resource => ({id: resource.id, domain: `${resource.id}@decision`, prediction: 0, scale: 100}))};
}

// Each reading of a not-open window gives it a new bound (lending-pace50-source coldOpenWindows), so the scope a cold
// reservation held is never offered again while the window stays shut. A settled job keeps one meter step of blind use on
// that scope until a later rise covers it, and the policy refuses every job while held use sits on a scope it cannot see
// (cross_window_exposure_unreconciled). That held lending for up to five hours after each job. A window that still shows as
// not open has not opened since that reservation, so it is the same window: the reading takes the held scope with the
// earliest reset. The earlier reset is the conservative bound, and the held use then counts against this window's headroom.
export function withHeldColdScope(observation, state, now) {
  if (!Array.isArray(observation?.resources) || !Array.isArray(state?.attempts)) return observation;
  const held = state.attempts.flatMap((a) => a.resources).filter((r) => r.cold_open === true && r.resets_at > now &&
    r.epoch === observation.epoch && (r.held_micro > 0 || r.unrepresented_micro > 0));
  if (held.length === 0) return observation;
  return {...observation, resources: observation.resources.map((r) => {
    if (r.cold_open !== true) return r;
    const scope = held.filter((h) => h.id === r.id && h.resets_at <= r.resets_at).sort((a, b) => a.resets_at - b.resets_at)[0];
    return scope ? {...r, instance: scope.instance, anchor_at: scope.anchor_at, resets_at: scope.resets_at} : r;
  })};
}

// `coldBindings` lists the windows a cold reservation was bound to ({window_id, resets_at, attempt_id, live}). Each is recorded
// with an unknown origin: the lent job or the owner may have used it first. While its job runs, the window is labelled `bound`
// in that job's own admission check (`checkingAttempt`) only; the label is never recorded and never admits another job.
export function withWindowOrigins(observation, {windowOrigins, lendingInstances = () => [], lentAttemptLive = () => true,
  coldBindings = () => [], checkingAttempt = () => null, now}) {
  if (!windowOrigins || observation?.refresh_succeeded !== true || !Array.isArray(observation.resources)) return observation;
  // A cold window is not open at the provider yet: its reset is a bound, not an instance anyone saw, so it is not recorded.
  const windows = observation.resources.map((r) => ({window_id: r.id, window_minutes: r.duration_ms / 60000, resets_at: r.resets_at,
    state: r.cold_open === true ? 'not_open' : r.state}));
  const bindings = coldBindings(), checking = checkingAttempt();
  windowOrigins.observeOpen({windows, lendingInstances: lendingInstances(), unknownWindows: bindings, lentAttemptLive: lentAttemptLive(), now});
  const bound = (r) => checking !== null && r.cold_open !== true && bindings.some((b) => b.live && b.attempt_id === checking &&
    b.window_id === r.id && Math.abs(b.resets_at - r.resets_at) <= RESET_JITTER_MS);
  return {...observation, resources: observation.resources.map((r) => ({...r,
    origin: bound(r) ? 'bound' : windowOrigins.originFor(r.instance) ?? r.origin ?? null}))};
}

// Usage units from the existing meter, in list-price USD for both providers: admission and the conversion (κ) are per list USD.
// Codex credits are 25 × list USD on every model both cards price; the credit amount stays in `metered` for receipts.
export function usageUnits({provider, model, execution, effort = null, catalog}) {
  const observation = execution?.lending_meter;
  const parsed = provider === 'claude' ? parseClaudeStream(execution?.stdout ?? '') : null;
  const served_model = observeServedModel({model, effort, observation, parsed});
  // The total is known only when the run ended normally: a Claude stream with a successful terminal result, or a FINAL guard reading. A
  // nonfinal reading, or a stream with no terminal result, is a partial count. Its total is unknown, so the hold stays whole (usage_unknown),
  // and a partial burn is never charged while the balance is released. Within a known total, the stream's own usage wins over the guard.
  // This function reports the metered total. Finish still treats a reported zero as unknown for converted exposure because the job can control
  // the result. Anything short of a final total is unknown here too.
  const streamFinal = Boolean(parsed?.result) && parsed.result.is_error === false;
  const streamed = Boolean(parsed) && (Object.values(parsed.tokens).some((n) => n > 0) || parsed.cost_usd > 0);
  const streamZero = Boolean(parsed) && parsed.cost_usd === 0 && parsed.result?.is_error === false &&
    Object.values(parsed.tokens).every((n) => n === 0);
  const guardFinal = observation?.final === true;
  const guardCounts = Object.values(observation?.tokens ?? {}).some((n) => n > 0) ||
    (Number.isFinite(observation?.cost_usd) && observation.cost_usd > 0);
  const guardZero = guardFinal && observation.cost_usd === 0;
  const useStream = streamFinal && (streamed || streamZero);
  const useGuard = guardFinal && (guardCounts || guardZero);
  if (!useStream && !useGuard) {
    return {metered: {model: observation?.model ?? parsed?.model ?? model ?? null, priced_units: null}, units_micro: null, served_model};
  }
  const usage = jobUsage({provider, stream: useStream ? parsed : null, guardTokens: observation?.tokens});
  const cost_usd = useStream ? (observation?.cost_usd ?? parsed?.cost_usd) : observation?.cost_usd;
  // No historical revision means no historical token price. Authoritative
  // currency can settle without choosing a fallback catalog; tokens cannot.
  if (catalog === null) {
    const known = Number.isFinite(cost_usd) && cost_usd >= 0 &&
      (cost_usd > 0 || !Object.values(usage.tokens).some(n => n > 0));
    return {metered: {model: observation?.model ?? parsed?.model ?? model,
      priced_units: known ? cost_usd : null},
      units_micro: known ? microCeil(cost_usd) : null, served_model};
  }
  // Unknown call boundaries need each token class's maximum effective rate
  // over feasible intervals: a later tier may decrease. Exact calls stay exact.
  const prompt = usage.tokens.fresh_input + usage.tokens.cache_read + usage.tokens.cache_write_5m + usage.tokens.cache_write_1h;
  const pricedModel = observation?.model ?? parsed?.model ?? model;
  const row = priceRowFor(pricedModel, catalog)?.[1];
  const prompts = [0, ...contextPriceTiers(row ?? {}).map(t => t.threshold + 1).filter(n => n <= prompt)];
  const calls = usage.calls ?? Object.entries(usage.tokens).filter(([, n]) => n > 0).map(([key, count]) => {
    const tokens = {...emptyTokens(), [key]: count};
    const worst = prompts.reduce((best, size) => {
      const usd = priceListUsd(pricedModel, tokens, {catalog, calls: [{...tokens, prompt: size}]}).usd;
      return usd > best.usd ? {prompt: size, usd} : best;
    }, {prompt: 0, usd: -Infinity});
    return {...tokens, prompt: worst.prompt};
  });
  const metered = meterJob({provider, model: pricedModel, tokens: usage.tokens, cost_usd, calls, catalog});
  // Unknown units (no provider cost, and no list price for the model) are null, never zero: zero would release the exposure. A measured
  // burn rounds up to the micro-dollar, so a positive cost is never understated and never rounds to zero. The 6-place rounding keeps
  // binary float noise from adding a micro-dollar to an exact value.
  const usd = provider === 'codex' ? metered.list_usd : metered.priced_units;
  const positiveTokens = Object.values(usage.tokens).some(n => n > 0);
  const units_micro = !Number.isFinite(usd) || (usd === 0 && positiveTokens) ? null : usd > 0 ? microCeil(usd) : 0;
  return {metered, units_micro, served_model};
}

// An attempt whose hold is still open: not ceased, or ceased with its hold not yet closed by settlement. A ceased process can
// still hold exposure, so its hold is the thing to check, not its process state.
const holdOpen = (attempt) => attempt.process_state !== 'ceased' || attempt.hold_closed === false;
// A durable native charge acknowledges completion even while its uncertainty remains in admission.
// A release without a charge does not acknowledge a lost settlement response.
const settledNativeRecord = (attempt) => attempt.process_state === 'ceased' &&
  attempt.cleanup_proven === true && attempt.late_ack_unresolved !== true &&
  attempt.resources.every((r) => r.held_micro === 0 && (r.unrepresented_micro === 0 || r.native_release_used_micro !== undefined) && r.spent_micro > 0);
// A native-window attempt: held in window points, settled from the meter, never from a converted burn.
const nativeAttempt = (attempt) => attempt?.resources?.length > 0 && attempt.resources.every((r) => r.conversion === 'native_window');
// The burn the provider meter attributes to a held attempt, one entry per resource, or null when the movement is not the attempt's
// own. Each hold must have moved by at least one whole point, the meter's resolution, and by no more than its hold. Less is not
// evidence of a burn, so it is never counted as zero. The owner must have been absent since before the attempt was admitted, and no
// other attempt may be live on the account. A short window must be one lending opened, so the owner's own use is never charged here.
function attributableBurns({attempt, reading, at, state}) {
  if (state.owner_present !== false || !Number.isSafeInteger(state.owner_absent_since) || state.owner_absent_since > attempt.created_at) return null;
  if (state.attempts.some((a) => a.id !== attempt.id && holdOpen(a))) return null;
  if (state.updated_at !== null && reading.observed_at < state.updated_at) return null;
  if (reading.epoch !== attempt.epoch) return null;
  const byId = new Map(reading.resources.map((r) => [r.id, r]));
  const burns = [];
  for (const ledger of attempt.resources) {
    const seen = byId.get(ledger.id);
    if (!seen || seen.instance !== ledger.instance || seen.anchor_at !== ledger.anchor_at || seen.resets_at !== ledger.resets_at) return null;
    if (reading.observed_at < ledger.anchor_at || at >= ledger.resets_at) return null;
    if (seen.kind === 'short' && seen.origin !== 'lending') return null;
    const movement = seen.used_micro - ledger.baseline_used_micro;
    if (!(movement >= MICRO) || movement > ledger.held_micro) return null;
    burns.push({ledger, amount_micro: movement});
  }
  return burns;
}

// The objective's reason text is the status line for the same hold, so every surface shows the same words. An unnamed code gets the proof line.
function holdText(reason) {
  return LINES[REASON_LINE[reason] ?? 'proof'];
}

// An unknown identity has no account to keep a durable store for, so the candidate refuses every admission and creates
// nothing on disk. The lender and the app still start, and the borrower's jobs are unaffected.
function unavailableCandidate({registry, reason}) {
  // The hold is named before any job arrives, so the status read says why lending waits.
  const projection = {schemaVersion: 1, policyVersion: 'objective/m1', admission: 'held',
    reasonCode: reason, reasonText: holdText(reason), protectionSource: 'unknown'};
  return {adapter: null, candidate: {
    registry,
    adapter: null,
    decisionFor: () => ({admitted: false, reason, objective: projection}),
    lastJobDecisionFor: () => null,
    async projectStatus() { return {admitted: false, reason, objective: projection}; },
    async preview() { return {admitted: false, reason, objective: projection}; },
    async previewAdmission() { return {admitted: false, reason, objective: projection}; },
    async preflight() { return declineCodeFor(reason); },
    async gate() { return declineCodeFor(reason); },
    async reserve() { return {ok: false, reason: declineCodeFor(reason), policyReason: reason}; },
    async ownerStop() { return {applied: false, reason}; },
    async started() { return null; },
    recordCleanup() {},
    async finish() { return {metered: null, cessation: {applied: false, reason}}; },
    async release() { return {applied: false, reason}; },
  }};
}

export function createPace50Candidate({directory, now = Date.now, account, account_week_id: accountWeek, source,
  policy = null, buildInput, effects, effectOverrides = {}, io, backend = null, pendingRecords = () => [], ownerSettings = null,
  statusRunModel,
  presenceOverrides = null, windowOrigins = null, objectiveInputFor = null, contextFor = () => ({}),
  history = null, readOnlyPreview = false, decide, measurementHistory = null, nativeGuard: nativeGuardOptions = {},
  guardReads = null, stopCheck = null, onCalibration = null, pendingReadingWaitMs = PENDING_READING_WAIT_MS, postingLagBoundMs = MEASURED_POSTING_LAG_MS}) {
  const registry = createCandidateRegistry();
  let adapter = null;
  let pendingPriceAdmissions = 0;
  if (typeof account !== 'string' || account.trim() === '') return unavailableCandidate({registry, reason: 'identity_unknown'});
  const observations = new Map(), pendingObservations = new Map(), meterReads = new Set();
  const statusProjections = new WeakMap(), initialReads = new Set();
  const retainedFailureReads = new Map();
  const offerRereads = new Map();
  const admissionScope = new AsyncLocalStorage();
  const loggedObservations = new Map();
  // The saved windows a new reading of the same window instance aligns to: those of attempts with a window not yet reset,
  // the preferred attempt first. Without a readable state there is nothing to align to.
  const durableKnownWindows = (preferredAttemptId = null) => {
    let attempts;
    try { attempts = adapter?.state().attempts ?? []; } catch { return []; }
    const at = now();
    const live = attempts.filter(attempt => attempt.resources.some(resource => resource.resets_at > at - RESET_JITTER_MS));
    const ordered = preferredAttemptId === null ? live.slice().reverse() : [
      ...live.filter(attempt => attempt.id === preferredAttemptId),
      ...live.filter(attempt => attempt.id !== preferredAttemptId).reverse(),
    ];
    return ordered.flatMap(attempt => attempt.resources);
  };
  let failedMeasurementWrites = 0;
  // Capture cannot control lending; expose failed writes for diagnostics.
  const capture = (type, data) => {
    try {return measurementHistory?.record?.(type, data) ?? null;}
    catch {failedMeasurementWrites++; return null;}
  };
  const captureRequest = (classification, startedWall, startedMono) => {
    const scope = admissionScope.getStore();
    if (scope) scope.latestEventId = null;
    return capture('observation_requested', {classification, started_wall_ms: startedWall, started_monotonic_ns: startedMono});
  };
  const captureComplete = (requestId, classification, startedWall, startedMono, observation) => {
    const eventId = capture('observation_completed', {request_event_id: requestId, classification,
      started_wall_ms: startedWall, started_monotonic_ns: startedMono,
      completed_wall_ms: Date.now(), completed_monotonic_ns: process.hrtime.bigint().toString(),
      resources: observation?.resources});
    const scope = admissionScope.getStore();
    if (scope) scope.latestEventId = eventId ?? null;
    return eventId;
  };
  const captureUnsuccessful = (requestId, classification, startedWall, startedMono, reason, probe = null, provider = probe?.provider) => capture(['account_busy', 'probe_deferred'].includes(reason) ? 'observation_deferred' : 'observation_failed', {
    request_event_id: requestId, classification, reason, started_wall_ms: startedWall,
    started_monotonic_ns: startedMono, completed_wall_ms: Date.now(), completed_monotonic_ns: process.hrtime.bigint().toString(),
    probe: sanitizeProbeFailure(probe ?? {reason:reason === 'cancelled' ? 'cancelled'
      : reason === 'empty_result' ? 'probe_unavailable' : 'guest_failed'}, provider),
  });
  const observationHold = observation => isDeferredObservation(observation) ? observation.probe.reason
    : !observation ? 'empty_result'
    : ['cancelled','closed'].includes(observation.latest_attempt?.reason ?? observation.probe?.reason) ? 'cancelled'
      : observation.refresh_outcome === 'deferred' || observation.refresh_succeeded !== true || observation.probe?.failure_class === 'identity_failed' ? 'refresh_failed' : null;
  const observeSource = async (args, classification = 'new_source') => {
    const startedWall = Date.now(), startedMono = process.hrtime.bigint().toString();
    const requestId = captureRequest(classification, startedWall, startedMono);
    try {
      const observation = corrected(source ? await source.observe({...args, ...keyArg({provider: args.provider, accountKey: attemptKey(args)}), knownWindows: durableKnownWindows(args.preferAttemptId ?? args.excludingAttemptId ?? null)}) : null);
      const failure = observationHold(observation);
      if (failure) captureUnsuccessful(requestId, classification, startedWall, startedMono, failure, observation?.probe, args.provider);
      else captureComplete(requestId, classification, startedWall, startedMono, observation);
      return observation;
    } catch (error) {
      captureUnsuccessful(requestId, classification, startedWall, startedMono, 'source_failed', null, args.provider);
      throw error;
    }
  };
  let observationGeneration = 0;
  // Every piece of state below belongs to one account, named by its whole key. The first account of a provider is keyed by the
  // bare provider name, so a call that names no account is that account. Pricing, parsers and priors still follow the provider.
  const subject = ({provider, accountKey}) => accountKey ?? provider;
  // Only another account's key is handed on, whole, beside the provider; the first account's calls are unchanged.
  const keyArg = ({provider, accountKey}) => accountKey && accountKey !== provider ? {accountKey} : {};
  // An attempt's account is bound when it is admitted; a read made for that attempt uses it.
  const handleOf = id => { try { return registry.peek(ownerOf(id)); } catch { return registry.peek(id); } };
  const attemptKey = ({provider, accountKey, preferAttemptId = null, excludingAttemptId = null}) => {
    const id = preferAttemptId ?? excludingAttemptId;
    return accountKey ?? (id == null ? null : handleOf(id)?.accountKey) ?? provider;
  };
  const observationKey = ({provider, accountKey, model, plan}) => [subject({provider, accountKey}) ?? '', model ?? '', plan ?? ''].join('\u0000');
  const snapshotEntry = ({provider, accountKey, model = null, plan = null}, {forStatus = false} = {}) => {
    const at = now(), cached = observations.get(observationKey({provider, accountKey, model, plan}));
    if (!cached || at < cached.at) return null;
    if (at - cached.at <= ADMISSION_READING_MS) return cached;
    // A status estimate can age a complete reading through policy. Offer previews still require a fresh cache entry.
    return forStatus && cached.observation?.complete === true && cached.observation.refresh_succeeded === true ? cached : null;
  };
  const observeSnapshot = args => snapshotEntry(args)?.observation ?? null;
  // The freshest reading for this provider and plan, whatever model it was observed for.
  const latestSnapshot = ({provider, accountKey, plan = null}, options) => {
    let latest = null;
    for (const key of observations.keys()) {
      const [keyAccount, keyModel, keyPlan] = key.split('\u0000');
      if (keyAccount !== (subject({provider, accountKey}) ?? '') || keyPlan !== (plan ?? '')) continue;
      const entry = snapshotEntry({provider, accountKey, model: keyModel || null, plan}, options);
      if (entry && (!latest || entry.at > latest.entry.at)) latest = {model: keyModel || null, entry};
    }
    return latest;
  };
  const refreshObservation = args => {
    const normalized = {...args, model: observationFallbackModel(args.provider, args.model ?? null), forceRefresh: args.forceRefresh ?? true};
    if (!normalized.guardRead) delete normalized.guardRead;
    // A skipped refresh must not resurrect a successful snapshot for later admission.
    observations.delete(observationKey({...normalized, accountKey: attemptKey(normalized)}));
    return admissionObserve(normalized);
  };
  // Joins the probe a held admission requested, or starts one if the saved reading still needs it. The wait is bounded well
  // inside the claim lease, so a slow probe declines as before instead of losing the claim.
  const waitForReading = async ({provider, accountKey, model, plan, excludingAttemptId, read, waitMs = pendingReadingWaitMs}) => {
    let timer = null;
    const bound = new Promise(resolve => { timer = setTimeout(resolve, waitMs); timer.unref?.(); });
    try {
      return await Promise.race([read ?? refreshObservation({provider, ...keyArg({provider, accountKey}), model, plan, now: now(), excludingAttemptId, forceRefresh: false})
        .catch(() => null), bound]);
    } finally { clearTimeout(timer); }
  };
  const cancelledObservation = provider => ({refresh_succeeded: false, complete: false, resources: [],
    identity: {verified: false}, account_week_id: null, epoch: null,
    funding: {subscription_only: 'unknown'}, executor: {single_executor: 'unknown'},
    stop: {bounded_execution: 'unknown'}, stop_bound_ms: null, uncertainty_ms: null,
    probe: sanitizeProbeFailure({reason:'cancelled'}, provider)});
  const abortObservation = (entry, reason) => {
    if (!entry.controller.signal.aborted) entry.controller.abort(reason ?? new DOMException('The quota observation was cancelled.', 'AbortError'));
  };
  const readingAgeOk = (observation, maxAgeMs) => !Number.isFinite(maxAgeMs) ||
    (observation?.resources?.length > 0 && observation.resources.every(r => now() - r.observed_at <= maxAgeMs));
  // A read with `guardRead` is the native guard's own (watchNative): it is never shared with another caller, so a status read
  // cannot take the guard's reading path or hand the guard an account_busy answer. A lifecycle invalidation does not cancel it.
  const admissionObserve = async ({provider, accountKey: named, model = null, plan = null, now: asOf, signal, forceRefresh = false, maxAgeMs = null,
    guardRead = null, excludingAttemptId = null, admissionOnly = false, preferAttemptId = null}) => {
    const startedWall = Date.now(), startedMono = process.hrtime.bigint().toString();
    const accountKey = attemptKey({provider, accountKey: named, preferAttemptId, excludingAttemptId});
    const key = observationKey({provider, accountKey, model, plan});
    const cached = forceRefresh || (admissionOnly && source?.kind === 'real') ? null : snapshotEntry({provider, accountKey, model, plan});
    if (cached && readingAgeOk(cached.observation, maxAgeMs) &&
        (!admissionOnly || source?.kind !== 'real' || cached.observation.refresh_succeeded === true)) {
      const classification = 'cache';
      const prior = loggedObservations.get(key);
      if (!signal?.aborted && prior?.signature === JSON.stringify(cached.observation)) {
        const scope = admissionScope.getStore();
        if (scope) scope.latestEventId = prior.eventId;
        return cached.observation;
      }
      const requestId = captureRequest(classification, startedWall, startedMono);
      if (signal?.aborted) {
        const cancelled = cancelledObservation(provider);
        captureUnsuccessful(requestId, classification, startedWall, startedMono, 'cancelled', null, provider);
        return cancelled;
      }
      const failure = observationHold(cached.observation);
      if (failure) captureUnsuccessful(requestId, classification, startedWall, startedMono, failure, cached.observation?.probe, provider);
      else captureComplete(requestId, classification, startedWall, startedMono, cached.observation);
      return cached.observation;
    }
    if (signal?.aborted) {
      const requestId = captureRequest('no_source', startedWall, startedMono);
      captureUnsuccessful(requestId, 'no_source', startedWall, startedMono, 'cancelled', null, provider);
      return cancelledObservation(provider);
    }
    const shared = !guardRead && !excludingAttemptId && !admissionOnly;
    let entry = shared ? pendingObservations.get(key) : null;
    const classification = entry ? 'shared' : 'new_source';
    let requestId = admissionOnly ? null : captureRequest(classification, startedWall, startedMono);
    if (!entry) {
      const controller = new AbortController(), generation = observationGeneration;
      entry = {controller, promise: null};
      // Keep the shared entry until source cleanup settles. In particular, a timed-out HTTP caller must not
      // let its successor start another provider probe while this one still owns a sandbox.
      entry.promise = Promise.resolve().then(async () => {
        if (controller.signal.aborted) return cancelledObservation(provider);
        const observation = corrected(source ? await source.observe({provider, ...keyArg({provider, accountKey}), model, plan, now: asOf, signal: controller.signal,
          forceRefresh, maxAgeMs, excludingAttemptId, admissionOnly, knownWindows: durableKnownWindows(preferAttemptId ?? excludingAttemptId),
          ...(guardRead ? {guardRead} : {})}) : null);
        if (controller.signal.aborted) return cancelledObservation(provider);
        if (generation !== observationGeneration) return shared ? cancelledObservation(provider) : observation;
        observations.set(key, {at: now(), observation});
        return observation;
      }).finally(() => {
        if (pendingObservations.get(key) === entry) pendingObservations.delete(key);
        meterReads.delete(entry);
      });
      if (shared) pendingObservations.set(key, entry); else meterReads.add(entry);
    }
    const onAbort = () => abortObservation(entry, signal.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, {once: true});
    let deadlineTimer;
    try {
      // Admission must finish even if source cancellation is waiting for sandbox cleanup.
      // Keep the entry registered until that cleanup drains, preventing overlapping probes.
      const bounded = Number.isFinite(maxAgeMs) || excludingAttemptId !== null;
      const observation = await (bounded ? Promise.race([entry.promise, new Promise(resolve => {
        deadlineTimer = setTimeout(() => {
          abortObservation(entry, new DOMException('The allowance check timed out.', 'TimeoutError'));
          resolve(cancelledObservation(provider));
        }, 60_000);
        deadlineTimer.unref?.();
      })]) : entry.promise);
      const result = signal?.aborted || entry.controller.signal.aborted ? cancelledObservation(provider) : observation;
      const signature = JSON.stringify(result), prior = loggedObservations.get(key);
      // Admission rereads local evidence each second. Only changed evidence belongs in
      // the bounded measurement history; decisions retain the original evidence ID.
      if (admissionOnly && prior?.signature === signature) {
        const scope = admissionScope.getStore();
        if (scope) scope.latestEventId = prior.eventId;
        return result;
      }
      requestId ??= captureRequest(classification, startedWall, startedMono);
      const failure = observationHold(result);
      const eventId = failure
        ? captureUnsuccessful(requestId, classification, startedWall, startedMono, failure, result?.probe, provider)
        : captureComplete(requestId, classification, startedWall, startedMono, result);
      loggedObservations.set(key, {signature, eventId});
      return result;
    } catch (error) {
      captureUnsuccessful(requestId, classification, startedWall, startedMono, 'source_failed', null, provider);
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
  const cancelEntries = (entries, reason) => {
    for (const entry of entries) abortObservation(entry, reason);
    return Promise.allSettled(entries.map(entry => entry.promise));
  };
  // Shutdown cancels every observation, the native guard's reads included.
  const cancelObservations = (reason = new DOMException('The app is closing.', 'AbortError')) =>
    cancelEntries([...pendingObservations.values(), ...meterReads], reason);
  const dropSharedReading = () => {
    observationGeneration += 1;
    observations.clear();
    // Invalidated observations remain registered until their underlying work drains.
    void cancelEntries([...pendingObservations.values()], new DOMException('The quota observation was cancelled.', 'AbortError'));
  };
  // The windows this lender opened and confirmed: their origin is lending, whatever the owner's record says.
  const lendingInstances = () => adapter.state().attempts.filter((a) => a.opening?.confirmed === true).map((a) => a.opening.instance);
  // The windows the native guard bound a cold reservation to (a reservation made while the window was not open). Being bound
  // does not prove who opened the window, so its origin is recorded as unknown. The bindings live in this process; after a
  // restart the reserved scope no longer matches and the hold settles in full at the reserved reset.
  const coldBound = new Map(), coldReserved = new Set();
  const coldBindings = () => {
    for (const [key, bound] of coldBound) if (bound.resets_at <= now()) coldBound.delete(key);
    const attempts = adapter.state().attempts;
    return [...coldBound.values()].map((bound) => ({window_id: bound.window_id, resets_at: bound.resets_at, attempt_id: bound.attempt_id,
      live: attempts.some((a) => a.id === bound.attempt_id && a.process_state !== 'ceased')}));
  };
  // While a lent attempt has not ceased, a window it may open (a pending opening, or a run past a reset) must not be inferred.
  const lentAttemptLive = () => adapter.state().attempts.some((a) => a.process_state !== 'ceased');
  // The admission check of a job whose cold window opened late: the job's own request for the rest of its wall time, against
  // the guard's current reading, with its own hold replaced. A refusal, a failure or a missing request stops the job; the
  // reserved reset stays its deadline. The time the job has already run is not asked for again, so the request expiry alone
  // cannot refuse a job that was admitted within it.
  const boundReading = new AsyncLocalStorage();
  const statusReading = new AsyncLocalStorage();
  // The re-check asks whether the rest of a running job fits the window it opened. Its stop bound was proven at launch and
  // the job is already running under it, so the re-check keeps the launch proof: an expiry of the latest one would stop the job.
  const withLaunchStop = (observation, check) => {
    const stop = check?.baseline?.stop;
    if (!observation || stop?.bounded_execution !== 'proven') return observation;
    const {proven_until: _expiry, ...launched} = stop;
    return {...observation, stop: launched, stop_bound_ms: check.baseline.stop_bound_ms};
  };
  const recheckBound = async (attemptId, observation) => {
    const check = registry.entry(attemptId).liveCheck;
    let out = null;
    try {
      const request = check && {...check.request, wall_ms: Math.max(1, check.admittedAt + check.request.wall_ms - now())};
      if (check && observation) {
        for (let pass = 0; pass < 2; pass++) {
          out = await boundReading.run({observation: withLaunchStop(observation, check), attemptId}, () =>
            adapter.preview({request, context: check.context, replacingAttemptId: attemptId}));
          if (out?.reason !== 'refresh_failed' || pass === 1 ||
              evidenceFor(source, observation, check.context)?.latest_attempt?.reason !== 'evidence_superseded') break;
          // Rebuild from the newer saved reading without waiting on the running job's meter.
          observation = await source.observe({provider: check.context.provider, ...keyArg(check.context), model: request.model,
            plan: request.plan, now: now(), admissionOnly: true});
        }
      }
    } catch { out = null; }
    registry.entry(attemptId).boundRecheck = {admitted: out?.admitted === true, reason: out?.reason ?? null};
    if (out?.admitted !== true) guard.stopFor(attemptId, 'window_recheck');
  };
  // Rate surprises are durable account/window facts, including after a process restart.
  const corrected = observation => {
    if (!observation) return observation;
    const rates = adapter.state().rate_feedback?.rates ?? [];
    let changed = false;
    const resources = observation.resources?.map(w => {
      // Historical feedback is a conservative floor, never evidence of a current conversion.
      // In particular, a rejected account/plan/model binding must remain unknown.
      if (!Number.isSafeInteger(w.kappa_micro) || w.kappa_micro <= 0) return w;
      const kappa = Math.max(w.kappa_micro ?? 0, ...rates.filter(r => r.id === w.id && r.instance === w.instance &&
        r.epoch === observation.epoch && r.anchor_at === w.anchor_at && r.resets_at === w.resets_at).map(r => r.kappa_micro));
      if (kappa <= (w.kappa_micro ?? 0)) return w;
      changed = true;
      return {...w, kappa_micro:kappa};
    });
    return changed ? {...observation, resources} : observation;
  };
  const sourceForBuild = {...(source ?? {}), observe:async args => {
    // A bound-window check reads the guard's own current reading: a fresh read would wait on the running job's account.
    const observed = boundReading.getStore()?.observation ?? await admissionObserve(args), fixed = corrected(observed);
    const scope = admissionScope.getStore();
    if (scope && fixed) scope.inputs.push({observation: fixed, eventId: scope.latestEventId});
    return evidenceFor(source, fixed, args) ?? fixed;
  },
    observeSnapshot:(args, {forStatus = false} = {}) => corrected(
      (forStatus ? statusReading.getStore()?.observation : null) ?? observeSnapshot(args))};
  const openAdapter = () => createPace50Adapter({directory, postingLagBoundMs, account, account_week_id: accountWeek,
    buildInput: buildInput ?? candidateBuildInput({source: sourceForBuild, windowOrigins, lendingInstances, lentAttemptLive, coldBindings,
      checkingAttempt: () => boundReading.getStore()?.attemptId ?? null, clock: now,
      objectiveInputFor: objectiveInputFor ?? source?.objectiveInputFor, history}),
    // Overrides replace single effects in tests; the registry-bound launch and arm effects stay real, and the launch sets the admission flag.
    effects: effects ?? {...candidateEffects({registry, now, backend, pendingRecords}), ...effectOverrides},
    now, readOnlyPreview, ...(io ? {io} : {}), decide});
  let currentAdapter = openAdapter(), reopening = null, recoveringAdapter = null, stopping = false;
  let reopenFailures = 0, reopenAt = 0;
  // Keep the public handle stable while the owner replaces the poisoned instance.
  adapter = Object.fromEntries(Object.keys(currentAdapter).map(key => [key, (...args) => currentAdapter[key](...args)]));
  adapter.close = async options => {
    stopping = true;
    const results = await Promise.allSettled([currentAdapter.close(options), recoveringAdapter?.close(options)]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    return results[0].value;
  };
  const reopenPoisoned = () => {
    if (reopening) return reopening;
    try { adapter.state(); return; }
    catch (error) { if (error.code !== 'pace50_store_poisoned') throw error; }
    if (stopping || now() < reopenAt) return;
    reopenAt = now() + SWEEP_BACKOFF_MS[Math.min(reopenFailures++, 2)];
    reopening = (async () => {
      await currentAdapter.close();
      if (stopping) return;
      const replacement = recoveringAdapter = openAdapter();
      try {
        const recovered = await replacement.recover();
        if (recovered.effects.some(effect => effect.status === 'failed')) throw new Error('pace50_recovery_failed');
        if (stopping) { await replacement.close(); return; }
        currentAdapter = replacement;
        return true;
      } catch (error) {
        await replacement.close();
        throw error;
      }
    })().finally(() => { reopening = null; recoveringAdapter = null; });
    return reopening;
  };

  for (const attempt of adapter.state().attempts) {
    const handle = registry.entry(attempt.id);
    handle.cleanupRemoved = attempt.cleanup_proven === true;
    // A started attempt stays started across a restart, so its release is refused until finish or a meter reading settles it.
    handle.started = attempt.launch_state === 'started' || attempt.launch_state === 'ambiguous';
    handle.provider = typeof attempt.usage_unknown === 'string' ? attempt.usage_unknown
      : attempt.resources.every(r=>r.id.startsWith('codex:')) ? 'codex'
      : attempt.resources.some(r=>['seven_day','five_hour'].includes(r.id)) ? 'claude' : null;
  }
  // The live account meter guard of lent jobs. Its timers read the meter without waiting for token events; it stops a job
  // at its point allowance, on a stale or unreadable meter, or on a reset, identity or funding change. A stop is a request.
  // Its stop takes the same path as a cessation effect: a bound job stops through its handle, and an unbound one (after a
  // restart) is removed through the backend's pending record, so a guard stop is never only a mark that nothing reads.
  const nativeCessation = attemptCessation({registry, backend, pendingRecords});
  // The guard reads the meter from the host, with the credential of the attempt's own account (usage-host-reader.mjs). The
  // context names that account and is the only thing that may read while the job holds it. No sandbox is created. If the
  // context cannot be made, the read gets account_busy, so the guard goes stale and stops the job.
  const guardReadFor = watch => {
    try { return guardReads?.({provider: watch.provider, accountKey: handleOf(watch.attemptId)?.accountKey ?? watch.provider}) ?? null; }
    catch { return null; }
  };
  const guard = createNativeGuard({now, ...nativeGuardOptions,
    onBind: (attemptId, resourceId, bound, {reserved_resets_at: reserved, observation}) => {
      coldBound.set(`${attemptId}\u0000${resourceId}`, {...bound, window_id: resourceId, attempt_id: attemptId});
      // The job's first use opened the window, or someone's did, after admission. The policy priced the owner's share of the
      // window to the reserved reset; a window that resets later than that by more than the reset jitter gives the owner more
      // time to use it, so the job runs on only if the same admission passes against that window now.
      if (bound.resets_at - reserved > RESET_JITTER_MS) void recheckBound(attemptId, observation);
    },
    read: watch => refreshObservation({provider: watch.provider, now: now(), admissionOnly:false, guardRead: guardReadFor(watch),
      preferAttemptId: watch.attemptId}),
    stop: (id,reason)=>nativeCessation(id,reason==='allowance_reached'&&
      !nativeAttempt(adapter.state().attempts.find(row=>row.id===id))?'provider_limit':reason)});
  const watchNative = (attempt, {accountId = null, lastFreshAt, cold = [], readingResources = [], restoring = false}) => {
    const provider = registry.entry(attempt.id).provider;
    // A cached baseline must not be stopped immediately by the old one-minute start rule.
    // Preserve the existing live poll cadence when admission already has a fresh reading.
    const freshnessMs = restoring || now() - lastFreshAt <= MAX_METER_AGE_MS ? MAX_METER_AGE_MS : Math.max(1,
      Math.floor(Math.min(...attempt.resources.map(r => readingHeadroomMs(
        readingResources.find(row => row.id === r.id) ?? {used_micro:r.baseline_used_micro, uncertainty_micro:MICRO})))));
    const watch = guard.watch({attemptId: attempt.id, provider, accountId, epoch: attempt.epoch,
      resources: attempt.resources, lastFreshAt, freshnessMs, cold});
    for (const id of cold) coldReserved.add(`${attempt.id}\u0000${id}`);
    return watch;
  };
  // The attempt ended: stop guarding it. A guard read still in flight is cancelled with the observations, and its late
  // answer changes nothing.
  const unwatchNative = attemptId => { guard.unwatch(attemptId); };
  // A restart cannot know whether its jobs read the meter while it was down, so each open one is guarded from its
  // last durable reading: a stale one is asked to stop at once. Its hold stays until cleanup and a reading settle it.
  for (const attempt of adapter.state().attempts)
    if (attempt.process_state !== 'ceased')
      watchNative(attempt, {restoring:true, lastFreshAt: Math.min(...attempt.resources.map(r => r.aggregate_observed_at))});
  const context = (provider, extra = {}, accountKey = provider) => {
    const saved = contextFor(accountKey) ?? {};
    const resolved = {provider, ...keyArg({provider, accountKey}), consent: false, people: true, agents: true, schedule: true,
      unexpired: true, intent: 'on', paused: false, ownerAbsent: false,
      ...extra, ...saved};
    // Manual review is this job's consent. The saved provider consent only decides whether a job may run automatically.
    if (extra.automatic === false) resolved.consent = true;
    // A one-job owner approval is an explicit, short-lived exception to the saved absence state.
    if (extra.ownerPresenceOverride === true) resolved.ownerPresenceOverride = true;
    if (extra.ownerAbsent === true) resolved.ownerAbsent = true;
    return resolved;
  };
  const revision = () => adapter.state().revision;
  const coverFeedback = async observation => {
    const feedback = adapter.state().rate_feedback;
    if (!feedback?.blocked || observation?.identity?.verified !== true ||
        observation?.complete !== true || observation.refresh_succeeded !== true) return;
    const roster = observation.resources.map(r=>r.instance).sort().join(',');
    await adapter.deliver({type:'meter_feedback_covered',event_id:`meter-covered:${roster}:${revision()}:${observation.observed_at}`,
      account:adapter.state().account, at:now(), observed_at:observation.observed_at,
      complete:true, refresh_succeeded:true, resources:observation.resources.map(r=>({...r,epoch:observation.epoch}))});
  };

  const latestDecision = new Map();
  // The owner's saved per-job limit. Unset is the documented runtime default, and with no settings store at all there is no owner cap.
  // An unreadable settings file is no limit at all, so admission holds on it by name, before any reading, builder run or durable record.
  const ownerHoldReason = () => (ownerSettings?.limit().state === 'unreadable' ? 'owner_settings_unreadable' : null);
  const ownerCapUsd = (provider, model) => {
    if (!ownerSettings) return null;
    const saved = ownerSettings.limit().maxJobUsd;
    if (saved !== null) return saved;
    return defaultOwnerMaxJobUsdForModel(provider, model);
  };
  const modelCapDecision = (provider, model, job) => {
    const cap = ownerCapUsd(provider, model), headroom = provider === 'claude' ? claudeCallHeadroomUsd(model) : null;
    if (!Number.isFinite(cap) || !Number.isFinite(headroom) || headroom < cap) return null;
    const requested = job?.budget_v1?.max_list_usd;
    const exposure = Number.isFinite(requested) && requested >= 0 ? Math.min(cap, requested) : cap;
    const budgetLimit = {model:model ?? DEFAULT_RUN_MODEL.claude, minimumUsd:minimumMaxJobUsdForModel(model ?? DEFAULT_RUN_MODEL.claude),
      source:'owner', limitUsd:cap};
    return {admitted: false, reason: 'budget_too_small', objective: {
      schemaVersion: 1, policyVersion: 'objective/m1', admission: 'held', reasonCode: 'budget_too_small',
      budgetLimit, reasonText:budgetLimitCopy(budgetLimit).line,
      protectionSource: 'unknown', maximumExposureUsd: exposure, nativeMaxBudgetUsd: 0,
    }};
  };
  // A positive limit checks catalog enforceability only; the objective still chooses the real limit.
  const modelEnforcementHold = (provider, model) => lendingBudgetFor({provider, model, limit: 1})
    ? null : {admitted: false, reason: 'model_unpriced', objective: null};
  // The conversion this attempt reserved: each resource's own kappa, so a burn is priced at the rate its reservation recorded.
  const reservedResources = (attemptId) => {
    const attempt = adapter.state().attempts.find((a) => a.id === attemptId);
    return attempt ? attempt.resources.map((r) => ({id: r.id, instance: r.instance, kappa_micro: r.kappa_micro})) : null;
  };
  // The objective already subtracts one worst-call headroom from total
  // exposure. Reuse that selected native budget without subtracting again.
  const guardLimitFor = (provider, attemptId) => {
    const native = registry.entry(attemptId).nativeBudgetMicro;
    return Number.isSafeInteger(native) && native > 0 ? native / MICRO : null;
  };

  // The reconciliation helpers below act only on what probeHeld has verified. Each records one fact through the durable adapter.
  const meterResources = (ledgers, reading) => ledgers.map((ledger) => {
    const seen = reading.resources.find((r) => r.id === ledger.id);
    return {id: seen.id, instance: seen.instance, anchor_at: seen.anchor_at, resets_at: seen.resets_at, used_micro: seen.used_micro};
  });
  // Meter movement can add spend, but without interval coverage it remains unresolved. A refused usage records nothing.
  const attribute = async (attempt, reading, burns, maximumAfterCleanup = false) => {
    const usage = await adapter.transition({type: 'usage', event_id: `${attempt.id}:probe-usage`, at: maximumAfterCleanup ? Math.max(now(), adapter.state().updated_at ?? 0) : reading.observed_at,
      attempt_id: attempt.id, burn_id: `${attempt.id}:probe`,
      ...(maximumAfterCleanup ? {maximum_after_cleanup:true} : {}),
      resources: burns.map((b) => ({id: b.ledger.id, instance: b.ledger.instance, amount_micro: b.amount_micro}))}, {expectedRevision: revision()});
    if (usage.applied !== true) return false;
    if (maximumAfterCleanup) return true;
    await adapter.transition({type: 'reconcile_burn', event_id: `${attempt.id}:probe-reconcile`, at: now(), attempt_id: attempt.id,
      burn_id: `${attempt.id}:probe`, account: adapter.state().account, epoch: reading.epoch, complete: true, compatible: true,
      refresh_succeeded: true, attribution_confirmed: true, observed_at: reading.observed_at,
      resources: meterResources(burns.map((b) => b.ledger), reading)}, {expectedRevision: revision()});
  };
  const publishCalibration = async (attemptId,reading,out) => {
    const attempt=adapter.state().attempts.find(a=>a.id===attemptId),handle=registry.entry(attemptId),info=handle.nativeSettle;
    if(out.applied&&attempt?.hold_closed===true&&reading&&info?.usage==='positive'&&typeof onCalibration==='function'){
      const {samples}=lentCalibrationSamples({attempt,reading,usdMicro:info.usdMicro,provider:providerOf(attemptId),model:info.model,
        accountId:handle.native?.accountId??reading.identity?.account_id??null,now:now()});
      if(samples.length)try{await onCalibration(samples);}catch{/* Calibration cannot block settlement. */}
    }
    return out;
  };
  // A window that has reset cannot be measured again for this attempt, so when the sandbox is proven gone the attempt settles in full:
  // every held amount is charged as spent. Otherwise the attempt closes only when every resource's usage is accounted for.
  const settleOrClose = async (attemptId, reading, at, {readMeter = true} = {}) => {
    const current = adapter.state().attempts.find((a) => a.id === attemptId);
    if (!holdOpen(current)) return;
    let settledAt = Math.max(at, now(), adapter.state().updated_at ?? 0);
    const evidence = reading ? {type:'usage_covered',at:settledAt,attempt_id:attemptId,
      account:current.account,account_week_id:reading.account_week_id,epoch:reading.epoch,complete:reading.complete,compatible:reading.identity?.verified===true,
      refresh_succeeded:reading.refresh_succeeded,observed_at:reading.observed_at,resources:reading.resources} : null;
    const decisions = current.resources.map(resource => ({resource,decision:settlementEligibility(current,resource,
      {state:adapter.state(),evidence,at:settledAt,postingLagBoundMs})}));
    const pending=current.pending_late_exposure;
    // A resource is due only at its durable deadline (or on no-use / reset proof); a retained one stays held even after its reset.
    let due = decisions.filter(({resource,decision}) => (resource.held_micro+resource.unrepresented_micro>0 || current.pending_late_exposure) &&
      (['no_use','reset_proven','deadline_reached'].includes(decision.reason) ||
        // A cold window is gated below by its reading-backed reset proof, not by the deadline.
        resource.cold_open === true && !current.pending_late_exposure && current.cleanup_proven === true && settledAt >= resource.resets_at)).map(({resource})=>resource.id);
    // A cold window ends only on a reading that proves its reset, whatever the other evidence says.
    let proofReading = reading, coldBlocked = false;
    const cold = current.resources.filter(r => due.includes(r.id) && r.cold_open === true);
    if (cold.length) {
      const provider = current.usage_unknown ?? providerOf(attemptId);
      if (!proofReading && readMeter && provider !== null) {
        proofReading = await readNativeSettlement(current, provider, settledAt);
        settledAt = Math.max(settledAt, now(), adapter.state().updated_at ?? 0);
      }
      const proven = new Set(cold.filter(r => proofReading && (coldWindowResetProven(current, r, proofReading, settledAt) ||
        coldWindowResetOmissionProven(current, r, proofReading, settledAt))).map(r => r.id));
      coldBlocked = proven.size < cold.length;
      due = due.filter(id => !cold.some(r => r.id === id) || proven.has(id));
    }
    const reset=pending&&due.length<current.resources.length?[]:due;
    if (reset.length){
      const event=windowResetSettlementEvent({attempt:current,resourceIds:reset,at:settledAt,clockAt:now(),
        updatedAt:adapter.state().updated_at,reading:proofReading});
      if(pending)event.event_id=`${attemptId}:pending-deadline:${pending.event_id}`;
      const out=await adapter.transition(event,{expectedRevision:revision()});
      if(out.applied&&reading)return await settleOrClose(attemptId,reading,settledAt,{readMeter})??out;
      return out;
    }
    if (coldBlocked) return {applied:false,reason:'window_reset_unsettled'};
    if (evidence && decisions.some(({decision})=>decision.reason==='usage_covered')){
      const out=await adapter.transition({...evidence,type:'usage_covered',
        event_id:`${attemptId}:coverage:${revision()}`},{expectedRevision:revision()});
      if(out.applied)return publishCalibration(attemptId,reading,out);
      const represented=await adapter.transition({...evidence,type:'usage_represented',
        event_id:`${attemptId}:representation:${revision()}`},{expectedRevision:revision()});
      if(represented.applied)return publishCalibration(attemptId,reading,represented);
    }
    if(!current.pending_late_exposure&&current.resources.every(r=>r.held_micro+r.unrepresented_micro===0)&&
      durableCessationBound(current,{state:adapter.state()})!==null)
      return adapter.transition({type:'cessation_proven',event_id:`${attemptId}:zero:${revision()}`,attempt_id:attemptId,at:settledAt,
        authoritative_cessation:true,usage_reconciled:true},{expectedRevision:revision()});
    return {applied:false,reason:'settlement_retained'};
  };

  // A native-window attempt records meter movement as spend, but keeps its unresolved envelope until measured coverage or reset.
  // Its sandbox must be proven gone, and a reading must come after the settlement delay before it can change the ledger.
  // A window that reset since admission settles in full (window_reset_settled). The settled job's plan-funded cost and meter
  // rise feed online calibration, which gates none.
  // The normal idle source reads cached probe evidence. A stopped run needs a new probe after cleanup, even if nobody
  // opens status. The runtime's held-work sweep retries failures at 30 s, 2 min, then at most once per 5 min until reset.
  const settlementRefresh = new Map();
  // Collection retries do not authorize settlement. The shared decision still validates every refreshed fact.
  const refreshSettlement = (attempt, args, cached, at, accept = () => true) => {
    const prior = settlementRefresh.get(attempt.id);
    if (prior?.pending) return prior.pending;
    if (prior && at < prior.nextAt) return accept(cached) ? cached : null;
    const failures = (prior?.failures ?? 0) + 1;
    const retry = {failures,nextAt:at+SWEEP_BACKOFF_MS[Math.min(failures-1,2)],pending:null};
    settlementRefresh.set(attempt.id,retry);
    retry.pending = refreshObservation({...args,maxAgeMs:60_000}).then(reading => freshReading(reading,now())).then(reading => accept(reading) ? reading : null)
      .catch(() => null).finally(() => {retry.pending=null;});
    return retry.pending;
  };

  // Reading for measured coverage; only a measured posting bound lets it close anything.
  const readSettlement = async (attempt, provider, at) => {
    const args = {provider, now:at, preferAttemptId:attempt.id};
    const cached = freshReading(await observeSource(args).catch(() => null), at);
    const state = adapter.state(), ceased = durableCessationBound(attempt,{state});
    if (cached?.identity?.verified === true && ceased !== null && postingLagBoundMs !== null &&
        cached.observed_at >= ceased + postingLagBoundMs &&
        attempt.resources.every(resource=>cached.resources.some(seen=>seen.id===resource.id))) return cached;
    if (ceased === null || postingLagBoundMs === null || at < ceased + postingLagBoundMs) return cached;
    return refreshSettlement(attempt, args, cached, at);
  };
  // Reading for native spend booking and cold-window reset proof.
  const readNativeSettlement = async (attempt, provider, at) => {
    const args = {provider, now: at, preferAttemptId: attempt.id};
    const hasColdScope = attempt.resources.some(r => r.cold_open === true);
    const coversCleanup = reading => reading?.identity?.verified === true &&
      (hasColdScope ? coldWindowAccountWeekProven(attempt, reading) : reading.account_week_id === attempt.account_week_id) &&
      reading.observed_at >= attempt.cleanup_proof_persisted_at + NATIVE_SETTLEMENT_DELAY_MS &&
      Array.isArray(reading.resources) && attempt.resources.every(r => reading.resources.some(x => x.id === r.id) ||
        r.cold_open === true && reading.observed_at >= r.resets_at &&
        coldWindowResetOmissionProven(attempt, r, reading, at));
    const cached = freshReading(await observeSource(args).catch(() => null), now());
    if (coversCleanup(cached)) return cached;
    return refreshSettlement(attempt, args, cached, at, coversCleanup);
  };
  // Collect exact provider evidence; the shared decision owns measured posting finality and deadlines.
  const settleNative = async (attemptId, provider, {readMeter = true} = {}) => {
    let attempt = adapter.state().attempts.find((a) => a.id === attemptId);
    if (!attempt) return {applied: false, reason: 'attempt_unknown'};
    if (attempt.usage_unknown==='legacy_full_charge') return {applied:true};
    if (!holdOpen(attempt)) return {applied: settledNativeRecord(attempt), reason: 'already_settled'};
    if (attempt.cleanup_proven !== true) return {applied: false, reason: 'cleanup_unverified'};
    const at = Math.max(now(), adapter.state().updated_at ?? 0);
    const reset = await settleOrClose(attemptId, null, at, {readMeter});
    if (reset?.reason === 'window_reset_unsettled') return reset;
    attempt = adapter.state().attempts.find((a) => a.id === attemptId);
    if (!holdOpen(attempt)) return {applied: true, reason: 'window_reset_settled'};
    if (!readMeter && settledNativeRecord(attempt)) return {applied:true, reason:'already_settled'};
    if (provider === null) return {applied: false, reason: 'provider_unknown'};
    if (!readMeter || at < attempt.cleanup_proof_persisted_at + NATIVE_SETTLEMENT_DELAY_MS)
      return {applied: false, reason: 'native_settlement_unread'};
    if (postingLagBoundMs !== null) {
      const covering = await readSettlement(attempt, provider, at);
      if (covering) {
        const out = await settleOrClose(attemptId, covering, at, {readMeter});
        if (out?.applied) return out;
        attempt = adapter.state().attempts.find((a) => a.id === attemptId);
        if (!holdOpen(attempt)) return {applied: true, reason: 'window_reset_settled'};
      }
    }
    const ledgers = attempt.resources.filter(r => !(at >= r.resets_at && r.held_micro === 0 && r.unrepresented_micro === 0));
    const reading = await readNativeSettlement({...attempt, resources: ledgers}, provider, at);
    if (!reading || reading.observed_at < attempt.cleanup_proof_persisted_at + NATIVE_SETTLEMENT_DELAY_MS ||
        !ledgers.every((r) => reading.resources.some((x) => x.id === r.id)))
      return {applied: false, reason: 'native_settlement_unread'};
    // The reading settles its own scope. A window instance other than the held one (an early or corrected short reset with
    // the same weekly epoch) is not use of the held instance: nothing settles and nothing is released. The recorded reset
    // settles the hold in full (window_reset_settled), as for any window that reset under a job.
    // A cold window settles from the instance it opened as, which the guard bound, or from a reading that still shows it not
    // open (below meter resolution). Admission persists cold_open so this also works after restart. Its use is read against
    // the reserved scope, and the reading's whole use counts, the owner's included.
    const visibleRise = ledgers.some(ledger => reading.resources.find(x => x.id === ledger.id)?.used_micro > ledger.aggregate_used_micro);
    const observed = ledgers.map((ledger) => {
      const seen = reading.resources.find((x) => x.id === ledger.id);
      const key = `${attemptId}\u0000${ledger.id}`, bound = coldBound.get(key);
      // A later cold scope may book a visible meter rise as spend, but with no rise it cannot settle or release the saved hold.
      const sameColdScope = seen.instance === ledger.instance || Math.abs(seen.resets_at - ledger.resets_at) <= RESET_JITTER_MS;
      const still = seen.cold_open === true && (ledger.cold_open === true || coldReserved.has(key)) && !bound &&
        (coldReserved.has(key) || sameColdScope || visibleRise);
      return still || bound && seen.cold_open !== true && Math.abs(seen.resets_at - bound.resets_at) <= RESET_JITTER_MS
        ? {...seen, instance: ledger.instance, anchor_at: ledger.anchor_at, resets_at: ledger.resets_at} : seen;
    });
    if (ledgers.some((ledger, i) => observed[i].instance !== ledger.instance || observed[i].anchor_at !== ledger.anchor_at ||
        observed[i].resets_at !== ledger.resets_at))
      return {applied: false, reason: 'native_settlement_scope_changed'};
    // No new charge, coverage or overshoot means no durable change. In particular, a newer
    // timestamp on the same meter value must not grow the event list on every sweep.
    const accounted = ledgers.every(r => r.held_micro === 0 && r.unrepresented_micro === 0);
    const unchanged = !accounted && ledgers.every((ledger, i) => {
      // A prior release or represented burn has no interval coverage and must be restored on the next eligible sweep.
      if (!Number.isSafeInteger(observed[i].uncertainty_micro) ||
          observed[i].uncertainty_micro < (ledger.meter_step_micro ?? PROVIDER_PERCENT_UNCERTAINTY_MICRO) ||
          ledger.native_release_used_micro === undefined || ledger.released_micro > 0 ||
          ledger.burns.some(burn => burn.represented)) return false;
      return observed[i].used_micro === ledger.aggregate_used_micro;
    });
    const canSettle = ledgers.every((r,i)=>r.kind==='weekly'||r.cold_open===true&&observed[i].cold_open===true) &&
      ledgers.some((r,i)=>r.kind==='weekly'&&observed[i].used_micro>r.baseline_used_micro);
    if (unchanged && !canSettle) return {applied:settledNativeRecord(attempt), reason:'native_reading_unchanged'};
    const info = registry.entry(attemptId).nativeSettle ?? null;
    const usage = info?.usage ?? 'unknown';
    const settledAt = Math.max(now(), adapter.state().updated_at ?? 0);
    const out = await adapter.transition({type: 'native_meter_settled', event_id: `${attemptId}:native-settle:${revision()}`, at: settledAt,
      attempt_id: attemptId, account: adapter.state().account, epoch: reading.epoch, complete: true,
      compatible: reading.identity?.verified === true, refresh_succeeded: true, usage, observed_at: reading.observed_at,
      resources: observed.map((r) => ({id: r.id, instance: r.instance, anchor_at: r.anchor_at, resets_at: r.resets_at,
        used_micro: r.used_micro, uncertainty_micro: r.uncertainty_micro, ...(r.cold_open===true?{cold_open:true}:{})}))}, {expectedRevision: revision()});
    if (out.applied === true) settlementRefresh.delete(attemptId);
    if (out.applied === true && adapter.state().attempts.find(a => a.id === attemptId)?.hold_closed === true &&
        usage === 'positive' && typeof onCalibration === 'function') {
      const {samples} = lentCalibrationSamples({attempt, reading: {...reading, resources: observed}, usdMicro: info.usdMicro, provider, model: info.model,
        accountId: registry.entry(attemptId).native?.accountId ?? reading.identity?.account_id ?? null, now: now()});
      if (samples.length) { try { await onCalibration(samples); } catch { /* Calibration is an improvement, never a gate. */ } }
    }
    return out;
  };

  // Aggregate movement can identify usage that appeared, but not whether provider posting for the attempt is complete.
  // The reducer keeps these burns unresolved because current providers expose no interval-coverage proof.
  const reconcilePending = async (attemptId, reading, at) => {
    const attempt = adapter.state().attempts.find((a) => a.id === attemptId);
    const ledgers = attempt.resources.filter(r => !(attempt.cleanup_proven === true &&
      r.resets_at <= reading.observed_at && r.held_micro === 0 && r.unrepresented_micro === 0));
    if (!ledgers.every((r) => reading.resources.some((x) => x.id === r.id))) return;
    const covered = (id) => ledgers.every((r) => r.burns.some((b) => b.id === id && !b.represented && b.at <= reading.observed_at));
    const burnId = ledgers[0]?.burns.map((b) => b.id).find(covered);
    if (burnId === undefined) return;
    await adapter.transition({type: 'reconcile_burn', event_id: `${attemptId}:reconcile-${at}`, at, attempt_id: attemptId,
      burn_id: burnId, account: adapter.state().account, epoch: reading.epoch, complete: true, compatible: true,
      refresh_succeeded: true, attribution_confirmed: true, observed_at: reading.observed_at,
      resources: meterResources(ledgers, reading)}, {expectedRevision: revision()});
  };

  // A carried record is named for the run it came from, so it reads that run's provider and sandbox proof.
  const ownerOf = (id) => {
    const row = adapter.state().attempts.find(a => a.id === id);
    return row?.lineage_parent_id ? ownerOf(row.lineage_parent_id) : id.includes(':carry:') ? id.slice(0, id.indexOf(':carry:')) : id;
  };
  const providerOf = (id) => registry.entry(ownerOf(id)).provider ?? null;
  const cleanupOf = (id) => {
    const attemptId = ownerOf(id);
    const attempt = adapter.state().attempts.find(row => row.id === attemptId);
    const handle = registry.entry(attemptId);
    return attempt?.cleanup_proven === true ||
      (attempt?.cleanup_proven === undefined && handle.cleanupRemoved === true) ||
      (attempt?.cleanup_proven === false && handle.cleanupRemoved === true &&
        handle.cleanupPersistence?.status === 'pending');
  };
  const persistCleanupProof = (attemptId) => {
    const handle = registry.entry(attemptId);
    if (handle.cleanupRemoved !== true) return Promise.resolve({applied: false, reason: 'cleanup_unverified'});
    // A poisoned store may show a proof whose directory write never finished, so the proof is not claimed until a reopen.
    let state;
    try { state = adapter.state(); } catch (error) { return Promise.reject(error); }
    const attempt = state.attempts.find(row => row.id === attemptId);
    if (!attempt) return Promise.reject(new Error('pace50_cleanup_attempt_missing'));
    if (attempt.cleanup_proven === true) {
      if (Number.isSafeInteger(attempt.cleanup_proof_persisted_at)) return Promise.resolve({applied: true, reason: 'already_proven'});
      if (handle.freshCleanupVerified !== true) return Promise.resolve({applied: false, reason: 'cleanup_unverified'});
    }
    // A ceased attempt whose hold is closed has settled. Its cessation is recorded, so a late sandbox proof adds nothing.
    if (attempt.process_state === 'ceased' && attempt.hold_closed !== false) return Promise.resolve({applied: true, reason: 'already_settled'});
    if (handle.cleanupPersistence?.status === 'pending') return handle.cleanupPersistence.promise;
    const persistence = {status: 'pending', promise: null};
    const pending = adapter.deliver({type: 'cleanup_proven', event_id: `${attemptId}:cleanup-proven:${state.revision + 1}`,
      at: Math.max(now(), state.updated_at ?? 0), attempt_id: attemptId, cleanup_removed: true}).then(out => {
      const saved = adapter.state().attempts.find(row => row.id === attemptId);
      const persisted = saved?.cleanup_proven === true && Number.isSafeInteger(saved.cleanup_proof_persisted_at);
      if (out.applied === true || persisted) return out;
      throw new Error(`pace50_cleanup_proof_not_persisted:${out.reason}`);
    });
    persistence.promise = pending;
    handle.cleanupPersistence = persistence;
    pending.then(() => { persistence.status = 'persisted'; }, () => {
      if (handle.cleanupPersistence === persistence) handle.cleanupPersistence = null;
    });
    pending.catch(() => {
      if (handle.cleanupPersistence === persistence) handle.cleanupPersistence = null;
    });
    return pending;
  };
  // A late start carries its maximum exposure into each window that now covers it, and that the run did not start in. The policy
  // checks each carry against the reading, and each carry is settled by its own window's covering reading or reset.
  const carryLate = async (attemptId, reading, at) => {
    const state = adapter.state();
    const attempt = state.attempts.find((a) => a.id === attemptId);
    if (attempt.pending_late_exposure) {
      return adapter.transition({type:'late_exposure_carried',event_id:`${attemptId}:generation:${attempt.pending_late_exposure.event_id}`,
        attempt_id:attemptId,at,observed_at:reading.observed_at,identity_verified:reading.identity?.verified===true,account:reading.identity?.account_id,
        epoch:reading.epoch,account_week_id:reading.account_week_id,complete:reading.complete,refresh_succeeded:reading.refresh_succeeded,
        resources:reading.resources.map(r=>({...r,epoch:reading.epoch}))},{expectedRevision:revision()});
    }
    const carries = [];
    if (attempt.resources.some(r => r.cold_open === true && !coldWindowResetProven(attempt, r, reading, at))) return;
    for (const from of attempt.resources) {
      if (from.held_micro + from.unrepresented_micro === 0 || at < from.resets_at || state.attempts.some((a) => a.id === `${attemptId}:carry:${from.id}:${from.instance}`)) continue;
      if (from.cold_open === true && !coldWindowResetProven(attempt, from, reading, at)) continue;
      const cur = reading.resources.find((x) => x.id === from.id && x.kind === from.kind && x.instance !== from.instance &&
        x.anchor_at <= reading.observed_at && x.resets_at > reading.observed_at && skippedPeriods(from, x)!==null);
      if (cur === undefined) continue;
      carries.push({from_id: from.id, from_instance: from.instance, resource: {id: cur.id, instance: cur.instance, epoch: reading.epoch,
        kind: cur.kind, anchor_at: cur.anchor_at, resets_at: cur.resets_at, duration_ms: cur.duration_ms,
        kappa_micro: cur.kappa_micro, used_micro: cur.used_micro, ...(cur.cold_open === true ? {cold_open:true} : {})}});
    }
    if (carries.length === 0) return;
    const weekly = reading.resources.find(r => r.id === reading.weekly_resource_id && r.kind === 'weekly');
    const weeklyMapping = weekly ? {account: reading.identity?.account_id, account_week_id: reading.account_week_id,
      epoch: reading.epoch, observed_at: reading.observed_at, resource_id: weekly.id, instance: weekly.instance,
      anchor_at: weekly.anchor_at, resets_at: weekly.resets_at} : null;
    await adapter.transition({type: 'late_start_carried', event_id: `${attemptId}:carry-${at}`, at, attempt_id: attemptId,
      observed_at: reading.observed_at, carries, account: reading.identity?.account_id,
      identity_verified: reading.identity?.verified === true, account_week_id: reading.account_week_id,
      epoch: reading.epoch, complete: reading.complete, refresh_succeeded: reading.refresh_succeeded,
      weekly_mapping: weeklyMapping, reading}, {expectedRevision: revision()});
  };

  const makeRequest = ({attemptId, jobId, job, provider, accountKey = provider, model, effort}) => {
    const appContext = contextFor(accountKey) ?? {};
    const stopMs = source?.stop_bound_ms ?? source?.stopBoundMs ?? 0;
    const uncertaintyMs = source?.uncertainty_ms ?? source?.uncertaintyMs ?? 0;
    return jobRequest({attemptId, jobId, job, provider, model, effort, plan: appContext.plan ?? null,
      ownerLimitUsd: ownerCapUsd(provider, model), stopMs, uncertaintyMs});
  };
  const cacheDecision = (provider, out, {recordRefusal = false, accountKey} = {}) => {
    const key = subject({provider, accountKey});
    const previous = latestDecision.get(key);
    const objective = out?.objective ?? {schemaVersion: 1, policyVersion: 'objective/m1', admission: 'held',
      reasonCode: out?.reason ?? 'objective_evidence_unknown', reasonText: fundingHoldCopy(out?.reason, out?.detail)?.line ?? holdText(out?.reason),
      protectionSource: out?.objective?.protectionSource ?? 'unknown'};
    latestDecision.set(key, {...(out?.detail ? {detail:out.detail} : {}), assessedAt: now(), admitted: out?.admitted === true, reason: out?.reason ?? objective.reasonCode, objective,
      ...(sanitizeProbeFailure(out?.probe, provider) ? {probe: sanitizeProbeFailure(out.probe, provider)} : {})});
    const decision = latestDecision.get(key);
    // Gates can refuse before reserve records an admission decision. Keep the exact
    // local reason, once per change, without recording the job or account identity.
    if (recordRefusal && !decision.admitted && (previous?.admitted !== false || previous.reason !== decision.reason)) {
      capture('admission_gate_refused', {outcome: 'held', provider,
        reason: declineCodeFor(decision.reason), policy_reason: decision.reason,
        ...(decision.detail ? {refusal_detail: decision.detail} : {}),
        candidate_revision: out?.revision, policy_version: objective.policyVersion});
    }
    return latestDecision.get(key);
  };
  // One assessment for the real gate and offer-only previews. Only the former updates last-job status.
  const assessOffer = async ({attemptId = null, jobId, job = null, provider, accountKey = provider, model = null, automatic = true,
    ownerAbsent = false, ownerPresenceOverride = false, intentOn = true, paused = false, plan = null} = {},
    {snapshotOnly = false, ...options} = {}) => {
    if (!job) return {admitted: false, reason: 'job_unknown', objective: null};
    const held = ownerHoldReason();
    if (held) {
      if (!snapshotOnly) cacheDecision(provider, {admitted: false, reason: held}, {recordRefusal: true, accountKey});
      return {admitted: false, reason: held, objective: null};
    }
    const modelCapHold = modelCapDecision(provider, model, job);
    if (modelCapHold) {
      if (!snapshotOnly) cacheDecision(provider, modelCapHold, {recordRefusal: true, accountKey});
      return modelCapHold;
    }
    // The real gate historically defers this check until reserve. Offer-only admission includes
    // that same reserve prerequisite without changing the gate's existing decisions.
    if (snapshotOnly) {
      const enforcementHold = modelEnforcementHold(provider, model);
      if (enforcementHold) return enforcementHold;
    }
    const id = attemptId ?? `preview:${jobId ?? job.id ?? 'job'}:${accountKey}:${model ?? 'default'}`;
    const request = makeRequest({attemptId: id, jobId: jobId ?? job.id ?? id, job, provider, accountKey, model});
    if (plan !== null) request.plan = plan;
    const generation = observationGeneration;
    const snapshotArgs = {provider, accountKey, model, plan: request.plan};
    const snapshot = snapshotOnly && !buildInput ? snapshotEntry(snapshotArgs) : null;
    const out = await adapter.preview({request, context: context(provider, {automatic, consent: true,
      ownerAbsent, ownerPresenceOverride, intent: intentOn ? 'on' : 'off', paused}, accountKey), snapshotOnly,
      ...(Object.hasOwn(options, 'readings') ? {readings: options.readings} : {})});
    if (snapshotOnly && !buildInput && (generation !== observationGeneration || snapshotEntry(snapshotArgs) !== snapshot))
      return {admitted: false, reason: 'objective_evidence_unknown', objective: null};
    const observed = snapshotEntry(snapshotArgs)?.observation;
    const detailed = out?.admitted === false && sanitizeProbeFailure(observed?.probe, provider)
      ? {...out, probe:sanitizeProbeFailure(observed.probe, provider)} : out;
    if (!snapshotOnly) cacheDecision(provider, detailed, {recordRefusal: true, accountKey});
    return detailed;
  };
  const candidate = {
    registry,
    adapter,
    observe:async args=>corrected(await admissionObserve(args)),
    async refreshObservation(args) {
      const observed = await refreshObservation(args);
      await coverFeedback(observed);
      return corrected(observed);
    },
    measurementStatus:() => ({failedWrites:failedMeasurementWrites}),
    observeSnapshot:args=>corrected(observeSnapshot(args)),
    cancelObservations,
    // Both take the account key; for the first account of a provider that is the provider name.
    decisionFor(key) { return latestDecision.get(key) ?? {admitted: false, reason: 'objective_evidence_unknown',
      objective: {schemaVersion: 1, policyVersion: 'objective/m1', admission: 'held', reasonCode: 'objective_evidence_unknown',
        reasonText: 'Holding because no job has been assessed with complete trusted evidence.', protectionSource: 'unknown'}}; },
    lastJobDecisionFor(key) { return latestDecision.get(key) ?? null; },
    async projectStatus({provider, accountKey = provider, model = null, plan = null, automatic = false, ownerAbsent = true, snapshotOnly = false} = {}) {
      const held = ownerHoldReason();
      if (held) return {admitted: false, reason: held, objective: null};
      const named = model !== null;
      model = model ?? statusRunModel?.(provider) ?? DEFAULT_RUN_MODEL[provider] ?? null;
      const enforcementHold = provider === 'claude' ? modelEnforcementHold(provider, model) : null;
      if (enforcementHold) return enforcementHold;
      const unknown = () => ({admitted: false, reason: 'objective_evidence_unknown', objective: null});
      let evidenceModel = model;
      const statusLookup = {forStatus:true};
      let snapshot = snapshotOnly ? snapshotEntry({provider, accountKey, model:evidenceModel, plan}, statusLookup) : null;
      // A failed first probe has no conversion to price, but its provider hold is current status.
      if (snapshotOnly && !snapshot && !named && provider === 'claude') {
        const observed = latestSnapshot({provider, accountKey, plan})?.entry.observation;
        if (observed && observationHold(observed) === 'refresh_failed' && !observed.resources?.length) {
          const input = paceInputFromObservation(observed, {now:now()});
          return {admitted:false, reason:input.refuse, objective:null,
            ...(sanitizeProbeFailure(observed.probe, provider) ? {probe:sanitizeProbeFailure(observed.probe, provider)} : {})};
        }
      }
      // Claude conversions are model-specific; Codex keeps its provider snapshot fallback.
      if (snapshotOnly && !snapshot && !named && provider !== 'claude') {
        const latest = latestSnapshot({provider, accountKey, plan}, statusLookup);
        if (latest) {
          evidenceModel = latest.model;
          snapshot = latest.entry;
        }
      }
      const cap = ownerCapUsd(provider, model) ?? DEFAULT_OWNER_MAX_JOB_USD;
      if (!Number.isFinite(cap) || cap <= 0) return {admitted: false, reason: 'budget_too_small', objective: null};
      const generation = observationGeneration;
      // Injected builders have no cache-only contract. Admission still uses them unchanged.
      if (snapshotOnly && (buildInput || !snapshot)) return unknown();
      // API, CLI and MCP describe the same cached revision, including its age allowance.
      const signature = snapshotOnly ? JSON.stringify({revision:revision(), cap, model, plan, automatic, ownerAbsent,
        context:context(provider, {automatic, ownerAbsent, intent:'on', paused:false}, accountKey)}) : null;
      const freshSnapshot = snapshotOnly && now() - snapshot.at <= ADMISSION_READING_MS;
      const cachedProjection = freshSnapshot ? statusProjections.get(snapshot) : null;
      if (cachedProjection?.signature === signature) return presentCapacityWait(
        structuredClone(cachedProjection.projection), snapshot.observation, accountKey);
      const minimum = provider === 'claude' && model ? minimumMaxJobUsdForModel(model) : cap;
      const statusBudget = Number.isFinite(minimum) ? Math.min(cap, minimum) : cap;
      if (statusBudget <= 0) return {admitted: false, reason: 'budget_too_small', objective: null};
      const at = now(), jobId = `lending-status:${accountKey}`;
      const job = {id: jobId, requirements: {limits: {wall_seconds: 300}},
        expires_at: new Date(at + 60 * 60_000).toISOString(), budget_v1: {max_list_usd: statusBudget}};
      const request = makeRequest({attemptId: jobId, jobId, job, provider, accountKey, model});
      request.plan = plan;
      request.objective_status = true;
      if (snapshotOnly) {
        request.status_snapshot = true;
        request.status_evidence_model = evidenceModel;
      }
      // This is a jobless capacity estimate. Ask mode uses manual consent; Auto includes its demand estimate and reserve.
      const out = await statusReading.run(snapshot, () => adapter.preview({request, context: context(provider, {automatic, ownerAbsent,
        intent: 'on', paused: false}, accountKey), snapshotOnly}));
      // Projection may yield; a replaced, expired or invalidated observation is no longer evidence.
      if (snapshotOnly && (generation !== observationGeneration || snapshotEntry({provider, accountKey, model:evidenceModel, plan}, statusLookup) !== snapshot))
        return unknown();
      const projection = {admitted: out?.admitted === true, reason: out?.reason ?? out?.objective?.reasonCode ?? 'objective_evidence_unknown',
        objective: out?.objective ?? null, ...(out?.detail ? {detail:out.detail} : {}),
        ...(sanitizeProbeFailure(snapshot?.observation?.probe)
          ? {probe: sanitizeProbeFailure(snapshot.observation.probe)} : {})};
      if (freshSnapshot) statusProjections.set(snapshot, {signature, projection:structuredClone(projection)});
      return presentCapacityWait(projection, snapshot?.observation ??
        observeSnapshot({provider, accountKey, model:evidenceModel, plan}), accountKey);
    },
    preview: assessOffer,
    async previewAdmission(args = {}, options = {}) {
      // Startup capability, never an offer option. The installer must verify that every supplied
      // builder/history/settings/override callback is read-only for snapshotOnly calls before opting in.
      // Production callbacks outside this module have no implicit purity promise.
      if (readOnlyPreview !== true) return {admitted: false, reason: 'objective_evidence_unknown', objective: null};
      const {provider, jobId = null, ownerAbsent = false} = args;
      const override = !ownerAbsent && jobId && presenceOverrides
        ? presenceOverrides.available({jobId, now: now()}).granted : false;
      return assessOffer({...args, provider, ownerAbsent: ownerAbsent || override,
        ownerPresenceOverride: override}, {...options, snapshotOnly: true});
    },
    async preflight({provider, accountKey = provider, automatic = true, ownerAbsent = false, jobId = null} = {}) {
      const held = ownerHoldReason();
      if (held) {
        cacheDecision(provider, {admitted: false, reason: held}, {recordRefusal: true, accountKey});
        return declineCodeFor(held);
      }
      const observed = withWindowOrigins(await admissionObserve({provider, accountKey, model: null, plan: contextFor(accountKey)?.plan, now: now(), admissionOnly:true}),
        {windowOrigins, lendingInstances, lentAttemptLive, coldBindings, now: now()});
      // The proof failure is read first: it carries the detail that names the failed check.
      const proof = paceInputFromObservation(observed, {now: now(), context: context(provider, {consent: true, ownerAbsent}, accountKey)});
      const failure = proof.refuse ? null : usableAdmissionEvidence(observed, null, now());
      const input = failure ? {refuse:failure} : proof;
      if (input.refuse) {
        cacheDecision(provider, {admitted: false, reason: input.refuse, ...(input.detail ? {detail:input.detail} : {}),
          probe:sanitizeProbeFailure(observed?.probe, provider)}, {recordRefusal: true, accountKey});
        return declineCodeFor(input.refuse);
      }
      return null;
    },
    // Decide from cached quota. A compatible waiting job can nudge a missing first reading without waiting.
    async gate({provider, accountKey = provider, automatic = true, ownerAbsent = false, jobId = null, job = null, model = null,
      intentOn = true, paused = false, offerDeadline = null}) {
      if (!job) return candidate.preflight({provider, accountKey, automatic, ownerAbsent, jobId});
      const override = !ownerAbsent && jobId && presenceOverrides ? presenceOverrides.available({jobId, now: now()}).granted : false;
      const previewOnce = () => candidate.preview({jobId, job, provider, accountKey, model, automatic,
        ownerAbsent: ownerAbsent || override, ownerPresenceOverride: override, intentOn, paused});
      let out = await previewOnce();
      const plan = contextFor(accountKey)?.plan ?? null;
      let observed = observeSnapshot({provider, accountKey, model, plan});
      // The owner already accepted this job. A saved reading that is too old, or a process with no probe fact yet, holds with
      // pending evidence and has asked for a fresh reading. Wait for it once, inside the same bound reserve uses and so inside
      // the claim lease, and decide again. Declining here would release an approved job and ask the owner again.
      if (!out.admitted && source?.kind === 'real' && intentOn && !paused &&
          out.reason === 'objective_evidence_unknown' && observed?.evidence_pending === true) {
        await waitForReading({provider, accountKey, model, plan});
        out = await previewOnce();
        observed = observeSnapshot({provider, accountKey, model, plan});
      }
      // Give a signed offer one ordinary read opportunity when the projected wait
      // outlasts it. The account reader still owns cadence and provider backoff.
      if (source?.kind === 'real' && intentOn && !paused && automatic && jobId &&
          out.reason === 'owner_reserve' && Number.isSafeInteger(offerDeadline) && offerDeadline > now()) {
        const wait = presentCapacityWait(out, observed, accountKey).wait;
        if (reserveRecheckNeeded(wait?.nextEvaluationAtMs, offerDeadline, now())) {
          for (const [key, entry] of offerRereads) if (entry.expiresAt <= now()) offerRereads.delete(key);
          const key = JSON.stringify([accountKey, jobId]);
          const previous = offerRereads.get(key);
          const due = wait.nextEvaluationAtMs <= now();
          if ((!previous && offerRereads.size < 128) || (due && previous?.due === false)) {
            offerRereads.set(key, {expiresAt:offerDeadline, due});
            await waitForReading({provider, accountKey, model, plan,
              waitMs: Math.min(pendingReadingWaitMs, offerDeadline - now())});
            if (now() >= offerDeadline) return 'job_expired';
            out = await previewOnce();
            observed = observeSnapshot({provider, accountKey, model, plan});
          }
        }
      }
      // No valid stop receipt: this claimed job joins the one bounded stop check of this machine (never one per account) and then
      // decides again. A failed or timed-out check refuses the job; the coordinator keeps the status line, and lending stays on.
      if (stopCheck && source?.kind === 'real' && intentOn && !paused && !out.admitted &&
          (out.reason === 'stop_bound_unknown' || out.reason === 'executor_unknown') &&
          (observed?.stop?.bounded_execution !== 'proven' || observed?.executor?.single_executor !== 'proven')) {
        const checked = await stopCheck.ensure();
        if (!checked.ok) return declineCodeFor(out.reason);
        out = await previewOnce();
        observed = observeSnapshot({provider, accountKey, model, plan});
      }
      // A failed refresh can retain quota windows for display without proving admission. A
      // live Codex offer may join one ordinary account read; the source owns cooldown/backoff.
      const recoveryKey = JSON.stringify([provider, accountKey]);
      const pendingRecovery = retainedFailureReads.get(recoveryKey);
      if (source?.kind === 'real' && provider === 'codex' && intentOn && !paused && automatic && jobId &&
          out.reason === 'refresh_failed' && (pendingRecovery || observed?.resources?.length) &&
          Number.isSafeInteger(offerDeadline) && offerDeadline > now()) {
        let read = pendingRecovery;
        if (!read) {
          read = refreshObservation({provider, ...keyArg({provider, accountKey}), model, plan, now:now(), forceRefresh:false})
            .catch(() => null).finally(() => { if (retainedFailureReads.get(recoveryKey) === read) retainedFailureReads.delete(recoveryKey); });
          retainedFailureReads.set(recoveryKey, read);
        }
        const refreshed = await waitForReading({provider, accountKey, model, plan, read,
          waitMs:Math.min(pendingReadingWaitMs, offerDeadline - now())});
        if (now() >= offerDeadline) return 'job_expired';
        if (refreshed?.refresh_succeeded === true) {
          out = await previewOnce();
          if (now() >= offerDeadline) return 'job_expired';
        }
      } else if (source?.kind === 'real' && intentOn && !paused && out.reason === 'refresh_failed' &&
          !pendingRecovery && !observed?.resources?.length && !initialReads.has(accountKey)) {
        initialReads.add(accountKey);
        void refreshObservation({provider, ...keyArg({provider, accountKey}), model, plan, now:now(), forceRefresh:false})
          .catch(() => {}).finally(() => initialReads.delete(accountKey));
      }
      return out.admitted === true ? null : declineCodeFor(out.reason);
    },
    // A chunk that cannot be enforced is refused before admission, by name, so nothing is held. An admitted chunk returns the guard budget
    // the run must enforce, and for Claude the enforced per-call cap, both from the limit the policy admitted.
    async reserve({attemptId, jobId, provider, accountKey = provider, job, model = null, effort, automatic = true, ownerAbsent = false, intentOn = true, paused = false, catalog}) {
      // This row records the final reserve result: pre-admission gates are held, while policy or effect failures are refused.
      const captureDecision = ({outcome, policyReason, out = null, baseline = null, inputIds = []}) => {
        try {
          const objective = out?.objective;
          const dial = objective?.dial ?? objective?.position ?? context(provider, {}, accountKey).protectionPosition;
          capture('admission_decided', {outcome,
            reason: outcome === 'admitted' ? 'objective_lend' : declineCodeFor(policyReason),
            policy_reason: policyReason,
            policy_version: objective?.policyVersion, dial, candidate_revision: out?.revision,
            input_observation_event_ids: inputIds,
            resource_headroom: (out?.windows ?? []).map(window => window?.slack_micro),
            // The named failed check and its measured facts, e.g. stop_latency_over_bound with latency_ms and bound_ms.
            ...(out?.detail ? {refusal_detail: out.detail} : {})});
        } catch { /* Capture assembly and writes must not change the reserve result. */ }
      };
      // The durable ledger keeps one account per provider: attempts are flattened and rewritten to the shared account, so a
      // scoped key cannot be reserved without another account's windows. Fail closed until the ledger isolates accounts.
      if (accountKey !== provider) {
        const reason = 'account_ledger_unisolated';
        cacheDecision(provider, {admitted: false, reason}, {accountKey});
        captureDecision({outcome: 'held', policyReason: reason});
        return {ok: false, reason: declineCodeFor(reason), policyReason: reason, probe: null};
      }
      const held = ownerHoldReason();
      if (held) {
        cacheDecision(provider, {admitted: false, reason: held}, {accountKey});
        captureDecision({outcome: 'held', policyReason: held});
        return {ok: false, reason: declineCodeFor(held), policyReason: held, probe: null};
      }
      const modelCapHold = modelCapDecision(provider, model, job);
      if (modelCapHold) {
        cacheDecision(provider, modelCapHold, {accountKey});
        captureDecision({outcome: 'held', policyReason: modelCapHold.reason, out: modelCapHold});
        return {ok: false, reason: declineCodeFor(modelCapHold.reason), policyReason: modelCapHold.reason, probe: null};
      }
      // Verify model pricing before persisting a reservation or dispatching effects.
      // A positive probe limit checks pricing only; admission selects the actual limit below.
      if (modelEnforcementHold(provider, model)) {
        cacheDecision(provider, {admitted: false, reason: 'model_unpriced'}, {accountKey});
        captureDecision({outcome: 'held', policyReason: 'model_unpriced'});
        return {ok: false, reason: declineCodeFor('model_unpriced'), policyReason: 'model_unpriced', probe: null};
      }
      pendingPriceAdmissions++;
      // The owner's one-job override stands in for presence, for this job only. It is spent only when this admission succeeds.
      const overridden =!ownerAbsent && presenceOverrides?.available({jobId, now: now()}).granted === true;
      let out, probe = null, baseline = null, inputIds = [];
      let evidence = {inputs: []};
      const admitOnce = () => admissionScope.run(evidence, () => adapter.admit({expectedRevision: revision(),
        request: {...makeRequest({attemptId, jobId, job, provider, accountKey, model, effort}), price_rev: catalog.revision},
        context: context(provider, {automatic, consent: true, ownerAbsent: ownerAbsent || overridden,
          ownerPresenceOverride: overridden,
          intent: intentOn ? 'on' : 'off', paused}, accountKey)}));
      try {
        out = await admitOnce();
        // The owner has already accepted this job. When the saved reading is too old or this process has no probe fact yet,
        // the source asked for a fresh reading and holds. Wait for that reading once, then decide, rather than decline and
        // ask the owner again after the re-offer delay.
        if (!out.admitted && source?.kind === 'real' && evidence.inputs.at(-1)?.observation?.evidence_pending === true) {
          await waitForReading({provider, accountKey, model, plan: contextFor(accountKey)?.plan, excludingAttemptId: attemptId});
          evidence = {inputs: []};
          out = await admitOnce();
        }
        const used = evidence.inputs.at(-1);
        baseline = used?.observation ?? null;
        inputIds = used?.eventId ? [used.eventId] : [];
        probe = sanitizeProbeFailure(baseline?.probe);
        cacheDecision(provider, out, {accountKey});
      } catch (error) {
        captureDecision({outcome: 'refused', policyReason: 'objective_evidence_unknown', baseline, inputIds});
        throw error;
      } finally {
        pendingPriceAdmissions--;
        dropSharedReading();
      }
      if (!out.admitted) {
        if (probe) out = {...out, probe};
        cacheDecision(provider, out, {accountKey});
        captureDecision({outcome: 'refused', policyReason: out.reason, out, baseline, inputIds});
        return {ok: false, reason: declineCodeFor(out.reason), policyReason: out.reason, probe};
      }
      if (overridden) presenceOverrides.consume({jobId, now: now()});
      registry.entry(attemptId).provider = provider;
      if (accountKey !== provider) registry.entry(attemptId).accountKey = accountKey;
      registry.entry(attemptId).nativeBudgetMicro = out.native_budget_micro;
      registry.entry(attemptId).liveCheck = {request:makeRequest({attemptId, jobId, job, provider, accountKey, model, effort}),
        context:context(provider, {automatic, consent:true, ownerAbsent:ownerAbsent || overridden,
          ownerPresenceOverride:overridden, intent:intentOn ? 'on' : 'off', paused}, accountKey),
        baseline, exposure:out.objective?.maximumExposureUsd, spent:0, admittedAt:now()};
      // The admission is durable before its effects run. A failed arm or launch means nothing may run, so the admitted reservation
      // is returned now by the lender's own absence proof, and the refusal is reported.
      const limit = out.effects_dispatched ? guardLimitFor(provider, attemptId) : null;
      const maxBudgetUsd = provider === 'claude' ? limit : null;
      if (limit === null || !lendingBudgetFor({provider, model, limit, catalog})) {
        registry.entry(attemptId).authorized = false;
        await candidate.release(attemptId,{prepared:false,reason:'admission_refused'});
        const reason = !out.effects_dispatched ? 'arm_failed' : 'model_unpriced';
        captureDecision({outcome: 'refused', policyReason: reason, out, baseline, inputIds});
        return {ok: false, reason: declineCodeFor(reason), policyReason: reason};
      }
      const admittedAttempt = adapter.state().attempts.find((a) => a.id === attemptId);
      // Both converted and native budgets need account-wide reads while the agent is silent.
      if (admittedAttempt) {
        registry.entry(attemptId).native = {accountId: baseline?.identity?.account_id ?? null, model};
        watchNative(admittedAttempt, {accountId: baseline?.identity?.account_id ?? null, readingResources:baseline?.resources ?? [],
          lastFreshAt: Math.min(...admittedAttempt.resources.map(r => r.aggregate_observed_at)),
          cold: admittedAttempt.resources.filter(r => (baseline?.resources ?? []).some(b => b.cold_open === true &&
            b.id === r.id && b.instance === r.instance)).map(r => r.id)});
      }
      captureDecision({outcome: 'admitted', policyReason: 'objective_lend', out, baseline, inputIds});
      return {ok: true, reservation: {provider, ...keyArg({provider, accountKey}), attemptId, model}, revision: out.revision, decision: {effort_max: contextFor(provider)?.effortMax ?? null},
        lendingBudget: lendingBudgetFor({provider, model, limit, catalog}), ...(provider === 'claude' ? {maxBudgetUsd} : {}),
        presence_override: overridden, probe};
    },
    // Check the same reserved job at the final dispatch boundary, without reserving twice.
    async admitStart(attemptId) {
      const handle = registry.entry(attemptId), check = handle.liveCheck;
      let out = {admitted: false, reason: 'objective_evidence_unknown'};
      const held = ownerHoldReason();
      if (held) out = {admitted: false, reason: held};
      else if (check && !check.baseline) out = {admitted:false, reason:'job_epoch_incompatible'};
      else if (check && handle.authorized === true && handle.started !== true) {
        try {
          for (let pass = 0; pass < 3; pass++) {
            const heldNow = ownerHoldReason();
            if (heldNow) { out = {admitted:false, reason:heldNow}; break; }
            if (handle.authorized !== true || handle.started === true) {
              out = {admitted:false, reason:'launch_not_authorized'}; break;
            }
            out = {admitted:false, reason:'controls'};
            const observation = await refreshObservation({...check.request, provider: handle.provider, ...keyArg({provider: handle.provider, accountKey: handle.accountKey}), now: now(), excludingAttemptId: attemptId, admissionOnly:true});
            const heldObserved = ownerHoldReason();
            if (heldObserved) { out = {admitted:false, reason:heldObserved}; break; }
            if (handle.authorized !== true || handle.started === true) {
              out = {admitted:false, reason:'launch_not_authorized'}; break;
            }
            const evidence = () => evidenceFor(source, observation, {provider: handle.provider, accountKey: handle.accountKey}) ?? observation;
            if (evidence()?.latest_attempt?.reason === 'evidence_superseded') continue;
            const failure = usableAdmissionEvidence(evidence(), check.request, now(), check.baseline);
            if (failure) { out = {admitted:false, reason:failure}; break; }
            const controls = context(handle.provider, check.context, handle.accountKey ?? handle.provider), stateRevision = revision();
            out = await boundReading.run({observation:evidence(), attemptId}, () => adapter.preview({
              request: check.request, context: controls, replacingAttemptId: attemptId}));
            const heldAfter = ownerHoldReason();
            if (heldAfter) { out = {admitted:false, reason:heldAfter}; break; }
            if (handle.authorized !== true || handle.started === true) {
              out = {admitted:false, reason:'launch_not_authorized'}; break;
            }
            if (evidence()?.latest_attempt?.reason === 'evidence_superseded' || stateRevision !== revision() ||
                JSON.stringify(controls) !== JSON.stringify(context(handle.provider, check.context, handle.accountKey ?? handle.provider))) {
              out = {admitted:false, reason:'controls'};
              continue;
            }
            const after = usableAdmissionEvidence(evidence(), check.request, now(), check.baseline);
            if (after && (after !== 'budget_too_small' || out.admitted)) out = {admitted:false, reason:after};
            break;
          }
        } catch {
          out = {admitted: false, reason: 'objective_evidence_unknown'};
        }
      }
      cacheDecision(handle.provider, out, {accountKey: handle.accountKey});
      return out?.admitted === true ? {ok:true} : {ok:false, reason:declineCodeFor(out?.reason)};
    },
    // Each live usage reading rechecks the remaining chunk with fresh quota. The durable reservation
    // stays intact; exclusion applies only to this replacement quote, never to another admission.
    async recheck({attemptId, usd, tokens, model, windows}) {
      const h = registry.entry(attemptId), check = h.liveCheck;
      // A native-window job has no conversion to price its spend. Its in-band meter lines come from the sandbox, so they can only
      // add a stop (a rise at the allowance); the guard's own host reads are the only evidence that keeps the job running.
      if (nativeAttempt(adapter.state().attempts.find(a => a.id === attemptId))) {
        guard.offerInband(attemptId, windows, now());
        const status = guard.status(attemptId);
        if (status?.stop_reason) return {admitted:false, reason:`native_guard_${status.stop_reason}`};
        return {deferred:true, reason:'native_guard_waiting'};
      }
      if (!check) {
        await registry.request(attemptId,'provider_limit');
        return {admitted:false, reason:'meter_coverage_required'};
      }
      // The fresh probe below is always deferred while this job holds the account. The guard's own meter reading is
      // live, so it stops the job once any reserved window has risen by the whole reservation.
      if (liveReservationSpent(adapter.state().attempts.find(a => a.id === attemptId)?.resources, windows)) {
        await registry.request(attemptId, 'provider_limit');
        return {admitted:false, reason:'live_meter_reservation_spent'};
      }
      if (!Number.isFinite(usd) && tokens && model) {
        let catalog;
        try { catalog = readPriceSnapshot(directory, adapter.state().attempts.find(a => a.id === attemptId)?.price_rev); }
        catch { await registry.request(attemptId, 'provider_limit'); return {admitted: false, reason: 'price_snapshot_missing'}; }
        const cost = priceListUsd(model, normalizeGuardUsage(h.provider, tokens), {catalog});
        usd = cost.priced ? cost.usd : null;
      }
      // Coalesce spend, but never discard a meter-only trigger at the same cumulative spend.
      check.spent = Math.max(check.spent, Number.isFinite(usd) ? usd : 0);
      h.pendingMeter = true;
      if (h.rechecking) return h.rechecking;
      h.rechecking = (async () => {
        let out = {admitted:false, reason:'meter_coverage_required'};
        while (h.pendingMeter) {
          h.pendingMeter = false;
          const spend = check.spent;
          const observation = await refreshObservation({...check.request, now:now(), preferAttemptId: attemptId}).catch(()=>null);
          const base = check.baseline;
          if (!observation?.identity?.verified || observation.identity.account_id !== base?.identity?.account_id ||
              observation.refresh_succeeded !== true || observation.complete !== true) {
            if (['account_busy', 'probe_deferred'].includes(observation?.probe?.reason)) {
              out = {deferred:true, reason:observation.probe.reason};
              continue;
            }
            // Unknown quota cannot replenish the account's blind native exposure, even through a restart.
            const state=adapter.state();
            const rates=(base?.resources??[]).map(w=>({id:w.id,instance:w.instance,epoch:base.epoch,
              anchor_at:w.anchor_at,resets_at:w.resets_at,kappa_micro:w.kappa_micro,used_micro:w.used_micro}));
            const frozen=await adapter.deliver({type:'meter_feedback_pending',event_id:`${attemptId}:meter-feedback:${revision()}`,
              account:state.account,at:now(),resources:rates});
            if(!frozen.applied) await registry.request(attemptId,'provider_limit');
            out = {admitted:false, reason:'meter_coverage_required'};
            continue;
          }
          const rates = [], accounted = [];
          for (const w of observation.resources ?? []) {
            const before = base?.resources?.find(b => b.id === w.id && b.instance === w.instance);
            if (!before) continue;
            const rise = w.used_micro - before.used_micro;
            const observedRate = rise > 0 && spend > 0 ? Math.ceil(rise / spend) : before.kappa_micro;
            const prior = adapter.state().rate_feedback?.rates.find(r=>r.id===w.id&&r.instance===w.instance&&r.epoch===observation.epoch);
            const rate = Math.max(before.kappa_micro, observedRate, prior?.kappa_micro ?? 0);
            rates.push({id:w.id,instance:w.instance,epoch:observation.epoch,anchor_at:w.anchor_at,resets_at:w.resets_at,
              kappa_micro:rate,used_micro:w.used_micro});
            // A refreshed but unchanged meter does not cover known native spend. Do not renew blind exposure.
            accounted.push(rise >= Math.ceil(before.kappa_micro * spend));
          }
          const surprise = rates.some(r=>r.kappa_micro > (base.resources.find(w=>w.id===r.id)?.kappa_micro ?? Infinity));
          const covered = rates.length === base.resources.length && accounted.every(Boolean);
          if (surprise || spend > 0 && !covered) {
            if (!surprise && spend > 0) {
              const request = {...check.request,requested_usd_micro:microCeil(Math.max(0,(check.exposure ?? 0)-spend))};
              const fresh = await adapter.preview({request,context:check.context,replacingAttemptId:attemptId});
              if (!fresh.admitted) {
                await registry.request(attemptId,'provider_limit');
                out = fresh;
                continue;
              }
              // Provider percentages can round away a small active burn. Keep the original hold and
              // wait for a later sample; lack of visible movement is not evidence of a safer rate.
              out = {deferred:true, reason:'meter_coverage_pending'};
              continue;
            }
            const result = await adapter.deliver({type:'meter_feedback',event_id:`${attemptId}:meter-feedback:${revision()}`,
              account:adapter.state().account,at:now(),observed_at:observation.observed_at,resources:rates});
            dropSharedReading();
            if (!result.applied) await registry.request(attemptId,'provider_limit');
            out = {admitted:false,reason:surprise?'meter_rate_surprise':'meter_coverage_required'};
            continue;
          }
          await coverFeedback(observation);
          const request = {...check.request,requested_usd_micro:microCeil(Math.max(0,(check.exposure ?? 0)-spend))};
          out = await adapter.preview({request,context:check.context,replacingAttemptId:attemptId});
          if (!out.admitted) await registry.request(attemptId,'provider_limit');
        }
        return out;
      })().then(out => {
        h.rechecking = null;
        // Also drain a trigger queued between the loop's return and this promise completion.
        return h.pendingMeter ? candidate.recheck({attemptId,usd:check.spent}) : out;
      }, error => { h.rechecking = null; throw error; });
      return h.rechecking;
    },
    // Persist launch before dispatch. Only a durable started or ambiguous row requires usage settlement;
    // a refused transition leaves a reserved attempt which the lender must not dispatch.
    async started(attemptId, {ok}) {
      dropSharedReading();
      const out = await adapter.transition({type: 'launch_result', event_id: `${attemptId}:start`, at: now(), attempt_id: attemptId,
        result: ok ? 'started' : 'ambiguous'}, {expectedRevision: revision()});
      const launchState = adapter.state().attempts.find(attempt => attempt.id === attemptId)?.launch_state;
      registry.entry(attemptId).started = launchState === 'started' || launchState === 'ambiguous';
      if (adapter.state().attempts.find(attempt => attempt.id === attemptId)?.cleanup_proven !== true) {
        registry.entry(attemptId).cleanupRemoved = false;
        registry.entry(attemptId).freshCleanupVerified = false;
        registry.entry(attemptId).cleanupPersistence = null;
      }
      // A late start carries its maximum exposure into the window that covers it, read now.
      if (adapter.state().attempts.find((a) => a.id === attemptId)?.late_ack_unresolved === true) {
        const provider = providerOf(attemptId);
        const reading = provider === null ? null : freshReading(await observeSource({provider, now: now(), preferAttemptId: attemptId}), now());
        if (reading) await carryLate(attemptId, reading, now());
      }
      return out;
    },
    // The owner route records an attempt-specific Stop intent before asking the local lender to stop the sandbox.
    // This does not prove cessation; only cleanup plus reconciled usage can close the held exposure.
    async ownerStop({attemptId, event_id, at = now()}) {
      const out=await adapter.deliver({type: 'owner_stop', event_id, at, attempt_id: attemptId});
      // The durable event dispatches the stop; a second unawaited copy could return before its journal is saved.
      if(out?.applied===true)guard.ownerStop(attemptId,{request:false});
      return out;
    },
    // The lender's own cleanup observed the sandbox removal for this attempt. That is what a cessation proof needs.
    recordCleanup(attemptId, cleanup) {
      if (cleanup?.removed !== true) return Promise.resolve({applied: false, reason: 'cleanup_unverified'});
      registry.entry(attemptId).cleanupRemoved = true;
      registry.entry(attemptId).freshCleanupVerified = true;
      const persisted = persistCleanupProof(attemptId);
      // Some backend cleanup callbacks are not async-aware. Keep the promise for finish to await
      // and attach a rejection handler here so a failed write cannot become an unhandled rejection.
      persisted.catch(() => {});
      return persisted;
    },
    // Usage is recorded once, at finish. Cessation is proven only by the lender's own cleanup, and only with usage known and
    // reconciled. A run with no reading is not a run with zero usage: it stays held until a reading or a reconciliation exists.
    async finish({attemptId, provider, accountKey = provider, model, execution, observation, effort = null}) {
      // A settlement that comes back from the lender's journal after a restart names its account again.
      if (accountKey !== provider) registry.entry(attemptId).accountKey = accountKey;
      dropSharedReading();
      // The job has ended: stop guarding it and remove its meter sandbox before any step below can throw or return early.
      void unwatchNative(attemptId);
      const cleanupHandle = registry.entry(attemptId);
      const cleanupState = adapter.state().attempts.find(attempt => attempt.id === attemptId)?.cleanup_proven;
      const cleanupPending = cleanupHandle.cleanupPersistence?.status === 'pending';
      if (cleanupHandle.cleanupRemoved === true && (cleanupState !== false || cleanupPending))
        await persistCleanupProof(attemptId);
      const priceAttempt = adapter.state().attempts.find(a => a.id === attemptId);
      const priceRev = priceAttempt?.price_rev;
      let catalog;
      try {
        // No historical token catalog exists for a revision-less attempt.
        // Do not select bundled or live fallback prices, including after restart.
        catalog = priceAttempt && priceRev == null
          ? null
          : readPriceSnapshot(directory, priceRev);
      }
      catch { return {metered: {model, units_micro: null}, public: null, cessation: {applied: false, reason: 'price_snapshot_missing'}}; }
      const {metered, units_micro: reportedUnits, served_model: observedModel} = usageUnits({provider, model, execution, effort, catalog});
      // A borrower can report zero after consuming quota. Converted lending needs lender-side meter evidence to release that hold.
      const units = !nativeAttempt(priceAttempt) && reportedUnits === 0 ? null : reportedUnits;
      const served_model = mergeServedModelEvidence(
        adapter.state().attempts.find(row => row.id === attemptId)?.served_model, observedModel);
      // Normal accounting events carry the evidence without another revision.
      // A path with no successful event records it only after accounting is done.
      const withServedModel = async result => {
        try {
          const recorded = await adapter.recordServedModel(attemptId, served_model);
          return {...result, served_model_persistence: {status: recorded.applied || recorded.reason === 'already_recorded'
            ? 'recorded' : 'not_recorded', reason: recorded.applied ? null : recorded.reason}};
        } catch (error) {
          // A failed evidence write must not relabel the accounting result. The
          // adapter still poisons an uncertain store; do not claim durable proof.
          return {...result, served_model_persistence: {status: 'unknown', reason: error?.code ?? 'evidence_write_failed'}};
        }
      };
      const publicReceipt = metered?.tokens
        ? publicBudgetReceipt(metered, {effort, stop_reason: execution?.stop_reason ?? 'done'}) : null;
      if (nativeAttempt(priceAttempt)) {
        // A native-window job is charged from the meter, at least one shown point whatever its own output reports. Its own
        // metered cost is kept only to calibrate.
        registry.entry(attemptId).nativeSettle = {usage: units === null ? 'unknown' : units === 0 ? 'zero' : 'positive',
          usdMicro: units, model: metered?.model ?? model};
        if (units === null) await adapter.transition({type: 'usage_unknown', event_id: `${attemptId}:usage-unknown`, at: now(),
          attempt_id: attemptId, provider, served_model}, {expectedRevision: revision()});
        // Result delivery does not wait for a meter probe. The idle sweep measures the durable hold after the lag delay.
        let cessation = registry.entry(attemptId).cleanupRemoved === true ? await settleNative(attemptId, provider, {readMeter:false})
          : {applied: false, reason: 'cleanup_unverified'};
        // Meter refusals leave a durable hold, recovered by probeHeld. Cleanup proves execution ended.
        // Admission continues to count the durable reservation or retained meter uncertainty.
        const held = adapter.state().attempts.find(a => a.id === attemptId);
        if (cessation.applied === false && held?.cleanup_proven === true && durableCessationBound(held,{state:adapter.state()})!==null &&
            holdOpen(held) && (cessation.reason?.startsWith('native_settlement_') || ['window_reset_unsettled','settlement_retained','usage_coverage_unavailable'].includes(cessation.reason)))
          cessation = {...cessation, reason: 'native_usage_held', settlement_reason: cessation.reason};
        return withServedModel({metered: {...metered, units_micro: units}, public: publicReceipt, cessation});
      }
      // Unknown usage is not zero. The exposure stays held, which is the conservative state the note above describes.
      if (units === null) {
        // The exposure stays held. The durable fact lets probeHeld settle it from the meter, even after a restart.
        await adapter.transition({type: 'usage_unknown', event_id: `${attemptId}:usage-unknown`, at: now(), attempt_id: attemptId,
          provider, served_model}, {expectedRevision: revision()});
        let cessation = {applied: false, reason: 'usage_unknown'};
        if (registry.entry(attemptId).cleanupRemoved === true) {
          await candidate.probeHeld();
          if (adapter.state().attempts.find(attempt => attempt.id === attemptId)?.hold_closed === true)
            cessation = {applied: true, reason: 'reconciled_from_meter'};
        }
        return withServedModel({metered: {model: metered.model, units_micro: null}, public: publicReceipt, cessation});
      }
      let reconciled = units === 0;
      if (units > 0) {
        // The burn is priced at the conversion this attempt reserved, not at the current observation.
        const resources = source.convertUsage({provider, units_micro: units, resources: reservedResources(attemptId)});
        if (!Array.isArray(resources)) return withServedModel({metered: {...metered, units_micro: units}, public: publicReceipt,
          cessation: {applied: false, reason: 'conversion_unknown'}});
        await adapter.transition({type: 'usage', event_id: `${attemptId}:usage`, at: now(), attempt_id: attemptId,
          burn_id: `${attemptId}:burn`, resources, served_model}, {expectedRevision: revision()});
        const reading = observation ?? await observeSource({provider, now: now(), preferAttemptId: attemptId});
        if (reading.refresh_succeeded === true && reading.complete === true && typeof reading.epoch === 'string') {
          const applied = await adapter.transition({type: 'reconcile_burn', event_id: `${attemptId}:reconcile`, at: now(),
            attempt_id: attemptId, burn_id: `${attemptId}:burn`, account: adapter.state().account, epoch: reading.epoch,
            complete: true, compatible: true, refresh_succeeded: true, attribution_confirmed: true, observed_at: reading.observed_at,
            resources: reading.resources.map((r) => ({id: r.id, instance: r.instance, anchor_at: r.anchor_at,
              resets_at: r.resets_at, used_micro: r.used_micro}))}, {expectedRevision: revision()});
          reconciled = applied.applied === true;
        }
      }
      const cessation = registry.entry(attemptId).cleanupRemoved === true && reconciled
        ? await adapter.transition({type: 'cessation_proven', event_id: `${attemptId}:cessation`, at: now(), attempt_id: attemptId,
          authoritative_cessation: true, usage_reconciled: true, served_model}, {expectedRevision: revision()})
        : {applied: false, reason: registry.entry(attemptId).cleanupRemoved === true ? 'usage_unreconciled' : 'cleanup_unverified'};
      if(cessation.applied===true){
        const reading=freshReading(observation??await observeSource({provider,now:now(),preferAttemptId:attemptId}),now());
        await settleOrClose(attemptId,reading,now());
      }
      const result = await withServedModel({metered: {...metered, units_micro: units}, public: publicReceipt, cessation});
      if (!pendingPriceAdmissions) prunePriceSnapshots(directory, new Set([...adapter.state().attempts.filter(a => a.hold_closed !== true).map(a => a.price_rev).filter(Boolean), currentPriceCatalog().revision]));
      return result;
    },
    // Manual recovery never treats missing usage as zero. Backend absence is fresh and attempt-bound.
    async releaseHold(attemptId, {confirmed = false} = {}) {
      if (confirmed !== true) return {applied:false,reason:'confirmation_required'};
      const attempt=adapter.state().attempts.find(a=>a.id===attemptId);
      if (!attempt) return {applied:false,reason:'attempt_unknown'};
      if (attempt.hold_closed === true) return {applied:true,settled:true};
      const refuse=detail=>({applied:false,reason:'cessation_unverified',detail});
      if (registry.entry(attemptId).stop) return refuse('attempt_active');
      let proof;
      try { proof=await backend?.proveHoldAbsent?.({attemptId,jobId:attempt.job_id,
        pending:pendingRecords().find(p=>p.attemptId===attemptId)}); } catch { return refuse('absence_check_failed'); }
      if (registry.entry(attemptId).stop) return refuse('attempt_active');
      if (proof?.absent!==true) return refuse(proof?.reason || 'absence_proof_unavailable');
      if (proof.attemptId!==attemptId) return refuse('attempt_identity_mismatch');
      const intent=await adapter.transition({type:'owner_release_hold',event_id:`${attemptId}:owner-release-hold`,
        at:Math.max(now(),adapter.state().updated_at??0),attempt_id:attemptId,confirmed:true}, {expectedRevision:revision()});
      if (!intent.applied && intent.reason!=='duplicate_event') return intent;
      const cleanup=await candidate.recordCleanup(attemptId,{removed:true});
      if (cleanup.applied!==true) return cleanup;
      await candidate.probeHeld();
      return {applied:true,settled:adapter.state().attempts.find(a=>a.id===attemptId)?.hold_closed===true};
    },
    // Exposure of an attempt that never started is released only by its own cleanup, or by the lender's absence proof when no
    // sandbox can exist. Cleanup alone never certifies usage for a started attempt, so a started attempt stays held here.
    async release(attemptId, {reason, prepared = true}) {
      dropSharedReading();
      void unwatchNative(attemptId);
      const entry = registry.entry(attemptId);
      if (entry.started === true) return {applied: false, reason: 'usage_unreconciled', cause: reason};
      // This lender prepared no sandbox for the attempt, so it has no work to stop. That is the lender-local proof of
      // absence, and it is the only proof besides its own cleanup record.
      const absent = prepared === false;
      if (!absent && entry.cleanupRemoved !== true) return {applied: false, reason: 'cleanup_unverified', cause: reason};
      if (!absent) await persistCleanupProof(attemptId);
      // Only an attempt that never started reaches this transition, so no use is the evidence, and the policy requires it to say so.
      return adapter.transition({type: 'cessation_proven', event_id: `${attemptId}:release`, at: now(), attempt_id: attemptId,
        authoritative_cessation: true, usage_reconciled: true, zero_use_attested: true,
        ...(absent ? {absence_proven: true} : {})}, {expectedRevision: revision()});
    },
    // A started or completed run settles through usage and cleanup; an undispatched attempt releases its hold.
    async settle(attemptId, {provider, accountKey = provider, model, execution = null, effort = null, prepared = true, reason, fullCharge = false}) {
      if(fullCharge){
        const attempt=adapter.state().attempts.find(row=>row.id===attemptId);
        if(!attempt||attempt.usage_unknown==='legacy_full_charge')return {applied:true};
        // Legacy inferred absence is charged in full even if an old marker says
        // the run never started. It must not take release() or meter discounts.
        return adapter.transition({type:'legacy_cleanup_full_charge',event_id:`${attemptId}:legacy-full-charge`,at:Math.max(now(),adapter.state().updated_at??0),attempt_id:attemptId,authoritative_cessation:true},{expectedRevision:revision()});
      }
      // A saved completion proves dispatch, including old journals whose prepared:false meant cleanup finished.
      const completed = reason === 'done' && adapter.state().attempts.some(attempt => attempt.id === attemptId);
      if (completed || registry.entry(attemptId).started === true)
        return candidate.finish({attemptId, provider, ...keyArg({provider, accountKey}), model, execution, effort});
      return candidate.release(attemptId, {reason, prepared});
    },
    // A reading may add spend for attributable movement. It cannot release unresolved exposure without interval coverage.
    // Cleanup plus reset settles the window; stale readings do not change the ledger.
    async probeHeld() {
      const recovery = reopenPoisoned();
      if (recovery && await recovery)
        for (const row of adapter.state().attempts)
          if (registry.entry(row.id).cleanupRemoved === true) await persistCleanupProof(row.id);
      const at = now(), maximums = [];
      for (const attempt of adapter.state().attempts) {
        if (!holdOpen(attempt)) continue;
        if (adapter.state().event_ids.includes(`${attempt.id}:owner-release-hold`)) {
          // Owner recovery always charges the full maximum, after the same reset and late-exposure gates.
          await settleOrClose(attempt.id,null,at);
          continue;
        }
        // A late or carried native record settles by the carry and reset path below, as a calibrated one does.
        // A run cleaned up after its window reset may have spent past it, with or without a late flag (older writers set none).
        const lateByCleanup = attempt.resources.some(r => at >= r.resets_at && r.held_micro + r.unrepresented_micro > 0 &&
          mayHaveSpentPast(attempt, r, {state: adapter.state()}));
        if (nativeAttempt(attempt) && attempt.late_ack_unresolved !== true && attempt.pending_late_exposure === undefined &&
            !lateByCleanup && !attempt.id.includes(':carry:')) {
          if (cleanupOf(attempt.id)) await settleNative(attempt.id, attempt.usage_unknown ?? providerOf(attempt.id));
          continue;
        }
        // A carried record reads its run's provider and sandbox proof. A late start carries its maximum as its windows end.
        const provider = attempt.usage_unknown ?? providerOf(attempt.id);
        const cleanup = cleanupOf(attempt.id);
        const pending = attempt.resources.some((r) => r.unrepresented_micro > 0);
        const observed = provider !== null && holdOpen(attempt)
          ? await readSettlement(attempt,provider,at) : null;
        const reading = freshReading(observed, at);
        if (reading) await carryLate(attempt.id, reading, at);
        if (reading && attempt.usage_unknown != null && attempt.resources.every((r) => r.burns.length === 0)) {
          let maximumAfterCleanup = false;
          let burns = attributableBurns({attempt, reading, at, state: adapter.state()});
          // Older stopped jobs can have no usage report or ownership history. Charge
          // their entire held maximum rather than wait forever for exact attribution.
          // The aggregate reconciliation still has to cover every charged point.
          if (!burns && cleanup && attempt.cleanup_proven === true &&
              reading.observed_at >= attempt.cleanup_proof_persisted_at && reading.epoch === attempt.epoch &&
              attempt.resources.every(r => reading.resources.some(seen => seen.id === r.id &&
                seen.instance === r.instance && seen.anchor_at === r.anchor_at && seen.resets_at === r.resets_at &&
                reading.observed_at < r.resets_at && seen.used_micro >= r.baseline_used_micro + r.held_micro)))
            { burns = attempt.resources.map(ledger => ({ledger, amount_micro:ledger.held_micro})); maximumAfterCleanup = true; }
          if (burns && await attribute(attempt, reading, burns, maximumAfterCleanup) && maximumAfterCleanup)
            maximums.push({id:attempt.id, reading});
        }
        if (reading && pending) await reconcilePending(attempt.id, reading, at);
        await settleOrClose(attempt.id, reading, at);
      }
      // Stage all stopped-job maxima before accepting their shared aggregate. The
      // cleanup proof dates these charges before the reading, regardless of replay order.
      for (const {id, reading} of maximums) {
        await reconcilePending(id, reading, Math.max(now(), adapter.state().updated_at ?? 0));
        await settleOrClose(id, reading, now());
      }
      const feedback=adapter.state().rate_feedback;
      if(feedback?.blocked){
        const providers=new Set(feedback.rates.map(r=>r.id.startsWith('codex:')?'codex':'claude'));
        for(const provider of providers) await coverFeedback(await refreshObservation({provider,now:now()}));
      }
    },
  };
  const reserveWithCatalog = candidate.reserve.bind(candidate);
  candidate.reserve = args => {
    let catalog;
    try { catalog = savePriceSnapshot(directory, currentPriceCatalog()); }
    catch { return Promise.resolve({ok: false, reason: 'price_snapshot_unavailable', policyReason: 'price_snapshot_unavailable'}); }
    const unpin = pinPriceSnapshot(catalog.revision);
    return withPriceCatalog(catalog, () => reserveWithCatalog({...args, catalog})).finally(unpin);
  };
  candidate.nativeGuard = guard;
  return {adapter, candidate};
}

