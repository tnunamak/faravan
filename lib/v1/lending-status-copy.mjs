// Keep this module browser-safe: it is also used by the owner UI.
const PROBE_PHASE_LABELS={queue:'waiting for the sandbox service',preflight:'checking sandbox requirements',
  storage_qualification:'checking sandbox storage',create_ready:'starting the check sandbox',identity:'checking the account sign-in',
  first_command:'reading the account allowance',teardown:'stopping and removing the check sandbox'};
const probePhaseLabel=phase=>Object.hasOwn(PROBE_PHASE_LABELS,phase)?PROBE_PHASE_LABELS[phase]:null;
export const RUNTIME_HELP = "Faravan's job guard could not start in the sandbox. Update Faravan; if it still fails, reinstall Faravan.";

// Lending status copy, as data. API, CLI, MCP status, and the app share these status strings; the Lend chooser has its own
// lead-approved chance wording below.
// Source: evidence/ui-copy-1024/LENDING-COPY.md. Binding wording rules: never "guarantee", "safe" or "insurance"; say
// never promise completion; pair "protection" with the explainer; name the declared starting prior.
// Four edits to the reviewed file are recorded in NOTES, including "promise" for "guarantee" in the paper sentence (UX 6):
// "too small to run safely" drops "safely", "would not finish before reset" becomes "could not be stopped before reset",
// and two status lines cover holds the reviewed file did not name.

// Dial copy only. The labels and the epsilon of each position come from the engine (PROTECTION_POSITIONS).
export const DIALS = Object.freeze({
  keep_more_for_me: Object.freeze({description: 'Keep the most for yourself; lend the share the model permits.',
    detail: 'The biggest reserve stays with you; friends may use the allowance the model permits. Risk target: 10%. Under Faravan\'s model, this is the chance that your own use needs what was lent.'}),
  balanced: Object.freeze({description: 'A fair split between you and your friends.',
    detail: 'You keep a reserve and friends may use what the model leaves after it. Risk target: 25%. Under Faravan\'s model, this is the chance that your own use needs what was lent.'}),
  share_more: Object.freeze({description: 'Friends get the most; you keep the least.',
    detail: 'Your reserve is smallest, so friends get the most and your own use is more likely to need what was lent. Risk target: 50%.'}),
});

const protectionExplainer = 'The risk target is what the setting aims for, not a measured rate. It is the chance, under Faravan\'s '
  + 'model of how usage varies, that your own use needs the part already lent out. That model is still being checked against real '
  + 'weeks, so treat the number as a setting, not a forecast. You can stop new lending at any moment. Running jobs keep their '
  + 'saved limits; use Stop to ask Faravan to end one. A job may use quota from your next window if it cannot be stopped before '
  + 'reset. Faravan holds new jobs when it cannot confirm stop support.';

// The 10/25/50% figures are targets of the model, not measured rates: the replay that scored them counted unpriced and
// missing weeks as idle (research capacity-pooling/lending-paper-v3-2026-10-26/outside-review-2026-10-27). Say "risk target",
// never a frequency such as "a quarter of the time", until a repaired replay supports one.
export const CHOOSER_DIALS = Object.freeze({
  keep_more_for_me: DIALS.keep_more_for_me.detail,
  balanced: DIALS.balanced.detail,
  share_more: DIALS.share_more.detail,
});
export const CHOOSER_EXPLAINER = protectionExplainer;

// One plain line per strategy. The parameters each one reads are in lending-policy.mjs (LENDING_STRATEGIES).
export const STRATEGY_COPY = Object.freeze({
  automatic: Object.freeze({label: 'Automatic', description: 'Lends by your dial position, with no separate share of the week.'}),
  fixed_share: Object.freeze({label: 'Fixed share', description: 'Friends use at most a fixed share of each week, and new jobs are checked against your protected balance before they start.'}),
  custom: Object.freeze({label: 'Custom', description: 'Friends can start at a point you choose in the week, and their share grows from there.'}),
});

export const EXPLAINER = protectionExplainer;

// Pause and Off stop admission. Running work continues under its existing limits; per-job Stop is separate.
export const RUNNING_JOB = 'Running jobs continue within their saved limits.';
// A launch whose earlier run is not confirmed stopped: Faravan retries by itself once the bound passes. `time` is already formatted.
export const launchFenceLine = time => 'Waiting to confirm the earlier run stopped; it retries by itself at ' + time + '.';
const RUNNING_JOB_CLAUSE = RUNNING_JOB.charAt(0).toLowerCase() + RUNNING_JOB.slice(1);

