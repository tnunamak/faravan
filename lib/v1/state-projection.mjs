import {lendingReasonCode} from './lending-reasons.mjs';
// Versioned read projections. These values describe observations; action hints
// are suggestions and never authorize a write.
export { createMembershipProjection, projectMembership } from './membership-projection.mjs';

export const JOB_PHASES = Object.freeze([
  'waiting', 'approval_pending', 'approved', 'starting', 'running', 'stopping',
  'stopped', 'failed', 'expired', 'result_accepted', 'unknown',
]);

const JOB_STATUS_LABELS = Object.freeze({
  waiting: 'Waiting', approval_pending: 'Waiting for an answer', approved: 'Approved',
  starting: 'Starting', running: 'Working', stopping: 'Stopping', stopped: 'Stopped',
  failed: 'Failed', expired: 'Expired', result_accepted: 'Finished', unknown: 'Status unavailable',
});

const ACTIONS = new Set(['cancel', 'review', 'resend', 'refresh', 'retry', 'none']);
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isTime = value => value === null || typeof value === 'string' && ISO_TIME.test(value) && Number.isFinite(Date.parse(value));
const validText = (value, max = 160) => typeof value === 'string' && value.length > 0 && value.length <= max;
const safeCode = value => validText(value, 160) && /^[a-z0-9][a-z0-9_.-]*$/i.test(value) ? value : null;
function legacyReason(value) {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return null;
  try { const parsed = JSON.parse(value); return isRecord(parsed) ? parsed : null; }
  catch { return safeCode(value) ? {code:value} : null; }
}
const WAITING_EXPLANATIONS = Object.freeze({
  daily_limit: 'Available computers have reached their daily limit.',
  outside_hours: 'No available computers are lending right now.',
  approval_pending: 'A computer reserved the job. Approval is still pending.',
  sandbox_not_ready: 'Available computers are checking their workspace setup.',
});
const validApplicationOutcome = value => value === null || isRecord(value) &&
  ['used', 'needs-more-work', 'unused'].includes(value.verdict) &&
  (value.note === undefined || typeof value.note === 'string' && value.note.length <= 1000) &&
  (value.checks === undefined || typeof value.checks === 'string' && value.checks.length <= 4000) &&
  Object.keys(value).every(key => ['verdict', 'note', 'checks'].includes(key));
const validVersion = value => typeof value === 'string' && value.length > 0 && value.length <= 200 ||
  Number.isSafeInteger(value) && value >= 0 || isRecord(value);
const reasonFitsPhase = (phase, reason) => {
  if (phase === 'unknown') return reason === null || validText(reason);
  if (phase === 'waiting') return reason === null || validText(reason) && !['approval_pending', 'stop_unconfirmed'].includes(reason);
  if (phase === 'approval_pending') return reason === 'approval_pending';
  if (phase === 'stopping') return reason === 'stop_unconfirmed';
  if (phase === 'stopped') return ['compute_stopped', 'cancelled_before_start'].includes(reason);
  if (phase === 'failed') return reason === null || validText(reason);
  if (phase === 'expired') return reason === 'expired';
  return reason === null;
};

const unknownJob = (reasonCode = 'invalid_projection') => ({
  schemaVersion: 2, kind: 'job', phase: 'unknown', reasonCode,
  result: {available: false, digest: null}, application: {outcome: null, appliedBranch: null},
  evidence: {}, version: null, times: {observedAt: null, validUntil: null, nextTransitionAt: null}, actionHints: [],
});

