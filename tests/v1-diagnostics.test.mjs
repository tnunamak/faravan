import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, writeFile, stat, symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {supportPreview, saveSupportArchive, SUPPORT_SCHEMA, SUPPORT_LIMITS, supportReadiness, createSupportReadinessCache} from '../lib/v1/diagnostics.mjs';
import {runDiagnosticsCommand} from '../lib/v1/diagnostics-cli.mjs';
import {readArchiveFiles} from '../lib/archive.mjs';
import {check} from '../lib/v1/ops/schema.mjs';
import {runOp, createOpsClient} from '../lib/v1/ops/execute.mjs';
import {startApp} from '../lib/v1/app.mjs';
import {syntheticBackend} from './helpers/v1-app-fixture.mjs';
import {makeTelemetry, settle} from './helpers/telemetry-harness.mjs';

const BIN = fileURLToPath(new URL('../bin/faravan', import.meta.url));
const ID = 'sha256:' + 'a'.repeat(64), OTHER = 'sha256:' + 'b'.repeat(64);
const AT = '2026-10-28T00:00:00.000Z';
// These are invented canaries, never values from a real profile.
const CANARIES = ['PLANTED_SECRET_4c86', 'PLANTED_PROMPT_4c86', 'PLANTED_TRANSCRIPT_4c86', 'private-host-4c86.internal',
  'private-4c86@example.invalid', 'PLANTED_COOKIE_4c86', 'https://invite.invalid/#PLANTED_INVITE_4c86',
  'PLANTED_CODE_4c86', 'PLANTED_RESULT_4c86', 'private-file-4c86.ts', 'PLANTED_MEMBER_4c86'];
const poison = Object.fromEntries(CANARIES.map((value, index) => ['private_' + index, value]));
const packedPoison = CANARIES.join(' ');
const factsOf = preview => JSON.parse(preview.entries[0].body);
const capture = () => ({text:'', write(text) {this.text += text; return true;}});
// Independent previews have different aliases; compare all other facts and alias relationships.
function comparableFacts(facts) {
  const aliases = new Map();
  return JSON.parse(JSON.stringify(facts, (_key, value) => {
    if (typeof value !== 'string' || !/^job:[0-9a-f]{32}$/.test(value)) return value;
    if (!aliases.has(value)) aliases.set(value, 'job:' + aliases.size);
    return aliases.get(value);
  }));
}

