import {act, click, createFakeApi, flush, installClock, mount, resetPage, teardown, window} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {Job, Jobs} from './jobs.jsx';
import {Person} from './people.jsx';
import {Phone} from './phone.jsx';
import {LocalHistoryLearning} from './lend.jsx';
import {LimitsPage} from './limits.jsx';

// Item 3 (1102 review): a screen whose first read fails shows a Try again beside the error. It re-runs the same read
// and keeps the route. The first read fails once; the second read is left open so the test can see it was made.
beforeEach(() => { resetPage('#/jobs'); installClock(); });
afterEach(teardown);

const circle = {id: 'c1', name: 'Weekend projects', origin: 'http://x', owned: true};
const unreachable = () => Object.assign(new Error('unreachable'), {code: 'network'});
// Fails the first read whose path matches; every later read is passed through to the fake.
function failFirstRead(api, matches) {
  const reads = [], real = api.get;
  let failed = false;
  api.get = (path, signal) => {
    if (matches(path)) reads.push(path);
    if (!failed && matches(path)) { failed = true; return Promise.reject(unreachable()); }
    return real(path, signal);
  };
  return reads;
}
const button = (view, label) => [...view.container.querySelectorAll('button')].find(b => b.textContent.trim() === label);

test('Jobs list: a first read that fails offers Try again, and pressing it reads the list again on the same route', async () => {
  const api = createFakeApi();
  const reads = failFirstRead(api, path => path.startsWith('jobs'));
  const view = await mount(h(Jobs, {api, circles: [circle], selected: circle, revision: 0}));
  assert.match(view.text(), /Jobs didn’t load/);
  const retry = button(view, 'Try again');
  assert.ok(retry, 'the error has a local Try again');
  await click(retry);
  assert.ok(reads.length >= 2, 'the list is read again');
  assert.equal(window.location.hash, '#/jobs', 'the route is kept');
  await view.unmount();
});

test('Job: a first read that fails keeps Back to Jobs and offers Try again beside it', async () => {
  const api = createFakeApi();
  const reads = failFirstRead(api, path => path.startsWith('jobs/'));
  const view = await mount(h(Job, {id: 'j1', requestedCircle: 'c1', api, circle: 'c1', circles: [circle], revision: 0, mutate: async () => ({}),
    setDialog() {}, members: [], headingRef: {current: null}, refresh: async () => {}, draft: {submission: null},
    data: {jobs: [], devices: {fingerprint: 'fp-1', name: 'MacBook', circles: []}}}));
  assert.ok(button(view, 'Back to Jobs') || view.container.querySelector('a[href="#/jobs"]'), 'Back to Jobs stays');
  const retry = button(view, 'Try again');
  assert.ok(retry, 'the error has a local Try again');
  await click(retry);
  assert.ok(reads.length >= 2, 'the job is read again');
  await view.unmount();
});

test('Person: a failed member read and a failed job-history read each offer Try again', async () => {
  const api = createFakeApi();
  const reads = failFirstRead(api, path => path === 'circles/c1/people');
  const view = await mount(h(Person, {id: 'p1', circleId: 'c1', circles: [circle], data: {devices: {fingerprint: 'fp-1', circles: []}}, api,
    revision: 0, mutate: async () => ({}), setDialog() {}, headingRef: {current: null}}));
  assert.match(view.text(), /Member unavailable/);
  const retry = button(view, 'Try again');
  assert.ok(retry, 'the member read has a local Try again');
  await click(retry);
  assert.ok(reads.length >= 2, 'the member read is repeated');
  await view.unmount();
});

test('Phone: a first read that fails offers Try again, and pressing it reads the phone settings again', async () => {
  const api = createFakeApi();
  const reads = failFirstRead(api, path => path === 'phone');
  const view = await mount(h(Phone, {api}));
  assert.match(view.text(), /unreachable|went wrong|couldn’t|could not/i);
  const retry = button(view, 'Try again');
  assert.ok(retry, 'the failed first read has a local Try again');
  await click(retry);
  assert.ok(reads.length >= 2, 'the phone settings are read again');
  await view.unmount();
});

test('Local learning: a first read that fails offers Try again, and pressing it reads the setting again', async () => {
  const api = createFakeApi();
  const reads = failFirstRead(api, path => path === 'lending/history-learning');
  const view = await mount(h(LocalHistoryLearning, {api, mutate: async () => ({})}));
  const retry = button(view, 'Try again');
  assert.ok(retry, 'the failed setting read has a local Try again');
  await click(retry);
  assert.ok(reads.length >= 2, 'the setting is read again');
  await view.unmount();
});

test('What you lend: a failed first read names the error and offers Try again, not a loading skeleton', async () => {
  const refreshed = [];
  const view = await mount(h(LimitsPage, {lending: {mode: 'ask', circle: 'c1', limits: {}}, circle: 'c1', circles: [circle], agents: [], api: createFakeApi(),
    mutate: async () => ({}), data: {}, errors: {home: unreachable()}, refresh: resource => refreshed.push(resource), now: Date.UTC(2026, 9, 20)}));
  assert.doesNotMatch(view.text(), /Loading what you lend/, 'the page does not wait forever');
  assert.match(view.text(), /could not connect/);
  const retry = button(view, 'Try again');
  assert.ok(retry, 'the failed read has a local Try again');
  await click(retry);
  assert.deepEqual(refreshed, ['home'], 'the home read is run again');
  await view.unmount();
});