// Every hold names its plain cause and who recovers it. An owner hold names the action the owner takes; an automatic hold names
// when it clears. The status lines and the recovery pointers are built from this table, so every surface says the same thing and
// the test checks each code against it. `prefix` replaces "Holding — " where the state is not a hold.
const ESTIMATE_NOTE = Object.freeze({note: usageEstimateNote()});
const HOLD = Object.freeze({
  guard_runtime: {cause: "Faravan's sandbox job guard could not start", owner: 'update Faravan; if it still fails, reinstall Faravan'},
  reserve: {cause: 'your reserve covers everything spare', when: 'spare quota grows or your own use drops'},
  recent_use: {cause: 'you are using this computer', when: 'you step away from it'},
  window_exposure: {cause: 'usage from an earlier quota window is still being accounted for', when: 'a later reading covers that usage or its quota window resets'},
  measured: ESTIMATE_NOTE,
  // Deferrals are skipped checks, never failed requests.
  account_busy: ESTIMATE_NOTE,
  probe_deferred: ESTIMATE_NOTE,
  reset: {cause: 'the job could not be stopped before reset', when: 'the next reset comes'},
  small: {cause: 'the available job budget cannot cover one AI call', when: 'the limits are checked with the next job'},
  too_large: {cause: 'this job asks for more than your per-job limit allows', owner: 'raise the per-job limit',
    op: 'lending.set_owner_settings'},
  strategy_limit: {cause: 'this job is over a lending limit you set', owner: 'review the Lend page'},
  strategy_config_unknown: {cause: 'Faravan could not confirm the settings for your lending strategy',
    owner: 'review your strategy on the Limits page'},
  // A check that failed or has no fresh account fact is Faravan's to repeat; only a different account is the owner's.
  identity: {cause: 'Faravan could not confirm which account is signed in to this agent', when: 'the next allowance reading confirms it'},
  identity_mismatch: {cause: 'a different account is signed in to this agent than the one enrolled for lending',
    owner: 'sign the enrolled account back in, or turn the agent off and on again on the Lend page to lend from the account now in use'},
  codex_limit: {cause: 'this account has reached its Codex usage limit', when: 'the limit resets'},
  funding: {cause: 'subscription-only funding cannot be confirmed for this account', owner: 'check the account’s plan and billing'},
  // Only Faravan's own sandbox runner is meant: there is nothing for the person to install. Setup's Check again re-reads it, and
  // the support archive is the one path when Setup shows nothing wrong.
  executor: {cause: 'job controls could not be confirmed', owner: 'check the sandbox setup and try again'},
  executor_failed: {cause: 'the sandbox could not start or authorize this job', owner: 'check the sandbox setup'},
  stop_bound: ESTIMATE_NOTE,
  queue: {cause: 'queued work cannot be read right now', when: 'the next read succeeds'},
  // A status check uses only a recent reading, so this also shows after earlier readings; it never says "first".
  evidence: ESTIMATE_NOTE,
  invalid_evidence: ESTIMATE_NOTE,
  conversion: ESTIMATE_NOTE,
  history: ESTIMATE_NOTE,
  model_unavailable: {cause: 'the declared usage model is unavailable', when: 'the model is restored'},
  model_evidence: {cause: 'the usage model cannot evaluate these windows together', when: 'complete compatible window evidence arrives'},
  window: {cause: 'this job belongs to a different usage window', when: 'the next window starts'},
  native_pending: {cause: 'Faravan is waiting to account for an earlier job’s usage', when: 'the provider reports that usage or the allowance resets'},
  in_flight: {cause: 'another job for this account is still running', when: 'that job stops'},
  no_offer: {cause: 'no spare quota is offered for this job right now', when: 'spare quota appears'},
  value: {cause: 'this job is not shown to be worth lending', when: 'completed work gives a value estimate'},
  spare: {cause: 'this job needs more than the spare quota now', when: 'enough quota is spare for the whole job'},
  deadline: {cause: 'this job’s deadline has passed', when: 'a new job arrives'},
  adapter_frozen: {cause: 'lending is stopped while you are at this computer', when: 'you step away from it'},
  // Native-window holds: an account with no measured usage rate sizes a job by the per-job limit, and its live meter guard
  // stops the job at its allowance. Neither is a hold for missing history.
  native_budget: {cause: 'a job on an account with no measured usage rate needs a per-job limit', owner: 'set the per-job limit',
    op: 'lending.set_owner_settings'},
  native_allowance: {cause: 'the last job used the allowance set for it', when: 'the meter shows what it used'},
  // A window that opened while a lent job ran may have been opened by that job or by the owner's own use; nothing tells which.
  window_origin: {cause: 'Faravan cannot tell whether you or a lent job opened the current five-hour window', when: 'that window resets'},
  native_recheck: {cause: 'the five-hour window opened later than the last job was checked for, and the job no longer fit in it',
    when: 'the meter shows what it used'},
  controls: {cause: 'a lending setting blocks this job', owner: 'review the Lend page'},
  model: {cause: 'this model cannot be lent', owner: 'choose a model that can be lent for this agent'},
  unknown_job: {cause: 'this job is not known to this computer yet', when: 'the job arrives'},
  internal: {cause: 'an internal lending check did not pass for this account', owner: 'restart Faravan'},
  // Never a delete: removing the file would read as unset and apply the $4 default. Saving keeps the damaged file beside the new one.
  owner_settings: {cause: 'your saved per-job limit cannot be read', owner: 'save the per-job limit again',
    detail: 'Saving replaces the unreadable file after you confirm, and keeps a copy of it beside the new one.',
    op: 'lending.set_owner_settings', input: {replaceUnreadable: true}},
  // The fallback for a reason with no line of its own. It names no page: the owner may already be on the Lend page.
  proof: {cause: 'a lending check did not pass for this account', owner: 'restart Faravan, and report it if it stays'},
});

const holdLine = ({note, prefix = 'Holding — ', cause, owner, detail, when}) => note ?? (owner
  ? `${prefix}${cause}. This needs you: ${owner}.${detail ? ' ' + detail : ''}`
  : `${prefix}${cause}. It clears on its own when ${when}.`);

const recoveryOf = ({owner, when, op, input}) => Object.freeze(owner
  ? {who: 'owner', action: owner, ...(op ? {op} : {}), ...(input ? {input: Object.freeze({...input})} : {})}
  : {who: 'automatic', when});

// The spare hold names what the job needs and what is spare now, in dollars, so the owner sees why the job waits. Without both
// amounts, the table line names the reason without them.
const usdPlain = value => '$' + (Math.round(value * 100) / 100).toFixed(2);
const spareDetail = detail => Number.isFinite(detail?.needUsd) && Number.isFinite(detail?.spareUsd);
export const spareLine = ({needUsd, spareUsd}) => `Holding — this job needs ${usdPlain(needUsd)}, and ${usdPlain(spareUsd)} is spare now. `
  + 'It clears on its own when enough quota is spare for the whole job.';

