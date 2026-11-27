import './helpers/no-browser.mjs';
// Occurrence ownership: one fault is counted once, repeated faults are each counted (design §2.3, §6).
import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from './helpers/v1-app-fixture.mjs';
import { telemetryApp } from './helpers/telemetry-app.mjs';
import { makeTelemetry, settle } from './helpers/telemetry-harness.mjs';
import { project } from '../lib/v1/telemetry/projection.mjs';

const options = {timeout: 120000};
const countsOf = (records, name) => records.filter(record => record.name === name);
const problems = records => countsOf(records, 'problem.count');
const total = list => list.reduce((sum, record) => sum + record.value, 0);

test('one lender exception seen by onDiagnostic and by the paired state emit is one problem.count; two faults are two', () => {
  const h = makeTelemetry();
  const fault = {code: 'sandbox_start_failed', phase: 'prepare', job: 'sha256:' + 'a'.repeat(64), ref: 'ABCDEF'};
  // The lender reports the fault once on its diagnostic channel and then emits the state that follows it.
  h.tel.observe('lender-failure', fault);
  h.tel.observe('event:lending', {account: 'codex:0', status: 'failed', reason: 'sandbox_start_failed'});
  h.clock.set(Date.UTC(2026, 9, 21, 20, 0, 1));
  h.tel.tick();
  const once = problems(h.tel.preview().items.map(i => JSON.parse(i.body)));
  assert.equal(total(once), 1, 'the state emit adds no occurrence');
  h.tel.observe('lender-failure', fault);
  h.tel.observe('lender-failure', fault);
  h.clock.set(Date.UTC(2026, 9, 21, 21, 0, 1));
  h.tel.tick();
  assert.equal(total(problems(h.tel.preview().items.map(i => JSON.parse(i.body)))), 3, 'each independent fault is one more');
});

test('stops and decisions are never problems', () => {
  const h = makeTelemetry();
  for (const code of ['stopped_by_lender', 'paused', 'approval_denied', 'daily_limit', 'quota_reserve', 'cancelled', 'conflict']) h.tel.observe('lender-failure', {code, phase: 'run'});
  h.clock.set(Date.UTC(2026, 9, 21, 20, 0, 1));
  h.tel.tick();
  assert.equal(h.tel.preview().items.length, 0);
});

test('a failing REST-bound op is one occurrence (the inner REST response) plus one op.count, with the surface forwarded', options, async t => {
  const x = await telemetryApp(t);
  // Through the app's own ops route, the way the CLI and MCP reach it: the headers say where the call comes from.
  const response = await fetch(x.app.origin + '/api/ops/jobs.get', {method: 'POST', headers: {'x-faravan-session-token': x.app.token, 'content-type': 'application/json',
    'faravan-surface': 'cli'}, body: JSON.stringify({digest: 'sha256:' + '1'.repeat(64)})});
  assert.ok(response.status >= 400, 'the job does not exist');
  const records = await x.records();
  const faults = problems(records), usage = countsOf(records, 'op.count');
  assert.equal(total(faults), 1, JSON.stringify(faults));
  assert.equal(faults[0].attrs.surface, 'cli', 'the occurrence carries the forwarded surface');
  assert.equal(faults[0].attrs.component, 'app', 'owned by the inner REST response, not the ops writer');
  assert.equal(total(usage), 1);
  assert.deepEqual([usage[0].attrs.op, usage[0].attrs.ok, usage[0].attrs.surface], ['jobs.get', false, 'cli']);
});

test('an error raised in the ops layer itself is owned by the ops writer', options, async t => {
  const x = await telemetryApp(t);
  const response = await fetch(x.app.origin + '/api/ops/jobs.get', {method: 'POST', headers: {'x-faravan-session-token': x.app.token, 'content-type': 'application/json'}, body: JSON.stringify({nope: 1})});
  assert.equal(response.status, 400);
  const faults = problems(await x.records());
  assert.equal(total(faults), 1);
  assert.equal(faults[0].attrs.component, 'ops');
  assert.equal(faults[0].attrs['error.type'], 'invalid_request');
});

