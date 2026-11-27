#!/usr/bin/env node
// Regenerate lib/v1/telemetry/catalog.json from lib/v1/telemetry/entries.mjs and from the code that owns each enum.
// `npm run gen:telemetry`; tests/telemetry-catalog-gen.test.mjs fails when the committed file is stale.
// --check exits 1 when the file is out of date, without writing.
//
// The generator merges the committed file, so history is never lost (design §2.2, §3.6): an enum member or entry that
// disappears from its owner is kept with `until`, and any addition or removal raises schema_version by one. A changed
// entry or bucket set is refused: change means a new name.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAILURE_CODES } from '../lib/v1/failures.mjs';
import { OPS } from '../lib/v1/ops/registry.mjs';
import { ROUTES } from '../ui/v1/src/helpers.mjs';
import { READINESS_CHECKS } from '../lib/docker-backend.mjs';
import { LENDING_PRESETS, ACCOUNT_PLANS } from '../lib/v1/lending-policy.mjs';
import { CHARGED_STOP_REASONS } from '../lib/v1/lending-ledger.mjs';
import { ENTRIES, ENUMS, BUCKET_SETS } from '../lib/v1/telemetry/entries.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const CATALOG_FILE = join(ROOT, 'lib/v1/telemetry/catalog.json');
export const DEFAULT_MAX_PER_PERIOD = 100000;

/** The Node files that packaging/stage-app.sh ships (bin/faravan* entry points with a node shebang, every .mjs file under lib/): crash frames name only these. A source checkout uses the same list. */
export function shippedFiles(root = ROOT) {
  const walk = directory => readdirSync(join(root, directory)).sort().flatMap(name => {
    const relative = directory + '/' + name;
    return statSync(join(root, relative)).isDirectory() ? walk(relative) : [relative];
  });
  const isNodeEntry = name => name.startsWith('faravan') && statSync(join(root, 'bin', name)).isFile() && readFileSync(join(root, 'bin', name), 'utf8').startsWith('#!/usr/bin/env node');
  const bin = readdirSync(join(root, 'bin')).filter(isNodeEntry).map(name => 'bin/' + name);
  return [...bin, ...walk('lib').filter(file => file.endsWith('.mjs'))];
}

/** Owner registries by name. PROBLEM_CODES is read once lib/v1/problem.mjs (origin/cycle3-problem-catalog) is merged; until then it is empty. */
export async function readOwners(root = ROOT) {
  const problem = join(root, 'lib/v1/problem.mjs');
  return {
    failure_code: FAILURE_CODES,
    problem_code: existsSync(problem) ? (await import(problem)).PROBLEM_CODES : [],
    op_id: OPS.map(op => op.id),
    route: Object.keys(ROUTES),
    readiness_check: READINESS_CHECKS,
    lending_preset: LENDING_PRESETS,
    account_plan: ACCOUNT_PLANS,
    charged_stop_reason: CHARGED_STOP_REASONS,
    shipped_file: shippedFiles(root),
    catalog_entry: ENTRIES.map(entry => entry.name),
  };
}

const sorted = list => [...new Set(list)].sort();
const definitionOf = entry => {
  const {description, since, until, ...definition} = entry;
  return JSON.stringify(definition);
};
function typesIn(type, out = []) {
  out.push(type);
  if (type.type === 'list') typesIn(type.of, out);
  if (type.type === 'record') Object.values(type.fields).forEach(field => typesIn(field, out));
  return out;
}

/**
 * Pure: declared entries, enum specs, bucket sets and the owners' current members -> the catalog document.
 * `previous` is the committed document, or null for the first one.
 */
