import {advance, click, flush, installClock, mount, resetPage, teardown} from './mounted.test-helper.mjs';
import test, {beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {Phone} from './phone.jsx';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const claimed = {enabled: true, confirmHere: true, computer: 'Studio Mac', reach: {state: 'http'}, phones: [],
  pairing: {id: 'p1', state: 'claimed', phrase: ['amber', 'otter', 'lamp'], expiresAt: new Date(NOW + 60000).toISOString(), phone: {label: 'Tablet'}, scopes: []}};
beforeEach(() => { resetPage('#/settings'); installClock(NOW); });
afterEach(teardown);
const button = (view, text) => [...view.container.querySelectorAll('button')].find(node => node.textContent === text);

test('remote confirmation shows the host and words, cancels, and keeps its permission through live updates', async () => {
  const calls = [];
  const initial = {...claimed, confirmHere: false};
  const api = {post: async (path, body) => { calls.push([path, body]); return {...initial, pairing: null}; }};
  const view = await mount(h(Phone, {initial, api, now: NOW}));
  assert.ok(!button(view, 'The words match — pair'), 'remote sessions must not offer host confirmation');
  assert.ok(!button(view, 'They don’t match'));
  assert.match(view.container.textContent, /Waiting for you to confirm on Studio Mac…/);
  assert.match(view.container.textContent, /Open Faravan on Studio Mac and check the words there\./);
  assert.match(view.container.textContent, /amber · otter · lamp/);
  const {confirmHere, ...live} = claimed;
  await view.rerender(h(Phone, {initial, live, api, now: NOW}));
  await flush();
  assert.ok(!button(view, 'The words match — pair'));
  await click(button(view, 'Cancel'));
  assert.deepEqual(calls, [['phone/pairing/cancel', {id: 'p1'}]]);
  assert.equal(view.$('.phone-confirm'), null);
});

test('confirmation timeout tells the user what happened and how to restart', async () => {
  for (const pairing of [{...claimed.pairing, state: 'expired'}, claimed.pairing]) {
    const view = await mount(h(Phone, {initial: {...claimed, confirmHere: false, pairing}, now: NOW + 120000}));
    assert.match(view.container.textContent, /Pairing was not confirmed in time\. Start pairing again when your device is ready\./);
    assert.ok(!button(view, 'The words match — pair'));
    await view.unmount();
  }
});

test('host confirms successfully and confirmation errors stay inside the card for every session', async () => {
  const calls = [];
  const api = {post: async (path, body) => { calls.push([path, body]); return {...claimed, pairing: null}; }};
  const view = await mount(h(Phone, {initial: claimed, api, now: NOW}));
  await click(button(view, 'The words match — pair'));
  assert.deepEqual(calls, [['phone/pairing/confirm', {id: 'p1', confirmed: true}]]);
  assert.equal(view.$('.phone-confirm'), null);
  await view.unmount();
  // A host window can become remote while a confirm response is in flight.
  for (const confirmHere of [true, false]) {
    let reject;
    const failure = {post: () => new Promise((resolve, no) => { reject = no; })};
    const pending = await mount(h(Phone, {initial: claimed, api: failure, now: NOW}));
    await click(button(pending, 'The words match — pair'));
    await pending.rerender(h(Phone, {initial: claimed, live: {...claimed, confirmHere}, api: failure, now: NOW}));
    reject({code: 'confirm_on_this_computer'});
    await flush();
    assert.match(pending.$('.phone-confirm [role="alert"]')?.textContent ?? '', /Confirm the pairing/);
    await pending.unmount();
  }
});

test('an open confirmation expires without waiting for a server event', async () => {
  const view = await mount(h(Phone, {initial: {...claimed, confirmHere: false}}));
  await advance(60000);
  assert.match(view.text(), /Pairing was not confirmed in time/);
  assert.equal(view.$('.phone-confirm'), null);
});
