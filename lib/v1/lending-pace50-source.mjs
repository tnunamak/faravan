// Trusted evidence seam for the estimated-pace50 candidate. It turns what the app can observe into
// the policy input, and it refuses by name for every fact that is missing or ambiguous.
//
// The real source below reports unknown for everything it cannot establish: a verified account
// identity, the account-week and epoch, subscription-only funding, single-executor ownership, a
// bounded stop, and the conversion from usage to policy units. The policy then refuses with its own
// reason. Nothing here turns a provider label into an identity, and nothing defaults to ready.
//
// Owner absence, consent and caps come from the caller's context (app settings and the lender's own
// pre-claim decision), never from a request body. Synthetic evidence for tests is a separate
// implementation of the same `observe` and `convertUsage` methods, injected by startup options only.
import kappaCalibration from './lending-kappa-calibration.json' with {type: 'json'};
import {DEFAULT_RUN_MODEL, priceRowFor} from './lending-meter.mjs';
import {MEASURED_LABEL} from './lending-kappa-measure.mjs';
import {PROVIDER_PERCENT_UNCERTAINTY_MICRO} from './quota-registry.mjs';
import {RESET_JITTER_MS} from './window-origin.mjs';

const MICRO = 1000000;
const WEEKLY_MINUTES = 300; // a window longer than five hours is the weekly kind

const timestamp = (value) => (typeof value === 'number' ? value : Date.parse(value));
// Flooring helps normalize ordinary reset noise, but noise can cross a second boundary; active windows are aligned to a known instance below.
const wholeSecond = (ms) => (Number.isFinite(ms) ? Math.floor(ms / 1000) * 1000 : ms);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;

import {sanitizeProbeFailure, isDeferredObservation, READING_STALE_MS, STOP_ANSWER_MS} from './lending-probe.mjs';
import {STOP_EVIDENCE_TTL_MS} from './stop-evidence.mjs';
export {sanitizeProbeFailure};

export {readingSpendRate, readingAgeReserve, readingHeadroomMs} from './lending-reading-age.mjs';

// Maps normalized readings to pace50 resources. Unplaceable readings keep the roster incomplete.
export function resourcesFromReadings(windows = []) {
  const resources = [];
  const ids = new Set();
  let complete = true;
  for (const window of Array.isArray(windows) ? windows : []) {
    const minutes = window?.window_minutes;
    // Without a saved matching row, flooring is only a provisional label; it cannot absorb noise across a second boundary.
    const resetAt = wholeSecond(timestamp(window?.resets_at));
    const observedAt = timestamp(window?.observed_at);
    const kind = Number.isFinite(minutes) && minutes > WEEKLY_MINUTES ? 'weekly'
      : Number.isFinite(minutes) && minutes > 0 ? 'short' : null;
    const usable = kind !== null && !(kind === 'weekly' && window.cold_open === true) && nonempty(window?.window_id) && !ids.has(window.window_id) &&
      Number.isSafeInteger(resetAt) && Number.isSafeInteger(observedAt) &&
      Number.isFinite(window.used_pct) && window.used_pct >= 0 && window.used_pct <= 100;
    if (!usable) {
      complete = false;
      continue;
    }
    ids.add(window.window_id);
    const durationMs = minutes * 60000;
    const anchorAt = resetAt - durationMs;
    const ownerUsedPct = Number.isFinite(window.owner_used_pct) && window.owner_used_pct >= 0 && window.owner_used_pct <= 100
      ? window.owner_used_pct : window.used_pct;
    resources.push({
      id: window.window_id,
      kind,
      // The reset time identifies the window instance. The duration is the provider's stated length.
      instance: `${window.window_id}@${resetAt}`,
      state: ['open', 'not_open'].includes(window.state) ? window.state : 'unknown',
      anchor_at: resetAt - durationMs,
      resets_at: resetAt,
      duration_ms: durationMs,
      observed_at: observedAt,
      ...(Number.isFinite(window.max_rate_pct_per_hour) ? {max_rate_pct_per_hour:window.max_rate_pct_per_hour} : {}),
      used_micro: Math.ceil(Number((window.used_pct * MICRO).toFixed(6))),
      owner_used_micro: Math.ceil(Number((ownerUsedPct * MICRO).toFixed(6))),
      // Provider readings report whole percentage points. This is measurement
      // uncertainty, not a lending-volume ceiling.
      uncertainty_micro: PROVIDER_PERCENT_UNCERTAINTY_MICRO,
      // Unknown until a verified conversion exists. The policy and this seam both refuse on null.
      kappa_micro: null,
      kappa_lower_micro: null,
      origin: null,
      ...(window.cold_open === true ? {cold_open: true} : {}),
    });
  }
  return {complete: complete && resources.some((r) => r.kind === 'weekly'), resources};
}

