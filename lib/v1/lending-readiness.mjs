import {RUNTIME_HELP, LINES, calibrationMissingCopy, learningCopy, probeDeferralCopy, fundingHoldCopy, probeFailureCopy, usageEstimateNote} from './lending-status-copy.mjs';
export const conversionKnown = r => r?.conversion === 'native_window' ? r.kappa_micro === null
  : Number.isSafeInteger(r?.kappa_micro) && r.kappa_micro > 0;

import {isDeferredObservation} from './lending-probe.mjs';
import {DEFAULT_RUN_MODEL, priceRowFor} from './lending-meter.mjs';

// These are projections of the policy's proof predicates, never substitutes for admission.
// `accountLabel` is set when a provider has more than one account: each fix then names the account it is for.
export function lendingReadiness({signedIn, observation, provider, runtimeCheck, requiredEvidence = null, accountLabel = null}) {
  const label = typeof accountLabel === 'string' && accountLabel ? accountLabel : null;
  const seen = !observation?.evidence_pending && observation?.refresh_succeeded === true && observation?.refresh_outcome !== 'deferred';
  // Each diagnostic reads its own evidence; admission keeps its own proof list and ordering.
  const has = value => typeof value === 'string' && value.trim().length > 0;
  const obs = observation ?? {};
  const identityMismatch = obs.identity?.verified !== true && obs.identity?.reason === 'identity_mismatch';
  const identityKnown = obs.identity?.verified === true && has(obs.identity?.account_id);
  const weeklyKnown = has(obs.account_week_id) && has(obs.epoch) && obs.complete === true && has(obs.weekly_resource_id);
  const fundingKnown = obs.funding?.subscription_only === 'proven';
  const controlKnown = obs.executor?.single_executor === 'proven' && obs.stop?.bounded_execution === 'proven' &&
    Number.isSafeInteger(obs.stop_bound_ms) && obs.stop_bound_ms > 0 && Number.isSafeInteger(obs.uncertainty_ms) && obs.uncertainty_ms >= 0;
  const conversionOk = Array.isArray(obs.resources) && obs.resources.every(conversionKnown);
  const deferred = isDeferredObservation(observation) ? probeDeferralCopy(observation.probe) : null;
  const failed = probeFailureCopy(observation?.probe_outcome, {provider, accountLabel: label, retryAt: observation?.probe?.retry_at ?? null});
  const check = (id, state, lines, fix) => {
    const required=requiredEvidence&&['account','subscription','job_control'].includes(id);
    if(failed && id === 'weekly_window') state = 'unknown';
    const waiting = !required && deferred && state === 'unknown' && !['signed_in', 'sandbox'].includes(id);
    if(!required && observation?.evidence_pending && !failed && state !== 'pass' && id !== 'signed_in')
      return {id,state,line:LINES.evidence,fix:'Refresh the allowance.'};
    if(!required && failed && state !== 'pass' && id !== 'signed_in') return {id,state,line:failed.line,fix:failed.action};
    return {id, state, line:waiting ? deferred.line : lines[state], fix:state === 'pass' ? null : waiting ? deferred.action : fix};
  };
  const control = requiredEvidence?(requiredEvidence.executor?.single_executor==='proven'&&requiredEvidence.stop?.bounded_execution==='proven'?'pass':'unknown'):seen && controlKnown ? 'pass' : 'unknown';
  const fundingReason = (requiredEvidence??observation)?.funding?.reason;
  const funding = requiredEvidence?.funding?.subscription_only==='proven'?'pass':!requiredEvidence&&!seen ? 'unknown' : !requiredEvidence&&fundingKnown ? 'pass'
    : ['extra_usage_enabled', 'alternative_api_provider', 'plan_not_subscription', 'limit_reached'].includes(fundingReason) ? 'fail' : 'unknown';
  const limitCopy = (requiredEvidence||seen) && funding === 'fail' && provider === 'codex'
    ? fundingHoldCopy('funding_unknown', {fundingReason}) : null;
  const price = !priceRowFor(DEFAULT_RUN_MODEL[provider]) ? 'unknown'
    : !seen || !observation?.resources?.length ? 'unknown' : conversionOk ? 'pass' : 'unknown';
  const missing = seen && !conversionOk && Array.isArray(observation?.calibration_missing)
    ? observation.calibration_missing.map(calibrationMissingCopy).find(Boolean) : null;
  // No measured usage rate is not a hold: the account lends in its own points until local logs measure a rate (native-window mode).
  const learning = seen && observation.resources?.some(r => r?.conversion === 'native_window')
    ? (Array.isArray(observation.learning) ? observation.learning.map(learningCopy).find(Boolean) : null) ?? {line:LINES.learning_ready}
    : null;
  const checks = [
    ...(runtimeCheck?.ok === false ? [{id:'guard_runtime', code:'guard_runtime_unavailable', state:'fail',
      line:RUNTIME_HELP, fix:'Update Faravan; if it still fails, reinstall Faravan.'}] : []),
    check('signed_in', signedIn === true ? 'pass' : signedIn === false ? 'fail' : 'unknown',
      {pass:label ? `${label} is signed in.` : 'The agent is signed in.', fail:label ? `${label} is signed out.` : 'The agent is signed out.', unknown:label ? `The sign-in of ${label} has not been checked.` : 'The agent sign-in has not been checked.'}, label ? `Sign in again to ${label}.` : 'Sign in on the Lending page.'),
    check('account', requiredEvidence?(requiredEvidence.identity?.verified===true?'pass':requiredEvidence.identity?.reason==='identity_mismatch'?'fail':'unknown'):
      seen && identityMismatch ? 'fail' : seen && identityKnown ? 'pass' : 'unknown',
      {pass:label ? `${label} is identified.` : 'The account is identified.', fail:label ? `The signed-in account does not match the account enrolled as ${label}.` : 'The signed-in account does not match the enrolled account.', unknown:label ? `${label} could not be identified.` : 'The account could not be identified.'}, label ? `Sign in again to ${label}, then refresh its allowance.` : 'Check the agent sign-in and refresh its allowance.'),
    check('subscription', funding,
      {pass:label ? `The subscription of ${label} can cover lending.` : 'The subscription can cover lending.', fail:fundingReason === 'plan_not_subscription' ? (label ? `${label} has no plan Faravan can lend from.` : 'This account has no plan Faravan can lend from.') : limitCopy ? limitCopy.line : (label ? `${label} can use paid API billing.` : 'The account can use paid API billing.'), unknown:label ? `The subscription of ${label} could not be confirmed.` : 'The subscription could not be confirmed.'}, limitCopy?.action ?? (label ? `Check the plan, usage limit and billing settings of ${label}.` : 'Check the plan, usage limit and billing settings for this account.')),
    check('weekly_window', seen && weeklyKnown ? 'pass' : 'unknown',
      {pass:label ? `The weekly allowance window of ${label} was read.` : 'The weekly allowance window was read.', unknown:label ? `The weekly allowance window of ${label} could not be confirmed.` : 'The weekly allowance window could not be confirmed.'}, label ? `Refresh the allowance of ${label}.` : 'Refresh the agent allowance.'),
    // A passed check shows no line, so the learning line is also a note: the owner sees the account lends while it learns.
    {...check('conversion', price,
      {pass:learning?.line ?? (label ? `The default model has a usable allowance estimate for ${label}.` : 'The default model has a usable allowance estimate.'), fail:'The default model price is unavailable.', unknown:missing?.line ?? (label ? `The default model allowance estimate for ${label} is not confirmed.` : 'The default model allowance estimate is not confirmed.')}, missing?.action ?? (label ? `Refresh the allowance of ${label}. If the estimate is still unavailable, check the plan of ${label} or report the missing estimate.` : 'Refresh the agent allowance. If the estimate is still unavailable, check the account plan or report the missing estimate.')),
      ...(price === 'pass' && learning ? {note: learning.line} : {})},
    check('job_control', control,
      {pass:label ? `Jobs can be controlled safely for ${label}.` : 'The job can be controlled safely.', unknown:label ? `Job controls for ${label} could not be confirmed.` : 'Job controls could not be confirmed.'}, 'Check the sandbox setup and try again.'),
  ];
  // A signed-in account whose quota or epoch reading has not arrived is starting its estimate, not blocked on the owner.
  for (const row of checks) if (row.id === 'weekly_window' && row.state === 'unknown' && seen && signedIn === true && !failed && !requiredEvidence)
    Object.assign(row, {line: usageEstimateNote(), fix: null});
  // Independent required facts govern setup. Allowance and conversion remain
  // estimates; their absence cannot become another required check.
  return requiredEvidence
    ? checks.filter(check => !['weekly_window', 'conversion'].includes(check.id))
    : checks;
}

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
// and every comparison of the proof's age run on the lender's own clock (lending-probe.mjs:360 stamps the receipt from host time; account launch.mjs:301 compares it),
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

