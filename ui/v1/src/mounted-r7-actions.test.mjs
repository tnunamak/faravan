import {advance, createFakeApi, flush, installClock, mount, resetPage, teardown, act, window} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {useState} from 'preact/hooks';
import {Job} from './jobs.jsx';
import {Jobs} from './jobs.jsx';
import {ApplySheet} from './apply-sheet.jsx';
import {isJobDeleted, markJobDeleted} from './job-local-outcome.mjs';

beforeEach(() => { resetPage('#/job/x'); installClock(); });
afterEach(teardown);

const D = n => 'sha256:' + String(n).repeat(64);
const circle = {id: 'c1', name: 'Weekend projects', origin: 'http://x', owned: true};
const enc = encodeURIComponent, P = id => 'jobs/' + enc(id);
const record = (role, id, state, extra = {}) => ({job_digest: id, circle: {id: 'c1'}, state, status: state,
  current_attempt: {holder: role === 'ran' ? 'fp-1' : 'fp-2', attempt_id: 'a1', compute_stopped: true, execution_started_at: new Date(Date.now() - 60000).toISOString()},
  ...(role === 'sent' ? {local: {title: 'Fix it', prompt: 'Fix it', agent: 'claude-code-subscription', submittedAt: new Date(Date.now() - 120000).toISOString()}} : {}), ...extra});
const patch = {format: 'diff', diff: 'diff --git a/m.js b/m.js\n--- a/m.js\n+++ b/m.js\n@@ -1 +1 @@\n-a\n+b\n', files: [{path: 'm.js', insertions: 1, deletions: 1}], diffstat: {files: 1, insertions: 1, deletions: 1}};

let setters, dialogs;
function Host({api, id, role = 'sent', approvals = [], refresh = async () => {}}) {
  const [revision, setRevision] = useState(0);
  setters = {setRevision};
  return h(Job, {key: id + ':c1', id, requestedCircle: 'c1', api, circle: 'c1', circles: [circle], revision, mutate: async () => ({}),
    setDialog: d => dialogs.push(d), members: [], headingRef: {current: null}, refresh, draft: {submission: null},
    data: {jobs: [], approvals, devices: {fingerprint: 'fp-1', name: 'MacBook', circles: []}}});
}
beforeEach(() => { dialogs = []; });

test('Delete leaves the page at once, without waiting for the list to refresh', async () => {
  const id = D('e'), tbl = {[P(id)]: () => record('sent', id, 'result-accepted', {result_digest: D('f')}), [P(id) + '/changes']: () => patch,
    [P(id) + '/transcript']: () => ({text: '', live: false}), [P(id) + '/retention']: () => ({deletable: true})};
  const api = createFakeApi(tbl);
  const view = await mount(h(Host, {api, id, refresh: () => new Promise(() => {})}));
  await api.release(); await advance(100); await api.release();
  await act(() => view.button('Delete this job…').click()); await flush();
  const dialog = dialogs.at(-1);
  await act(() => { dialog.onConfirm(); }); await flush();
  assert.equal(location.hash, '#/jobs');
  assert.equal(isJobDeleted(api, id), true, 'the confirmed delete hides the cached row');
  assert.equal(sessionStorage.getItem('faravan-job-deleted'), 'Job deleted');
});

test('a job the person just deleted is not listed while the list catches up', async () => {
  const id = D('g'), api = createFakeApi({});
  markJobDeleted(api, id);
  const data = {jobs: [{job_digest: id, circle: {id: 'c1'}, state: 'result-accepted', local: {title: 'Gone job', prompt: 'x'}}], devices: {}};
  const view = await mount(h(Jobs, {api, circles: [circle], selected: circle, revision: 0, data, refresh: async () => {}}));
  assert.doesNotMatch(view.text(), /Gone job/);
});

test('a pending repository check never becomes the branch write control', async () => {
  let respond;
  const posts = [];
  const api = {post: async (_path, body) => {
    posts.push(body);
    if (!body.dry_run) return {status:'applied'};
    return new Promise(resolve => {respond=resolve;});
  }};
  const view = await mount(h(ApplySheet,{open:true,jobId:D('e'),circle:'c1',api,sourceFolder:'/work/site'}));
  const check = view.button('Check the repository');
  assert.ok(check);
  assert.equal(check.getAttribute('aria-disabled'),'true');
  await act(() => respond({status:'dry_run',repo:'/work/site',branch:'faravan/fix',files_changed:[{path:'m.js'}]}));
  await flush();
  const add = view.button('Add the branch');
  assert.ok(add);
  assert.notEqual(check,add,'a pointer press on the old button cannot confirm the new action');
  assert.equal(check.isConnected,false);
  await act(() => check.click());
  assert.deepEqual(posts.map(body=>body.dry_run),[true]);
});
test('Add the branch confirms from the apply response at once, while the refresh is still pending', async () => {
  const id = D('e'), api = createFakeApi({[P(id)]: () => record('sent', id, 'result-accepted', {result_digest: D('f'), local: {title: 'Fix it', prompt: 'Fix it', sourceFolder: '/work/site', sourceBranch: 'main', submittedAt: new Date(Date.now() - 120000).toISOString()}}),
    [P(id) + '/changes']: () => patch, [P(id) + '/transcript']: () => ({text: '', live: false}), [P(id) + '/retention']: () => ({})});
  api.post = async (path, body) => body.dry_run ? {status: 'preview', branch: 'faravan/fix-it', repo: '/work/site', head: 'h1', current_branch: 'main', files: 1, job_digest: id, base: 'a'.repeat(40), patch_hash: 'd'.repeat(64)}
    : {status: 'applied', branch: 'faravan/fix-it', repo: '/work/site', commit: 'c'.repeat(40), job_digest: id, base: 'a'.repeat(40), patch_hash: 'd'.repeat(64)};
  const view = await mount(h(Host, {api, id, refresh: () => new Promise(() => {})}));
  await api.release(); await advance(100); await api.release();
  const find = label => [...document.querySelectorAll('button')].find(el => el.textContent.trim() === label);
  await act(() => find('Add as a branch…').click()); await flush(); await flush();
  if (find('Check the repository')) { const input = document.querySelector('.apply-body input'); await act(() => { input.value = '/work/site'; input.dispatchEvent(new window.Event('input', {bubbles: true})); }); await act(() => find('Check the repository').click()); await flush(); await flush(); }
  await act(() => find('Add the branch').click()); await flush(); await flush();
  assert.match(view.text(), /Added as branch faravan\/fix-it/, 'the branch is shown as added without waiting for a re-read');
  assert.match(view.text(), /The branch is on your computer, in site\./);
  assert.doesNotMatch(view.text(), /Last known/);
  assert.equal(find('Add as a branch…'), undefined, 'the add action is gone');
});
