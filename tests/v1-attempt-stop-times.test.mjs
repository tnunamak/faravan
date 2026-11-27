import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext, runInThisContext} from 'node:vm';
import {MEASURED_POSTING_LAG_MS} from '../lib/v1/lending-rule-defaults.mjs';
import {RESET_JITTER_MS} from '../lib/v1/window-origin.mjs';
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

async function rig(t, state = oldState()) {
  // Dynamic import keeps the pure projections independently runnable in a read-scoped workspace.
  const {createPace50Adapter} = await import('../lib/v1/lending-pace50-adapter.mjs');
  const directory = fs.mkdtempSync(join(tmpdir(), 'attempt-stop-times-'));
  const file = join(directory, 'lending-pace50-state.json');
  fs.writeFileSync(file, JSON.stringify(state));
  const effects = {arm_cessation_deadline: async () => () => {}, launch_chunk: async () => {},
    open_short_window: async () => {}, cancel_pending_attempt: async () => {},
    request_cessation: async () => {}, request_fresh_complete_reconciliation: async () => {}};
  const adapters = [];
  const open = () => {
    const adapter = createPace50Adapter({directory, account: state.account, account_week_id: state.account_week_id,
      buildInput: async () => { throw new Error('stop evidence must not request admission'); }, effects, now: () => 1300});
    adapters.push(adapter);
    return adapter;
  };
  t.after(async () => {
    for (const adapter of adapters) await adapter.close();
    fs.rmSync(directory, {recursive: true, force: true});
  });
  return {adapter: open(), open, file};
}
const stopEvent = {type: 'owner_stop', event_id: 'attempt-1:owner-stop', at: 1100, attempt_id: 'attempt-1'};
const cleanupEvent = {type: 'cleanup_proven', event_id: 'attempt-1:cleanup-proven:3', at: 1200,
  attempt_id: 'attempt-1', cleanup_removed: true};

// Scope-limited witnesses execute the actual pure durable transition and its validators.
// No imported dependency is replaced. These do not claim adapter/fsync/restart coverage.
function durablePolicyWitness() {
  const source = fs.readFileSync(new URL('../lib/v1/lending-policy.mjs', import.meta.url), 'utf8');
  const begin = source.indexOf("const PACE50_VERSION=");
  const end = source.indexOf('function refusePace50(', begin);
  assert.ok(begin >= 0 && end > begin);
  const body = source.slice(begin, end).replace(/^export (?=function |const )/gm, '');
  return runInThisContext(`(function(RESET_JITTER_MS,MEASURED_POSTING_LAG_MS){${body}; return {transitionEstimatedPace50State, validPace50State};})`)(RESET_JITTER_MS,MEASURED_POSTING_LAG_MS);
}

test('source witness: accepted Stop and cleanup metadata preserve every ledger number', () => {
  const {transitionEstimatedPace50State: transition, validPace50State: valid} = durablePolicyWitness();
  const state = oldState(), before = structuredClone(state.attempts[0].resources);
  assert.equal(valid(state), true);
  const stopped = transition(state, stopEvent);
  assert.equal(stopped.applied, true);
  assert.equal(valid(stopped.state), true);
  assert.deepEqual(stopped.state.attempts[0].owner_stop,
    {event_id: stopEvent.event_id, requested_at: 1100, durable_intent_recorded: true});
  assert.deepEqual(stopped.state.attempts[0].resources, before);
  const cleaned = transition(stopped.state, cleanupEvent);
  assert.equal(cleaned.applied, true);
  assert.equal(valid(cleaned.state), true);
  assert.equal(cleaned.state.attempts[0].cleanup_proof_persisted_at, 1200);
  assert.deepEqual(cleaned.state.attempts[0].resources, before);
  assert.equal(cleaned.state.attempts[0].hold_closed, false);
  assert.deepEqual(state, oldState(), 'transitions do not mutate their input');
});

test('source witness: old JSON state validates and late acknowledgement clears only the new time', () => {
  const {transitionEstimatedPace50State: transition, validPace50State: valid} = durablePolicyWitness();
  const legacy = JSON.parse(JSON.stringify(oldState()));
  assert.equal(valid(legacy), true);
  const cleaned = transition(legacy, cleanupEvent);
  const late = transition(cleaned.state, {type: 'late_ack', event_id: 'attempt-1:late', at: 1250, attempt_id: 'attempt-1'});
  assert.equal(late.applied, true);
  assert.equal(valid(late.state), true);
  assert.equal(late.state.attempts[0].cleanup_proof_persisted_at, null);
  assert.equal(stopCessationEvidence({attempt: late.state.attempts[0]}).cessation.ceased_at, null);
});

test('source witness: duplicate/refused Stop and cleanup cannot invent or replace timestamps', () => {
  const {transitionEstimatedPace50State: transition} = durablePolicyWitness();
  const state = oldState();
  const rejected = transition(state, {...stopEvent, attempt_id: 'missing'});
  assert.equal(rejected.applied, false);
  assert.equal(rejected.state.attempts[0].owner_stop, undefined);
  const stopped = transition(state, stopEvent);
  const repeated = transition(stopped.state, {...stopEvent, at: 1199});
  assert.equal(repeated.applied, false);
  assert.equal(repeated.state.attempts[0].owner_stop.requested_at, 1100);
  const rejectedProof = transition(stopped.state, {...cleanupEvent, cleanup_removed: false});
  assert.equal(rejectedProof.applied, false);
  assert.equal(rejectedProof.state.attempts[0].cleanup_proof_persisted_at, undefined);
});

