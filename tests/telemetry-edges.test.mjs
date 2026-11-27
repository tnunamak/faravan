import './helpers/no-browser.mjs';
// Telemetry is wired only where the design says (§2.3), and each of the 47 phase-1 failure classes (§7) is triggered
// and produces its expected record.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { edgeCapture,makeTelemetry, manualClock } from './helpers/telemetry-harness.mjs';
import { telemetryApp } from './helpers/telemetry-app.mjs';
import { canonicalJson } from '../lib/v1/telemetry/catalog.mjs';
import { readGolden } from './helpers/telemetry-golden.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

// ---- Import graph --------------------------------------------------------------------------------------------------
function walk(directory, out = []) {
  for (const name of readdirSync(directory)) {
    if (['node_modules', '.git', 'test-artifacts'].includes(name)) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path, out); else out.push(path);
  }
  return out;
}
const SOURCES = [...walk(join(ROOT, 'lib')), ...walk(join(ROOT, 'bin')), ...walk(join(ROOT, 'coordinator')).filter(f => !f.includes('node_modules')), ...walk(join(ROOT, 'ui/v1/src'))]
  .filter(file => (/\.(mjs|jsx|js)$/.test(file) && !/\.test\.m?js$/.test(file)) || /\/bin\/faravan/.test(file));
