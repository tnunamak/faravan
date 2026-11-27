/** Transport-independent failures. Only the catalog may turn these into user copy.
 * Diagnostic fields are deliberately separate from allow-listed presentation parameters.
 * This module schedules no retries and performs no writes.
 * @typedef {{code:string, category:string, field?:string, retryPolicy:{kind:string, until?:number}, safeParams:object, diagnosticId:string|null}} Problem
 */
export const PROBLEM_CATEGORIES = Object.freeze({
  access: 'unauthorized invalid_host invalid_origin not_owner forbidden local_session_required',
  validation: 'invalid_request invalid_content_type payload_too_large invalid_petname petname_label_taken invalid_source outside_home folder_missing repo_missing not_git no_commits git_missing upload_file_limit upload_size_limit upload_zip_selection upload_read_failed',
  setup: 'sandbox_not_ready signin_failed signin_unsupported signin_not_waiting_for_code signin_code_invalid signin_redirect_mismatch codex_device_code_unavailable codex_device_code_rate_limited codex_device_code_service_unavailable codex_device_code_exchange_failed codex_device_code_expired agent_not_ready agent_unavailable protection_not_ready autostart_failed credential_writer_unresolved native_credentials_owner_only',
  conflict: 'config_changed identity_changed approval_expired approval_pending conflict job_expired device_busy lending_busy lending_recovery_required publication_pending authority_chain authority_rollback source_changed previous_coordinator_other_install host_still_running host_home_conflict host_config_unreadable host_failed',
  membership: 'circle_ambiguous origin_required person_link_refresh_required invalid_person_link role_conflict person_blocked already_linked ownership_transfer_required ownership_transfer_pending circle_must_be_closed circle_closed host_update_required circle_members_need_update enrollment_rejected invitation_revoked invitation_expired invite_used enrollment_conflict invalid_invite invite_preview_required warning_not_acknowledged invalid_transfer_code transfer_expired transfer_mismatch',
  unavailable: 'action_unavailable not_found result_unavailable app_closing app_load_failed petname_store_full repo_refused apply_refused not_connected attachment_storage attachment_missing image_preview_unavailable',
  connection: 'offline network network_error timeout read_timeout agent_check_timeout invite_unreachable service_unavailable updates_paused project_check_failed',
  limit: 'daily_limit rate_limited',
  uncertain: 'mutation_pending mutation_uncertain submission_uncertain apply_failed save_uncertain hosting_uncertain followup_pending',
  followup: 'followup_missing followup_storage followup_empty followup_too_long',
  apply: 'apply_repo_missing apply_base_missing apply_branch_exists apply_conflict apply_unsafe apply_no_changes apply_locked apply_lock_blocked',
  result: "result_index_flags result_attributes result_dirty result_path_exists result_unsafe_path result_patch_conflict result_unknown_file result_nothing_selected result_too_many_files result_repo_missing result_not_a_repository result_repo_busy result_unsafe_patch result_patch_invalid result_write_failed result_base_missing result_base_unknown result_branch_moved result_not_our_commit result_branch_checked_out result_not_applied",
  phone: "confirm_on_this_computer phone_access_off pairing_not_open too_many_phones no_network address_not_available invalid_hostname phone_local_session_required",
  unknown: 'unknown clipboard',
});
const categories = new Map(Object.entries(PROBLEM_CATEGORIES).flatMap(([category, codes]) => codes.split(' ').map(code => [code, category])));
export const PROBLEM_CODES = Object.freeze([...categories.keys()]);
const fields = new Set(['prompt', 'title', 'circle', 'files', 'git', 'commit', 'name', 'code', 'path', 'model', 'agent']);
const normalized = new WeakSet();
export const LEGACY_COMPOSE_PROBLEMS = Object.freeze({
  'compose.not-git':'not_git', 'compose.no-commits':'no_commits',
  'compose.session-lost':'unauthorized', 'compose.check-failed':'project_check_failed',
  'compose.repo-missing':'repo_missing',
});
export const LEGACY_APPLY_PROBLEMS = Object.freeze({
  'job.apply-repo-missing':'apply_repo_missing', 'job.apply-base-missing':'apply_base_missing',
  'job.apply-branch-exists':'apply_branch_exists', 'job.apply-conflict':'apply_conflict',
  'job.apply-unsafe':'apply_unsafe', 'job.no-changes':'apply_no_changes', 'job.apply-failed':'apply_failed',
  'job.apply-lock-blocked':'apply_lock_blocked', 'job.apply-locked':'apply_locked',
});

