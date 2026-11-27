import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {lendingStatus, RULE_REASON_COPY} from '../../../lib/v1/lending-status-copy.mjs';

// MAPPED proves the pure status formatter returns this exact owner sentence.
// It does not claim end-to-screen rendering of diagnostics outside this scope.
// Historical branches removed/preempted by registry/v2 and display-only fields
// stay MISSING with an explicit reason; they are not disguised as passes.
const inventory = [
  {
    "origin": "fluid",
    "key": "invalid history",
    "line": 7,
    "status": "MAPPED",
    "desired": "Usage estimate: lending uses available readings or the starting estimate; history improves it.",
    "code": "fluid_invalid_history"
  },
  {
    "origin": "fluid",
    "key": "invalid trace",
    "line": 10,
    "status": "MAPPED",
    "desired": "Usage estimate: lending uses available readings or the starting estimate; history improves it.",
    "code": "fluid_invalid_trace"
  },
  {
    "origin": "fluid",
    "key": "invalid reset-relative trace",
    "line": 13,
    "status": "MAPPED",
    "desired": "Usage estimate: lending uses available readings or the starting estimate; history improves it.",
    "code": "fluid_invalid_reset_relative_trace"
  },
  {
    "origin": "fluid",
    "key": "invalid state",
    "line": 57,
    "status": "MAPPED",
    "desired": "Lending is waiting because job or allowance details are incomplete. It clears on its own when complete job and allowance details arrive.",
    "code": "fluid_invalid_state"
  },
  {
    "origin": "fluid",
    "key": "invalid identity",
    "line": 60,
    "status": "MAPPED",
    "desired": "Lending is waiting because an allowance window cannot be identified. It clears on its own when the next reading identifies the allowance window.",
    "code": "fluid_invalid_identity"
  },
  {
    "origin": "fluid",
    "key": "invalid window",
    "line": 61,
    "status": "MAPPED",
    "desired": "Lending is waiting because an allowance reading is incomplete. It clears on its own when a complete allowance reading arrives.",
    "code": "fluid_invalid_window"
  },
  {
    "origin": "fluid",
    "key": "invalid bounds",
    "line": 62,
    "status": "MAPPED",
    "desired": "Lending is waiting because allowance readings are inconsistent or expired. It clears on its own when a consistent current allowance reading arrives.",
    "code": "fluid_invalid_bounds"
  },
  {
    "origin": "fluid",
    "key": "missing gross",
    "line": 63,
    "status": "MAPPED",
    "desired": "Lending is waiting because the job's full allowance cost is unknown. It clears on its own when the job's full allowance estimate becomes available.",
    "code": "fluid_missing_gross"
  },
  {
    "origin": "fluid",
    "key": "unknown gross resource",
    "line": 71,
    "status": "MAPPED",
    "desired": "Lending is waiting because the job needs an allowance that has not been checked. It clears on its own when all allowances needed by the job have been checked.",
    "code": "fluid_unknown_gross_resource"
  },
  {
    "origin": "fluid",
    "key": "lend",
    "line": 72,
    "status": "MAPPED",
    "desired": "This job fits the allowance available to lend and can be stopped before reset. No action is needed.",
    "code": "fluid_lend"
  },
  {
    "origin": "fluid",
    "key": "hold: share / waiting-startup / physical room",
    "line": 68,
    "status": "MAPPED",
    "desired": "This job needs more allowance than is available to lend. It clears on its own when enough allowance becomes available for this job.",
    "code": "fluid_allowance"
  },
  {
    "origin": "fluid",
    "key": "hold: deadline",
    "line": 69,
    "status": "MAPPED",
    "desired": "This job cannot be stopped before the allowance resets. It clears on its own when a new job fits before the next reset.",
    "code": "fluid_deadline"
  },
  {
    "origin": "fluid",
    "key": "hold: zero gross",
    "line": 71,
    "status": "MAPPED",
    "desired": "Lending is waiting because this job has no positive allowance estimate. It clears on its own when a positive allowance estimate becomes available.",
    "code": "fluid_zero_gross"
  },
  {
    "origin": "seam",
    "key": "both quota windows required",
    "line": 42,
    "status": "MAPPED",
    "desired": "Lending is waiting because both allowance windows have not been checked. It clears on its own when both allowance windows have been checked.",
    "code": "seam_quota_windows_required"
  },
  {
    "origin": "seam",
    "key": "unknown rule evidence",
    "line": 44,
    "status": "MAPPED",
    "desired": "Lending is waiting because the details needed to decide whether to lend are unavailable. It clears on its own when the required lending details become available.",
    "code": "seam_unknown_rule_evidence"
  },
  {
    "origin": "seam",
    "key": "unknown account",
    "line": 46,
    "status": "MAPPED",
    "desired": "Lending is waiting because the allowance reading is not linked to an account. This needs you: check agent sign-in and refresh allowance.",
    "code": "seam_unknown_account"
  },
  {
    "origin": "seam",
    "key": "unknown applicable resource roster",
    "line": 52,
    "status": "MAPPED",
    "desired": "Lending is waiting because the allowances needed for this model are not confirmed. It clears on its own when the allowances needed for this model are confirmed.",
    "code": "seam_unknown_applicable_resource_roster"
  },
  {
    "origin": "seam",
    "key": "ambiguous meter identity",
    "line": 55,
    "status": "MAPPED",
    "desired": "Lending is waiting because allowance readings cannot be matched to one window. It clears on its own when new readings identify each allowance window once.",
    "code": "seam_ambiguous_meter_identity"
  },
  {
    "origin": "seam",
    "key": "unknown model quota applicability",
    "line": 59,
    "status": "MISSING",
    "desired": "Lending is waiting because the allowances used by this model are unknown. Try another model or refresh allowance.",
    "missing": "Removed or preempted by the registry/contract-v2 boundary; no ordinary input reaches this historical refusal."
  },
  {
    "origin": "seam",
    "key": "incomplete applicable resource roster",
    "line": 64,
    "status": "MAPPED",
    "desired": "Lending is waiting because some allowances needed for this job have not been checked. It clears on its own when all allowances needed by the job have been checked.",
    "code": "seam_incomplete_applicable_resource_roster"
  },
  {
    "origin": "seam",
    "key": "incompatible meter snapshot",
    "line": 75,
    "status": "MAPPED",
    "desired": "Lending is waiting because the allowance readings do not agree. It clears on its own when consistent allowance readings arrive.",
    "code": "seam_incompatible_meter_snapshot"
  },
  {
    "origin": "seam",
    "key": "incompatible window length",
    "line": 79,
    "status": "MAPPED",
    "desired": "Lending is waiting because the allowance reset window is inconsistent. It clears on its own when readings with matching reset windows arrive.",
    "code": "seam_incompatible_window_length"
  },
  {
    "origin": "seam",
    "key": "unknown meter age",
    "line": 83,
    "status": "MAPPED",
    "desired": "Usage estimate: lending uses available readings or the starting estimate; history improves it.",
    "code": "seam_unknown_meter_age"
  },
  {
    "origin": "seam",
    "key": "unknown account-wide lag bound",
    "line": 87,
    "status": "MAPPED",
    "desired": "Usage estimate: lending uses available readings or the starting estimate; history improves it.",
    "code": "seam_unknown_account_wide_lag_bound"
  },
  {
    "origin": "seam",
    "key": "unknown ledger interval",
    "line": 95,
    "status": "MAPPED",
    "desired": "Lending is waiting because recorded lending times are inconsistent. This needs you: report the inconsistent recorded lending times.",
    "code": "seam_unknown_ledger_interval"
  },
  {
    "origin": "seam",
    "key": "ambiguous ledger reset",
    "line": 97,
    "status": "MAPPED",
    "desired": "Lending is waiting because past lending cannot be matched to a reset window. This needs you: report the lending entry with an unknown reset window.",
    "code": "seam_ambiguous_ledger_reset"
  },
  {
    "origin": "seam",
    "key": "invalid represented time",
    "line": 106,
    "status": "MAPPED",
    "desired": "Lending is waiting because recorded lending and allowance update times do not agree. This needs you: report the inconsistent lending and allowance update times.",
    "code": "seam_invalid_represented_time"
  },
  {
    "origin": "seam",
    "key": "inconsistent ledger snapshot",
    "line": 111,
    "status": "MAPPED",
    "desired": "Lending is waiting because the lending totals do not agree. It clears on its own when recorded lending and allowance totals agree.",
    "code": "seam_inconsistent_ledger_snapshot"
  },
  {
    "origin": "seam",
    "key": "ledger exceeds meter",
    "line": 112,
    "status": "MAPPED",
    "desired": "Lending is waiting because recorded lending exceeds the allowance reading. It clears on its own when an updated allowance reading accounts for recorded lending.",
    "code": "seam_ledger_exceeds_meter"
  },
  {
    "origin": "seam",
    "key": "unknown conversion",
    "line": 121,
    "status": "MAPPED",
    "desired": "Usage estimate: lending uses available readings or the starting estimate; history improves it.",
    "code": "seam_unknown_conversion"
  },
  {
    "origin": "seam",
    "key": "unsafe gross",
    "line": 123,
    "status": "MAPPED",
    "desired": "Lending is waiting because the job's allowance estimate is too large to check. This needs you: request a smaller job.",
    "code": "seam_unsafe_gross"
  },
  {
    "origin": "seam",
    "key": "unknown history",
    "line": 127,
    "status": "MISSING",
    "desired": "Lending is waiting because usage history is unavailable. Refresh allowance and try again.",
    "missing": "Removed or preempted by the registry/contract-v2 boundary; no ordinary input reaches this historical refusal."
  },
  {
    "origin": "seam",
    "key": "invalid trace",
    "line": 130,
    "status": "MISSING",
    "desired": "Lending is waiting because usage history contains an incomplete reading. Refresh allowance and try again.",
    "missing": "Removed or preempted by the registry/contract-v2 boundary; no ordinary input reaches this historical refusal."
  },
  {
    "origin": "seam",
    "key": "invalid history order",
    "line": 133,
    "status": "MISSING",
    "desired": "Lending is waiting because usage history has inconsistent times. Refresh allowance and try again.",
    "missing": "Removed or preempted by the registry/contract-v2 boundary; no ordinary input reaches this historical refusal."
  },
  {
    "origin": "seam",
    "key": "rule must be a function",
    "line": 145,
    "status": "MAPPED",
    "desired": "Lending is waiting because the lending rule is unavailable. This needs you: check for a Faravan update and report the missing lending rule.",
    "code": "seam_rule_must_be_a_function"
  },
  {
    "origin": "seam",
    "key": "invalid rule decision",
    "line": 152,
    "status": "MAPPED",
    "desired": "Lending is waiting because the lending rule returned an unreadable decision. This needs you: report the unreadable lending decision.",
    "code": "seam_invalid_rule_decision"
  },
  {
    "origin": "seam",
    "key": "unknown now",
    "line": 39,
    "status": "MAPPED",
    "desired": "Lending is waiting because the current time is unavailable or inconsistent. This needs you: check this computer's clock.",
    "code": "seam_unknown_now"
  },
  {
    "origin": "seam",
    "key": "unknown dial",
    "line": 39,
    "status": "MAPPED",
    "desired": "Lending is waiting because the saved lending preference is unavailable or inconsistent. This needs you: save a lending preference again.",
    "code": "seam_unknown_dial"
  },
  {
    "origin": "seam",
    "key": "unknown gross request",
    "line": 67,
    "status": "MAPPED",
    "desired": "Lending is waiting because the job's full cost estimate is unavailable or inconsistent. It clears on its own when a valid full job estimate becomes available.",
    "code": "seam_unknown_gross_request"
  },
  {
    "origin": "seam",
    "key": "unknown meter",
    "line": 74,
    "status": "MAPPED",
    "desired": "Lending is waiting because the allowance reading is unavailable or inconsistent. It clears on its own when a consistent allowance reading arrives.",
    "code": "seam_unknown_meter"
  },
  {
    "origin": "seam",
    "key": "unknown window length",
    "line": 76,
    "status": "MAPPED",
    "desired": "Lending is waiting because the time between allowance resets is unavailable or inconsistent. It clears on its own when a reading with a valid reset interval arrives.",
    "code": "seam_unknown_window_length"
  },
  {
    "origin": "seam",
    "key": "unknown observation",
    "line": 80,
    "status": "MAPPED",
    "desired": "Lending is waiting because the allowance reading time is unavailable or inconsistent. It clears on its own when a reading with a valid observation time arrives.",
    "code": "seam_unknown_observation"
  },
  {
    "origin": "seam",
    "key": "unknown rounding bound",
    "line": 84,
    "status": "MAPPED",
    "desired": "Lending is waiting because the possible rounding error in allowance readings is unavailable or inconsistent. This needs you: check for support for this allowance's rounding error.",
    "code": "seam_unknown_rounding_bound"
  },
  {
    "origin": "seam",
    "key": "unknown provider lag bound",
    "line": 88,
    "status": "MAPPED",
    "desired": "Lending is waiting because the possible delay in allowance reporting is unavailable or inconsistent. This needs you: check for support for this provider's reporting delay.",
    "code": "seam_unknown_provider_lag_bound"
  },
  {
    "origin": "seam",
    "key": "unknown account-wide rate",
    "line": 90,
    "status": "MAPPED",
    "desired": "Lending is waiting because the maximum rate of account use is unavailable or inconsistent. This needs you: check for support for this account's usage-rate bound.",
    "code": "seam_unknown_account_wide_rate"
  },
  {
    "origin": "seam",
    "key": "unknown ledger start",
    "line": 94,
    "status": "MAPPED",
    "desired": "Lending is waiting because the recorded lending start time is unavailable or inconsistent. This needs you: report the missing or inconsistent lending start time.",
    "code": "seam_unknown_ledger_start"
  },
  {
    "origin": "seam",
    "key": "unknown ledger end",
    "line": 94,
    "status": "MAPPED",
    "desired": "Lending is waiting because the recorded lending end time is unavailable or inconsistent. This needs you: report the missing or inconsistent lending end time.",
    "code": "seam_unknown_ledger_end"
  },
  {
    "origin": "seam",
    "key": "unknown borrower spend",
    "line": 101,
    "status": "MAPPED",
    "desired": "Lending is waiting because the allowance already used for friends is unavailable or inconsistent. This needs you: report the missing or inconsistent recorded allowance used for friends.",
    "code": "seam_unknown_borrower_spend"
  },
  {
    "origin": "seam",
    "key": "unknown borrower lower",
    "line": 102,
    "status": "MAPPED",
    "desired": "Lending is waiting because the confirmed allowance used for friends is unavailable or inconsistent. This needs you: report the missing or inconsistent confirmed allowance used for friends.",
    "code": "seam_unknown_borrower_lower"
  },
  {
    "origin": "seam",
    "key": "unknown represented time",
    "line": 105,
    "status": "MAPPED",
    "desired": "Lending is waiting because the time a lending entry appeared in allowance readings is unavailable or inconsistent. This needs you: report the missing or inconsistent allowance update time.",
    "code": "seam_unknown_represented_time"
  },
  {
    "origin": "seam",
    "key": "unknown ledger total",
    "line": 110,
    "status": "MAPPED",
    "desired": "Lending is waiting because the recorded lending total is unavailable or inconsistent. It clears on its own when a reading with a valid recorded lending total arrives.",
    "code": "seam_unknown_ledger_total"
  },
  {
    "origin": "seam",
    "key": "unknown inflight",
    "line": 113,
    "status": "MAPPED",
    "desired": "Lending is waiting because the allowance held for running jobs is unavailable or inconsistent. This needs you: report the missing or inconsistent allowance held for running jobs.",
    "code": "seam_unknown_inflight"
  },
  {
    "origin": "seam",
    "key": "unknown ledger reservations",
    "line": 114,
    "status": "MAPPED",
    "desired": "Lending is waiting because the allowance reserved for other jobs is unavailable or inconsistent. It clears on its own when a reading with valid allowance reservations arrives.",
    "code": "seam_unknown_ledger_reservations"
  },
  {
    "origin": "seam",
    "key": "unknown history time",
    "line": 132,
    "status": "MISSING",
    "desired": "Lending is waiting because the time of a past usage reading is unavailable or inconsistent. Refresh status and try again.",
    "missing": "Removed or preempted by the registry/contract-v2 boundary; no ordinary input reaches this historical refusal."
  },
  {
    "origin": "seam",
    "key": "unknown history usage",
    "line": 132,
    "status": "MISSING",
    "desired": "Lending is waiting because the past usage reading is unavailable or inconsistent. Refresh status and try again.",
    "missing": "Removed or preempted by the registry/contract-v2 boundary; no ordinary input reaches this historical refusal."
  },
  {
    "origin": "seam",
    "key": "unknown wall",
    "line": 139,
    "status": "MAPPED",
    "desired": "Lending is waiting because the job duration is unavailable or inconsistent. It clears on its own when a valid job duration estimate becomes available.",
    "code": "seam_unknown_wall"
  },
  {
    "origin": "seam",
    "key": "unknown uncertainty",
    "line": 139,
    "status": "MAPPED",
    "desired": "Lending is waiting because the extra time reserved for a job is unavailable or inconsistent. It clears on its own when a valid job timing allowance becomes available.",
    "code": "seam_unknown_uncertainty"
  },
  {
    "origin": "seam",
    "key": "unknown stop",
    "line": 140,
    "status": "MAPPED",
    "desired": "Lending is waiting because the time needed to stop a job is unavailable or inconsistent. This needs you: check the executor's stop support.",
    "code": "seam_unknown_stop"
  },
  {
    "origin": "seam",
    "key": "unknown rule lendable",
    "line": 155,
    "status": "MAPPED",
    "desired": "Lending is waiting because the allowance the rule offers to lend is unavailable or inconsistent. This needs you: report the lending rule's unreadable allowance estimate.",
    "code": "seam_unknown_rule_lendable"
  },
  {
    "origin": "seam",
    "key": "cap: rule allowance",
    "line": 159,
    "status": "MAPPED",
    "desired": "This job is limited by the allowance available to lend. It clears on its own when enough allowance becomes available for this job.",
    "code": "seam_rule_allowance"
  },
  {
    "origin": "seam",
    "key": "cap: independent physical room",
    "line": 159,
    "status": "MAPPED",
    "desired": "This job is limited by allowance already used or reserved. It clears on its own when enough unused, unreserved allowance becomes available.",
    "code": "seam_physical_room"
  },
  {
    "origin": "seam",
    "key": "cap: product uncertainty and commitments",
    "line": 160,
    "status": "MAPPED",
    "desired": "This job is limited by allowance kept for uncertain use and running jobs. It clears on its own when updated readings leave enough allowance after other commitments.",
    "code": "seam_product_room"
  },
  {
    "origin": "seam",
    "key": "fit=false overrides admit=true; reason unchanged",
    "line": 163,
    "status": "MAPPED",
    "desired": "This job does not fit the available allowance, so it will not start. It clears on its own when the whole job fits every required allowance.",
    "code": "seam_resource_fit"
  },
  {
    "origin": "fluid",
    "key": "admit / lendable / reason",
    "line": 72,
    "status": "MISSING",
    "desired": "Show whether this job can start, how much allowance is available for each window, and why.",
    "missing": "Display-only diagnostic, not a reason code."
  },
  {
    "origin": "fluid",
    "key": "reserve / envelope",
    "line": 52,
    "status": "MISSING",
    "desired": "Show how much allowance is kept for you and how much can be shared.",
    "missing": "Display-only diagnostic, not a reason code."
  },
  {
    "origin": "fluid",
    "key": "n / imported / owner",
    "line": 52,
    "status": "MISSING",
    "desired": "Show how many past windows informed this estimate and the current use already observed.",
    "missing": "Display-only diagnostic, not a reason code."
  },
  {
    "origin": "fluid",
    "key": "optimum / startup",
    "line": 52,
    "status": "MISSING",
    "desired": "Show how the waiting estimate and starting allowance affect what can be lent.",
    "missing": "Display-only diagnostic, not a reason code."
  },
  {
    "origin": "fluid",
    "key": "mode",
    "line": 52,
    "status": "MISSING",
    "desired": "This is a model-based estimate, not a promise about future use.",
    "missing": "Display-only diagnostic, not a reason code."
  },
  {
    "origin": "fluid",
    "key": "unexpected exception text",
    "line": 73,
    "status": "MAPPED",
    "desired": "Lending is waiting because a required detail could not be checked. This needs you: report the lending check that could not be completed.",
    "code": "fluid_unexpected_error"
  },
  {
    "origin": "seam",
    "key": "state",
    "line": 164,
    "status": "MISSING",
    "desired": "Show the allowance windows and observations used for this decision.",
    "missing": "Display-only diagnostic, not a reason code."
  },
  {
    "origin": "seam",
    "key": "admitted / reason",
    "line": 164,
    "status": "MISSING",
    "desired": "Show whether the job may start and explain any hold without a conflicting lending message.",
    "missing": "Display-only diagnostic, not a reason code."
  },
  {
    "origin": "seam",
    "key": "lendableMicro / fit",
    "line": 164,
    "status": "MISSING",
    "desired": "Show the remaining allowance for each window and whether the full job fits.",
    "missing": "Display-only diagnostic, not a reason code."
  },
  {
    "origin": "seam",
    "key": "grossUsdMicro",
    "line": 165,
    "status": "MISSING",
    "desired": "Show the full estimated job cost used in this decision.",
    "missing": "Display-only diagnostic, not a reason code."
  },
  {
    "origin": "seam",
    "key": "reservePointsMicro",
    "line": 166,
    "status": "MISSING",
    "desired": "Show the allowance that this job would reserve in each window.",
    "missing": "Display-only diagnostic, not a reason code."
  },
  {
    "origin": "seam",
    "key": "unexpected input or candidate exception",
    "line": 146,
    "status": "MAPPED",
    "desired": "Lending is waiting because a required detail could not be checked. This needs you: report the lending check that could not be completed.",
    "code": "seam_unexpected_error"
  }
];

