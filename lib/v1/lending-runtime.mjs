import {resolveLenderStatusModel} from './lending-run-model.mjs';
import {createLendingManager} from './lending-manager.mjs';
import {createPace50Candidate} from './lender-pace50.mjs';
import {machineCapacity} from './lending-policy.mjs';
import {DIALS, EXPLAINER, LIMIT, lendingStatus, retainedJobStatus, conversionRejectionLine} from './lending-status-copy.mjs';
import {DEFAULT_PROTECTION, PROTECTION_POSITIONS} from './lending-objective.mjs';
import {attemptEvidenceFromState} from './attempt-evidence.mjs';
import {totalmem, availableParallelism} from 'node:os';
import {join} from 'node:path';
import {createMeasurementHistory} from './event-history.mjs';
import {sanitizeProbeFailure} from './lending-pace50-source.mjs';
import {isDeferredObservation} from './lending-probe.mjs';
import {accountIdOfKey, isAccountKey, providerOfKey} from './lending-account-key.mjs';

const UNKNOWN_DECISION = Object.freeze({admitted: false, reason: 'objective_evidence_unknown',
  objective: Object.freeze({schemaVersion: 1, policyVersion: 'objective/m1', admission: 'held',
    reasonCode: 'objective_evidence_unknown', reasonText: 'Holding because trusted lending evidence is unavailable.',
    protectionSource: 'unknown'})});

// The protection source the status read and the ops registry name. The engine's whole-week history bands are 'history'; a
// usage model would be 'model'. Anything else is null: no source is known yet, so the surface never guesses one.
const PROTECTION_SOURCES = Object.freeze({weekly_upper_band: 'history', weekly_band_unbounded: 'history', history: 'history', model: 'model'});
export function publicProtectionSource(engineSource) {
  if (typeof engineSource === 'string') return PROTECTION_SOURCES[engineSource] ?? null;
  if (!engineSource || typeof engineSource !== 'object' || Array.isArray(engineSource)) return null;
  const sources = Object.values(engineSource);
  if (sources.length === 0 || new Set(sources).size !== 1) return null;
  return PROTECTION_SOURCES[sources[0]] ?? null;
}
// Display windows belong to the decision only when every window published was observed at the objective's own time and
// each window the objective priced is among them. A conflicting duplicate id carries a second time, so it fails the same check.
// Matching by window id and observation time proves one revision; the percentages are engine points and are not compared here.
function windowsAlignWith(objective, windows) {
  const ids = Object.keys(objective?.usedPoints ?? {}), at = Date.parse(objective?.observedAt);
  if (ids.length === 0 || !Number.isFinite(at) || !Array.isArray(windows)) return false;
  const observedAt = window => typeof window?.observed_at === 'number' ? window.observed_at : Date.parse(window?.observed_at);
  return windows.every(window => observedAt(window) === at) && ids.every(id => windows.some(window => window.window_id === id));
}
function publicObjective(objective) {
  if (!objective) return objective;
  return {...objective, protectionSource: publicProtectionSource(objective.protectionSource)};
}

function publicRead(observation, plan) {
  if (!observation || !Array.isArray(observation.resources)) return null;
  return {plan, observed_at: observation.observed_at ?? null, epoch: observation.epoch ?? null,
    account_week_id: observation.account_week_id ?? null, complete: observation.complete === true,
    refresh_succeeded: observation.refresh_succeeded === true,
    ...(isDeferredObservation(observation) ? {refresh_outcome:'deferred'} : {}),
    probe: observation.refresh_succeeded === true ? observation.probe ?? null : sanitizeProbeFailure(observation.probe),
    windows: observation.resources.map(resource => ({window_id: resource.id,
      window_minutes: resource.duration_ms / 60000, used_pct: resource.used_micro / 1_000_000,
      resets_at: resource.resets_at, observed_at: resource.observed_at, state: resource.state,
      kind: resource.kind, instance: resource.instance,
      conversion: resource.conversion ?? null,
      // A native window has no rate yet: it lends in its own points while the rate is learned from lent jobs.
      conversionLabel: [resource.conversion === 'native_window' ? 'No measured usage rate yet' : resource.kappa_provenance?.label,
        conversionRejectionLine(resource.kappa_rejection_code)].filter(Boolean).join('. ') || null,
      origin: resource.origin ?? null}))};
}

