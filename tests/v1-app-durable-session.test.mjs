import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appFixture, api, boundedFetch } from './helpers/v1-app-fixture.mjs';

const testOptions = {timeout: 120000};
async function signIn(app) {
  const response = await boundedFetch(app.handoffUrl(), {redirect: 'manual'});
  await response.text();
  assert.equal(response.status, 302);
  return {header: response.headers.get('set-cookie'), cookie: response.headers.get('set-cookie').split(';')[0]};
}

test('a signed-in browser stays signed in when the app restarts on the same address', testOptions, async t => {
  const f = await appFixture(t);
  const first = (await f.start('restart')).app;
  const {header, cookie} = await signIn(first);
  assert.match(header, /^faravan_local_session_[0-9a-f]+=[\w-]+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Strict$/);
  const port = first.server.address().port;
  const pending = first.handoffUrl();
  await first.close();
  const second = (await f.start('restart')).app;
  assert.equal(second.server.address().port, port, 'the app comes back on the port the open tab uses');
  await api(second, '/api/status', {token: null, headers: {cookie}});
  const stale = await boundedFetch(pending.replace(/:\d+\//, ':' + second.server.address().port + '/'), {redirect: 'manual'});
  await stale.text();
  assert.equal(stale.status, 401, 'an unused sign-in link does not outlive the app that issued it');
  const sessions = await readFile(join(await f.home('restart'), 'v1', 'sessions.json'), 'utf8');
  assert.equal(sessions.includes(cookie.split('=')[1]), false, 'the session file holds no cookie value');
});

test('when the remembered port is taken the app starts elsewhere instead of failing, and the cookie still works', testOptions, async t => {
  const f = await appFixture(t);
  const first = (await f.start('moved')).app;
  const {cookie} = await signIn(first);
  const port = first.server.address().port;
  await first.close();
  const squatter = createServer();
  squatter.listen(port, '127.0.0.1');
  await once(squatter, 'listening');
  t.after(() => squatter.close());
  const second = (await f.start('moved')).app;
  assert.notEqual(second.server.address().port, port);
  await api(second, '/api/status', {token: null, headers: {cookie}});
  const discovery = JSON.parse(await readFile(join(await f.home('moved'), 'v1', 'app.json'), 'utf8'));
  const moved = second.server.address().port;
  assert.equal(discovery.port, moved, 'the tray finds the new address');
  await second.close();
  squatter.close();
  await once(squatter, 'close');
  const third = (await f.start('moved')).app;
  assert.equal(third.server.address().port, moved, 'the new address is the one remembered');
});

test('a port the person chose is kept when the app restarts without --port, as a self-update does', testOptions, async t => {
  const f = await appFixture(t);
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const chosen = probe.address().port;
  probe.close();
  await once(probe, 'close');
  const first = (await f.start('chosen', {port: chosen})).app;
  assert.equal(first.server.address().port, chosen);
  await first.close();
  const relaunched = (await f.start('chosen')).app;
  assert.equal(relaunched.server.address().port, chosen, 'the open tab finds the app where the person put it');
});

test('an explicit port that is taken still fails loudly', testOptions, async t => {
  const f = await appFixture(t);
  const squatter = createServer();
  squatter.listen(0, '127.0.0.1');
  await once(squatter, 'listening');
  t.after(() => squatter.close());
  await assert.rejects(f.start('explicit', {port: squatter.address().port}), /EADDRINUSE/);
});

test('a remembered session file from another kind of session never signs the owner in', testOptions, async t => {
  const f = await appFixture(t);
  const {app} = await f.start('kinds');
  await api(app, '/api/status', {token: null, headers: {cookie: 'faravan_local_session_0=forged'}, status: 401});
});
