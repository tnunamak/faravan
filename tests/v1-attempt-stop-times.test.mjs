import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {stopCessationEvidence} from '../lib/v1/attempt-evidence.mjs';

// An old-format durable attempt. No admission, provider or external fixture is needed.
const oldState = () => ({version: 'objective-lending/state/4', account: 'synthetic-account',
  account_week_id: 'synthetic-week', revision: 1, mode: 'on', owner_present: false,
  owner_absent_since: null, updated_at: 1000, event_ids: [], opened_windows: [],
  opening_tokens: [{account_week_id: 'synthetic-week', status: 'unused', attempt_id: null}],
  attempts: [{id: 'attempt-1', account: 'synthetic-account', account_week_id: 'synthetic-week',
    epoch: 'epoch-1', job_id: 'job-1', created_at: 1000, wall_ms: 100, stop_ms: 10, uncertainty_ms: 0,
    launch_state: 'started', process_state: 'running', cessation_proven: false, cleanup_proven: false,
    late_ack_unresolved: false, late_ack_events: [], opening: null, recoveries: [], usage_unknown: null,
    resources: [{id: 'weekly', instance: 'week-1', epoch: 'epoch-1', kind: 'weekly',
      anchor_at: 0, resets_at: 100000, duration_ms: 100000, baseline_used_micro: 0, kappa_micro: 1,
      aggregate_observed_at: 1000, aggregate_used_micro: 0, initial_micro: 100, spent_micro: 0,
      settled_micro: 0, held_micro: 100, released_micro: 0, unrepresented_micro: 0, burns: []}]}]});

const stopEvent = {type: 'owner_stop', event_id: 'attempt-1:owner-stop', at: 1100, attempt_id: 'attempt-1'};

// Scope-limited witnesses execute the actual pure durable transition and its validators.
// No imported dependency is replaced. These do not claim adapter/fsync/restart coverage.

test('projection: no cleanup proof keeps ceased_at null with a reason', () => {
  const attempt = oldState().attempts[0];
  const evidence = stopCessationEvidence({attempt, stop: {event_id: stopEvent.event_id,
    requested_at: 1100, durable_intent_recorded: true}});
  assert.equal(evidence.accepted_is_cessation, false);
  assert.equal(evidence.cessation.ceased_at, null);
  assert.equal(evidence.cessation.ceased_at_source, null);
  assert.equal(evidence.cessation.ceased_at_reason, 'not_ceased');
  assert.equal(evidence.cessation.requested_at, 1100);
});

test('projection: durable Stop wins over memory and absence retains the compatibility fallback', () => {
  const durable = {event_id: 'attempt-1:owner-stop', requested_at: 1100, durable_intent_recorded: true};
  const fallback = {event_id: 'attempt-1:memory-stop', requested_at: 1299, durable_intent_recorded: false};
  const attempt = {...oldState().attempts[0], owner_stop: durable};
  assert.deepEqual(stopCessationEvidence({attempt, stop: fallback}).stop_request, durable);
  delete attempt.owner_stop;
  assert.deepEqual(stopCessationEvidence({attempt, stop: fallback}).stop_request, fallback);
  assert.equal(stopCessationEvidence({attempt}).stop_request, null);
});

test('projection: cleanup-proof time is not a process exit time or Stop acceptance', () => {
  const attempt = {...oldState().attempts[0], process_state: 'ceased', cessation_proven: true,
    cleanup_proven: true, cleanup_proof_persisted_at: 1200, hold_closed: false};
  const before = structuredClone(attempt);
  const evidence = stopCessationEvidence({attempt});
  assert.equal(evidence.cessation.ceased_at, 1200);
  assert.equal(evidence.cessation.ceased_at_source, 'durable_cleanup_proof');
  assert.equal(evidence.cessation.ceased_at_reason, null);
  assert.equal(evidence.accepted_is_cessation, false);
  assert.deepEqual(attempt, before, 'projection is read-only');
  attempt.cleanup_proven = false;
  assert.equal(stopCessationEvidence({attempt}).cessation.ceased_at, null, 'an invalidated proof cannot supply a time');
});

test('projection: legacy ceased state stays unknown and invalid timestamps are not exposed', () => {
  const attempt = {...oldState().attempts[0], process_state: 'ceased', cessation_proven: true, cleanup_proven: true};
  assert.equal(stopCessationEvidence({attempt}).cessation.ceased_at, null);
  assert.equal(stopCessationEvidence({attempt}).cessation.ceased_at_source, null);
  assert.equal(stopCessationEvidence({attempt}).cessation.ceased_at_reason, 'durable_state_keeps_no_cessation_time');
  for (const time of [-1, NaN, Infinity, '1200']) {
    attempt.cleanup_proof_persisted_at = time;
    assert.equal(stopCessationEvidence({attempt}).cessation.ceased_at, null);
  }
});
