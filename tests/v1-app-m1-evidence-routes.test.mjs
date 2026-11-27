import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {stopCessationEvidence} from '../lib/v1/attempt-evidence.mjs';
import {requestedBudget} from '../lib/v1/cli.mjs';

// Route-level tests: the production route text is extracted from app.mjs and run against controlled
// runtime doubles. No server, provider, browser, timer, sandbox or file is touched.
const source = await readFile(new URL('../lib/v1/app.mjs', import.meta.url), 'utf8');
function extract(begin, end) {
  const from = source.indexOf(begin);
  const to = from >= 0 ? source.indexOf(end, from) : -1;
  assert.ok(from >= 0 && to > from, `extract route starting ${begin.trim()}`);
  return source.slice(from, to);
}
// Extracted per call, so one missing route fails only the tests that use it.
const stopRoute = () => extract("            if(parts[2]==='stop') {", "            if(parts[2]==='requester-limits'");
const previewRoute = () => extract("            if(parts[2]==='preview'&&parts.length===3) {", "            if(parts[2]==='owner-settings') {");
const evidenceRoute = () => extract("        if(method==='GET'&&parts[1]==='lending'&&parts[2]==='attempts'",
  "        if(method==='GET'&&parts[1]==='lending')return send(");

const json = value => JSON.parse(JSON.stringify(value));
const fail = (code, status = 400) => { throw Object.assign(new Error(code), {code, status}); };
const send = value => value;
const runEvidence = context => runInNewContext(`(async function(method,parts){${evidenceRoute()}})`, {fail, send, stopCessationEvidence, ...context});
const runPreview = context => {
  const route = runInNewContext(`(async function(input,parts){${previewRoute()}})`, {fail, send, requestedBudget, ...context});
  return input => route(input, ['api', 'lending', 'preview']);
};
const runStop = context => {
  const route = runInNewContext(`(async function(input,parts){${stopRoute()}})`, {fail, send, ...context});
  return input => route(input, ['api', 'lending', 'stop']);
};
const readEvidence = (context, attemptId) => runEvidence(context)('GET', ['api', 'lending', 'attempts', attemptId, 'evidence']);

test('evidence route returns the runtime record with its cessation link, and 404 for an unknown attempt', async () => {
  const record = {schema_version: 1, attempt_id: 'attempt-1', column_4: {classification: 'unknown', actual_usd: null}};
  const attempts = [{id: 'attempt-1', process_state: 'running', cessation_proven: false, cleanup_proven: false, hold_closed: null}];
  const context = {lendingStopRecords: new Map(), lendingRuntime: {
    attemptEvidence: id => id === 'attempt-1' ? structuredClone(record) : null,
    pace50: {state: () => ({attempts})},
  }};
  const body = json(await readEvidence(context, 'attempt-1'));
  assert.equal(body.column_4.classification, 'unknown');
  assert.equal(body.column_4.actual_usd, null);
  assert.equal(body.stop_cessation.accepted_is_cessation, false);
  assert.equal(body.stop_cessation.stop_request, null);
  assert.equal(body.stop_cessation.cessation.observed, false);
  assert.equal(body.stop_cessation.cessation.process_state, 'running');
  await assert.rejects(readEvidence(context, 'unknown'), {code: 'not_found', status: 404});
  await assert.rejects(runEvidence({...context, lendingRuntime: null})('GET',
    ['api', 'lending', 'attempts', 'attempt-1', 'evidence']), {code: 'not_found', status: 404});
});

