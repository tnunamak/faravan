// Import the real mounted kit first so component imports see its synthetic DOM.
import {mount, teardown, resetPage, installClock, advance, flush, act,
  click, forceClick, window} from './mounted.test-helper.mjs';
import {test, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {SignIn} from './signin.jsx';
import {POLL_MS, ACTION_LABELS} from './signin.mjs';
import {setupVM} from './view-models.mjs';

// These are local enrollment controls, not Docker preparation or W11 evidence.
// No real popup, service, credential, network, or account mutation is used.
let restoreOpen, pending, calls, opened;
beforeEach(() => {
  resetPage(); installClock();
  pending = []; calls = []; opened = [];
  const original = window.open;
  window.open = (...args) => { opened.push(args); return null; };
  restoreOpen = () => { window.open = original; };
});
afterEach(async () => {
  try {
    await teardown(); // unmount/effect cleanup before resolving ignored callbacks
    for (const call of pending) if (!call.done) call.resolve({
      flowId: 'synthetic-disposed', target: 'docker', status: 'cancelled',
    });
    await flush();
  } finally { restoreOpen(); resetPage(); }
});
function deferredCall(method, path, body) {
  const call = {method, path, body, done: false};
  const promise = new Promise((resolve, reject) => {
    call.resolve = value => { call.done = true; resolve(value); };
    call.reject = error => { call.done = true; reject(error); };
  });
  calls.push(call); pending.push(call);
  return promise;
}
const api = {
  get: path => deferredCall('GET', path),
  post: (path, body) => deferredCall('POST', path, body),
};
const flow = (status, extra = {}) => ({
  flowId: 'docker/flow 1', target: 'docker', status, ...extra,
});
const route = 'signin/docker%2Fflow%201';
const writes = () => calls.filter(call => call.method === 'POST');
const reads = () => calls.filter(call => call.method === 'GET');
async function settle(call, value) {
  assert.ok(call && !call.done, 'expected one pending API operation');
  await act(async () => { call.resolve(value); });
  await flush();
}
async function fixture() {
  const effects = {refresh: 0, waiting: []};
  const ui = await mount(h(SignIn, {
    api, target: 'docker', refresh: () => effects.refresh++,
    onWaiting: value => effects.waiting.push(value),
  }));
  assert.equal(calls.length, 0, 'mount must not start enrollment');
  assert.equal(opened.length, 0);
  return {ui, effects};
}
// happy-dom does not synthesize a native button's default keyboard click.
// Send the real key events, then model that browser-generated activation click.
// This tests the mounted handler/disabled guard, not browser keyboard defaults.
async function keyboardActivate(button, key = 'Enter') {
  assert.ok(button); assert.equal(button.tagName, 'BUTTON');
  button.focus(); assert.equal(document.activeElement, button);
  await act(() => {
    button.dispatchEvent(new window.KeyboardEvent('keydown', {key, bubbles: true}));
    button.dispatchEvent(new window.KeyboardEvent('keyup', {key, bubbles: true}));
    button.click();
  });
  await flush();
}
async function start(ui, state = flow('starting')) {
  await keyboardActivate(ui.button('Sign in to Docker'));
  const call = writes()[0];
  assert.equal(call.path, 'signin/docker');
  assert.deepEqual(Object.keys(call.body), ['requestId']);
  assert.equal(typeof call.body.requestId, 'string');
  assert.ok(call.body.requestId.length > 0);
  await settle(call, state);
  return call;
}
test('Docker activation starts exactly once; waiting retains the active flow', async () => {
  const {ui, effects} = await fixture();
  const button = ui.button('Sign in to Docker');
  await keyboardActivate(button);
  await forceClick(button); // an event on the still-mounted busy control
  assert.equal(writes().length, 1);
  const call = writes()[0];
  assert.equal(call.path, 'signin/docker');
  assert.deepEqual(Object.keys(call.body), ['requestId']);
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0], [
    '/#/signin/' + encodeURIComponent(call.body.requestId),
    '_blank', 'noopener,noreferrer',
  ]);
  await settle(call, flow('awaiting_browser', {
    url: 'https://example.invalid/device', code: 'SYNTHETIC-ONLY',
  }));
  assert.match(ui.text(), /SYNTHETIC-ONLY/);
  assert.match(ui.text(), /Waiting for you to finish/);
  assert.equal(ui.button('Open sign-in page').getAttribute('href'), 'https://example.invalid/device');
  assert.equal(ui.button('Sign in to Docker'), null);
  assert.equal(ui.button('Other ways to sign in'), null);
  await advance(POLL_MS);
  assert.equal(reads().length, 1);
  assert.equal(reads()[0].path, route);
  await settle(reads()[0], flow('awaiting_browser', {
    url: 'https://example.invalid/device', code: 'SYNTHETIC-ONLY',
  }));
  assert.equal(writes().length, 1);
  assert.equal(opened.length, 1);
  assert.equal(effects.refresh, 0);
});
test('targeted cancel wins over an earlier in-flight completion callback', async () => {
  const {ui, effects} = await fixture();
  await start(ui, flow('awaiting_browser', {url: 'https://example.invalid/device'}));
  await advance(POLL_MS);
  const stale = reads()[0];
  await click(ui.button('Cancel sign-in'));
  assert.equal(writes().length, 2);
  assert.equal(writes()[1].path, route + '/cancel');
  assert.deepEqual(writes()[1].body, {});
  await settle(writes()[1], flow('cancelled'));
  await settle(stale, flow('complete'));
  assert.match(ui.text(), /Sign-in cancelled/);
  assert.doesNotMatch(ui.text(), /Signed in/);
  assert.equal(effects.refresh, 0);
  const count = calls.length;
  await advance(POLL_MS * 3);
  assert.equal(calls.length, count);
});
test('late start response after unmount cannot notify success or render stale controls', async () => {
  const {ui, effects} = await fixture();
  await keyboardActivate(ui.button('Sign in to Docker'));
  const late = writes()[0];
  await ui.unmount();
  await settle(late, flow('complete'));
  await advance(POLL_MS * 2);
  assert.equal(effects.refresh, 0);
  assert.equal(document.querySelector('.signin'), null);
  assert.equal(calls.length, 1);
});
test('late poll after unmount cannot notify success or reschedule reads', async () => {
  const {ui, effects} = await fixture();
  await start(ui);
  await advance(POLL_MS);
  const late = reads()[0];
  await ui.unmount();
  await settle(late, flow('complete'));
  const count = calls.length;
  await advance(POLL_MS * 3);
  assert.equal(calls.length, count);
  assert.equal(effects.refresh, 0);
  assert.equal(document.querySelector('.signin'), null);
});
test('a supported code-entry response submits only to this Docker flow', async () => {
  const {ui, effects} = await fixture();
  await start(ui, flow('awaiting_browser', {
    codeEntry: true, url: 'https://example.invalid/device',
  }));
  const input = ui.$('input');
  assert.ok(input);
  await act(() => {
    input.value = '  synthetic-code  ';
    input.dispatchEvent(new window.Event('input', {bubbles: true}));
  });
  await flush();
  await act(() => ui.$('form').dispatchEvent(
    new window.Event('submit', {bubbles: true, cancelable: true})));
  await flush();
  assert.equal(writes().length, 2);
  assert.equal(writes()[1].path, route + '/code');
  assert.deepEqual(writes()[1].body, {code: 'synthetic-code'});
  await settle(writes()[1], flow('complete'));
  assert.match(ui.text(), /Signed in/);
  assert.equal(effects.refresh, 1);
  assert.equal(ui.$('form'), null);
  await advance(POLL_MS * 3);
  assert.equal(writes().length, 2);
  assert.equal(reads().length, 0);
});
test('a terminal failure offers one retry and no spontaneous new enrollment', async () => {
  const {ui, effects} = await fixture();
  const initial = await start(ui, flow('failed', {
    stage: 'backend_health', reasonCode: 'startup_failed',
  }));
  assert.equal(ui.$$('button').length, 1);
  assert.ok(ui.button(ACTION_LABELS.retry));
  assert.equal(ui.$$('[role="alert"]').length, 1);
  await advance(POLL_MS * 3);
  assert.equal(calls.length, 1);
  await keyboardActivate(ui.button(ACTION_LABELS.retry), ' ');
  assert.equal(writes().length, 2);
  assert.equal(writes()[1].path, 'signin/docker');
  assert.notEqual(writes()[1].body.requestId, initial.body.requestId);
  await settle(writes()[1], flow('starting'));
  assert.equal(effects.refresh, 0);
});
test('LOGIN completion refreshes once; unknown preparation still is not readiness', async () => {
  const {ui, effects} = await fixture();
  const input = {agents: [], status: {}, readiness: null};
  const before = setupVM(input);
  assert.equal(before.ready, false);
  assert.equal(before.steps.find(row => row.id === 'sandboxes').state, 'now');
  await start(ui);
  await advance(POLL_MS);
  await settle(reads()[0], flow('complete'));
  assert.equal(effects.refresh, 1);
  assert.match(ui.text(), /Signed in/);
  assert.equal(ui.$$('button').length, 0);
  // A refresh callback is not a producer readiness receipt. No invented
  // hasReading/agent selection or preparation flag is added to the fixture.
  const after = setupVM(input);
  assert.deepEqual(after, before);
  assert.equal(after.ready, false);
  const count = calls.length;
  await advance(POLL_MS * 3);
  assert.equal(calls.length, count);
  assert.equal(effects.refresh, 1);
  assert.deepEqual(writes().map(call => call.path), ['signin/docker']);
});
// Ready-transition coverage is deliberately not inferred from the masked tails
// of setupAgentCheckState/setupAgentRowsState. Real preparation/receipt and
// installed-app qualification remain separate release obligations.