export function buildCatalog({entries = ENTRIES, enums = ENUMS, bucketSets = BUCKET_SETS, owners, previous = null}) {
  const members = Object.fromEntries(Object.entries(enums).map(([name, spec]) => [name, sorted([
    ...spec.from.flatMap(owner => owners[owner] ?? (() => { throw new Error('enum ' + name + ' reads unknown owner ' + owner); })()), ...spec.extra])]));
  const declared = new Map();
  for (const entry of entries) {
    if (declared.has(entry.name)) throw new Error('duplicate entry ' + entry.name);
    for (const type of Object.values(entry.attrs).flatMap(attr => typesIn(attr))) {
      if (type.type === 'enum' && !members[type.enum]) throw new Error(entry.name + ' uses unknown enum ' + type.enum);
      if (type.type === 'bucket' && !bucketSets[type.set]) throw new Error(entry.name + ' uses unknown bucket set ' + type.set);
    }
    if (entry.buckets && !bucketSets[entry.buckets]) throw new Error(entry.name + ' uses unknown bucket set ' + entry.buckets);
    const counted = entry.kind === 'sum' || entry.kind === 'histogram';
    declared.set(entry.name, counted ? {...entry, maxPerPeriod: entry.maxPerPeriod ?? DEFAULT_MAX_PER_PERIOD} : entry);
  }

  let changed = previous === null;
  const version = (previous?.schema_version ?? 0) + 1;
  const outEnums = {}, outEntries = {}, outSets = {};

  for (const [name, wanted] of Object.entries(members)) {
    // One object per interval of membership: a value that was retired and returned keeps its first stay.
    const before = new Map();
    for (const member of previous?.enums[name] ?? []) before.set(member.value, [...(before.get(member.value) ?? []), member]);
    const list = [];
    for (const value of wanted) {
      const stays = before.get(value) ?? [];
      list.push(...stays);
      if (!stays.some(stay => stay.until === undefined)) { list.push({value, since: version}); changed = true; }
    }
    for (const [value, stays] of before) {
      if (wanted.includes(value)) continue;
      for (const stay of stays) {
        if (stay.until === undefined) { list.push({...stay, until: version}); changed = true; } else list.push(stay);
      }
    }
    outEnums[name] = list.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : a.since - b.since));
  }
  for (const name of Object.keys(previous?.enums ?? {})) if (!outEnums[name]) outEnums[name] = previous.enums[name];

  for (const [name, set] of Object.entries(bucketSets)) {
    const old = previous?.bucket_sets[name];
    if (old && JSON.stringify(old) !== JSON.stringify(set)) throw new Error('bucket set ' + name + ' changed: add a new set instead');
    outSets[name] = set;
  }
  for (const [name, set] of Object.entries(previous?.bucket_sets ?? {})) outSets[name] ??= set;

  for (const [name, entry] of declared) {
    const old = previous?.entries[name];
    const {name: _, ...body} = entry;
    if (old?.until !== undefined) throw new Error('entry ' + name + ' was retired at schema_version ' + old.until + ': a retired name cannot return, add a new name');
    if (old && definitionOf(old) !== definitionOf(body)) throw new Error('entry ' + name + ' changed: add a new name and let the old one expire');
    if (old) outEntries[name] = {...body, since: old.since, description: body.description};
    else { outEntries[name] = {...body, since: version}; changed = true; }
  }
  for (const [name, old] of Object.entries(previous?.entries ?? {})) {
    if (declared.has(name)) continue;
    if (old.until === undefined) { outEntries[name] = {...old, until: version}; changed = true; } else outEntries[name] = old;
  }

  const schemaVersion = changed ? version : previous.schema_version;
  return {format: 'faravan-telemetry-catalog', schema_version: schemaVersion, bucket_sets: sortKeys(outSets), enums: sortKeys(outEnums), entries: sortKeys(outEntries)};
}
const sortKeys = object => Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]]));

/** One member or entry per line, so a reviewer sees what a regeneration added or removed. */
export function formatCatalog(catalog) {
  const lines = ['{', ' "format": ' + JSON.stringify(catalog.format) + ',', ' "schema_version": ' + catalog.schema_version + ',',
    ' "bucket_sets": ' + JSON.stringify(catalog.bucket_sets) + ',', ' "enums": {'];
  const names = Object.keys(catalog.enums);
  names.forEach((name, i) => {
    lines.push('  ' + JSON.stringify(name) + ': [');
    catalog.enums[name].forEach((member, j, all) => lines.push('   ' + JSON.stringify(member) + (j < all.length - 1 ? ',' : '')));
    lines.push('  ]' + (i < names.length - 1 ? ',' : ''));
  });
  lines.push(' },', ' "entries": {');
  const entryNames = Object.keys(catalog.entries);
  entryNames.forEach((name, i) => lines.push('  ' + JSON.stringify(name) + ': ' + JSON.stringify(catalog.entries[name]) + (i < entryNames.length - 1 ? ',' : '')));
  lines.push(' }', '}', '');
  return lines.join('\n');
}

export function readCommitted(file = CATALOG_FILE) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}
export async function generated({file = CATALOG_FILE} = {}) {
  return formatCatalog(buildCatalog({owners: await readOwners(), previous: readCommitted(file)}));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const next = await generated();
  const current = existsSync(CATALOG_FILE) ? readFileSync(CATALOG_FILE, 'utf8') : '';
  if (process.argv.includes('--check')) {
    if (next !== current) { console.error('Out of date (run npm run gen:telemetry): lib/v1/telemetry/catalog.json'); process.exit(1); }
  } else {
    if (next !== current) writeFileSync(CATALOG_FILE, next);
    console.log(next !== current ? 'Wrote lib/v1/telemetry/catalog.json' : 'Up to date.');
  }
}
