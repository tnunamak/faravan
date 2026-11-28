import { createHash, randomInt } from 'node:crypto';

// EXPERIENCE §1.5. This module classifies only; it does not settle counters,
// change queue state, or put private diagnostics into borrower-facing copy.
// Keys name the six copy rows in that table, for a presentation-layer adapter.
// outcome is requeue (before the agent started), failed, expired, cancelled, delayed (result delivery retries) or
// uncertain (EXPERIENCE 1.6, T21: a started job that may have run in part never requeues by itself).
const groups = {
  lender_setup: ['lender', 'requeue', false, `
    isolation_check_failed isolation_check_inconclusive objective_evidence_unknown resources_incomplete account_week_mapping_unknown conversion_unknown
    agent_signed_out agent_not_ready not_signed_in sandbox_not_ready docker_sandboxes_restarted readiness_changed
    prepare_failed sandbox_start_failed sandbox_credential_store_failed credential_store_unreadable sandbox_ready_timeout entrypoint_start_failed launch_ack_failed
    invalid_policy invalid_counter_store counter_lock_required lender_already_running
    lender_dependencies_required lending_recovery_required protection_not_ready audit_unavailable autostart_failed transcript_scan_unavailable
    app_already_running identity_changed approval_unavailable approval_changed approval_decided sandbox_backend_unavailable
    git_source_unsupported preparation_failed preparation_timeout cleanup_pending guard_runtime_unavailable guard_install_failed lending_unavailable
    credential_scope_unenforceable credential_writer_unresolved scratch_cleanup_pending storage_unenforceable native_credentials_owner_only host_disk_low host_disk_unreadable disk_protection_unavailable removal_open
    claude_account_unavailable adapter_unsupported job_binding_mismatch
  `],
  lender_stop: ['lender', 'requeue', false, `
    stopped_by_lender lending_off paused hold_release_requested approval_denied approval_skipped approval_timeout approval_expired
    approval_pending daily_limit requester_limit quota_reserve quota_unknown native_attempt_in_flight window_not_open lending_window_removed model_not_lendable
    user_active lending_busy decline_exclusions_full outside_hours hidden inbox_closed offer_taken rule_limit standing_rule_changed busy lender_stopped lender_starting machine_checking update_in_progress
    circle_unreachable conditions_unavailable sandbox_check_pending
  `],
  // The hosting config cannot be read, so the app shows its state as unknown rather than stopped.
  // Check access to the hosting config and try again.
  platform: ['platform', 'requeue', false, `
    lease_expired lease_expired_unproven lease_uncertain network_error sandbox_crash restart_interrupted restart_before_start
    stale_attempt cessation_unverified sandbox_cleanup_unverified cleanup_check_failed cleanup_snapshot_misuse sandbox_inventory_incomplete stop_unrecorded host_config_unreadable execution_observation_failed unavailable internal_error decline_after_launch rate_limited
    roster_stale roster_expired enrollment_expired unauthenticated unauthorized
    invalid_signature replay forbidden conflict idempotency_conflict not_found not_designated
    enrollment_conflict artifact_missing prompt_unavailable digest_mismatch size_mismatch
    claim_failed claim_rejected release_rejected release_unknown released completion_unknown
    lender_failed stop_report_pending app_closing app_quitting agent_check_timeout observation_changed
    operation_failed invite_unreachable action_unavailable lock_busy no_current_job not_connected resume_pending invalid_response leave_unconfirmed
    author_mismatch executor_mismatch key_mismatch holder_revoked author_revoked
    input_copy_failed git_source_transfer_failed sandbox_stop_failed guard_record_invalid guard_record_unverified history_write_failed error
  `],
  job: ['job', 'failed', true, `
    execution_failed agent_error agent_exit_nonzero agent_group_not_ceased agent_run_failed wall_timeout output_too_large tests_failed
  `],
  request: ['request', 'failed', false, `
    requirements_unsupported policy_unenforceable limits_unenforceable invalid_source invalid_working_directory
    invalid_request invalid_run_request wrong_circle circle_ambiguous circle_required origin_required cursor_invalid payload_too_large quota_exceeded
    result_unavailable unsupported_version retry_exhausted job_terminal job_changed job_taken job_running config_changed apply_refused repo_refused git_source_invalid
    git_source_unavailable git_source_egress_unsupported wall_limit too_large source_timeout
    invalid_content_type invalid_host invalid_origin invalid_invite local_session_required human_only platform_unsupported saved_read_retired
    warning_not_acknowledged confirmation_required not_author not_owner invalid_circle_profile invite_used
    host_too_old circle_members_need_update host_update_required circle_must_be_closed device_busy ownership_transfer_required ownership_transfer_pending
    circle_closed invalid_person_link role_conflict person_blocked publication_pending transfer_expired transfer_mismatch authority_chain invalid_job_spec not_your_job followup_base_unavailable followup_result_changed prompt_preview_too_large client_update_required
  `],
  // The result is stored on the lender and the upload failed: the lender retries it for 24 h (EXPERIENCE 1.6).
  delivery: ['platform', 'delayed', false, `
    delivery_delayed output_save_pending
  `],
  result_delivery: ['platform', 'failed', false, `
    candidate_missing candidate_invalid git_commit_unverified git_commit_mismatch
    model_unverified meter_unavailable completion_rejected result_not_delivered result_kind_mismatch git_failed
    output_path_invalid output_copy_failed output_missing output_invalid check_workspace_failed check_workspace_mismatch
  `],
};

