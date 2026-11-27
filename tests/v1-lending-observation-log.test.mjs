import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFile, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEventHistory, createMeasurementHistory, MEASUREMENT_LIMITS} from '../lib/v1/event-history.mjs';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {createOwnerSettings} from '../lib/v1/owner-settings.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';

const T0 = Date.parse('2026-10-29T12:00:00Z');
const MODEL = 'claude-haiku-5-5';
const job = {requirements: {limits: {wall_seconds: 300}}, expires_at: null, budget_v1: {max_list_usd: 4}};

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'lending-observation-log-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
}

function candidateFor(root, measurementHistory, {source = null, now = () => T0} = {}) {
  const ownerSettings = createOwnerSettings({directory: join(root, 'owner-settings')});
  ownerSettings.set({by: 'owner', reason: 'test limit', now: T0, maxJobUsd: 1.5});
  const inner = source ?? createSyntheticPace50Source({start: T0});
  const buildObjective = inner.objectiveInputFor?.bind(inner);
  if (buildObjective) inner.objectiveInputFor = args => {
    const input = buildObjective(args);
    input.job.chunkCandidates = [{id: 'owner-capped-checkpoint', usdMicro: 1_500_000, friendValue: 100}];
    return input;
  };
  return createPace50Candidate({directory: join(root, 'pace50'), now, account: 'synthetic-account',
    account_week_id: 'synthetic-week-1', source: inner, ownerSettings, measurementHistory,
    contextFor: () => ({consent: true, people: true, agents: true, schedule: true, unexpired: true, plan: 'max20'})});
}

async function readRows(log) {
  await log.flush();
  const content = await readFile(join(log.directory, 'measurements.jsonl'), 'utf8');
  return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('measurement storage is private, bounded, and isolated from activity history', async t => {
  const root = await directory(t);
  const activity = createEventHistory({directory: root, now: () => T0});
  await activity.load();
  activity.record({id: activity.nextId(), type: 'lending-action', at: new Date(T0).toISOString(),
    data: {circle: 'circle-1', action: 'on'}});
  const log = createMeasurementHistory({directory: root, now: () => T0, maxBytes: 4096});
  log.record('capture_epoch_started', {});
  for (let index = 0; index < 120; index++) log.record('observation_failed', {
    classification: 'new_source', reason: 'refresh_failed', started_wall_ms: T0 + index,
    started_monotonic_ns: String(index + 1), completed_wall_ms: T0 + index + 1,
    completed_monotonic_ns: String(index + 2),
  });
  await activity.flush();
  const rows = await readRows(log);
  const files = await readdir(root);
  assert.deepEqual(files.sort(), ['events.jsonl', 'events.meta.json', 'measurements']);
  assert.equal(activity.page({}).events.length, 1, 'measurement rows do not enter activity history');
  assert.ok(rows.some(row => row.type === 'capture_gap' && row.data.reason === 'oldest_rows_dropped'));
  const measurementDirStat = await stat(log.directory);
  const measurementFileStat = await stat(join(log.directory, 'measurements.jsonl'));
  const metadataStat = await stat(join(log.directory, 'measurements.meta.json'));
  assert.equal(measurementDirStat.mode & 0o777, 0o700);
  assert.equal(measurementFileStat.mode & 0o777, 0o600);
  assert.equal(metadataStat.mode & 0o777, 0o600);
  assert.ok(measurementFileStat.size <= 4096);
  assert.ok(metadataStat.size <= MEASUREMENT_LIMITS.metadataBytes);
  assert.ok(rows.every(row => Buffer.byteLength(JSON.stringify(row) + '\n') <= MEASUREMENT_LIMITS.rowBytes));
});

test('observation wrapper logs new evidence and suppresses an unchanged cache hit', async t => {
  const root = await directory(t);
  const log = createMeasurementHistory({directory: root, now: () => T0});
  let sourceCalls = 0;
  const source = createSyntheticPace50Source({start: T0});
  const observe = source.observe.bind(source);
  source.observe = async args => { sourceCalls++; return observe(args); };
  const {candidate, adapter} = candidateFor(root, log, {source});
  const args = {provider: 'claude', model: MODEL, plan: 'max20', now: T0};
  await candidate.observe(args);
  await candidate.observe(args);
  const rows = await readRows(log);
  assert.equal(sourceCalls, 1);
  assert.deepEqual(rows.filter(row => row.type === 'observation_completed').map(row => row.data.classification), ['new_source']);
  assert.equal(rows.filter(row => row.type === 'observation_requested').length, 1);
  assert.equal(rows.some(row => row.type === 'meter_sample'), false, 'a cache hit is not a new meter sample');
  await adapter.close();
});

test('failed observation records a fixed reason and drops the source error text', async t => {
  const root = await directory(t);
  const log = createMeasurementHistory({directory: root});
  const source = {async observe() { throw new Error('token=canary-token /home/private/account@example.test'); }};
  const {candidate, adapter} = candidateFor(root, log, {source});
  await assert.rejects(candidate.observe({provider: 'claude', model: MODEL, plan: 'max20', now: T0}));
  const rows = await readRows(log);
  const failed = rows.find(row => row.type === 'observation_failed');
  assert.equal(failed.data.reason, 'source_failed');
  const content = await readFile(join(log.directory, 'measurements.jsonl'), 'utf8');
  assert.equal(content.includes('canary-token'), false);
  assert.equal(content.includes('/home/private'), false);
  assert.equal(content.includes('account@example.test'), false);
  await adapter.close();
});

test('admission_decided is emitted at reserve, never for preview', async t => {
  const root = await directory(t);
  const log = createMeasurementHistory({directory: root, now: () => T0});
  const {candidate, adapter} = candidateFor(root, log);
  await candidate.preview({jobId: 'job-1', job, provider: 'claude', model: MODEL, automatic: true, ownerAbsent: true});
  assert.equal((await readRows(log)).filter(row => row.type === 'admission_decided').length, 0);
  const grant = await candidate.reserve({attemptId: 'attempt-1', jobId: 'job-1', provider: 'claude', model: MODEL,
    job, automatic: true, ownerAbsent: true});
  assert.equal(grant.ok, true, JSON.stringify(grant));
  const decisions = (await readRows(log)).filter(row => row.type === 'admission_decided');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].data.outcome, 'admitted');
  assert.equal(decisions[0].data.policy_version, 'objective/m1');
  assert.equal(decisions[0].data.dial, 'balanced');
  assert.ok(decisions[0].data.input_observation_event_ids.length > 0);
  assert.ok(decisions[0].data.resource_headroom.length > 0);
  await adapter.close();
});

