import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {LINES, REASON_LINE, RECOVERY, lendingStatus} from '../lib/v1/lending-status-copy.mjs';
import {SEAM_UNKNOWN} from '../lib/v1/lender-pace50.mjs';

// Each reason maps to an estimate note, an owner action, or a condition that clears on its own.
// Enumerate expected classifications so a new or reclassified reason needs a deliberate test update.
const INTENT = new Set(['paused', 'stopped']);
const BANNED = /guarantee|\bsafe|insurance|won['’]t need|finish/i;
const ROWS = [ // [code, status line, who recovers it]
  ['owner_band', 'reserve', 'automatic'], ['owner_harm', 'reserve', 'automatic'],
  ['owner_reserve', 'reserve', 'automatic'], ['defer', 'reserve', 'automatic'],
  ['owner_present', 'recent_use', 'automatic'],
  ['account_busy', 'account_busy', 'note'], ['probe_deferred', 'probe_deferred', 'note'],
  ['usage_unknown', 'measured', 'note'], ['refresh_failed', 'measured', 'note'],
  ['resources_incomplete', 'measured', 'note'], ['epoch_unknown', 'measured', 'note'],
  ['account_week_mapping_unknown', 'measured', 'note'], ['reading_stale', 'measured', 'note'],
  ['aggregate_observation_regressed', 'measured', 'note'], ['cross_window_exposure_unreconciled', 'window_exposure', 'automatic'],
  ['cross_epoch_rate_unknown', 'measured', 'note'],
  ['conversion_unknown', 'conversion', 'note'], ['model_unpriced', 'conversion', 'note'],
  ['history_unknown', 'history', 'note'],
  ['owner_scenarios_unknown', 'evidence', 'note'], ['objective_evidence_unknown', 'evidence', 'note'],
  ['strategy_config_unknown', 'strategy_config_unknown', 'owner'], ['strategy_limit', 'strategy_limit', 'owner'],
  ['demand_model_unavailable', 'model_unavailable', 'automatic'],
  ['demand_model_invalid', 'model_evidence', 'automatic'], ['demand_model_coupling_unknown', 'model_evidence', 'automatic'],
  ['demand_model_exact_usage_required', 'measured', 'note'],
  ['objective_evidence_invalid', 'invalid_evidence', 'note'],
  ['reset', 'reset', 'automatic'], ['resource_reset_margin', 'reset', 'automatic'],
  ['budget_too_small', 'small', 'automatic'], ['request_too_large', 'too_large', 'owner'],
  ['friend_value_unknown', 'value', 'automatic'], ['chunk_value_unknown', 'value', 'automatic'], ['no_value', 'value', 'automatic'],
  ['exceeds_spare', 'spare', 'automatic'],
  ['identity_unknown', 'identity', 'automatic'], ['invalid_identity', 'identity', 'automatic'],
  ['identity_mismatch', 'identity_mismatch', 'owner'],
  ['funding_unknown', 'funding', 'owner'], ['executor_unknown', 'executor', 'note'],
  ['arm_failed', 'executor_failed', 'owner'], ['launch_not_authorized', 'executor_failed', 'owner'],
  ['guard_runtime_unavailable', 'guard_runtime', 'owner'],
  ['stop_bound_unknown', 'stop_bound', 'note'], ['queue_unknown', 'queue', 'automatic'],
  ['gate_closed', 'controls', 'owner'], ['controls', 'controls', 'owner'],
  ['no_useful_quote', 'no_offer', 'automatic'], ['attempt_in_flight', 'in_flight', 'automatic'],
  ['job_epoch_incompatible', 'window', 'automatic'], ['deadline', 'deadline', 'automatic'],
  ['adapter_frozen', 'adapter_frozen', 'automatic'], ['model_not_lendable', 'model', 'owner'],
  ['job_unknown', 'unknown_job', 'automatic'],
  ['account_week_identity', 'internal', 'owner'], ['resource_identity', 'internal', 'owner'],
  ['weekly_resource_mapping', 'internal', 'owner'], ['state_unknown', 'internal', 'owner'],
  ['objective_reservation_invalid', 'internal', 'owner'], ['objective_reservation_exceeds_resource', 'internal', 'owner'],
  ['invalid_input', 'internal', 'owner'], ['duplicate_attempt', 'internal', 'owner'], ['observation_order', 'internal', 'owner'],
  ['revision_overflow', 'internal', 'owner'], ['cross_reset_conversion_mismatch', 'internal', 'owner'],
  ['owner_settings_unreadable', 'owner_settings', 'owner'],
  ['paused', 'paused', 'owner'], ['stopped', 'stopped', 'owner'],
  // Rule refusals are holds; positive fluid/seam decisions stay outside this table.
  ["fluid_invalid_history", "fluid_invalid_history", "note"],
  ["fluid_invalid_trace", "fluid_invalid_trace", "note"],
  ["fluid_invalid_reset_relative_trace", "fluid_invalid_reset_relative_trace", "note"],
  ["fluid_invalid_state", "fluid_invalid_state", "automatic"],
  ["fluid_invalid_identity", "fluid_invalid_identity", "automatic"],
  ["fluid_invalid_window", "fluid_invalid_window", "automatic"],
  ["fluid_invalid_bounds", "fluid_invalid_bounds", "automatic"],
  ["fluid_missing_gross", "fluid_missing_gross", "automatic"],
  ["fluid_unknown_gross_resource", "fluid_unknown_gross_resource", "automatic"],
  ["fluid_allowance", "fluid_allowance", "automatic"],
  ["fluid_deadline", "fluid_deadline", "automatic"],
  ["fluid_zero_gross", "fluid_zero_gross", "automatic"],
  ["seam_quota_windows_required", "seam_quota_windows_required", "automatic"],
  ["seam_unknown_rule_evidence", "seam_unknown_rule_evidence", "automatic"],
  ["seam_unknown_account", "seam_unknown_account", "owner"],
  ["seam_unknown_applicable_resource_roster", "seam_unknown_applicable_resource_roster", "automatic"],
  ["seam_ambiguous_meter_identity", "seam_ambiguous_meter_identity", "automatic"],
  ["seam_incomplete_applicable_resource_roster", "seam_incomplete_applicable_resource_roster", "automatic"],
  ["seam_incompatible_meter_snapshot", "seam_incompatible_meter_snapshot", "automatic"],
  ["seam_incompatible_window_length", "seam_incompatible_window_length", "automatic"],
  ["seam_unknown_meter_age", "seam_unknown_meter_age", "note"],
  ["seam_unknown_account_wide_lag_bound", "seam_unknown_account_wide_lag_bound", "note"],
  ["seam_unknown_ledger_interval", "seam_unknown_ledger_interval", "owner"],
  ["seam_ambiguous_ledger_reset", "seam_ambiguous_ledger_reset", "owner"],
  ["seam_invalid_represented_time", "seam_invalid_represented_time", "owner"],
  ["seam_inconsistent_ledger_snapshot", "seam_inconsistent_ledger_snapshot", "automatic"],
  ["seam_ledger_exceeds_meter", "seam_ledger_exceeds_meter", "automatic"],
  ["seam_unknown_conversion", "seam_unknown_conversion", "note"],
  ["seam_unsafe_gross", "seam_unsafe_gross", "owner"],
  ["seam_rule_must_be_a_function", "seam_rule_must_be_a_function", "owner"],
  ["seam_invalid_rule_decision", "seam_invalid_rule_decision", "owner"],
  ["seam_unknown_now", "seam_unknown_now", "owner"],
  ["seam_unknown_dial", "seam_unknown_dial", "owner"],
  ["seam_unknown_gross_request", "seam_unknown_gross_request", "automatic"],
  ["seam_unknown_meter", "seam_unknown_meter", "automatic"],
  ["seam_unknown_window_length", "seam_unknown_window_length", "automatic"],
  ["seam_unknown_rounding_bound", "seam_unknown_rounding_bound", "owner"],
  ["seam_unknown_provider_lag_bound", "seam_unknown_provider_lag_bound", "owner"],
  ["seam_unknown_account_wide_rate", "seam_unknown_account_wide_rate", "owner"],
  ["seam_unknown_ledger_start", "seam_unknown_ledger_start", "owner"],
  ["seam_unknown_ledger_end", "seam_unknown_ledger_end", "owner"],
  ["seam_unknown_borrower_spend", "seam_unknown_borrower_spend", "owner"],
  ["seam_unknown_borrower_lower", "seam_unknown_borrower_lower", "owner"],
  ["seam_unknown_represented_time", "seam_unknown_represented_time", "owner"],
  ["seam_unknown_ledger_total", "seam_unknown_ledger_total", "automatic"],
  ["seam_unknown_inflight", "seam_unknown_inflight", "owner"],
  ["seam_unknown_ledger_reservations", "seam_unknown_ledger_reservations", "automatic"],
  ["seam_unknown_wall", "seam_unknown_wall", "automatic"],
  ["seam_unknown_uncertainty", "seam_unknown_uncertainty", "automatic"],
  ["seam_unknown_stop", "seam_unknown_stop", "owner"],
  ["seam_unknown_rule_lendable", "seam_unknown_rule_lendable", "owner"],
  ["seam_rule_allowance", "seam_rule_allowance", "automatic"],
  ["seam_physical_room", "seam_physical_room", "automatic"],
  ["seam_product_room", "seam_product_room", "automatic"],
  ["seam_resource_fit", "seam_resource_fit", "automatic"],
  ["fluid_unexpected_error", "fluid_unexpected_error", "owner"],
  ["seam_unexpected_error", "seam_unexpected_error", "owner"],
  ["fluid_unsupported_contract", "fluid_unsupported_contract", "owner"],
  ["seam_unknown_observation", "seam_unknown_observation", "automatic"],
  ["seam_rule_hold", "seam_rule_hold", "automatic"],
  ["quota_registry_missing", "quota_registry_missing", "note"],
  ["native_cost_bound_unknown", "native_cost_bound_unknown", "note"],
  ["quota_registry_unsupported", "quota_registry_unsupported", "owner"],
  ["rule_seam_quota_unit_unsupported", "rule_seam_quota_unit_unsupported", "owner"],
  ["rule_seam_rolling_unsupported", "rule_seam_rolling_unsupported", "owner"],
  ["quota_registry_charge_mismatch", "quota_registry_charge_mismatch", "owner"],
  ["seam_native_no_room", "seam_native_no_room", "automatic"],
  // Native-window mode (no measured usage rate). Missing history has no code; a stale meter keeps the named 'measured' hold.
  ["native_attempt_in_flight", "native_pending", "automatic"],
  ["cross_reset_native_unsupported", "reset", "automatic"],
  ["native_budget_unknown", "native_budget", "owner"],
  ["native_settlement_unknown", "measured", "note"],
  ["native_settlement_incomplete", "measured", "note"],
  ["native_settlement_mismatch", "measured", "note"],
  ["native_settlement_unread", "measured", "note"],
  ["native_settlement_scope_changed", "reset", "automatic"],
  ["native_guard_waiting", "measured", "note"],
  ["native_guard_meter_stale", "measured", "note"],
  ["native_guard_allowance_reached", "native_allowance", "automatic"],
  ["native_guard_window_reset", "reset", "automatic"],
  ["native_guard_identity_changed", "identity_mismatch", "owner"],
  ["native_guard_funding_changed", "funding", "owner"],
  ["native_guard_epoch_changed", "window", "automatic"],
  ["native_guard_owner_stop", "stopped", "owner"],
  ["native_guard_window_recheck", "native_recheck", "automatic"],
  ["window_origin_unknown", "window_origin", "automatic"],

];

test('the table covers every reason the copy maps, and every named seam hold', () => {
  assert.deepEqual(ROWS.map(([code]) => code).sort(), Object.keys(REASON_LINE).sort());
  for (const code of SEAM_UNKNOWN) assert.ok(ROWS.some(([row]) => row === code), code + ' has a row');
});

test('each hold code maps to its line, says who recovers it, and reads as a plain cause', () => {
  for (const [code, line, who] of ROWS) {
    assert.equal(REASON_LINE[code], line, code + ' maps to its line');
    const recovery = RECOVERY[line];
    const text = LINES[line];
    assert.doesNotMatch(text, /_/, code + ': the copy names no code');
    assert.doesNotMatch(text, BANNED, code + ': no banned wording');
    if (who === 'note') {
      assert.equal(recovery, undefined, code + ' has no recovery action');
      assert.match(text, /^Usage estimate:/);
      continue;
    }
    assert.equal(recovery?.who, who, code + ' says who recovers it');
    if (who === 'owner') {
      assert.ok(recovery.action, code + ' names the owner action');
      if (!INTENT.has(line)) assert.ok(text.includes('This needs you: ' + recovery.action + '.'), code + ' states the action');
    } else {
      assert.ok(recovery.when, code + ' names when it clears');
      assert.ok(text.endsWith('It clears on its own when ' + recovery.when + '.'), code + ' states when it clears');
    }
  }
});

test('the status carries the same line and the same recovery as the table, for every code', () => {
  for (const [code, line, who] of ROWS) {
    const status = lendingStatus({reason: code});
    assert.equal(status.line, LINES[line], code + ': the status line is the table line');
    if (who === 'note') {
      assert.equal(status.id, 'usage_estimate', code);
      assert.equal(Object.hasOwn(status, 'recovery'), false, code);
    } else assert.equal(status.recovery?.who, who, code + ': the status says who recovers it');
  }
});

test('conversion, history and invalid evidence share estimate copy while retaining distinct mappings', () => {
  const codes = ['conversion_unknown', 'history_unknown', 'objective_evidence_invalid'];
  assert.equal(new Set(codes.map(code => REASON_LINE[code])).size, codes.length);
  const observations = codes.map(reason => lendingStatus({reason}));
  assert.equal(new Set(observations.map(status => status.line)).size, 1);
  for (const status of observations) {
    assert.equal(status.id, 'usage_estimate');
    assert.equal(Object.hasOwn(status, 'recovery'), false);
  }
});

test('a structured Codex funding limit clears when the limit resets', () => {
  assert.equal(lendingStatus({reason:'funding_unknown'}).recovery.who, 'owner');
  const limited = lendingStatus({reason:'funding_unknown', detail:{fundingReason:'limit_reached'}});
  assert.equal(limited.id, 'funding');
  assert.match(limited.line, /Codex usage limit/);
  assert.deepEqual(limited.recovery, {who:'automatic', when:'the limit resets'});
});

// Sandpiper, 2026-11-01: an account check that failed told the owner "This needs you" when nothing they did could clear it.
test('an unconfirmed account is Faravan\'s to check again; only a different account asks the owner to act', () => {
  const unknown = lendingStatus({reason: 'identity_unknown'});
  assert.equal(unknown.line, 'Holding — Faravan could not confirm which account is signed in to this agent. '
    + 'It clears on its own when the next allowance reading confirms it.');
  assert.doesNotMatch(unknown.line, /needs you/i);
  assert.deepEqual(unknown.recovery, {who: 'automatic', when: 'the next allowance reading confirms it'});
  const mismatch = lendingStatus({reason: 'identity_mismatch'});
  assert.equal(mismatch.id, 'identity_mismatch');
  assert.match(mismatch.line, /^Holding — a different account is signed in to this agent than the one enrolled for lending\. This needs you: /);
  assert.equal(mismatch.recovery.who, 'owner');
  assert.equal(SEAM_UNKNOWN.has('identity_mismatch'), true, 'the reason crosses the route boundary by name');
});

test('native pending explains why Faravan will check again without asking the owner to act', () => {
  const status = lendingStatus({reason: 'native_attempt_in_flight'});
  assert.equal(status.id, 'native_pending');
  assert.equal(status.line, 'Holding — Faravan is waiting to account for an earlier job’s usage. '
    + 'It clears on its own when the provider reports that usage or the allowance resets.');
  assert.equal(status.recovery?.who, 'automatic');
});
