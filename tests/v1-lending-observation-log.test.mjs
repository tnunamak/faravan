import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFile, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEventHistory, createMeasurementHistory, MEASUREMENT_LIMITS} from '../lib/v1/event-history.mjs';

const T0 = Date.parse('2026-10-29T12:00:00Z');

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'lending-observation-log-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
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
