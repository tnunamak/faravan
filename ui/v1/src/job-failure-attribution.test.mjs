import test from 'node:test';
import assert from 'node:assert/strict';
import {FAILURE_CODES, classify} from '../../../lib/v1/failures.mjs';
import {jobStatusContract} from '../../../lib/v1/status-contract.mjs';
import {RESULT_DELIVERY_FAILURE_CODES, LENDER_INTERRUPTION_CODES} from './job-failure-copy.mjs';
import {formatJobProjection} from './job-projection-view.mjs';
import {jobStatusVM} from './view-models.mjs';

const at = '2026-10-21T12:00:00.000Z';
const failed = (code, failurePhase = 'result') => ({jobProjection:{
  schemaVersion:2,kind:'job',phase:'failed',reasonCode:code,
  result:{available:false,digest:null},application:{outcome:null,appliedBranch:null},
  evidence:{rawState:'failed',attemptPresent:true,approval:null,approvedAt:null,
    executionStartedAt:at,computeStopped:false,failurePhase},
  version:{jobDigest:'sha256:'+'a'.repeat(64)},
  times:{observedAt:at,validUntil:null,nextTransitionAt:null},actionHints:[],
}});
const resultCodes = FAILURE_CODES.filter(code => {
  const row = classify(code, 'result');
  return row.borrower_key === 'failure.result_delivery.borrower' && row.outcome === 'failed';
});
test('browser delivery registry exactly matches accounting classification', () => {
  assert.deepEqual([...RESULT_DELIVERY_FAILURE_CODES].sort(), [...resultCodes].sort());
  assert.equal(new Set(RESULT_DELIVERY_FAILURE_CODES).size, RESULT_DELIVERY_FAILURE_CODES.length);
});
test('every classified result-delivery failure survives projection and gets lender-side recovery', () => {
  for (const code of resultCodes) {
    const job = failed(code);
    assert.equal(formatJobProjection(job).failureDetails.reason, code);
    const copy = jobStatusVM(job);
    assert.match(copy.headline + ' ' + copy.text, /lender’s computer/);
    assert.match(copy.text, /Nothing was added to your code/);
    assert.match(copy.text, /send it again or choose another lender/);
    assert.equal(copy.recovery, 'resend');
    const contract = jobStatusContract(job);
    assert.equal(contract.responsibleParty, 'lender', code);
    assert.equal(contract.explanation, copy.text, code);
    assert.deepEqual(contract.allowedActions, [copy.recovery], code);
    assert.doesNotMatch(copy.headline + ' ' + copy.text, /verdict|receipt|attempt|settled|lease/i);
    assert.equal(classify(code, 'result').owner, 'platform', 'display attribution does not change accounting');
  }
});
test('meter_unavailable explains the lender meter; completion_rejected does not invent finished work', () => {
  const meter = jobStatusVM(failed('meter_unavailable'));
  assert.equal(meter.headline, 'The lender’s computer could not send the work back');
  assert.match(meter.text, /finished the work but could not send it back because its usage meter was unavailable/);
  const rejected = jobStatusVM(failed('completion_rejected'));
  assert.equal(rejected.headline, 'The lender’s computer could not send the work back');
  assert.doesNotMatch(rejected.text, /finished the work/);
});
test('wall_timeout and stopped_by_lender keep their existing copy', () => {
  const timeout = jobStatusVM({...failed('wall_timeout','run'),safety:{budget_minutes:5}});
  assert.equal(timeout.headline, "The agent couldn't finish: it hit the 5-minute limit.");
  assert.equal(timeout.recovery, 'followup');
  const stopped = jobStatusVM(failed('stopped_by_lender','run'),{lender:'Maya'});
  assert.equal(stopped.headline, 'Maya stopped this run. Changes up to the stop weren’t kept.');
});
test('unknown failure text cannot become a public reason or a completion claim', () => {
  const job=failed('private_new_failure');
  assert.equal(formatJobProjection(job).failureDetails.reason,null);
  assert.equal(jobStatusVM(job).headline,'The job didn’t finish');
});
test('missing result-phase evidence never claims the meter failure finished work', () => {
  for (const phase of [null,'prepare','run']) {
    const job=failed('meter_unavailable',phase);
    const copy=jobStatusVM(job);
    assert.doesNotMatch(copy.text,/finished the work/);
    assert.equal(jobStatusContract(job).explanation,copy.text);
  }
});
test('lender interruptions keep their reason and never claim completed work', () => {
  for (const code of LENDER_INTERRUPTION_CODES) {
    const job=failed(code,'run');
    const copy=jobStatusVM(job);
    assert.equal(formatJobProjection(job).failureDetails.reason,code);
    assert.equal(jobStatusContract(job).responsibleParty,'lender');
    assert.match(copy.headline,/computer stopped answering/);
    assert.doesNotMatch(copy.headline,/finished the work/);
    assert.equal(copy.recovery,'resend');
  }
});