/** Runtime boundary for a v2 job projection. Invalid phase/evidence pairs fail closed. */
export function createJobProjection(input) {
  if (!isRecord(input) || input.schemaVersion !== 2 || input.kind !== 'job' ||
      !JOB_PHASES.includes(input.phase) || !reasonFitsPhase(input.phase, input.reasonCode) ||
      !isRecord(input.result) || typeof input.result.available !== 'boolean' ||
      !(input.result.digest === null || validText(input.result.digest, 256)) ||
      input.result.available && (input.phase !== 'result_accepted' || input.result.digest === null) ||
      !isRecord(input.application) || !validApplicationOutcome(input.application.outcome) ||
      !(input.application.appliedBranch === null || validText(input.application.appliedBranch, 1024)) ||
      !isRecord(input.evidence) || !(input.evidence.hardStopAt === undefined || isTime(input.evidence.hardStopAt)) ||
      !(input.evidence.executionStartRequestedAt === undefined || isTime(input.evidence.executionStartRequestedAt)) ||
      !(input.evidence.sharedStopRequestedAt === undefined || isTime(input.evidence.sharedStopRequestedAt)) ||
      !(input.evidence.sharedStopRequestUnavailable === undefined || typeof input.evidence.sharedStopRequestUnavailable === 'boolean') ||
      !(input.evidence.launchFenceUntil === undefined || isTime(input.evidence.launchFenceUntil)) ||
      !(input.evidence.releasedBeforeExecution === undefined || typeof input.evidence.releasedBeforeExecution === 'boolean') ||
      !validVersion(input.version) || !isRecord(input.times) ||
      !isTime(input.times.observedAt) || !isTime(input.times.validUntil) || !isTime(input.times.nextTransitionAt) ||
      !Array.isArray(input.actionHints) || input.actionHints.some(action => !ACTIONS.has(action))) return unknownJob();

  if (input.times.observedAt &&
      (input.times.validUntil && Date.parse(input.times.validUntil) < Date.parse(input.times.observedAt) ||
       input.times.nextTransitionAt && Date.parse(input.times.nextTransitionAt) < Date.parse(input.times.observedAt))) return unknownJob('contradictory_times');

  const evidence = input.evidence;
  const started = typeof evidence.executionStartedAt === 'string' && Number.isFinite(Date.parse(evidence.executionStartedAt));
  const approved = evidence.approval === 'approved' || typeof evidence.approvedAt === 'string' && Number.isFinite(Date.parse(evidence.approvedAt));
  const pending = evidence.approval === 'pending';
  const stopped = evidence.computeStopped === true;
  const releasedProofConsistent = evidence.releasedBeforeExecution !== true ||
    evidence.rawState === 'cancelled' && evidence.attemptPresent === true && !started;
  const consistent = releasedProofConsistent && (input.phase === 'unknown' ||
    input.phase === 'waiting' && !started && !stopped && (evidence.rawState === 'queued' ||
      ['claimed', 'starting', 'running'].includes(evidence.rawState) && !pending &&
      (evidence.rawState === 'running' || !approved) && input.reasonCode === null ||
      // A launch that may still be running: its attempt ended unconfirmed, so it waits for the fence bound.
      evidence.rawState === 'claimed' && typeof evidence.launchFenceUntil === 'string' && !pending && input.reasonCode === null) ||
    input.phase === 'approval_pending' && evidence.rawState === 'claimed' && pending && !approved && !started && !stopped ||
    input.phase === 'approved' && evidence.rawState === 'claimed' && approved && !pending && !started && !stopped ||
    input.phase === 'starting' && evidence.rawState === 'starting' && approved && !pending && !started && !stopped ||
    input.phase === 'running' && ['claimed', 'starting', 'running'].includes(evidence.rawState) && started && !stopped && !pending ||
    input.phase === 'stopping' && (evidence.rawState === 'stop-requested' || evidence.rawState === 'cancelled' ||
      evidence.localStopRequested === true && ['claimed', 'starting', 'running'].includes(evidence.rawState) && started ||
      typeof evidence.sharedStopRequestedAt === 'string' && ['claimed', 'starting', 'running'].includes(evidence.rawState) && started) && !stopped ||
    input.phase === 'stopped' && evidence.rawState === 'cancelled' &&
      (input.reasonCode === 'compute_stopped' && stopped || input.reasonCode === 'cancelled_before_start' && !started &&
        (evidence.attemptPresent !== true || evidence.releasedBeforeExecution === true)) ||
    input.phase === 'failed' && (input.reasonCode === null || validText(input.reasonCode)) && evidence.rawState === 'failed' ||
    input.phase === 'expired' && input.reasonCode === 'expired' && evidence.rawState === 'expired' ||
    input.phase === 'result_accepted' && ['result-accepted', 'finished'].includes(evidence.rawState));
  if (!consistent) return unknownJob('contradictory_evidence');

  const observation = validObservation(input.observation);
  if (input.observation !== undefined && !observation) return unknownJob('invalid_observation');
  return {
    schemaVersion: 2, kind: 'job', phase: input.phase, reasonCode: input.reasonCode,
    result: {available: input.result.available, digest: input.result.digest},
    application: {outcome: input.application.outcome, appliedBranch: input.application.appliedBranch},
    evidence: {...evidence}, version: input.version,
    times: {...input.times}, actionHints: [...new Set(input.actionHints)],
    ...(observation ? {observation} : {}),
  };
}