// A short window the provider reports as not open (Claude's `five_hour: null`) has no use and no reset yet. It opens at the
// next use, the lent job's or the owner's, and resets one window length after that. This run read it at `observedAt`, and
// any first use comes at or after that read, so `observedAt` + the window length is no later than the real reset. That is
// the reading the policy is given: 0 used, reset at that bound. An earlier reset is the conservative side for every reset
// check (the margin before the reset, the hold at the earliest reset, the stop at the reserved reset). It understates the
// owner's share of the short window by the delay from this read to the first use. That delay has no bound of its own, so the
// lender bounds the error instead: when the window opens later than the reset jitter after this bound, the job runs on only
// if its admission passes again against the opened window (lender-pace50 recheckBound).
// Only an explicit not-open row of this same run counts: a stale row is unknown in the ledger snapshot already, a missing
// window has no row, and a weekly window is never opened this way.
export function coldOpenWindows(windows = [], observedAt) {
  return (Array.isArray(windows) ? windows : []).map((w) => {
    const minutes = w?.window_minutes;
    const cold = w?.state === 'not_open' && w.source === 'probe' && w.used_pct === 0 && w.resets_at == null &&
      Number.isFinite(minutes) && minutes > 0 && minutes <= WEEKLY_MINUTES &&
      Number.isSafeInteger(observedAt) && timestamp(w.observed_at) === observedAt;
    return cold ? {...w, state: 'open', resets_at: observedAt + minutes * 60000, cold_open: true} : w;
  });
}

// Subscription-only funding is proven only when the provider's own extra-usage reading is explicitly disabled AND the
// guest's CLI reports the claude.ai login on the first-party provider. Any other value stays unknown with a named reason.
// Identity is a separate fact and is not established here.
export function claudeSubscriptionFunding({extraUsage, guestAuth} = {}) {
  const unknown = (reason) => ({subscription_only: 'unknown', reason});
  if (extraUsage === 'enabled') return unknown('extra_usage_enabled');
  if (extraUsage !== 'disabled') return unknown('extra_usage_unobserved');
  if (guestAuth?.loggedIn !== true || guestAuth?.authMethod !== 'claude.ai') return unknown('guest_auth_not_claude_ai');
  if (guestAuth.apiProvider === undefined || guestAuth.apiProvider === null) return unknown('guest_provider_unobserved');
  if (guestAuth.apiProvider !== 'firstParty') return unknown('alternative_api_provider');
  return {subscription_only: 'proven', reason: null};
}

// Codex has no extra-usage switch. Its usage reply names the ChatGPT plan, and whether the account has reached its limit or its
// spend control. A subscription plan below its limit is running on the plan's included usage: Codex spends purchased credits only
// after that usage runs out, and lending stops well before the limit. Any other plan, a reached limit, or a missing reading is unknown.
export const CODEX_SUBSCRIPTION_PLANS = Object.freeze(['plus', 'pro', 'team', 'business', 'enterprise', 'edu']);
export function codexSubscriptionFunding(plan) {
  const unknown = (reason) => ({subscription_only: 'unknown', reason});
  if (!plan || typeof plan.plan_type !== 'string') return unknown('plan_unobserved');
  if (!CODEX_SUBSCRIPTION_PLANS.includes(plan.plan_type)) return unknown('plan_not_subscription');
  if (plan.limit_reached === true) return unknown('limit_reached');
  if (plan.limit_reached !== false) return unknown('limit_unobserved');
  return {subscription_only: 'proven', reason: null};
}

// Identity admits only on a stable account id or an e-mail hash, compared with what the owner enrolled. Both sides are
// hashes from the guest, so no raw e-mail or identifier is compared or stored. A match verifies; a mismatch or any
// missing side refuses with its own reason.
export function claudeAccountMatch(observed, expected) {
  const unknown = (reason) => ({verified: false, reason});
  if (!observed?.account_sha256_16 || !observed?.email_sha256_16) return unknown('identity_unobserved');
  if (!expected) return unknown('expected_identity_unknown');
  const matched = () => ({verified: true, account_id: observed.account_sha256_16, reason: null});
  if (expected.account_sha256_16) return observed.account_sha256_16 === expected.account_sha256_16 ? matched() : unknown('identity_mismatch');
  if (expected.email_sha256_16) return observed.email_sha256_16 === expected.email_sha256_16 ? matched() : unknown('identity_mismatch');
  return unknown('expected_identity_unknown');
}