// Intentionally retained on disk for review; this lane does not delete scratch.
async function fixture() {
  const scratch = fileURLToPath(new URL('../test-artifacts/support-export/', import.meta.url));
  await mkdir(scratch, {recursive:true});
  const root = await mkdtemp(join(scratch, 'case-'));
  const home = join(root, 'profile'), installRoot = join(root, 'install');
  await mkdir(join(home, 'v1', 'owner-settings'), {recursive:true});
  await mkdir(join(home, 'v1', 'history'), {recursive:true});
  await mkdir(installRoot);
  const put = async (path, value) => writeFile(join(home, 'v1', path), typeof value === 'string' ? value : JSON.stringify(value));
  await put('app-settings.json', {...poison, version:1, name:packedPoison, ownerName:packedPoison, token:packedPoison,
    enabled:false, intent:'off', paused:true, agents:{codex:true, claude:false, ...poison}, modes:{[packedPoison]:'ask'},
    limits:{dailyJobs:3, dailyMinutes:60, maxWallSeconds:1200, idleOnly:true, timeZone:packedPoison, ...poison,
      lendingPolicy:{strategy:'automatic', accountSlots:1, providerConsent:{codex:true, ...poison}, ...poison}}});
  await put('owner-settings/owner-settings.json', {version:1, values:{maxJobUsd:2, ...poison},
    audit:[{by:packedPoison, reason:packedPoison, ...poison}], ...poison});
  await put('support-readiness.json', {observed_at:AT, ready:false, backend_id:'docker-sbx', sbx_version:'0.47.0',
    version_compatible:true, checks:[{name:'docker_login', ok:false, diagnostics:packedPoison, ...poison}], ...poison});
  await put('sandbox-test.json', {state:'failed', at:AT, versions:{faravan:'0.1.0', sbx:'0.47.0', adapters:{codex:'1.2.3', ...poison}, ...poison},
    parts:[{id:'codex:credentials', status:'failed', detail_code:'credential_probe_no_report', label:packedPoison, ...poison}], ...poison});
  await put('history/events.jsonl', [
    {id:1, at:AT, type:'job', job:ID, circle:packedPoison, data:{state:'queued', author:packedPoison, prompt:packedPoison, ...poison}, ...poison},
    {id:2, at:AT, type:'lending', data:{status:'paused', reason:'paused', currentRequester:packedPoison, ...poison}, ...poison},
    {id:3, at:AT, type:'job', data:{job_digest:ID, state:'result-accepted', result:packedPoison, ...poison}, ...poison},
    {id:4, at:AT, type:'job', job:OTHER, data:{state:'failed', reason:'network_error', transcript:packedPoison, ...poison}, ...poison},
    {id:5, at:AT, type:packedPoison, job:packedPoison, data:poison},
  ].map(JSON.stringify).join('\n') + '\n');
  await put('lending-errors.jsonl', JSON.stringify({at:AT, job:ID, code:'network_error', phase:'result', message:packedPoison, ...poison}) + '\n');
  await writeFile(join(installRoot, 'VERSION'), '0.1.0-preview.20261028.1');
  await writeFile(join(installRoot, '.installed-via'), 'faravan');
  // Stores the collector must never read, even though they contain useful-looking metadata.
  await put('job-meta.json', {[ID]:{prompt:packedPoison, title:packedPoison, sourcePath:packedPoison}});
  await put('app.json', {token:packedPoison, host:packedPoison, port:1, pid:process.pid});
  await put('state.json', {circles:[{name:packedPoison, origin:packedPoison, members:[poison]}]});
  await put('app-counters.json', {pending:{jobId:ID, prompt:packedPoison, transcript:packedPoison}, ...poison});
  await put('sessions.json', poison);
  return {root, home, installRoot, put};
}

function assertBoundary(preview) {
  const archive = Buffer.from(preview.archiveBase64, 'base64');
  const inflated = gunzipSync(archive);
  const files = readArchiveFiles(archive);
  assert.deepEqual(files.map(file => file.path), ['support.json']);
  assert.equal(files[0].bytes.toString(), preview.entries[0].body);
  for (const canary of [...CANARIES, ID, OTHER]) {
    assert.equal(archive.includes(Buffer.from(canary)), false, 'compressed archive excludes canary');
    assert.equal(inflated.includes(Buffer.from(canary)), false, 'tar names, headers and contents exclude canary');
    assert.equal(JSON.stringify(preview).includes(canary), false, 'preview excludes canary');
  }
  assert.equal(check(SUPPORT_SCHEMA, factsOf(preview)), null);
}

test('real saved archive excludes planted private content in every input store and excluded stores', async () => {
  const f = await fixture(), preview = await supportPreview(f);
  await saveSupportArchive(preview, join(f.root, 'support.tar.gz'));
  assert.deepEqual(await readFile(join(f.root, 'support.tar.gz')), Buffer.from(preview.archiveBase64, 'base64'));
  assertBoundary(preview);
  const facts = factsOf(preview);
  assert.equal(facts.settings.limits.dailyJobs, 3);
  assert.equal(facts.owner_limit.maxJobUsd, 2);
  assert.equal(facts.readiness.checks[0].name, 'docker_login');
  assert.equal(facts.errors[0].code, 'network_error');
  assert.equal(facts.lending.state, 'paused');
  assert.deepEqual(facts.jobs.map(row => row.state), ['failed','result-accepted']);
  assert.equal(facts.install.channel, 'preview');
  assert.equal((await stat(join(f.root, 'support.tar.gz'))).mode & 0o777, 0o600);
});

