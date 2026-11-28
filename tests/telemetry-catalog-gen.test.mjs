import {LENDING_REASONS} from '../lib/v1/lending-reasons.mjs';
import './helpers/no-browser.mjs';
// Where the catalog's enums come from, and how its history is kept (design §2.2, §3.6).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FAILURE_CODES } from '../lib/v1/failures.mjs';
import { READINESS_CHECKS } from '../lib/docker-backend.mjs';
import { LENDING_PRESETS, ACCOUNT_PLANS, normalizeLendingPolicy } from '../lib/v1/lending-policy.mjs';
import { ENTRIES, ENUMS, BUCKET_SETS } from '../lib/v1/telemetry/entries.mjs';
import { createCatalog, parseEnvelope, TelemetrySchemaError, CATALOG } from '../lib/v1/telemetry/catalog.mjs';
import { buildCatalog, readOwners, generated, readCommitted, CATALOG_FILE, shippedFiles } from '../scripts/gen-telemetry-catalog.mjs';
import { readGolden } from './helpers/telemetry-golden.mjs';

const owners = await readOwners();
const committed = readCommitted();
const REMOVED = 'prompt_preview_too_large';
const V = committed.schema_version;
const rejectsAt = (catalog, batch) => assert.throws(() => catalog.parseEnvelope(batch), TelemetrySchemaError);

test('catalog.json is fresh: npm run gen:telemetry changes nothing', async () => {
  assert.equal(await generated(), readFileSync(CATALOG_FILE, 'utf8'), 'run npm run gen:telemetry and commit lib/v1/telemetry/catalog.json');
});

test('generation is idempotent and the module reads the committed file', () => {
  assert.deepEqual(buildCatalog({owners, previous: committed}), committed);
  assert.deepEqual(committed, CATALOG);
});

test('a code removed from its owner stays in the catalog with until, and an old client still validates', () => {
  assert.ok(FAILURE_CODES.includes(REMOVED));
  const smaller = {...owners, failure_code: FAILURE_CODES.filter(code => code !== REMOVED)};
  const next = buildCatalog({owners: smaller, previous: committed});
  assert.equal(next.schema_version, V + 1);
  const member = next.enums.error_type.find(item => item.value === REMOVED);
  assert.deepEqual(member, {value: REMOVED, since: 1, until: V + 1});
  const old = JSON.parse(readGolden('envelope.old-client.json'));
  assert.equal(old.records[0].attrs['error.type'], REMOVED);
  const catalog = createCatalog(next);
  assert.ok(catalog.parseEnvelope(old), 'the old-client fixture validates at its own schema version');
  rejectsAt(catalog, {...old, schema_version: V + 1});
  assert.equal(catalog.enumMembers('error_type', V).includes(REMOVED), true);
  assert.equal(catalog.enumMembers('error_type', V + 1).includes(REMOVED), false);
  // Regenerating from that result changes nothing, and the freshness test would flag the unregenerated file.
  assert.deepEqual(buildCatalog({owners: smaller, previous: next}), next);
  assert.notEqual(JSON.stringify(next), JSON.stringify(committed));
});

test('a code added to its owner is new at the next schema version and unknown before it', () => {
  const larger = {...owners, failure_code: [...FAILURE_CODES, 'brand_new_code']};
  const next = buildCatalog({owners: larger, previous: committed});
  assert.equal(next.schema_version, V + 1);
  assert.deepEqual(next.enums.error_type.find(item => item.value === 'brand_new_code'), {value: 'brand_new_code', since: V + 1});
  assert.ok(next.enums.error_type.filter(item => item.value !== 'brand_new_code').every(item => item.since <= V));
  const catalog = createCatalog(next);
  const batch = JSON.parse(readGolden('envelope.old-client.json'));
  batch.records[0].attrs['error.type'] = 'brand_new_code';
  rejectsAt(catalog, batch);
  assert.ok(catalog.parseEnvelope({...batch, schema_version: V + 1}));
});

test('an entry is append-only: an edit is refused, a removal expires it', () => {
  const edited = ENTRIES.map(entry => entry.name === 'op.count' ? {...entry, attrs: {...entry.attrs, ok: {type: 'int', min: 0, max: 1}}} : entry);
  assert.throws(() => buildCatalog({entries: edited, owners, previous: committed}), /entry op\.count changed/);
  const withDescription = ENTRIES.map(entry => entry.name === 'op.count' ? {...entry, description: 'Reworded.'} : entry);
  assert.equal(buildCatalog({entries: withDescription, owners, previous: committed}).schema_version, committed.schema_version, 'a description is not part of the contract');
  const fewer = buildCatalog({entries: ENTRIES.filter(entry => entry.name !== 'op.duration'), owners, previous: committed});
  assert.equal(fewer.entries['op.duration'].until, V + 1);
  assert.equal(fewer.schema_version, V + 1);
  const record = JSON.parse(readGolden('op.duration.record.json'));
  const batch = JSON.parse(readGolden('envelope.counts.json'));
  const catalog = createCatalog(fewer);
  assert.ok(catalog.parseEnvelope({...batch, records: [record]}), 'valid at schema version 1');
  rejectsAt(catalog, {...batch, schema_version: V + 1, records: [record]});
});

test('a bucket set is append-only', () => {
  assert.throws(() => buildCatalog({bucketSets: {...BUCKET_SETS, points: {bounds: [0, 1, 3]}}, owners, previous: committed}), /bucket set points changed/);
});