// The account week and epoch are the weekly window's identity, observed in the same run as the verified account. The reset
// instant identifies the week, and a reset changes the epoch. No verified account or no weekly window means no week.
export function weeklyWindowIdentity({resources = [], identity = null} = {}) {
  const weekly = resources.find((r) => r.kind === 'weekly');
  if (identity?.verified !== true || !nonempty(identity.account_id) || !weekly) return {account_week_id: null, epoch: null};
  return {account_week_id: `${identity.account_id}:weekly:${weekly.resets_at}`, epoch: weekly.instance};
}

// The executor is proven only when the backend that ran the probe is the expected one and its version is accepted.
// `expected.accepts` is the product's own version check, passed in so this module stays free of the sandbox code.
export function executorProof(executor, expected) {
  const unknown = (reason) => ({single_executor: 'unknown', reason});
  if (!expected || typeof expected.accepts !== 'function' || !nonempty(expected.backend_id)) return unknown('expected_executor_unknown');
  if (executor?.backend_id !== expected.backend_id) return unknown('executor_backend_mismatch');
  if (typeof executor.sbx_version !== 'string' || !expected.accepts(executor.sbx_version)) return unknown('executor_version_unaccepted');
  return {single_executor: 'proven', reason: null};
}

// The bound on a future Stop is the deadline the app itself enforces on a Stop, and the configured bound must cover it. That is
// a check on configuration, not on a sample: the guarded Stop waits `answerMs` for the run to end, then hard-stops it
// (lib/docker-backend.mjs:2728-2742 requestStop; the stop check passes STOP_ANSWER_MS, stop-check.mjs). Stop has no poll (a promise race, no interval, docker-backend.mjs:2737), so the poll allowance is 0. The deadline timer
// and every comparison of the proof's age run on the lender's own clock (lending-probe.mjs:360 stamps the receipt from host time; lender-pace50.mjs:301 compares it),
// so the clock allowance is 0. A past receipt shows the mechanism works (delivered, hard stop not needed, sandbox removed). Its latency can
// only refute a proof (over the bound); it never certifies or sets the bound. The remainder (bound - answerMs) is the time left for
// the hard stop and the removal after the deadline. That remainder is an assumption: nothing enforces it yet.
// An unproven result keeps the measured facts it was judged on, so a refusal can say which check failed and by how much.
export function stopProof(stop, boundMs, answerMs) {
  const bound = Number.isFinite(boundMs) && boundMs > 0 ? boundMs : null;
  const measured = stop ? {delivered: stop.delivered === true, fallback: stop.fallback ?? null,
    latency_ms: Number.isFinite(stop.latency_ms) ? stop.latency_ms : null, bound_ms: bound, removed: stop.removed === true} : null;
  const unknown = (reason) => ({bounded_execution: 'unknown', reason, measured});
  if (!bound) return unknown('stop_bound_unconfigured');
  if (!Number.isFinite(answerMs) || answerMs <= 0) return unknown('stop_answer_deadline_unknown');
  if (bound < answerMs) return unknown('stop_bound_below_answer_deadline');
  if (!stop) return unknown('stop_unmeasured');
  if (stop.delivered !== true || stop.fallback !== null) return unknown('stop_not_delivered');
  if (!Number.isFinite(stop.latency_ms) || stop.latency_ms < 0 || stop.latency_ms > bound) return unknown('stop_latency_over_bound');
  if (stop.removed !== true) return unknown('stop_removal_unverified');
  return {bounded_execution: 'proven', reason: null, uncertainty_ms: bound - answerMs};
}

// Shipped bound lookup for one named plan.
export function certifiedKappa({provider, plan, window, model} = {}) {
  const row = kappaCalibration.entries.find(entry => entry.provider === provider && entry.plan === plan &&
    entry.window === window && entry.model === model);
  if (!row || !Number.isSafeInteger(row.upperMicro) || row.upperMicro <= 0 ||
      !nonempty(row.provenance?.method) || !nonempty(row.provenance?.boundReport) ||
      !nonempty(row.provenance?.acceptedBy)) return null;
  return {upper_micro: row.upperMicro, lower_micro: null, provenance: structuredClone(row.provenance)};
}

