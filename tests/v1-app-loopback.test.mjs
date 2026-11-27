import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, api, boundedFetch} from './helpers/v1-app-fixture.mjs';
import {refuseFraming} from '../lib/v1/loopback-security.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('the owner UI server listens only on loopback', async t => {
  const f = await appFixture(t);
  const app = (await f.start('loopback-only')).app;
  assert.equal(app.server.address().address, '127.0.0.1');
});

test('the session token is accepted only in the header, never from the query string', async t => {
  const f = await appFixture(t);
  const {app} = await f.start('query-token');
  await api(app, '/api/status?token=' + encodeURIComponent(app.token), {token: null, status: 401});
  await api(app, '/api/status');
});

test('every owner response refuses framing: shell, static asset and API answers', async t => {
  const f = await appFixture(t);
  const {app} = await f.start('framing');
  for (const path of ['/', '/app.mjs', '/api/status']) {
    const response = await boundedFetch(app.origin + path, {headers: {'x-faravan-session-token': app.token}});
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('x-frame-options'), 'DENY', path);
    const csp = response.headers.get('content-security-policy') ?? '';
    assert.equal(csp.split(';').filter(part => /^\s*frame-ancestors\b/.test(part)).length, 1, path + ' carries one frame-ancestors');
    assert.match(csp, /(^|;)\s*frame-ancestors 'none'\s*(;|$)/, path);
    await response.arrayBuffer();
  }
});

test('app.url issues a fresh single-use handoff each time it is read, and the handoff lands on the app root', async t => {
  const f = await appFixture(t);
  const {app} = await f.start('url-handoff');
  const first = app.url, second = app.url;
  assert.notEqual(first, second, 'each read issues its own code');
  for (const link of [first, second]) {
    assert.ok(link.startsWith(app.origin + '/auth/handoff?code='), link.split('?')[0]);
    assert.equal(link.includes(app.token), false);
  }
  const response = await boundedFetch(first, {redirect: 'manual'});
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/');
  assert.equal(response.headers.get('location').includes('#'), false, 'no fragment, so the browser keeps the caller hash');
  assert.match(response.headers.get('set-cookie') ?? '', /^faravan_local_session_[0-9a-f]+=/);
  await response.text();
  const replay = await boundedFetch(first, {redirect: 'manual'});
  assert.equal(replay.status, 401, 'a handoff code works once');
  await replay.text();
  const again = await boundedFetch(second, {redirect: 'manual'});
  assert.equal(again.status, 302);
  await again.text();
});

test('refuseFraming adds to an existing CSP instead of sending a second one', () => {
  const sent = [];
  const response = {getHeader: () => undefined, writeHead(...args) { sent.push(args); return this; }};
  refuseFraming(response).writeHead(200, {'Content-Security-Policy': "default-src 'none'; sandbox"});
  refuseFraming(response).writeHead(200, {'Content-Security-Policy': "default-src 'none'; frame-ancestors 'self'"});
  refuseFraming(response).writeHead(200, {'Content-Type': 'text/plain'});
  const [withCsp, replaced, plain] = sent.map(args => args.find(value => typeof value === 'object'));
  assert.equal(withCsp['Content-Security-Policy'], "default-src 'none'; sandbox; frame-ancestors 'none'");
  assert.equal(replaced['Content-Security-Policy'], "default-src 'none'; frame-ancestors 'none'");
  assert.equal(plain['Content-Security-Policy'], "frame-ancestors 'none'");
  assert.equal(plain['X-Frame-Options'], 'DENY');
  assert.equal(plain['Content-Type'], 'text/plain');
});

test('two parallel redeems of one handoff code: exactly one 302 and one 401, and the Location never echoes the code', async t => {
  const f = await appFixture(t);
  const {app} = await f.start('parallel-redeem');
  const link = app.url, code = new URL(link).searchParams.get('code');
  const [a, b] = await Promise.all([
    boundedFetch(link, {redirect: 'manual'}),
    boundedFetch(link, {redirect: 'manual'}),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [302, 401]);
  const winner = a.status === 302 ? a : b, loser = a.status === 302 ? b : a;
  assert.equal(winner.headers.get('location'), '/');
  assert.equal((winner.headers.get('location') ?? '').includes(code), false);
  assert.equal((loser.headers.get('location') ?? '').includes(code), false);
  await a.text(); await b.text();
});

test('handoff expiry uses a monotonic clock, so a wall-clock jump forward does not expire a live code', async t => {
  const {createLocalHandoff} = await import('../lib/v1/loopback-security.mjs');
  const {openSessionStore} = await import('../lib/v1/browser-sessions.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'faravan-monotonic-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const sessions = await openSessionStore(join(dir, 'sessions.json'));
  const realNow = Date.now();
  // Mocked before construction: the default clock is captured when createLocalHandoff is called.
  t.mock.method(Date, 'now', () => realNow);
  const handoff = createLocalHandoff({sessions});
  const code = handoff.issue();
  Date.now.mock.mockImplementation(() => realNow + 3600000);
  assert.ok(await handoff.redeem(code), 'an hour of wall-clock skew does not kill a 60 s code');
});
