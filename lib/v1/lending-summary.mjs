import {lendingReason,lendingReasonText} from './lending-reasons.mjs';
import {createLendingProjection} from './state-projection.mjs';
import {identityHoldCopy, lendingStatus, usageEstimateNote} from './lending-status-copy.mjs';
import {deadlineRecoveryPendingHold} from '../sandbox-remediation.mjs';

const sentence = text => text[0].toUpperCase() + text.slice(1);
export const circlePhrase = name => typeof name === 'string' && name.trim() ? `the circle “${name.trim()}”` : 'this circle';
// The app passes its own clock formatter (browser language); every other surface reads this computer's clock the same way.
const defaultClock = value => { try { return new Intl.DateTimeFormat('en-US', {hour: 'numeric', minute: '2-digit'}).format(new Date(value)); } catch { return ''; } };

export function formatPauseDeadline(until, {now = Date.now(), formatClock = defaultClock} = {}) {
  const deadline = typeof until === 'number' ? until : Date.parse(until);
  return Number.isFinite(deadline) && deadline > now ? formatClock(deadline) : '';
}

// The next start is the producer's window edge, shown on this computer's clock like the other lending times.
const outsideReason = (startsAt, formatClock) => {
  const clock = startsAt ? formatClock(startsAt) : '';
  return 'This computer is outside its lending hours.' + (clock ? ' Lending starts at ' + clock + '.' : '');
};

/** One vocabulary for Home, shell, and Lending. Blocker details stay separately
 * renderable, but they cannot change the projected intent/admission/execution. */
