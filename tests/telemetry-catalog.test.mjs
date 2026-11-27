import './helpers/no-browser.mjs';
// The contract of lib/v1/telemetry/catalog.mjs: parseRecord accepts the golden records and rejects everything outside the
// catalog, in every attribute of every entry. The wire rules are in docs/design/TELEMETRY-WIRE.md.
import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { CATALOG, SCHEMA_VERSION, TelemetrySchemaError, parseRecord, parseInboxFile, parseEnvelope, bucket, bucketIndex, canonicalJson,
  channelOf, minorOf, parseVersion, entryNamesAt, enumMembers } from '../lib/v1/telemetry/catalog.mjs';
import { goldenRecords, readGolden } from './helpers/telemetry-golden.mjs';

const golden = goldenRecords();
const originOf = ({record, inbox}, entry) => inbox?.origin ?? record.origin ?? entry.origins[0];
const parseGolden = item => {
  const entry = CATALOG.entries[item.name];
  return item.inbox ? parseInboxFile(item.inbox).record : parseRecord(item.record, {origin: originOf(item, entry)});
};
const rejects = (fn, code) => assert.throws(fn, error => error instanceof TelemetrySchemaError && (code === undefined || error.code === code), 'expected ' + (code ?? 'a schema error'));
const clone = value => JSON.parse(JSON.stringify(value));

test('the golden records are canonical bytes and pass parseRecord', () => {
  for (const item of golden) {
    assert.equal(item.bytes, canonicalJson(item.record) + '\n', item.name + ' is not in canonical form');
    assert.equal(canonicalJson(parseGolden(item)), canonicalJson(item.record), item.name);
  }
});

test('every entry live at the current schema version has a golden pair', () => {
  const have = new Set(golden.map(item => item.name));
  const missing = entryNamesAt().filter(name => !have.has(name));
  assert.deepEqual(missing, []);
  assert.deepEqual([...have].filter(name => !CATALOG.entries[name]), [], 'a golden pair names an entry that is not in the catalog');
});

// Paths to every leaf of a record's attrs, with the leaf's value.
function leaves(value, path = []) {
  if (Array.isArray(value)) return value.flatMap((item, index) => leaves(item, [...path, index]));
  if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => leaves(item, [...path, key]));
  return [{path, value}];
}
const set = (root, path, value) => { const copy = clone(root); let at = copy; for (const key of path.slice(0, -1)) at = at[key]; at[path.at(-1)] = value; return copy; };
const CANARIES = ['', 'not-a-member', '/home/alice/projects/secret', 'git@github.com:alice/private.git', 'alice@example.com',
  'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA', 'Ann’s MacBook', '‮gnp.exe', '%2Fhome%2Falice', 'ＡＢＣ', 'x'.repeat(5000), 'Error: boom\n    at /home/alice/x.js:1:1'];

test('a string that is not a member of its attribute\'s enum or bucket set is rejected, in every attribute of every entry', () => {
  let checked = 0;
  for (const item of golden) {
    const entry = CATALOG.entries[item.name], origin = originOf(item, entry);
    const body = item.inbox ? item.inbox.record : item.record;
    const parse = record => item.inbox ? parseInboxFile({...item.inbox, record}) : parseRecord(record, {origin});
    for (const leaf of leaves(body.attrs).filter(l => typeof l.value === 'string')) {
      for (const canary of CANARIES) {
        rejects(() => parse(set(body, ['attrs', ...leaf.path], canary)));
        checked++;
      }
    }
  }
  assert.ok(checked > 1000, 'checked ' + checked);
});

