import {act, click, createFakeApi, flush, mount, teardown} from './mounted.test-helper.mjs';
import {h} from 'preact';
import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {Circle} from './circles.jsx';

// Batch 9 (P2-8): leaving a circle with unsaved Circle name / Purpose changes asks first, from every link out of the
// page, not only from the tabs. Discard finishes the navigation the person asked for.
const circle = {id: 'circle-a', name: 'Friends', owned: true, origin: 'http://10.23.1.2:8787'};
const data = {circles: [circle], devices: {name: 'My laptop', fingerprint: 'self', circles: []}};
const props = {circles: [circle], data, api: createFakeApi(), mutate() {}, refresh() {}, id: circle.id};
const purposeInput = view => {
  const label = Array.from(view.container.querySelectorAll('label')).find(label => label.textContent.trim() === 'Purpose');
  return label && view.container.ownerDocument.getElementById(label.htmlFor);
};
async function editPurpose(view, value) {
  await act(() => { const input = purposeInput(view); input.value = value; input.dispatchEvent(new Event('input', {bubbles: true})); });
  await flush();
}
afterEach(teardown);

test('the back link asks before leaving unsaved circle details, and Discard then goes there', async () => {
  location.hash = '#/circle/circle-a';
  const view = await mount(h(Circle, props));
  await click(view.button('Settings'));
  await editPurpose(view, 'Unsaved purpose');
  await click(view.button('Circles'));
  assert.ok(view.$('[role="alertdialog"]'), 'the draft prompt opens');
  assert.notEqual(location.hash, '#/circles', 'the link did not navigate yet');
  await click(view.button('Discard changes'));
  assert.equal(location.hash, '#/circles', 'Discard completes the navigation');
});

test('Send a job asks before leaving unsaved circle details; Stay keeps the draft', async () => {
  location.hash = '#/circle/circle-a';
  const view = await mount(h(Circle, props));
  await click(view.button('Settings'));
  await editPurpose(view, 'Unsaved purpose');
  await click(view.button('Send a job'));
  assert.ok(view.$('[role="alertdialog"]'), 'the draft prompt opens');
  assert.notEqual(location.hash, '#/new', 'the link did not navigate yet');
  await click(view.button('Stay in Settings'));
  assert.equal(purposeInput(view).value, 'Unsaved purpose');
  assert.notEqual(location.hash, '#/new');
});
