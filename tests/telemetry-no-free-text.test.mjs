import './helpers/no-browser.mjs';
// No input string can reach the wire. A seeded generator builds 10,000+ random observations of every kind, each with
// canaries in its string fields, and runs them through the whole pipeline to the request bodies (design §4.2, §6).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { makeTelemetry, manualClock, captureTransport, START } from './helpers/telemetry-harness.mjs';
import {POSTHOG_TOKEN} from '../lib/v1/telemetry/contract.mjs';
import { CATALOG, ID_PATTERNS, VERSION_RE, canonicalJson, enumMembers, parseRecord } from '../lib/v1/telemetry/catalog.mjs';

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const CANARIES = [
  'sk-ant-api03-Zq9XyW8vU7tS6rQ5pO4nM3lK2jI1hG0fEdCbAaZ', 'ghp_aB3dE5gH7jK9mN1pQ3sT5vX7zB9dF1hJ3kL5', 'AKIAIOSFODNN7EXAMPLE', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.sig',
  '/home/alice/projects/secret/app.js', 'C:\\Users\\Alice\\Documents\\x', 'git@github.com:alice/private-repo.git', 'https://github.com/alice/private-repo.git', 'alice@example.com',
  'Please refactor my payroll system and email the results', 'sha256:' + 'ab'.repeat(32), 'attempt-7f3c91e2', 'SPK-AB12', 'Ann’s MacBook Pro', 'hostname.local',
  'ＡＢＣ', 'a\u200Bb', 'e\u0301', '‮txt.exe', '%2Fhome%2Falice%2F.ssh', '%00', '\\u0041', '&#47;home&#47;alice', "'; DROP TABLE x;--", '<script>alert(1)</script>', '', ' ', 'x'.repeat(3000),
  'Error: ENOENT /home/alice/.config/secret\n    at /home/alice/app/node_modules/x.js:1:1',
];
const FIELD_NAMES = ['code', 'message', 'path', 'apply_code', 'repo_code', 'title', 'name', 'label', 'reason', 'state', 'status', 'target', 'harness', 'harness_id', 'kind', 'op', 'opId', 'route', 'action',
  'provider', 'plan', 'preset', 'mode', 'outcome', 'owner', 'version', 'currentVersion', 'candidate', 'check', 'id', 'stack', 'error', 'job_digest', 'digest', 'account', 'current', 'flowId', 'surface', 'area', 'stage'];

/** A value for a string field: mostly a canary, sometimes a value that looks valid. */
function text(rand, valid = []) {
  const pool = rand() < 0.2 && valid.length ? valid : CANARIES;
  return pool[Math.floor(rand() * pool.length)];
}
const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const num = rand => pick(rand, [0, 1, 5, 99, 3600, 86400, 1e9, -1, 0.5, NaN, Infinity, 2 ** 40]);

