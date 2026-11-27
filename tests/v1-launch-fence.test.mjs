import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {statusMessage} from '../lib/v1/cli.mjs';
import {adaptLegacyJob} from '../lib/v1/state-projection.mjs';
import {lendingBlockers} from '../lib/v1/blockers.mjs';

// A start the coordinator authorized but never saw begin: the attempt ended, and nothing shows the run stopped.
const fencedJob = (extra = {}) => ({
  state: 'claimed', job_digest: 'sha256:' + 'b'.repeat(64), approval: 'approved',
  expiry: Date.parse('2026-10-20T14:00:00Z') / 1000,
  current_attempt: {attempt_id: '11111111-1111-4111-8111-111111111111', job_digest: 'sha256:' + 'b'.repeat(64), generation: 1,
    holder: 'sha256:' + 'c'.repeat(64), state: 'released', claimed_at: '2026-10-20T11:55:00Z',
    lease_expires_at: '2026-10-20T12:05:00Z', execution_started_at: '2026-10-20T12:01:00Z', execution_observed_at: null,
    reason: 'lease_expired', compute_stopped: false, stopped_at: null},
  ...extra,
});

test('a fenced launch is waiting, not approved, and carries the time its run can no longer be going', () => {
  const view = adaptLegacyJob(fencedJob());
  assert.equal(view.phase, 'waiting');
  assert.equal(view.evidence.launchFenceUntil, '2026-10-20T14:00:00.000Z');
  assert.equal(view.evidence.waitingExplanation, 'Waiting for the lender to confirm the last try stopped.');
});

test('the fence bound uses the wall-clock limit from the signed job when the job carries one', () => {
  const job = fencedJob({signed: {payload: {requirements: {limits: {wall_seconds: 600}}}}});
  // lease end 12:05:00 + 600 s wall + 300 s lease allowance = 12:20:00
  assert.equal(adaptLegacyJob(job).evidence.launchFenceUntil, '2026-10-20T12:20:00.000Z');
});

test('a launch that was observed is not fenced and has no retry time', () => {
  const job = fencedJob();
  job.current_attempt.execution_observed_at = '2026-10-20T12:01:05Z';
  const view = adaptLegacyJob(job);
  assert.notEqual(view.phase, 'waiting');
  assert.equal(view.evidence.launchFenceUntil, undefined);
});

test('the blocker model shows a fenced launch as a waits row whose time is the bound', () => {
  const model = lendingBlockers({docker: {installed: true, running: true, signedIn: true},intent: {on: true},launchFence: {until: '2:00 PM'}});
  const row = model.items.find(item => item.key === 'launch_fence');
  assert.deepEqual([row.status, row.time], ['waits', '2:00 PM']);
  assert.equal(row.detail, 'Waiting to confirm the earlier run stopped; it retries by itself at 2:00 PM.');
  assert.notEqual(model.first?.key, 'launch_fence', 'a waits row never becomes the blocker shown first');
});

test('the blocker model has no launch row without a fence', () => {
  const model = lendingBlockers({docker: {installed: true, running: true, signedIn: true},intent: {on: true}});
  assert.equal(model.items.some(item => item.key === 'launch_fence'), false);
});

test('CLI fenced status names the earlier run and its retry time', () => {
  const expected = 'Waiting to confirm the earlier run stopped; it retries by itself at Oct 20, 2026, 2:00 PM.';
  assert.equal(statusMessage(fencedJob(), {timeZone:'UTC'}), expected);
  assert.equal(statusMessage({jobProjection:adaptLegacyJob(fencedJob())}, {timeZone:'UTC'}), expected);
});