// Rule holds use the same cause/recovery contract as other holds. Positive decisions
// remain non-hold lines, like lend and ready, and have no recovery obligation.
const RULE_HOLD = Object.freeze({
  "fluid_invalid_history": ESTIMATE_NOTE,
  "fluid_invalid_trace": ESTIMATE_NOTE,
  "fluid_invalid_reset_relative_trace": ESTIMATE_NOTE,
  "fluid_invalid_state": {"prefix": "", "cause": "Lending is waiting because job or allowance details are incomplete", "when": "complete job and allowance details arrive"},
  "fluid_invalid_identity": {"prefix": "", "cause": "Lending is waiting because an allowance window cannot be identified", "when": "the next reading identifies the allowance window"},
  "fluid_invalid_window": {"prefix": "", "cause": "Lending is waiting because an allowance reading is incomplete", "when": "a complete allowance reading arrives"},
  "fluid_invalid_bounds": {"prefix": "", "cause": "Lending is waiting because allowance readings are inconsistent or expired", "when": "a consistent current allowance reading arrives"},
  "fluid_missing_gross": {"prefix": "", "cause": "Lending is waiting because the job's full allowance cost is unknown", "when": "the job's full allowance estimate becomes available"},
  "fluid_unknown_gross_resource": {"prefix": "", "cause": "Lending is waiting because the job needs an allowance that has not been checked", "when": "all allowances needed by the job have been checked"},
  "fluid_allowance": {"prefix": "", "cause": "This job needs more allowance than is available to lend", "when": "enough allowance becomes available for this job"},
  "fluid_deadline": {"prefix": "", "cause": "This job cannot be stopped before the allowance resets", "when": "a new job fits before the next reset"},
  "fluid_zero_gross": {"prefix": "", "cause": "Lending is waiting because this job has no positive allowance estimate", "when": "a positive allowance estimate becomes available"},
  "seam_quota_windows_required": {"prefix": "", "cause": "Lending is waiting because both allowance windows have not been checked", "when": "both allowance windows have been checked"},
  "seam_unknown_rule_evidence": {"prefix": "", "cause": "Lending is waiting because the details needed to decide whether to lend are unavailable", "when": "the required lending details become available"},
  "seam_unknown_account": {"prefix": "", "cause": "Lending is waiting because the allowance reading is not linked to an account", "owner": "check agent sign-in and refresh allowance"},
  "seam_unknown_applicable_resource_roster": {"prefix": "", "cause": "Lending is waiting because the allowances needed for this model are not confirmed", "when": "the allowances needed for this model are confirmed"},
  "seam_ambiguous_meter_identity": {"prefix": "", "cause": "Lending is waiting because allowance readings cannot be matched to one window", "when": "new readings identify each allowance window once"},
  "seam_incomplete_applicable_resource_roster": {"prefix": "", "cause": "Lending is waiting because some allowances needed for this job have not been checked", "when": "all allowances needed by the job have been checked"},
  "seam_incompatible_meter_snapshot": {"prefix": "", "cause": "Lending is waiting because the allowance readings do not agree", "when": "consistent allowance readings arrive"},
  "seam_incompatible_window_length": {"prefix": "", "cause": "Lending is waiting because the allowance reset window is inconsistent", "when": "readings with matching reset windows arrive"},
  "seam_unknown_meter_age": ESTIMATE_NOTE,
  "seam_unknown_account_wide_lag_bound": ESTIMATE_NOTE,
  "seam_unknown_ledger_interval": {"prefix": "", "cause": "Lending is waiting because recorded lending times are inconsistent", "owner": "report the inconsistent recorded lending times"},
  "seam_ambiguous_ledger_reset": {"prefix": "", "cause": "Lending is waiting because past lending cannot be matched to a reset window", "owner": "report the lending entry with an unknown reset window"},
  "seam_invalid_represented_time": {"prefix": "", "cause": "Lending is waiting because recorded lending and allowance update times do not agree", "owner": "report the inconsistent lending and allowance update times"},
  "seam_inconsistent_ledger_snapshot": {"prefix": "", "cause": "Lending is waiting because the lending totals do not agree", "when": "recorded lending and allowance totals agree"},
  "seam_ledger_exceeds_meter": {"prefix": "", "cause": "Lending is waiting because recorded lending exceeds the allowance reading", "when": "an updated allowance reading accounts for recorded lending"},
  "seam_unknown_conversion": ESTIMATE_NOTE,
  "seam_unsafe_gross": {"prefix": "", "cause": "Lending is waiting because the job's allowance estimate is too large to check", "owner": "request a smaller job"},
  "seam_rule_must_be_a_function": {"prefix": "", "cause": "Lending is waiting because the lending rule is unavailable", "owner": "check for a Faravan update and report the missing lending rule"},
  "seam_invalid_rule_decision": {"prefix": "", "cause": "Lending is waiting because the lending rule returned an unreadable decision", "owner": "report the unreadable lending decision"},
  "seam_unknown_now": {"prefix": "", "cause": "Lending is waiting because the current time is unavailable or inconsistent", "owner": "check this computer's clock"},
  "seam_unknown_dial": {"prefix": "", "cause": "Lending is waiting because the saved lending preference is unavailable or inconsistent", "owner": "save a lending preference again"},
  "seam_unknown_gross_request": {"prefix": "", "cause": "Lending is waiting because the job's full cost estimate is unavailable or inconsistent", "when": "a valid full job estimate becomes available"},
  "seam_unknown_meter": {"prefix": "", "cause": "Lending is waiting because the allowance reading is unavailable or inconsistent", "when": "a consistent allowance reading arrives"},
  "seam_unknown_window_length": {"prefix": "", "cause": "Lending is waiting because the time between allowance resets is unavailable or inconsistent", "when": "a reading with a valid reset interval arrives"},
  "seam_unknown_rounding_bound": {"prefix": "", "cause": "Lending is waiting because the possible rounding error in allowance readings is unavailable or inconsistent", "owner": "check for support for this allowance's rounding error"},
  "seam_unknown_provider_lag_bound": {"prefix": "", "cause": "Lending is waiting because the possible delay in allowance reporting is unavailable or inconsistent", "owner": "check for support for this provider's reporting delay"},
  "seam_unknown_account_wide_rate": {"prefix": "", "cause": "Lending is waiting because the maximum rate of account use is unavailable or inconsistent", "owner": "check for support for this account's usage-rate bound"},
  "seam_unknown_ledger_start": {"prefix": "", "cause": "Lending is waiting because the recorded lending start time is unavailable or inconsistent", "owner": "report the missing or inconsistent lending start time"},
  "seam_unknown_ledger_end": {"prefix": "", "cause": "Lending is waiting because the recorded lending end time is unavailable or inconsistent", "owner": "report the missing or inconsistent lending end time"},
  "seam_unknown_borrower_spend": {"prefix": "", "cause": "Lending is waiting because the allowance already used for friends is unavailable or inconsistent", "owner": "report the missing or inconsistent recorded allowance used for friends"},
  "seam_unknown_borrower_lower": {"prefix": "", "cause": "Lending is waiting because the confirmed allowance used for friends is unavailable or inconsistent", "owner": "report the missing or inconsistent confirmed allowance used for friends"},
  "seam_unknown_represented_time": {"prefix": "", "cause": "Lending is waiting because the time a lending entry appeared in allowance readings is unavailable or inconsistent", "owner": "report the missing or inconsistent allowance update time"},
  "seam_unknown_ledger_total": {"prefix": "", "cause": "Lending is waiting because the recorded lending total is unavailable or inconsistent", "when": "a reading with a valid recorded lending total arrives"},
  "seam_unknown_inflight": {"prefix": "", "cause": "Lending is waiting because the allowance held for running jobs is unavailable or inconsistent", "owner": "report the missing or inconsistent allowance held for running jobs"},
  "seam_unknown_ledger_reservations": {"prefix": "", "cause": "Lending is waiting because the allowance reserved for other jobs is unavailable or inconsistent", "when": "a reading with valid allowance reservations arrives"},
  "seam_unknown_wall": {"prefix": "", "cause": "Lending is waiting because the job duration is unavailable or inconsistent", "when": "a valid job duration estimate becomes available"},
  "seam_unknown_uncertainty": {"prefix": "", "cause": "Lending is waiting because the extra time reserved for a job is unavailable or inconsistent", "when": "a valid job timing allowance becomes available"},
  "seam_unknown_stop": {"prefix": "", "cause": "Lending is waiting because the time needed to stop a job is unavailable or inconsistent", "owner": "check the executor's stop support"},
  "seam_unknown_rule_lendable": {"prefix": "", "cause": "Lending is waiting because the allowance the rule offers to lend is unavailable or inconsistent", "owner": "report the lending rule's unreadable allowance estimate"},
  "seam_rule_allowance": {"prefix": "", "cause": "This job is limited by the allowance available to lend", "when": "enough allowance becomes available for this job"},
  "seam_physical_room": {"prefix": "", "cause": "This job is limited by allowance already used or reserved", "when": "enough unused, unreserved allowance becomes available"},
  "seam_product_room": {"prefix": "", "cause": "This job is limited by allowance kept for uncertain use and running jobs", "when": "updated readings leave enough allowance after other commitments"},
  "seam_resource_fit": {"prefix": "", "cause": "This job does not fit the available allowance, so it will not start", "when": "the whole job fits every required allowance"},
  "fluid_unexpected_error": {"prefix": "", "cause": "Lending is waiting because a required detail could not be checked", "owner": "report the lending check that could not be completed"},
  "seam_unexpected_error": {"prefix": "", "cause": "Lending is waiting because a required detail could not be checked", "owner": "report the lending check that could not be completed"},
  "fluid_unsupported_contract": {"prefix": "", "cause": "Lending is waiting because a required detail could not be checked", "owner": "check for a Faravan update that supports this lending contract"},
  "seam_unknown_observation": {"prefix": "", "cause": "Lending is waiting because the allowance reading time is unavailable or inconsistent", "when": "a reading with a valid observation time arrives"},
  "seam_rule_hold": {"prefix": "", "cause": "Lending is waiting because a required detail could not be checked", "when": "the lending rule permits this job"},
  "quota_registry_missing": ESTIMATE_NOTE,
  "native_cost_bound_unknown": ESTIMATE_NOTE,
  "quota_registry_unsupported": {"prefix": "", "cause": "Lending is waiting because a required detail could not be checked", "owner": "check for support for this account's allowance details"},
  "rule_seam_quota_unit_unsupported": {"prefix": "", "cause": "Lending is waiting because the job's allowance cost cannot be estimated", "owner": "choose a model and plan with a supported allowance unit"},
  "rule_seam_rolling_unsupported": {"prefix": "", "cause": "Lending is waiting because the allowance reset window is inconsistent", "owner": "choose a plan with a supported reset window"},
  "seam_native_no_room": {"prefix": "", "cause": "This job is limited by allowance already used or reserved", "when": "enough unused, unreserved allowance becomes available"},
  "quota_registry_charge_mismatch": {"prefix": "", "cause": "Lending is waiting because the job's allowance cost cannot be estimated", "owner": "report the disagreement between the model's allowance estimates"},
});