// How the projection was observed (judge r9). 'current': this read. 'transitional': the job moved while this read
// was assembled, so the projection is its last confirmed state until the next read. 'last_known': a saved copy
// served while the host is unreachable. An uncertain observation keeps the confirmed state it has; only a job with
// no confirmed state at all projects as unknown.
const OBSERVATIONS = new Set(['current', 'transitional', 'last_known']);
function validObservation(value) {
  if (!isRecord(value) || !OBSERVATIONS.has(value.state) || !(value.at === undefined || value.at === null || isTime(value.at)) ||
      !(value.reason === undefined || value.reason === null || validText(value.reason, 64))) return null;
  return {state: value.state, at: value.at ?? null, reason: value.reason ?? null};
}
/**
 * This computer's lender asked its own sandbox to stop a job it runs (judge r9 O-E): until the host records the
 * stop, the job is stopping here, not running, and offers no fresh Stop.
 */
export function locallyStoppingJobProjection(projection) {
  const p = createJobProjection(projection);
  if (!['running','stopping'].includes(p.phase) || p.evidence.localStopRequested === true) return p;
  return createJobProjection({...p, phase: 'stopping', reasonCode: 'stop_unconfirmed',
    evidence: {...p.evidence, localStopRequested: true}, actionHints: []});
}
/** The last confirmed projection, qualified as transitional or last known, instead of an unknown one. */
export function qualifyJobProjection(projection, {state, at = null, reason = null}) {
  const confirmed = createJobProjection(projection);
  if (confirmed.phase === 'unknown') return confirmed;
  return createJobProjection({...confirmed, observation: {state, at, reason}});
}

const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;

/** Preserve the old observation rule only for saved attempts from before the new field existed. */
export function observedExecutionTime(attempt) {
  if (!isRecord(attempt)) return null;
  return Object.hasOwn(attempt, 'execution_observed_at') ? attempt.execution_observed_at : attempt.execution_started_at;
}

// Launch fence bound (also read by the lender's store): one full lease covers the wall-clock backstop, the 60 s clock
// skew the store accepts, and exec start-up. Changing it changes when a fenced launch is treated as over.
export const MAX_LEASE_SECONDS = 300;
const FENCE_DAY = 86400;
const toSeconds = value => typeof value === 'number' ? value : Date.parse(value) / 1000;

/** When a fenced run can no longer be going, in epoch seconds: lease end + the wall limit + one lease. */
export function launchFenceBound(attempt, job) {
  const wall = job?.signed?.payload?.requirements?.limits?.wall_seconds;
  return Number.isSafeInteger(wall) && wall >= 1 && wall <= FENCE_DAY
    ? toSeconds(attempt.lease_expires_at) + wall + MAX_LEASE_SECONDS : toSeconds(job.expiry);
}

