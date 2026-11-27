import {advance, createFakeApi, flush, installClock, mount, resetPage, teardown} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {useState} from 'preact/hooks';
import {Job} from './jobs.jsx';

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

test('the lender sees a loading line while the request read fails briefly, then the request, never an apology', async () => {
  const id = D('d'), api = createFakeApi({[P(id)]: () => record('ran', id, 'running')});
  const view = await mount(h(Host, {api, id, role: 'ran'}));
  await api.release();
  for (const call of api.openReads(p => p.includes('/prompt'))) call.settle('err', {status: 404, code: 'not_found'});
  await flush();
  assert.doesNotMatch(view.text(), /couldn’t be loaded/);
  await advance(6000);
  assert.ok(api.count(p => p.includes('/prompt')) >= 2, 'the request is read again');
  await api.answer(p => p.includes('/prompt'), {text: 'Late prompt'}).catch(() => {});
  await api.release();
  assert.match(view.text(), /Late prompt/);
});

test('a request that keeps failing is reported after the retry window, not swallowed forever', async () => {
  const id = D('h'), api = createFakeApi({[P(id)]: () => record('ran', id, 'running')});
  const view = await mount(h(Host, {api, id, role: 'ran'}));
  await api.release();
  for (let i = 0; i < 12; i++) { for (const call of api.openReads(p => p.includes('/prompt'))) call.settle('err', {status: 404, code: 'not_found'}); await advance(3000); }
  assert.match(view.text(), /The request couldn’t be loaded/);
});

test('the retry window starts when the page knows it ran the job, not when it opened', async () => {
  const id = D('p'), api = createFakeApi({[P(id)]: () => record('ran', id, 'running')});
  const view = await mount(h(Host, {api, id, role: 'ran'}));
  await advance(21000);                     // the job detail read is slow; the page does not yet know it ran the job
  await api.release(p => p === P(id) + '?circle=c1');
  for (const call of api.openReads(p => p.includes('/prompt'))) call.settle('err', {status: 404, code: 'not_found'});
  await flush();
  assert.doesNotMatch(view.text(), /couldn’t be loaded/);
  await advance(3500);
  assert.ok(api.count(p => p.includes('/prompt')) >= 2, 'the request is read again');
});

const lenderView = (api, id, devices) => h(Job, {key: id + ':c1', id, requestedCircle: 'c1', api, circle: 'c1', circles: [circle], revision: 0,
  mutate: async () => ({}), setDialog: d => dialogs.push(d), members: [], headingRef: {current: null}, refresh: async () => {},
  draft: {submission: null}, data: {jobs: [], approvals: [], ...(devices ? {devices} : {})}});

test('before this computer’s fingerprint is read, the lender’s job page shows a loading line, not an apology', async () => {
  const id = D('q'), api = createFakeApi({[P(id)]: () => record('ran', id, 'running')});
  const view = await mount(lenderView(api, id, null));
  await api.release(); await flush();
  assert.doesNotMatch(view.text(), /couldn’t be loaded/);
});

test('before the job’s holder is read, the page shows a loading line, then a viewer’s apology only after the window', async () => {
  const id = D('r'), {current_attempt: _, ...noHolder} = record('ran', id, 'running');
  const api = createFakeApi({[P(id)]: () => noHolder});
  const view = await mount(lenderView(api, id, {fingerprint: 'fp-1', name: 'MacBook', circles: []}));
  await api.release(); await flush();
  assert.doesNotMatch(view.text(), /couldn’t be loaded/);
  await advance(21000);
  assert.match(view.text(), /The request couldn’t be loaded/);
});