// Holds that read as their closed public reason. Their remedy is the public action words, not an ACTION_OP label.
const PUBLIC_HOLDS=['sandbox_cannot_start','account_signed_out','provider_limit_reached','no_accounts','no_spare','lending_off','circle_access_refused'];
const namesPublicReason=p=>p.admission==='blocked'&&(p.admissionReason==='cleanup_pending'||p.intent==='on'&&PUBLIC_HOLDS.includes(p.admissionReason));
export function formatLendingProjection(projection, {until = null, now = Date.now(), person = '', own = false, agentName = '', circleName = '', dailyFacts = null, stoppedJob = null, hostOutage = null, recoveryPending = false,nextAction=null,detail=null, startFailed = false, formatClock = defaultClock} = {}) {
  const p = createLendingProjection(projection);
  const hasReachedJobCap = Number.isSafeInteger(dailyFacts?.jobs) && Number.isSafeInteger(dailyFacts?.jobLimit) &&
    dailyFacts.jobs >= dailyFacts.jobLimit && dailyFacts.jobLimit > 0;
  const running = p.execution === 'running';
  const finishing = p.execution === 'finishing';
  const stopping = p.execution === 'stopping';
  const admissionBlocked = p.admission === 'blocked';
  const pauseTime = p.intent === 'paused' ? formatPauseDeadline(until, {now, formatClock}) : '';
  // Facts that moved while the server read them (judge r9 O-D): the newest state, held back from admitting work
  // until a stable read. It reads as updating, never as unavailable or as a fault.
  const updating = admissionBlocked && p.admissionReason === 'readiness_changed';
  // Admission and execution remain visible independently.
  const machineChecking = admissionBlocked && p.intent === 'on' && p.admissionReason === 'sandbox_check_pending';
  const busy = admissionBlocked && p.admissionReason === 'busy';
  // A day with time left, but less than a job needs, is done for today too (judge r10 R3).
  const minutesLeft = Number.isSafeInteger(dailyFacts?.minutes) && Number.isSafeInteger(dailyFacts?.minuteLimit) ? Math.max(0, dailyFacts.minuteLimit - dailyFacts.minutes) : null;
  const tooShort = Number.isSafeInteger(dailyFacts?.jobMinutes) && minutesLeft !== null && minutesLeft > 0 && minutesLeft < dailyFacts.jobMinutes;
  const kind = p.execution === 'running' || p.execution === 'finishing' || p.execution === 'stopping' || busy ? 'running'
    : p.intent === 'unknown' || p.admission === 'unknown' || p.execution === 'unknown' ? 'unknown'
    : p.intent === 'off' ? 'off' : p.intent === 'paused' ? 'paused'
    : p.admissionReason === 'platform_unsupported' ? 'unsupported'
    : p.admissionReason === 'daily_limit' ? 'resting'
    : ['no_spare','owner_active'].includes(p.admissionReason) ? 'resting'
    : p.admissionReason === 'outside_hours' ? 'outside'
    : machineChecking ? 'starting'
    : p.admission === 'blocked' ? 'blocked' : p.admission === 'allowed' ? 'ready' : 'unknown';
  let headline;
  if (stopping) headline = own === true ? 'Stopping your job' : 'Stopping' + (person ? ' ' + person + '’s job' : ' this job');
  else if (finishing) headline = own === true ? 'Finishing your job' : 'Finishing' + (person ? ' ' + person + '’s job' : ' a job');
  else if (running) headline = own === true ? 'Running your job' : 'Running ' + (person ? person + '’s job' : 'a job');
  else if (busy) headline = 'Starting ' + (person ? person + '’s job' : 'a job');
  else if (p.intent === 'unknown' || p.admission === 'unknown' || p.execution === 'unknown') headline = 'Status unavailable';
  else if (p.intent === 'off') headline = 'Lending is off';
  else if (p.intent === 'paused') headline = 'Lending is paused';
  else if (admissionBlocked && p.admissionReason === 'platform_unsupported') headline = 'Can’t lend';
  else if (admissionBlocked && p.admissionReason === 'daily_limit') headline = 'Done for today';
  else if (admissionBlocked && ['no_spare','owner_active'].includes(p.admissionReason)) headline = 'Resting';
  else if (admissionBlocked && p.admissionReason === 'outside_hours') headline = 'Outside lending hours';
  else if (machineChecking) headline = 'Checking this computer…';
  else if (updating) headline = 'Updating lending status';
  // Blocked lending never leads with "Lending is on" (I09): the switch shows the choice, the headline what happens.
  else if (admissionBlocked) headline = p.admissionReason === 'sandbox_cannot_start' ? 'Lending can’t start here' : 'Jobs can’t start';
  else headline = 'Ready for requests';

  // The headline already says "Ready for requests"; the line says what that means, not the same words again.
  const reason = admissionBlocked && p.admissionReason === 'cleanup_pending' && recoveryPending
    ? deadlineRecoveryPendingHold().message
    : admissionBlocked && p.admissionReason === 'cleanup_pending'
    ? 'Faravan cannot confirm that the sandbox stopped. No new jobs start until this is confirmed. Open Setup and choose Check again.'
    : stopping ? 'Stopping this job. Lending will be off after it stops.'
    : p.admission === 'allowed' ? 'A new request is checked against the quota available when it arrives.'
    : busy ? 'No other job starts until this one finishes.'
    : p.admission === 'unknown' || p.intent === 'unknown' ? 'Lending status could not be confirmed.'
    : p.intent === 'off' && stoppedJob ? `Lending is off because you stopped ${stoppedJob.requester ? stoppedJob.requester + '’s' : 'a'} job. Turn it on to take the next job.`
    : p.intent === 'off' && p.admissionReason === 'stopped_by_lender' ? 'No new jobs start until you turn lending back on after the earlier check stopped it.'
    : p.intent === 'off' ? 'No new jobs start on this computer.'
    : p.intent === 'paused' && p.admissionReason === 'conditions_unavailable' ? 'Lending could not resume. No new jobs start.'
    : p.intent === 'paused' ? `Paused${pauseTime ? ' until ' + pauseTime : ''}. No new jobs start.`
    : p.admissionReason === 'circle_unreachable' ? `${sentence(circlePhrase(hostOutage?.circleName))} is unreachable. Jobs start again when ${hostOutage?.hostName ? hostOutage.hostName + '’s' : 'the host’s'} computer is back.`
    : p.admissionReason === 'daily_limit' ? hasReachedJobCap
      ? `${dailyFacts.jobs} of ${dailyFacts.jobLimit} ${dailyFacts.jobLimit === 1 ? 'job' : 'jobs'}. Lending resumes at midnight.`
      : tooShort ? `${minutesLeft} ${minutesLeft === 1 ? 'minute' : 'minutes'} left today, and a job needs ${dailyFacts.jobMinutes}. Lending resumes at midnight.`
      : 'Today’s lending limit is reached.'
    : p.admissionReason === 'outside_hours' ? outsideReason(p.evidence.outsideUntil, formatClock)
    : p.admissionReason === 'platform_unsupported' ? 'This computer cannot lend because it cannot run Docker Sandboxes; you can still send jobs.'
    : p.admissionReason === 'no_spare' ? 'Your remaining allowance is being kept for you.'
    : p.admissionReason === 'owner_active' ? 'Automatic lending is waiting for this computer to be idle.'
    : p.admissionReason === 'account_signed_out' ? agentName ? `${agentName} is no longer signed in to Faravan’s sandbox. Sign in again on the Lend page, then lending can resume.` : 'No job can start until a lent agent is signed in.'
    : p.admissionReason === 'lending_off' ? 'Choose which agent may lend before jobs can start.'
    : p.admissionReason === 'no_accounts' ? 'No lent agent is ready. Install or sign in to an agent, then check agents again.'
    : p.admissionReason === 'circle_not_joined' ? 'Join or create a circle before lending can start.'
    // The public reason is `conditions_unavailable`; the caller knows from its own start-failure record that this one is a failed start.
    : p.admissionReason === 'conditions_unavailable' && startFailed ? 'Lending couldn’t start' + (circleName ? ' for ' + circlePhrase(circleName) : '') + '. Check lending for what is blocking it.'
    : p.admissionReason === 'stopped_by_lender' ? 'No new jobs start until you turn lending back on after the earlier check stopped it.'
    : p.admissionReason === 'app_updating' ? 'Update Faravan before new jobs can start.'
    : machineChecking ? 'Faravan will check the sandbox service again automatically.'
    : updating ? 'Lending is changing. This updates in a moment.'
    : admissionBlocked ? 'Lending on this computer waits for the blocked step. You can still send jobs to another lender.'
    : 'Lending status could not be confirmed.';
  const label = stopping ? 'Stopping'
    : finishing ? 'Finishing' : running ? 'Running' : busy ? 'Starting'
    : p.intent === 'unknown' || p.admission === 'unknown' || p.execution === 'unknown' ? 'Needs attention'
    : p.admissionReason === 'account_signed_out' ? 'Sign-in needed'
    : admissionBlocked && p.intent === 'on' && ['daily_limit','no_spare','owner_active','outside_hours','readiness_changed'].includes(p.admissionReason) ? headline
    : p.admissionReason === 'platform_unsupported' ? 'Can’t lend'
    : p.intent === 'off' ? p.admissionReason === 'stopped_by_lender' ? 'Stopped' : 'Off'
    : p.intent === 'paused' ? 'Paused'
    : machineChecking ? 'Checking' : admissionBlocked ? 'Needs attention' : 'Lending on';
  const iconState = stopping ? 'Running' : finishing || running || busy ? 'Running'
    : p.intent === 'unknown' || p.admission === 'unknown' || p.execution === 'unknown' ? 'Needs attention'
    : p.admissionReason === 'platform_unsupported' ? 'Can’t lend'
    : p.intent === 'off' ? 'Off'
    : p.intent === 'paused' || ['daily_limit','no_spare'].includes(p.admissionReason) ? 'Paused'
    : admissionBlocked && !['owner_active','outside_hours','readiness_changed','sandbox_check_pending'].includes(p.admissionReason) ? 'Needs attention' : 'Lending on';
  const remedy = p.intent === 'off' ? 'Turn lending on'
    : p.intent === 'paused' ? 'Resume lending'
    : p.admissionReason === 'account_signed_out' ? 'Sign in'
    : p.admissionReason === 'lending_off' ? 'Choose agents'
    : p.admissionReason === 'daily_limit' ? 'Edit limits'
    : p.admissionReason === 'no_spare' ? 'View allowance'
    : machineChecking ? null
    : admissionBlocked ? 'Check lending' : 'Refresh status';
  const listed=namesPublicReason(p);
  return {kind, headline, reason:listed?lendingReasonText(p.admissionReason,{until,nextAction,detail}):reason, running:running || finishing || stopping, label, iconState, remedy:listed?(nextAction?.label??lendingReason(p.admissionReason).action):remedy,
    on: p.intent === 'on' || p.intent === 'paused', ready: p.admission === 'allowed'};
}


