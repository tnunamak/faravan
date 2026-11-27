// Synthetic foundation-walk driver only. No product APIs or credential access.
import { createHash } from 'node:crypto';

const CHECKS = ['W04_ACCOUNT_OPTIONS', 'W05_SEND_SELECTED', 'W06_RESULT_RETURN'];
export const FOUNDATION_PROMPT = 'Return exactly FOUNDATION_OK in your final message. Create foundation-result.txt containing FOUNDATION_OK.';
const EXPECTED = 'FOUNDATION_OK';
const hash = text => createHash('sha256').update(text).digest('hex');

/**
 * Fake UI transcript fixture for the existing runner's run/resume/cleanup port.
 * Caller owns this disposable fixture across driver reconstruction. No real
 * identity, signing or UI claim is made. All receipts mark fixtureIntervention.
 * A pending action is reconciled, never replayed. Cleanup preserves login state.
 */
export function createAccountAndSendDriver(fixture) {
  const { accountId, jobId, attemptId, readingAgeMs, model, effort } = fixture;
  if (![accountId, jobId, attemptId, model, effort].every(x => typeof x === 'string' && x.length)
      || !Number.isFinite(readingAgeMs) || readingAgeMs < 0) throw new Error('invalid_fixture');
  fixture.actions ??= [];
  fixture.completed ??= [];
  fixture.pending ??= null;
  fixture.temporary ??= [];
  let busy = false;
  const observed = code => ({
    code, accountId, jobId, attemptId, readingAgeMs, fixtureIntervention: true,
  });
  const result = (check, outcome, code, pause) => ({
    outcome, observed: observed(code),
    // No files are written by this fake: do not manufacture evidence paths.
    evidencePaths: [],
    ...(pause ? { pause } : {}),
  });
  const sameIdentity = row => row?.schemaVersion === 1 && row.accountId === accountId
    && row.jobId === jobId && row.attemptId === attemptId && row.readingAgeMs === readingAgeMs;
  function valid(check, row) {
    if (!sameIdentity(row)) return false;
    if (check === CHECKS[0]) return row.enrollment === 'confirmed' && row.lendingMode === 'auto'
      && row.supported === true && row.requestedModel === model && row.effectiveModel === model
      && row.requestedEffort === effort && row.effectiveEffort === effort;
    if (check === CHECKS[1]) return row.project === null && row.submission === 'confirmed'
      && row.prompt === FOUNDATION_PROMPT && row.requestedModel === model && row.effectiveModel === model
      && row.requestedEffort === effort && row.effectiveEffort === effort;
    // A synthetic signature verdict is not cryptographic verification. This
    // verifies the walk checks the verdict and binding, not a real signature.
    return row.message === EXPECTED && row.downloadedText === EXPECTED
      && row.artifact?.signatureVerified === true && sameIdentity(row.artifact)
      && row.artifact.sha256 === hash(row.downloadedText);
  }
  async function execute({ check, signal }, recovering) {
    if (busy) throw new Error('driver_already_running');
    busy = true;
    try {
      if (!CHECKS.includes(check)) return result(check, 'blocked', 'outside_fake_driver_scope');
      if (signal?.aborted) return result(check, 'blocked', 'cancelled');
      const index = CHECKS.indexOf(check);
      if (fixture.completed.includes(check)) return structuredClone(fixture.receipts[check]);
      if (index > 0 && !fixture.completed.includes(CHECKS[index - 1]))
        return result(check, 'blocked', 'prior_step_unconfirmed');
      if (fixture.pending && fixture.pending !== check)
        return result(check, 'blocked', 'different_step_pending');
      if (recovering && fixture.pending !== check)
        return result(check, 'blocked', 'no_pending_action');
      if (!recovering && fixture.pending)
        return result(check, 'blocked', 'reconciliation_required');
      if (!recovering) {
        // Set pending before the synthetic effect. A missing observation is
        // ambiguous, never permission to submit/enroll again.
        fixture.pending = check;
        fixture.actions.push({
          schemaVersion: 1, check, accountId, jobId, attemptId, readingAgeMs,
          action: ['enroll_and_select', 'send', 'inspect_result'][index],
          ...(index === 0 ? { via: 'Faravan', lendingMode: 'auto',
            requestedModel: model, requestedEffort: effort } : {}),
          ...(index === 1 ? { project: null, prompt: FOUNDATION_PROMPT,
            requestedModel: model, requestedEffort: effort } : {}),
        });
      }
      const row = fixture.ui?.[check];
      if (row?.loginRequired) return result(check, 'blocked', 'account_signed_out', 'login');
      if (!row) return result(check, 'blocked', 'observation_ambiguous', 'login');
      if (!valid(check, row)) return result(check, 'fail', 'ui_receipt_mismatch');
      const receipt = result(check, 'pass', 'synthetic_ui_confirmed');
      fixture.receipts ??= {};
      fixture.receipts[check] = structuredClone(receipt);
      fixture.completed.push(check);
      fixture.pending = null;
      return receipt;
    } finally { busy = false; }
  }
  return {
    run: args => execute(args, false),
    resume: args => execute(args, true),
    cleanup: async () => {
      fixture.temporary.splice(0);
      return result('W10_CLEANUP', 'pass', 'synthetic_cleanup');
    },
  };
}
