import test from 'node:test';
import assert from 'node:assert/strict';
import {jobStatusVM, waitingCopyVM} from './view-models.mjs';

const declined = 'Sam declined this request. It went back to the circle; another computer can pick it up.';
const queued = reason => ({state: 'queued', lenderName: 'Sam', current_attempt: {holder: 'lender', state: 'released', execution_started_at: null, reason: JSON.stringify({code: reason})},
  waitingTiming: {submittedAt: '2026-10-19T19:41:00Z', expiresAt: '2026-10-20T19:41:00Z'}});

test('a lender who skipped the job is shown as having declined it, not as a computer that will try again', () => {
  assert.equal(waitingCopyVM(queued('approval_skipped'), {circle: 'Weekend projects', zone: 'UTC', lender: 'Sam'}).previousDecision, declined);
  assert.equal(waitingCopyVM(queued('approval_denied'), {circle: 'Weekend projects', zone: 'UTC', lender: 'Sam'}).previousDecision, declined);
  assert.match(waitingCopyVM(queued('sandbox_start_failed'), {circle: 'Weekend projects', zone: 'UTC', lender: 'Sam'}).previousDecision, /couldn’t start it; it’s open again/);
});

const neverStarted = code => ({state: 'failed', attempts_started: 0, current_attempt: {holder: 'lender', state: 'released', execution_started_at: null,
  claimed_at: '2026-10-19T19:42:00Z', lease_expires_at: '2026-10-19T19:44:00Z', generation: 3, attempt_id: 'x', reason: JSON.stringify({code})}});

test('a job the coordinator ended after its start failures says it could not start, whatever the last code was', () => {
  for (const code of ['sandbox_start_failed', 'agent_signed_out', 'execution_failed', 'host_disk_low', 'preparation_timeout', 'isolation_check_failed']) {
    const view = jobStatusVM(neverStarted(code), {role: 'sent', lender: 'Sam'});
    assert.equal(view.key, 'failed', code);
    assert.equal(view.headline, 'This job couldn’t start', code);
    assert.equal(view.text, 'It tried several times and gave up. Nothing ran.', code);
    assert.doesNotMatch(view.headline + view.text, /Sam|Waiting|attempt|lease|settled|verdict|receipt|Ran on|agent couldn|signed out|disk|isolation/i, code);
  }
});

test('the lender reads the same outcome about its own computer', () => {
  const view = jobStatusVM(neverStarted('agent_signed_out'), {role: 'ran', lender: 'Sam'});
  assert.equal(view.headline, 'Your computer couldn’t start this job');
  assert.equal(view.text, 'It tried several times and gave up. Nothing ran.');
});

test('a failure after the agent started keeps its own copy', () => {
  const started = {state: 'failed', attempts_started: 1, current_attempt: {holder: 'lender', state: 'failed', execution_started_at: '2026-10-19T19:43:00Z',
    claimed_at: '2026-10-19T19:42:00Z', lease_expires_at: '2026-10-19T19:44:00Z', generation: 3, attempt_id: 'x', reason: JSON.stringify({code: 'execution_failed', phase: 'run'})}};
  const view = jobStatusVM(started, {role: 'sent', lender: 'Sam'});
  assert.equal(view.headline, 'The agent couldn\'t finish.');
});