test('a throwing measurement writer cannot change the admission result', async t => {
  const root = await directory(t);
  const healthy = createMeasurementHistory({directory: join(root, 'healthy'), now: () => T0});
  const failing = createMeasurementHistory({directory: join(root, 'failing'), now: () => T0,
    writer: {append: async () => { throw new Error('writer failure'); }} });
  const good = candidateFor(join(root, 'good'), healthy);
  const bad = candidateFor(join(root, 'bad'), failing);
  const args = {attemptId: 'attempt-1', jobId: 'job-1', provider: 'claude', model: MODEL,
    job, automatic: true, ownerAbsent: true};
  const [goodResult, badResult] = await Promise.all([good.candidate.reserve(args), bad.candidate.reserve(args)]);
  assert.deepEqual(badResult, goodResult);
  await failing.flush();
  assert.equal(failing.status().invalid, true);
  const failureRows = await readRows(failing);
  assert.ok(failureRows.some(row => row.type === 'capture_gap' && row.data.reason === 'write_failed'));
  const meta = JSON.parse(await readFile(join(failing.directory, 'measurements.meta.json'), 'utf8'));
  assert.equal(meta.gap.reason, 'write_failed');
  await Promise.all([good.adapter.close(), bad.adapter.close()]);
});

test('a failed queued write does not recreate a measurement directory removed during shutdown', async t => {
  const root = await directory(t);
  let started;
  const startedWriting = new Promise(resolve => { started = resolve; });
  let release;
  const holdWriter = new Promise(resolve => { release = resolve; });
  const log = createMeasurementHistory({directory: root, writer: {append: async () => {
    started();
    await holdWriter;
    throw new Error('writer failure');
  }}});
  log.record('capture_epoch_started', {});
  await startedWriting;
  await rm(log.directory, {recursive: true, force: true});
  release();
  await log.flush();
  await assert.rejects(stat(log.directory), {code: 'ENOENT'});
});