// One engine owns borrower admission, reservations, holds and reconciliation. If
// startup has no trusted identity or source, the candidate is unavailable and
// holds every request; there is no legacy allocator fallback.
export function createLendingRuntime({directory, backend, settings, presence, now = Date.now, readOverride = null,
  statusRead = null, pace50 = null} = {}) {
  let closed = false, ownerActive = null, ownerActiveAt = null, timer;
  let presenceGeneration = 0;
  const activeJobs = new Map();
  const measurementHistory = pace50?.measurementHistory ?? createMeasurementHistory({
    directory: typeof directory === 'string' ? join(directory, 'history') : null,
  });
  try { measurementHistory?.record?.('capture_epoch_started', {}); } catch { /* Measurement capture never controls lending. */ }
  // The provider toggle controls lending. Account eligibility and sign-in
  // remain separate, and a saved provider plan only describes its first account.
  const ownsProviderSettings = key => !isAccountKey(key) || accountIdOfKey(key) === null;
  // One plan normalization for refresh, observe, status and reads: they share a cache key, so they must name the same plan.
  // Codex without a saved plan is 'unknown'; Claude without one stays null.
  const contextPlan = key => {
    const provider = isAccountKey(key) ? providerOfKey(key) : key;
    const saved = ownsProviderSettings(key) ? settings()?.limits?.lendingPolicy?.accountPlans?.[provider] : undefined;
    return saved ?? (provider === 'claude' ? null : 'unknown');
  };
  // The key names the account. The first account's key is its provider, so only another account's key is passed on, whole.
  const subjectArgs = key => {
    const provider = isAccountKey(key) ? providerOfKey(key) : key;
    return provider === key ? {provider} : {provider, accountKey: key};
  };
  const selectedProvider = key => {
    const provider = isAccountKey(key) ? providerOfKey(key) : key;
    const agent = provider === 'claude' ? 'claude-code-subscription' : provider;
    return settings()?.agents?.[agent] === true;
  };
  const runtimeContext = key => ({
    protectionPosition: settings()?.limits?.lendingPolicy?.protectionPosition,
    strategy: settings()?.limits?.lendingPolicy?.strategy,
    strategyConfig: settings()?.limits?.lendingPolicy?.strategyConfig,
    plan: ownsProviderSettings(key) ? settings()?.limits?.lendingPolicy?.accountPlans?.[key] ?? null : null,
    consent: selectedProvider(key),
    strategy: settings()?.limits?.lendingPolicy?.strategy ?? 'automatic',
    strategyParams: settings()?.limits?.lendingPolicy?.strategyParams ?? {},
    effortMax: settings()?.limits?.lendingPolicy?.effortMax ?? 'high',
  });
  const statusRunModel = provider => resolveLenderStatusModel({
    spec:{harness_id:provider === 'claude' ? 'claude-code-subscription' : provider},
    run:settings()?.agentRun?.[provider === 'claude' ? 'claude-code-subscription' : provider]});
  const opened = createPace50Candidate({directory, now, backend, contextFor: runtimeContext,
    statusRunModel, ...(pace50 ?? {}), measurementHistory});
  const candidate = opened.candidate;
  const durable = opened.adapter;
  // The lender calls the durable candidate directly for admission and settlement. Track that same lifecycle here so
  // status does not report an admitted job as idle while its reservation is active.
  const reserveCandidate = candidate.reserve.bind(candidate);
  candidate.reserve = async args => {
    const result = await reserveCandidate(args);
    if (result?.ok === true) activeJobs.set(args.attemptId, args.provider);
    return result;
  };
  const finishCandidate = candidate.finish.bind(candidate);
  candidate.finish = async args => {
    try { return await finishCandidate(args); }
    finally { activeJobs.delete(args.attemptId); }
  };
  const releaseCandidate = candidate.release.bind(candidate);
  candidate.release = async (attemptId, args = {}) => {
    try { return await releaseCandidate(attemptId, args); }
    finally { if (attemptId) activeJobs.delete(attemptId); }
  };
  const manager = createLendingManager({candidate});

  async function samplePresence() {
    if(settings()?.limits?.idleOnly!==true){
      ++presenceGeneration;ownerActive=false;ownerActiveAt=now();return false;
    }
    const generation = ++presenceGeneration, sampledAt = now();
    let sampled = null;
    try {
      const value = await presence?.();
      sampled = value === true ? true : value === false ? false : null;
    } catch { /* Unknown presence never proves absence. */ }
    // An older completion cannot overwrite newer presence, or freshen an old absence.
    if (generation === presenceGeneration) {
      ownerActive = sampled;
      ownerActiveAt = sampledAt;
    }
    return ownerActive;
  }

  async function readings(accountKey, {presenceSampled = false, signal, forceRefresh = false} = {}) {
    if (signal?.aborted || closed) return null;
    const plan = contextPlan(accountKey);
    if (!presenceSampled) await samplePresence();
    if (signal?.aborted || closed) return null;
    if (typeof readOverride === 'function') {
      try {
        const value = await readOverride(accountKey, {signal, forceRefresh});
        if (signal?.aborted || closed) return null;
        if (value?.windows) return value;
        // A scoped key is answered only by its own reading. Falling through would let a provider-level source answer for it.
        // The bare provider is a legacy key and keeps its fallback.
        if (isAccountKey(accountKey) && accountIdOfKey(accountKey) !== null) return null;
      } catch { return null; }
    }
    if (typeof candidate.observe !== 'function') return null;
    try {
      const read = forceRefresh && typeof candidate.refreshObservation === 'function'
        ? candidate.refreshObservation({...subjectArgs(accountKey), plan, now: now(), signal})
        : candidate.observe({...subjectArgs(accountKey), plan, now: now(), signal});
      return publicRead(await read, plan);
    }
    catch { return null; }
  }

  async function refreshCapacity(accountKey, {signal} = {}) {
    const provider = isAccountKey(accountKey) ? providerOfKey(accountKey) : accountKey;
    if (!['claude', 'codex'].includes(provider)) throw new TypeError('unknown lending account');
    if (closed || signal?.aborted || typeof candidate.refreshObservation !== 'function') return UNKNOWN_DECISION;
    await samplePresence();
    if (closed || signal?.aborted) return UNKNOWN_DECISION;
    const plan = contextPlan(accountKey);
    let reading;
    try { reading = publicRead(await candidate.refreshObservation({...subjectArgs(accountKey), model:statusRunModel(provider), plan, now: now(), signal}), plan); }
    catch { return UNKNOWN_DECISION; }
    if (closed || signal?.aborted) return UNKNOWN_DECISION;
    if (reading?.refresh_succeeded !== true) {
      const probe = sanitizeProbeFailure(reading?.probe);
      const reason = isDeferredObservation(reading) ? probe.reason : 'refresh_failed';
      return {...UNKNOWN_DECISION, reason, reasonCode: reason, ...(probe ? {probe} : {})};
    }
    const saved = settings() ?? {};
    const presenceFresh = ownerActiveAt !== null && now() >= ownerActiveAt && now() - ownerActiveAt <= 30_000;
    const projection = await candidate.projectStatus?.({...subjectArgs(accountKey), plan,
      automatic: saved.modes?.[saved.activeCircle] === 'auto' && runtimeContext(accountKey).consent,
      ownerAbsent: saved.limits?.idleOnly!==true || presenceFresh && ownerActive === false,
      snapshotOnly: true}) ?? UNKNOWN_DECISION;
    return closed || signal?.aborted ? UNKNOWN_DECISION : projection;
  }

  // Offer-only assessment: never refresh quota, sample presence, reserve, or publish a job.
  // Fixtures replace only readings; the same candidate controls and objective still decide.
  async function previewAdmission(offer = {}, options = {}) {
    const job = structuredClone(offer.job ?? offer);
    if (job.expires_at === undefined && offer.deadline !== undefined)
      job.expires_at = typeof offer.deadline === 'number' ? new Date(offer.deadline).toISOString() : offer.deadline;
    if (offer.estimatedWallMs !== undefined && job.requirements?.limits?.wall_seconds === undefined)
      job.requirements = {...job.requirements, limits: {...job.requirements?.limits, wall_seconds: offer.estimatedWallMs / 1000}};
    const resource = offer.resource ?? job.resource ?? offer.harness ?? job.harness;
    const provider = offer.provider ?? job.provider ?? (String(resource).startsWith('claude') ? 'claude'
      : resource === 'codex' ? 'codex' : null);
    const model = offer.model ?? job.model ?? null;
    const saved = settings() ?? {};
    const automatic = options.automatic ?? saved.modes?.[saved.activeCircle] === 'auto';
    const presenceFresh = ownerActiveAt !== null && now() >= ownerActiveAt && now() - ownerActiveAt <= 30_000;
    const ownerAbsent = saved.limits?.idleOnly!==true || (options.ownerAbsent ?? (presenceFresh && ownerActive === false));
    const out = closed || options.signal?.aborted ? UNKNOWN_DECISION : await candidate.previewAdmission?.({
      provider, model, job, jobId: offer.jobId ?? job.id, automatic, ownerAbsent,
      intentOn: saved.intent === 'on', paused: saved.paused === true,
    }, options) ?? UNKNOWN_DECISION;
    const reason = out.reason ?? out.objective?.reasonCode ?? 'objective_evidence_unknown';
    const usageUnknown = ['reading_stale', 'reading_unknown'].includes(reason) ||
      (reason === 'resource_unknown' && out.inputs?.windows?.some(window =>
        window.usedMicro === null || window.observedAt === null));
    const reasonCode = usageUnknown ? 'objective_usage_unknown' : reason === 'resource_reset_margin'
      ? 'objective_reset' : out.objective?.reasonCode ?? reason;
    const reasonText = out.objective?.reasonText ?? lendingStatus({admitted: out.admitted === true,
      reason: usageUnknown ? 'usage_unknown' : reason, detail:out.detail}).line;
    return {admitted: out.admitted === true, reason, reasonCode, reasonText,
      policyVersion: out.objective?.policyVersion ?? 'objective/m1',
      resource: provider, model, effort: job.budget_v1?.effort ?? job.effort ?? null,
      inputs: out.inputs ?? null};
  }

  async function buildView() {
    const accounts = [];
    for (const provider of ['claude', 'codex']) {
      const lastJobDecision = candidate.lastJobDecisionFor?.(provider) ?? null;
      const saved = settings() ?? {};
      const mode = saved.modes?.[saved.activeCircle] ?? 'ask';
      // No saved automatic consent means each job still needs the owner's approval.
      // This changes only the jobless projection, never admission or saved consent.
      const automatic = mode === 'auto' && runtimeContext(provider).consent;
      // Status never samples external presence or starts a quota observation.
      const presenceFresh = ownerActiveAt !== null && now() >= ownerActiveAt && now() - ownerActiveAt <= 30_000;
      const ownerActiveNow = presenceFresh ? ownerActive : null;
      let projection = null;
      try {
        projection = await candidate.projectStatus?.({provider, plan: contextPlan(provider),
          automatic, ownerAbsent: saved.limits?.idleOnly!==true || ownerActiveNow === false, snapshotOnly: true}) ?? null;
      } catch { /* A failed snapshot stays unknown; the last job is kept separately. */ }
      projection ??= UNKNOWN_DECISION;
      let reason = projection.reason ?? projection.reasonCode ?? projection.objective?.reasonCode ?? 'objective_evidence_unknown';
      const active = [...activeJobs.values()].includes(provider);
      // A corrupt owner limit already blocks every job. Do not wait on quota reads for that hold.
      let read = null;
      // Explicit caller contract: local snapshot only. Never fall back to readOverride/observe.
      if (reason !== 'owner_settings_unreadable' && typeof statusRead === 'function') {
        try { read = await statusRead(provider); } catch { /* unavailable local snapshot */ }
      }
      // Ready needs one observation. With no display windows there is nothing to mix, so the decision stands. When display windows
      // exist and are not the decision's own, the account keeps its last-known usage and its readiness becomes unknown.
      if (projection.admitted === true && Array.isArray(read?.windows) && read.windows.length > 0 && !windowsAlignWith(projection.objective, read.windows)) {
        projection = {...projection, admitted: false, reason: 'usage_unknown',
          objective: projection.objective ? {...projection.objective, admission: 'held', reasonCode: 'usage_unknown'} : null};
        reason = 'usage_unknown';
      }
      // Concrete fresh readiness wins; only evidence a jobless view cannot answer falls back to history.
      const assessedHold = lastJobDecision?.admitted === false ? lastJobDecision : null;
      const currentOwnerHold = ['owner_settings_unreadable','paused','stopped','owner_present','identity_unknown','budget_too_small'].includes(reason);
      const assessedReason = assessedHold?.reason ?? assessedHold?.objective?.reasonCode;
      const evidenceHold = ['objective_evidence_unknown','objective_evidence_invalid','friend_value_unknown',
        'chunk_value_unknown','owner_scenarios_unknown','demand_model_unavailable','demand_model_invalid'].includes(assessedReason);
      const joblessEvidencePreview = projection.admitted === true && reason === 'objective_lend'
        && projection.objective?.strategyId === 'manual_approval' && evidenceHold;
      const retainAssessment = reason === 'objective_evidence_unknown' || joblessEvidencePreview;
      const currentProjection = active && lastJobDecision?.admitted === true ? lastJobDecision
        : currentOwnerHold ? projection : retainAssessment ? assessedHold ?? projection : projection;
      const currentReason = currentProjection.reason ?? currentProjection.reasonCode ?? currentProjection.objective?.reasonCode ?? 'objective_evidence_unknown';
      const publicOne = publicObjective(currentProjection.objective);
      const availabilityObjective = publicObjective(projection.objective);
      const admitted = currentProjection.admitted === true;
      const availabilityAdmitted = projection.admitted === true;
      // The status line is the reason the app shows. The engine's own text is kept only for an admitted job, where it has no hold wording.
      // Present tense comes from the lifecycle: a reservation this runtime holds for the provider. The quote alone does not lend.
      // History only when the current snapshot has no answer of its own. A snapshot that already names a hold (for example
      // refresh_failed read just now) is the account's current status, not a retained job.
      const retained = !active && assessedHold !== null && currentProjection === assessedHold
        && retainAssessment;
      let status = lendingStatus({admitted, active, reason:currentReason, approvalRequired: !automatic,
        conversion: publicOne?.conversion ?? currentProjection.conversion ?? null,
        protectionSource: publicOne?.protectionSource ?? null,
        detail: currentReason === 'budget_too_small' ? publicOne?.budgetLimit : currentReason === 'exceeds_spare' ? {needUsd: publicOne?.requestedUsd, spareUsd: publicOne?.maximumExposureUsd} : currentProjection.detail,
        lendingOn: saved.enabled === true || saved.intent === 'on', intentOn: saved.intent === 'on'});
      if (retained && saved.enabled === true && saved.intent === 'on')
        status = retainedJobStatus({status, assessedAt:currentProjection.assessedAt, probe:currentProjection.probe, includeAge:false});
      const availabilityStatus = lendingStatus({admitted:availabilityAdmitted, reason, approvalRequired: !automatic,
        conversion:availabilityObjective?.conversion ?? projection.conversion ?? null,
        protectionSource:availabilityObjective?.protectionSource ?? null,
        detail:reason === 'budget_too_small' ? availabilityObjective?.budgetLimit : reason === 'exceeds_spare' ? {needUsd:availabilityObjective?.requestedUsd,
          spareUsd:availabilityObjective?.maximumExposureUsd} : projection.detail,
        lendingOn:saved.enabled === true || saved.intent === 'on', intentOn:saved.intent === 'on'});
      const objective = publicOne
        ? {...publicOne, reasonText: status.line, ...(admitted ? {detail: publicOne.reasonText} : {})}
        : {schemaVersion: 1, policyVersion: 'objective/m1', admission: admitted ? 'allowed' : 'held',
          reasonCode: currentReason, reasonText: status.line, protectionSource: null};
      const availableObjective = availabilityObjective
        ? {...availabilityObjective, reasonText:availabilityStatus.line,
          ...(availabilityAdmitted ? {detail:availabilityObjective.reasonText} : {})}
        : {schemaVersion: 1, policyVersion: 'objective/m1', admission: availabilityAdmitted ? 'allowed' : 'held',
          reasonCode:reason, reasonText:availabilityStatus.line, protectionSource:null};
      // The request status may be a retained job observed earlier than the fresh reading. Its windows are its own, and only when they
      // match its objective; the fresh display windows stay with the fresh availability below.
      const decisionWindows = currentProjection === projection ? read?.windows ?? []
        : windowsAlignWith(publicOne, currentProjection.windows) ? currentProjection.windows : [];
      const current = {...currentProjection, objective, status, windows: decisionWindows,
        strategy: saved.limits?.lendingPolicy?.strategy ?? 'automatic', admitted, reason:currentReason};
      const availability = {...projection, objective:availableObjective, status:availabilityStatus,
        windows:read?.windows ?? [], admitted:availabilityAdmitted, reason};
      const lastJobStatus = assessedHold ? retainedJobStatus({
        status: lendingStatus({reason:assessedReason}), assessedAt:assessedHold.assessedAt,
        probe:assessedHold.probe, includeAge:false}) : null;
      const decision = {...current, availability, lastJobDecision, lastJobStatus,
        assessmentSource:retained ? 'last_job' : 'current'};
      accounts.push({id: provider, provider, label: provider === 'claude' ? 'Claude' : 'Codex',
        plan: read?.plan ?? saved.limits?.lendingPolicy?.accountPlans?.[provider] ?? 'unknown',
        probe_outcome:read?.probe_outcome??null, decision, readings: read?.windows ?? [], jobCount: 0, pointsPerJobHour: null, backtest: null});
    }
    // The dial the owner chose, with its copy and the one-time explainer that ships with it.
    const position = settings()?.limits?.lendingPolicy?.protectionPosition ?? DEFAULT_PROTECTION;
    const engineDial = PROTECTION_POSITIONS[position] ?? PROTECTION_POSITIONS[DEFAULT_PROTECTION];
    const dial = {position, label: engineDial.label, epsilon: engineDial.epsilon, ...(DIALS[position] ?? DIALS[DEFAULT_PROTECTION]),
      explainer: EXPLAINER, limit: LIMIT};
    return {accounts, dial, machineCapacity: machineCapacity({ramBytes: totalmem(), cpus: availableParallelism(), memoryMb: 4096, cpu: 2}),
      watchOnly: false, shadow: [], migration: settings()?.lendingPolicyMigration?.acknowledged === false
        ? settings().lendingPolicyMigration : null};
  }

  // The newest completed snapshot wins: an older view that finishes after a newer one has settled returns that newer snapshot.
  let viewSeq = 0, settledSeq = 0, settledView = null;
  async function sequencedView() {
    const seq = ++viewSeq;
    const built = await buildView();
    if (seq < settledSeq) return settledView;
    settledSeq = seq;
    settledView = built;
    return built;
  }

  return {
    pace50: durable,
    candidate,
    manager,
    readings,
    refreshCapacity,
    // One validated local revision; never observe, refresh, reserve or persist.
    attemptEvidence(attemptId) {
      return attemptEvidenceFromState(durable?.state(), attemptId);
    },
    previewAdmission,
    cancelObservations: () => candidate.cancelObservations?.(),
    samplePresence,
    // The highest effort a friend may ask this lender for (the saved Lend setting).
    effortMax: () => settings()?.limits?.lendingPolicy?.effortMax ?? 'high',
    busy: (provider, excludingAttemptId = null) => [...activeJobs].some(([attemptId, active]) =>
      attemptId !== excludingAttemptId && (provider === undefined || active === provider)),
    async reserve(args) {
      const result = await manager.reserve(args);
      if (result?.ok) activeJobs.set(args.attemptId, args.provider);
      return result;
    },
    async finish(args) {
      try { return await manager.finish(args); }
      finally { activeJobs.delete(args.attemptId); }
    },
    async release(attemptId, args = {}) {
      try { return await manager.release(attemptId, args); }
      finally { if (attemptId) activeJobs.delete(attemptId); }
    },
    async reconcileAttempt() {
      return {applied: false, reason: 'durable_candidate_owns_reconciliation'};
    },
    observe() {},
    view: () => sequencedView(),
    start() {
      samplePresence().catch(() => {});
      timer = setInterval(() => {
        samplePresence().catch(() => {});
        if (!closed) candidate.probeHeld?.().catch(() => {});
        const saved = settings() ?? {};
        if (!closed && saved.enabled === true && saved.intent === 'on' && saved.paused !== true) {
          for (const [provider, harness] of [['claude', 'claude-code-subscription'], ['codex', 'codex']]) {
            if (saved.agents?.[harness] !== true || saved.lendingAuth?.[harness] !== true || [...activeJobs.values()].includes(provider)) continue;
            // The non-forced source owns cadence and provider backoff; admission only reads its cache.
            const plan = contextPlan(provider);
            candidate.observe({provider, model:statusRunModel(provider), plan, now:now(), forceRefresh:false}).catch(() => {});
          }
        }
      }, 30_000);
      timer.unref?.();
    },
    async close({drainMs = 100} = {}) {
      closed = true;
      clearInterval(timer);
      const results = await Promise.allSettled([durable?.close({drainMs}), candidate.cancelObservations?.()]);
      let liveAttempts = [...activeJobs.keys()], captureDrainComplete = false;
      try {
        for (const result of results) if (result.status === 'rejected') throw result.reason;
        liveAttempts = results[0].value?.live_attempts ?? liveAttempts;
      } finally {
        try { measurementHistory?.record?.('capture_epoch_ended', {}); } catch { /* Capture failure cannot block shutdown. */ }
        try { captureDrainComplete = await (measurementHistory?.flush?.({timeoutMs: drainMs}) ?? true) !== false; }
        catch { captureDrainComplete = false; }
        try { measurementHistory?.close?.(); } catch { /* Capture cleanup cannot block shutdown. */ }
      }
      return {live_attempts: liveAttempts, capture_drain_complete: captureDrainComplete};
    },
  };
}
