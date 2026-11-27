import {createLendingProjection} from '../../../lib/v1/state-projection.mjs';

// Compact, explicit domain evidence for Home/Lending fixtures. This keeps UI mocks
// aligned with the server tuple while leaving the production legacy adapter exercised
// only by tests that intentionally model an old API response.
export function withLendingProjection(status, {
  intent = 'on', intentState = 'ready', admission = 'allowed', admissionReason = null,
  execution = 'idle', executionJob = null, dailyLimitReached = false,
} = {}) {
  return {...status, lendingProjection:createLendingProjection({
    schemaVersion:2, kind:'lending', intent, admission, admissionReason, execution, executionJob,
    evidence:{intentState, dailyLimitReached, executionState:execution}, version:'fixture-v2',
  })};
}