test('owner Stop time and event id survive a new adapter on the same durable state', async t => {
  const r = await rig(t);
  const before = r.adapter.state().attempts[0].resources;
  assert.equal((await r.adapter.deliver(stopEvent)).applied, true);
  await r.adapter.close();
  const restarted = r.open();
  const attempt = restarted.state().attempts[0];
  const evidence = stopCessationEvidence({attempt});
  assert.deepEqual(evidence.stop_request, {event_id: stopEvent.event_id, requested_at: 1100, durable_intent_recorded: true});
  assert.deepEqual(attempt.resources, before, 'Stop metadata changes no ledger number');
  assert.equal(evidence.accepted_is_cessation, false);
  assert.equal(evidence.cessation.observed, false);
  assert.equal(evidence.cessation.ceased_at, null);
});

test('cleanup proof persists ceased_at with its source without settling or releasing exposure', async t => {
  const r = await rig(t);
  const before = r.adapter.state().attempts[0].resources;
  assert.equal((await r.adapter.deliver(stopEvent)).applied, true);
  assert.equal((await r.adapter.deliver(cleanupEvent)).applied, true);
  await r.adapter.close();
  const attempt = r.open().state().attempts[0];
  const evidence = stopCessationEvidence({attempt});
  assert.equal(attempt.cleanup_proof_persisted_at, 1200);
  assert.equal(evidence.cessation.ceased_at, 1200);
  assert.equal(evidence.cessation.ceased_at_source, 'durable_cleanup_proof');
  assert.equal(evidence.cessation.ceased_at_reason, null);
  assert.equal(evidence.cessation.observed, true);
  assert.equal(evidence.cessation.hold_closed, false);
  assert.equal(evidence.accepted_is_cessation, false);
  assert.deepEqual(attempt.resources, before);
});

test('a pre-change state file loads and keeps both absent timestamps unknown', async t => {
  const state = oldState();
  state.updated_at = 1200;
  state.revision = 2;
  state.event_ids = [cleanupEvent.event_id];
  Object.assign(state.attempts[0], {process_state: 'ceased', cessation_proven: true, cleanup_proven: true, hold_closed: false});
  const r = await rig(t, state);
  assert.deepEqual(r.adapter.state(), state, 'loading does not migrate or invent old evidence');
  const evidence = stopCessationEvidence({attempt: r.adapter.state().attempts[0]});
  assert.equal(evidence.stop_request, null);
  assert.equal(evidence.cessation.requested_at, null);
  assert.equal(evidence.cessation.ceased_at, null);
  assert.equal(evidence.cessation.ceased_at_source, null);
  assert.equal(evidence.cessation.ceased_at_reason, 'durable_state_keeps_no_cessation_time');
});

test('a late acknowledgement invalidates the previous cleanup timestamp', async t => {
  const r = await rig(t);
  await r.adapter.deliver(cleanupEvent);
  assert.equal((await r.adapter.deliver({type: 'late_ack', event_id: 'attempt-1:late', at: 1250, attempt_id: 'attempt-1'})).applied, true);
  const attempt = r.adapter.state().attempts[0];
  assert.equal(attempt.cleanup_proof_persisted_at, null);
  assert.equal(attempt.cleanup_proven, false);
  const evidence = stopCessationEvidence({attempt});
  assert.equal(evidence.cessation.ceased_at, null);
  assert.equal(evidence.cessation.ceased_at_source, null);
});

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

test('projection: the production evidence route reads durable Stop after restart and prefers it to memory', async () => {
  const source = fs.readFileSync(new URL('../lib/v1/app.mjs', import.meta.url), 'utf8');
  const begin = source.indexOf("        if(method==='GET'&&parts[1]==='lending'&&parts[2]==='attempts'");
  const end = source.indexOf("        if(method==='GET'&&parts[1]==='lending')return send(", begin);
  assert.ok(begin >= 0 && end > begin);
  const attempt = {...oldState().attempts[0], owner_stop: {event_id: stopEvent.event_id,
    requested_at: 1100, durable_intent_recorded: true}};
  const stops = new Map();
  const route = runInNewContext(`(async function(method,parts){${source.slice(begin, end)}})`, {
    stopCessationEvidence, lendingStopRecords: stops, send: value => value,
    fail: code => { throw new Error(code); }, lendingRuntime: {
      attemptEvidence: attemptId => ({attempt_id: attemptId}), pace50: {state: () => ({attempts: [attempt]})}}});
  const read = () => route('GET', ['api', 'lending', 'attempts', 'attempt-1', 'evidence']);
  assert.deepEqual((await read()).stop_cessation.stop_request, attempt.owner_stop);
  stops.set('attempt-1', {event_id: 'attempt-1:memory-stop', requested_at: 1299, durable_intent_recorded: false});
  assert.deepEqual((await read()).stop_cessation.stop_request, attempt.owner_stop);
  delete attempt.owner_stop;
  assert.deepEqual((await read()).stop_cessation.stop_request, stops.get('attempt-1'));
});
