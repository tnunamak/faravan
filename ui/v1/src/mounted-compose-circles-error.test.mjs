import {advance, click, createFakeApi, installClock, mount, resetPage, teardown} from './mounted.test-helper.mjs';
import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {App} from './main.jsx';

// Send a job on the real App: the first circles read fails. The shell holds the error, Compose shows it with Retry,
// and Retry reads circles again through the shell's own refresh.
const circle = {id: 'c1', name: 'Weekend projects', origin: 'http://x', owned: true, selected: true};
const table = {
  readiness: {ok: true}, home: () => ({observedAt: new Date(Date.now()).toISOString(), lending: {enabled: false}}),
  circles: [circle], agents: [], devices: {name: 'MacBook', fingerprint: 'fp-1', circles: []},
  approvals: [], activity: [], jobs: [], hosting: {state: 'off'},
};
afterEach(teardown);

test('App mounted: a failed first circles read shows Retry on Send a job, and Retry recovers the composer', async () => {
  resetPage('#/borrow'); installClock();
  const api = createFakeApi(table);
  const view = await mount(h(App, {api, takeJoinLink: () => ''}));
  await api.fail('circles', Object.assign(new Error('offline'), {code: 'network_error'}));
  await api.release(path => path !== 'circles');
  await advance(2000);
  assert.match(view.text(), /Circles could not be loaded/);
  assert.match(view.text(), /Your saved request has not changed/);
  const before = api.count('circles');
  await click(view.button('Retry circles'));
  assert.equal(api.count('circles'), before + 1, 'Retry reads circles again');
  await api.answer('circles');
  await api.release();
  await advance(2000);
  assert.doesNotMatch(view.text(), /Circles could not be loaded/);
});