test('unknown observation fields are not serialized, including tokens, paths, and email addresses', async t => {
  const root = await directory(t);
  const log = createMeasurementHistory({directory: root, now: () => T0});
  const secretToken = 'canary-token-obslog-7f3b';
  const secretPath = '/tmp/canary/private/session.jsonl';
  const secretEmail = 'obslog-canary@example.test';
  const source = {async observe() { return {refresh_succeeded: true, complete: true,
    identity: {verified: true, account_id: secretEmail, token: secretToken},
    path: secretPath, prompt: secretToken, output: secretEmail,
    resources: [{id: secretEmail, instance: secretPath, used_micro: 120, kappa_micro: 40,
      duration_ms: 300000, observed_at: T0, resets_at: T0 + 300000, account: secretEmail,
      nested: {token: secretToken, path: secretPath, email: secretEmail}}]}; }};
  const {candidate, adapter} = candidateFor(root, log, {source});
  await candidate.observe({provider: 'claude', model: MODEL, plan: 'max20', now: T0});
  await log.flush();
  const content = await readFile(join(log.directory, 'measurements.jsonl'), 'utf8');
  for (const secret of [secretToken, secretPath, secretEmail]) assert.equal(content.includes(secret), false, `${secret} is excluded`);
  assert.match(content, /"used_micro":\{"value":120,"null_reason":null\}/);
  await adapter.close();
});

test('runtime records partial capture epoch start and end without authority receipts', async t => {
  const root = await directory(t);
  const log = createMeasurementHistory({directory: join(root, 'pace50', 'history'), now: () => T0});
  const runtime = createLendingRuntime({directory: join(root, 'pace50'), settings: () => ({}), backend: {},
    presence: () => false, pace50: {account: 'synthetic-account', account_week_id: 'synthetic-week-1',
      source: createSyntheticPace50Source({start: T0}), measurementHistory: log}});
  await runtime.close();
  const rows = await readRows(log);
  assert.deepEqual(rows.map(row => row.type), ['capture_epoch_started', 'capture_epoch_ended']);
  assert.ok(rows.every(row => row.schema_version === 1 && row.coverage === 'partial'));
  assert.ok(rows.every(row => row.data.coverage_status === 'partial: part A, no authority receipts'));
});

test('a rejected symlink measurement directory is never used for writes', async t => {
  const root = await directory(t), outside = join(root, 'outside');
  await import('node:fs/promises').then(({mkdir}) => mkdir(outside));
  await symlink(outside, join(root, 'measurements'));
  const log = createMeasurementHistory({directory: root});
  log.record('capture_epoch_started', {});
  await log.flush();
  assert.deepEqual(await readdir(outside), []);
  assert.equal(log.status().durable, false);
});

test('only one measurement writer can own a partition', async t => {
  const root = await directory(t), first = createMeasurementHistory({directory: root, maxBytes: 4096});
  const second = createMeasurementHistory({directory: root, maxBytes: 4096});
  first.record('capture_epoch_started', {});
  second.record('capture_epoch_started', {});
  await Promise.all([first.flush(), second.flush()]);
  const rows = await readRows(first);
  assert.equal(rows.length, 1);
  assert.equal(second.status().invalid, true);
});

test('restart repairs an unterminated JSONL tail before appending a gap', async t => {
  const root = await directory(t), measurements = join(root, 'measurements');
  await import('node:fs/promises').then(({mkdir}) => mkdir(measurements));
  await writeFile(join(measurements, 'measurements.jsonl'), '{"schema_version":1');
  const log = createMeasurementHistory({directory: root});
  log.record('capture_epoch_started', {});
  await log.flush();
  const content = await readFile(join(measurements, 'measurements.jsonl'), 'utf8');
  const rows = content.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(rows.some(row => row.type === 'capture_gap' && row.data.reason === 'unclean_restart'));
  assert.ok(rows.some(row => row.type === 'capture_epoch_started'));
});