export const RULE_REASON_COPY = Object.freeze({
  ...Object.fromEntries(Object.entries(RULE_HOLD).map(([code, entry]) => [code, holdLine(entry)])),
  fluid_lend: "This job fits the allowance available to lend and can be stopped before reset. No action is needed.",
  seam_lend: "Ready to lend to a friend when a job arrives.",
});

export const LINES = Object.freeze({
  ...RULE_REASON_COPY,
  lend: 'Lending to a friend now.',
  // Native-window mode: an account with no measured usage rate lends now in allowance points (see learningCopy below).
  learning: 'Lending now in allowance points · no measured usage rate yet.',
  learning_ready: 'Ready to lend in allowance points · no measured usage rate yet. It uses the starting estimate.',
  // Admitted for a friend's job but nothing is reserved or running. Future tense, so it never reads as lending now.
  ready: 'Ready to lend to a friend when a job arrives.',
  // Admission intent is separate from running work, which keeps its existing limits.
  paused: `Paused for new jobs; ${RUNNING_JOB_CLAUSE}`,
  stopped: `Stopped for new jobs; ${RUNNING_JOB_CLAUSE}`,
  own_weeks: 'Risk target based on your own weeks.',
  ...Object.fromEntries(Object.entries(HOLD).map(([id, entry]) => [id, holdLine(entry)])),
});