import {claudeSubscriptionFunding,codexSubscriptionFunding} from './providers/native-host.mjs';
import {STOP_ANSWER_MS} from './lending-probe.mjs';
const nonempty=value=>typeof value==='string'&&value.trim().length>0;
export function createLendingDiagnostics({readings,funding,expectedIdentity,expectedExecutor,stopEvidence,stopBoundMs,stopAnswerMs=STOP_ANSWER_MS}) {
  return {
    async machineEvidence({provider,signal}) {
      const expected=await Promise.resolve().then(()=>expectedExecutor(provider,{signal})).catch(()=>null);
      const receipt=await Promise.resolve().then(()=>stopEvidence(provider,{signal})).catch(()=>null);
      return {executor:executorProof(receipt?.executor,expected),stop:stopProof(receipt?.stop,stopBoundMs,stopAnswerMs)};
    },
    async requiredEvidence({provider,accountKey=provider,signal}) {
      const [fact,expected,machine]=await Promise.all([funding(accountKey),expectedIdentity(accountKey,{signal}),this.machineEvidence({provider,signal})]);
      return {...machine,identity:claudeAccountMatch(fact?.identity,expected),funding:provider==='codex'?codexSubscriptionFunding(fact?.codex_plan):claudeSubscriptionFunding({extraUsage:fact?.extra_usage,guestAuth:fact?.guest_auth})};
    },
    async observe({provider,accountKey=provider}) {const value=await readings(accountKey);return {...value,observed_at:value?.read_at??null};}
  };
}
