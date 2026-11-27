import {advance, click, createFakeApi, flush, installClock, mount, resetPage, teardown} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {App} from './main.jsx';

// Batch 9 (P2-5): "Approve each computer" is saved only when the circle list shows the new value. Home can answer
// first; the switch keeps saving until the circles read has been answered, so it never reverts to the old value.
const circle = {id: 'c1', name: 'Weekend projects', origin: 'http://x', owned: true, selected: true, approveEach: false};
const table = () => ({
  readiness: {ok: true}, home: () => ({observedAt: new Date(Date.now()).toISOString(), lending: {enabled: false}}),
  circles: [circle], agents: [], devices: {name: 'MacBook', fingerprint: 'fp-1', circles: []},
  approvals: [], activity: [], jobs: [], hosting: {state: 'off'}, updates: {},
});
beforeEach(() => { resetPage('#/circle/c1'); installClock(); });
afterEach(teardown);

test('Approve each computer stays saving until the circle list has been re-read', async () => {
  const api = createFakeApi(table());
  const view = await mount(h(App, {api, takeJoinLink: () => ''}));
  await api.release();
  await advance(1000);
  await click(view.$('#circle-tab-settings'));
  const approval = () => view.$('[aria-label="Approve each computer"]');
  assert.equal(approval().getAttribute('aria-checked'), 'false');
  await click(approval());
  assert.equal(api.postsOf('circles/c1/approval-mode').at(-1)?.body.approveEach, true, 'the choice is written');
  await api.release(path => path === 'home');
  assert.equal(api.openReads('circles').length > 0, true, 'the circle list has not been re-read yet');
  assert.match(view.text(), /Saving approval choice/, 'the switch still reports the save');
  assert.equal(approval().getAttribute('aria-busy'), 'true');
  while (api.openReads('circles').length) await api.answer('circles', [{...circle, approveEach: true}]);
  await flush();
  assert.equal(view.text().includes('Saving approval choice'), false, 'the save is done once the new value is on screen');
  assert.equal(approval().getAttribute('aria-checked'), 'true');
  await view.unmount();
});
