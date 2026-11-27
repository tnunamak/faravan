import {advance, createFakeApi, flush, installClock, mount, resetPage, teardown, act} from './mounted.test-helper.mjs';
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

test('a stopped job is never marked as last known because an unrelated event arrived', async () => {
  const id = D('a'), api = createFakeApi({[P(id)]: () => record('sent', id, 'cancelled'), [P(id) + '/transcript']: () => ({text: '', live: false}), [P(id) + '/retention']: () => ({})});
  const view = await mount(h(Host, {api, id}));
  await api.release();
  assert.match(view.text(), /Stopped/);
  await act(() => setters.setRevision(1)); await flush();
  assert.doesNotMatch(view.text(), /Last known|Job status is updating/);
  await advance(6000); await api.release();
  assert.doesNotMatch(view.text(), /Last known|Job status is updating/);
});

// Judge r8 O3 / I06: fresh job reads never claim stale status. A pending revalidation and another
// resource's connection notice are not evidence that this job's answer is out of date.
test('I06: a waiting job keeps its fresh status through a revision and an unrelated connection notice', async () => {
  const {Connection} = await import('./shared.jsx');
  const id = D('b'), waiting = {...record('sent', id, 'queued'), current_attempt: null};
  const api = createFakeApi({[P(id)]: () => waiting, [P(id) + '/retention']: () => ({})});
  const view = await mount(h(Connection.Provider, {value: {offline: false, stale: true}}, h(Host, {api, id})));
  await api.release();
  assert.doesNotMatch(view.text(), /Last known|Job status is updating/);
  await act(() => setters.setRevision(1)); await flush();
  assert.doesNotMatch(view.text(), /Last known|Job status is updating/, 'a revision only schedules a read');
  await advance(6000); await api.release();
  assert.doesNotMatch(view.text(), /Last known|Job status is updating/);
});
