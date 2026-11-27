// Classifies a failure at the point a call to a circle's host ends, before anything strips the error down to a code.
// Only a positively identified host transport failure or host-call deadline says the host is unreachable. A person's
// Stop or Quit stays "cancelled", a host that answered (auth refusal, malformed reply) keeps its own code, and a local
// disk or programming error is left alone for the caller to report as an internal error.
import {isOutcome, isOperationKey} from './outcome.mjs';

export const CIRCLE_UNREACHABLE = 'circle_unreachable';
const GATEWAY = new Set([502, 503, 504]);
const abortLike = error => ['TimeoutError', 'AbortError'].includes(error?.name);

// Evidence of a received response, never proof that the host rather than a gateway answered.
// Copy only bounded typed scalars; raw problems, headers and causes stay in-process.
export function receivedResponse(source) {
  if (!Number.isInteger(source?.status) || source.status < 100 || source.status > 599) return undefined;
  const result = {status: source.status};
  if (typeof source.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(source.code)) result.code = source.code;
  if (isOutcome(source.outcome)) result.outcome = source.outcome;
  if (isOperationKey(source.operationKey)) result.operationKey = source.operationKey;
  if (Number.isFinite(source.retryAfterSeconds) && source.retryAfterSeconds >= 0 &&
      source.retryAfterSeconds <= Number.MAX_SAFE_INTEGER) result.retryAfterSeconds = source.retryAfterSeconds;
  return result;
}

export function circleUnreachable(cause) {
  const error = Object.assign(new Error(CIRCLE_UNREACHABLE, cause === undefined ? undefined : {cause}),
    {code: CIRCLE_UNREACHABLE, status: 409, retryable: true});
  const response = receivedResponse(cause?.receivedResponse);
  if (response) error.receivedResponse = response;
  return error;
}
export function cancelled() {
  return Object.assign(new Error('cancelled'), {code: 'cancelled', status: 409});
}

/**
 * `callerSignal` is the person's own signal (Stop, Quit, request abort). The host-call deadline is a different signal
 * that the caller does not pass here, so a deadline is never confused with a person's cancel.
 */
export function classifyHostFailure(error, {callerSignal} = {}) {
  if (error?.code === CIRCLE_UNREACHABLE || error?.code === 'cancelled') return error;
  if (callerSignal?.aborted && (error === callerSignal.reason || abortLike(error))) return cancelled();
  if (GATEWAY.has(error?.status)) return circleUnreachable(error);
  if (error?.code === 'network_error') return circleUnreachable(error);
  if (typeof error?.code === 'string') return error;
  if (abortLike(error)) return circleUnreachable(error);
  if (error instanceof TypeError) return circleUnreachable(error);
  return error;
}

/** Runs one host call and classifies whatever it throws. */
export async function hostCall(run, {callerSignal} = {}) {
  try { return await run(); } catch (error) { throw classifyHostFailure(error, {callerSignal}); }
}
