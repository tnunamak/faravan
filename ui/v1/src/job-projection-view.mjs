import {adaptLegacyJob, createJobProjection} from '../../../lib/v1/state-projection.mjs';
import {RESULT_DELIVERY_FAILURE_CODES, LENDER_INTERRUPTION_CODES} from './job-failure-copy.mjs';
import {launchFenceLine} from '../../../lib/v1/lending-status-copy.mjs';
import {formatDate} from './dates.mjs';

// One UI boundary for validated server projections and explicitly supported old responses.
export function jobProjectionFor(job = {}) {
  if (job?.jobProjection !== undefined) return createJobProjection(job.jobProjection);
  let attempt = job?.current_attempt;
  if (typeof attempt?.reason === 'string' && attempt.reason.length <= 2048) {
    try { attempt = {...attempt, reason:JSON.parse(attempt.reason)}; }
    catch { if (SAFE_REASON_CODES.has(attempt.reason)) attempt = {...attempt, reason:{code:attempt.reason}}; }
  }
  // Old responses used display labels in `status`; only labels that identify a
  // terminal or queued state can be adapted without inventing execution facts.
  const rawLegacyState = job?.state ?? job?.status;
  const normalizedLegacyState = String(rawLegacyState ?? '').toLowerCase().replaceAll(' ', '-');
  const legacyState = ({waiting:'queued'}[normalizedLegacyState] ?? rawLegacyState);
  // An attempt observed as null and an attempt field that is missing are different evidence (dot server review P2):
  // only the first says a cancelled job never had an attempt. The shared adapter decides from that difference.
  const legacyInput = {...job, ...(legacyState ? {state:legacyState} : {})};
  if (attempt === undefined) delete legacyInput.current_attempt;
  else legacyInput.current_attempt = attempt;
  const adapted = adaptLegacyJob(legacyInput);
  const failurePhase = adapted.evidence.failurePhase ?? (attempt?.reason && typeof attempt.reason === 'object' ? attempt.reason.phase : undefined);
  const stoppedAt = adapted.evidence.stoppedAt ?? (typeof attempt?.stopped_at === 'string' && Number.isFinite(Date.parse(attempt.stopped_at)) ? attempt.stopped_at : undefined);
  return failurePhase || stoppedAt ? createJobProjection({...adapted,evidence:{...adapted.evidence,
    ...(failurePhase?{failurePhase}:{}),...(stoppedAt?{stoppedAt}:{})}}) : adapted;
}

export function jobPageRecord({record, listed, created, previous=null, error}) {
  if (record) {
    // A list may supply decoration, never the detail's execution observation.
    const {jobProjection:ignoredProjection,statusContract:ignoredContract,...decoration}=listed??{};
    const current={...decoration,...record},projection=jobProjectionFor(record);
    const prior=previous??created;
    const circleOf=value=>value?.circle?.id??value?.circleId??value?.borrowerCircle;
    const matched=prior&&typeof record.job_digest==='string'&&prior.job_digest===record.job_digest&&
      typeof circleOf(record)==='string'&&circleOf(prior)===circleOf(record);
    const incomplete=record.jobProjection!==undefined&&projection.phase==='unknown'&&
      ['observation_changed','observation_unavailable'].includes(projection.reasonCode)&&projection.evidence.observation==='incomplete'&&
      projection.version?.jobDigest===record.job_digest;
    if(!error&&matched&&incomplete) {
      const known=jobProjectionFor(prior);
      const attempt=prior.current_attempt;
      const identity=known.version?.jobDigest===prior.job_digest&&
        (known.version?.attemptId??null)===(attempt?.attempt_id??null)&&
        (known.version?.generation??null)===(Number.isSafeInteger(attempt?.generation)?attempt.generation:null);
      if(['waiting','approval_pending','approved','starting','running','stopping'].includes(known.phase)&&identity) {
        return {...prior,jobProjection:{...known,actionHints:[],observation:{
          state:projection.reasonCode==='observation_unavailable'?'last_known':'transitional',
          at:known.times.observedAt,reason:projection.reasonCode}}};
      }
    }
    return current;
  }
  if (error) return null;
  return created;
}

// Older cancel responses return an acknowledgement rather than a projected job record.
export function cancelledJobProjection(job = {}, cancellation = {}, {hasNewerRead = false} = {}) {
  if (hasNewerRead) {
    const latest = jobProjectionFor(job);
    if (latest.phase !== 'unknown') return latest;
  }
  // An unavailable or invalid follow-up projection cannot replace the cancel
  // acknowledgement with an older-looking runnable state.
  if (cancellation?.jobProjection !== undefined) return createJobProjection(cancellation.jobProjection);
  return jobProjectionFor({...job,...cancellation,jobProjection:undefined,state:'cancelled',
    current_attempt:cancellation.attempt ?? job.current_attempt,
    compute_stopped:cancellation.compute_stopped});
}

// A successful apply response confirms the application outcome before the next
// detail read. It cannot change the job's execution phase.
export function confirmedAppliedJob(job = {}, applied) {
  const projection = jobProjectionFor(job);
  if (projection.phase !== 'result_accepted' || typeof applied?.branch !== 'string' ||
      !applied.branch.trim() || applied.branch.length > 1024) return job;
  return {...job,applied,jobProjection:createJobProjection({...projection,
    application:{...projection.application,appliedBranch:applied.branch}})};
}

