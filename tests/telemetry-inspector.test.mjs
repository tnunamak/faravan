import './helpers/no-browser.mjs';
// "See what we send": the inspector shows exactly the bytes that were or will be sent (design §6).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { makeTelemetry, captureServer, manualClock, START, RELEASE } from './helpers/telemetry-harness.mjs';
import { previewModel, downloadName } from '../ui/v1/src/telemetry-preview.mjs';

const failure = {code: 'sandbox_start_failed', phase: 'prepare'};
const segmentLines = dir => readdirSync(join(dir, 'outbox')).filter(f => f.endsWith('.jsonl')).flatMap(f => readFileSync(join(dir, 'outbox', f), 'utf8').split('\n').filter(Boolean).map(line => line.split('\t').slice(3).join('\t')));

test('preview bodies equal the queued segment lines before sending and the captured request bytes after', async () => {
  const server = await captureServer();
  // This test sends over a real socket, not the capture transport.
  const real = makeTelemetry({endpoint: server.url, clock: manualClock(START), transport: (_url, init) => fetch(server.url, init)});
  real.tel.observe('lender-failure', failure);
  real.tel.observe('event:lending', {account: 'codex:0', status: 'preparing'});
  real.clock.advance(5000);
  real.tel.observe('event:lending', {account: 'codex:0', status: 'finished'});
  real.clock.set(Date.UTC(2026, 9, 21, 20, 0, 1));
  real.tel.tick();

  const queued = real.tel.preview().items;
  assert.ok(queued.length >= 3 && queued.every(item => item.state === 'queued'));
  assert.deepEqual(queued.map(item => item.body).sort(), segmentLines(real.dir).sort(), 'queued = the lines of the segments, byte for byte');
  for (const item of queued) assert.equal(item.bytes, Buffer.byteLength(item.body));

  real.clock.advance(11 * 60000);
  await real.tel.flushNow();
  real.clock.advance(6 * 60000);
  await real.tel.flushNow();
  assert.ok(server.requests.length >= 2, 'a counts batch and a diagnostics batch');
  const sent = real.tel.preview().items.filter(item => item.state === 'sent');
  assert.equal(sent.length, server.requests.length);
  assert.deepEqual(sent.map(item => item.body).sort(), server.requests.map(request => request.body).sort(), 'sent = the bytes the server received');
  for (const item of sent) assert.equal(item.status, 200);
  for (const request of server.requests) {
    assert.equal(request.headers['content-encoding'], 'gzip');
    assert.equal(request.headers['user-agent'], 'telemetry/1');
    assert.equal(gunzipSync(request.raw).toString(), request.body);
    assert.deepEqual(Object.keys(request.headers).filter(k => /cookie|authorization|x-/.test(k)), []);
  }
  assert.equal(real.tel.preview().items.some(item => item.state === 'queued'), false, 'nothing is left waiting');
  await server.close();
  real.cleanup();
});

test('a rejected batch is kept as rejected, with the status the server answered', async () => {
  const server = await captureServer({status: 422});
  const h = makeTelemetry({endpoint: server.url, clock: manualClock(START), transport: (_url, init) => fetch(server.url, init)});
  h.tel.observe('lender-failure', failure);
  h.tel.tick();
  h.clock.advance(6 * 60000);
  await h.tel.flushNow();
  const rejected = h.tel.preview().items.filter(item => item.state === 'rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].status, 422);
  assert.equal(rejected[0].body, server.requests[0].body);
  await server.close();
});

test('the page model renders the op output, with the off and environment-switch lines', async () => {
  const on = makeTelemetry({clock: manualClock(START)});
  on.tel.observe('lender-failure', failure);
  on.tel.tick();
  const model = previewModel(on.tel.preview());
  assert.match(model.sentence, /On/i);
  assert.equal(model.off, false);
  assert.ok(model.items.length >= 1);
  for (const row of model.items) {
    const original = on.tel.preview().items.find(item => item.body === row.body);
    assert.ok(original, 'the model shows the exact body');
    assert.match(row.filename, /^faravan-report-/);
    assert.equal(row.filename, downloadName(original));
  }
  assert.match(model.queuedLine, /^Waiting to send:/);
  const off = makeTelemetry({level: 'off'});
  const offModel = previewModel(off.tel.preview());
  assert.equal(offModel.off, true);
  assert.deepEqual(offModel.items, []);
  assert.equal(offModel.emptyLine, 'No locally retained reports to show.');
  assert.doesNotMatch(offModel.emptyLine, /sent nothing/, 'local retention cannot prove historical sending');
  const env = makeTelemetry({env: {DO_NOT_TRACK: '1'}});
  const envModel = previewModel(env.tel.preview());
  assert.equal(envModel.env, true);
  assert.match(envModel.sentence, /DO_NOT_TRACK/);
  assert.equal(previewModel(null).items.length, 0, 'a missing output renders as empty');
});

test('the CLI show command prints the same bodies', async () => {
  const { runTelemetryCommand } = await import('../lib/v1/telemetry/cli.mjs');
  const h = makeTelemetry({clock: manualClock(START)});
  h.tel.observe('lender-failure', failure);
  h.tel.tick();
  const out = [];
  const client = {rest: async (method, path) => (path.endsWith('/preview') ? h.tel.preview() : h.tel.view())};
  const code = await runTelemetryCommand(['show'], {client, stdout: {write: text => out.push(text)}, stderr: {write: () => {}}});
  assert.equal(code, 0);
  const text = out.join('');
  for (const item of h.tel.preview().items) assert.ok(text.includes(item.body));
  const json = [];
  await runTelemetryCommand(['show', '--json'], {client, stdout: {write: text => json.push(text)}, stderr: {write: () => {}}});
  assert.deepEqual(JSON.parse(json.join('')).items.map(i => i.body), h.tel.preview().items.map(i => i.body));
});