// The largest shipped bound for this provider, window and model over every plan. It is a floor under a measurement,
// never a rate on its own: a plan label does not prove which allowance the account has.
export function certifiedFloor({provider, window, model} = {}) {
  const bounds = kappaCalibration.entries.filter(entry => entry.provider === provider && entry.window === window &&
    entry.model === model).map(certifiedKappa).filter(Boolean);
  if (!bounds.length) return null;
  const top = bounds.reduce((a, b) => b.upper_micro > a.upper_micro ? b : a);
  return {...top, provenance: {...top.provenance, label: 'shipped bound'}};
}

// A window's origin is only ever owner or lending. Anything else, including a missing map, is unknown.
function originFor(origins, id) {
  const origin = origins?.get?.(id);
  return origin === 'owner' || origin === 'lending' ? origin : null;
}

// The real provider observation. Funding, identity, executor and stop are taken only from the same probe run that produced
// the windows, and conversion from a calibration. A reading from another run is not this run's fact. Anything missing is unknown.
export function createRealPace50Source({readings, funding = () => null, expectedIdentity = () => null,
  expectedExecutor = null, stopEvidence = () => null, stopBoundMs = null, stopAnswerMs = STOP_ANSWER_MS,
  windowOrigin = () => null, kappaForUsage = null, kappaFloor = certifiedFloor, learningOn = () => true,
  measurementExpired = () => false, creatorUnknown = () => false}) {
  if (typeof readings !== 'function') throw new TypeError('the real pace50 source needs a readings function');
  const cancelled = provider => ({refresh_succeeded: false, complete: false, resources: [], identity: {verified: false},
    account_week_id: null, epoch: null, funding: {subscription_only: 'unknown'}, executor: {single_executor: 'unknown'},
    stop: {bounded_execution: 'unknown'}, stop_bound_ms: null, uncertainty_ms: null, probe: sanitizeProbeFailure({reason:'cancelled'}, provider)});
  return {
    kind: 'real',
    admissionEvidence(observation, provider, accountKey = provider) {
      const snapshot = readings.cached?.(accountKey);
      // A newer successful read supersedes the sampled one, including its account and plan.
      const superseded = snapshot?.evidence_generation != null && observation?.evidence_generation != null &&
        snapshot.evidence_generation !== observation.evidence_generation;
      return {...observation, latest_attempt: superseded ? {outcome:'failed', reason:'evidence_superseded'}
        : snapshot?.latest_attempt ?? observation?.latest_attempt};
    },
    // Required account and machine evidence is independent of allowance
    // availability. This is a local read; it never requests a usage probe.
    async machineEvidence({provider,signal}) {
      const expected=await Promise.resolve().then(()=>typeof expectedExecutor==='function'?expectedExecutor(provider,{signal}):expectedExecutor).catch(()=>null);
      const receipt=await Promise.resolve().then(()=>stopEvidence(provider,{signal})).catch(()=>null);
      return {executor:executorProof(receipt?.executor??null,expected),stop:stopProof(receipt?.stop??null,stopBoundMs,stopAnswerMs)};
    },
    async requiredEvidence({provider,accountKey=provider,signal}) {
      const [fact,expected,executorExpected,receipt]=await Promise.all([
        Promise.resolve().then(()=>funding(accountKey)).catch(()=>null),
        Promise.resolve().then(()=>expectedIdentity(accountKey,{signal})).catch(()=>null),
        Promise.resolve().then(()=>typeof expectedExecutor==='function'?expectedExecutor(provider,{signal}):expectedExecutor).catch(()=>null),
        Promise.resolve().then(()=>stopEvidence(provider,{signal})).catch(()=>null),
      ]);
      if(signal?.aborted)return cancelled(provider);
      return {identity:claudeAccountMatch(fact?.identity??null,expected),
        funding:provider==='codex'?codexSubscriptionFunding(fact?.codex_plan):
          claudeSubscriptionFunding({extraUsage:fact?.extra_usage,guestAuth:fact?.guest_auth}),
        executor:executorProof(receipt?.executor??null,executorExpected),
        stop:stopProof(receipt?.stop??null,stopBoundMs,stopAnswerMs)};
    },
    stopBoundMs,
    uncertaintyMs: Number.isFinite(stopBoundMs) && stopBoundMs >= stopAnswerMs ? stopBoundMs - stopAnswerMs : 0,
    // `guardRead` is the native guard's own host read context for a running lent job (createLendingReadings).
    async observe({provider, accountKey = provider, model = null, plan = null, signal, forceRefresh = false, maxAgeMs = null, guardRead = null,
      excludingAttemptId = null, admissionOnly = false, knownWindows = []}) {
      if (signal?.aborted) return cancelled(provider);
      // Only admission can normalize retained account facts. A live guard must
      // use the ordinary failed/deferred observation path even if a caller also
      // supplied the admission flag.
      admissionOnly = admissionOnly && guardRead == null;
      let snapshot;
      try {
        // The readings, funding and identity facts are kept per account key. The first account's key is its provider; another
        // account has its own, and never borrows the first account's.
        snapshot = admissionOnly && typeof readings.cached === 'function' ? readings.cached(accountKey)
          : await readings(accountKey, {signal, forceRefresh, maxAgeMs, excludingAttemptId, admissionOnly, ...(guardRead ? {guardRead} : {})});
      } catch {
        if (signal?.aborted) return cancelled(provider);
        return {refresh_succeeded: false, complete: false, resources: [], identity: {verified: false},
          account_week_id: null, epoch: null, funding: {subscription_only: 'unknown'},
          executor: {single_executor: 'unknown'}, stop: {bounded_execution: 'unknown'},
          stop_bound_ms: null, uncertainty_ms: null, probe: sanitizeProbeFailure({reason:'guest_failed'}, provider)};
      }
      if (signal?.aborted) return cancelled(provider);
      if (isDeferredObservation(snapshot)) {
        return {...cancelled(provider), refresh_outcome:'deferred', probe:sanitizeProbeFailure(snapshot.probe, provider)};
      }
      // Admission may reuse successful windows after a refresh failure. The same-run
      // funding and identity checks below still bind those windows; live guard reads cannot reuse them.
      if (!snapshot || snapshot.refresh_outcome === 'deferred' || (snapshot.refresh_succeeded === false && !admissionOnly) || !Array.isArray(snapshot.windows) || snapshot.windows.length === 0) {
        return {refresh_succeeded: false, complete: false, resources: [], identity: {verified: false},
          account_week_id: null, epoch: null, funding: {subscription_only: 'unknown'},
          executor: {single_executor: 'unknown'}, stop: {bounded_execution: 'unknown'},
          stop_bound_ms: null, uncertainty_ms: null, probe: sanitizeProbeFailure(snapshot?.probe ?? (snapshot?.refresh_succeeded === false ? {reason:'guest_failed'} : null), provider)};
      }
      const fact = await Promise.resolve().then(() => funding(accountKey)).catch(() => null);
      const roster = resourcesFromReadings(coldOpenWindows(snapshot?.windows, fact?.observed_at));
      const known = Array.isArray(knownWindows) ? knownWindows : [];
      const resources = roster.resources.map(resource => {
        const prior = known.find(window => window?.id === resource.id && window.kind === resource.kind &&
          Number.isSafeInteger(window.resets_at) && Math.abs(window.resets_at - resource.resets_at) <= RESET_JITTER_MS &&
          typeof window.instance === 'string' && Number.isSafeInteger(window.anchor_at));
        if (!prior) return resource;
        return {...resource, instance: prior.instance, anchor_at: prior.anchor_at, resets_at: prior.resets_at};
      });
      // The run's facts belong to the windows that run read. A window the provider left out of that reply keeps an older
      // reading; it makes the roster incomplete, but it does not make this run's identity, funding, executor or stop unknown.
      const sameRun = Boolean(fact) && resources.some((r) => r.observed_at === fact.observed_at);
      // Admission reads the saved reading and never waits for a probe. A short window that was not open counts only for
      // READING_STALE_MS after its probe; later it is unknown, and the roster is incomplete until the next probe. While the saved
      // reading is that old, ask for a fresh one and hold with pending evidence, as when no window is from this run. A fresh
      // reading that still lacks a window is a real gap and keeps the resources_incomplete refusal.
      const staleReading = Number.isFinite(snapshot.age_ms) && snapshot.age_ms >= READING_STALE_MS;
      const pending = !sameRun || (admissionOnly && !roster.complete && staleReading);
      if (pending && admissionOnly) readings.requestRefresh?.(accountKey);
      const complete = roster.complete && (!sameRun || resources.every((r) => r.observed_at === fact.observed_at));
      const subscription = !sameRun ? {subscription_only: 'unknown', reason: 'funding_unobserved'}
        : provider === 'codex' ? codexSubscriptionFunding(fact.codex_plan)
          : claudeSubscriptionFunding({extraUsage: fact.extra_usage, guestAuth: fact.guest_auth});
      // Only same-run provider evidence can name the account's plan. Unknown named plans
      // remain uncalibrated; an owner setting must never substitute a cheaper conversion.
      const providerPlan = provider === 'codex' && sameRun && nonempty(fact.codex_plan?.plan_type)
        ? fact.codex_plan.plan_type : null;
      const ownerPlan = nonempty(plan) && plan !== 'unknown' ? plan : null;
      // Keep owner preference separate: it is not evidence of a Codex plan.
      const accountPlan = provider === 'codex'
        ? CODEX_SUBSCRIPTION_PLANS.includes(providerPlan) ? providerPlan : null
        : ownerPlan;
      const planSource = accountPlan === null ? null : provider === 'codex' ? 'provider' : 'owner';
      const expected = await Promise.resolve().then(() => expectedIdentity(accountKey, {signal})).catch(() => null);
      if (signal?.aborted) return cancelled(provider);
      const identity = sameRun ? claudeAccountMatch(fact.identity ?? null, expected) : {verified: false, reason: 'identity_unobserved'};
      const identityOut = identity.verified ? {verified: true, account_id: identity.account_id, reason: null} : {verified: false, reason: identity.reason};
      const executorExpected = await Promise.resolve().then(() => typeof expectedExecutor === 'function'
        ? expectedExecutor(provider, {signal}) : expectedExecutor).catch(() => null);
      if (signal?.aborted) return cancelled(provider);
      // Executor and stop come from the machine's stop receipt (stop-evidence.mjs), never from this account's reading. A reading
      // carries neither, so it can never prove them.
      const receipt = stopEvidence ? await Promise.resolve().then(() => stopEvidence(provider, {signal})).catch(() => null) : null;
      if (signal?.aborted) return cancelled(provider);
      const executor = receipt ? executorProof(receipt.executor ?? null, executorExpected) : {single_executor: 'unknown', reason: 'executor_unobserved'};
      const stop = receipt ? stopProof(receipt.stop ?? null, stopBoundMs, stopAnswerMs) : {bounded_execution: 'unknown', reason: 'stop_unobserved'};
      const week = weeklyWindowIdentity({resources, identity: identityOut});
      // The origin of a window is the durable record of who opened it. A failed or absent read stays unknown.
      const origins = await Promise.resolve().then(() => windowOrigin(provider, resources)).catch(() => null);
      if (signal?.aborted) return cancelled(provider);
      // A job that names no model runs the default one, so its conversion is that model's, not unknown.
      const priceModel = model ?? DEFAULT_RUN_MODEL[provider] ?? null;
      const learning = [];
      const converted = resources.map((r) => {
        const window = r.kind === 'weekly' ? 'weekly' : r.kind === 'short' ? 'five_hour' : 'model';
        // A window converts only by this account's own measurement, from its own use. The plan is a label and never chooses a rate.
        // A measurement made on another account is not this account's. A shipped bound for the same provider, window and model is a
        // floor: the larger rate wins. A model with no list price cannot be converted at any rate.
        const accountId = identityOut.verified === true && priceRowFor(priceModel ?? '') ? identityOut.account_id : null;
        const candidate = accountId ? kappaForUsage?.({account: accountKey, account_id: accountId, provider,
          resource: `${provider}:${r.id}`, window, model: priceModel}) : null;
        const measured = candidate?.binding?.account_sha256_16 === accountId &&
          Number.isSafeInteger(candidate.upper_micro) && candidate.upper_micro > 0 ? candidate : null;
        const rejection = candidate != null && measured === null ? 'binding_mismatch' : null;
        const floor = measured && kappaFloor?.({provider, window, model: priceModel});
        const selected = floor && floor.upper_micro > measured.upper_micro ? floor : measured;
        // No measurement is not a hold. The window lends in its own points, guarded by its own live meter, and the conversion
        // comes only from local log measurements (native-window mode). No rate is invented for it: its conversion stays null.
        // A model with no list price stays unknown: its dollar caps could not be checked, so it does not lend natively.
        // A cold window has no history to measure, so it lends only natively, guarded by its live meter.
        const native = (selected == null || r.cold_open === true) && accountId !== null;
        if (native)
          learning.push({reason: 'learning', provider, window, ...(learningOn() === false ? {learning_off: true}
            : creatorUnknown({provider, resource: `${provider}:${r.id}`}) === true ? {creator_unknown: true}
            : accountId && measurementExpired({provider, resource: `${provider}:${r.id}`, account_id: accountId}) === true ? {expired: true} : {})});
        const kappa = r.cold_open !== true && selected && {...selected, provenance:{...selected.provenance,
          label:selected.provenance?.label ?? MEASURED_LABEL}};
        return {...r,
        conversion: kappa ? 'measured' : native ? 'native_window' : null,
        kappa_micro: kappa?.upper_micro ?? null,
        kappa_lower_micro: kappa?.lower_micro ?? null,
        kappa_provenance: kappa?.provenance ?? null,
        kappa_rejection_code: rejection,
        // No one has opened a cold window yet. Whoever uses it first opens it, so it is named for that state, not for an opener.
        origin: r.cold_open === true ? 'cold' : originFor(origins, r.id)};
      });
      // One attempt's windows settle together, from the meter or from a converted burn, so the mode is all or none: when any
      // window lends natively, every window does. A measured rate is kept as evidence but does not convert this attempt.
      const anyNative = converted.some((r) => r.conversion === 'native_window');
      const moded = anyNative ? converted.map((r) => r.conversion === 'measured'
        ? {...r, conversion: 'native_window', kappa_micro: null, kappa_lower_micro: null, measured_kappa_micro: r.kappa_micro} : r)
        : converted;
      return {refresh_succeeded: !admissionOnly || sameRun, ...(pending ? {evidence_pending:true} : {}), complete, resources: moded, weekly_resource_id: resources.find((r) => r.kind === 'weekly')?.id ?? null,
        evidence_generation: snapshot.evidence_generation ?? null,
        latest_attempt: readings.cached?.(accountKey)?.latest_attempt ?? snapshot.latest_attempt ?? null,
        account_plan: {plan: accountPlan, source: planSource},
        // Windows that lend in their own points while this account's usage rate is learned. Display-only detail.
        learning,
        identity: identityOut, account_week_id: week.account_week_id, epoch: week.epoch,
        funding: {subscription_only: subscription.subscription_only, reason: subscription.reason},
        executor: {single_executor: executor.single_executor, reason: executor.reason},
        // A proven stop carries the time it stops counting, so a decision made after an await still sees it expire.
        stop: {bounded_execution: stop.bounded_execution, reason: stop.reason, ...(stop.measured ? {measured: stop.measured} : {}),
          ...(stop.bounded_execution === 'proven' && Number.isSafeInteger(receipt?.measured_at)
            ? {proven_until: receipt.measured_at + STOP_EVIDENCE_TTL_MS} : {})},
        stop_bound_ms: stop.bounded_execution === 'proven' ? stopBoundMs : null,
        uncertainty_ms: stop.bounded_execution === 'proven' ? stop.uncertainty_ms : 0, opening_anchor_known: false, resource_coupling_known: false,
        // The run's own time, which the reconciliation of a burn is measured against. Null when the run is not this run.
        observed_at: sameRun ? fact.observed_at : null,
        // The HTTP statuses of the read that produced these windows, so a refusal can say what the provider answered. Null when no read.
        probe: sanitizeProbeFailure(snapshot?.probe ?? (sameRun && !identity.verified ? {reason:'identity_failed'} : null), provider)};
    },
    // The burn of one attempt, per reserved resource: the reserved conversion times the usage, rounded up so the burn is never
    // understated. Unknown (null) when the usage or any reserved conversion is missing or not a positive integer, never zero.
    convertUsage({units_micro, resources} = {}) {
      if (!Number.isSafeInteger(units_micro) || units_micro < 0 || !Array.isArray(resources) || resources.length === 0) return null;
      const burns = resources.map((r) => {
        if (typeof r?.id !== 'string' || typeof r.instance !== 'string' ||
            !Number.isSafeInteger(r.kappa_micro) || r.kappa_micro <= 0) return null;
        const amount = (BigInt(r.kappa_micro) * BigInt(units_micro) + BigInt(MICRO - 1)) / BigInt(MICRO);
        return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? {id: r.id, instance: r.instance, amount_micro: Number(amount)} : null;
      });
      return burns.every((burn) => burn !== null) ? burns : null;
    },
  };
}