test('new settings fields are excluded by default at each nesting level', async () => {
  const f = await fixture();
  const settings = JSON.parse(await readFile(join(f.home, 'v1', 'app-settings.json')));
  settings.futureCredential = packedPoison;
  settings.futureFlag = true;
  settings.limits.futureLimit = 42;
  settings.limits.lendingPolicy.futureChoice = 'automatic';
  await f.put('app-settings.json', settings);
  const preview = await supportPreview(f), facts = factsOf(preview);
  assertBoundary(preview);
  assert.equal(Object.hasOwn(facts.settings, 'futureCredential'), false);
  assert.equal(Object.hasOwn(facts.settings, 'futureFlag'), false);
  assert.equal(Object.hasOwn(facts.settings.limits, 'futureLimit'), false);
  assert.equal(Object.hasOwn(facts.settings.limits.lendingPolicy, 'futureChoice'), false);
});

test('job references rotate between exports and correlate only inside one archive', async () => {
  const f = await fixture();
  const first = await supportPreview(f), second = await supportPreview(f);
  assertBoundary(first); assertBoundary(second);
  const a = factsOf(first), b = factsOf(second);
  for (const preview of [first, second]) {
    const archive = Buffer.from(preview.archiveBase64, 'base64');
    for (const digest of [ID, OTHER]) {
      assert.equal(archive.includes(Buffer.from(digest)), false);
      assert.equal(gunzipSync(archive).includes(Buffer.from(digest)), false, 'raw job IDs never leave the profile');
    }
    const facts = factsOf(preview), alias = facts.events[0].job;
    assert.match(alias, /^job:[0-9a-f]{32}$/);
    assert.equal(facts.events[2].job, alias);
    assert.equal(facts.errors[0].job, alias);
    assert.equal(facts.jobs.find(row => row.state === 'result-accepted').id, alias);
    assert.notEqual(facts.jobs.find(row => row.state === 'failed').id, alias);
  }
  const previous = new Set([...a.events.map(row => row.job), ...a.errors.map(row => row.job), ...a.jobs.map(row => row.id)].filter(Boolean));
  const current = [...b.events.map(row => row.job), ...b.errors.map(row => row.job), ...b.jobs.map(row => row.id)].filter(Boolean);
  assert.ok(current.every(alias => !previous.has(alias)), 'a new export gets fresh aliases');
});

test('private text in allowlisted scalar slots, versions and timestamps becomes unknown', async () => {
  const f = await fixture();
  await f.put('app-settings.json', {intent:packedPoison, enabled:packedPoison, limits:{dailyJobs:packedPoison}});
  await f.put('support-readiness.json', {observed_at:packedPoison, checks:[{name:packedPoison, ok:packedPoison}]});
  await f.put('sandbox-test.json', {state:packedPoison, at:packedPoison, versions:{sbx:packedPoison}, parts:[{id:packedPoison, detail_code:packedPoison}]});
  await f.put('lending-errors.jsonl', JSON.stringify({at:packedPoison, job:packedPoison, code:packedPoison, phase:packedPoison}));
  await writeFile(join(f.installRoot, 'VERSION'), packedPoison);
  await writeFile(join(f.installRoot, '.installed-via'), CANARIES[0]);
  const preview = await supportPreview(f);
  assertBoundary(preview);
  assert.equal(factsOf(preview).runtime.app, null);
  assert.equal(factsOf(preview).settings.limits.dailyJobs, null);
});