test('integers outside their range, wrong types, unknown keys and missing keys are rejected, never coerced', () => {
  for (const item of golden) {
    const entry = CATALOG.entries[item.name], origin = originOf(item, entry);
    const body = item.inbox ? item.inbox.record : item.record;
    const parse = record => item.inbox ? parseInboxFile({...item.inbox, record}) : parseRecord(record, {origin});
    for (const leaf of leaves(body.attrs)) {
      const where = ['attrs', ...leaf.path];
      if (typeof leaf.value === 'number') for (const bad of [-1, 2 ** 40, 1.5, '1', null]) rejects(() => parse(set(body, where, bad)));
      if (typeof leaf.value === 'boolean') for (const bad of [0, 1, 'true', null]) rejects(() => parse(set(body, where, bad)));
    }
    // An unknown key at the top and inside attrs, and in every nested record.
    rejects(() => parse({...clone(body), extra: 1}), 'unknown_key');
    rejects(() => parse(set(body, ['attrs', 'extra'], 'x')), 'unknown_key');
    const nested = leaves(body.attrs).map(l => l.path.slice(0, -1)).filter(p => typeof p.at(-1) === 'number');
    for (const path of nested) rejects(() => parse(set(body, ['attrs', ...path, 'extra'], 'x')), 'unknown_key');
    // A required attribute removed.
    for (const [key, type] of Object.entries(entry.attrs)) {
      if (type.optional) continue;
      const copy = clone(body); delete copy.attrs[key];
      rejects(() => parse(copy), 'missing_key');
    }
    // Top-level fields.
    rejects(() => parse({...clone(body), name: 'not.an.entry'}), 'unknown_name');
    const noAttrs = clone(body); delete noAttrs.attrs;
    rejects(() => parse(noAttrs), 'missing_key');
  }
});

test('counts: periods, values and histogram bins are checked', () => {
  const sum = clone(golden.find(item => item.name === 'problem.count').record);
  const histogram = clone(golden.find(item => item.name === 'job.duration').record);
  for (const period of ['2026-10-21', '2026-10-21T24', '2026-13-01T00', '2026-02-30T01', 'now', 20261021, '2026-10-21T19:00']) rejects(() => parseRecord({...sum, period}, {origin: 'app'}), 'bad_period');
  for (const value of [0, -1, 10001, 1.5, '3', null]) rejects(() => parseRecord({...sum, value}, {origin: 'app'}));
  rejects(() => parseRecord({...histogram, counts: histogram.counts.slice(1)}, {origin: 'app'}), 'bad_length');
  rejects(() => parseRecord({...histogram, counts: histogram.counts.map(() => 0)}, {origin: 'app'}), 'out_of_range');
  rejects(() => parseRecord({...histogram, counts: histogram.counts.map((n, i) => i === 0 ? -1 : n)}, {origin: 'app'}), 'bad_type');
  rejects(() => parseRecord({...histogram, buckets: 'wait_s'}, {origin: 'app'}), 'not_member');
  rejects(() => parseRecord({...sum, hour: '2026-10-21T19'}, {origin: 'app'}), 'unknown_key');
  const health = golden.find(item => item.name === 'health.state').record;
  rejects(() => parseRecord({...health, value: 2}, {origin: 'app'}), 'out_of_range');
});

test('diagnostics: identity, kind, hour and duration are checked; the inbox form has no identity', () => {
  const span = clone(golden.find(item => item.name === 'job.run').record);
  const event = clone(golden.find(item => item.name === 'problem.observed.readiness').record);
  const parse = record => parseRecord(record, {origin: 'app'});
  for (const key of ['rid', 'epoch', 'session', 'trace']) rejects(() => parse({...span, [key]: 'x-AAAAAAAAAAAAAAAAAAAA'}), 'bad_pattern');
  rejects(() => parse({...span, rid: span.epoch}), 'bad_pattern');
  const noTrace = {...span}; delete noTrace.trace;
  rejects(() => parse(noTrace), 'missing_key');
  const eventNoTrace = {...event}; delete eventNoTrace.trace;
  assert.ok(parse(eventNoTrace), 'an event may omit its trace');
  rejects(() => parse({...span, kind: 'event'}), 'not_member');
  rejects(() => parse({...span, status: 'unset'}), 'not_member');
  rejects(() => parse({...span, duration_ms: -5}), 'out_of_range');
  rejects(() => parse({...span, seq: 2 ** 31}), 'out_of_range');
  rejects(() => parse({...span, hour: '2026-10-21T19:42'}), 'bad_period');
  rejects(() => parse({...span, period: '2026-10-21T19'}), 'unknown_key');
  const inbox = golden.find(item => item.inbox).inbox;
  rejects(() => parseInboxFile({...inbox, record: {...inbox.record, rid: span.rid}}), 'unknown_key');
});

