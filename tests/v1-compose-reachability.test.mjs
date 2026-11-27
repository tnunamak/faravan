import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api,boundedFetch} from './helpers/v1-app-fixture.mjs';
import {json} from './helpers/v1-journey.mjs';

// Whether a circle's host answers is evidence only from the host's own answer. Owning a circle says where it is hosted,
// not that its origin answers, so an owned circle whose host does not answer is not reachable.
const PRESENCE_PAGE = {now: '2026-10-24T00:00:00Z', online_seconds: 90, devices: [], persons: []};

function presenceTransport(mode) {
  return async (url, options = {}) => {
    if (new URL(url).pathname.endsWith('/presence') && mode.value === 'down') throw new TypeError('synthetic host outage');
    return boundedFetch(url, options);
  };
}

test('an owned circle whose host does not answer is not reachable', {timeout: 60000}, async t => {
  const f = await appFixture(t);
  const previous = f.override;
  f.override = async details => {
    if (details.route === '/presence' && details.req.method === 'GET') {
      json(details.res, PRESENCE_PAGE);
      return true;
    }
    return previous(details);
  };
  const mode = {value: 'up'};
  const owner = await f.start('owner', {autoApprove: false, pollMs: 250, fetch: presenceTransport(mode)});
  await f.provisionFromHome('owner');
  const circle = await api(owner.app, '/api/circles', {method: 'POST', body: {origin: f.origin, name: 'Hosted here'}});
  const hostOf = async () => (await api(owner.app, '/api/circles/' + circle.id + '/compose')).host;
  assert.equal((await hostOf()).reachable, true, 'a host that answers is reachable');
  mode.value = 'down';
  assert.equal((await hostOf()).reachable, false, 'an owned circle whose host does not answer is not reachable');
});

test('an owned circle hosted on another computer is not reachable while that computer does not answer', {timeout: 60000}, async t => {
  const f = await appFixture(t);
  const owner = await f.start('owner', {autoApprove: false, pollMs: 250});
  await f.provisionFromHome('owner');
  // Nothing listens on port 9 here, which stands for another computer that is off.
  const away = await api(owner.app, '/api/circles', {method: 'POST', body: {origin: 'http://127.0.0.1:9', name: 'Hosted elsewhere', publish: false}});
  const host = (await api(owner.app, '/api/circles/' + away.id + '/compose')).host;
  assert.equal(host.reachable, false, 'ownership does not make another computer reachable');
});
