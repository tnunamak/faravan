import {act, flush, installClock, mount, resetPage, teardown, window} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {ComputerLink, CircleAuthority} from './people.jsx';

// Batch 9 (C2): a late proof or transfer code is shown only for the computer it was asked for. Changing the
// selection, or cancelling the transfer, while a reply is in flight drops that reply.
beforeEach(() => { resetPage('#/circle/c1'); installClock(); });
afterEach(teardown);

const members = [
  {key_id: 'self-key', person_id: 'self-key', device_name: 'Tessa’s MacBook'},
  {key_id: 'ana-key', person_id: 'ana-key', device_name: 'Ana’s laptop'},
  {key_id: 'lee-key', person_id: 'lee-key', device_name: 'Lee’s desktop'},
];
const circle = {id: 'c1', name: 'Weekend', owned: true, authorityStewardKeyId: ''};
function recorder() {
  const calls = [];
  const mutate = (path, body) => new Promise((resolve, reject) => calls.push({path, body, resolve, reject}));
  return {calls, mutate};
}
const choose = async (select, value) => {
  await act(() => { select.value = value; select.dispatchEvent(new window.Event('change', {bubbles: true})); });
  await flush();
};
const button = (view, label) => view.$$('button').find(b => b.textContent.includes(label));
const press = async (view, label) => { await act(() => { button(view, label).click(); }); await flush(); };

test('a link proof is shown only for the computer it was asked for; changing the computer drops the late reply', async () => {
  const {calls, mutate} = recorder();
  const view = await mount(h(ComputerLink, {circle, members, selfKey: 'self-key', mutate}));
  await choose(view.$$('select')[1], 'ana-key');
  await press(view, 'Create this computer');
  assert.equal(calls[0].body.otherKeyId, 'ana-key');
  await choose(view.$$('select')[1], 'lee-key');
  await act(() => { calls[0].resolve({proof: 'ANA-PROOF'}); });
  await flush();
  assert.equal(view.$$('textarea').some(t => t.value.includes('ANA-PROOF')), false, 'Ana’s proof is not shown next to Lee’s computer');

  await press(view, 'Create this computer');
  assert.equal(calls[1].body.otherKeyId, 'lee-key');
  await act(() => { calls[1].resolve({proof: 'LEE-PROOF'}); });
  await flush();
  assert.equal(view.$$('textarea').some(t => t.value.includes('LEE-PROOF')), true, 'the proof for the selected computer is shown');
  await view.unmount();
});

test('a transfer code is not shown after its computer changed or its transfer was cancelled', async () => {
  const {calls, mutate} = recorder();
  const view = await mount(h(CircleAuthority, {circle, members, selfKey: 'self-key', mutate, setDialog() {}}));
  await choose(view.$$('select')[1], 'ana-key');
  await press(view, 'Create transfer code');
  assert.equal(calls[0].path, 'circles/c1/ownership/propose');
  await choose(view.$$('select')[1], 'lee-key');
  await act(() => { calls[0].resolve({proposal: {code: 'ANA-CODE'}}); });
  await flush();
  assert.equal(view.$$('textarea').some(t => t.value.includes('ANA-CODE')), false, 'the code for Ana is not shown for Lee');

  await choose(view.$$('select')[1], 'ana-key');
  await press(view, 'Create transfer code');
  await press(view, 'Cancel outstanding transfer codes');
  await act(() => { calls[2].resolve({}); });
  await act(() => { calls[1].resolve({proposal: {code: 'LATE-CODE'}}); });
  await flush();
  assert.equal(view.$$('textarea').some(t => t.value.includes('LATE-CODE')), false, 'a reply that lands after the cancel is dropped');
  await view.unmount();
});
