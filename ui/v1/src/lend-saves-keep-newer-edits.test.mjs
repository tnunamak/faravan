import {act, click, flush, installClock, mount, resetPage, teardown, window} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {AgentCard, RequesterLimitsControl} from './lend.jsx';

// Batch 9 (C3): a save clears only the draft it sent. An edit made while the save is in flight stays in the form,
// and so does a draft opened after Cancel. Only the saved value is replaced by the server's answer.
beforeEach(() => { resetPage('#/lend'); installClock(); });
afterEach(teardown);

function deferredWrites() {
  const writes = [];
  const mutate = (path, body) => new Promise(resolve => { writes.push({path, body, resolve}); });
  return {writes, mutate};
}
const edit = async (control, value) => {
  await act(() => { control.value = value; control.dispatchEvent(new window.Event('input', {bubbles: true})); });
  await flush();
};
const change = async (select, value) => {
  await act(() => { select.value = value; select.dispatchEvent(new window.Event('change', {bubbles: true})); });
  await flush();
};
const buttonNamed = (view, label) => view.$$('button').find(b => b.textContent.trim() === label);

const agent = {id: 'codex', installed: true, signedIn: true, useForLending: false, models: ['gpt-a', 'gpt-b'], run: {model: 'gpt-a', effort: 'low'}};
const ready = {key: 'agent', status: 'ok', detail: 'Ready.'};

test('saving model and effort keeps an effort chosen while the save is in flight', async () => {
  const {writes, mutate} = deferredWrites();
  const view = await mount(h(AgentCard, {agent, api: {}, mutate, refresh() {}, blocker: ready}));
  await click(view.$('summary'));
  const [model, effort] = view.$$('form[aria-label="Model and effort"] select');
  await change(model, 'gpt-b');
  await click(buttonNamed(view, 'Save'));
  assert.deepEqual(writes.map(w => [w.path, w.body]), [['agents/codex/run', {model: 'gpt-b', effort: 'low'}]]);
  await change(effort, 'high');
  await act(() => { writes[0].resolve([]); });
  await flush();
  assert.equal(view.$$('form[aria-label="Model and effort"] select')[1].value, 'high', 'the newer effort is still there after the save answers');
  await view.unmount();
});

test('saving device limits keeps an edit typed while the save is in flight', async () => {
  const {writes, mutate} = deferredWrites();
  const view = await mount(h(RequesterLimitsControl, {circleId: 'c1', keyId: 'k1', value: {limits: {dailyJobs: 2}}, mutate}));
  await click(buttonNamed(view, 'Edit device limits'));
  await edit(view.$('input'), '3');
  await click(buttonNamed(view, 'Save device limits'));
  assert.deepEqual(writes.map(w => [w.path, w.body.limits]), [['lending/requester-limits', {dailyJobs: 3, dailyMinutes: null}]]);
  await edit(view.$('input'), '5');
  await act(() => { writes[0].resolve({}); });
  await flush();
  assert.equal(view.$('form').hidden, false, 'the form stays open for the newer edit');
  assert.equal(view.$('input').value, '5', 'the newer value is kept, not reset to the saved one');
  await view.unmount();
});

test('an answer for a cancelled save does not close a draft opened afterwards', async () => {
  const {writes, mutate} = deferredWrites();
  const view = await mount(h(RequesterLimitsControl, {circleId: 'c1', keyId: 'k1', value: {limits: {dailyJobs: 2}}, mutate}));
  await click(buttonNamed(view, 'Edit device limits'));
  await edit(view.$('input'), '3');
  await click(buttonNamed(view, 'Save device limits'));
  await click(buttonNamed(view, 'Cancel'));
  await click(buttonNamed(view, 'Edit device limits'));
  await edit(view.$('input'), '7');
  await act(() => { writes[0].resolve({}); });
  await flush();
  assert.equal(view.$('form').hidden, false, 'the draft opened after Cancel is still open');
  assert.equal(view.$('input').value, '7');
  await view.unmount();
});