test('oversized stores and long event tails cannot exceed input, row or archive budgets', async () => {
  const f = await fixture();
  await f.put('app-settings.json', ' '.repeat(SUPPORT_LIMITS.storeBytes + 1));
  await f.put('history/events.jsonl', Array.from({length:3000}, (_, id) => JSON.stringify({id, at:AT, type:'job',
    job:'sha256:' + id.toString(16).padStart(64, '0'), data:{state:'queued', prompt:packedPoison}})).join('\n'));
  await f.put('lending-errors.jsonl', (JSON.stringify({at:AT, code:'network_error', message:packedPoison}) + '\n').repeat(3000));
  const preview = await supportPreview(f), facts = factsOf(preview);
  assertBoundary(preview);
  assert.equal(facts.sources.settings, 'too_large');
  assert.equal(facts.sources.events, 'partial');
  assert.equal(facts.events.length, SUPPORT_LIMITS.events);
  assert.equal(facts.errors.length, SUPPORT_LIMITS.errors);
  assert.equal(facts.jobs.length, SUPPORT_LIMITS.jobs);
  assert.ok(Buffer.byteLength(preview.entries[0].body) <= SUPPORT_LIMITS.jsonBytes);
  assert.ok(preview.bytes <= SUPPORT_LIMITS.archiveBytes);
  assert.ok(gunzipSync(Buffer.from(preview.archiveBase64, 'base64')).length <= SUPPORT_LIMITS.jsonBytes + 2048);
});

test('partially corrupt stores preserve valid records without copying corrupt bytes or rewriting stores', async () => {
  const f = await fixture();
  const corrupt = '{' + packedPoison;
  await f.put('app-settings.json', corrupt);
  await f.put('owner-settings/owner-settings.json', corrupt);
  await f.put('sandbox-test.json', []);
  await f.put('support-readiness.json', corrupt);
  const log = corrupt + '\n' + JSON.stringify({at:AT, job:ID, code:'sandbox_crash', phase:'run'}) + '\n' + corrupt;
  await f.put('lending-errors.jsonl', log);
  const preview = await supportPreview(f), facts = factsOf(preview);
  assertBoundary(preview);
  assert.equal(facts.sources.settings, 'unreadable');
  assert.equal(Object.hasOwn(facts.sources, 'sandbox_test'), false);
  assert.equal(facts.sources.errors, 'partial');
  assert.equal(facts.errors[0].code, 'sandbox_crash');
  assert.equal(await readFile(join(f.home, 'v1', 'app-settings.json'), 'utf8'), corrupt);
  assert.equal(await readFile(join(f.home, 'v1', 'lending-errors.jsonl'), 'utf8'), log);
});

test('missing profile exports unknown facts without creating profile data', async () => {
  const f = await fixture(), preview = await supportPreview({home:join(f.root, 'missing'), installRoot:join(f.root,'missing-install')});
  assertBoundary(preview);
  assert.equal(factsOf(preview).sources.settings, 'missing');
  assert.equal(factsOf(preview).readiness.ready, null);
  assert.equal(factsOf(preview).install.kind, null);
  assert.equal(factsOf(preview).install.channel, null);
  await assert.rejects(stat(join(f.root, 'missing')), {code:'ENOENT'});
});

test('symlinked input files and parent directories are rejected', async () => {
  const f = await fixture(), otherHome = join(f.root, 'linked-profile');
  await mkdir(join(otherHome, 'v1'), {recursive:true});
  await symlink(join(f.home, 'v1', 'app-settings.json'), join(otherHome, 'v1', 'app-settings.json'));
  await symlink(join(f.home, 'v1', 'history'), join(otherHome, 'v1', 'history'));
  const preview = await supportPreview({home:otherHome, installRoot:f.installRoot});
  assertBoundary(preview);
  assert.equal(factsOf(preview).sources.settings, 'unsafe_path');
  assert.equal(factsOf(preview).sources.events, 'unsafe_path');
});

test('exclusive save never overwrites an existing file or follows an output symlink', async () => {
  const f = await fixture(), preview = await supportPreview(f), output = join(f.root, 'existing');
  await writeFile(output, 'keep');
  await assert.rejects(saveSupportArchive(preview, output), {code:'EEXIST'});
  await symlink(output, join(f.root, 'link'));
  await assert.rejects(saveSupportArchive(preview, join(f.root, 'link')), {code:'EEXIST'});
  assert.equal(await readFile(output, 'utf8'), 'keep');
});

