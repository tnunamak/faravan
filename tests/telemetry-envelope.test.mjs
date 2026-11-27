import './helpers/no-browser.mjs';
// Batches and inbox files: the shapes that travel. Wire rules: docs/design/TELEMETRY-WIRE.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA_VERSION, TelemetrySchemaError, parseEnvelope, parseInboxFile, canonicalJson, MAX_INBOX_FILE_BYTES } from '../lib/v1/telemetry/catalog.mjs';
import { goldenNames, readGolden, goldenRecords } from './helpers/telemetry-golden.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const envelope = name => JSON.parse(readGolden(name + '.json'));
const rejects = (fn, code) => assert.throws(fn, error => error instanceof TelemetrySchemaError && (code === undefined || error.code === code), 'expected ' + (code ?? 'a schema error'));
const quotaRelease = () => envelope('envelope.quota-release-0.1.0-preview.20261020.7');

test('every golden envelope is canonical bytes and passes parseEnvelope', () => {
  const names = goldenNames('.json').filter(name => name.startsWith('envelope.'));
  assert.ok(names.length >= 5);
  for (const file of names) {
    assert.equal(readGolden(file), canonicalJson(JSON.parse(readGolden(file))) + '\n', file);
    assert.equal(canonicalJson(parseEnvelope(JSON.parse(readGolden(file)))), canonicalJson(JSON.parse(readGolden(file))), file);
  }
});

test('there is one golden envelope per stream, a macOS one and one from the real release', () => {
  const streams = new Set(goldenNames('.json').filter(name => name.startsWith('envelope.')).map(name => envelope(name.slice(0, -5)).stream));
  assert.deepEqual([...streams].sort(), ['counts', 'diagnostics', 'quota']);
  assert.equal(envelope('envelope.counts-macos').resource['os.major'], 26);
  assert.deepEqual(quotaRelease().resource, {'deployment.environment.name': 'preview', 'service.version_minor': '0.1'});
});

test('a quota batch holds exactly one record and only the reduced resource', () => {
  const batch = quotaRelease();
  for (const resource of [{...batch.resource, 'service.version': '0.1.0-preview.20261020.7'}, {...batch.resource, 'service.name': 'app'}, {...batch.resource, 'os.type': 'linux'},
    {...batch.resource, 'host.arch': 'amd64'}]) rejects(() => parseEnvelope({...batch, resource}), 'unknown_key');
  rejects(() => parseEnvelope({...batch, resource: {'service.version_minor': '0.1.0', 'deployment.environment.name': 'preview'}}), 'bad_version');
  rejects(() => parseEnvelope({...batch, resource: {'service.version_minor': '0.1', 'deployment.environment.name': 'beta'}}), 'not_member');
  rejects(() => parseEnvelope({...batch, resource: {'service.version_minor': '0.1'}}), 'not_member');
  rejects(() => parseEnvelope({...batch, records: [...batch.records, ...batch.records]}), 'bad_length');
  rejects(() => parseEnvelope({...batch, records: []}), 'bad_length');
  // The quota stream admits only quota.week.
  const counts = envelope('envelope.counts');
  rejects(() => parseEnvelope({...batch, records: [counts.records[0]]}), 'stream_mismatch');
  rejects(() => parseEnvelope({...counts, records: batch.records}), 'stream_mismatch');
});

test('a counts or diagnostics batch needs a full release version whose channel matches', () => {
  const batch = envelope('envelope.counts');
  const resource = (changes) => ({...batch.resource, ...changes});
  rejects(() => parseEnvelope({...batch, resource: resource({'service.version': '1.2.3-privateproject'})}), 'bad_version');
  rejects(() => parseEnvelope({...batch, resource: resource({'deployment.environment.name': 'stable'})}), 'not_member');
  rejects(() => parseEnvelope({...batch, resource: resource({'service.version': '0.1.0'})}), 'not_member');
  assert.ok(parseEnvelope({...batch, resource: resource({'service.version': '0.1.0', 'deployment.environment.name': 'stable'})}));
  rejects(() => parseEnvelope({...batch, resource: resource({'os.type': 'plan9'})}), 'not_member');
  rejects(() => parseEnvelope({...batch, resource: resource({'os.major': 26})}), 'unknown_key', 'os.major is a macOS field');
  rejects(() => parseEnvelope({...batch, resource: resource({'host.name': 'alice-laptop'})}), 'unknown_key');
  const unnamed = clone(batch); delete unnamed.resource['service.name'];
  rejects(() => parseEnvelope(unnamed), 'missing_key');
  rejects(() => parseEnvelope({...batch, resource: resource({'service.name': 'ui'})}), 'not_member');
});

test('the envelope header is checked', () => {
  const batch = envelope('envelope.counts');
  rejects(() => parseEnvelope({...batch, schema: 'otlp'}), 'not_member');
  for (const schema_version of [0, SCHEMA_VERSION + 1, 1.5, '1', null]) rejects(() => parseEnvelope({...batch, schema_version}), 'out_of_range');
  for (const batch_id of ['b-short', 'r-AAAAAAAAAAAAAAAAAAAA', 'alice', 7, null]) rejects(() => parseEnvelope({...batch, batch_id}), 'bad_pattern');
  rejects(() => parseEnvelope({...batch, stream: 'metrics'}), 'not_member');
  rejects(() => parseEnvelope({...batch, install_id: 'x'}), 'unknown_key');
  rejects(() => parseEnvelope({...batch, records: 'x'}), 'bad_type');
  rejects(() => parseEnvelope({...batch, records: Array(201).fill(batch.records[0])}), 'bad_length');
  rejects(() => parseEnvelope(null), 'not_object');
});

