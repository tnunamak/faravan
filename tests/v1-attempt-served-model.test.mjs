import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {attemptEvidenceFromState, buildAttemptEvidence, mergeServedModelEvidence, observeServedModel, servedModelEvidence} from '../lib/v1/attempt-evidence.mjs';
import {parseClaudeStream} from '../lib/v1/lending-meter.mjs';

const requested = 'claude-haiku-5-5';
const stream = model => JSON.stringify({type: 'system', subtype: 'init', model}) + '\n' +
  JSON.stringify({type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0});
const oldState = () => ({version: 'objective-lending/state/4', account: 'synthetic-account', account_week_id: 'week-1',
  revision: 1, updated_at: 100, mode: 'on', owner_present: false, owner_absent_since: null,
  opening_tokens: [{account_week_id: 'week-1', status: 'unused', attempt_id: null}], opened_windows: [], event_ids: [],
  attempts: [{id: 'attempt-1', account: 'synthetic-account', account_week_id: 'week-1', epoch: 'epoch-1', job_id: 'job-1',
    created_at: 100, wall_ms: 1000, stop_ms: 0, uncertainty_ms: 0, launch_state: 'started', process_state: 'running',
    cessation_proven: false, cleanup_proven: false, usage_unknown: null, late_ack_unresolved: false, late_ack_events: [],
    opening: null, recoveries: [], resources: [{id: 'five_hour', instance: 'window-1', epoch: 'epoch-1', kind: 'short',
      anchor_at: 0, resets_at: 18_000_000, duration_ms: 18_000_000, baseline_used_micro: 100, kappa_micro: 1,
      aggregate_observed_at: 100, aggregate_used_micro: 100, initial_micro: 1000, spent_micro: 0, settled_micro: 0,
      held_micro: 1000, released_micro: 0, unrepresented_micro: 0, burns: []}]}]});
const project = metadata => {
  const state = oldState();
  if (metadata !== undefined) state.attempts[0].served_model = metadata;
  return attemptEvidenceFromState(JSON.parse(JSON.stringify(state)), 'attempt-1').served_model;
};
const observed = extras => observeServedModel({model: requested, effort: 'low', ...extras});
const assertUnknownEffort = evidence => {
  assert.equal(evidence.effort_requested, 'low');
  assert.equal(evidence.effort_served, 'unknown');
  assert.equal(evidence.effort_served_reason, 'provider_does_not_report_effort');
};

test('pure: guard model wins over stream and survives durable JSON projection', () => {
  const value = observed({observation: {model: 'guard-model', effort: 'high'}, parsed: {model: 'stream-model', effort: 'high'}});
  assert.deepEqual(project(value), {requested, effort_requested: 'low', served: 'guard-model', source: 'guard', reason: null,
    effort_served: 'unknown', effort_served_reason: 'provider_does_not_report_effort'});
});

test('pure: real stream parser supplies served model when guard has no model', () => {
  const parsed = parseClaudeStream(stream('stream-model'));
  const value = project(observed({observation: {model: null}, parsed}));
  assert.equal(value.served, 'stream-model');
  assert.equal(value.source, 'stream');
  assert.equal(value.reason, null);
  assertUnknownEffort(value);
});

test('pure: requested fallback is never reported as served', () => {
  const value = project(observed({parsed: parseClaudeStream('')}));
  assert.equal(value.requested, requested);
  assert.equal(value.served, null);
  assert.equal(value.source, 'unknown');
  assert.equal(value.reason, 'no_source_reported_model');
  assertUnknownEffort(value);
});

test('pure: old state with no additive block projects unknown without mutation', () => {
  const state = oldState(), original = structuredClone(state);
  const evidence = attemptEvidenceFromState(JSON.parse(JSON.stringify(state)), 'attempt-1');
  assert.deepEqual(evidence.served_model, {requested: null, effort_requested: null, served: null, source: 'unknown',
    reason: 'not_recorded', effort_served: 'unknown', effort_served_reason: 'provider_does_not_report_effort'});
  assert.deepEqual(state, original);
});

test('pure: untrusted or unlabelled model/effort claims do not become served facts', () => {
  const invalid = project(observed({observation: {model: 'sk-secret'}, parsed: {model: 'stream-model'}}));
  assert.equal(invalid.served, null);
  assert.equal(invalid.source, 'unknown');
  assert.equal(invalid.reason, 'invalid_reported_model');
  assert.equal(JSON.stringify(invalid).includes('sk-secret'), false);
  const forged = servedModelEvidence({requested, served: requested, source: 'requested', effort_served: 'low'});
  assert.equal(forged.served, null);
  assert.equal(forged.source, 'unknown');
  assert.equal(forged.effort_served, 'unknown');
});

test('pure: valid served evidence is independent of final usage and requested model equality', () => {
  const value = observed({observation: {model: requested, final: false}});
  assert.equal(value.served, requested);
  assert.equal(value.source, 'guard');
  assertUnknownEffort(value);
  assert.equal(observeServedModel({observation: {model: 'guard-model', effort: 'high'}}).effort_requested, null);
});

test('pure: adding model evidence changes none of the four numeric/accounting columns', () => {
  const state = oldState(), before = attemptEvidenceFromState(state, 'attempt-1');
  state.attempts[0].served_model = observed({observation: {model: 'guard-model'}});
  const after = attemptEvidenceFromState(state, 'attempt-1');
  delete before.served_model; delete after.served_model;
  assert.deepEqual(after, before);
  assert.equal(buildAttemptEvidence({guard_estimate: {model: requested}}).served_model.served, null,
    'a priced estimate is not a served-model source');
});

test('pure: retries preserve known requested fields and never downgrade served provenance', () => {
  const first = observed({observation: {model: 'guard-model'}}), saved = structuredClone(first);
  const empty = observeServedModel({});
  assert.deepEqual(mergeServedModelEvidence(first, empty), first);
  const weaker = observeServedModel({model: 'different-request', effort: 'high', parsed: {model: 'stream-model'}});
  assert.deepEqual(mergeServedModelEvidence(first, weaker), first);
  assert.deepEqual(first, saved);
});

test('pure: retries fill missing effort and upgrade unknown to stream to guard idempotently', () => {
  const admitted = observeServedModel({model: requested});
  const streamed = mergeServedModelEvidence(admitted, observed({parsed: {model: 'stream-model'}}));
  assert.equal(streamed.effort_requested, 'low');
  assert.equal(streamed.source, 'stream');
  const guarded = mergeServedModelEvidence(streamed, observeServedModel({observation: {model: 'guard-model'}}));
  assert.equal(guarded.source, 'guard');
  assert.equal(guarded.requested, requested);
  assert.equal(guarded.effort_requested, 'low');
  assert.deepEqual(mergeServedModelEvidence(guarded, guarded), guarded);
  assert.equal(mergeServedModelEvidence(guarded, observed({observation: {model: 'final-guard-model'}})).served, 'final-guard-model');
});

// These owner-run integration cases use the actual scoped lender/policy/adapter.
// The scope-limited worker runs --test-name-pattern='^pure:' rather than loading
// their excluded transitive dependencies or replacing those dependencies.
