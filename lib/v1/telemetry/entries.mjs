// What may leave a computer: the declared entries, their enums and their bucket sets. Data only.
// scripts/gen-telemetry-catalog.mjs resolves the enums from the code that owns them and writes catalog.json;
// catalog.mjs validates against that file. docs/design/TELEMETRY-WIRE.md states the rules. Design: TELEMETRY.md §2.2, §3.
//
// There is no free string type. A value on the wire is a bool, a bounded integer, or a string that is a member of
// a declared enum, a label of a declared bucket set, a release version, or a random ID of a fixed pattern.
// Entries are append-only: to change one, add a new name and let the old one expire (the generator refuses an edit).

/** A named enum: `extra` are literal members; `from` names owner registries the generator reads (never copies). */
const en = (extra, from = []) => ({from, extra});
const own = (owner, extra = []) => en(extra, [owner]);

export const ENUMS = Object.freeze({
  // Owner registries (the generator reads each from its owner; see OWNERS in scripts/gen-telemetry-catalog.mjs).
  error_type: en(['unknown'], ['failure_code', 'problem_code']),
  op: own('op_id', ['none']),
  route: own('route'),
  readiness_check: own('readiness_check'),
  health_check: own('readiness_check', ['agent_signin', 'quota_meter', 'circle_connection', 'coordinator_tunnel',
    'phone_listener', 'event_history_durable', 'notifications', 'updater', 'app_reachable', 'outbox']),
  preset: own('lending_preset', ['unknown']),
  plan: own('account_plan'),
  stop_reason: own('charged_stop_reason', ['owner', 'provider_limit', 'error']),
  catalog_entry: own('catalog_entry', ['none']),
  shipped_file: own('shipped_file'),
  // Literal members, declared here.
  surface: en(['http', 'cli', 'mcp', 'ui', 'phone', 'tray', 'background', 'installer', 'coordinator']),
  ui_surface: en(['ui', 'phone']),
  component: en(['app', 'ops', 'phone', 'lender', 'coordinator', 'tray', 'installer']),
  problem_registry: en(['failure', 'problem']),
  phase: en(['before_claim', 'before_start', 'prepare', 'start', 'run', 'result', 'none']),
  failure_outcome: en(['requeue', 'failed', 'expired', 'cancelled', 'delayed', 'uncertain']),
  api_area: en(['activity', 'agents', 'approvals', 'chatgpt', 'circles', 'contributions', 'decisions', 'desktop', 'devices', 'events',
    'folders', 'handoff', 'hosting', 'jobs', 'lending', 'notification-settings', 'notifications', 'ops', 'phone', 'readiness', 'repo',
    'setup', 'shutdown', 'signin', 'source', 'telemetry', 'updates', 'other']),
  harness: en(['claude-code', 'codex', 'any', 'unknown']),
  effort: en(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'unknown']),
  egress: en(['internet', 'provider-only']),
  source_kind: en(['none', 'folder', 'git', 'files', 'zip']),
  result_kind: en(['branch', 'message', 'files']),
  health_state: en(['ok', 'degraded', 'blocked', 'off', 'unknown']),
  readiness_state: en(['ok', 'blocked', 'unknown']),
  crash_kind: en(['uncaught_exception', 'unhandled_rejection', 'panic', 'start_failed']),
  js_error_class: en(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'SystemError', 'other']),
  errno: en(['none', 'EACCES', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EAGAIN', 'EBADF', 'EBUSY', 'ECONNREFUSED', 'ECONNRESET', 'EEXIST',
    'EHOSTUNREACH', 'EINTR', 'EINVAL', 'EIO', 'EISDIR', 'ELOOP', 'EMFILE', 'ENAMETOOLONG', 'ENETUNREACH', 'ENFILE', 'ENOENT',
    'ENOMEM', 'ENOSPC', 'ENOTDIR', 'ENOTEMPTY', 'EPERM', 'EPIPE', 'EROFS', 'ETIMEDOUT', 'ETXTBSY', 'EXDEV']),
  service: en(['app', 'tray', 'coordinator']),
  job_role: en(['borrower', 'lender']),
  job_outcome: en(['finished', 'failed', 'stopped', 'cancelled', 'expired', 'uncertain', 'abandoned']),
  job_stage: en(['waiting', 'claim', 'prepare', 'start', 'run', 'verify', 'result']),
  update_owner: en(['faravan', 'apt', 'brew']),
  upgrade_stage: en(['check', 'download', 'verify', 'swap', 'restart', 'first_healthy_start']),
  upgrade_outcome: en(['applied', 'staged', 'failed', 'rolled_back', 'abandoned']),
  install_method: en(['deb', 'tarball', 'brew', 'macapp']),
  install_outcome: en(['ok', 'session_unknown', 'quit_unanswered', 'restart_failed', 'tray_restart_failed', 'deferred']),
  signin_outcome: en(['complete', 'failed', 'cancelled', 'timed_out']),
  agent_set: en(['none', 'claude', 'codex', 'both']),
  consent_level: en(['counts', 'diagnostics']),
  self_reason: en(['dropped_age', 'dropped_bytes', 'rejected', 'tripwire', 'inbox_invalid', 'stale_generation', 'rollup_full',
    'offer_map_full', 'upload_failed', 'internal_error']),
  milestone: en(['installed', 'app_started', 'docker_ready', 'agent_signed_in', 'circle_joined', 'circle_hosted',
    'lending_on', 'first_offer_seen', 'first_job_lent', 'first_job_sent', 'first_result', 'first_apply', 'upgraded']),
  friction_kind: en(['action_repeated', 'dead_end', 'recovery_shown', 'recovery_action', 'flow_abandoned', 'error_banner']),
  // Recovery actions of the problem catalog (ui/v1/src/problem-catalog.mjs on origin/cycle3-problem-catalog).
  // TODO: read them from their owner once that branch merges.
  recovery_action: en(['none', 'check-status', 'select-text', 'reconnect', 'use-computer', 'edit-fields', 'reload', 'choose-files',
    'setup', 'sign-in', 'choose-agent', 'circles', 'check-connection', 'review-settings', 'review-request', 'ask-owner',
    'review-members', 'review-invite', 'wait', 'review-result', 'review-storage', 'new-job', 'download-result']),
  offer_outcome: en(['admitted_auto', 'accepted_manual', 'declined_manual', 'hidden', 'expired_visible', 'taken_by_other', 'ineligible']),
  // Gate reasons. The ones that are failure codes are checked against FAILURE_CODES by tests/telemetry-catalog-gen.test.mjs.
  offer_reason: en(['machine_capacity','model_not_lendable','invalid_request','readiness_changed','objective_evidence_unknown',
  'resources_incomplete','account_week_mapping_unknown','unreadable_window_origin','conversion_unknown','meter_unavailable','observation_changed',
    'native_attempt_in_flight', 'window_not_open', 'internal_error', 'quota_reserve', 'quota_unknown', 'daily_limit', 'requester_limit', 'user_active', 'outside_hours',
    'sandbox_not_ready', 'requirements_unsupported', 'rule_limit', 'paused', 'confirming_surplus', 'agent_signed_out',
    'model_unsupported', 'git_unpinned', 'not_evaluated', 'none']),
  offer_mode: en(['ask', 'auto', 'rule']),
  request_outcome: en(['claimed', 'expired_unclaimed', 'cancelled_unclaimed', 'retry_exhausted']),
  provider: en(['claude', 'codex']),
});