/** An object with canary strings under many field names, plus a few numbers and nested objects. */
function junk(rand, depth = 0) {
  const out = {};
  for (const key of FIELD_NAMES) if (rand() < 0.35) out[key] = rand() < 0.15 ? num(rand) : text(rand);
  if (depth < 2 && rand() < 0.4) out.job = {payload: junk(rand, depth + 1), digest: text(rand)};
  if (depth < 2 && rand() < 0.3) out.parts = Array.from({length: Math.floor(rand() * 4)}, () => junk(rand, depth + 1));
  if (rand() < 0.3) out.slots = Array.from({length: 28}, () => ({o: pick(rand, [null, 1, 5, 'x', text(rand)]), l: pick(rand, [null, 0, 2, text(rand)])}));
  if (rand() < 0.3) out.charges = Array.from({length: 3}, () => ({points: num(rand), stopReason: text(rand, ['done', 'budget'])}));
  return out;
}
const validKinds = {
  response: rand => ({status: pick(rand, [200, 400, 401, 404, 409, 429, 500, 'x']), body: pick(rand, [junk(rand), 'a string', [text(rand)], null]), opId: text(rand, ['jobs.apply', 'jobs.list']),
    surface: text(rand, ['cli', 'mcp']), writer: text(rand, ['app', 'ops', 'phone']), area: text(rand, ['jobs', 'lending']), durationMs: num(rand), fromRest: rand() < 0.5}),
  'lender-failure': rand => ({code: text(rand, ['lease_expired', 'sandbox_start_failed']), phase: text(rand, ['prepare', 'run']), message: text(rand), job: text(rand), ref: text(rand)}),
  health: rand => ({...junk(rand), readiness: {checks: [{name: text(rand, ['docker_login', 'kvm_access']), ok: pick(rand, [true, false, 'x'])}]}, install: junk(rand), notifications: junk(rand), history: junk(rand), milestones: [text(rand, ['docker_ready'])]}),
  ui: rand => ({kind: text(rand, ['dead_end', 'error_banner']), route: text(rand, ['home', 'jobs', 'setup']), op: text(rand, ['jobs.list']), code: text(rand, ['unauthorized']), action: text(rand, ['setup', 'wait']), title: text(rand)}),
};
/** A field value: a valid one, or (about 45% of the time) a canary. */
const field = (rand, valid) => (rand() < 0.45 ? text(rand) : pick(rand, valid));
const iso = (rand, offset = 0) => (rand() < 0.2 ? text(rand) : new Date(START + offset * 1000).toISOString());
const DIGEST = rand => field(rand, ['sha256:' + '1'.repeat(64), 'sha256:' + '2'.repeat(64)]);
const structured = {
  'event:job': rand => ({job_digest: DIGEST(rand), state: field(rand, ['queued', 'claimed', 'result-accepted', 'failed', 'expired', 'cancelled']), attempts_started: pick(rand, [0, 1, 2, num(rand)]),
    waiting_reason: field(rand, ['lease_expired', 'retry_exhausted']), deleted: rand() < 0.05,
    current_attempt: {claimed_at: iso(rand, 240), execution_started_at: iso(rand, 300), reason: {code: field(rand, ['lease_expired', 'retry_exhausted'])}},
    job: {payload: {created_at: iso(rand), expires_at: iso(rand, 21600), requirements: {harness: pick(rand, [[], [field(rand, ['codex', 'claude-code'])], [text(rand), text(rand)]]), egress: field(rand, ['internet', 'provider-only'])},
      source: {kind: field(rand, ['git', 'files_v1', 'archive', 'none'])}, result: {kind: field(rand, ['branch', 'message', 'files'])}, verify: rand() < 0.5 ? {cmd: text(rand)} : undefined}}}),
  'event:lending': rand => ({account: field(rand, ['codex:0', 'claude:0', 'claude:1']), status: field(rand, ['preparing', 'accepting', 'running', 'sending-result', 'finished', 'failed', 'stopped', 'declined', 'preparation-failed']),
    reason: field(rand, ['lease_expired', 'stopped_by_lender', 'cancelled', 'completion_unknown']), stopReason: field(rand, ['done', 'budget', 'time']), label: text(rand)}),
  'event:setup-test': rand => ({state: field(rand, ['running', 'passed', 'failed', 'waits', 'cancelled']), failed_check: text(rand),
    parts: Array.from({length: Math.floor(rand() * 4)}, () => ({id: field(rand, ['codex:sandbox', 'codex:isolation', 'codex:agent']), status: field(rand, ['passed', 'failed', 'skipped']), elapsed_ms: pick(rand, [10, 5000, num(rand)]), label: text(rand)}))}),
  'event:signin': rand => ({flowId: field(rand, ['f1', 'f2']), target: field(rand, ['codex', 'claude-code-subscription']), status: field(rand, ['starting', 'complete', 'failed', 'cancelled', 'timed_out', 'awaiting_browser']), url: text(rand), code: text(rand)}),
  'event:update': rand => ({state: field(rand, ['checking', 'available', 'applied', 'staged', 'failed', 'rolled_back', 'current']), owner: field(rand, ['faravan', 'apt', 'brew']),
    currentVersion: field(rand, ['0.1.0', '0.1.0-preview.20261019.6']), candidate: field(rand, ['0.1.1', '0.1.0-preview.20261020.7']), error: text(rand)}),
  'event:offer-decision': rand => ({offerKey: text(rand), outcome: field(rand, ['admitted_auto', 'declined_manual', 'ineligible', 'hidden']), reason: field(rand, ['quota_unknown', 'agent_signed_out', 'daily_limit', 'none']),
    harness: field(rand, ['claude-code', 'codex']), mode: field(rand, ['ask', 'auto', 'rule']), wallSeconds: pick(rand, [60, 900, num(rand)]), deadline: pick(rand, [3600, num(rand)]), mapOverflow: pick(rand, [0, 3, num(rand)])}),
  'event:quota-window': rand => ({provider: field(rand, ['claude', 'codex']), windowKind: field(rand, ['seven_day', 'five_hour']), plan: field(rand, ['plus', 'max5', 'unknown']), lendingOn: rand() < 0.5,
    ownerUsedPct: pick(rand, [0, 50, 100, num(rand)]), lentPoints: pick(rand, [0, 3, num(rand)]), unusedPct: pick(rand, [0, 40, num(rand)]), shortfall: rand() < 0.5, coverage: pick(rand, [0.5, 1, num(rand)]),
    contaminated: rand() < 0.5, history: pick(rand, [0, 4, num(rand)]), slots: Array.from({length: 28}, () => ({o: pick(rand, [null, 0, 1, 7, text(rand)]), l: pick(rand, [null, 0, 2])})),
    charges: Array.from({length: 2}, () => ({points: pick(rand, [0.5, 3, num(rand)]), stopReason: field(rand, ['done', 'budget'])}))}),
};
const eventKinds = ['approval', 'phone', 'enrollment', 'agents'];