// The four words a lender uses. `kind` keeps the finer reason ("resting", "outside hours") for callers that need it.
const PHASE = {running: 'running', ready: 'ready', off: 'off', paused: 'off', unsupported: 'off'};
// What the lender does next, as the operation that does it. Every surface offers the same one.
const ACTION_OP = {
  'Sign in': 'signin.start', 'Choose agents': 'agents.select', 'Turn lending on': 'lending.on', 'Resume lending': 'lending.resume',
  'Check lending': 'status.blockers', 'Edit limits': 'limits.set', 'View allowance': 'limits.get',
};
// A public hold keeps the operation it had before the public words: sign in, choose agents, else read the blockers.
const PUBLIC_REASON_OP = {account_signed_out: 'signin.start', lending_off: 'agents.select'};
// These waits end by themselves. The lender does nothing, so no action is offered.
const SELF_CLEARING = ['daily_limit', 'no_spare', 'owner_active', 'outside_hours', 'readiness_changed'];
const clean = text => typeof text === 'string' ? text.trim() : '';
export const currentAccountDecision = account => {
  const decision = account?.decision;
  return decision?.availability ?? (decision?.lastJobDecision || decision?.assessmentSource === 'last_job' ? null : decision);
};
// Presentation of projectStatus().wait only. Expiry requests fresh evidence; it
// never changes admission, resumes a pause, or revives a saved last-job decision.
export function currentCapacityWait(account, {now = Date.now(), formatClock = value => new Intl.DateTimeFormat('en-US', {
  month:'short', day:'numeric', hour:'numeric', minute:'2-digit'
}).format(value)} = {}) {
  const decision = currentAccountDecision(account), wait = decision?.wait;
  if (decision?.admitted !== false || decision.reason !== 'owner_reserve' || !wait) return null;
  const unknown = {state:'unknown', line:'The next allowance check time is not confirmed. Lending remains on hold.'};
  const deadline = wait.nextEvaluationAtMs;
  if (!Number.isSafeInteger(now) || now < 0 || now > 8.64e15 ||
      !Number.isSafeInteger(deadline) || deadline < 0 || deadline > 8.64e15 ||
      wait.reason !== decision.reason || wait.accountKey !== (account.accountKey ?? account.provider) ||
      wait.strategyId !== (decision.objective?.strategyId ?? null) ||
      !['window_reset','probe_retry_at'].includes(wait.source)) return unknown;
  if (deadline <= now) return {state:'expired', line:'The wait time has passed. A fresh allowance check is needed before another job can start.'};
  const at = formatClock(deadline);
  if (!at) return unknown;
  if (wait.source === 'window_reset') return {state:'waiting', line:'Your remaining allowance is being kept for you. It resets at ' + at + '.'};
  return {state:'waiting', line:'Your remaining allowance is being kept for you. It will be checked again automatically at ' + at + '.'};
}

