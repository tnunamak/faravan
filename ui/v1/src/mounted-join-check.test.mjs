import {click, createFakeApi, flush, mount, resetPage, teardown} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {Circle} from './circles.jsx';

// After the owner approves, a joined circle never reads as pending. While this computer's own
// check is running, the card says it is checking instead of asking the owner to approve again.
beforeEach(() => resetPage('#/circle/c1'));
afterEach(teardown);

test('a pending ask-each join names the owner action, then shows an active approval check', async () => {
  let answer;
  const mutate = path => new Promise(resolve => { answer = () => resolve({state: 'approved'}); });
  const circle = {id: 'c1', name: 'G2 friends', origin: 'http://10.23.1.2:4000', enrollment: {state: 'pending', enrollment_id: 'e1'},
    joinInfo: {approval: 'each', ownerName: 'Alex Rivera', code: '5EBBCE'}};
  const api = createFakeApi();
  const view = await mount(h(Circle, {id: 'c1', circles: [circle], data: {circles: [circle], devices: {circles: []}}, mutate, api, revision: 0, setDialog: () => {}, headingRef: {current: null}}));
  assert.match(view.text(), /Ask Alex Rivera to approve this computer/, 'before any check the request is pending');
  await click(view.button('Check approval'));
  assert.doesNotMatch(view.text(), /Ask Alex Rivera to approve/, 'a check in progress is not evidence of pending');
  assert.match(view.text(), /Checking whether Alex Rivera approved this computer/);
  answer(); await flush();
});