// Code-only lookup for callers that are not rendering a lifecycle status.
export const ruleReasonLine = code => typeof code === 'string' && Object.hasOwn(RULE_REASON_COPY, code)
  ? RULE_REASON_COPY[code] : LINES.proof;

// Closed source rejection codes only: never interpolate account, plan or model identifiers.
const CONVERSION_REJECTION = Object.freeze({
  missing_binding: 'The saved usage estimate has no verified scope. Refresh allowance; if this persists, check for an update supporting current estimates.',
  binding_mismatch: 'The saved usage estimate does not match the current account, plan or model. Refresh allowance; if this persists, check for an update supporting current estimates.',
  measurement_observation_mismatch: 'The saved usage estimate belongs to another reading. Refresh allowance; if this persists, check for an update supporting current estimates.',
});
export const conversionRejectionLine = code => typeof code === 'string' && Object.hasOwn(CONVERSION_REJECTION, code)
  ? CONVERSION_REJECTION[code] : null;

// The paper sentence with its adjacent explanation. The paper says "not a guarantee"; UX 6 removes that word from every shipped
// line, so this one says "not a promise". LENDING-COPY.md asks for the sentence exactly, so this change is recorded in NOTES.
export const LIMIT = Object.freeze({
  sentence: 'Your setting aims to keep the chance of lending reducing your service at 10%, 25%, or 50% per week under Faravan\'s '
    + 'model of usage; that model is still being checked against real weeks, so this is a target, not a measured rate or a promise, '
    + 'and heavy or unexpected demand can exceed it.',
  adjacent: 'No imported history is required; borrowed usage that has already run can\'t be refunded; importing your past usage improves '
    + 'the starting forecast; the setting limits how often, not how much.',
});

// Every hold reason the engine, the candidate and the quote path can name, mapped to its table entry. An unnamed code falls to proof.
export const REASON_LINE = Object.freeze({
  ...Object.fromEntries(Object.keys(RULE_HOLD).map(code => [code, code])),
  owner_band: 'reserve', owner_harm: 'reserve', owner_reserve: 'reserve', defer: 'reserve',
  owner_present: 'recent_use', paused: 'paused', stopped: 'stopped', adapter_frozen: 'adapter_frozen',
  account_busy: 'account_busy', probe_deferred: 'probe_deferred',
  usage_unknown: 'measured', refresh_failed: 'measured', resources_incomplete: 'measured', epoch_unknown: 'measured',
  account_week_mapping_unknown: 'measured', reading_stale: 'measured', aggregate_observation_regressed: 'measured',
  cross_window_exposure_unreconciled: 'window_exposure', cross_epoch_rate_unknown: 'measured',
  conversion_unknown: 'conversion', model_unpriced: 'conversion', history_unknown: 'history',
  owner_scenarios_unknown: 'evidence', objective_evidence_unknown: 'evidence', objective_evidence_invalid: 'invalid_evidence',
  reset: 'reset', resource_reset_margin: 'reset', budget_too_small: 'small', request_too_large: 'too_large',
  strategy_limit: 'strategy_limit',
  demand_model_unavailable: 'model_unavailable', demand_model_invalid: 'model_evidence',
  demand_model_coupling_unknown: 'model_evidence', demand_model_exact_usage_required: 'measured',
  strategy_config_unknown: 'strategy_config_unknown',
  friend_value_unknown: 'value', chunk_value_unknown: 'value', no_value: 'value', exceeds_spare: 'spare',
  identity_unknown: 'identity', invalid_identity: 'identity', identity_mismatch: 'identity_mismatch',
  funding_unknown: 'funding', executor_unknown: 'executor', arm_failed: 'executor_failed', launch_not_authorized: 'executor_failed',
  stop_bound_unknown: 'stop_bound', queue_unknown: 'queue',
  gate_closed: 'controls', controls: 'controls',
  no_useful_quote: 'no_offer', attempt_in_flight: 'in_flight', job_epoch_incompatible: 'window', deadline: 'deadline',
  model_not_lendable: 'model', job_unknown: 'unknown_job',
  account_week_identity: 'internal', resource_identity: 'internal', weekly_resource_mapping: 'internal', state_unknown: 'internal',
  objective_reservation_invalid: 'internal', objective_reservation_exceeds_resource: 'internal', invalid_input: 'internal',
  duplicate_attempt: 'internal', observation_order: 'internal', revision_overflow: 'internal', cross_reset_conversion_mismatch: 'internal',
  owner_settings_unreadable: 'owner_settings',
  // Native-window mode. A stale or unreadable meter keeps its named hold ('measured'); missing history has no code at all.
  native_attempt_in_flight: 'native_pending', cross_reset_native_unsupported: 'reset', native_budget_unknown: 'native_budget',
  native_settlement_unknown: 'measured', native_settlement_incomplete: 'measured', native_settlement_mismatch: 'measured',
  guard_runtime_unavailable: 'guard_runtime',
  native_settlement_unread: 'measured', native_settlement_scope_changed: 'reset', native_guard_waiting: 'measured', native_guard_meter_stale: 'measured',
  native_guard_allowance_reached: 'native_allowance', native_guard_window_reset: 'reset',
  native_guard_identity_changed: 'identity_mismatch', native_guard_funding_changed: 'funding', native_guard_epoch_changed: 'window',
  native_guard_owner_stop: 'stopped', native_guard_window_recheck: 'native_recheck', window_origin_unknown: 'window_origin',
});

// Who recovers each hold, and the operation that does it, when there is one. Every surface that shows a hold carries the same pointer.
export const RECOVERY = Object.freeze({
  ...Object.fromEntries(Object.entries(RULE_HOLD).filter(([,entry])=>!entry.note).map(([id, entry]) => [id, recoveryOf(entry)])),
  ...Object.fromEntries(Object.entries(HOLD).filter(([,entry])=>!entry.note).map(([id, entry]) => [id, recoveryOf(entry)])),
  paused: Object.freeze({who: 'owner', action: 'resume lending to take new jobs'}),
  stopped: Object.freeze({who: 'owner', action: 'turn lending on to take new jobs'}),
});