export function retryAfterUntil(value, now = Date.now()) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!text || !Number.isFinite(now)) return null;
  const until = /^\d+(?:\.\d+)?$/.test(text) ? now + Number(text) * 1000 :
    // Require an HTTP-date, rather than Date.parse's permissive numeric/date guesses.
    /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text) ? Date.parse(text) : NaN;
  return Number.isFinite(until) && until <= 8640000000000000 ? Math.max(now,until) : null;
}

/** One legacy adapter for response bodies, Error objects, and network failures.
 * Unknown codes never acquire server-provided prose or an inferred cause.
 * method/outcomeUncertain are boundary facts, never guessed from message text.
 */
export function normalizeProblem(input, options = {}) {
  if (normalized.has(input?.problem) && Object.keys(options).length === 0) return input.problem;
  if (normalized.has(input) && Object.keys(options).length === 0) return input;
  const {status = input?.status, retryAfter, now = Date.now(), method = 'GET', outcomeUncertain = false} = options;
  const source = input && typeof input === 'object' ? input : {};
  const candidate = (source.code==='repo_refused'&&categories.has(source.repo_code)?source.repo_code:null) ??
    (source.code==='apply_refused'&&categories.has('result_'+source.apply_code)?'result_'+source.apply_code:null) ??
    source.code ?? LEGACY_COMPOSE_PROBLEMS[source.state] ?? LEGACY_APPLY_PROBLEMS[source.state];
  const known = typeof candidate === 'string' && categories.has(candidate);
  let code = known ? candidate : 'unknown';
  if (status === 401) code = 'unauthorized';
  else if (status === 429) code = 'rate_limited';
  else if (!known && !source.code && status === 409) code = 'conflict';
  else if (!known && !source.code && status === 404) code = 'not_found';
  if (outcomeUncertain && !['GET', 'HEAD'].includes(method.toUpperCase())) code = 'mutation_uncertain';
  const until = retryAfterUntil(retryAfter, now);
  const retryPolicy = code === 'rate_limited' ? (until === null ? {kind:'wait'} : {kind:'wait-until', until}) :
    categories.get(code) === 'uncertain' ? {kind:'check-status'} : {kind:'manual'};
  // No dynamic copy parameters are currently needed. Expand this schema per code;
  // do not admit arbitrary names/messages by filtering suspicious characters.
  const problem = Object.freeze({code, category:categories.get(code),
    ...(fields.has(source.field) ? {field:source.field} : {}),
    retryPolicy:Object.freeze(retryPolicy), safeParams:Object.freeze({}),
    diagnosticId:typeof source.diagnosticId === 'string' ? source.diagnosticId.slice(0,160) :
      typeof source.error_id === 'string' ? source.error_id.slice(0,160) : null});
  normalized.add(problem);
  return problem;
}

/** Empty is a successful read outcome, never a fallback for missing or failed data. */
export function readState({loading = false, error = null, data, hasMembership = true, filtered = false} = {}) {
  if (error) return {kind:data === undefined ? 'unavailable' : 'stale-with-data', problem:normalizeProblem(error), ...(data === undefined ? {} : {data})};
  if (loading || data === undefined) return {kind:'loading'};
  if (!hasMembership) return {kind:'no-membership'};
  if (!Array.isArray(data)) throw new TypeError('A list read must return an array');
  return data.length ? {kind:'loaded', data} : {kind:filtered ? 'filtered-empty' : 'loaded-empty', data};
}