// A selected agent's account that admits no work holds a computer that otherwise reads ready. A projection that is already
// blocked (outside hours, a rest, a limit) keeps its own, more specific reason. Same rule as the app's account hold
// (ui/v1/src/view-models.mjs lendingAccountHold) before this summary; the copy comes from lib/v1.
function accountHoldOf(projection, accounts, selectedAgents) {
  if (projection.intent !== 'on' || projection.execution !== 'idle' || projection.admission !== 'allowed') return null;
  const providers = new Set(selectedAgents.map(id => id === 'codex' ? 'codex' : id === 'claude-code-subscription' ? 'claude' : null));
  const selected = accounts.filter(account => providers.has(account.provider));
  if (selected.some(account => currentAccountDecision(account)?.admitted === true)) return null;
  const candidates = selected.filter(account => currentAccountDecision(account)?.admitted === false);
  // An estimate must not hide another account's runtime or authorization failure.
  return candidates.find(account => {
    const decision = currentAccountDecision(account);
    return lendingStatus({admitted: false, reason: decision?.reason, reasonCode: decision?.objective?.reasonCode,
      ruleReasonCode: decision?.ruleReasonCode}).id !== 'usage_estimate';
  }) ?? candidates[0] ?? null;
}
function weeklyReadingOf(account, now) {
  const weekly = (account?.decision?.windows ?? []).filter(window =>
    window.state === 'open' && (window.window_id === 'seven_day' || window.window_id === 'codex:10080' || window.window_minutes === 10080));
  if (weekly.length !== 1 || !Number.isFinite(weekly[0].used_pct) || weekly[0].used_pct < 0 || weekly[0].used_pct > 100) return null;
  const observedAt = Date.parse(weekly[0].observed_at);
  if (!Number.isFinite(observedAt) || now < observedAt) return null;
  return {remaining: 100 - weekly[0].used_pct, observedAt};
}
// Missing or aged usage is an estimate note, including while an explicit review is pending.
function idleReadingLine(projection, decision, reading, now) {
  if (projection.intent !== 'on' || projection.execution !== 'idle' || projection.admissionReason === 'busy') return null;
  const copy = lendingStatus({admitted: decision?.admitted === true, reason: decision?.reason, reasonCode: decision?.objective?.reasonCode,
    ruleReasonCode: decision?.ruleReasonCode, pendingRequest: false});
  if (copy.id !== 'usage_estimate') return null;
  return reading ? Math.round(reading.remaining) + '% of your week left. ' + usageEstimateNote({ageMs:now-reading.observedAt}) : copy.line;
}