test('origin: an entry accepts only its listed origins, and a record that names another origin is rejected', () => {
  const record = golden.find(item => item.name === 'problem.count').record;
  for (const origin of ['ui', 'phone', 'tray', 'installer', 'crash', 'nope', undefined]) rejects(() => parseRecord(record, {origin}), 'wrong_origin');
  assert.ok(parseRecord(record, {origin: 'coordinator'}), 'the coordinator reports its own failures as problem.count');
  rejects(() => parseRecord({...record, origin: 'ui'}, {origin: 'app'}), 'wrong_origin');
  const {origin: _own, ...friction} = golden.find(item => item.name === 'ui.friction').record;
  assert.ok(parseRecord(friction, {origin: 'ui'}) && parseRecord(friction, {origin: 'phone'}));
  assert.equal(golden.find(item => item.name === 'ui.friction').record.origin, 'ui', 'the fixture names its origin');
  rejects(() => parseRecord(friction, {origin: 'app'}), 'wrong_origin');
  rejects(() => parseRecord(golden.find(item => item.name === 'quota.week').record, {origin: 'ui'}), 'wrong_origin');
});

test('a record is valid at the schema versions where its entry exists, and not before', () => {
  const record = golden.find(item => item.name === 'problem.count').record;
  assert.ok(parseRecord(record, {origin: 'app', schemaVersion: 1}));
  rejects(() => parseRecord(record, {origin: 'app', schemaVersion: 0}), 'unknown_name');
});

test('non-objects and hostile shapes are rejected without throwing anything else', () => {
  for (const raw of [null, undefined, 1, 'x', [], [[]], true, () => 1, Symbol.iterator.toString()]) rejects(() => parseRecord(raw, {origin: 'app'}));
  rejects(() => parseRecord(JSON.parse('{"name":"problem.count","__proto__":{"x":1}}'), {origin: 'app'}));
  rejects(() => parseRecord(Object.create({name: 'problem.count'}), {origin: 'app'}));
});

test('the version grammar is the release formats and nothing else', () => {
  for (const [text, channel, minor] of [['0.1.0', 'stable', '0.1'], ['12.34.56', 'stable', '12.34'], ['0.1.0-preview.20261020.7', 'preview', '0.1'], ['1.2.3-preview.20260101.12', 'preview', '1.2']]) {
    assert.equal(channelOf(text), channel);
    assert.equal(minorOf(text), minor);
    assert.ok(parseVersion(text));
  }
  for (const text of ['1.2.3-privateproject', '1.2.3-alice', '1.2', '1.2.3.4', 'v1.2.3', '1.2.3-preview', '1.2.3-preview.2026102.7', '1.2.3-preview.20261020', '1.2.3-preview.20261020.7-1',
    '1.2.3-rc.1', '12345.0.0', '1.2.3+build', ' 1.2.3', '1.2.3\n', '1.2.3-preview.20261020.7/home/alice', '', null, 7]) {
    assert.equal(parseVersion(text), null, String(text));
  }
  const upgrade = golden.find(item => item.name === 'upgrade.run').record;
  for (const to of ['1.2.3-privateproject', '1.2.3-rc.1', 'latest']) rejects(() => parseRecord({...upgrade, attrs: {...upgrade.attrs, to}}, {origin: 'app'}), 'bad_version');
});

test('IDs have a fixed pattern per field', () => {
  const span = golden.find(item => item.name === 'job.run').record;
  for (const rid of ['r-AAAAAAAAAAAAAAAAAAA', 'r-AAAAAAAAAAAAAAAAAAAAA', 'r-aaaaaaaaaaaaaaaaaaaa', 'r-AAAAAAAAAAAAAAAAAAA1', 'R-AAAAAAAAAAAAAAAAAAAA', '/home/alice/x']) {
    rejects(() => parseRecord({...span, rid}, {origin: 'app'}), 'bad_pattern');
  }
});

test('buckets: the label is the smallest bound at or above the value', () => {
  assert.equal(bucket('points', 0), '0');
  assert.equal(bucket('points', 0.1), '1');
  assert.equal(bucket('points', 3), '5');
  assert.equal(bucket('points', 40), '40');
  assert.equal(bucket('points', 41), 'inf');
  assert.equal(bucket('pct10', 61), '70');
  assert.equal(bucket('pct10', 100), '100');
  assert.equal(bucket('pct10', 1000), '100', 'a closed set clamps');
  assert.equal(bucket('coverage', 0.9), '0.9');
  assert.equal(bucket('coverage', 0.91), '1');
  assert.equal(bucket('since_install', 10800), '1d');
  assert.equal(bucket('since_install', 99999999), 'inf');
  assert.equal(bucketIndex('duration_s', 0.5), 0);
  assert.equal(bucketIndex('duration_s', 75), 4);
  assert.equal(bucketIndex('duration_s', 86400), 10);
  assert.equal(bucketIndex('duration_s', 86401), 11);
  for (const bad of [NaN, Infinity, '5', null, undefined]) assert.throws(() => bucket('points', bad), TypeError);
  assert.throws(() => bucket('nope', 1), TelemetrySchemaError);
});