const importsOf = file => [...readFileSync(file, 'utf8').matchAll(/(?:from\s+|import\s*\(\s*|require\(\s*)['"]([^'"]+)['"]/g)].map(m => m[1]);
/** Files (relative to the repo) that import a module whose path ends with `target`. */
const importersOf = target => SOURCES.filter(file => importsOf(file).some(spec => spec.startsWith('.') && resolve(join(file, '..'), spec).endsWith(target))).map(file => relative(ROOT, file)).sort();

test('only app.mjs imports the telemetry facade', () => {
  assert.deepEqual(importersOf('lib/v1/telemetry/index.mjs'), ['lib/v1/app.mjs']);
});

test('the other telemetry modules are reached only from the places that own an edge', () => {
  const allowed = {
    'lib/v1/telemetry/crash.mjs': ['bin/faravan', 'bin/faravan-coordinator'],
    'lib/v1/telemetry/switch.mjs': ['lib/v1/ops/execute.mjs', 'lib/v1/ops/http.mjs'],
    'lib/v1/telemetry/cli.mjs': ['bin/faravan', 'lib/v1/ops/cli.mjs'],
    'lib/v1/telemetry/copy.mjs': ['ui/v1/src/telemetry-model.mjs', 'ui/v1/src/telemetry-ui.jsx'],
  };
  for (const [target, expected] of Object.entries(allowed)) {
    const actual = importersOf(target).filter(file => !file.startsWith('lib/v1/telemetry/'));
    assert.ok(actual.every(file => expected.includes(file)), `${target} is imported by ${actual.join(', ')}; expected only ${expected.join(', ')}`);
  }
  for (const target of ['catalog.mjs', 'catalog.json', 'consent.mjs', 'rollup.mjs', 'projection.mjs', 'outbox.mjs', 'uploader.mjs', 'tripwire.mjs', 'ids.mjs', 'entries.mjs']) {
    const outside = importersOf('lib/v1/telemetry/' + target).filter(file => !file.startsWith('lib/v1/telemetry/') && !file.startsWith('scripts/'));
    assert.deepEqual(outside.filter(file => !file.startsWith('ui/')), [], target + ' is internal to telemetry');
  }
});

test('no lending, lender, admission or docker-backend module imports telemetry, and telemetry imports none of them', () => {
  const lending = SOURCES.map(file => relative(ROOT, file)).filter(file => /\/(lend|admission|docker-backend|offer-book)/.test(file) && !file.startsWith('lib/v1/telemetry/') && !file.startsWith('ui/'));
  assert.ok(lending.length >= 8, 'found ' + lending.join(', '));
  for (const file of lending) assert.ok(!importsOf(join(ROOT, file)).some(spec => /telemetry/.test(spec)), file + ' imports telemetry');
  for (const file of SOURCES.filter(f => f.includes('/lib/v1/telemetry/'))) {
    assert.ok(!importsOf(file).some(spec => /(lend|lender|admission|docker-backend|lending-)/.test(spec.split('/').at(-1))), relative(ROOT, file) + ' imports lending code');
  }
});

// ---- The 47 phase-1 classes ----------------------------------------------------------------------------------------
const DAY = 86400000;
const D = 'sha256:' + 'd'.repeat(64);
const lend = (h, status, extra = {}, advance = 1000) => { h.clock.advance(advance); h.tel.observe('event:lending', {account: 'codex:0', status, ...extra}); };
const failure = (h, code, phase = 'run') => h.tel.observe('lender-failure', {code, phase, job: D, ref: 'AAAAAA', message: 'x /home/alice'});
const response = (h, status, body, extra = {}) => h.tel.response({writer: 'app', req: {url: '/api/jobs', headers: {}}, status, body, ...extra});
const readiness = (...pairs) => ({readiness: {checks: pairs.map(([name, ok]) => ({name, ok}))}});
const jobPayload = {created_at: '2026-10-21T19:00:00.000Z', expires_at: '2026-10-22T01:00:00.000Z', requirements: {harness: ['codex']}, source: {kind: 'git'}};

/** [id, why it matters, trigger(h), expected records as [name, attribute subset]] */
const CLASSES = [
  ['J4', 'stop or guard acknowledgement unresolved', h => { lend(h, 'preparing'); failure(h, 'cessation_unverified'); lend(h, 'stopping', {reason: 'cessation_unverified'}); lend(h, 'stopped', {reason: 'stopped_by_lender'}); },
    [['problem.count', {'error.type': 'cessation_unverified', component: 'lender'}], ['job.run', {'job.role': 'lender', outcome: 'stopped', 'stop.reason': 'owner', 'error.type': undefined}]]],
  ['D4', 'cleanup unproven', h => failure(h,'sandbox_stop_failed'), [['problem.count',{'error.type':'sandbox_stop_failed'}]]],
  ['J3', 'run timeout, lease or heartbeat loss', h => { lend(h, 'preparing'); lend(h, 'running'); failure(h, 'lease_expired'); lend(h, 'failed', {reason: 'lease_expired'}); },
    [['job.run', {outcome: 'uncertain', 'error.type': 'lease_expired'}], ['problem.count', {'error.type': 'lease_expired'}]]],
  ['J7', 'result upload or completion pending or rejected', h => { lend(h, 'preparing'); lend(h, 'running'); failure(h, 'delivery_delayed', 'result'); failure(h, 'completion_unknown', 'result'); failure(h, 'completion_rejected', 'result'); lend(h, 'failed', {reason: 'completion_rejected'}); },
    [['problem.count', {'error.type': 'delivery_delayed', outcome: 'delayed'}], ['problem.count', {'error.type': 'completion_unknown'}], ['problem.count', {'error.type': 'completion_rejected'}], ['job.run', {outcome: 'failed'}]]],
  ['L1', 'quota meter missing', h => h.tel.observe('event:offer-decision', {outcome: 'ineligible', reason: 'quota_unknown', harness: 'codex', mode: 'auto', wallSeconds: 60, deadline: 600}),
    [['health.state', {check: 'quota_meter', state: 'degraded'}], ['lending.offer.decision', {reason: 'quota_unknown'}]]],
  ['L2', 'quota meter stale or unreadable', h => { h.tel.observe('event:offer-decision', {outcome: 'ineligible', reason: 'quota_unknown', harness: 'claude-code', mode: 'ask', wallSeconds: 600, deadline: 3600}); },
    [['health.state', {check: 'quota_meter', state: 'degraded'}], ['lending.offer.decision', {reason: 'quota_unknown', harness: 'claude-code'}]]],
  ['L7', 'five-hour guard or budget stop', h => { lend(h, 'preparing'); lend(h, 'running'); lend(h, 'sending-result', {stopReason: 'budget'}); lend(h, 'finished', {stopReason: 'budget'}); },
    [['job.run', {outcome: 'finished', 'stop.reason': 'budget'}]]],
  ['L8', 'guard record or stop failure', h => { failure(h, 'guard_record_invalid'); failure(h, 'guard_record_unverified'); },
    [['problem.count', {'error.type': 'guard_record_invalid'}], ['problem.count', {'error.type': 'guard_record_unverified'}]]],
  ['D1', 'readiness blockers', h => { h.tel.observe('health', readiness(['docker_runtime', false], ['kvm_access', false], ['docker_login', false], ['sbx_version', true])); },
    [['health.state', {check: 'docker_runtime', state: 'blocked'}], ['health.state', {check: 'kvm_access', state: 'blocked'}], ['health.state', {check: 'docker_login', state: 'blocked'}], ['health.state', {check: 'sbx_version', state: 'ok'}]]],
  ['S1', 'start-up throws on corrupt settings', h => h.crash('start_failed', Object.assign(new SyntaxError('bad json'), {})), [['app.crash', {'crash.kind': 'start_failed', 'js.error_class': 'SyntaxError'}]]],
  ['S2', 'start-up throws on a port bind', h => h.crash('start_failed', Object.assign(new Error('listen'), {code: 'EADDRINUSE'})), [['app.crash', {'crash.kind': 'start_failed', errno: 'EADDRINUSE'}]]],
  ['H1', 'start-up throws on the adapter contract', h => h.crash('start_failed', new TypeError('adapter')), [['app.crash', {'crash.kind': 'start_failed', 'js.error_class': 'TypeError'}], ['crash.count', {'crash.kind': 'start_failed'}]]],
  ['C1', 'coordinator listener failure', h => h.inbox('inbox.coordinator-listener'), [['problem.count', {component: 'coordinator', 'error.type': 'internal_error'}]]],
  ['C2', 'coordinator tunnel failure, also after readiness', h => h.inbox('inbox.coordinator-tunnel'), [['health.state', {check: 'coordinator_tunnel', state: 'blocked'}]]],
  ['S7', 'history persistence degraded', h => h.tel.observe('health', {history: {durable: false}}), [['health.state', {check: 'event_history_durable', state: 'degraded'}]]],
  ['E1', 'history rewrite fails silently', h => h.tel.observe('health', {history: {durable: false}}), [['health.state', {check: 'event_history_durable', state: 'degraded'}]]],
  ['E2', 'history append fails silently', h => h.tel.observe('health', {history: {durable: false}, notifications: {degraded: true, lastCode: 'ENOSPC'}}),
    [['health.state', {check: 'event_history_durable', state: 'degraded'}], ['health.state', {check: 'notifications', state: 'degraded'}]]],
  ['J1', 'prepare, source or clone failure', h => { lend(h, 'preparing'); failure(h, 'sandbox_start_failed', 'prepare'); failure(h, 'git_source_transfer_failed', 'prepare'); lend(h, 'preparation-failed', {reason: 'preparation_failed'}); },
    [['problem.count', {'error.type': 'sandbox_start_failed', phase: 'prepare'}], ['problem.count', {'error.type': 'git_source_transfer_failed', phase: 'prepare'}], ['job.run', {outcome: 'failed'}]]],
  ['J2', 'start, entrypoint or guard-install failure', h => { failure(h, 'entrypoint_start_failed', 'start'); failure(h, 'guard_install_failed', 'start'); },
    [['problem.count', {'error.type': 'entrypoint_start_failed', phase: 'start'}], ['problem.count', {'error.type': 'guard_install_failed'}]]],
  ['D2','repair failure',h=>{h.snapshot=readiness(['docker_login',false]);h.tel.observe('event:readiness',{});},[['setup.check.count',{check:'docker_login',state:'blocked'}]]],
  ['D3','per-job isolation failure',h=>failure(h,'isolation_check_failed'),[['problem.count',{'error.type':'isolation_check_failed'}]]],
  ['H2', 'harness sign-in failure', h => { h.tel.observe('event:signin', {flowId: 'f', target: 'codex', status: 'starting'}); h.clock.advance(2000); h.tel.observe('event:signin', {flowId: 'f', target: 'codex', status: 'failed'}); },
    [['signin.run', {outcome: 'failed', harness: 'codex'}], ['signin.count', {outcome: 'failed'}]]],
  ['H3', 'sign-in blocks admission', h => h.tel.observe('event:offer-decision', {outcome: 'ineligible', reason: 'agent_signed_out', harness: 'codex', mode: 'auto', wallSeconds: 60, deadline: 600}),
    [['lending.offer.decision', {reason: 'agent_signed_out'}], ['health.state', {check: 'agent_signin', state: 'blocked'}]]],
  ['T1', 'tray sees the app unreachable', h => h.inbox('inbox.tray-health-app-reachable'), [['health.state', {check: 'app_reachable', state: 'blocked', }]]],
  ['I5', 'self-update failure', h => { h.tel.observe('event:update', {state: 'checking', owner: 'faravan'}); h.clock.advance(1000); h.tel.observe('event:update', {state: 'failed', owner: 'faravan', currentVersion: '0.1.0', candidate: '0.1.1'}); },
    [['upgrade.run', {outcome: 'failed', owner: 'faravan'}], ['upgrade.count', {outcome: 'failed'}]]],
  ['I6', 'the updater silently retries', h => h.tel.observe('health', {updater: {state: 'failed'}}), [['health.state', {check: 'updater', state: 'degraded'}]]],
  ['I3', 'postinst cannot find the session', h => h.inbox('install.run'), [['install.run', {outcome: 'restart_failed'}], ['install.count', {outcome: 'restart_failed'}]]],
  ['I4', 'quit unanswered or restart failed', h => h.inbox('install.run'), [['install.run', {method: 'deb'}]]],
  ['P1', 'phone listener failure', h => h.tel.observe('health', {phone: {degraded: true}}), [['health.state', {check: 'phone_listener', state: 'degraded'}]]],
  ['P2', 'phone pairing failure', h => h.tel.response({writer: 'phone', req: {url: '/api/phone/pairing', headers: {}}, status: 409, body: {code: 'rate_limited'}}), [['problem.count', {component: 'phone', surface: 'phone', 'error.type': 'rate_limited'}]]],
  ['S3', 'phone listener cannot bind', h => h.tel.observe('health', {phone: {degraded: true}}), [['health.state', {check: 'phone_listener', state: 'degraded'}]]],
  ['J9', 'result verification failure', h => response(h, 409, {code: 'apply_refused', apply_code: 'dirty'}), [['problem.count', {'error.type': 'result_dirty', component: 'app'}]]], // apply_refused with apply_code dirty: projection.mjs names the result code
  ['J10', 'apply failure', h => response(h, 409, {code: 'repo_refused', repo_code: 'not_git'}), [['problem.count', {component: 'app'}]]],
  ['J5', 'verification check failure', h => { lend(h, 'preparing'); failure(h, 'check_workspace_failed', 'result'); lend(h, 'failed', {reason: 'check_workspace_failed'}); },
    [['problem.count', {'error.type': 'check_workspace_failed', phase: 'result'}], ['job.run', {outcome: 'failed'}]]],
  ['J6', 'output collection failure', h => failure(h, 'output_missing', 'result'), [['problem.count', {'error.type': 'output_missing'}]]],
  ['L6', 'standing-rule audit receipt write fails', h => failure(h, 'audit_unavailable', 'before_claim'), [['problem.count', {'error.type': 'audit_unavailable'}]]],
  ['C5', 'claim, renew or upload transport failure', h => { failure(h, 'claim_failed', 'before_claim'); failure(h, 'release_unknown', 'run'); },
    [['problem.count', {'error.type': 'claim_failed'}], ['problem.count', {'error.type': 'release_unknown'}]]],
  ['C6', 'claim conflict', h => { failure(h, 'conflict', 'before_claim'); h.tel.observe('event:offer-decision', {outcome: 'taken_by_other', reason: 'none', harness: 'codex', mode: 'auto', wallSeconds: 60, deadline: 600}); },
    [['lending.offer.decision', {outcome: 'taken_by_other'}]]],
  ['C3', 'invite resolution failure', h => response(h, 409, {code: 'invite_unreachable'}), [['problem.count', {'error.type': 'invite_unreachable'}]]],
  ['C4', 'enrollment failure', h => response(h, 409, {code: 'enrollment_conflict'}), [['problem.count', {'error.type': 'enrollment_conflict'}]]],
  ['L4', 'policy guards, as demand', h => { h.tel.observe('event:offer-decision', {outcome: 'ineligible', reason: 'daily_limit', harness: 'codex', mode: 'auto', wallSeconds: 60, deadline: 600}); h.tel.observe('event:offer-decision', {outcome: 'ineligible', reason: 'outside_hours', harness: 'codex', mode: 'auto', wallSeconds: 60, deadline: 600}); },
    [['lending.offer.decision', {reason: 'daily_limit'}], ['lending.offer.decision', {reason: 'outside_hours'}]]],
  ['L5', 'approval timeouts, as demand', h => h.tel.observe('event:offer-decision', {outcome: 'expired_visible', reason: 'none', harness: 'claude-code', mode: 'ask', wallSeconds: 60, deadline: 600}), [['lending.offer.decision', {outcome: 'expired_visible'}]]],
  ['S5', 'autostart and readiness degrade through catches', h => { response(h, 409, {code: 'autostart_failed'}); h.tel.observe('health', readiness(['sbx_daemon', false])); },
    [['problem.count', {'error.type': 'autostart_failed'}], ['health.state', {check: 'sbx_daemon', state: 'blocked'}]]],
  ['O2', 'local HTTP failure', h => response(h, 403, {code: 'invalid_origin', message: 'Use the local app address.'}), [['problem.count', {'error.type': 'invalid_origin', surface: 'http', component: 'app'}]]],
  ['O3', 'ops failure', h => h.tel.response({writer: 'ops', req: {url: '/api/ops/jobs.get', headers: {}}, status: 400, body: {code: 'invalid_request'}, opId: 'jobs.get'}),
    [['problem.count', {component: 'ops', 'error.type': 'invalid_request'}], ['op.count', {op: 'jobs.get', ok: false}]]],
  ['O4', 'MCP failure', h => h.tel.response({writer: 'ops', req: {url: '/api/ops/jobs.get', headers: {'faravan-surface': 'mcp'}}, status: 409, body: {code: 'conflict'}, opId: 'jobs.get'}),
    [['problem.count', {surface: 'mcp', 'error.type': 'conflict'}], ['op.count', {surface: 'mcp'}]]],
  ['O7', 'no export of operation use', h => h.tel.response({writer: 'ops', req: {url: '/api/ops/jobs.list', headers: {'faravan-surface': 'cli'}}, status: 200, body: {jobs: []}, opId: 'jobs.list', durationMs: 20}),
    [['op.count', {op: 'jobs.list', ok: true, surface: 'cli'}], ['op.duration', {op: 'jobs.list'}]]],
];

const matches = (record, [name, subset]) => record.name === name && Object.entries(subset).every(([k, v]) => (v === undefined ? !(k in record.attrs) : record.attrs[k] === v));

/** A telemetry instance plus the helpers that stand in for the edge producers. */
function edgeHarness() {
  const h = makeTelemetry({clock: manualClock(Date.UTC(2026, 9, 21, 19, 5)), health: () => h.snapshot});
  h.snapshot = {};
  h.crash = async (kind, error) => {
    const { writeCrashFile } = await import('../lib/v1/telemetry/crash.mjs');
    assert.ok(writeCrashFile({dir: h.dir, now:h.clock.now, env: {}, kind, error, uptimeMs: 3000}));
    h.tel.ingestInbox();
  };
  h.inbox = name => {
    const golden = JSON.parse(readGolden((name.startsWith('inbox.') ? name : name + '.inbox') + '.json'));
    mkdirSync(join(h.dir, 'inbox'), {recursive: true});
    writeFileSync(join(h.dir, 'inbox', name + '.json'), canonicalJson({...golden, gen: h.tel.status().generation,capture:edgeCapture(h)}));
    h.tel.ingestInbox();
  };
  return h;
}

test('there are 47 phase-1 classes and each id is distinct', () => {
  assert.equal(CLASSES.length, 47);
  assert.equal(new Set(CLASSES.map(c => c[0])).size, 47);
});

for (const [id, why, trigger, expected] of CLASSES) {
  test(`class ${id} (${why}) produces its record`, async () => {
    const h = edgeHarness();
    // A crash helper is async (it imports the writer); the others are synchronous.
    await trigger(h);
    h.clock.advance(2 * DAY);
    h.tel.tick();
    const records = h.tel.preview().items.filter(item => item.state === 'queued').map(item => JSON.parse(item.body));
    for (const want of expected) assert.ok(records.some(record => matches(record, want)), `${id}: no ${want[0]} ${JSON.stringify(want[1])}; got ${records.map(r => r.name + JSON.stringify(r.attrs)).join(' | ').slice(0, 1500)}`);
    h.cleanup();
  });
}
