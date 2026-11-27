import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appFixture, api, boundedFetch } from './helpers/v1-app-fixture.mjs';

test('the tray can ask for a one-time sign-in link, and only with the session token', {timeout: 120000}, async t => {
  const f = await appFixture(t), {app} = await f.start('handoff-route');
  await api(app, '/api/handoff', {method: 'POST', token: null, status: 401});
  const {url} = await api(app, '/api/handoff', {method: 'POST', body: {}});
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/auth\/handoff\?code=[\w-]+$/);
  assert.equal(url.includes(app.token), false, 'the link never carries the long-lived token');
  const first = await boundedFetch(url, {redirect: 'manual'});
  assert.equal(first.status, 302);
  await first.text();
  const replay = await boundedFetch(url, {redirect: 'manual'});
  assert.equal(replay.status, 401, 'a link works once');
  await replay.text();
});