const PHASE_KEY = Object.freeze({
  waiting: 'waiting', approval_pending: 'waiting_approval', approved: 'approved',
  starting: 'starting', running: 'working', stopping: 'stop_requested',
  stopped: 'stopped', failed: 'failed', expired: 'expired',
  result_accepted: 'ready', unknown: 'unknown',
});
const SAFE_REASON_CODES = new Set(['wall_timeout','output_too_large','execution_failed','tests_failed',
  ...RESULT_DELIVERY_FAILURE_CODES,...LENDER_INTERRUPTION_CODES,
  'requirements_unsupported','policy_unenforceable',
  'stopped_by_lender','approval_denied','agent_signed_out','sandbox_failed','sandbox_not_ready',
  'readiness_changed','sandbox_start_failed','sandbox_ready_timeout','entrypoint_start_failed','agent_exit_nonzero','agent_group_not_ceased','agent_run_failed']);

// Execution phase always comes from the projection. Repository outcomes only decorate an accepted result.
export function formatJobProjection(job = {}) {
  const projection = jobProjectionFor(job);
  let key = PHASE_KEY[projection.phase] ?? 'unknown';
  if (projection.phase === 'stopping' && projection.evidence.stopVerification === 'failed') key = 'stop_unconfirmed';
  if (projection.phase === 'stopped' && projection.reasonCode === 'cancelled_before_start') key = 'cancelled';
  if (projection.phase === 'result_accepted') {
    if (projection.application.appliedBranch) key = 'added_branch';
    else if (job.resultSummary?.noChanges === true) key = 'no_changes';
  }
  const legacy = job?.jobProjection === undefined;
  const waiting = projection.phase === 'waiting';
  // A fenced launch is not "getting ready": its earlier run may still be going, so the sender sees when Faravan retries.
  const fenceUntil = waiting ? projection.evidence.launchFenceUntil : undefined;
  const fenceLine = typeof fenceUntil === 'string' ? launchFenceLine(formatDate(fenceUntil, 'clock')) : '';
  const preparing = waiting && !fenceLine && ['claimed','starting','running'].includes(projection.evidence.rawState);
  const preparingCopy = 'A computer took this job and is getting ready.';
  const statusContract = job?.statusContract;
  const projectedExplanation = waiting ? (fenceLine || (!legacy ? boundedCopy(projection.evidence.waitingExplanation) : '')) : '';
  const sharedExplanation = waiting && !fenceLine && statusContract?.lifecycle === 'waiting' &&
    (legacy || statusContract.reasonCode === projection.reasonCode) && typeof statusContract.explanation === 'string'
    ? statusContract.explanation : projectedExplanation;
  const sharedWaitingSummary = sharedExplanation.includes(' · ')
    ? sharedExplanation.slice(sharedExplanation.indexOf(' · ') + 3) : sharedExplanation;
  // The server's lead-in ("Nobody can take it right now") is its verdict; a heading must not soften it.
  const sharedLeadIn = sharedExplanation.includes(' · ') ? sharedExplanation.slice(0, sharedExplanation.indexOf(' · ')) : '';
  const waitingHeadline = waiting && (legacy
    ? projection.reasonCode !== null && boundedCopy(job?.waiting_message) || projectedExplanation
    : projectedExplanation);
  const failureDetails = ['failed','stop_unconfirmed'].includes(key) ? {
    reason:SAFE_REASON_CODES.has(projection.reasonCode) ? projection.reasonCode : null,
    ...(typeof projection.evidence.failurePhase === 'string' && ['prepare','run','result'].includes(projection.evidence.failurePhase)
      ? {phase:projection.evidence.failurePhase} : {}),
    ...(key === 'stop_unconfirmed' && projection.times.observedAt ? {observedAt:projection.times.observedAt} : {}),
    ...(key === 'stop_unconfirmed' && projection.times.nextTransitionAt ? {nextTransitionAt:projection.times.nextTransitionAt} : {}),
  } : null;
  const previousAttemptState = projection.evidence.previousAttemptState ?? null;
  const previousReason = projection.evidence.previousReason ??
    (['released','failed','expired'].includes(previousAttemptState) ? 'preparation_failed' : null);
  // The app sets approvalHold on an own job whose identity check failed; the sender sees its reason and clearing action.
  const hold = job?.approvalHold?.reason && job.approvalHold.action
    ? {reason: boundedCopy(job.approvalHold.reason), action: boundedCopy(job.approvalHold.action)} : null;
  return {projection, key, preparing, hold, sharedWaitingSummary:preparing ? '' : sharedWaitingSummary,
    sharedLeadIn:preparing ? '' : sharedLeadIn, waitingHeadline:preparing ? preparingCopy : waitingHeadline,
    waitingReason:waiting ? projection.reasonCode : null,
    noLender:waiting && projection.reasonCode === 'agent_unavailable', failureDetails,
    previousReason,
    previousAttemptState,
    previousAttemptHolder:projection.evidence.previousAttemptHolder ?? null};
}

function boundedCopy(value) {
  return typeof value === 'string' && value.trim() && value.length <= 1000 ? value.trim() : '';
}