for (const row of inventory) {
  test(row.origin + ':' + row.line + ' ' + row.key + ' [' + row.status + ']',
    row.status === 'MISSING' ? {todo: row.missing} : {}, () => {
      if (row.status === 'MISSING') return;
      assert.equal(RULE_REASON_COPY[row.code], row.desired);
      assert.equal(lendingStatus({reasonCode: row.code, admitted: row.code === 'fluid_lend'}).line, row.desired);
    });
}
const fluid = readFileSync(new URL('../../../lib/v1/rules/fluid-protection.mjs', import.meta.url), 'utf8');
const seam = readFileSync(new URL('../../../lib/v1/lending-rule-seam.mjs', import.meta.url), 'utf8');
test('every explicitly named fluid refusal has owner copy', () => {
  for (const match of fluid.matchAll(/throw refusal\('([^']+)'/g)) assert.ok(RULE_REASON_COPY[match[1]], match[1]);
});
test('every explicitly named seam refusal has owner copy', () => {
  for (const match of seam.matchAll(/throw evidenceError\('([^']+)'/g)) assert.ok(RULE_REASON_COPY[match[1]], match[1]);
});
test('every parameterized seam validation has owner copy', () => {
  const table = JSON.parse(seam.match(/const VALIDATION_CODE = Object.freeze\((\{[\s\S]*?\})\);/)[1]);
  for (const value of Object.values(table)) assert.ok(RULE_REASON_COPY[value], value);
});
test('seam retains legacy reason text independently of structured cap code', () => {
  assert.match(seam, /admitted:result\.admit && fits, reason:result\.reason\.trim\(\)/);
  assert.ok(inventory.some(row => row.key === 'fit=false overrides admit=true; reason unchanged'));
});