test('explicit send() failures are observed on direct REST and through ops: autostart_failed, folder errors, apply_refused', options, async t => {
  const failing = {setEnabled: async () => { throw new Error('cannot write /home/alice/.config/autostart/x.desktop'); }, status: async () => ({supported: true, enabled: false})};
  const x = await telemetryApp(t, {extra: {autostart: failing}});
  await api(x.app, '/api/desktop/autostart', {method: 'POST', body: {enabled: true}, status: 409});
  await api(x.app, '/api/folders?path=' + encodeURIComponent('/etc'), {status: 403});
  // The same failure reached through the ops route is owned by the inner REST response and adds one op.count.
  const viaOps = await fetch(x.app.origin + '/api/ops/desktop.autostart', {method: 'POST', headers: {'x-faravan-session-token': x.app.token, 'content-type': 'application/json', 'faravan-surface': 'mcp'}, body: JSON.stringify({enabled: true})});
  assert.equal(viaOps.status, 409);
  // A refused apply is returned by send() and carries a secondary code; the response observer reads apply_code and nothing else.
  x.tel.response({writer: 'app', req: {url: '/api/jobs/x/apply', headers: {}}, status: 409, body: {code: 'apply_refused', apply_code: 'repo_missing', message: 'Enter /home/alice/repo'}});
  const records = await x.records();
  const faults = problems(records);
  const byCode = code => total(faults.filter(fault => fault.attrs['error.type'] === code));
  assert.equal(byCode('autostart_failed'), 2, 'direct REST and through ops: two requests, two occurrences');
  assert.ok(faults.some(fault => fault.attrs.surface === 'mcp'), 'the ops call carries the forwarded surface');
  assert.equal(byCode('apply_refused') + byCode('result_repo_missing'), 1);
  assert.ok(total(faults.filter(fault => ['unknown', 'outside_home'].includes(fault.attrs['error.type']))) >= 1, 'the folder error is counted');
  assert.equal(total(countsOf(records, 'op.count').filter(r => r.attrs.op === 'desktop.autostart')), 1);
  const text = JSON.stringify(records);
  assert.ok(!text.includes('alice') && !text.includes('/etc') && !text.includes('cannot write'), 'no message or path reaches a record');
});

test('no digest, attempt ID or request key appears in any record', () => {
  const h = makeTelemetry();
  const digest = 'sha256:' + 'c'.repeat(64);
  h.tel.observe('lender-failure', {code: 'lease_expired', phase: 'run', job: digest, attempt_id: 'attempt-secret-1', ref: 'XYZ123', message: 'job ' + digest});
  h.tel.observe('event:lending', {account: 'codex:0', status: 'preparing', current: 'attempt-secret-1', jobDigest: digest});
  h.tel.observe('event:lending', {account: 'codex:0', status: 'failed', reason: 'lease_expired', current: 'attempt-secret-1', jobDigest: digest});
  h.tel.response({writer: 'app', req: {url: '/api/jobs/' + digest, headers: {'idempotency-key': 'key-secret-9'}}, status: 409, body: {code: 'job_changed', job_digest: digest, error_id: 'SPK-AB12', message: 'attempt-secret-1'}});
  h.clock.set(Date.UTC(2026, 9, 21, 20, 0, 1));
  h.tel.tick();
  const bodies = h.tel.preview().items.map(i => i.body).join('\n');
  assert.ok(bodies.length > 100);
  for (const secret of [digest, digest.slice(7, 20), 'attempt-secret', 'key-secret', 'SPK-', 'XYZ123']) assert.ok(!bodies.includes(secret), secret);
});

test('a failed hosting start or stop is usage only: the coordinator owns that failure, and other ops still count', () => {
  const failed = (opId, status = 409, code = 'host_failed') => project('response', {status, body: {code}, writer: 'ops', opId, surface: 'cli', durationMs: 5}, {});
  for (const opId of ['hosting.start', 'hosting.stop']) {
    const out = failed(opId);
    assert.equal(out.filter(o => o.name === 'problem.count').length, 0, opId + ' is not a problem here');
    assert.ok(out.some(o => o.name === 'op.count' && o.attrs.ok === false), opId + ' is still usage');
  }
  assert.equal(failed('circles.list', 500, 'internal_error').filter(o => o.name === 'problem.count').length, 1, 'another op failure is an occurrence');
});
