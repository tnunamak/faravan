import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMeasurementHistory} from '../lib/v1/event-history.mjs';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {normalizeLendingPolicy} from '../lib/v1/lending-policy.mjs';
import {ACCOUNT, NOW, WEEK, MICRO, ordinaryInput} from './helpers/pace50-fixtures.mjs';

const offer = () => ({id: 'synthetic-offer', resource: 'claude', model: 'claude-haiku-4-5',
  budget_v1: {max_list_usd: 10, effort: 'low'}, expires_at: new Date(NOW + 3_600_000).toISOString(),
  requirements: {limits: {wall_seconds: 300}}, prompt: 'NOT-FOR-EXPORT'});
const readings = (used = 20) => ({windows: ['weekly', 'short'].map(window_id =>
  ({window_id, used_pct: used, observed_at: NOW, state: 'open'}))});
const settings = {enabled: true, intent: 'on', activeCircle: 'fixture', modes: {fixture: 'auto'},
  limits: {lendingPolicy: normalizeLendingPolicy({accountPlans: {claude: 'max20'}, providerConsent: {claude: true}})}};

function bytes(directory) {
  const entries = [];
  function visit(path, relative) {
    for (const name of fs.readdirSync(path).sort()) {
      const child = join(path, name), key = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(child);
      if (stat.isSymbolicLink()) entries.push([key, 'symlink', fs.readlinkSync(child)]);
      else if (stat.isDirectory()) { entries.push([key, 'directory']); visit(child, key); }
      else entries.push([key, fs.readFileSync(child).toString('base64')]);
    }
  }
  visit(directory, '');
  return entries;
}

