import {mount, resetPage, teardown, click, flush} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {Sheet} from './ds/index.mjs';
import {ApplySheet} from './apply-sheet.jsx';

// Batch 9 (C1): a sheet asks before it closes. Escape and a backdrop click go through onClose; a veto (false) keeps
// the dialog open and its focus in place. "Add as a branch" vetoes while its write is pending or unconfirmed.
beforeEach(() => resetPage('#/job/x'));
afterEach(teardown);

const dialog = () => document.querySelector('dialog');
const escape = () => dialog().dispatchEvent(new Event('cancel', {cancelable: true}));
const backdrop = () => dialog().click();

test('a sheet whose onClose answers false stays open on Escape and on a backdrop click', async () => {
  let asked = 0;
  const view = await mount(h(Sheet, {open: true, label: 'Guarded', onClose: () => { asked++; return false; }}, h('p', null, 'Still here')));
  escape();
  backdrop();
  await flush();
  assert.equal(asked, 2, 'each Escape and backdrop click asks first');
  assert.equal(dialog().open, true, 'a vetoed close leaves the dialog open');
  assert.match(view.text(), /Still here/);
  await view.unmount();
});

test('a sheet that is not vetoed still closes once on Escape and on a backdrop click', async () => {
  let asked = 0;
  const view = await mount(h(Sheet, {open: true, label: 'Plain', onClose: () => { asked++; }}, h('p', null, 'Body')));
  escape();
  await flush();
  assert.equal(asked, 1);
  assert.equal(dialog().open, false, 'the dialog closes when onClose does not veto');
  await view.unmount();
});

const digest = 'sha256:' + '3f'.repeat(32), repo = '/home/ana/code/booking-site';
const preview = {job_digest: digest, status: 'preview', branch: 'job/3f3f3f3f3f3f', base: 'a'.repeat(40), repo, head: 'b'.repeat(40),
  current_branch: 'main', preview_token: 'signed-preview', patch_hash: 'd'.repeat(64), files: 1, files_changed: [{path: 'src/form.tsx', insertions: 3, deletions: 1}]};
function fakeApi() {
  const writes = [];
  return {writes, post(path, body) {
    if (body.dry_run) return Promise.resolve(preview);
    return new Promise((resolve, reject) => writes.push({body, resolve, reject}));
  }};
}
const sheet = (api, over = {}) => h(ApplySheet, {open: true, api, jobId: digest, circle: 'weekend', lender: 'Ana', sourceFolder: repo, sourceBranch: '', onClose() {}, onApplied() {}, ...over});
const text = () => document.body.textContent.replace(/\s+/g, ' ');

test('Add as a branch cannot be closed by Escape or a backdrop click while its write is pending, and says why', async () => {
  const api = fakeApi();
  const view = await mount(sheet(api));
  await click([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add the branch'));
  assert.equal(api.writes.length, 1, 'the write is sent');
  escape();
  backdrop();
  await flush();
  assert.equal(dialog().open, true, 'the sheet stays open while the write has no result');
  assert.match(text(), /cannot be cancelled\. Wait for its result before closing\./);
  assert.equal(api.writes.length, 1, 'a close that is vetoed does not send anything');
  api.writes[0].reject(new Error('network'));
  await flush();
  assert.match(text(), /Could not confirm whether/);
  escape();
  await flush();
  assert.equal(dialog().open, true, 'an unconfirmed write also keeps the sheet open');
  assert.match(text(), /This sheet stays open until the write is checked\./);
  await view.unmount();
});

test('Add as a branch closes on Escape before any write is sent', async () => {
  const api = fakeApi();
  let closed = 0;
  const view = await mount(sheet(api, {onClose: () => { closed++; }}));
  escape();
  await flush();
  assert.equal(closed, 1);
  assert.equal(dialog().open, false);
  assert.equal(api.writes.length, 0);
  await view.unmount();
});
