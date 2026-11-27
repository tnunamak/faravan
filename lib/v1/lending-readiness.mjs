import {RUNTIME_HELP, LINES, calibrationMissingCopy, learningCopy, probeDeferralCopy, fundingHoldCopy, probeFailureCopy, usageEstimateNote} from './lending-status-copy.mjs';
import {conversionKnown} from './lending-pace50-source.mjs';
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