/**
 * Bucket sets. A label is the smallest bound that is >= the value (as a string, or the `labels` entry at its index).
 * An open set adds the label "inf" for larger values; a closed set clamps to its last bound. A histogram has
 * bounds.length + 1 bins, the last one for larger values.
 */
export const BUCKET_SETS = Object.freeze({
  duration_s: {bounds: [1, 5, 15, 60, 300, 900, 1800, 3600, 7200, 21600, 86400]},
  wait_s: {bounds: [60, 300, 1800, 7200, 21600, 86400, 259200]},
  pct10: {bounds: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100], closed: true},
  points: {bounds: [0, 1, 2, 5, 10, 20, 40]},
  small: {bounds: [0, 1, 2, 3, 5, 10, 20]},
  coverage: {bounds: [0.25, 0.5, 0.75, 0.9, 1], closed: true},
  since_install: {bounds: [3600, 86400, 604800, 2592000], labels: ['1h', '1d', '7d', '30d']},
});

// Type descriptors. An attribute is `{type, ...}`; `optional` means the key may be absent.
const T = {
  enum: name => ({type: 'enum', enum: name}),
  bool: () => ({type: 'bool'}),
  int: (min, max) => ({type: 'int', min, max}),
  bucket: (set, nullable = false) => ({type: 'bucket', set, ...(nullable ? {nullable: true} : {})}),
  version: () => ({type: 'version'}),
  list: (of, max, min = 0) => ({type: 'list', of, min, max}),
  record: fields => ({type: 'record', fields}),
  optional: type => ({...type, optional: true}),
};
const {enum: e, bool, int, bucket: b, version, list, record, optional: opt} = T;
const MS = int(0, 2 ** 31 - 1);