const rows = Object.create(null);
for (const [key, [owner, outcome, job, codes]] of Object.entries(groups)) {
  for (const code of codes.trim().split(/\s+/)) {
    if (Object.hasOwn(rows, code)) throw new Error('Duplicate failure classification: ' + code);
    rows[code] = Object.freeze({owner, outcome, job, key: key === 'delivery' ? 'result_delivery' : key});
  }
}
for (const code of ['expired', 'job_expired', 'invitation_expired']) {
  rows[code] = Object.freeze({owner:'request', outcome:'expired', job:false, key:'request'});
}
rows.cancelled = Object.freeze({owner:'request', outcome:'cancelled', job:false, key:'request'});

// An explicit registry lets the source-coverage test distinguish a reviewed row
// from the safe fallback. Never infer a row from the spelling of a new code.
export const FAILURE_CODES = Object.freeze(Object.keys(rows).sort());
// A lender's own decision to stop, or a cancelled request: the codes telemetry counts as decisions rather than faults.
export const isLenderDecision = code => typeof code === 'string' && Object.hasOwn(rows, code) && (rows[code].key === 'lender_stop' || code === 'cancelled');
const fallback = Object.freeze({owner:'platform', outcome:'requeue', job:false, key:'platform'});
const beforeStart = new Set(['before_claim', 'before_start', 'prepare', 'start']);
const noRun = new Set(['approval_denied', 'approval_skipped', 'approval_timeout', 'approval_expired',
  'approval_pending', 'daily_limit', 'requester_limit', 'quota_reserve',
  'quota_unknown', 'model_not_lendable', 'user_active', 'wall_limit', 'decline_exclusions_full', 'outside_hours', 'hidden', 'inbox_closed', 'offer_taken', 'rule_limit', 'standing_rule_changed']);

const base32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function errorId(code, jobDigest) {
  // Frame the pair to avoid ambiguous concatenation. Exclude phase and time.
  const input = JSON.stringify([
    typeof code === 'string' ? code : '',
    typeof jobDigest === 'string' ? jobDigest : '',
  ]);
  const hash = createHash('sha256').update(input).digest();
  // First 20 bits, encoded with the RFC 4648 alphabet (no padding).
  const bits = (hash[0] << 12) | (hash[1] << 4) | (hash[2] >>> 4);
  return 'SPK-' + [15, 10, 5, 0].map(shift => base32[(bits >>> shift) & 31]).join('');
}

/**
 * Six random characters chosen once, where a failure happens. The full correlation ID
 * is `<job>-<ref>` (EXPERIENCE 1.5); the SPK- label above is its short, display-only form.
 * classify() stays pure, so the caller that records or reports the failure owns the ref.
 */