test('accepted Stop is linked to the durable cessation state and is never reported as cessation by itself', async () => {
  const attempts = [{id: 'attempt-1', process_state: 'running', cessation_proven: false, cleanup_proven: false, hold_closed: null}];
  const intents = [];
  const stops = new Map();
  const lenderState = {current: 'attempt-1', currentJobs: [{attemptId: 'attempt-1'}]};
  const adapter = {state: () => ({mode: 'on', event_ids: intents.map(intent => intent.event_id), attempts})};
  const stopContext = {
    lendingRuntime: {pace50: adapter, candidate: {ownerStop: async ({attemptId, event_id, at}) => {
      intents.push({attemptId, event_id, at});
      attempts[0].process_state = 'cessation_requested';
      return {applied: true, reason: 'applied'};
    }}},
    lendingStopRecords: stops, lenderStoppedJob: null, stopReceipt: null, stopFlights: new Map(), safetyEpoch: 0, safetyIntentEpoch: 0,
    settings: {enabled: true, intent: 'on'}, policy: {enabled: true},
    runningJobView: async () => ({requester: 'synthetic-person'}), now: () => 42,
    save: async () => {}, emit: () => {}, readinessChanged: () => {}, lendingView: () => ({enabled: false}),
    lender: {getState: () => lenderState, stopCurrentJob: async id => {
      assert.equal(id, 'attempt-1');
      lenderState.current = null;
      lenderState.currentJobs = [];
    }},
  };
  await runStop(stopContext)({attemptId: 'attempt-1', confirmed: true});
  assert.deepEqual(intents, [{attemptId: 'attempt-1', event_id: 'attempt-1:owner-stop', at: 42}]);
  assert.deepEqual(json(stops.get('attempt-1')),
    {event_id: 'attempt-1:owner-stop', requested_at: 42, durable_intent_recorded: true});

  const evidenceContext = {lendingStopRecords: stops, lendingRuntime: {
    attemptEvidence: id => ({attempt_id: id, column_4: {classification: 'unknown', actual_usd: null}}),
    pace50: adapter,
  }};
  const requested = json(await readEvidence(evidenceContext, 'attempt-1')).stop_cessation;
  assert.equal(requested.accepted_is_cessation, false);
  assert.deepEqual(requested.stop_request, {event_id: 'attempt-1:owner-stop', requested_at: 42, durable_intent_recorded: true});
  assert.equal(requested.cessation.observed, false, 'a cessation_requested process is not ceased');
  assert.equal(requested.cessation.requested_at, 42);
  assert.equal(requested.cessation.ceased_at, null);
  assert.equal(requested.cessation.ceased_at_reason, 'not_ceased');

  Object.assign(attempts[0], {process_state: 'ceased', cessation_proven: true, hold_closed: true});
  const ceased = json(await readEvidence(evidenceContext, 'attempt-1')).stop_cessation;
  assert.equal(ceased.cessation.observed, true);
  assert.equal(ceased.cessation.hold_closed, true);
  assert.equal(ceased.cessation.ceased_at, null, 'the durable engine keeps no cessation time, so none is invented');
  assert.equal(ceased.cessation.ceased_at_reason, 'durable_state_keeps_no_cessation_time');
  assert.equal(ceased.accepted_is_cessation, false);
});

test('offer-only preview asks the admission gate and touches nothing else', async () => {
  const offers = [];
  const runtime = new Proxy({
    previewAdmission: async offer => {
      offers.push(offer);
      return {admitted: false, reason: 'objective_evidence_unknown', resource: 'claude', model: 'claude-x', effort: 'low', inputs: null};
    },
  }, {get(target, key) {
    if (key in target) return target[key];
    throw new Error(`preview touched runtime.${String(key)}`);
  }});
  const settings = {modes: {c: 'auto'}, intent: 'on'};
  const settingsBefore = JSON.stringify(settings);
  let saves = 0;
  const context = {lendingRuntime: runtime, settings, save: async () => { saves += 1; }};
  const out = json(await runPreview(context)({jobId: 'job-1', provider: 'claude', model: 'claude-x',
    budget_v1: {max_list_usd: 5, effort: 'low'}, deadline: '2026-10-27T00:00:00Z', estimatedWallMs: 60000}));
  assert.deepEqual(out, {admitted: false, reason: 'objective_evidence_unknown', resource: 'claude', model: 'claude-x', effort: 'low', inputs: null});
  assert.deepEqual(json(offers), [{jobId: 'job-1', provider: 'claude', model: 'claude-x',
    job: {id: 'job-1', budget_v1: {max_list_usd: 5, effort: 'low'}},
    deadline: '2026-10-27T00:00:00Z', estimatedWallMs: 60000}]);
  assert.equal(saves, 0, 'preview never writes settings or state');
  assert.equal(JSON.stringify(settings), settingsBefore);
});

test('preview rejects unknown keys and invalid values before the gate is asked', async () => {
  const offers = [];
  const context = {lendingRuntime: {previewAdmission: async offer => { offers.push(offer); return {admitted: false}; }}};
  const run = runPreview(context);
  const valid = {jobId: 'job-1', provider: 'codex'};
  await run(valid);
  assert.equal(offers.length, 1);
  for (const bad of [
    {...valid, ownerAbsent: true},
    {...valid, readings: []},
    {...valid, intentOn: true},
    {...valid, attemptId: 'attempt-1'},
    {jobId: '', provider: 'codex'},
    {jobId: 'job-1', provider: 'gemini'},
    {...valid, model: 7},
    {...valid, deadline: 'not a date'},
    {...valid, estimatedWallMs: 0},
    {...valid, budget_v1: {max_list_usd: 0}},
    {...valid, budget_v1: {effort: 'ultra'}},
    {...valid, budget_v1: {max_list_usd: 5, extra: true}},
  ]) await assert.rejects(run(bad), {code: 'invalid_request', status: 400}, JSON.stringify(bad));
  assert.equal(offers.length, 1, 'no rejected input reaches the gate');
});

test('preview with no pace50 runtime is a 404 and never reaches a gate', async () => {
  await assert.rejects(runPreview({lendingRuntime: null})({jobId: 'job-1', provider: 'claude'}),
    {code: 'pace50_disabled', status: 404});
});