test('an archive exactly 128 KiB saves intact; one byte over the limit creates no file', async () => {
  const f = await fixture(), preview = await supportPreview(f);
  const compressed = Buffer.from(preview.archiveBase64, 'base64');
  // A legal gzip comment reaches the boundary without changing support.json or tar metadata.
  function atSize(size) {
    const archive = Buffer.concat([compressed.subarray(0, 10), Buffer.alloc(size - compressed.length - 1, 32),
      Buffer.from([0]), compressed.subarray(10)]);
    archive[3] |= 0x10;
    return {...preview, bytes:archive.length, archiveBase64:archive.toString('base64')};
  }
  const exact = atSize(SUPPORT_LIMITS.archiveBytes), output = join(f.root, 'exact-limit.tar.gz');
  assert.equal(exact.bytes, 128 * 1024);
  assertBoundary(exact);
  await saveSupportArchive(exact, output);
  assert.deepEqual(await readFile(output), Buffer.from(exact.archiveBase64, 'base64'));
  const oversizedOutput = join(f.root, 'over-limit.tar.gz');
  await assert.rejects(saveSupportArchive(atSize(SUPPORT_LIMITS.archiveBytes + 1), oversizedOutput), /support_export_too_large/);
  await assert.rejects(stat(oversizedOutput), {code:'ENOENT'});
});

test('CLI previews before confirmation and saves the reviewed snapshot even if stores change', async () => {
  const f = await fixture(), stdout = capture(), stderr = capture(), output = join(f.root, 'confirmed.tar.gz');
  let shown;
  const code = await runDiagnosticsCommand(['export','--output',output], {home:f.home, stdout, stderr,
    preview:() => supportPreview(f), confirm:async () => {
      shown = stdout.text;
      await assert.rejects(stat(output), {code:'ENOENT'});
      await f.put('app-settings.json', {intent:'on'});
      return true;
    }});
  assert.equal(code, 0);
  assert.equal(stderr.text, '');
  assert.match(shown, /This archive is never uploaded\. Usage telemetry follows your telemetry setting\./);
  const body = readArchiveFiles(await readFile(output))[0].bytes.toString();
  assert.ok(shown.endsWith(body));
  assert.equal(JSON.parse(body).settings.intent, 'off');
});

test('CLI decline, preview-only and noninteractive use save nothing; failures show no raw error', async () => {
  const f = await fixture(), output = join(f.root, 'not-saved.tar.gz');
  const options = {home:f.home, stdout:capture(), stderr:capture(), stdin:{isTTY:false}, preview:() => supportPreview(f)};
  assert.equal(await runDiagnosticsCommand(['export','--output',output], {...options, confirm:async () => false}), 0);
  assert.equal(await runDiagnosticsCommand(['export','--preview'], options), 0);
  assert.equal(await runDiagnosticsCommand(['export','--output',output], options), 6);
  await assert.rejects(stat(output), {code:'ENOENT'});
  assert.equal(await runDiagnosticsCommand(['export','--output',join(f.root,'absent','file'),'--yes'], options), 1);
  assert.doesNotMatch(options.stderr.text, /ENOENT|absent|stack/);
});

