import {mount, teardown} from './mounted.test-helper.mjs';
import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {JobThreadPanel} from './job-thread.jsx';

afterEach(teardown);

// The authoritative projection: a stop was requested and is not confirmed. The job's raw state is still 'cancelled'.
const stopRequested = {schemaVersion: 2, kind: 'job', phase: 'stopping', reasonCode: 'stop_unconfirmed',
  result: {available: false, digest: null}, application: {outcome: null, appliedBranch: null},
  evidence: {rawState: 'cancelled', attemptPresent: true, approval: 'approved', approvedAt: '2026-10-20T11:00:00Z',
    executionStartedAt: '2026-10-20T11:19:00Z', computeStopped: false},
  version: {}, times: {observedAt: '2026-10-20T11:30:00Z', validUntil: null, nextTransitionAt: null}, actionHints: []};

test('a thread job cancelled before its stop is confirmed says Stop requested, not Cancelled, when mounted', async () => {
  const currentJob = {job_digest: 'sha256:current', title: 'Follow-up', submittedAt: '2026-10-20T11:50:00Z', state: 'cancelled',
    current_attempt: {attempt_id: 'attempt-2', generation: 2, state: 'running', execution_started_at: '2026-10-20T11:19:00Z', compute_stopped: false},
    jobProjection: stopRequested};
  const thread = [{job_digest: 'sha256:parent', title: 'Original', submittedAt: '2026-10-20T11:00:00Z',
    runs: [{attempt_id: 'attempt-1', generation: 1, state: 'completed', result_digest: 'result-1'}]}];
  const view = await mount(h(JobThreadPanel, {threadData: {thread}, circleId: 'c1', currentJob}));
  assert.match(view.text(), /This job/);
  assert.match(view.text(), /Run 2 · Stop requested/);
  assert.match(view.text(), /Run 1 · Ready to review/);
  assert.doesNotMatch(view.text(), /Cancelled/);
});