// A window either has a positive measured conversion, or is typed native-window: no conversion at all, reserved and guarded in
// its own points. A zero or negative conversion, or an untyped missing one, is unknown.
export const conversionKnown = r => r?.conversion === 'native_window' ? r.kappa_micro === null
  : Number.isSafeInteger(r?.kappa_micro) && r.kappa_micro > 0;
export const nativeWindow = r => r?.conversion === 'native_window' && r.kappa_micro === null;

// Pure mapping from an observation, the caller's context and the adapter's own durable facts to the
// policy input. The first missing fact wins, and its name is the refusal reason.
export function observationProofFailures(obs = {}) {
  if (obs.evidence_pending === true) return ['objective_evidence_unknown'];
  const failures = [];
  const check = (ok, reason) => { if (!ok) failures.push(reason); };
  if (obs.refresh_outcome === 'deferred') return [isDeferredObservation(obs) ? obs.probe.reason : 'refresh_failed'];
  check(obs.refresh_succeeded === true, 'refresh_failed');
  // A provider account other than the enrolled one is the owner's to resolve; a missing or failed check is not.
  check(obs.identity?.verified === true && nonempty(obs.identity?.account_id),
    obs.identity?.verified !== true && obs.identity?.reason === 'identity_mismatch' ? 'identity_mismatch' : 'identity_unknown');
  check(nonempty(obs.account_week_id), 'account_week_mapping_unknown');
  check(nonempty(obs.epoch), 'epoch_unknown');
  check(obs.complete === true && nonempty(obs.weekly_resource_id), 'resources_incomplete');
  check(obs.funding?.subscription_only === 'proven', 'funding_unknown');
  check(obs.executor?.single_executor === 'proven', 'executor_unknown');
  check(obs.stop?.bounded_execution === 'proven' && Number.isSafeInteger(obs.stop_bound_ms) && obs.stop_bound_ms > 0 &&
    Number.isSafeInteger(obs.uncertainty_ms) && obs.uncertainty_ms >= 0, 'stop_bound_unknown');
  check(Array.isArray(obs.resources) && obs.resources.every(r => conversionKnown(r)), 'conversion_unknown');
  return failures;
}