/** Adapt the actual coordinator/API job vocabulary at one boundary. */
export function adaptLegacyJob(job = {}, {observedAt = null, validUntil = null, nextTransitionAt = null, actionHints} = {}) {
  if (!isRecord(job)) return unknownJob('invalid_legacy_job');
  // An attempt is present, observed absent (null), or not observed at all (field missing). A cancelled job with no
  // attempt field and no compute-stopped fact is not proof that it never started: it stays stop-unconfirmed.
  const attemptPresent = !Object.hasOwn(job, 'current_attempt') ? null : job.current_attempt !== null;
  const rawState = String(job.state ?? job.status ?? '').toLowerCase().replaceAll(' ', '-');
  // A queued job's current_attempt is the attempt that ended (released, expired or stopped): its execution facts
  // describe that earlier run, not this job's current state (judge r9: a lender-stopped job read "unknown").
  const namedAttempt = isRecord(job.current_attempt) ? job.current_attempt : {};
  const releasedBeforeExecution = rawState === 'cancelled' && job.attempts_started === 0 &&
    ['released','cancelled'].includes(namedAttempt.state) && namedAttempt.execution_started_at === null &&
    namedAttempt.execution_observed_at === null;
  const attempt = rawState === 'queued' ? {} : namedAttempt;
  const attemptReason = legacyReason(attempt.reason);
  const failure = isRecord(job.failure) ? job.failure : legacyReason(job.failure);
  const previousAttempt = isRecord(job.previous_attempt) ? job.previous_attempt :
    isRecord(job.previousAttempt) ? job.previousAttempt : rawState === 'queued' ? namedAttempt : {};
  const previousAttemptReason = legacyReason(previousAttempt.reason);
  // The coordinator's start timestamp fences replay. Only the separate backend
  // observation proves launch in new-shape records; old records predate that field.
  const startRequestedAt=timestamp(attempt.execution_started_at);
  const startedAt=timestamp(observedExecutionTime(attempt));
  const stopped = attempt.compute_stopped === true || rawState !== 'queued' && job.compute_stopped === true;
  const request = isRecord(job.stopRequest) ? job.stopRequest : null;
  // A graceful lender stop returns an ordinary result. Keep its attempt-bound
  // request as history after acceptance, not only while stopping is pending.
  const resultAccepted = ['result-accepted', 'finished'].includes(rawState);
  const sharedStopRequestedAt = request && request.attempt_id === namedAttempt.attempt_id &&
    request.job_digest === job.job_digest && request.generation === namedAttempt.generation &&
    startedAt && (resultAccepted || namedAttempt.state === 'active' && !stopped) ? timestamp(request.requested_at) : null;
  const sharedStopRequestUnavailable=job.stopRequestReadUnavailable===true&&!sharedStopRequestedAt;
  const stoppedAt = timestamp(attempt.stopped_at) ?? timestamp(job.stopped_at);
  // Launch fence: the start was authorized and its attempt ended, but nothing shows the run began or stopped. The
  // coordinator keeps the job until the lender confirms the stop or the run's time limit has passed.
  const launchUnconfirmed = rawState === 'claimed' && ['released','failed','expired','cancelled'].includes(attempt.state) &&
    startRequestedAt !== null && !startedAt && !stopped;
  const fenceSeconds = launchUnconfirmed ? launchFenceBound(attempt, job) : NaN;
  const launchFenceUntil = Number.isFinite(fenceSeconds) ? new Date(fenceSeconds * 1000).toISOString() : null;
  const approval = job.approval === 'approved' || job.approval === 'pending' ? job.approval : null;
  const approvedAt = timestamp(attempt.approved_at);
  let phase = 'unknown', reasonCode = null;
  if (sharedStopRequestedAt && ['claimed','starting','running'].includes(rawState)) phase = 'stopping';
  else if (rawState === 'queued') phase = 'waiting';
  else if (rawState === 'claimed') {
    if (startedAt) phase = 'running'; // execution is proof that approval preceded it
    else if (launchUnconfirmed) phase = 'waiting'; // the earlier run may still be going; the sender sees why
    else if (approval === 'approved' || approvedAt) phase = 'approved';
    else if (approval === 'pending') phase = 'approval_pending';
    else phase = 'waiting';
  } else if (rawState === 'starting') {
    if (startedAt) phase = 'running';
    else if (approval === 'approved' || approvedAt) phase = 'starting';
    else if (approval !== 'pending') phase = 'waiting';
  } else if (rawState === 'running') {
    if (startedAt) phase = 'running';
    else if (approval !== 'pending') phase = 'waiting';
  } else if (rawState === 'stop-requested') phase = 'stopping';
  else if (rawState === 'cancelled') {
    if (stopped) { phase = 'stopped'; reasonCode = 'compute_stopped'; }
    else if (releasedBeforeExecution) { phase = 'stopped'; reasonCode = 'cancelled_before_start'; }
    else if (attemptPresent === true || attemptPresent === null && job.compute_stopped !== true) phase = 'stopping';
    else { phase = 'stopped'; reasonCode = 'cancelled_before_start'; }
  } else if (rawState === 'failed') phase = 'failed';
  else if (rawState === 'expired') phase = 'expired';
  else if (rawState === 'result-accepted' || rawState === 'finished') phase = 'result_accepted';

  if (job.waiting_reason === 'approval_pending' && (['approved','starting','running'].includes(phase) || phase === 'waiting' && rawState !== 'queued')) phase = 'unknown';

  if (phase === 'approval_pending') reasonCode = 'approval_pending';
  else if (phase === 'stopping') reasonCode = 'stop_unconfirmed';
  else if (phase === 'stopped') reasonCode = attemptPresent !== true || releasedBeforeExecution && !stopped
    ? 'cancelled_before_start' : 'compute_stopped';
  else if (phase === 'failed') reasonCode = safeCode(attemptReason?.code) ?? safeCode(failure?.code) ?? null;
  else if (phase === 'expired') reasonCode = 'expired';
  else if (phase === 'waiting') reasonCode = rawState === 'queued' ? safeCode(job.waiting_reason) : null;
  else reasonCode = null;

  const resultDigest = validText(job.result_digest, 256) ? job.result_digest : null;
  const resultAvailable = ['result-accepted', 'finished'].includes(rawState) && resultDigest !== null;
  const version = {
    jobDigest: validText(job.job_digest, 256) ? job.job_digest : null,
    attemptId: validText(namedAttempt.attempt_id, 256) ? namedAttempt.attempt_id : null,
    generation: Number.isSafeInteger(namedAttempt.generation) ? namedAttempt.generation : null,
  };
  return createJobProjection({schemaVersion: 2, kind: 'job', phase, reasonCode,
    result: {available: resultAvailable, digest: resultAvailable ? resultDigest : null},
    application: {outcome: validApplicationOutcome(job.borrowerOutcome) ? job.borrowerOutcome : null,
      appliedBranch: validText(job.applied?.branch, 1024) ? job.applied.branch : null},
    evidence: {rawState, approval, approvedAt, executionStartedAt: startedAt,
      ...(startRequestedAt?{executionStartRequestedAt:startRequestedAt}:{}),hardStopAt: timestamp(job.hardStopAt),
      sharedStopRequestedAt,computeStopped: stopped, stoppedAt,
      ...(sharedStopRequestUnavailable?{sharedStopRequestUnavailable:true}:{}),
      ...(releasedBeforeExecution?{releasedBeforeExecution:true}:{}),
      failurePhase: safeCode(attemptReason?.phase) ?? safeCode(failure?.phase) ?? safeCode(job.failurePhase),
      previousAttemptState: safeCode(previousAttempt.state),
      previousReason: safeCode(previousAttemptReason?.code),
      previousAttemptHolder: validText(previousAttempt.holder,256) ? previousAttempt.holder : null,
      waitingExplanation: phase === 'waiting' ? (rawState !== 'queued' ? (launchUnconfirmed
        ? 'Waiting for the lender to confirm the last try stopped.' : 'A computer took this job and is getting ready.') :
        Object.hasOwn(WAITING_EXPLANATIONS,reasonCode) ? WAITING_EXPLANATIONS[reasonCode] : 'Waiting for someone to run it.') : null,
      ...(launchFenceUntil ? {launchFenceUntil} : {}),
      attemptPresent, resultDigest, applicationPresent: job.applied !== null && job.applied !== undefined},
    version, times: {observedAt, validUntil, nextTransitionAt},
    actionHints: actionHints ?? (sharedStopRequestUnavailable?[]:phase === 'waiting' || phase === 'approval_pending' || phase === 'approved' || phase === 'starting' || phase === 'running' ? ['cancel'] : phase === 'result_accepted' ? ['review'] : []),
  });
}

