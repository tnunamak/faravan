import {click, mount, resetPage, teardown} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {ProfileMigrationNotice} from './profile-migration.jsx';
const notice = {message:'Circles from the earlier preview must be created or joined again. Your accounts and settings were kept.', archive:'/fixture/Faravan/earlier-preview-2026-11-26'};
beforeEach(() => resetPage('#/home'));
afterEach(() => teardown());
test('shows the migration line and archive path until dismissal is saved', async () => {
  const calls = [];
  const page = await mount(h(ProfileMigrationNotice, {notice, api:{post:async (path, body) => { calls.push({path, body}); }}}));
  assert.ok(page.text().includes(notice.message));
  assert.ok(page.text().includes(notice.archive));
  assert.equal(page.$('details').open, false);
  await click(page.$('button'));
  assert.deepEqual(calls, [{path:'profile-migration', body:{}}]);
  assert.equal(page.$('aside'), null);
});
test('a refused dismissal keeps the notice visible and offers retry', async () => {
  const page = await mount(h(ProfileMigrationNotice, {notice, api:{post:async () => { throw new Error('fixture refusal'); }}}));
  await click(page.$('button'));
  assert.ok(page.$('aside'));
  assert.equal(page.$('[role=alert]').textContent, 'Could not save your dismissal. Try again.');
  assert.equal(page.$('button').disabled, false);
});
