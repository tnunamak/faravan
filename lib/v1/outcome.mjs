// The one vocabulary for a write whose result is uncertain. The host, client, ops, CLI, MCP and browser
// import it, so outcome values and operation-key rules cannot drift between surfaces.
//   not_applied: the host refused the write. Sending it again as a new write is safe.
//   unknown:     the write may have been applied (lost response, timeout, unreadable acknowledgement).
//                Retry the same request with the same operation key. Never start a second write.
// A job send whose outcome is unknown also names its job (jobDigest), so the caller follows that job instead of
// sending another.
export const OUTCOMES = Object.freeze(['not_applied', 'unknown']);
export const OPERATION_KEY = /^[A-Za-z0-9._~-]{1,128}$/;

export const isOutcome = value => OUTCOMES.includes(value);
export const isOperationKey = value => typeof value === 'string' && OPERATION_KEY.test(value);
const JOB_DIGEST = /^sha256:[0-9a-f]{64}$/;

// Copies only valid outcome fields. An invalid value is dropped, never guessed.
export function outcomeFields(source) {
  return {
    ...(isOutcome(source?.outcome) ? {outcome: source.outcome} : {}),
    ...(isOperationKey(source?.operationKey) ? {operationKey: source.operationKey} : {}),
    ...(source?.outcome === 'unknown' && JOB_DIGEST.test(source?.jobDigest ?? '') ? {jobDigest: source.jobDigest} : {}),
  };
}