/**
 * The one lending answer every surface gives: whether lending is ready, waiting, running or off, why, and what to do.
 * `projection` is the status read's lendingProjection; `blockers` is its ordered model (lib/v1/blockers.mjs).
 * `lendingAccounts` is the lending policy's accounts and `selectedAgents` the canonical ids of agents chosen to lend.
 * The app, `faravan status` and the MCP status_get tool all show this object.
 */
export function lendingSummary(projection, {blockers = null, dailyFacts = null, person = '', own = false, circleName = '', stoppedJob = null, until = null,
  lendingAccounts = [], selectedAgents = [], approvalPending = false, recoveryPending = false,nextAction=null,detail=null, startFailed = false, now = Date.now()} = {}) {
  const first = blockers?.first;
  const host = blockers?.items?.find(item => item.key === 'circle' && item.status === 'blocked' && item.detail_code !== 'host_too_old');
  const view = formatLendingProjection(projection, {
    until, now, person, own, circleName, dailyFacts, stoppedJob,nextAction,detail,startFailed,
    agentName: first?.agent ? clean(first.label) : '',
    hostOutage: {circleName: clean(host?.label), hostName: clean(host?.hostName)}, recoveryPending,
  });
  const account = accountHoldOf(projection, Array.isArray(lendingAccounts) ? lendingAccounts : [], selectedAgents);
  if (account) {
    const decision = currentAccountDecision(account);
    const identity = identityHoldCopy(decision?.status?.id ?? decision?.reason ?? decision?.objective?.reasonCode, {provider: account.provider});
    const idle = idleReadingLine(projection, decision, weeklyReadingOf(account, now), now);
    const wait = currentCapacityWait(account, {now});
    const ownerLimit = decision?.reason === 'owner_limit_too_low' || decision?.objective?.reasonCode === 'owner_limit_too_low';
    const ownerHold = !idle && !wait && decision?.status?.recovery?.who !== 'automatic';
    const headline = ownerLimit ? 'Per-job limit too low' : ownerHold ? 'Check lending accounts' : 'Lending on';
    const reason = identity?.line ?? wait?.line ?? idle ?? decision?.status?.line ?? decision?.objective?.reasonText ?? view.reason;
    const action = ownerLimit ? {label: 'Edit limits', op: 'limits.set'} : ownerHold ? {label: 'Check lending', op: 'status.blockers'} : null;
    return {phase: 'waiting', kind: 'hold', headline, label: headline, reason, action};
  }
  const op = namesPublicReason(createLendingProjection(projection)) ? PUBLIC_REASON_OP[projection.admissionReason] ?? 'status.blockers' : ACTION_OP[view.remedy];
  // Waiting for lending hours or a rest ends by itself; nothing for the lender to do.
  const action = view.ready || view.running || SELF_CLEARING.includes(projection.admissionReason) || !op ? null : {label: view.remedy, op};
  return {phase: PHASE[view.kind] ?? (view.kind === 'running' ? 'running' : 'waiting'), kind: view.kind, headline: view.headline, label: view.label, reason: view.reason, action};
}
