import {click, flush, mount, resetPage, teardown} from './mounted.test-helper.mjs';
import {installViewport, restoreViewport} from './telemetry-viewport.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {FirstRunCard, PrivacyCard} from './telemetry-ui.jsx';
import {telemetryStore} from './telemetry-store.mjs';

// The notice acknowledgment (telemetry/notice) may run only while the notice is on screen in a visible tab, and
// a dismissed notice must stay dismissed across a reload. Localstorage is the only state a "reload" keeps.

const pendingView = () => ({level: null, effective: 'off', uploadable: true, reason: {kind: 'notice_pending'}, notice: {shown: false, pending: true}});
const acknowledgedView = view => ({...view, effective: 'on', reason: {kind: 'default'}, notice: {shown: true, pending: false}});

// A fake server: the view changes only when a POST is applied. `rejectNotice` makes the notice write fail before it commits.
function serverApi({rejectNotice = false} = {}) {
  const server = {view: pendingView(), posts: [], rejectNotice};
  server.api = {
    get: async () => server.view,
    post: async (path, body = {}) => {
      server.posts.push({path, body});
      if (path === 'telemetry/notice') {
        if (server.rejectNotice) throw new Error('The request did not reach the server.');
        server.view = acknowledgedView(server.view);
      } else if (path === 'telemetry/choose') {
        const level = body.level;
        server.view = {...server.view, level, effective: level, reason: {kind: 'choice'}, notice: {shown: true, pending: false}};
      }
      return server.view;
    },
  };
  return server;
}
const noticeCount = server => server.posts.filter(post => post.path === 'telemetry/notice').length;
const noticeOnScreen = () => document.querySelector('aside.telemetry-notice') !== null;
// Preact sets a radio's value as a property, not an attribute, so select by the property.
const radio = (page, level) => page.$$('input[name="telemetry-level"]').find(input => input.value === level);

let viewport;
beforeEach(() => { resetPage('#/setup'); telemetryStore.set(null); viewport = installViewport(); });
afterEach(async () => { await teardown(); telemetryStore.set(null); restoreViewport(); });

test('a hidden tab never acknowledges the notice, even when it is on screen', async () => {
  const server = serverApi();
  viewport.setVisibility('hidden');
  const page = await mount(h(FirstRunCard, {api: server.api, view: server.view}));
  assert.ok(noticeOnScreen(), 'the notice is rendered');
  viewport.deliver(true);
  await flush();
  assert.equal(noticeCount(server), 0, 'no acknowledgment while the tab is hidden');
  viewport.setVisibility('visible');
  viewport.deliver(true); // the fresh observation the tab's return asks for
  await flush();
  assert.equal(noticeCount(server), 1, 'the tab comes back into view: the one acknowledgment runs');
  viewport.deliver(true);
  viewport.setVisibility('visible');
  await flush();
  assert.equal(noticeCount(server), 1, 'repeat events do not acknowledge again');
  await page.unmount();
});

test('a visible notice that is scrolled out of the viewport is not acknowledged', async () => {
  const server = serverApi();
  const page = await mount(h(FirstRunCard, {api: server.api, view: server.view}));
  viewport.deliver(false);
  await flush();
  assert.equal(noticeCount(server), 0, 'visible tab, but the notice is not intersecting');
  viewport.deliver(true);
  await flush();
  assert.equal(noticeCount(server), 1, 'the notice enters the viewport: exactly one acknowledgment');
  viewport.deliver(false);
  viewport.deliver(true);
  viewport.setVisibility('visible');
  await flush();
  assert.equal(noticeCount(server), 1, 'later intersection and visibility events add nothing');
  await page.unmount();
});

test('a notice that unmounts before its queued intersection callback never acknowledges', async () => {
  const server = serverApi();
  const page = await mount(h(FirstRunCard, {api: server.api, view: server.view}));
  const observer = viewport.created.at(-1); // undefined on a base without an observer; the no-POST check still runs
  await page.unmount();
  if (observer) {
    assert.equal(observer.disconnected, true, 'the observer is disconnected on unmount');
    viewport.deliverLate(observer, true);
  }
  assert.equal(viewport.visibilityListeners(), 0, 'the visibility listener is removed on unmount');
  viewport.setVisibility('visible');
  await flush();
  assert.equal(noticeCount(server), 0, 'the late callback and the later visibility change post nothing');
});