function legalStrings() {
  const strings = new Set([POSTHOG_TOKEN,'api_key','batch','event','distinct_id','uuid','timestamp','properties','app_version','surface','$geoip_disable','faravan-telemetry', 'counts', 'diagnostics', 'quota', 'event', 'span', 'ok', 'error', 'linux', 'darwin', 'windows', 'amd64', 'arm64', 'stable', 'preview', 'inf',
    ...Object.keys(CATALOG.entries)]);
  for (const entry of Object.values(CATALOG.entries)) {
    for (const key of ['period', 'buckets']) if (entry[key]) strings.add(entry[key]);
    const walk = (type, name) => {
      if (type.type === 'list') walk(type.of);
      if (type.type === 'record') for (const [key, field] of Object.entries(type.fields)) { strings.add(key); walk(field); }
    };
    for (const [key, type] of Object.entries(entry.attrs)) { strings.add(key); walk(type); }
  }
  for (const key of ['schema', 'schema_version', 'batch_id', 'stream', 'resource', 'records', 'name', 'attrs', 'period', 'value', 'buckets', 'counts', 'kind', 'hour', 'rid', 'epoch', 'session', 'trace',
    'seq', 'duration_ms', 'status', 'origin', 'service.name', 'service.version', 'service.version_minor', 'deployment.environment.name', 'os.type', 'host.arch', 'os.major', 'app', 'tray', 'coordinator',
    'installer', 'ui', 'phone', 'crash']) strings.add(key);
  for (const name of Object.keys(CATALOG.enums)) for (const m of enumMembers(name)) strings.add(m);
  for (const set of Object.values(CATALOG.bucket_sets)) {
    set.bounds.forEach((bound, i) => strings.add(set.labels?.[i] ?? String(bound)));
  }
  return strings;
}
const PERIOD = /^\d{4}-\d{2}-\d{2}(T\d{2})?$/;
const isLegal = (value, legal) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(value) || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || legal.has(value) || VERSION_RE.test(value) || PERIOD.test(value) || Object.values(ID_PATTERNS).some(re => re.test(value)) || /^\d+\.\d+$/.test(value);
function* strings(value) {
  if (typeof value === 'string') yield value;
  else if (Array.isArray(value)) for (const item of value) yield* strings(item);
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { yield key; yield* strings(item); }
}