// Funding detail selects copy only; the funding_unknown admission hold stays unchanged.
export function fundingHoldCopy(reason, detail) {
  if ((REASON_LINE[reason] ?? reason) !== 'funding' || detail?.fundingReason !== 'limit_reached') return null;
  return {line:LINES.codex_limit, recovery:RECOVERY.codex_limit, action:'Wait for the limit to reset'};
}

// Provider is a closed display choice. Identity data never changes admission or recovery ownership.
export function identityHoldCopy(reason, detail = {}) {
  const id = REASON_LINE[reason] ?? reason;
  if (!['identity', 'identity_mismatch'].includes(id)) return null;
  const name = detail?.provider === 'claude' ? 'Claude Code' : detail?.provider === 'codex' ? 'Codex' : null;
  if (!name) return null;
  // Two accounts of one provider: the hold names the account it belongs to and never offers a provider-wide switch.
  const label = typeof detail?.accountLabel === 'string' && detail.accountLabel ? detail.accountLabel : null;
  if (label) return {line:id === 'identity'
    ? `Holding — Faravan could not confirm which account is signed in for ${label}. It clears on its own when the next allowance reading confirms it.`
    : `Holding — the account signed in for ${label} is not the one enrolled for it. Sign in again to ${label} with that account.`,
    action:`Sign in again to ${label}`};
  const line = id === 'identity'
    ? `Holding — Faravan could not confirm which account is signed in to ${name}. It clears on its own when the next allowance reading confirms it.`
    : `Holding — a different account is signed in to ${name} than the one enrolled for lending. Sign in to ${name} with the account enrolled for lending, or turn “Lend with ${name}” off and on again to lend from the account now in use.`;
  return {line, action:'Sign in to ' + name};
}

// The saved per-job limit, as the owner sees it. The control on the limits page, the hold's link and the confirmation use these
// words. The confirmation names a replacement only when the hold is active.
export const OWNER_LIMIT_LABEL = 'Most one friend’s job may spend';
export const OWNER_LIMIT_HREF = '#owner-limit';
export const ownerLimitEffect = ({maxJobUsd, replaceUnreadable = false}) => 'Save $' + maxJobUsd
  + ' as the most one lent job may spend' + (replaceUnreadable ? ', replacing the saved file if it cannot be read.' : '.');

// Learning copy (native-window mode, 1101). An account with no measured usage rate lends now, in its own allowance points,
// using the starting estimate until local agent logs measure a rate. Lent jobs alone never set it. Missing history is never a hold, so this copy never
// says "on hold" or "won't lend"; it names the window, promises no dollar amount and asks nothing of the owner.
const MEASURED_WINDOW = {weekly:'weekly', five_hour:'5-hour', model:'per-model'};
export const LEARNING_STATUS_LINE = LINES.learning;
export const LEARNING_READY_LINE = LINES.learning_ready;
const windowName = window => `${MEASURED_WINDOW[window] ?? 'allowance'}${MEASURED_WINDOW[window] ? ' allowance' : ''}`;
export const learningLine = window => `Faravan has no measured usage rate for this account's ${windowName(window)} yet. `
  + 'Until your local agent logs measure a rate, it lends in allowance points using the starting estimate.';
export const learningExpiredLine = window => `Faravan's measurement of this account's ${windowName(window)} is more than 8 weeks old. `
  + 'Until your local agent logs measure the rate again, it lends in allowance points using the starting estimate.';
export const learningCreatorUnknownLine = window => `Faravan can't tell which account your Codex use belongs to, so local logs can't measure this account's ${windowName(window)}. `
  + 'It lends now in allowance points using the starting estimate. Updating the Codex CLI lets your own use count too.';
export const LEARNING_OFF_LINE = 'Faravan has no measured usage rate for this account. It lends in allowance points using the starting estimate. '
  + 'Turn on "Learn from my local agent logs" so your own use can measure the rate.';

// Display-only learning detail (observation.learning rows). Not a hold: it has no recovery obligation.
export function learningCopy(detail) {
  if (detail?.reason !== 'learning' || !['claude', 'codex'].includes(detail.provider)) return null;
  return detail.learning_off === true ? {line:LEARNING_OFF_LINE}
    : {line:detail.creator_unknown === true ? learningCreatorUnknownLine(detail.window)
      : detail.expired === true ? learningExpiredLine(detail.window) : learningLine(detail.window)};
}

// Display-only source detail; malformed or temporary evidence keeps the ordinary unknown copy.
export function calibrationMissingCopy(detail) {
  if (detail?.reason !== 'calibration_missing' || !['plan', 'model_window'].includes(detail.scope) ||
      !['claude', 'codex'].includes(detail.provider) ||
      !['weekly', 'five_hour'].includes(detail.window) ||
      ![detail.plan, detail.model].every(value => typeof value === 'string' &&
        /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value))) return null;
  return {line:usageEstimateNote(), action:null};
}


// A deferral describes a skipped check, never a failed request.
export function probeDeferralCopy(probe) {
  if (!['account_busy', 'probe_deferred'].includes(probe?.reason)) return null;
  if (probe.reason === 'probe_deferred' && probe.deferral_cause === 'target_cleanup') return {
    line:'The allowance check is waiting for its sandbox to finish cleanup. It can run again when cleanup finishes.',
    action:'Wait for cleanup to finish.'};
  const action = 'Wait for the next scheduled allowance read.';
  const at = Number.isSafeInteger(probe.retry_at) && probe.retry_at >= 0 && probe.retry_at <= 8.64e15
    ? new Date(probe.retry_at).toISOString() : null;
  const cause = probe.deferral_cause === 'rate_limited' ? ' after an earlier rate limit' : '';
  // Only a known next check time or cause adds to the table line.
  if (probe.reason === 'account_busy' || (!at && !cause)) return {line:LINES[probe.reason], action};
  return {line:usageEstimateNote() + ` The next allowance check${at ? ' is at ' + at : ' has no confirmed time yet'}${cause}.`, action};
}

