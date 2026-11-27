import './helpers/no-browser.mjs';
// A journey on the real app: a person sends a job that fails, uses an operation, hits an error and a friction point.
// `telemetry.preview` (the operation, over HTTP) then shows what would be sent, and every record in it is valid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { api, appFixture, waitFor } from './helpers/v1-app-fixture.mjs';
import { telemetryApp } from './helpers/telemetry-app.mjs';
import { RELEASE, captureTransport, catalogRemoteFactory, manualClock } from './helpers/telemetry-harness.mjs';
import {parseQueuedRecord} from '../lib/v1/telemetry/posthog.mjs';
import { parseRecord } from '../lib/v1/telemetry/catalog.mjs';

const options = {timeout: 120000};
const ops = (app, id, body = {}, headers = {}) => fetch(app.origin + '/api/ops/' + id, {method: 'POST', headers: {'x-faravan-session-token': app.token, 'content-type': 'application/json', ...headers}, body: JSON.stringify(body)});

test('a journey on the real app shows its entries in telemetry.preview, every record valid and none holding private text', options, async t => {
  const x = await telemetryApp(t, {extra: {pollMs: 250}});
  const {f, app: owner} = x;
  const lender = (await f.start('lender')).app;
  await f.provisionFromHome('owner');
  const circle = await api(owner, '/api/circles', {method: 'POST', body: {origin: f.origin, name: 'Synthetic friends'}});
  const {invite} = await api(owner, '/api/circles/' + circle.id + '/invite', {method: 'POST', body: {}});
  await api(lender, '/api/circles/join', {method: 'POST', body: {link: invite}});
  await api(owner, '/api/circles/' + circle.id + '/approve', {method: 'POST', body: {}});
  await lender.device.refreshRoster(circle.id);

  // Use an operation from the CLI surface, and fail one.
  assert.equal((await ops(owner, 'jobs.list', {}, {'faravan-surface': 'cli'})).status, 200);
  assert.ok((await ops(owner, 'jobs.get', {digest: 'sha256:' + '9'.repeat(64)}, {'faravan-surface': 'mcp'})).status >= 400);
  // Send a job and let it fail on the lender's side.
  const sent = await api(owner, '/api/jobs', {method: 'POST', body: {circle: circle.id, git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40), prompt: 'My secret prompt about payroll', harness: 'codex'}});
  const raw = f.jobs.get(sent.jobDigest);
  const at = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
  Object.assign(raw, {state: 'failed', attempts_started: 1, current_attempt: {attempt_id: '11111111-1111-4111-8111-111111111111', job_digest: sent.jobDigest, generation: 1, state: 'released', holder: lender.device.keyId,
    claimed_at: at, lease_expires_at: at, execution_started_at: at, reason: null, stopped_at: at, compute_stopped: true}});
  // A friction record from the UI, with a title that must never travel.
  await api(owner, '/api/telemetry/ui', {method: 'POST', body: {records: [{kind: 'error_banner', route: 'jobs', code: 'conflict', title: "Ann's MacBook"}]}});
  await waitFor(async () => (await x.records({close: false})).some(r => r.name === 'job.run'), 'the failed job span');

  x.clock.advance(2 * 86400000);
  x.tel.tick();
  const preview = await (await ops(owner, 'telemetry.preview')).json();
  const records = preview.items.flatMap(item => (item.state === 'queued' ? [JSON.parse(item.body)] : JSON.parse(item.body).records));
  const names = new Set(records.map(r => r.name));
  for (const name of ['op.count', 'op.duration', 'problem.count', 'problem.observed.readiness', 'job.run', 'job.outcome.count', 'job.duration', 'lending.request.outcome', 'ui.friction', 'install.active', 'health.state']) {
    assert.ok(names.has(name), `${name} is in telemetry.preview; got ${[...names].sort().join(', ')}`);
  }
  for (const record of records) assert.ok(parseQueuedRecord({...record}),record.name);
  const text = JSON.stringify(preview);
  for (const secret of ['payroll', "Ann's", 'sha256:', 'synthetic.git', 'github.com', sent.jobDigest, 'secret']) assert.ok(!text.includes(secret), secret);
  // The operation, the REST route and the CLI/MCP names are the same data.
  const direct = await api(owner, '/api/telemetry/preview');
  assert.equal(direct.items.length, preview.items.length);
});

test('turning telemetry off through the op empties the queue; widening is not an operation', options, async t => {
  const x = await telemetryApp(t);
  await ops(x.app, 'jobs.list', {}, {'faravan-surface': 'cli'});
  x.clock.advance(2 * 86400000);
  x.tel.tick();
  assert.ok((await api(x.app, '/api/telemetry/preview')).items.length > 0);
  const off = await (await ops(x.app, 'telemetry.off')).json();
  assert.equal(off.effective, 'off');
  assert.deepEqual((await api(x.app, '/api/telemetry/preview')).items, []);
  const widen = await ops(x.app, 'telemetry.set', {level: 'on'});
  assert.ok([403, 404].includes(widen.status), 'telemetry.set is not offered over HTTP ops: ' + widen.status);
  assert.equal((await api(x.app, '/api/telemetry')).effective, 'off');
});

test('acknowledging the telemetry notice cannot widen a saved Settings Off choice across reopen', options, async t => {
  const f = await appFixture(t);
  const transport = captureTransport();
  const clock = manualClock(Date.now());
  const extra = {
    version: RELEASE, clock: {now: clock.now}, telemetryTransport: transport,
    env: {...process.env, FARAVAN_NO_TELEMETRY: '0', DO_NOT_TRACK: '0'},
    telemetryOptions: {remoteFactory: catalogRemoteFactory, tripwire: async () => null, random: () => 0},
  };
  const first = await f.start('owner', extra);
  const {app} = first;
  const choose = await api(app, '/api/telemetry/choose', {method: 'POST', body: {level: 'off'}});
  assert.equal(choose.level, 'off');
  assert.equal(choose.effective, 'off');
  assert.deepEqual(choose.notice, {shown: true, pending: false}, 'the Settings decision counts as having seen the notice');
  const acknowledged = await api(app, '/api/telemetry/notice', {method: 'POST', body: {}});
  assert.equal(acknowledged.level, 'off');
  assert.equal(acknowledged.effective, 'off');
  assert.deepEqual(acknowledged.notice, {shown: true, pending: false});
  const quiet = async owner => {
    await api(owner, '/api/telemetry/ui', {method: 'POST', body:{records:[{kind:'error_banner',route:'jobs',code:'conflict'}]}});
    clock.advance(2 * 86400000);
    owner.telemetry.tick();
    await owner.telemetry.flushNow();
    assert.deepEqual((await api(owner, '/api/telemetry/preview')).items, []);
    assert.deepEqual(transport.requests, []);
  };
  await quiet(app);
  await app.close();
  const reopened = await f.start('owner', extra); // Same profile; startup does not call choose.
  assert.equal(reopened.home, first.home);
  const status = await api(reopened.app, '/api/telemetry');
  assert.equal(status.level, 'off');
  assert.equal(status.effective, 'off');
  assert.deepEqual(status.notice, {shown: true, pending: false});
  assert.notEqual(status.reason?.kind, 'notice_pending');
  await quiet(reopened.app);
});