test('an entry that names an enum or bucket set that does not exist fails at generation', () => {
  const broken = [{...ENTRIES[0], attrs: {...ENTRIES[0].attrs, component: {type: 'enum', enum: 'nope'}}}];
  assert.throws(() => buildCatalog({entries: broken, owners}), /unknown enum nope/);
  assert.throws(() => buildCatalog({entries: [{...ENTRIES[0], attrs: {x: {type: 'bucket', set: 'nope'}}}], owners}), /unknown bucket set nope/);
  assert.throws(() => buildCatalog({enums: {x: {from: ['nowhere'], extra: []}}, entries: [], owners}), /unknown owner/);
});

test('every check(name, ...) in docker-backend.mjs is in READINESS_CHECKS', () => {
  const source = readFileSync(new URL('../lib/docker-backend.mjs', import.meta.url), 'utf8');
  const used = new Set([...source.matchAll(/\bcheck\(\s*'([a-z_]+)'/g)].map(match => match[1]));
  assert.ok(used.size >= 10);
  assert.deepEqual([...used].filter(name => !READINESS_CHECKS.includes(name)), []);
  assert.deepEqual(READINESS_CHECKS.filter(name => !used.has(name)), [], 'READINESS_CHECKS lists a name the module never reports');
});

test('the lending preset and plan lists are the ones the policy validates against', () => {
  for (const preset of LENDING_PRESETS) assert.equal(normalizeLendingPolicy({strategy: preset}).strategy, preset);
  assert.throws(() => normalizeLendingPolicy({strategy: 'nope'}));
  for (const plan of ACCOUNT_PLANS) assert.equal(normalizeLendingPolicy({accountPlans: {claude: plan, codex: 'unknown'}}).accountPlans.claude, plan);
  assert.throws(() => normalizeLendingPolicy({accountPlans: {claude: 'nope', codex: 'unknown'}}));
});

test('public offer reasons come from the one closed lending vocabulary',()=>{
  assert.deepEqual(ENUMS.offer_reason.extra,Object.keys(LENDING_REASONS));
});

test('error_type is exactly the failure codes, the problem codes and unknown', () => {
  const members = new Set(CATALOG.enums.error_type.filter(member => member.until === undefined).map(member => member.value));
  for (const code of [...owners.failure_code, ...owners.problem_code, 'unknown']) assert.ok(members.has(code), code);
  assert.equal(members.size, new Set([...owners.failure_code, ...owners.problem_code, 'unknown']).size);
});

test('crash frames name only shipped files: bin/faravan* and lib/**/*.mjs', () => {
  const files = shippedFiles();
  assert.ok(files.includes('bin/faravan') && files.includes('lib/v1/app.mjs') && files.includes('lib/v1/telemetry/catalog.mjs'));
  assert.ok(files.every(file => /^(bin\/faravan[\w-]*|lib\/.+\.mjs)$/.test(file)), 'only entry points and runtime modules');
  assert.ok(!files.some(file => file.startsWith('tests/') || file.includes('node_modules')));
  assert.deepEqual(CATALOG.enums.shipped_file.filter(member => member.until === undefined).map(member => member.value), files.slice().sort());
});

test('names carry no brand and no entry is declared twice', () => {
  const names = ENTRIES.map(entry => entry.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(!names.some(name => /faravan|faravan/i.test(name)));
});

test('every declared enum and bucket set is used by an entry', () => {
  const enums = new Set(), sets = new Set();
  const walk = type => {
    if (type.type === 'enum') enums.add(type.enum);
    if (type.type === 'bucket') sets.add(type.set);
    if (type.type === 'list') walk(type.of);
    if (type.type === 'record') Object.values(type.fields).forEach(walk);
  };
  for (const entry of ENTRIES) { Object.values(entry.attrs).forEach(walk); if (entry.buckets) sets.add(entry.buckets); }
  assert.deepEqual(Object.keys(ENUMS).filter(name => !enums.has(name)), []);
  assert.deepEqual(Object.keys(BUCKET_SETS).filter(name => !sets.has(name)), []);
});

test('a member that is retired and returns keeps every stay, and a retired entry cannot return', () => {
  const without = {...owners, failure_code: FAILURE_CODES.filter(code => code !== REMOVED)};
  const v2 = buildCatalog({owners: without, previous: committed});
  const v3 = buildCatalog({owners, previous: v2});
  assert.equal(v3.schema_version, V + 2);
  assert.deepEqual(v3.enums.error_type.filter(item => item.value === REMOVED), [{value: REMOVED, since: 1, until: V + 1}, {value: REMOVED, since: V + 2}]);
  const catalog = createCatalog(v3);
  const old = JSON.parse(readGolden('envelope.old-client.json'));
  assert.ok(catalog.parseEnvelope(old), 'valid at version 1, where the first stay was live');
  rejectsAt(catalog, {...old, schema_version: V + 1});
  assert.ok(catalog.parseEnvelope({...old, schema_version: V + 2}), 'valid again after it returned');
  assert.deepEqual(buildCatalog({owners, previous: v3}), v3, 'idempotent');
  // Removed a second time: the second stay is closed, the first is untouched.
  const v4 = buildCatalog({owners: without, previous: v3});
  assert.deepEqual(v4.enums.error_type.filter(item => item.value === REMOVED), [{value: REMOVED, since: 1, until: V + 1}, {value: REMOVED, since: V + 2, until: V + 3}]);
  assert.ok(createCatalog(v4).parseEnvelope(old) && createCatalog(v4).parseEnvelope({...old, schema_version: V + 2}));
  const retired = buildCatalog({entries: ENTRIES.filter(entry => entry.name !== 'op.duration'), owners, previous: committed});
  assert.throws(() => buildCatalog({owners, previous: retired}), new RegExp('op\\.duration was retired at schema_version ' + (V + 1)));
});