// A retained job assessment is history, not a claim about the account's current capacity.
export function retainedJobStatus({status, assessedAt, now, probe = null, includeAge = true} = {}) {
  // Absolute history validates only its stored time; clock skew must not revise a shared decision.
  // Relative presentation still rejects future timestamps and requires an explicit read clock.
  const validTime = Number.isSafeInteger(assessedAt) && assessedAt >= 0 && assessedAt <= 8.64e15 &&
    (!includeAge || Number.isSafeInteger(now) && assessedAt <= now);
  const ageMs = includeAge && validTime ? now - assessedAt : null;
  const age = ageMs === null ? null : ageMs < 60_000 ? `${Math.floor(ageMs / 1000)} seconds ago`
    : ageMs < 3_600_000 ? `${Math.floor(ageMs / 60_000)} minutes ago` : `${Math.floor(ageMs / 3_600_000)} hours ago`;
  const when = validTime ? ` at ${new Date(assessedAt).toISOString()}${includeAge ? ` (${age})` : ''}` : ' at an unknown time';
  // Never recycle a current hold's cause or remedy into history: those strings contain
  // present-tense capacity claims and instructions that may no longer apply.
  const causes = {account_busy: 'the account was busy, so its allowance was not checked then',
    probe_deferred: 'the allowance check was waiting for its next run',
    reserve: 'your reserve covered everything spare then',
    spare: 'the job exceeded the spare quota measured then',
    evidence: 'it was waiting for a current quota reading', invalid_evidence: 'the objective evidence was invalid',
    value: 'the job value was unknown', measured: 'recent usage could not be measured',
    model_unavailable: 'the demand model was unavailable', model_evidence: 'the demand estimate could not be verified'};
  // Current estimate copy collapses these deferred readings to one ID. The
  // retained probe carries their original cause.
  const id = status?.id === 'usage_estimate' && ['account_busy', 'probe_deferred'].includes(probe?.reason)
    ? probe.reason : status?.id;
  const cause = Object.hasOwn(causes, id) ? causes[id] : 'a lending check did not pass for that job';
  const provider = probe?.provider === 'codex' ? 'Codex' : probe?.provider === 'claude' ? 'Claude' : null;
  const descriptions = {probe_busy:'usage check was busy', probe_deferred:'usage check was deferred',
    probe_unavailable:'usage check was unavailable', probe_cancelled:'usage check was cancelled',
    rate_limited:'usage check was rate limited', identity_failed:'account identity could not be checked',
    guard_runtime_unavailable:'job guard could not start',
    sandbox_start_failed:'usage check sandbox could not start', parse_failed:'usage answer could not be read',
    timeout:'usage check timed out', other:'usage check failed'};
  const failureClass = typeof probe?.failure_class === 'string' ? probe.failure_class : null;
  const description = (Object.hasOwn(descriptions, failureClass) ? descriptions[failureClass] : null) ?? (/^usage_http_[1-5][0-9]{2}$/.test(failureClass ?? '')
    ? `usage check returned HTTP ${failureClass.slice(11)}` : null);
  const detail = provider && description ? ` (${provider} ${description})` : '';
  return {id:'last_job_held', line:`The last job was held${when} because ${cause}${detail}. The next job is checked again before it can run.`,
    basis:null, assessedAt:validTime ? assessedAt : null, ...(includeAge ? {ageMs} : {})};
}

// One status for one account. Owner state wins over the decision; history carries its own-weeks basis and the starting prior
// carries its link, statement and explainer.
// Present tense only while a reservation is active. An admitted quote alone is readiness, not lending, and a finished job
// leaves no activity behind: `active` comes from the lifecycle (a reservation not yet finished or released), never from the quote.
export function lendingStatus({admitted = false, active = false, reason = null, protectionSource = null, lendingOn = true,
  intentOn = true, detail = null, reasonCode = null, ruleReasonCode = null, pendingRequest = null, conversion = null,
  approvalRequired = false} = {}) {
  if (!lendingOn) return {id: 'stopped', line: LINES.stopped, basis: null, recovery: RECOVERY.stopped};
  if (!intentOn) return {id: 'paused', line: LINES.paused, basis: null, recovery: RECOVERY.paused};
  // Objective reasonCode predates this mapping and may be more specific than
  // the recognized legacy reason. Do not erase its existing copy/recovery.
  const code = [ruleReasonCode, reasonCode, reason].find(value =>
    typeof value === 'string' && (Object.hasOwn(REASON_LINE, value) || Object.hasOwn(RULE_REASON_COPY, value)));
  const observationId = REASON_LINE[code] ?? code;
  if (!admitted && (HOLD[observationId]?.note || RULE_HOLD[observationId]?.note))
    return {id:'usage_estimate', line:usageEstimateNote(detail), basis:null};
  const structured = typeof code === 'string' && Object.hasOwn(RULE_REASON_COPY, code) ? code : null;
  const lends = structured === 'fluid_lend' || structured === 'seam_lend';
  // Optional/untrusted metadata cannot turn a hold into a lending sentence, or
  // turn an admitted quote into a hold. Active lifecycle and owner intent win.
  // An admitted job on an account with no measured usage rate says so: it lends in allowance points.
  const learning = conversion === 'native_window' || reasonCode === 'objective_lend_native';
  const id = admitted ? (learning ? (active ? 'learning' : 'learning_ready') : active ? 'lend' : structured && lends ? structured : 'ready')
    : (structured ? (lends ? 'proof' : structured)
      : (typeof code === 'string' && Object.hasOwn(REASON_LINE, code) ? REASON_LINE[code] : 'proof'));
  const missing = id === 'conversion' && code === 'conversion_unknown' ? calibrationMissingCopy(detail) : null;
  const deferred = ['account_busy', 'probe_deferred'].includes(id)
    ? probeDeferralCopy({...detail, reason:id}) : null;
  const budget = id === 'small' ? budgetLimitCopy(detail?.budgetLimit ?? detail) : null;
  const funding = fundingHoldCopy(id, detail);
  const recovery = funding ? funding.recovery : budget ? budget.recovery : missing ? {who:'owner', action:missing.action} : RECOVERY[id];
  const own = protectionSource === 'history';
  const link = id === 'owner_settings' ? {href: OWNER_LIMIT_HREF, linkLabel: 'Set the limit'} : {};
  const line = funding?.line ?? budget?.line ?? identityHoldCopy(id, detail)?.line ?? deferred?.line ?? missing?.line ?? (id === 'spare' && spareDetail(detail) ? spareLine(detail) : LINES[id]);
  return {id, line: admitted && !active && approvalRequired ? line + ' You approve each job before it starts.' : line,
    basis: own ? {id: 'own_weeks', line: LINES.own_weeks} : null, ...(own ? {explainer: EXPLAINER} : {}),
    ...link, ...(recovery ? {recovery} : {})};
}


