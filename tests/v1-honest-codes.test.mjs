import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {declineCodeFor, isObjectiveReviewHold} from '../lib/v1/lender-pace50.mjs';
import {failureMessage, failureVM} from '../lib/v1/cli.mjs';
import {FAILURE_CODES} from '../lib/v1/failures.mjs';
import {offerReason} from '../lib/v1/offer-book.mjs';
import {messageForCode} from '../lib/v1/lending-log.mjs';

const mappings = {
  internal_error: ['admission_timeout','admission_check_failed','internal_admission_error','admission_headroom_failure',
    'evidence_builder_failed','invalid_input','invalid_identity','state_unknown','revision_overflow','duplicate_attempt',
    'objective_reservation_invalid','objective_reservation_exceeds_resource','future_reason'],
  model_not_lendable: ['model_unpriced'],
  invalid_request: ['invalid_request','job_unknown'],
  readiness_changed: ['gate_closed','revision_conflict','observation_order','schedule_action_unsafe'],
  quota_reserve: ['job_epoch_incompatible'],
  native_attempt_in_flight: ['native_attempt_in_flight'],
  window_not_open: ['window_not_open'],
  quota_unknown: ['quota_unknown','reading_stale','reading_unknown','resource_unknown','window_timing_unknown'],
  objective_evidence_unknown: ['evidence_unknown','native_budget_unknown','objective_evidence_invalid','protection_source_inconsistent'],
  resources_incomplete: ['resource_roster_unknown','resource_identity','weekly_resource_mapping'],
  account_week_mapping_unknown: ['account_week_identity'],
  unreadable_window_origin: ['window_origin_unknown'],
  conversion_unknown: ['cross_reset_conversion_mismatch'],
  meter_unavailable: ['meter_coverage_required'],
  observation_changed: ['aggregate_observation_regressed'],
};
for (const [code, reasons] of Object.entries(mappings)) {
  for (const reason of reasons) test(`${reason} reports ${code}`, () => {
    assert.equal(declineCodeFor(reason), code);
    assert.ok(FAILURE_CODES.includes(code));
    assert.equal(offerReason(code), code);
  });
}
test('internal offer and owner log retain an honest code and copy', () => {
  assert.equal(offerReason(declineCodeFor('future_reason')), 'internal_error');
  assert.equal(messageForCode('internal_error'), 'Something went wrong on this computer.');
});
test('no current job and unknown failures never imply execution', () => {
  for (const phase of [undefined, 'prepare', 'run']) {
    for (const present of [failureMessage, (code, p) => failureVM(code, p).headline]) {
      assert.equal(present('no_current_job', phase), 'No job was running when the action arrived.');
      assert.equal(present('future_failure', phase), 'The action could not be completed. Check the job status for details.');
    }
  }
});
test('known interruptions keep the existing cautious text', () => {
  for (const code of ['lease_expired','lease_expired_unproven','lease_uncertain','network_error','sandbox_crash',
    'restart_interrupted','stale_attempt','cessation_unverified','execution_observation_failed','lender_failed',
    'lender_stopped','sandbox_stop_failed','stop_report_pending'])
    assert.equal(failureMessage(code, 'run'), 'Interrupted. The agent may have done part of the work. Nothing came back.');
});

test('temporary native and window holds stay reviewable and keep precise owner copy', () => {
  for (const code of ['native_attempt_in_flight','window_not_open']) {
    assert.equal(isObjectiveReviewHold(code),true);
    assert.doesNotMatch(messageForCode(code),/Something went wrong/);
  }
});
