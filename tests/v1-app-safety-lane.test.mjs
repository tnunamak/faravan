import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from '../lib/v1/app.mjs';
import { api, bounded } from './helpers/v1-app-fixture.mjs';

// A device whose network calls never answer until aborted.
function hungDevice() {
  const calls = {aborted: 0};
  return {calls, keyId: 'sha256:' + '0'.repeat(64), listCircles: async () => [],
    createCircle: (_origin, _options) => new Promise(() => {})};
}
async function hungApp(t, extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'faravan-safety-'));
  const app = await startApp({home, port: 0, token: 'safety-token', device: hungDevice(), backendFactory: async () => ({}),
    adapters: [], ...extra});
  t.after(async () => { await app.close(); await rm(home, {recursive: true, force: true}); });
  return app;
}

test('pause, skip and stop answer while a network mutation hangs', {timeout: 20000}, async t => {
  const app = await hungApp(t, {mutationTimeoutMs: 600});
  const hung = api(app, '/api/circles', {method: 'POST', body: {origin: 'http://127.0.0.1:1'}, status: 504});
  await new Promise(resolve => setTimeout(resolve, 100));
  const started = Date.now();
  await bounded(api(app, '/api/lending/pause', {method: 'POST', body: {}}), 'pause behind hung mutation', 400);
  await api(app, '/api/lending/off', {method: 'POST', body: {}});
  await api(app, '/api/approvals/missing/skip', {method: 'POST', body: {}, status: 404});
  await api(app, '/api/lending/stop', {method: 'POST', body: {confirmed: true, attemptId: 'x'}, status: 409});
  assert.ok(Date.now() - started < 500);
  await hung;
});

test('a hung network mutation times out and releases the lane', {timeout: 20000}, async t => {
  const app = await hungApp(t, {mutationTimeoutMs: 300});
  await api(app, '/api/circles', {method: 'POST', body: {origin: 'http://127.0.0.1:1'}, status: 504});
  // The next mutation is not stuck behind the first one.
  await api(app, '/api/devices', {method: 'POST', body: {name: 'Laptop'}});
});

test('close() aborts a hung mutation instead of waiting for it', {timeout: 20000}, async t => {
  const home = await mkdtemp(join(tmpdir(), 'faravan-safety-'));
  const app = await startApp({home, port: 0, token: 'safety-token', device: hungDevice(), backendFactory: async () => ({}),
    adapters: [], mutationTimeoutMs: 60000});
  t.after(() => rm(home, {recursive: true, force: true}));
  const hung = api(app, '/api/circles', {method: 'POST', body: {origin: 'http://127.0.0.1:1'}, status: 503}).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 100));
  const started = Date.now();
  await bounded(app.close(), 'close behind hung mutation', 5000);
  assert.ok(Date.now() - started < 3000);
  await hung;
});