test('a notice that moved offscreen while hidden is not acknowledged by the tab coming back, with no new observer entry', async () => {
  const server = serverApi();
  viewport.setVisibility('hidden');
  const page = await mount(h(FirstRunCard, {api: server.api, view: server.view}));
  viewport.deliver(true); // a stale "intersecting" entry from before the layout change
  await flush();
  viewport.place('offscreen'); // layout moves; the observer is not told
  viewport.setVisibility('visible');
  await flush();
  assert.equal(noticeCount(server), 0, 'the notice is not on screen now, so nothing is acknowledged');
  await page.unmount();
});

for (const [name, dismiss] of [
  ['Close', () => document.querySelector('button[aria-label="Close"]')],
  ['Settings link', () => document.querySelector('aside.telemetry-notice a[href="#/you/data"]')],
]) {
  test(`a queued intersection callback that runs after ${name} is pressed, before cleanup, posts nothing`, async () => {
    const server = serverApi();
    const page = await mount(h(FirstRunCard, {api: server.api, view: server.view}));
    const observer = viewport.created.at(-1);
    dismiss().click(); // raw click: the state update and effect cleanup have not run yet
    viewport.deliverLate(observer, true);
    await flush();
    assert.equal(noticeCount(server), 0, 'the dismissal interval posts no acknowledgment');
    assert.equal(noticeOnScreen(), false, 'and the notice stays dismissed');
    await page.unmount();
  });
}

for (const [name, dismiss] of [
  ['Close', () => document.querySelector('button[aria-label="Close"]')],
  ['Settings link', page => page.button('Change in Settings')],
]) {
  test(`dismissing the notice with ${name} survives a failed write and a reload`, async () => {
    const server = serverApi({rejectNotice: true});
    const first = await mount(h(FirstRunCard, {api: server.api, view: server.view}));
    viewport.deliver(true);
    await flush();
    assert.equal(noticeCount(server), 1, 'the acknowledgment was attempted and failed');
    assert.equal(server.view.effective, 'off', 'the server did not apply it');
    assert.ok(noticeOnScreen());
    await click(dismiss(first));
    assert.equal(noticeOnScreen(), false, 'dismissed in this session');
    await first.unmount();

    // Reload: a new page with the same browser storage and the same unapplied server state.
    const second = await mount(h(FirstRunCard, {api: server.api, view: server.view}));
    viewport.deliver(true);
    viewport.setVisibility('visible');
    await flush();
    assert.equal(second.text(), '', 'the dismissed notice stays absent after reload');
    assert.equal(noticeCount(server), 1, 'no new acknowledgment after reload');
    assert.equal(server.view.effective, 'off', 'the dismissal did not turn telemetry on');
    await second.unmount();
  });
}

test('with browser storage denied, the notice is never acknowledged, because a dismissal could not be kept', async () => {
  const server = serverApi();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {configurable: true, get() { throw new Error('storage is disabled'); }});
  try {
    const first = await mount(h(FirstRunCard, {api: server.api, view: server.view}));
    viewport.deliver(true);
    viewport.setVisibility('visible');
    await flush();
    assert.equal(noticeCount(server), 0, 'no acknowledgment without durable storage');
    await click(document.querySelector('button[aria-label="Close"]'));
    assert.equal(noticeOnScreen(), false, 'dismissed in this session');
    await first.unmount();
    const second = await mount(h(FirstRunCard, {api: server.api, view: server.view}));
    viewport.deliver(true);
    await flush();
    assert.equal(noticeCount(server), 0, 'after a reload the notice still makes no acknowledgment');
    assert.equal(server.view.effective, 'off', 'telemetry stays off');
    await second.unmount();
  } finally {
    Object.defineProperty(globalThis, 'localStorage', original);
  }
});

test('after a dismissed notice, an explicit Settings Off stays Off and an explicit On follows the server success path', async () => {
  const server = serverApi({rejectNotice: true});
  localStorage.setItem('faravan-telemetry-notice-dismissed-v1', '1');
  telemetryStore.set(null);
  const page = await mount(h(PrivacyCard, {api: server.api, view: server.view}));
  await click(radio(page, 'off'));
  assert.deepEqual(server.posts.map(post => [post.path, post.body]), [['telemetry/choose', {level: 'off'}]]);
  assert.equal(server.view.effective, 'off');
  await page.unmount();

  const next = await mount(h(PrivacyCard, {api: server.api, view: server.view}));
  await click(radio(next, 'on'));
  assert.deepEqual(server.posts.at(-1), {path: 'telemetry/choose', body: {level: 'on'}});
  assert.equal(server.view.effective, 'on', 'the explicit choice is applied by the server');
  assert.equal(noticeCount(server), 0, 'the dismissal never posted an acknowledgment');
  await next.unmount();
});