test('invalid-record markers stay within the byte cap', async t => {
  const root = await directory(t), log = createMeasurementHistory({directory: root, maxBytes: 4096});
  for (let index = 0; index < 500; index++) log.record('unsupported_type', {});
  await log.flush();
  const size = (await stat(join(log.directory, 'measurements.jsonl'))).size;
  assert.ok(size <= 4096, `measurement file is ${size} bytes`);
});

test('trimming during an in-flight append rewrites the retained snapshot', async t => {
  let release = () => {}, log = null;
  t.after(async () => { release(); if (log) { await log.flush(); log.close(); } });
  const root = await directory(t);
  let started;
  const startedWriting = new Promise(resolve => { started = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  log = createMeasurementHistory({directory: root, maxBytes: 4096, writer: {append: async (path, content) => {
    started();
    await paused;
    await appendFile(path, content);
  }}});

  log.record('capture_epoch_started', {});
  await startedWriting;
  let lastId;
  for (let index = 0; index < 100; index++) {
    lastId = log.record('observation_failed', {reason: 'source_failed', classification: 'new_source',
      started_wall_ms: T0 + index, completed_wall_ms: T0 + index + 1});
  }
  release();
  assert.equal(await log.flush(), true);
  const rows = await readRows(log);
  assert.ok(rows.some(row => row.event_id === lastId), 'the retained latest row reaches disk after trimming');
});

test('trimming during an in-flight rewrite preserves a newer rewrite request', async t => {
  let release = () => {}, log = null;
  t.after(async () => { release(); if (log) { await log.flush(); log.close(); } });
  const root = await directory(t), measurements = join(root, 'measurements');
  await import('node:fs/promises').then(({mkdir}) => mkdir(measurements));
  await writeFile(join(measurements, 'measurements.jsonl'), '{invalid row}\n');
  let started;
  const startedWriting = new Promise(resolve => { started = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  let rewriteCalls = 0;
  log = createMeasurementHistory({directory: root, maxBytes: 4096, writer: {rewrite: async (path, content) => {
    rewriteCalls++;
    if (rewriteCalls === 1) { started(); await paused; }
    await writeFile(path, content);
  }}});

  await startedWriting;
  let lastId;
  for (let index = 0; index < 100; index++) {
    lastId = log.record('observation_failed', {reason: 'source_failed', classification: 'new_source',
      started_wall_ms: T0 + index, completed_wall_ms: T0 + index + 1});
  }
  release();
  assert.equal(await log.flush(), true);
  const rows = await readRows(log);
  assert.ok(rewriteCalls >= 2, 'a newer dirty snapshot schedules another rewrite');
  assert.ok(rows.some(row => row.event_id === lastId), 'the retained latest row reaches disk after the rewrite race');
});

test('admission headroom survives a clean restart and rewrite', async t => {
  let first = null, reopened = null;
  t.after(async () => {
    await first?.flush(); first?.close();
    await reopened?.flush(); reopened?.close();
  });
  const root = await directory(t);
  first = createMeasurementHistory({directory: root, now: () => T0});
  first.record('admission_decided', {outcome: 'admitted', reason: 'quota_reserve', resource_headroom: [123]});
  await first.flush();
  assert.equal(first.close(), true);

  reopened = createMeasurementHistory({directory: root, now: () => T0});
  await reopened.flush();
  const decision = (await readRows(reopened)).find(row => row.type === 'admission_decided');
  assert.deepEqual(decision.data.resource_headroom, [{value: 123, null_reason: null}]);
});

test('restart discards non-allowlisted restored fields and metadata reasons', async t => {
  const root = await directory(t), measurements = join(root, 'measurements');
  await import('node:fs/promises').then(({mkdir}) => mkdir(measurements));
  const secret = 'restart-canary-secret';
  const row = {schema_version: 1, coverage: 'partial', event_id: '00000000-0000-0000-0000-000000000001',
    capture_epoch_id: '00000000-0000-0000-0000-000000000002', sequence: 1, type: 'capture_epoch_ended',
    recorded_at_utc: new Date(T0).toISOString(), recorded_at_null_reason: null, monotonic_ns: '1',
    monotonic_null_reason: null, data: {coverage_status: 'partial: part A, no authority receipts', prompt: secret}, extra: secret};
  await writeFile(join(measurements, 'measurements.jsonl'), `${JSON.stringify(row)}\n`);
  await writeFile(join(measurements, 'measurements.meta.json'), JSON.stringify({schema_version: 1, coverage: 'partial',
    invalid: false, gap: {reason: secret}}));
  const log = createMeasurementHistory({directory: root, maxBytes: 4096});
  log.record('observation_failed', {reason: 'refresh_failed'});
  await log.flush();
  const content = await readFile(join(measurements, 'measurements.jsonl'), 'utf8');
  assert.equal(content.includes(secret), false);
  assert.notEqual(log.status().gap?.reason, secret);
});

test('cached failed observations remain failures in the measurement log', async t => {
  const root = await directory(t), log = createMeasurementHistory({directory: root});
  const source = {async observe() { return {refresh_succeeded: false, complete: false, resources: []}; }};
  const {candidate, adapter} = candidateFor(root, log, {source});
  const args = {provider: 'claude', model: MODEL, plan: 'max20', now: T0};
  await candidate.observe(args);
  await candidate.observe(args);
  const rows = await readRows(log);
  assert.equal(rows.filter(row => row.type === 'observation_failed').length, 1);
  assert.equal(rows.some(row => row.type === 'observation_completed'), false);
  await adapter.close();
});

test('admission references the observation used for its requested model', async t => {
  const root = await directory(t), log = createMeasurementHistory({directory: root});
  const {candidate, adapter} = candidateFor(root, log);
  const args = {provider: 'claude', plan: 'max20', now: T0};
  await candidate.observe({...args, model: 'claude-haiku-5-5'});
  await candidate.observe({...args, model: 'claude-sonnet-5-5'});
  const reserve = await candidate.reserve({attemptId: 'attempt-correlated', jobId: 'job-correlated', provider: 'claude',
    model: 'claude-haiku-5-5', job, automatic: true, ownerAbsent: true});
  assert.equal(reserve.ok, true, JSON.stringify(reserve));
  const rows = await readRows(log);
  const decidingRead = rows.find(row => row.type === 'observation_completed');
  const decision = rows.find(row => row.type === 'admission_decided');
  assert.deepEqual(decision.data.input_observation_event_ids, [decidingRead.event_id]);
  await adapter.close();
});

test('reserve decisions are identical with capture enabled, disabled, and failing', async t => {
  let enabled, failing;
  t.after(async () => {
    await Promise.all([enabled, failing].filter(Boolean).map(log => log.flush()));
    enabled?.close();
    failing?.close();
  });
  const root = await directory(t);
  enabled = createMeasurementHistory({directory: join(root, 'enabled'), now: () => T0});
  failing = createMeasurementHistory({directory: join(root, 'failing'), now: () => T0,
    writer: {append: async () => { throw new Error('writer failure'); }}});
  const candidates = [candidateFor(join(root, 'enabled-case'), enabled), candidateFor(join(root, 'disabled-case'), null),
    candidateFor(join(root, 'failing-case'), failing)];
  const sequence = ['attempt-sequence-1', 'attempt-sequence-2'];
  const decisions = [];
  for (const {candidate} of candidates) {
    const result = [];
    for (const attemptId of sequence) result.push(await candidate.reserve({attemptId, jobId: attemptId,
      provider: 'claude', model: MODEL, job, automatic: true, ownerAbsent: true}));
    decisions.push(result);
  }
  assert.deepEqual(decisions[1], decisions[0]);
  assert.deepEqual(decisions[2], decisions[0]);
  await Promise.all(candidates.map(({adapter}) => adapter.close()));
});

test('reserve log records held and refused outcomes with fixed reason codes', async t => {
  const root = await directory(t), log = createMeasurementHistory({directory: root, now: () => T0});
  const held = candidateFor(join(root, 'held'), log);
  await held.candidate.reserve({attemptId: 'attempt-held', jobId: 'job-held', provider: 'unknown-provider',
    model: 'unknown-model', job, automatic: true, ownerAbsent: true});
  const ownerSettings = createOwnerSettings({directory: join(root, 'refused-settings')});
  const refused = createPace50Candidate({directory: join(root, 'refused'), now: () => T0, account: 'synthetic-account',
    account_week_id: 'synthetic-week-1', source: createSyntheticPace50Source({start: T0}), ownerSettings,
    buildInput: async () => ({refuse: 'no_value'}), measurementHistory: log,
    contextFor: () => ({consent: true, people: true, agents: true, schedule: true, unexpired: true, plan: 'max20'})});
  await refused.candidate.reserve({attemptId: 'attempt-refused', jobId: 'job-refused', provider: 'claude',
    model: MODEL, job, automatic: true, ownerAbsent: true});
  await log.flush();
  const decisions = (await readRows(log)).filter(row => row.type === 'admission_decided');
  assert.deepEqual(decisions.map(row => row.data.outcome).sort(), ['held', 'refused']);
  assert.ok(decisions.every(row => ['model_not_lendable', 'quota_reserve'].includes(row.data.reason)));
  await Promise.all([held.adapter.close(), refused.adapter.close()]);
});

test('runtime close reports an undrained measurement capture without waiting for a stuck writer', async t => {
  let release = () => {}, log = null;
  t.after(async () => { release(); if (log) { await log.flush(); log.close(); } });
  const root = await directory(t);
  const hold = new Promise(resolve => { release = resolve; });
  log = createMeasurementHistory({directory: join(root, 'pace50', 'history'), writer: {append: async () => hold}});
  const runtime = createLendingRuntime({directory: join(root, 'pace50'), settings: () => ({}), backend: {},
    presence: () => false, pace50: {account: 'synthetic-account', account_week_id: 'synthetic-week-1',
      source: createSyntheticPace50Source({start: T0}), measurementHistory: log}});
  const started = Date.now();
  const result = await runtime.close({drainMs: 20});
  assert.ok(Date.now() - started < 500);
  assert.equal(result.capture_drain_complete, false);
  release();
  await log.flush();
  const replacement = createMeasurementHistory({directory: join(root, 'pace50', 'history'), now: () => T0});
  assert.equal(replacement.status().durable, true, 'a closed runtime releases its partition after the writer drains');
  replacement.close();
});

test('unchanged admission cache polls preserve measurement rows across cache expiry', async t => {
  const root = await directory(t);
  let at = T0;
  const log = createMeasurementHistory({directory:root, now:() => at, maxBytes:4096});
  const source = createSyntheticPace50Source({start:T0});
  const snapshot = await source.observe({provider:'claude', now:T0});
  source.observe = async () => snapshot;
  const {candidate, adapter} = candidateFor(root, log, {source, now:() => at});
  const args = {provider:'claude', model:MODEL, plan:'max20', admissionOnly:true};
  await candidate.observe(args);
  const initial = await readRows(log);
  for (let i = 1; i <= 120; i++) {at = T0 + i * 1000; await candidate.observe(args);}
  assert.deepEqual(await readRows(log), initial, 'the same evidence writes no new rows even after the 30 s cache expires');
  snapshot.resources[0].used_micro += 1_000_000;
  at += 31_000;
  await candidate.observe(args);
  const changed = await readRows(log);
  assert.equal(changed.filter(row => row.type === 'observation_completed').length, 2);
  await adapter.close();
});

test('unknown reserve reason stays diagnostic in the private measurement log', async t => {
  const root = await directory(t);
  const log = createMeasurementHistory({directory: root, now: () => T0});
  const built = createPace50Candidate({directory: join(root, 'candidate'), now: () => T0,
    account: 'synthetic-account', account_week_id: 'synthetic-week-1',
    source: createSyntheticPace50Source({start:T0}), measurementHistory: log,
    buildInput: async () => ({refuse:'future_internal_reason'}),
    contextFor: () => ({consent:true, people:true, agents:true, schedule:true, unexpired:true, plan:'max20'})});
  const out = await built.candidate.reserve({attemptId:'unknown-reason', jobId:'unknown-reason',
    provider:'claude', model:MODEL, job, automatic:true, ownerAbsent:true});
  assert.equal(out.reason, 'internal_error');
  assert.equal(out.policyReason, 'future_internal_reason');
  const decision = (await readRows(log)).find(row => row.type === 'admission_decided');
  assert.equal(decision.data.reason, 'internal_error');
  assert.equal(decision.data.policy_reason, 'future_internal_reason');
  await built.adapter.close();
});