export function claudeModelName(model) {
  const match = /^claude-(haiku|sonnet|opus|fable|mythos)(?:-(\d+)(?:-(\d+))?)?/.exec(model ?? '');
  if (!match) return model ?? 'Claude';
  const family = match[1][0].toUpperCase() + match[1].slice(1);
  return 'Claude ' + family + (match[2] ? ' ' + match[2] + (match[3] ? '.' + match[3] : '') : '');
}

export function budgetLimitCopy(detail, {borrower = false} = {}) {
  if (!detail || !Number.isFinite(detail.minimumUsd) || detail.minimumUsd <= 0) return null;
  const name = claudeModelName(detail.model), minimum = '$' + detail.minimumUsd.toFixed(2);
  const amount = '$' + Number(detail.limitUsd).toFixed(2);
  if (detail.source === 'borrower') return {line: borrower
    ? `Your job's ${amount} limit is below what one ${name} call can cost (${minimum}). Raise the job limit to at least $${Math.ceil(detail.minimumUsd)}.`
    : `This job's own limit of ${amount} is below what one ${name} call can cost (${minimum}). The borrower needs to raise it to at least $${Math.ceil(detail.minimumUsd)}. You need to do nothing.`,
    recovery:{who:'borrower', action:'raise the job limit'}};
  if (detail.source === 'owner') return {line:`Your per-job limit of ${amount} is below what one ${name} call can cost (${minimum}). Raise it to at least ${minimum}.`,
    recovery:{who:'owner', action:`raise the per-job limit to at least ${minimum}`}};
  if (detail.source === 'strategy') return {line:`The limit you set for this lending strategy allows ${amount} for this job, below what one ${name} call can cost (${minimum}). Review the Lend page to change it.`,
    recovery:{who:'owner', action:'change the lending strategy limit on the Lend page'}};
  return {line:`The spare allowance cannot cover one ${name} call right now (${minimum}). It will be checked again when allowance is available.`,
    recovery:{who:'automatic', action:'wait for spare allowance'}};
}

// Display only: a recent failed allowance read can coexist with older saved windows.
const validAt = at => Number.isSafeInteger(at) && at >= 0 && at <= 8.64e15 ? new Date(at).toISOString() : null;
// `accountLabel` and `retryAt` name the one account the outcome belongs to. Without them the copy is the provider-level text.
export function probeFailureCopy(outcome, {provider = null, accountLabel = null, retryAt = null} = {}) {
  if (outcome?.outcome !== 'failed') return null;
  if (provider === 'codex' && outcome.reason === 'auth')
    return {line:'Codex sign-in expired: sign in again', action:accountLabel ? 'Sign in again to ' + accountLabel + '.' : 'Sign in again to Codex.'};
  const reasons = {
    sandbox_start_failed:'the allowance check sandbox could not start',
    guest_failed:'the allowance check could not run',
    probe_unavailable:'the allowance check is unavailable',
    timeout:'the allowance check timed out',
    network_error:'the provider could not be reached',
    rate_limited:'the provider limited allowance checks',
    auth:'the provider rejected the sign-in',
    provider_error:'the provider returned an error',
    http_error:'the provider rejected the allowance request',
    unreadable:'the allowance answer could not be read',
    identity_failed:'the account identity could not be checked',
    cancelled:'the allowance check was cancelled',
    closed:'the allowance check was cancelled',
    history_write_failed:'the allowance check could not be saved',
    guard_runtime_unavailable:"Faravan's sandbox job guard could not start",
  };
  const reason = Object.hasOwn(reasons, outcome.reason) ? reasons[outcome.reason] : 'the allowance check failed';
  const phase=probePhaseLabel(outcome.failed_phase);
  const who = typeof accountLabel === 'string' && accountLabel ? accountLabel : null;
  const at = validAt(retryAt);
  return {line:(who ? `Faravan could not read ${who}'s allowance: ` : "Faravan could not read this account's allowance: ") + reason + (phase?' while '+phase:'') + '.',
    action:who && outcome.reason === 'auth' ? `Sign in again to ${who}.`
      : who && outcome.reason === 'rate_limited' ? (at ? `Wait until ${at}, then refresh the allowance of ${who}.` : `Wait for the provider limit to clear, then refresh the allowance of ${who}.`)
      : outcome.reason === 'auth' ? 'Sign in again and refresh the allowance.'
      : outcome.reason === 'guard_runtime_unavailable' ? 'Update Faravan; if it still fails, reinstall Faravan.'
      : outcome.reason === 'rate_limited' ? 'Wait for the provider limit to clear, then refresh the allowance.'
      : reason[0].toUpperCase() + reason.slice(1) + '. Refresh the allowance. If it still fails, check for a Faravan update.'};
}

// Display only. Keep the original observation age; never treat a failed read as a new reading.
export function usageEstimateNote(detail = {}) {
  const ageMs = detail?.ageMs;
  return Number.isSafeInteger(ageMs) && ageMs >= 0
    ? 'Usage estimate: the saved reading is ' + ageMs + ' ms old. Lending accounts for its age; history improves the estimate.'
    : detail?.hasReading === false
      ? 'Usage estimate: no aggregate reading is available. Lending uses the starting estimate; history improves it.'
      : 'Usage estimate: lending uses available readings or the starting estimate; history improves it.';
}
