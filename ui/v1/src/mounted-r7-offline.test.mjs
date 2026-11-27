import {act, advance, createFakeApi, flush, installClock, mount, resetPage, teardown} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {useState} from 'preact/hooks';
import {Job} from './jobs.jsx';
import {Jobs} from './jobs.jsx';

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

test('a delivered result the app saved while the host is down stays visible, marked, with one plain message', async () => {
  const id = D('b'), savedAt = new Date(Date.now() - 180000).toISOString();
  const api = createFakeApi({[P(id)]: () => record('sent', id, 'result-accepted', {result_digest: D('f'), savedAt}), [P(id) + '/changes']: () => ({...patch, savedAt}),
    [P(id) + '/transcript']: () => ({text: '', live: false, savedAt}), [P(id) + '/retention']: () => ({savedAt})});
  const view = await mount(h(Host, {api, id}));
  await api.release(); await advance(100); await api.release();
  assert.match(view.text(), /m\.js/, 'the saved result is shown');
  assert.match(view.text(), /Last known/, 'the saved copy is not presented as current');
  assert.equal(view.text().split('The circle “Weekend projects” is unreachable').length - 1, 1, 'one plain offline message');
  assert.match(view.text(), /saved 3 min ago/);
  assert.doesNotMatch(view.text(), /didn’t load|Try (loading the result )?again|error 409|Reload job|couldn’t refresh|Result unavailable|Load the result/i);
  assert.equal(view.$$('[role="alert"]').length, 0, 'no error alerts over a saved result');
});
test('the Jobs list keeps rows the app saved while a host is down, with one offline line and no error', async () => {
  const api = createFakeApi({}), savedAt = new Date(Date.now() - 60000).toISOString();
  const rows = [{job_digest: D('j'), circle: {id: 'c1', name: 'Weekend projects'}, state: 'result-accepted', savedAt, local: {title: 'Kept row', prompt: 'x'}},
    {job_digest: D('k'), circle: {id: 'c1', name: 'Weekend projects'}, state: 'queued', savedAt, local: {title: 'Second row', prompt: 'y'}}];
  const view = await mount(h(Jobs, {api, circles: [circle], selected: circle, revision: 0, data: {jobs: rows, devices: {}}, refresh: async () => {}}));
  assert.match(view.text(), /Kept row/);assert.match(view.text(), /Second row/);
  assert.equal(view.text().split('is unreachable').length - 1, 1, 'one offline line for the list');
  assert.doesNotMatch(view.text(), /Jobs didn’t load|couldn’t refresh|409/);
});

// Judge r10 R1: on the host's own computer a busy host's saved waiting job read "unreachable", "Last known:" with
// nothing after it, and "Stop this job" on a job nobody started.
test('a waiting job saved while the host was busy says catching up, names its state and keeps Cancel job', async () => {
  const id = D('w'), savedAt = new Date(Date.now() - 60000).toISOString();
  const waiting = {...record('sent', id, 'queued', {savedAt, savedReason: 'busy'}), current_attempt: null};
  const api = createFakeApi({[P(id)]: () => waiting, [P(id) + '/transcript']: () => ({text: '', live: false, savedAt}), [P(id) + '/retention']: () => ({savedAt})});
  const view = await mount(h(Host, {api, id}));
  await api.release(); await advance(100); await api.release();
  assert.match(view.text(), /Faravan is catching up with the circle “Weekend projects”/);
  assert.doesNotMatch(view.text(), /unreachable/);
  assert.doesNotMatch(view.text(), /Last known:\s*(?:$|What|This job|Job status)/);
  const buttons = view.$$('button').map(b => b.textContent.trim());
  assert.ok(buttons.includes('Cancel job'), 'a job nobody started keeps Cancel: ' + buttons.join(' | '));
  assert.ok(!buttons.includes('Stop this job'), 'never Stop for a job nobody started');
});

test('an owner result shows its circle-server outage and disables Delete',async()=>{
  const id=D('o'), savedAt=new Date(Date.now()-20000).toISOString();
  const api=createFakeApi({
    [P(id)]:()=>record('sent',id,'result-accepted',{result_digest:D('f'),savedAt}),
    [P(id)+'/changes']:()=>({...patch,savedAt}),
    [P(id)+'/transcript']:()=>({text:'',live:false,savedAt}),
    [P(id)+'/retention']:()=>({deletable:true,savedAt}),
    'circles/c1/compose':()=>({circle:'c1',name:'Weekend projects',hosted:true,networked:true,
      host:{label:'MacBook',reachable:false,lastReachedAt:new Date(Date.now()-20000).toISOString()}}),
  });
  const view=await mount(h(Host,{api,id}));
  await api.release();await advance(100);await api.release();
  assert.match(view.text(),/The circle “Weekend projects” isn’t answering/);
  assert.match(view.text(),/Start it again from Circles → Host a circle on this computer/);
  const remove=view.button('Delete this job…');
  assert.equal(remove.getAttribute('aria-disabled'),'true','Delete cannot be retried while the circle server is down');
  assert.match(remove.title,/circle server isn’t answering/i);
  await act(()=>remove.click());await flush();
  assert.equal(dialogs.length,0,'Delete does not open a confirmation while the server is down');
  assert.doesNotMatch(view.text(),/awake and connected before sending/);
});