// The sub-reason and the measured facts behind a stop refusal. They name the failed check for a person and never change the code.
function stopRefusalDetail(obs) {
  return obs.stop?.reason ? {stopReason: obs.stop.reason, ...(obs.stop.measured ?? {})} : null;
}

export function paceInputFromObservation(observation, {now, context = {}}) {
  const obs = observation ?? {};
  const failures = observationProofFailures(obs);
  if (failures.length) {
    const detail = failures[0] === 'funding_unknown' && obs.funding?.reason === 'limit_reached' ? {fundingReason:'limit_reached'}
      : failures[0] === 'stop_bound_unknown' ? stopRefusalDetail(obs) : null;
    return {refuse: failures[0], ...(detail ? {detail} : {})};
  }
  const account = obs.identity.account_id;
  const windows = obs.resources.map((r) => ({...r, account, epoch: obs.epoch}));
  const ids = windows.map((w) => w.id);
  return {
    now,
    account,
    account_week_id: obs.account_week_id,
    epoch: obs.epoch,
    weekly_resource_id: obs.weekly_resource_id,
    windows,
    controls: {
      consent: context.consent === true,
      people: context.people === true,
      agents: context.agents === true,
      schedule: context.schedule === true,
      unexpired: context.unexpired === true,
      on: context.intent === 'on',
      paused: context.paused === true,
      owner_absent: context.ownerAbsent === true,
    },
    owner_presence_override: context.ownerPresenceOverride === true,
    evidence: {
      complete: true,
      refresh_succeeded: true,
      subscription_only: true,
      bounded_execution: true,
      single_executor: true,
      identity_compatible: true,
      resource_ids: ids,
      account_week_mapping_known: true,
      opening_anchor_known: obs.opening_anchor_known === true,
      resource_coupling_known: obs.resource_coupling_known === true,
    },
    stop_bound_ms: obs.stop_bound_ms,
    uncertainty_ms: obs.uncertainty_ms,
  };
}