test('real CLI exports with no app and an unreachable coordinator; preview operation makes no network calls', async () => {
  const f = await fixture(), output = join(f.root, 'cli.tar.gz');
  // state.json points at a closed coordinator; collection does not open the device or discover app.json.
  await f.put('state.json', {circles:[{origin:'http://127.0.0.1:1', name:packedPoison}]});
  const result = spawnSync(process.execPath, [BIN,'diagnostics','export','--output',output,'--yes'],
    {encoding:'utf8', timeout:30000, env:{...process.env, FARAVAN_HOME:f.home, DO_NOT_TRACK:'1', FARAVAN_NO_AUTOSTART:'1'}});
  assert.equal(result.status, 0, 'CLI completed without app/coordinator');
  const archive = await readFile(output);
  const preview = await supportPreview({home:f.home});
  const savedBody = readArchiveFiles(archive)[0].bytes.toString();
  assert.ok(result.stdout.endsWith(savedBody + 'Saved locally.\n'), 'the saved bytes match the CLI preview');
  assert.deepEqual(comparableFacts(JSON.parse(savedBody)), comparableFacts(factsOf(preview)));
  assertBoundary(preview);
  const client = createOpsClient({home:f.home, autostart:false, fetch:async () => {throw new Error('network forbidden');}});
  const operationPreview = await client.call('diagnostics.preview');
  assertBoundary(operationPreview);
  assert.deepEqual(comparableFacts(factsOf(operationPreview)), comparableFacts(factsOf(preview)));
});

test('authenticated app operation and CLI share archive bytes; cached readiness excludes raw probe text', {timeout:60000}, async t => {
  const f = await fixture(), home = join(f.root, 'app-profile');
  await mkdir(home);
  const backend = syntheticBackend(f.root);
  const original = backend.protectionSummary;
  backend.protectionSummary = async (...args) => {
    const report = await original(...args);
    return {...report, preflight:{...report.preflight, version:'0.47.0', checks:[{name:'sbx_install',ok:true,detail:packedPoison,diagnostics:packedPoison}]}};
  };
  const app = await startApp({home, origin:null, port:0, freshLending:'off', backendFactory:() => backend, adapters:[],
    clock:{now:() => Date.parse(AT)}, env:{DO_NOT_TRACK:'1'}, fetch:async () => {throw new Error('coordinator unreachable');}});
  t.after(() => app.close());
  const headers = {'x-faravan-session-token':app.token, 'content-type':'application/json'};
  await fetch(app.origin + '/api/readiness?refresh=true', {headers});
  await assert.rejects(stat(join(home,'v1','support-readiness.json')), {code:'ENOENT'}, 'ordinary readiness writes no diagnostic cache');
  const refused = await fetch(app.origin + '/api/ops/diagnostics.preview', {method:'POST', headers:{'content-type':'application/json'}, body:'{}'});
  assert.equal(refused.status, 401);
  const response = await fetch(app.origin + '/api/ops/diagnostics.preview', {method:'POST', headers, body:'{}'});
  assert.equal(response.status, 200);
  const preview = await response.json();
  const cache = await readFile(join(home,'v1','support-readiness.json'), 'utf8');
  assert.equal(CANARIES.some(value => cache.includes(value)), false);
  assertBoundary(preview);
  assert.deepEqual(preview, await runOp('diagnostics.preview', {}, {home, strict:true}));
  const output = join(f.root,'app-cli.tar.gz');
  const result = spawnSync(process.execPath, [BIN,'diagnostics','export','--output',output,'--yes'],
    {encoding:'utf8', timeout:30000, env:{...process.env, FARAVAN_HOME:home, DO_NOT_TRACK:'1'}});
  assert.equal(result.status, 0);
  assert.deepEqual(await readFile(output), Buffer.from(preview.archiveBase64, 'base64'));
});

test('readiness cache serializer admits only reviewed checks and scalar facts', () => {
  const projected = supportReadiness({ready:true, observed_at:AT, protection:{backend_id:packedPoison, version_gate:{ok:true}},
    checks:[{name:'docker_login',ok:false,detail:packedPoison},{name:packedPoison,ok:packedPoison}]}, packedPoison);
  assert.equal(JSON.stringify(projected).includes(CANARIES[0]), false);
  assert.equal(projected.sbx_version, null);
  assert.equal(projected.backend_id, null);
  assert.deepEqual(projected.checks[0], {name:'docker_login',ok:false});
});

