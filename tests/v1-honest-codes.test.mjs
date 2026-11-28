import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {failureMessage, failureVM} from '../lib/v1/cli.mjs';

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