async function setup(t, {used = 20, production = false} = {}) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'admission-preview-'));
  const calls = {live: 0, presence: 0, origins: 0, effects: 0};
  const input = ordinaryInput({now: NOW});
  input.windows = input.windows.map(window => ({...window, used_micro: used * MICRO}));
  const observation = {refresh_succeeded: true, complete: true, identity: {verified: true, account_id: ACCOUNT},
    account_week_id: WEEK, epoch: 'epoch-1', weekly_resource_id: 'weekly', resources: input.windows,
    funding: {subscription_only: 'proven'}, executor: {single_executor: 'proven'},
    stop: {bounded_execution: 'proven'}, stop_bound_ms: 60_000, uncertainty_ms: 30_000};
  const effects = Object.fromEntries(['arm_cessation_deadline', 'launch_chunk', 'open_short_window',
    'cancel_pending_attempt', 'request_cessation', 'request_fresh_complete_reconciliation'].map(name =>
    [name, async () => { calls.effects++; return () => {}; }]));
  const source = {stopBoundMs: 60_000, uncertaintyMs: 30_000,
    observe: async () => { calls.live++; return observation; }};
  const buildInput = ({request, context}) => {
    const out = structuredClone(input);
    out.controls.owner_absent = context.ownerAbsent;
    out.controls.on = context.intent === 'on';
    out.objective.job.requestedUsdMicro = request.requested_usd_micro;
    out.objective.ownerMaxJobUsdMicro = request.owner_max_job_usd_micro;
    return out;
  };
  const measurementHistory = createMeasurementHistory({directory:join(directory,'history')});
  const runtime = createLendingRuntime({directory, now: () => NOW, settings: () => settings,
    presence: () => { calls.presence++; return false; },
    readOverride: () => { throw new Error('live meter must not be touched'); },
    backend: new Proxy({}, {get() { throw new Error('backend must not be touched'); }}),
    pace50: {account: ACCOUNT, account_week_id: WEEK, source, effects, readOnlyPreview: true, measurementHistory,
      ...(production ? {objectiveInputFor: () => structuredClone(input.objective),
        windowOrigins: {observeOpen() { calls.origins++; }, originFor() { return 'owner'; }}} : {buildInput})}});
  t.after(async () => { await runtime.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  await runtime.pace50.transition({type: 'on', event_id: 'fixture-on', at: NOW}, {expectedRevision: 0});
  await runtime.pace50.transition({type: 'owner_absent', event_id: 'fixture-absent', at: NOW},
    {expectedRevision: runtime.pace50.state().revision});
  await measurementHistory.flush();
  return {runtime, directory, calls, input, observation};
}

for (const [label, used, admitted] of [['light', 20, true], ['heavy', 99.999, false]]) {
  test(`preview, real gate, and durable admission agree for ${label} use`, async t => {
    const {runtime} = await setup(t, {used});
    const job = offer(), options = {ownerAbsent: true, readings: readings(used)};
    const preview = await runtime.previewAdmission(job, options);
    const gate = await runtime.manager.admission({provider: 'claude', model: job.model, job, jobId: job.id,
      automatic: true, ownerAbsent: true, intentOn: true});
    const reserved = await runtime.reserve({provider: 'claude', model: job.model, job, jobId: job.id,
      attemptId: `actual-${label}`, automatic: true, ownerAbsent: true, intentOn: true});
    assert.equal(preview.admitted, admitted);
    assert.equal(gate.admitted, preview.admitted);
    assert.equal(reserved.ok, preview.admitted);
    assert.equal(preview.reasonCode, gate.objective.reasonCode);
    assert.equal(preview.reasonText, gate.objective.reasonText);
    assert.equal(preview.policyVersion, 'objective/m1');
  });
}

test('preview preserves every state path/byte, caches, inputs, and lifecycle without effects', async t => {
  const {runtime, directory, calls, input} = await setup(t);
  fs.mkdirSync(join(directory, 'existing'));
  fs.writeFileSync(join(directory, 'existing', 'sentinel.bin'), Buffer.from([0, 255, 1, 10]));
  const before = bytes(directory), state = runtime.pace50.state(), fixture = readings();
  const job = offer(), original = structuredClone({job, fixture, input});
  const last = runtime.candidate.lastJobDecisionFor('claude');
  const preview = await runtime.previewAdmission(job, {ownerAbsent: true, readings: fixture});
  assert.equal(preview.admitted, true);
  assert.deepEqual(bytes(directory), before);
  assert.deepEqual(runtime.pace50.state(), state);
  assert.equal(runtime.candidate.lastJobDecisionFor('claude'), last);
  assert.equal(runtime.busy(), false);
  assert.deepEqual({job, fixture, input}, original);
  assert.deepEqual(calls, {live: 0, presence: 0, origins: 0, effects: 0});
  assert.equal(preview.inputs.requestedUsdMicro, 10 * MICRO);
  assert.equal(preview.inputs.wallMs, 300_000);
  assert.equal(preview.inputs.stopMs, 60_000);
  assert.equal(preview.inputs.uncertaintyMs, 30_000);
  assert.equal(preview.effort, 'low');
  assert.ok(!JSON.stringify(preview).includes('NOT-FOR-EXPORT'));
  assert.ok(!JSON.stringify(preview).includes(ACCOUNT));
});

for (const [label, change] of [
  ['unreadable', row => ({...row, used_pct: null, readable: false})],
  ['future', row => ({...row, observed_at: NOW + 1})],
]) {
  test(`${label} fixture usage holds with objective_usage_unknown without reading live usage`, async t => {
    const {runtime, calls} = await setup(t);
    const fixture = readings();
    fixture.windows[0] = change(fixture.windows[0]);
    const result = await runtime.previewAdmission(offer(), {ownerAbsent: true, readings: fixture});
    assert.equal(result.admitted, false);
    assert.equal(result.reasonCode, 'objective_usage_unknown');
    assert.equal(calls.live, 0);
    assert.equal(calls.effects, 0);
  });
}

// Age is relative to remaining headroom; a fixed one-minute expiry is no longer policy.
test('aged fixture usage consumes headroom without reading live usage', async t => {
  const {runtime, calls} = await setup(t, {used:90});
  const fixture = readings(90);
  assert.equal((await runtime.previewAdmission(offer(), {ownerAbsent:true, readings:fixture})).admitted, true);
  fixture.windows[0].observed_at = NOW - 31 * 60_000;
  const result = await runtime.previewAdmission(offer(), {ownerAbsent:true, readings:fixture});
  assert.equal(result.admitted, false);
  assert.equal(result.reasonCode, 'objective_owner_reserve');
  assert.equal(calls.live, 0);
  assert.equal(calls.effects, 0);
});

test('reaching the reset holds with objective_reset, and a strict earlier finish admits', async t => {
  const {runtime} = await setup(t);
  const fixture = readings();
  fixture.windows[1].resets_at = NOW + 390_000;
  const held = await runtime.previewAdmission(offer(), {ownerAbsent: true, readings: fixture});
  assert.equal(held.admitted, false);
  assert.equal(held.reasonCode, 'objective_reset');
  const shorter = offer();
  shorter.requirements.limits.wall_seconds = 299;
  assert.equal((await runtime.previewAdmission(shorter, {ownerAbsent: true, readings: fixture})).admitted, true);
});

test('production snapshot path never invokes live reader or records window origins', async t => {
  const {runtime, calls, directory, observation} = await setup(t, {production: true});
  const cold = await runtime.previewAdmission(offer(), {ownerAbsent: true, readings: readings()});
  assert.equal(cold.admitted, false);
  assert.equal(cold.reasonCode, 'objective_evidence_unknown');
  assert.equal(calls.live, 0, 'even cold fixtures cannot launch a probe to fill missing trusted evidence');
  await runtime.candidate.observe({provider: 'claude', model: offer().model, plan: 'max20', now: NOW});
  const before = bytes(directory), sourceBefore = structuredClone(observation), countBefore = {...calls};
  const result = await runtime.previewAdmission(offer(), {ownerAbsent: true, readings: readings()});
  assert.equal(result.admitted, true);
  assert.deepEqual(calls, countBefore);
  assert.deepEqual(bytes(directory), before);
  assert.deepEqual(observation, sourceBefore);
});

test('explicit deadline and wall estimate are returned as the exact bounded request inputs', async t => {
  const {runtime} = await setup(t);
  const job = offer();
  delete job.requirements;
  delete job.expires_at;
  job.deadline = NOW + 1_000_000;
  job.estimatedWallMs = 123_000;
  const result = await runtime.previewAdmission(job, {ownerAbsent: true, readings: readings()});
  assert.equal(result.admitted, true);
  assert.equal(result.inputs.wallMs, 123_000);
  assert.equal(result.inputs.expiresAt, NOW + 1_000_000);
});

test('preview includes the real reserve model-enforceability prerequisite without effects', async t => {
  const {runtime, calls} = await setup(t);
  const job = {...offer(), model: 'unpriced-synthetic-model'};
  const preview = await runtime.previewAdmission(job, {ownerAbsent: true, readings: readings()});
  const reserve = await runtime.reserve({provider: 'claude', model: job.model, job, jobId: job.id,
    attemptId: 'unpriced', automatic: true, ownerAbsent: true, intentOn: true});
  assert.equal(preview.admitted, false);
  assert.equal(preview.reason, reserve.policyReason);
  assert.equal(preview.reason, 'model_unpriced');
  assert.equal(calls.effects, 0);
});

test('without explicit startup purity capability preview invokes no unproven callbacks or writes', async t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'admission-preview-capability-'));
  let calls = 0;
  const unproven = () => { calls++; throw new Error('unproven callback invoked'); };
  const runtime = createLendingRuntime({directory, now: () => NOW, settings: () => settings,
    presence: unproven, readOverride: unproven,
    pace50: {account: ACCOUNT, account_week_id: WEEK, buildInput: unproven,
      objectiveInputFor: unproven, history: unproven,
      ownerSettings: {limit: unproven}, presenceOverrides: {available: unproven},
      source: {observe: unproven}}});
  t.after(async () => { await runtime.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  const applicationState = () => bytes(directory).filter(([path]) => !path.startsWith('history/measurements'));
  const before = applicationState();
  const result = await runtime.previewAdmission(offer(), {ownerAbsent: true,
    readings: readings(), readOnlyPreview: true});
  assert.equal(result.admitted, false);
  assert.equal(result.reasonCode, 'objective_evidence_unknown');
  assert.equal(calls, 0, 'per-offer options cannot assert callback purity');
  const direct = await runtime.pace50.preview({snapshotOnly: true, request: {attempt_id: 'fixture'}});
  assert.equal(direct.reason, 'objective_evidence_unknown');
  assert.equal(calls, 0, 'direct adapter snapshots also require the startup capability');
  assert.deepEqual(applicationState(), before);
});
