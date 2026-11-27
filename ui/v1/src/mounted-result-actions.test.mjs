import './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {click, mount, resetPage, teardown} from './mounted.test-helper.mjs';
import {ResultActions} from './result-actions.jsx';

const APPLIED = {repo:'/r', branch:'result', commit:'a'.repeat(40)};
// Answers each post in order, so a test states the dry run and the write separately.
const fakeApi = answers => {
  const posts = [];
  return {posts, async post(path, body) {
    posts.push({path, body});
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next;
  }};
};
const refusal = code => Object.assign(new Error(code), {applyRefusal:{code, state:''}});

beforeEach(() => { resetPage('#/jobs'); });
afterEach(teardown);

test('a removal the server reports as removed or gone is confirmed, not left uncertain', async () => {
  for (const status of ['removed', 'gone']) {
    let changed = 0;
    const api = fakeApi([{status:'removable', ...APPLIED}, {status, ...APPLIED}]);
    const view = await mount(h(ResultActions, {api, jobId:'job-1', circle:'c', applied:APPLIED, onChanged:() => { changed++; }}));
    await click(view.button('Remove this branch…'));
    await click(view.button('Remove result'));
    assert.match(view.text(), status === 'gone' ? /result was already removed\./ : /Removed result\./, status);
    assert.doesNotMatch(view.text(), /not confirmed/, status);
    assert.equal(changed, 1, status);
    await teardown();
  }
});

test('a removal answer for another branch stays unconfirmed', async () => {
  const api = fakeApi([{status:'removable', ...APPLIED}, {status:'removed', ...APPLIED, branch:'other'}]);
  const view = await mount(h(ResultActions, {api, jobId:'job-1', circle:'c', applied:APPLIED}));
  await click(view.button('Remove this branch…'));
  await click(view.button('Remove result'));
  assert.match(view.text(), /The outcome is not confirmed/);
  assert.doesNotMatch(view.text(), /Removed result\./);
});

test('a coded server refusal of a removal shows its reason and unlocks the controls', async () => {
  const api = fakeApi([{status:'removable', ...APPLIED}, refusal('branch_moved')]);
  const view = await mount(h(ResultActions, {api, jobId:'job-1', circle:'c', applied:APPLIED}));
  await click(view.button('Remove this branch…'));
  await click(view.button('Remove result'));
  assert.doesNotMatch(view.text(), /not confirmed/);
  assert.ok(view.$('.banner.bad'));
  assert.equal(view.button('Remove this branch…').disabled, false);
});

test('a coded server refusal of an apply shows its reason instead of an unconfirmed outcome', async () => {
  const dry = {status:'dry_run', repo:'/r', head:'b'.repeat(40), current_branch:'main', base:'a'.repeat(40), per_file:true,
    working_tree:{clean:true, changed:[], more:0},
    files:[{path:'src/a.ts', old_path:null, status:'modified', insertions:3, deletions:1, binary:false, state:'applies'}]};
  const api = fakeApi([dry, refusal('patch_conflict')]);
  const view = await mount(h(ResultActions, {api, jobId:'job-1', circle:'c', sourceFolder:'/r'}));
  await click(view.$('.result-apply-form button[type=submit], .result-apply-form button'));
  await click(view.button('Apply 1 file'));
  assert.equal(api.posts.length, 2);
  assert.doesNotMatch(view.text(), /not confirmed/);
  assert.ok(view.$('.banner.bad'));
});

const dryRun = repo => ({status:'dry_run', repo, head:'b'.repeat(40), current_branch:'main', base:'a'.repeat(40), per_file:true,
  working_tree:{clean:true, changed:[], more:0},
  files:[{path:'src/a.ts', old_path:null, status:'modified', insertions:3, deletions:1, binary:false, state:'applies'}]});
const checkAndApply = async view => {
  await click(view.$('.result-apply-form button'));
  await click(view.button('Apply 1 file'));
};

test('a write_failed refusal comes after git started writing, so the outcome stays unconfirmed and locked', async () => {
  const api = fakeApi([dryRun('/r'), refusal('write_failed')]);
  const view = await mount(h(ResultActions, {api, jobId:'job-1', circle:'c', sourceFolder:'/r'}));
  await checkAndApply(view);
  assert.match(view.text(), /The outcome is not confirmed/);
  assert.ok(view.button('I checked the repository'));
});

test('the write and its receipt use the repository folder the check answered with', async () => {
  const api = fakeApi([dryRun('/r'), {status:'applied', repo:'/r', applied:['src/a.ts']}]);
  const view = await mount(h(ResultActions, {api, jobId:'job-1', circle:'c', sourceFolder:'/r/sub/'}));
  await checkAndApply(view);
  assert.equal(api.posts[1].body.repo, '/r');
  assert.match(view.text(), /Applied 1 file to \/r\./);
  assert.doesNotMatch(view.text(), /not confirmed/);
});

test('a finished removal does not carry over to another branch record with the same commit', async () => {
  const api = fakeApi([{status:'removable', ...APPLIED}, {status:'removed', ...APPLIED}]);
  const view = await mount(h(ResultActions, {api, jobId:'job-1', circle:'c', applied:APPLIED}));
  await click(view.button('Remove this branch…'));
  await click(view.button('Remove result'));
  assert.match(view.text(), /Removed result\./);
  await view.rerender(h(ResultActions, {api, jobId:'job-1', circle:'c', applied:{...APPLIED, branch:'other', repo:'/o'}}));
  assert.doesNotMatch(view.text(), /Removed/);
  assert.ok(view.button('Remove this branch…'));
});

test('an unconfirmed removal keeps its recovery button when the branch record goes away', async () => {
  const api = fakeApi([{status:'removable', ...APPLIED}, new Error('network')]);
  const view = await mount(h(ResultActions, {api, jobId:'job-1', circle:'c', applied:APPLIED}));
  await click(view.button('Remove this branch…'));
  await click(view.button('Remove result'));
  await view.rerender(h(ResultActions, {api, jobId:'job-1', circle:'c', applied:null}));
  assert.match(view.text(), /The outcome is not confirmed/);
  await click(view.button('I checked the repository'));
  assert.doesNotMatch(view.text(), /not confirmed/);
});