const entry = (name, kind, stream, rest) => ({name, kind, stream, ...rest});
const sum = (name, period, purpose, origins, attrs, description, maxPerPeriod) =>
  entry(name, 'sum', 'counts', {period, purpose, origins, attrs, description, ...(maxPerPeriod ? {maxPerPeriod} : {})});
const histogram = (name, period, purpose, origins, buckets, attrs, description) =>
  entry(name, 'histogram', 'counts', {period, purpose, origins, buckets, attrs, description});
const diag = (name, kind, purpose, origins, attrs, description) => entry(name, kind, 'diagnostics', {purpose, origins, attrs, description});

const stage = of => list(record({stage: e(of), ms: MS, ok: bool()}), 12);
const readiness = record({docker: e('readiness_state'), sbx: e('readiness_state'), agent_signed_in: e('readiness_state')});
const problemAttrs = {'error.type': e('error_type'), 'problem.registry': e('problem_registry'), component: e('component'), phase: e('phase'),
  outcome: e('failure_outcome'), surface: e('surface')};

/** The phase-1 entries of design §3.4. Derived counts (crash.count, job.outcome.count, ...) take the parent's low-cardinality attributes. */
export const ENTRIES = Object.freeze([
  // Problems and crashes
  sum('problem.count', 'hour', 'breakage', ['app', 'coordinator'], problemAttrs, 'Occurrences of one problem code, by owner component and surface.', 10000),
  diag('problem.observed.readiness', 'event', 'breakage', ['app'], {...problemAttrs, op: opt(e('op')), 'api.area': opt(e('api_area')),
    harness: opt(e('harness')), attempts: opt(b('small')), readiness: opt(readiness)}, 'One exemplar of a problem, with the readiness snapshot.'),
  diag('app.crash', 'event', 'breakage', ['app', 'crash', 'tray'], {'crash.kind': e('crash_kind'), 'js.error_class': e('js_error_class'),
    errno: e('errno'), frames: list(record({file: e('shipped_file'), line: int(0, 1000000)}), 16), uptime: b('duration_s'), crash_loop: bool()},
  'A crash or failed start, as frames of shipped files only.'),
  sum('crash.count', 'hour', 'breakage', ['app'], {'crash.kind': e('crash_kind')}, 'Crashes by kind; derived from app.crash.'),
  sum('app.unclean_exit', 'day', 'breakage', ['app'], {'service.name': e('service')}, 'A running marker that survived to the next start.'),
  // Lifecycle spans and what they derive
  diag('job.run', 'span', 'breakage', ['app'], {'job.role': e('job_role'), outcome: e('job_outcome'), 'error.type': opt(e('error_type')),
    'stop.reason': opt(e('stop_reason')), harness: opt(e('harness')), effort: opt(e('effort')), egress: opt(e('egress')),
    'source.kind': opt(e('source_kind')), 'result.kind': opt(e('result_kind')), verify: opt(bool()), attempts: opt(b('small')),
    stages: opt(stage('job_stage'))}, 'One job from this computer, borrower or lender.'),
  sum('job.outcome.count', 'hour', 'breakage', ['app'], {'job.role': e('job_role'), outcome: e('job_outcome'), 'error.type': opt(e('error_type'))},
    'Finished jobs by role and outcome; derived from job.run.'),
  histogram('job.duration', 'day', 'breakage', ['app'], 'duration_s', {'job.role': e('job_role'), outcome: e('job_outcome')}, 'Job durations; derived from job.run.'),
  histogram('job.stage.duration', 'day', 'breakage', ['app'], 'duration_s', {'job.role': e('job_role'), stage: e('job_stage')}, 'Stage durations; derived from job.run.'),
  diag('setup.readiness', 'span', 'breakage', ['app'], {checks: list(record({check: e('readiness_check'), state: e('health_state'), repaired: bool()}), 16),
  }, 'One readiness check run.'),
  sum('setup.check.count', 'hour', 'breakage', ['app'], {check: e('readiness_check'), state: e('health_state'), repaired: bool()}, 'Readiness checks by state; derived from setup.readiness.'),
  diag('upgrade.run', 'span', 'breakage', ['app'], {from: version(), to: version(), owner: e('update_owner'), stages: list(record({stage: e('upgrade_stage'), ms: MS, ok: bool()}), 8),
    outcome: e('upgrade_outcome'), 'error.type': opt(e('error_type'))}, 'One self-update attempt.'),
  sum('upgrade.count', 'hour', 'breakage', ['app'], {owner: e('update_owner'), outcome: e('upgrade_outcome')}, 'Upgrades by outcome; derived from upgrade.run.'),
  diag('install.run', 'span', 'breakage', ['installer'], {method: e('install_method'), outcome: e('install_outcome'), 'error.type': opt(e('error_type'))},
    'One install or upgrade run of the packaged installer.'),
  sum('install.count', 'day', 'breakage', ['app'], {method: e('install_method'), outcome: e('install_outcome')}, 'Installs by outcome; derived from install.run.'),
  diag('signin.run', 'span', 'breakage', ['app'], {harness: e('harness'), outcome: e('signin_outcome'), 'error.type': opt(e('error_type'))}, 'One agent sign-in flow.'),
  sum('signin.count', 'hour', 'breakage', ['app'], {harness: e('harness'), outcome: e('signin_outcome')}, 'Sign-ins by outcome; derived from signin.run.'),
  // Health and self-reporting
  sum('health.state', 'hour', 'breakage', ['app', 'tray', 'coordinator'], {check: e('health_check'), state: e('health_state'), reason: opt(e('error_type'))},
    'One per install-hour per check.', 1),
  sum('install.active', 'day', 'usage', ['app'], {lending_on: bool(), hosts_circle: bool(), circles: b('small'), agents: e('agent_set'), level: e('consent_level')},
    'One per install-day: the active-install denominator.', 1),
  sum('telemetry.self', 'hour', 'breakage', ['app'], {reason: e('self_reason'), entry: e('catalog_entry')}, 'Telemetry drops, rejections and tripwire hits.'),
  // Funnel and friction
  sum('funnel.reached', 'day', 'usage', ['app'], {milestone: e('milestone'), since_install: b('since_install')}, 'A milestone reached, once per install lifetime.', 1),
  sum('ui.friction', 'hour', 'usage', ['ui', 'phone'], {kind: e('friction_kind'), route: e('route'), op: e('op'), 'error.type': opt(e('error_type')),
    action: e('recovery_action'), surface: e('ui_surface')}, 'Friction the UI derives locally.'),
  sum('op.count', 'hour', 'usage', ['app'], {op: e('op'), surface: e('surface'), ok: bool(), 'error.type': opt(e('error_type'))}, 'Operation calls by surface and result.'),
  histogram('op.duration', 'hour', 'usage', ['app'], 'duration_s', {op: e('op'), surface: e('surface'), ok: bool(), 'error.type': opt(e('error_type'))}, 'Operation durations, by result.'),
  // Lending demand
  sum('lending.offer.decision', 'day', 'usage', ['app'], {outcome: e('offer_outcome'), reason: e('offer_reason'), harness: e('harness'), preset: e('preset'), mode: e('offer_mode'),
    wall: b('duration_s'), deadline: b('wait_s')}, 'One per offer per computer, at its final local outcome.'),
  sum('lending.request.outcome', 'day', 'usage', ['app'], {outcome: e('request_outcome'), harness: e('harness'), deadline: b('wait_s'),
    'source.kind': e('source_kind'), 'result.kind': opt(e('result_kind'))}, 'The borrower side of one request: the demand truth.'),
  histogram('lending.request.wait', 'day', 'usage', ['app'], 'wait_s', {harness: e('harness')}, 'Seconds from send to claim.'),
  histogram('lending.job.charge', 'day', 'usage', ['app'], 'points', {harness: e('harness'), 'stop.reason': e('stop_reason'), preset: e('preset')},
    'Allowance points charged for a lent job.'),
  // Quota
  entry('quota.week', 'record', 'quota', {purpose: 'usage', origins: ['app'], description: 'One closed seven-day allowance window: a reset-relative curve.',
    attrs: {provider: e('provider'), plan: e('plan'), preset: e('preset'), lending_on: bool(), owner_used: b('pct10'), lent: b('points'),
      unused: b('pct10'), shortfall: bool(), coverage: b('coverage'), contaminated: bool(), history: b('small'),
      slots: list(record({o: b('points', true), l: b('points', true)}), 28, 28)}}),
  sum('quota.window.closed', 'day', 'usage', ['app'], {provider: e('provider'), plan: e('plan'), preset: e('preset'), lending_on: bool(), owner_used: b('pct10'),
    lent: b('points'), unused: b('pct10'), shortfall: bool(), coverage: b('coverage'), contaminated: bool(), history: b('small')},
  'One closed five-hour window.'),
]);