export function newErrorRef() {
  return Array.from({ length: 6 }, () => base32[randomInt(32)]).join('');
}

/**
 * Pure failure policy. phase is before_claim | before_start | prepare | start |
 * run | result. Omitted/unknown phases conservatively retain actual agent time.
 * counts.job is whether to charge one job; counts.minutes is 'none' or 'actual'.
 * 'actual' means measured agent time, never the reservation or wall-clock budget.
 * A setup/sign-in failure during a run still refunds the job and counts time.
 * Unknown codes always belong to the platform and requeue.
 * Pass the same canonical job digest on both sides for a shared error_id.
 * Omitted/non-string digests use an empty string: a code-only legacy fallback,
 * not per-job correlation. This short label can collide; it is not a unique ID
 * or an authorization key.
 */
export function classify(code, phase, jobDigest) {
  let row = typeof code === 'string' && Object.hasOwn(rows, code) ? rows[code] : fallback;
  if (code === 'meter_unavailable' && phase !== 'result') {
    row = Object.freeze({owner: 'platform', outcome: 'requeue', job: false, key: 'platform'});
  }
  // Today's generic execution_failed also wraps prepare exceptions. Phase is
  // required to avoid billing the job for an agent that never started.
  if (code === 'execution_failed' && beforeStart.has(phase)) row = rows.prepare_failed;
  const started = !beforeStart.has(phase);
  const noMinutes = !started || noRun.has(code);
  // T21: only a failure before the agent started may requeue. After it started, a lost lease, an unverified stop, any
  // other interruption and any unknown code are "uncertain": the agent may have done part of the work, so nothing runs
  // it again by itself; the lender decides.
  const outcome = row.outcome === 'requeue' && !noMinutes ? 'uncertain' : row.outcome;
  return {
    error_id: errorId(code, jobDigest),
    owner: row.owner,
    outcome,
    counts: {job: started && row.job, minutes: noMinutes ? 'none' : 'actual'},
    borrower_key: 'failure.' + row.key + '.borrower',
    lender_key: row.owner === 'request' ? null : 'failure.' + row.key + '.lender',
  };
}

// Capacity refusals may be reconsidered through fresh admission. Owner decisions,
// unsupported requirements and unknown codes keep their job-lifetime exclusion.
export const PASSING_DECLINE_REASONS = Object.freeze([
  'quota_reserve', 'daily_limit', 'requester_limit',
  'isolation_check_inconclusive',
  'resources_incomplete', 'refresh_failed', 'quota_unknown', 'readiness_changed',
  'sandbox_not_ready', 'cleanup_pending', 'lending_busy', 'busy', 'user_active',
  'account_busy', 'probe_deferred', 'observation_changed',
  'native_attempt_in_flight', 'window_not_open', 'lending_window_missing', 'lending_window_memory_unreadable', 'lending_window_invalid', 'meter_unavailable', 'objective_evidence_unknown', 'stop_bound_unknown',
  // Account admission holds: fresh facts (a sign-in, an allowance reset, a new reading) can clear each one.
  'no_spare', 'account_signed_out', 'provider_limit_reached',
]);
export const isPassingDecline = code => PASSING_DECLINE_REASONS.includes(code);

// A start that fails before the agent runs, for a reason in the lender's own setup. It is not a passing hold and not a
// person's choice, and it spends no run. The lender retries it later, and the coordinator ends a job after as many of
// these as the job has runs (max_attempts), so a job that fails the same way every time cannot cycle until it expires.
// A bare execution_failed before the start is a prepare failure (see classify), so it counts too.
export const isStartFailure = code => classify(code, 'before_start').borrower_key === 'failure.lender_setup.borrower' && !isPassingDecline(code);

export function passingDeclineCode(attempt) {
  if (attempt?.state !== 'released' || attempt.execution_started_at) return null;
  try {
    const code = JSON.parse(attempt.reason)?.code;
    return isPassingDecline(code) ? code : null;
  } catch { return null; }
}