test('SCHEMA_VERSION is the latest revision, and the enums and entries are well formed', () => {
  const revisions = [...Object.values(CATALOG.entries), ...Object.values(CATALOG.enums).flat()].flatMap(item => [item.since, item.until ?? 0]);
  assert.equal(SCHEMA_VERSION, Math.max(...revisions));
  assert.equal(SCHEMA_VERSION, CATALOG.schema_version);
  for (const [name, members] of Object.entries(CATALOG.enums)) {
    assert.ok(members.length > 0, name + ' is empty');
    assert.equal(new Set(members.map(member => member.value + '@' + member.since)).size, members.length, name + ' has a duplicate member');
    assert.deepEqual(enumMembers(name), members.filter(member => member.until === undefined).map(member => member.value));
  }
  for (const [name, entry] of Object.entries(CATALOG.entries)) {
    assert.match(name, /^[a-z]+(\.[a-z_]+)+$/, 'names are dotted lowercase with no brand');
    assert.ok(entry.origins.length > 0 && entry.description);
  }
});

// In-process callers hand parsed objects to the parsers. A hostile object must not run its own code or change between
// the check and the copy (dot review of PR A1, P1-1 and P1-2).
const CANARY = 'CANARY-private-text';
const goldenRecord = name => clone(golden.find(item => item.name === name).record);
const hostileArray = () => Object.assign([], {map: () => [CANARY], every: () => true, reduce: () => 1, filter: () => [CANARY], slice: () => [CANARY]});
const once = (first, later) => { let reads = 0; return {enumerable: true, configurable: true, get: () => (reads++ === 0 ? first : later)}; };

test('hostile objects are rejected before any validation reads them', () => {
  const noLeak = fn => assert.throws(fn, error => error instanceof TelemetrySchemaError && !error.message.includes('CANARY'));
  const counts = goldenRecord('job.duration');
  // Own methods on arrays.
  noLeak(() => parseRecord({...counts, counts: Object.assign([...counts.counts], {every: () => true, reduce: () => 1, map: () => [CANARY]})}, {origin: 'app'}));
  const crash = goldenRecord('app.crash');
  noLeak(() => parseRecord({...crash, attrs: {...crash.attrs, frames: hostileArray()}}, {origin: 'crash'}));
  const batch = JSON.parse(readFileSync(new URL('./telemetry/golden/envelope.old-client.json', import.meta.url), 'utf8'));
  noLeak(() => parseEnvelope({...batch, records: Object.assign([null], {map: () => [CANARY]})}));
  const inbox = golden.find(item => item.inbox).inbox;
  noLeak(() => parseInboxFile({...inbox, record: {...inbox.record, attrs: {...inbox.record.attrs, frames: hostileArray()}}}));
  // Accessors that return a different value on a later read.
  const withGetter = (object, key, first, later) => Object.defineProperty({...object}, key, once(first, later));
  noLeak(() => parseRecord(withGetter(counts, 'origin', 'app', CANARY), {origin: 'app'}));
  noLeak(() => parseRecord(withGetter(counts, 'period', counts.period, CANARY), {origin: 'app'}));
  noLeak(() => parseEnvelope(withGetter(batch, 'stream', 'counts', CANARY)));
  noLeak(() => parseRecord({...counts, attrs: withGetter(counts.attrs, 'job.role', 'lender', CANARY)}, {origin: 'app'}));
  // A getter that throws, a Proxy, symbols, holes, extra array properties, a class instance and a cycle.
  noLeak(() => parseRecord(Object.defineProperty({...counts}, 'value', {enumerable: true, get() { throw new Error(CANARY); }}), {origin: 'app'}));
  noLeak(() => parseRecord(new Proxy({...counts}, {get: () => CANARY, ownKeys: () => ['name'], getOwnPropertyDescriptor: () => ({value: CANARY, enumerable: true, configurable: true})}), {origin: 'app'}));
  noLeak(() => parseRecord({...counts, [Symbol('x')]: 1}, {origin: 'app'}));
  noLeak(() => parseRecord({...counts, counts: [1, , 2]}, {origin: 'app'}));
  noLeak(() => parseRecord({...counts, counts: Object.assign([...counts.counts], {extra: 1})}, {origin: 'app'}));
  noLeak(() => parseRecord(Object.assign(new (class Evil {})(), counts), {origin: 'app'}));
  const loop = {...counts}; loop.attrs = {...counts.attrs, self: loop};
  noLeak(() => parseRecord(loop, {origin: 'app'}));
  noLeak(() => parseRecord({...counts, value: NaN}, {origin: 'app'}));
  noLeak(() => parseRecord({...counts, value: 1n}, {origin: 'app'}));
  let deep = {}; for (let i = 0; i < 50; i++) deep = {x: deep};
  noLeak(() => parseRecord({...counts, attrs: deep}, {origin: 'app'}));
});