test('10,000 random inputs with canaries in every string reach the wire as catalog values only', async () => {
  const rand = rng(20261021), legal = legalStrings();
  const bodies = [];
  const gzipped = [];
  const transport = async (url, init) => { const buf = init.body; gzipped.push(buf); bodies.push(JSON.parse(require_gunzip(buf))); return {status: 200, headers: new Headers(), body: null}; };
  let inputs = 0;
  for (let round = 0; round < 20; round++) {
    const h = makeTelemetry({transport, clock: manualClock(START), seed: round + 1, health: () => junk(rand)});
    for (let i = 0; i < 520; i++) {
      h.clock.advance(Math.floor(rand() * 60000));
      const kinds = [...Object.keys(validKinds), ...Object.keys(structured), ...eventKinds.map(k => 'event:' + k)];
      const kind = pick(rand, kinds);
      const data = structured[kind] ? structured[kind](rand) : kind.startsWith('event:') ? junk(rand) : validKinds[kind](rand);
      h.tel.observe(kind, data, rand() < 0.1 ? {origin: pick(rand, ['ui', 'phone'])} : {});
      if (rand() < 0.05) h.tel.response({writer: pick(rand, ['app', 'ops', 'phone']), req: {url: '/api/' + text(rand), headers: {'faravan-surface': text(rand)}}, status: pick(rand, [400, 409, 500]), body: junk(rand), opId: text(rand), fromRest: rand() < 0.5});
      inputs++;
    }
    // Files from outside producers carry canaries too; they are validated and mostly dropped.
    mkdirSync(join(h.dir, 'inbox'), {recursive: true});
    for (let i = 0; i < 20; i++) {
      const record = {name: text(rand, ['app.crash', 'health.state']), kind: text(rand, ['event']), hour: text(rand, ['2026-10-21T19']), attrs: junk(rand)};
      writeFileSync(join(h.dir, 'inbox', 'f' + i + '.json'), canonicalJson({format: 'faravan-telemetry-inbox', schema_version: 1, origin: text(rand, ['tray', 'crash']), gen: h.tel.status().generation, record}));
      inputs++;
    }
    h.tel.ingestInbox();
    h.clock.advance(3 * 86400000);
    h.tel.tick();
    h.clock.advance(60 * 60000);
    await h.tel.flushNow();
    h.clock.advance(60 * 60000);
    await h.tel.flushNow();
    h.cleanup();
  }
  assert.ok(inputs >= 10000, 'inputs: ' + inputs);
  assert.ok(bodies.length > 0, 'something was uploaded');
  let checked = 0;
  for (const body of bodies) {
    assert.equal(body.api_key,POSTHOG_TOKEN);assert.deepEqual(Object.keys(body).sort(),['api_key','batch']);
    for(const event of body.batch){
      const entry=CATALOG.entries[event.event];assert.ok(entry);
      const {schema_version,app_version,surface,$geoip_disable,...properties}=event.properties;
      const attrs=Object.fromEntries(Object.entries(properties).filter(([key])=>Object.hasOwn(entry.attrs,key)));
      if(entry.attrs.surface)attrs.surface=surface;
      const record={name:event.event,attrs,...Object.fromEntries(Object.entries(properties).filter(([key])=>!Object.hasOwn(entry.attrs,key)))};
      if(['event','span'].includes(entry.kind))Object.assign(record,{kind:entry.kind,rid:'r-AAAAAAAAAAAAAAAAAAAA',epoch:'e-AAAAAAAAAAAAAAAAAAAA',session:'s-AAAAAAAAAAAAAAAAAAAA',seq:1,...(entry.kind==='span'?{trace:'t-AAAAAAAAAAAAAAAAAAAA'}:{})});
      assert.equal($geoip_disable,true);parseRecord(record,{origin:entry.origins[0]});
    }
    for (const value of strings(body)) {
      checked++;
      assert.ok(isLegal(value, legal), 'a string outside the catalog reached the wire: ' + JSON.stringify(value).slice(0, 80));
    }
  }
  const everything = bodies.map(body => JSON.stringify(body)).join('\n');
  for (const canary of CANARIES.filter(c => c.length > 3 && c.length < 300)) {
    assert.ok(!everything.includes(canary) && !everything.includes(encodeURIComponent(canary)), 'canary on the wire: ' + canary.slice(0, 40));
  }
  assert.ok(checked > 1000, 'strings checked: ' + checked);
  const names = new Set(bodies.flatMap(body => body.batch.map(event=>event.event)));
  console.log('bodies', bodies.length, 'records', bodies.reduce((n, b) => n + b.batch.length, 0), 'names', names.size, [...names].sort().join(' '));
  assert.ok(names.size >= 10, 'the generator reached many entries: ' + [...names].join(', '));
});

import { gunzipSync } from 'node:zlib';
function require_gunzip(buffer) { return gunzipSync(buffer).toString(); }