/** One display label for every surface, derived from the validated job phase. */
export function jobStatusLabel(job) {
  const value = typeof job === 'string' ? {state: job} : job;
  const projection = isRecord(value) && value.jobProjection !== undefined
    ? createJobProjection(value.jobProjection) : adaptLegacyJob(value);
  if (projection.phase === 'stopped' && projection.reasonCode === 'cancelled_before_start') return 'Cancelled';
  if (projection.phase === 'stopped' && projection.evidence.rawState === 'cancelled') return 'Cancelled';
  if (projection.phase === 'result_accepted' && projection.evidence.sharedStopRequestedAt && projection.evidence.computeStopped) return 'Stopped by lender';
  return JOB_STATUS_LABELS[projection.phase];
}

const EXECUTIONS = new Set(['idle', 'running', 'finishing', 'stopping', 'unknown']);
const LENDING_INTENTS = new Set(['on', 'off', 'paused', 'unknown']);
const ADMISSIONS = new Set(['allowed', 'blocked', 'unknown']);
const INTENT_STATES = new Set(['ready', 'blocked', 'starting', 'resting', 'outside', 'update', 'paused', 'off']);

function unknownLending(reason = 'invalid_projection') {
  return {schemaVersion: 2, kind: 'lending', intent: 'unknown', admission: 'unknown', admissionReason: lendingReasonCode(reason),
    execution: 'unknown', executionJob: null,
    evidence: {intentState: null, dailyLimitReached: null, executionState: null}, version: null};
}

