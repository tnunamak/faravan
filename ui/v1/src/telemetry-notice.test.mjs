import {click, flush, mount, resetPage, teardown} from './mounted.test-helper.mjs';
import {installViewport, restoreViewport} from './telemetry-viewport.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {FirstRunCard} from './telemetry-ui.jsx';
import {telemetryStore} from './telemetry-store.mjs';

let viewport;
beforeEach(() => { resetPage('#/setup'); telemetryStore.set(null); viewport = installViewport(); });
afterEach(async () => { await teardown(); telemetryStore.set(null); restoreViewport(); });
// The notice is acknowledged only once it is on screen in a visible tab; the tests deliver that event.
const onScreen = async () => { viewport.deliver(true); await flush(); };

const pending = () => ({level: null, effective: 'off', uploadable: true, reason: {kind: 'notice_pending'}, notice: {shown: false, pending: true}});

test('displaying the notice records it, sends nothing before that, and leaves a close control and a Settings link', async () => {
  let view = pending();
  const posts = [];
  const api = {get: async () => view, post: async (path, body) => {
    posts.push({path, body});
    view = {...view, effective: 'on', reason: {kind: 'default'}, notice: {shown: true, pending: false}};
    return view;
  }};
  const page = await mount(h(FirstRunCard, {api, view}));
  await onScreen();
  assert.deepEqual(posts, [{path: 'telemetry/notice', body: {}}], 'only the notice is recorded; no choice is posted');
  assert.match(page.text(), /Faravan sends usage data to help improve it/); assert.doesNotMatch(page.text(), /record/i);
  assert.equal(page.button('Turn reports off'), null, 'no choice buttons in the notice');
  assert.ok(document.querySelector('button[aria-label="Close"]'), 'the notice has a named close control');
  assert.equal(page.button('Change in Settings').getAttribute('href'), '#/you/data');
});

test('closing the notice hides it, posts no choice, and it does not return', async () => {
  let view = pending();
  const posts = [];
  const api = {get: async () => view, post: async (path, body) => {
    posts.push({path, body});
    view = {...view, effective: 'on', reason: {kind: 'default'}, notice: {shown: true, pending: false}};
    return view;
  }};
  const page = await mount(h(FirstRunCard, {api, view}));
  await onScreen();
  await click(document.querySelector('button[aria-label="Close"]'));
  assert.equal(page.text(), '');
  await page.rerender(h(FirstRunCard, {api, view}));
  assert.equal(page.text(), '', 'recorded as shown, so it stays closed');
  assert.deepEqual(posts.map(post => post.path), ['telemetry/notice'], 'closing never changes the consent choice');
  await page.unmount();
  const later = await mount(h(FirstRunCard, {api, view}));
  assert.equal(later.text(), '', 'a later visit does not show it again');
});

test('following the Settings link hides the notice without posting a choice', async () => {
  let view = pending();
  const posts = [];
  const api = {get: async () => view, post: async (path, body) => {
    posts.push({path, body});
    view = {...view, effective: 'on', reason: {kind: 'default'}, notice: {shown: true, pending: false}};
    return view;
  }};
  const page = await mount(h(FirstRunCard, {api, view}));
  await onScreen();
  await click(page.button('Change in Settings'));
  assert.equal(page.text(), '');
  assert.deepEqual(posts.map(post => post.path), ['telemetry/notice']);
});

test('an existing Off choice and an environment restriction never acknowledge a new notice', async () => {
  for (const view of [{...pending(), level: 'off', effective: 'off', reason: {kind: 'choice'}, notice: {shown: true, pending: false}},
    {...pending(), reason: {kind: 'env', env: 'DO_NOT_TRACK'}, notice: {shown: false, pending: false}}]) {
    const posts = [];
    telemetryStore.set(view);
    const page = await mount(h(FirstRunCard, {api: {get: async () => view, post: async (...args) => { posts.push(args); return view; }}, view}));
    assert.equal(page.text(), '');
    assert.deepEqual(posts, []);
    await page.unmount();
  }
});

test('a build that cannot upload shows no banner and never records the notice', async () => {
  const view = {...pending(), uploadable:false};
  const posts = [];
  const api = {get:async()=>view,post:async(...args)=>{posts.push(args);return view;}};
  const page = await mount(h(FirstRunCard,{api,view}));
  assert.equal(page.text(),'');
  await page.rerender(h(FirstRunCard,{api,view}));
  assert.equal(page.text(),'');
  assert.deepEqual(posts,[]);
});

test('a failed acknowledgment keeps the notice open with a Retry that posts once, only while on screen', async () => {
  let view = pending();
  const posts = [];
  let failFirst, resolveRetry;
  let attempts = 0;
  const api = {get: async () => view, post: async (path, body) => {
    posts.push({path, body});
    attempts++;
    if (attempts === 1) return new Promise((_, reject) => { failFirst = () => reject(new Error('upload failed')); });
    return new Promise(resolve => { resolveRetry = () => resolve(view); });
  }};
  const page = await mount(h(FirstRunCard, {api, view}));
  await onScreen();
  assert.deepEqual(posts, [{path: 'telemetry/notice', body: {}}], 'only the notice is recorded; no choice is posted');
  failFirst();
  await flush();
  assert.match(page.text(), /Faravan sends usage data to help improve it/, 'the notice stays open after a failed acknowledgment');
  assert.match(page.text(), /could not be recorded/, 'a fixed local failure message is shown');
  assert.ok(page.button('Retry'), 'an accessible Retry is shown');
  assert.deepEqual(posts.map(post => post.path), ['telemetry/notice'], 'the failure posted nothing else');
  // Hidden/offscreen control: a Retry while the notice is not intersecting sends nothing.
  viewport.deliver(false);
  await flush();
  await click(page.button('Retry'));
  assert.deepEqual(posts.map(post => post.path), ['telemetry/notice'], 'no retry while the notice is off screen');
  assert.match(page.text(), /could not be recorded/, 'the failure message stays until a retry succeeds');
  // Back on screen: one explicit Retry dispatches the one ordinary notice POST.
  viewport.deliver(true);
  await flush();
  assert.equal(posts.length, 1, 'the observer cannot retry the failed write');
  await click(page.button('Retry'));
  assert.deepEqual(posts, [{path: 'telemetry/notice', body: {}}, {path: 'telemetry/notice', body: {}}]);
  assert.equal(page.button('Retry'), null, 'there is no second Retry action while the write is pending');
  viewport.deliver(true);
  await flush();
  assert.equal(posts.length, 2, 'no duplicate while the retry is in flight');
  // Held success: only the confirmed server response changes the visible state.
  view = {...view, effective: 'on', reason: {kind: 'default'}, notice: {shown: true, pending: false}};
  resolveRetry();
  await flush();
  assert.doesNotMatch(page.text(), /could not be recorded/, 'the failure message clears on success');
  assert.match(page.text(), /Faravan sends usage data to help improve it/);
  assert.equal(posts.length, 2, 'success posts nothing further');
  viewport.deliver(true);
  await flush();
  assert.equal(posts.length, 2, 'no further acknowledgment after success');
});

test('a build that can upload shows the short notice and records it', async () => {
  let view = pending();
  const posts = [];
  const api = {get: async () => view, post: async (path, body) => { posts.push({path, body}); return view; }};
  const page = await mount(h(FirstRunCard, {api, view}));
  await onScreen();
  assert.match(page.text(), /Change in Settings/);
  assert.deepEqual(posts, [{path: 'telemetry/notice', body: {}}]);
});