test('published schema matches the serializer and has no open objects or unconstrained text', async () => {
  const documented = JSON.parse(await readFile(new URL('../docs/support/diagnostics.schema.json', import.meta.url)));
  assert.deepEqual(documented, SUPPORT_SCHEMA);
  function inspect(schema) {
    if (schema.type === 'object') {
      assert.equal(schema.additionalProperties, false);
      Object.values(schema.properties).forEach(inspect);
    }
    if (schema.type === 'array') {assert.ok(schema.maxItems <= 50); inspect(schema.items);}
    if ([schema.type].flat().includes('string')) assert.ok(schema.enum || schema.pattern);
  }
  inspect(SUPPORT_SCHEMA);
});

test('preview usage and failures follow telemetry consent; the archive never reaches the transport', {timeout:60000}, async t => {
  const f = await fixture(), home = join(f.root, 'telemetry-app');
  const h = makeTelemetry({dir:join(f.root, 'telemetry'), base:f.root});
  t.after(() => h.tel.close());
  assert.equal(h.tel.view().uploadable, true, 'synthetic consent, version and endpoint permit uploads');
  const app = await startApp({home, origin:null, port:0, freshLending:'off', adapters:[],
    backendFactory:() => syntheticBackend(f.root), telemetry:h.tel, env:{}, fetch:async () => {throw new Error('offline');}});
  t.after(() => app.close());
  await mkdir(join(home, 'v1', 'history'), {recursive:true});
  await writeFile(join(home, 'v1', 'history', 'events.jsonl'), await readFile(join(f.home, 'v1', 'history', 'events.jsonl')));
  const headers = {'x-faravan-session-token':app.token, 'content-type':'application/json', 'faravan-surface':'ui'};
  const request = body => fetch(app.origin + '/api/ops/diagnostics.preview', {method:'POST', headers, body:JSON.stringify(body)});
  const response = await request({});
  assert.equal(response.status, 200);
  const preview = await response.json();
  assertBoundary(preview);
  assert.equal((await request({unknown:true})).status, 400);
  await settle(h);
  const usage = h.transport.records().filter(row => row.name === 'op.count' && row.attrs.op === 'diagnostics.preview');
  assert.ok(usage.some(row => row.attrs.ok === true));
  assert.ok(usage.some(row => row.attrs.ok === false));
  const sent = JSON.stringify(h.transport.bodies());
  assert.equal(sent.includes(preview.archiveBase64), false);
  assert.equal(sent.includes(preview.entries[0].body), false);
  assert.equal(sent.includes('support.json'), false);
  assert.equal([...CANARIES, ID, OTHER, ...factsOf(preview).jobs.map(row => row.id)].some(value => sent.includes(value)), false);
  h.tel.choose({level:'off', region:'US'});
  const requestsBefore = h.transport.requests.length;
  assert.equal((await request({})).status, 200);
  assert.equal((await request({unknown:true})).status, 400);
  await settle(h);
  assert.equal(h.transport.requests.length, requestsBefore, 'turning telemetry off sends no preview usage or failures');
});

test('a blocked or failed diagnostic write does not block readiness recording or queue obsolete snapshots', async () => {
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const writes = [];
  const cache = createSupportReadinessCache(async value => {writes.push(value); if (writes.length === 1) {await gate; throw new Error(packedPoison);}});
  assert.equal(cache.record({ready:false,observed_at:AT}, '0.47.0'), undefined);
  await Promise.resolve();
  assert.equal(writes.length, 0, 'ordinary readiness never starts disk I/O');
  const flushing = cache.flush();
  await Promise.resolve();
  assert.equal(writes.length, 1);
  cache.record({ready:false,observed_at:AT}, '0.47.1');
  cache.record({ready:true,observed_at:AT,diagnostics:packedPoison}, '0.47.2');
  assert.equal(writes.length, 1, 'recording returns while the old write is blocked');
  release();
  await flushing;
  assert.deepEqual(writes.map(value => [value.ready,value.sbx_version]), [[false,'0.47.0'],[true,'0.47.2']]);
  assert.equal(CANARIES.some(value => JSON.stringify(writes).includes(value)), false);
});