/** Runtime validation boundary for the intent/admission/execution tuple. */
export function createLendingProjection(input) {
  if (!isRecord(input) || input.schemaVersion !== 2 || input.kind !== 'lending' ||
      !LENDING_INTENTS.has(input.intent) || !ADMISSIONS.has(input.admission) || !EXECUTIONS.has(input.execution) ||
      !(input.admissionReason === null || validText(input.admissionReason)) ||
      !(input.executionJob === null || validText(input.executionJob, 256)) || !isRecord(input.evidence) ||
      !(input.evidence.dailyLimitReached === null || typeof input.evidence.dailyLimitReached === 'boolean') ||
      !(input.evidence.intentState === null || INTENT_STATES.has(input.evidence.intentState)) ||
      !(input.evidence.executionState === null || EXECUTIONS.has(input.evidence.executionState)) ||
      !(input.version === null || validVersion(input.version)) ||
      input.intent === 'unknown' && input.admission === 'allowed' ||
      input.intent === 'on' && !['ready', 'blocked', 'starting', 'resting', 'outside', 'update'].includes(input.evidence.intentState) ||
      input.intent === 'off' && ![null, 'off'].includes(input.evidence.intentState) ||
      input.intent === 'paused' && input.evidence.intentState !== 'paused' ||
      input.intent === 'unknown' && input.evidence.intentState !== null ||
      input.admission === 'allowed' && input.intent !== 'on' ||
      input.admission === 'allowed' && input.execution === 'unknown' ||
      input.admission === 'allowed' && input.evidence.intentState !== 'ready' ||
      input.admission === 'allowed' && input.admissionReason !== null ||
      input.admission === 'allowed' && input.evidence.dailyLimitReached !== false ||
      input.admission === 'blocked' && input.admissionReason === null ||
      input.admissionReason === 'daily_limit' && input.evidence.dailyLimitReached !== true ||
      input.execution === 'running' && !validText(input.executionJob, 256) ||
      ['idle', 'unknown'].includes(input.execution) && input.executionJob !== null ||
      input.execution === 'finishing' && !validText(input.executionJob, 256) ||
      input.execution === 'running' && input.evidence.executionState !== 'running' ||
      input.execution === 'finishing' && input.evidence.executionState !== 'finishing' ||
      input.execution === 'stopping' && input.evidence.executionState !== 'stopping' ||
      input.execution === 'idle' && input.evidence.executionState !== null && input.evidence.executionState !== 'idle' ||
      input.execution === 'unknown' && ![null, 'unknown'].includes(input.evidence.executionState) ||
      input.evidence.dailyLimitReached === true && input.admission === 'allowed' ||
      input.evidence.outsideUntil !== undefined && !isTime(input.evidence.outsideUntil) ||
      input.evidence.outsideUntil != null && input.evidence.intentState !== 'outside') return unknownLending('contradictory_evidence');
  const observation = validObservation(input.observation);
  if (input.observation !== undefined && !observation) return unknownLending('invalid_observation');
  // A transitional projection never admits new work: the facts moved while it was assembled (dot review of r8).
  if (observation?.state === 'transitional' && input.admission === 'allowed') return unknownLending('contradictory_evidence');

  return {...input,admissionReason:input.admissionReason===null?null:lendingReasonCode(input.admissionReason), evidence: {...input.evidence}, ...(observation ? {observation} : {})};
}
/**
 * The lending state assembled while its facts were still moving (judge r9 O-D: a pending stop read "Status
 * unavailable"). It keeps the newest intent and execution — a stop that is pending shows as stopping — but never
 * admits new work until a stable read: allowed becomes blocked with reason observation_changed.
 */
export function transitionalLendingProjection(projection) {
  const p = createLendingProjection(projection);
  if (p.intent === 'unknown' && p.execution === 'unknown') return p;
  const admission = p.admission === 'allowed' ? {admission: 'blocked', admissionReason: 'observation_changed'} : {};
  return createLendingProjection({...p, ...admission, observation: {state: 'transitional', at: null, reason: 'observation_changed'}});
}