test('the parsed value is a fresh copy: changing the input afterwards changes nothing', () => {
  const input = goldenRecord('problem.count');
  const parsed = parseRecord(input, {origin: 'app'});
  input.attrs.component = 'tray'; input.value = 99;
  assert.equal(parsed.attrs.component, 'lender');
  assert.equal(parsed.value, 3);
});

test('proxies are refused before any trap runs, and a wide input is refused before it is copied', () => {
  const calls = [];
  const spy = target => new Proxy(target, new Proxy({}, {get: (_, trap) => (...args) => { calls.push(trap); return Reflect[trap](...args); }}));
  const throwing = new Proxy({}, {ownKeys() { throw new Error(CANARY); }});
  const revoked = (() => { const {proxy, revoke} = Proxy.revocable({}, {}); revoke(); return proxy; })();
  const record = goldenRecord('problem.count');
  const batch = JSON.parse(readFileSync(new URL('./telemetry/golden/envelope.old-client.json', import.meta.url), 'utf8'));
  const inbox = golden.find(item => item.inbox).inbox;
  const inputs = [
    [raw => parseRecord(raw, {origin: 'app'}), [spy({...record}), throwing, revoked, {...record, attrs: spy({...record.attrs})}, {...record, attrs: {...record.attrs, extra: throwing}}]],
    [raw => parseEnvelope(raw), [spy({...batch}), throwing, revoked, {...batch, records: spy([...batch.records])}]],
    [raw => parseInboxFile(raw), [spy({...inbox}), throwing, revoked, {...inbox, record: revoked}]],
  ];
  for (const [parse, list] of inputs) for (const raw of list) {
    assert.throws(() => parse(raw), error => error instanceof TelemetrySchemaError && !error.message.includes('CANARY'));
  }
  assert.deepEqual(calls, [], 'no proxy trap ran');
  // Width is charged before the copy: this array is never walked.
  const started = Date.now();
  assert.throws(() => parseEnvelope({records: new Array(10_000_000).fill(null)}), error => error instanceof TelemetrySchemaError);
  assert.throws(() => parseEnvelope({records: new Array(2 ** 32 - 1)}), error => error instanceof TelemetrySchemaError);
  assert.throws(() => parseRecord({...record, attrs: {...record.attrs, wide: Array.from({length: 100001}, () => 0)}}, {origin: 'app'}), error => error instanceof TelemetrySchemaError);
  assert.ok(Date.now() - started < 2000, 'refused quickly');
  // A full-size legitimate batch still passes.
  const big = JSON.parse(readFileSync(new URL('./telemetry/golden/envelope.counts.json', import.meta.url), 'utf8'));
  const records = Array.from({length: 200}, (_, i) => ({...big.records[0], period: '2026-10-' + String(1 + (i % 28)).padStart(2, '0') + 'T' + String(i % 24).padStart(2, '0')}));
  assert.ok(parseEnvelope({...big, records: records.filter((r, i, all) => all.findIndex(o => o.period === r.period) === i)}));
});

test('deferred is an install outcome from schema 2: its golden record parses at 2 and is refused at 1', () => {
  const text = readGolden('inbox.installer-deferred.json');
  assert.equal(text, canonicalJson(JSON.parse(text)) + '\n', 'the golden is canonical');
  assert.equal(parseInboxFile(text).record.attrs.outcome, 'deferred');
  const older = JSON.parse(text);
  older.schema_version = 1;
  rejects(() => parseInboxFile(JSON.stringify(older)), 'not_member');
});