test('records in a batch: origin must belong to the batch\'s service, and a counts cell may appear once', () => {
  const batch = envelope('envelope.counts');
  const [problem] = batch.records;
  rejects(() => parseEnvelope({...batch, records: [{...problem, origin: 'tray'}]}), 'wrong_origin');
  rejects(() => parseEnvelope({...batch, records: [{...problem, origin: 'ui'}]}), 'wrong_origin');
  rejects(() => parseEnvelope({...batch, records: [problem, clone(problem)]}), 'duplicate_cell');
  assert.ok(parseEnvelope({...batch, records: [problem, {...problem, period: '2026-10-21T18'}]}));
  const tray = {...batch, resource: {...batch.resource, 'service.name': 'tray'}, records: [goldenRecords().find(item => item.name === 'health.state').record]};
  assert.ok(parseEnvelope(tray), 'a tray batch carries tray health records');
  rejects(() => parseEnvelope({...tray, records: [problem]}), 'wrong_origin', 'problem.count is an app record');
  const crash = goldenRecords().find(item => item.name === 'app.crash').record;
  const diagnostics = envelope('envelope.diagnostics');
  assert.ok(parseEnvelope({...diagnostics, records: [crash]}), 'a crash record rides in the app\'s batch with origin crash');
  rejects(() => parseEnvelope({...diagnostics, resource: {...diagnostics.resource, 'service.name': 'tray'}, records: [crash]}), 'wrong_origin');
});

test('an error names a path of declared keys and never echoes input', () => {
  const batch = envelope('envelope.counts');
  const canary = 'CANARY-/home/alice/secret-sk-ant-AAAA';
  const probes = [
    {...batch, [canary]: 1},
    {...batch, records: [{...batch.records[0], [canary]: 1}]},
    {...batch, records: [{...batch.records[0], attrs: {...batch.records[0].attrs, [canary]: 1}}]},
    {...batch, records: [{...batch.records[0], attrs: {...batch.records[0].attrs, 'error.type': canary}}]},
    {...batch, resource: {...batch.resource, 'service.version': canary}},
    {...batch, batch_id: canary},
    {...batch, records: [{...batch.records[0], name: canary}]},
  ];
  for (const probe of probes) {
    try { parseEnvelope(probe); assert.fail('accepted'); } catch (error) {
      assert.ok(error instanceof TelemetrySchemaError);
      assert.ok(!error.message.includes('CANARY') && !error.path.includes('CANARY'), error.message);
    }
  }
});

test('inbox files: the golden files pass; hostile ones are rejected', () => {
  const files = goldenNames('.json').filter(name => name.startsWith('inbox.') || name.endsWith('.inbox.json'));
  assert.ok(files.length >= 4);
  for (const file of files) {
    const text = readGolden(file);
    assert.equal(text, canonicalJson(JSON.parse(text)) + '\n', file);
    assert.equal(parseInboxFile(text).origin, JSON.parse(text).origin);
  }
  const base = JSON.parse(readGolden('inbox.tray-panic.json'));
  rejects(() => parseInboxFile('{'), 'bad_json');
  rejects(() => parseInboxFile(JSON.stringify(base) + ' '.repeat(MAX_INBOX_FILE_BYTES)), 'too_large');
  rejects(() => parseInboxFile({...base, format: 'other'}), 'not_member');
  rejects(() => parseInboxFile({...base, extra: 1}), 'unknown_key');
  for (const origin of ['app', 'ui', 'phone', 'nope', 7]) rejects(() => parseInboxFile({...base, origin}), 'wrong_origin');
  rejects(() => parseInboxFile({...base, origin: 'installer'}), 'wrong_origin', 'app.crash is not an installer record');
  for (const gen of [-1, 1.5, '3', null, Number.MAX_SAFE_INTEGER + 1]) rejects(() => parseInboxFile({...base, gen}), 'out_of_range');
  assert.equal(parseInboxFile({...base, gen: Number.MAX_SAFE_INTEGER}).gen, Number.MAX_SAFE_INTEGER);
  rejects(() => parseInboxFile({...base, schema_version: SCHEMA_VERSION + 1}), 'out_of_range');
  rejects(() => parseInboxFile({...base, record: goldenRecords().find(item => item.name === 'quota.week').record}), 'wrong_origin');
  rejects(() => parseInboxFile({...base, record: {...base.record, attrs: {...base.record.attrs, frames: [{file: '/home/alice/x.js', line: 1}]}}}), 'not_member');
  rejects(() => parseInboxFile([]), 'not_object');
  assert.equal(parseInboxFile(readGolden('inbox.coordinator-tunnel.json')).gen, 0, 'generation 0 means the policy file was missing');
});