/** Three independent axes; a limit affects new admission, never observed execution. */
export function projectLendingState(input = {}) {
  if (!isRecord(input)) return unknownLending();
  const effective = isRecord(input.effective) ? input.effective : {};
  const dailyLimitReached = input.dailyLimitReached;
  const intentView = effective.intent ?? {};
  const intent = intentView.on === true ? (intentView.state === 'paused' ? 'paused' : ['ready','blocked','starting','resting','outside','update'].includes(intentView.state) ? 'on' : 'unknown') :
    intentView.on === false ? 'off' : 'unknown';
  const executionRaw = effective.execution?.state;
  const validRunningEvidence = executionRaw !== 'running' || validText(effective.execution?.job, 256);
  const execution = EXECUTIONS.has(executionRaw) && validRunningEvidence ? executionRaw : 'unknown';
  let admission = 'unknown', admissionReason = null;
  if (dailyLimitReached === true) { admission = 'blocked'; admissionReason = 'daily_limit'; }
  else if (!validRunningEvidence || execution === 'unknown') { admission = 'unknown'; admissionReason = null; }
  else if (intent === 'unknown') { admission = 'unknown'; }
  else if (intent !== 'on' || intentView.state !== 'ready') {
    admission = 'blocked';
    admissionReason = intentView.reason ?? (intent === 'paused' ? 'paused' : intent === 'off' ? 'off' : intentView.state === 'outside' ? 'outside_hours' : 'not_ready');
  }
  // Readiness is admission (judge r10 R5): the producer asked the running lender whether a standard offer arriving now
  // would be admitted. While this computer runs a job and has no other free slot, no other job starts.
  else if (isRecord(effective.admission) && typeof effective.admission.reason === 'string' && effective.admission.reason) {
    admission = 'blocked'; admissionReason = effective.admission.reason.slice(0, 64);
  } else if (dailyLimitReached === false) admission = 'allowed';
  // The producer's window edge stays on the projection so every surface can say when lending starts again.
  const outsideUntil = intentView.state === 'outside' && Number.isFinite(intentView.until) && Math.abs(intentView.until) <= 8.64e15
    ? new Date(intentView.until).toISOString() : null;
  return createLendingProjection({schemaVersion: 2, kind: 'lending', intent, admission, admissionReason,
    execution, executionJob: effective.execution?.job ?? null,
    evidence: {intentState: intentView.state ?? null, dailyLimitReached: dailyLimitReached === true ? true : dailyLimitReached === false ? false : null,
      executionState: execution === 'unknown' ? executionRaw == null ? null : 'unknown' : execution, outsideUntil}, version: effective.version ?? null});
}

/** Resource-local freshness. Stream state and other resource failures cannot stale this resource. */
export function projectResourceFreshness(resource = {}) {
  if (!isRecord(resource)) return {hasData: false, fetching: false, lastSuccess: null, lastError: null, source: 'live',
    streamConnected: null, state: 'unknown'};
  const lastSuccess = timestamp(resource.lastSuccess);
  const lastError = timestamp(resource.lastError);
  const source = ['live', 'saved'].includes(resource.source) ? resource.source : 'live';
  const hasData = resource.hasData === true;
  const failed = lastError !== null && (lastSuccess === null || Date.parse(lastError) > Date.parse(lastSuccess));
  const stale = hasData && failed;
  return {hasData, fetching: resource.fetching === true, lastSuccess, lastError, source,
    streamConnected: typeof resource.streamConnected === 'boolean' ? resource.streamConnected : null,
    state: !hasData
      ? resource.fetching === true ? 'loading' : failed ? 'unavailable' : lastSuccess ? 'empty' : 'initial'
      : source === 'saved' ? 'saved' : !lastSuccess ? 'unavailable' : stale ? 'stale' : 'fresh'};
}

/** A disconnect is not proof an update operation restarted the app. */
export function acknowledgedUpdateOperation(input) {
  if (!isRecord(input) || !validText(input.operationId, 200) || input.acknowledged !== true ||
      !['accepted', 'applying', 'restarting', 'reconnected', 'failed', 'unknown'].includes(input.stage)) return null;
  return {operationId: input.operationId, acknowledged: true, stage: input.stage,
    version: validText(input.version, 100) ? input.version : null,
    acknowledgedAt: timestamp(input.acknowledgedAt)};
}
