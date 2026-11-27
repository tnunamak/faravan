import {advance, click, forceClick, createFakeApi, flush, flushRendersWithoutEffects, installClock, mount, resetPage, teardown, act} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {Fragment, h} from 'preact';
import {useState} from 'preact/hooks';
import {Job, Jobs, JobsList} from './jobs.jsx';
import {loadJobReceipt} from './job-receipts.mjs';
import {ResultCard} from './home.jsx';
import {jobsListVM} from './view-models.mjs';
import {Connection, Confirm} from './shared.jsx';
import {createJobOperations} from '../../../lib/v1/cli.mjs';

beforeEach(() => { resetPage('#/job/x'); installClock(); });
afterEach(teardown);

const DIGEST = n => 'sha256:' + String(n).repeat(64);
const circle = {id: 'c1', name: 'Weekend projects', origin: 'http://x', owned: true};
const patch = {format: 'diff', diff: 'diff --git a/math.js b/math.js\nindex 123..456 100644\n--- a/math.js\n+++ b/math.js\n@@ -3,2 +3,2 @@\n export function add(a, b) {\n- return a - b;\n+ return a + b;\n', files: [{path: 'math.js', insertions: 1, deletions: 1}], diffstat: {files: 1, insertions: 1, deletions: 1}};
const say = text => JSON.stringify({type: 'assistant', message: {role: 'assistant', content: [{type: 'text', text}]}});
const lines = (...texts) => texts.map(say).join('\n');

let setters, pendingDialog;
// The same wiring main.jsx gives the page: one key per job and circle, the app-wide revision as a prop.
function Host({api, role, initialId, keyed=true, refreshOnAction=false, routeCircle='c1'}) {
  const [id, setId] = useState(initialId), [revision, setRevision] = useState(0);
  setters = {setId, setRevision};
  return h(Job, {key: keyed ? id + ':' + routeCircle : undefined, id, requestedCircle: routeCircle, api, circle: routeCircle, circles: routeCircle ? [circle] : [], revision, mutate: async () => ({}),
    setDialog(value) { pendingDialog=value; }, members: [], headingRef: {current: null}, refresh: async () => {if(refreshOnAction)setRevision(value=>value+1);}, draft: {submission: null},
    data: {jobs: [], devices: {fingerprint: 'fp-1', name: 'MacBook', circles: []}}});
}
function OutageHost({api,id}) {
  return h(Connection.Provider,{value:{offline:false,stale:true}},
    h(Job,{id,requestedCircle:'c1',api,circle:'c1',circles:[circle],revision:0,mutate:async()=>({}),setDialog(){},members:[],
      headingRef:{current:null},refresh:async()=>{},draft:{submission:null},data:{jobs:[],devices:{fingerprint:'fp-1',name:'MacBook',circles:[]}}}));
}
const jobRecord = (role, id, state) => ({job_digest: id, circle: {id: 'c1'}, state, status: state, result_digest: state === 'result-accepted' ? DIGEST('f') : undefined,
  current_attempt: {holder: role === 'ran' ? 'fp-1' : 'fp-2', attempt_id: 'a1', generation:1, execution_started_at: new Date(Date.now() - 60000).toISOString()},
  ...(role === 'sent' ? {local: {title: 'Fix the login loop', prompt: 'Fix it', agent: 'claude-code-subscription', submittedAt: new Date(Date.now() - 120000).toISOString()}} : {})});
const enc = encodeURIComponent;


const P = id => 'jobs/' + enc(id);
const T = id => P(id) + '/transcript?circle=c1';
const FINAL = 'FINAL OUTPUT: shipped the fix';
const finalText = (...texts) => lines(...texts) + '\n' + JSON.stringify({type: 'result', result: FINAL});

// What the daemon serves for one job. `world` is mutable so a test changes the server between reads.
function serve(id, role, world) {
  return {
    [P(id)]: () => {
      const ended = world.phase === 'ended';
      if (ended) world.finalServed = true;
      return jobRecord(role, id, ended ? 'result-accepted' : 'running');
    },
    [P(id) + '/transcript']: () => world.finalServed
      ? {text: finalText(...world.lines), live: false, at: new Date(Date.now()).toISOString()}
      : {text: lines(...world.lines), live: true, at: new Date(Date.now()).toISOString()},
    [P(id) + '/changes']: () => patch,
    [P(id) + '/prompt']: () => ({text: 'Fix it'}),
  };
}
async function projectSignedJob(id, sourceKind, result) {
  const circleRecord={id:'c1',name:'Weekend projects',origin:'http://x'};
  const signed={job_digest:id,state:'result-accepted',attempts_started:1,
    current_attempt:{job_digest:id,attempt_id:'a1',generation:1,holder:'fp-1',state:'completed',
      execution_started_at:'2026-10-21T11:59:00.000Z'},
    result_digest:DIGEST('f'),
    job:{payload:{...(sourceKind===undefined?{}:{source:{kind:sourceKind}}),...(result?{result}:{})}}};
  const device={keyId:'fp-1',selectCircle:async()=>circleRecord,
    intentStore:()=>({list:async()=>[]}),
    client:async()=>({getJob:async()=>structuredClone(signed)})};
  return createJobOperations({device,home:'/unused'}).get({digest:id,circle:circleRecord.id});
}

const ROLES = [['borrower', 'sent'], ['lender', 'ran']];

function projectedJob(id, phase, observedAt, failureCode = 'meter_unavailable') {
  const rawState = {running:'running',stopping:'stop-requested',stopped:'cancelled',failed:'failed',result_accepted:'result-accepted'}[phase];
  const stopped = phase === 'stopped';
  return {...jobRecord('sent',id,rawState),jobProjection:{schemaVersion:2,kind:'job',phase,
    reasonCode:phase==='failed'?failureCode:phase==='stopping'?'stop_unconfirmed':phase==='stopped'?'compute_stopped':null,
    result:{available:phase==='result_accepted',digest:phase==='result_accepted'?DIGEST('f'):null},application:{outcome:null,appliedBranch:null},
    evidence:{rawState,attemptPresent:true,approval:null,approvedAt:null,executionStartedAt:'2026-10-21T11:59:00.000Z',computeStopped:stopped},
    version:{jobDigest:id,attemptId:'a1',generation:1},times:{observedAt,validUntil:null,nextTransitionAt:null},actionHints:[]}};
}

test('failed lender result renders meter explanation and Send again for the sender', async () => {
  const id=DIGEST('a');
  const job=projectedJob(id,'failed','2026-10-21T12:00:00.000Z');
  job.jobProjection.evidence.failurePhase='result';
  const api=createFakeApi({[P(id)]:()=>job});
  const view=await mount(h(NewsHost,{api,id}));
  await api.answer(P(id)+'?circle=c1');
  await flush();
  assert.match(view.text(),/The lender’s computer could not send the work back/);
  assert.match(view.text(),/finished the work but could not send it back because its usage meter was unavailable/);
  assert.match(view.text(),/Nothing was added to your code/);
  assert.match(view.text(),/send it again or choose another lender/);
  assert.ok(view.button('Send again…'));
});

// Judge r12 R12-1: the page learned that the job's own news arrived (a job event named it) and its status read is still in flight.
// The page must not present the pre-start claim as current meanwhile.
let newsSetter;
function NewsHost({api, id}) {
  const [news, setNews] = useState(0), [dialog, setDialog] = useState(null);
  newsSetter = setNews;
  pendingDialog=dialog;
  return h(Fragment, null,
    h(Job, {key: id + ':c1', id, requestedCircle: 'c1', api, circle: 'c1', circles: [circle], revision: 0, jobNews: news, mutate: async () => ({}),
      setDialog, members: [], headingRef: {current: null}, refresh: async () => {}, draft: {submission: null},
      data: {jobs: [], devices: {fingerprint: 'fp-1', name: 'MacBook', circles: []}}}),
    dialog && h(Confirm, {...dialog, onClose: () => setDialog(null)}));
}
function waitingProjection(id) {
  return {job_digest: id, circle: {id: 'c1'}, state: 'queued', status: 'queued',
    local: {title: 'Fix the login loop', prompt: 'Fix it', agent: 'claude-code-subscription', submittedAt: '2026-10-21T11:58:00.000Z'},
    jobProjection: {schemaVersion: 2, kind: 'job', phase: 'waiting', reasonCode: null, result: {available: false, digest: null},
      application: {outcome: null, appliedBranch: null},
      evidence: {rawState: 'queued', attemptPresent: false, approval: null, approvedAt: null, executionStartedAt: null, computeStopped: false},
      version: {jobDigest: id}, times: {observedAt: '2026-10-21T11:59:00.000Z', validUntil: null, nextTransitionAt: null}, actionHints: []}};
}
test('Judge r12 R12-1: a status read still in flight after job news does not present Waiting as current', async () => {
  const id = DIGEST('d');
  let world = waitingProjection(id);
  const api = createFakeApi({[P(id)]: () => world});
  const view = await mount(h(NewsHost, {api, id}));
  await api.answer(P(id) + '?circle=c1');
  assert.match(view.text(), /Waiting|Nobody has started it/, 'before the news the page shows the waiting claim');
  world = projectedJob(id, 'running', '2026-10-21T12:00:00.000Z');
  await act(() => newsSetter(1));
  await flush();
  assert.equal(api.openReads(P(id) + '?circle=c1').length, 1, 'the news read is in flight');
  assert.doesNotMatch(view.text(), /Nobody has started it|Waiting for someone to run it/, 'the superseded claim is not presented as current');
  assert.match(view.text(), /Checking/, 'the page says it is checking the status');
  await api.answer(P(id) + '?circle=c1');
  await flush();
  assert.doesNotMatch(view.text(), /Checking/, 'the answer replaces the qualification');
  assert.doesNotMatch(view.text(), /Nobody has started it|Waiting for someone to run it/);
});

test('Judge r13 R13-2: cancel copy does not promise pre-start while checking, and changes for a known run', async () => {
  const id=DIGEST('e');let world=waitingProjection(id);
  const api=createFakeApi({[P(id)]:()=>world});
  pendingDialog=null;
  const view=await mount(h(NewsHost,{api,id}));
  await api.answer(P(id)+'?circle=c1');
  world=projectedJob(id,'running','2026-10-21T12:00:00.000Z');
  await act(()=>newsSetter(1));
  await flush();
  assert.equal(api.openReads(P(id)+'?circle=c1').length,1,'the execution update read is pending');
  assert.match(view.text(),/Checking…/);
  await click(view.button('Cancel job'));
  assert.match(view.$('dialog[aria-labelledby="confirm-title"]').textContent,/Cancel this job\?/);
  assert.match(view.$('dialog[aria-labelledby="confirm-title"]').textContent,/Cancel job/);
  assert.match(view.$('dialog[aria-labelledby="confirm-title"]').textContent,/Checking/i);
  assert.doesNotMatch(view.$('dialog[aria-labelledby="confirm-title"]').textContent,/Nobody has started it|It won’t run/);

  // The news read answers first. The job is then known to be running, so the dialog says that and never claims nobody started it.
  await api.answer(P(id)+'?circle=c1');
  await flush();
  assert.match(view.text(),/Working/);
  assert.doesNotMatch(view.$('dialog[aria-labelledby="confirm-title"]').textContent,/Nobody has started it|It won’t run/,'a known running job gets no no-start claim while Cancel’s read is pending');
  // Cancel’s own fresh read answers last; the dialog’s final copy follows that answer.
  await api.answer(P(id)+'?circle=c1');
  await flush();
  assert.match(view.$('dialog[aria-labelledby="confirm-title"]').textContent,/Stop this job\?/,'the open dialog title follows the recorded execution start');
  assert.match(view.$('dialog[aria-labelledby="confirm-title"]').textContent,/Stop job/);
  assert.match(view.$('dialog[aria-labelledby="confirm-title"]').textContent,/running computer to (?:stop|end)|job to stop/i,'the open dialog follows the recorded execution start');
  assert.doesNotMatch(view.$('dialog[aria-labelledby="confirm-title"]').textContent,/Nobody has started it|It won’t run/);
});

// Judge r13 R13-2: the page's last read said nobody had started it, but the executor started before any news arrived.
// Opening the decision reads the job first, so its pre-start claim waits for that answer.
test('Judge r13 R13-2: opening Cancel waits for a fresh read before claiming nobody started it', async () => {
  const id=DIGEST('g');let world=waitingProjection(id);
  const api=createFakeApi({[P(id)]:()=>world});
  pendingDialog=null;
  const view=await mount(h(NewsHost,{api,id}));
  await api.answer(P(id)+'?circle=c1');
  assert.match(view.text(),/Nobody has started it/,'the last read is the pre-start claim');
  world=projectedJob(id,'running','2026-10-21T12:00:00.000Z');
  await click(view.button('Cancel job'));
  const dialogText=()=>view.$('dialog[aria-labelledby="confirm-title"]').textContent;
  assert.equal(api.openReads(P(id)+'?circle=c1').length,1,'opening the decision reads the job first');
  assert.match(dialogText(),/Checking/i,'the dialog says it is checking while that read is pending');
  assert.doesNotMatch(dialogText(),/Nobody has started it|It won’t run/,'a pending read does not deny a start');
  await api.answer(P(id)+'?circle=c1');
  await flush();
  assert.match(dialogText(),/Stop this job\?/,'the answer changes the open dialog to the running decision');
  assert.doesNotMatch(dialogText(),/Nobody has started it|It won’t run/);
});

test('Judge r13 R13-2: a job confirmed as not started keeps its no-start claim', async () => {
  const id=DIGEST('i');
  const api=createFakeApi({[P(id)]:()=>waitingProjection(id)});
  pendingDialog=null;
  const view=await mount(h(NewsHost,{api,id}));
  await api.answer(P(id)+'?circle=c1');
  await click(view.button('Cancel job'));
  const dialogText=()=>view.$('dialog[aria-labelledby="confirm-title"]').textContent;
  assert.doesNotMatch(dialogText(),/Nobody has started it/,'the read that the decision opened is still pending');
  await api.answer(P(id)+'?circle=c1');
  await flush();
  assert.match(dialogText(),/Cancel this job\?/);
  assert.match(dialogText(),/Nobody has started it\. It won’t run\./,'a confirmed pre-start state keeps the claim');
});

// Judge r13 R13-1: a saved copy of a running job cannot show whether the lender's Stop already landed.
test('Judge r13 R13-1: a saved running copy does not offer the requester a second Stop', async () => {
  const id=DIGEST('h');let world=projectedJob(id,'running','2026-10-21T12:00:00.000Z');
  const api=createFakeApi({[P(id)]:()=>world});
  const view=await mount(h(NewsHost,{api,id}));
  await api.answer(P(id)+'?circle=c1');
  assert.ok(view.button('Stop this job'),'a fresh running job offers the requester its Stop');
  world={...world,savedAt:'2026-10-21T12:00:00.000Z'};
  await act(()=>newsSetter(1));
  await api.answer(P(id)+'?circle=c1');
  await flush();
  assert.match(view.text(),/Last known:/,'the page marks the saved running state as old');
  // Assert a boolean: a failing assert.equal makes Node inspect the whole DOM element, which runs out of memory.
  assert.ok(!view.button('Stop this job'),'a saved copy does not offer a second Stop');
});

test('a late old Confirm action cannot dismiss a replacement Job changed notice', async () => {
  const id=DIGEST('a');let attemptId='attempt-a';
  const api=createFakeApi({[P(id)]:()=>{
    const record=jobRecord('ran',id,'running');record.current_attempt.attempt_id=attemptId;record.title='Attempt '+attemptId.slice(-1).toUpperCase();return record;
  }});
  const view=await mount(h(NewsHost,{api,id}));
  await api.answer(P(id)+'?circle=c1');
  await click(view.button('Stop this job'));

  attemptId='attempt-b';
  await act(()=>newsSetter(1));
  await flush();
  const statusRead=api.openReads(P(id)+'?circle=c1')[0];
  assert.ok(statusRead,'the job news starts a status read');
  const changedJob=jobRecord('ran',id,'running');changedJob.current_attempt.attempt_id=attemptId;changedJob.title='Attempt B';
  await flushRendersWithoutEffects(()=>statusRead.settle('ok',changedJob));
  assert.equal(view.$('h1')?.textContent,'Attempt B','the B-only heading proves the status response committed');
  const originalDialog=view.$('dialog[aria-labelledby="confirm-title"]');
  assert.ok(originalDialog?.hasAttribute('open'),'the original confirmation remains mounted before passive invalidation');
  assert.match(originalDialog.textContent,/Stop this job\?/);
  assert.doesNotMatch(originalDialog.textContent,/Job changed/,'the invalidation effect has not replaced the old dialog');
  assert.ok(view.button('Stop job'),'the click still targets the original confirmation action');

  await click(view.button('Stop job'));
  assert.deepEqual(api.postsOf('lending/stop'),[],'the stale confirmation does not post for either attempt');
  const dialog=view.$('dialog[aria-labelledby="confirm-title"]');
  assert.ok(dialog?.hasAttribute('open'),'the old Action success callback leaves the replacement dialog open');
  assert.match(dialog.textContent,/Job changed/,'the person sees why the old confirmation was invalidated');
  await click(view.button('Close'));
  assert.ok(!view.$('dialog[aria-labelledby="confirm-title"]'),'the person can dismiss the notice explicitly');
});

test('a lender Stop response cannot close a Job changed notice opened while its POST was pending', async () => {
  const id=DIGEST('9');let attemptId='attempt-a',finishStop;
  const api=createFakeApi({[P(id)]:()=>{
    const record=jobRecord('ran',id,'running');record.current_attempt.attempt_id=attemptId;return record;
  }});
  const post=api.post.bind(api);
  api.post=async(path,body={})=>{
    if(path==='lending/stop'){
      api.posts.push({path,body});
      return new Promise(resolve=>{finishStop=resolve;});
    }
    return post(path,body);
  };
  const view=await mount(h(NewsHost,{api,id}));
  await api.answer(P(id)+'?circle=c1');
  await click(view.button('Stop this job'));
  await click(view.button('Stop job'));
  assert.ok(finishStop,'the lender Stop request is pending');
  assert.deepEqual(api.postsOf('lending/stop'),[
    {path:'lending/stop',body:{attemptId:'attempt-a',confirmed:true}},
  ]);

  attemptId='attempt-b';
  await act(()=>newsSetter(1));
  await flush();
  await api.answer(P(id)+'?circle=c1');
  assert.match(view.text(),/Job changed/,'the replacement notice renders before the original POST resolves');

  finishStop({accepted:true});
  await flush();
  const dialog=view.$('dialog[aria-labelledby="confirm-title"]');
  assert.ok(dialog?.hasAttribute('open'),'the old Stop response does not dismiss the replacement dialog');
  assert.match(dialog.textContent,/Job changed/);
  await click(view.button('Close'));
  assert.ok(!view.$('dialog[aria-labelledby="confirm-title"]'));
});

test('lender Stop confirmation cannot submit an attempt that changed while the same dialog was open', async () => {
  const id=DIGEST('b');let attemptId='attempt-a';
  const api=createFakeApi({[P(id)]:()=>{
    const record=jobRecord('ran',id,'running');record.current_attempt.attempt_id=attemptId;return record;
  }});
  const view=await mount(h(NewsHost,{api,id}));
  await api.answer(P(id)+'?circle=c1');
  await click(view.button('Stop this job'));
  const authorizedDialog=pendingDialog;assert.ok(authorizedDialog);

  attemptId='attempt-b';
  await act(()=>newsSetter(1));
  await flush();
  await api.answer(P(id)+'?circle=c1');
  await act(async()=>{await authorizedDialog.onConfirm();});
  assert.deepEqual(api.postsOf('lending/stop'),[],'the old confirmation cannot stop a different attempt');
  assert.match(view.$('dialog[aria-labelledby="confirm-title"]')?.textContent||'',/job changed/i,'the dialog explains why the old confirmation was invalidated');
  assert.ok(!view.button('Stop job'),'the old confirmation cannot remain actionable');
  await click(view.button('Review current job'));
  assert.ok(!view.$('dialog[aria-labelledby="confirm-title"]'),'the person must close the notice before reviewing Stop again');

  await click(view.button('Stop this job'));
  const currentDialog=pendingDialog;assert.ok(currentDialog);
  await act(async()=>{await currentDialog.onConfirm();});
  assert.deepEqual(api.postsOf('lending/stop'),[
    {path:'lending/stop',body:{attemptId:'attempt-b',confirmed:true}},
  ],'a fresh lender confirmation names the current attempt');
});

test('an invalidated lender Stop callback stays inert if its old attempt becomes current again', async () => {
  const id=DIGEST('f');let attemptId='attempt-a';
  const api=createFakeApi({[P(id)]:()=>{
    const record=jobRecord('ran',id,'running');record.current_attempt.attempt_id=attemptId;return record;
  }});
  const view=await mount(h(NewsHost,{api,id}));
  await api.answer(P(id)+'?circle=c1');
  await click(view.button('Stop this job'));
  const invalidatedDialog=pendingDialog;

  attemptId='attempt-b';
  await act(()=>newsSetter(1));
  await flush();
  await api.answer(P(id)+'?circle=c1');
  assert.match(view.text(),/Job changed/,'the original confirmation is invalidated when its target changes');

  attemptId='attempt-a';
  await act(()=>newsSetter(2));
  await flush();
  await api.answer(P(id)+'?circle=c1');
  await act(async()=>{await invalidatedDialog.onConfirm();});
  assert.deepEqual(api.postsOf('lending/stop'),[],'an invalidated callback cannot become valid again when its old target returns');
});

test('an open lender Stop cannot switch to requester cancellation when the job role changes', async () => {
  const id=DIGEST('c');let role='ran',attemptId='attempt-a',savedAt=null;
  const api=createFakeApi({
    [P(id)]:()=>{
      const record=jobRecord(role,id,'running');record.current_attempt.attempt_id=attemptId;
      if(savedAt)record.savedAt=savedAt;
      return record;
    },
    [P(id)+'/cancel']:{...projectedJob(id,'stopping','2026-10-21T12:00:01.000Z'),requested_at:'2026-10-21T12:00:01.000Z'},
  });
  const view=await mount(h(NewsHost,{api,id}));
  await api.answer(P(id)+'?circle=c1');
  await click(view.button('Stop this job'));
  const authorizedDialog=pendingDialog;assert.ok(authorizedDialog);
  assert.equal(authorizedDialog.allowOffline,true,'the lender action was initially scoped to this computer');

  // Answers each read in flight, including the fresh reads these actions start, until none is pending.
  const settle=async()=>{for(let i=0;i<4&&api.openReads(P(id)+'?circle=c1').length;i++)await api.answer(P(id)+'?circle=c1');};
  role='sent';attemptId='attempt-b';savedAt='2026-10-21T12:00:02.000Z';
  await act(()=>newsSetter(1));
  await flush();
  await api.answer(P(id)+'?circle=c1');
  await act(async()=>{await authorizedDialog.onConfirm();});
  assert.deepEqual(api.postsOf('lending/stop'),[],'the old lender action does not survive a role change');
  assert.deepEqual(api.postsOf(P(id)+'/cancel'),[],'the old confirmation does not silently switch to requester cancellation');
  assert.match(view.$('dialog[aria-labelledby="confirm-title"]')?.textContent||'',/job changed/i);

  await click(view.button('Review current job'));
  // The reopened copy is saved, so it offers the requester no Stop (judge r13 R13-1).
  assert.ok(!view.button('Stop this job'),'a saved copy offers no requester Stop');

  // A fresh read replaces the saved copy. Every read in flight answers before the Stop reopens and before it confirms.
  savedAt=null;
  await act(()=>newsSetter(2));
  await settle();
  await click(view.button('Stop this job'));
  await settle();
  const currentDialog=pendingDialog;assert.ok(currentDialog);
  assert.equal(currentDialog.allowOffline,false,'the reopened action uses requester permissions');
  await click(view.button('Stop job'));
  assert.deepEqual(api.postsOf('lending/stop'),[]);
  assert.deepEqual(api.postsOf(P(id)+'/cancel'),[
    {path:P(id)+'/cancel',body:{circle:'c1'}},
  ],'a fresh requester confirmation uses the job-scoped cancellation route');
});

test('a lender Stop confirmation is bound to the projected attempt generation',async()=>{
  const id=DIGEST('b');let generation=1;
  const api=createFakeApi({[P(id)]:()=>{const record=jobRecord('ran',id,'running');record.current_attempt.generation=generation;return record;}});
  const view=await mount(h(NewsHost,{api,id}));
  await api.answer(P(id)+'?circle=c1');
  await click(view.button('Stop this job'));
  const authorizedDialog=pendingDialog;assert.ok(authorizedDialog);
  assert.equal(authorizedDialog.title(),'Stop this job?');

  // Cancel’s own read answers first, so the news read below is the one that reports the new attempt generation.
  await api.answer(P(id)+'?circle=c1');
  generation=2;
  await act(()=>newsSetter(1));
  const statusRead=api.openReads(P(id)+'?circle=c1')[0];assert.ok(statusRead);
  const replacement=jobRecord('ran',id,'running');replacement.current_attempt.generation=generation;
  // api.answer settles the read and flushes the render and effects its answer starts, as every other answer in this file does.
  await api.answer(P(id)+'?circle=c1',replacement);
  assert.match(view.$('dialog[aria-labelledby="confirm-title"]')?.textContent||'',/Job changed/);
  await act(async()=>{await authorizedDialog.onConfirm();});
  assert.deepEqual(api.postsOf('lending/stop'),[],'the old generation is never submitted as the current run');
  assert.match(view.$('dialog[aria-labelledby="confirm-title"]')?.textContent||'',/Job changed/);
});

test('Judge r13 R13-2: a saved waiting copy does not claim the job has not started', async () => {
  const id=DIGEST('f'), saved={...waitingProjection(id),savedAt:'2026-10-21T12:00:00.000Z'};
  const api=createFakeApi({[P(id)]:()=>saved});
  const view=await mount(h(NewsHost,{api,id}));
  await api.answer(P(id)+'?circle=c1');
  assert.match(view.text(),/Last known:/,'the page marks the saved waiting state as old');
  await click(view.button('Cancel job'));
  assert.match(view.$('dialog[aria-labelledby="confirm-title"]').textContent,/Checking/i,'the dialog explains that the old status must be checked');
  assert.doesNotMatch(view.$('dialog[aria-labelledby="confirm-title"]').textContent,/Nobody has started it|It won’t run/);
});

test('Job mounted: a saved stop awaiting its home says delivery is pending', async () => {
  const id=DIGEST('a'),time='2026-10-21T12:00:01.000Z';
  const api=createFakeApi({[P(id)]:()=>projectedJob(id,'running',time),[P(id)+'/cancel']:{
    state:'pending',authority_revoked:false,compute_stopped:false,requested_at:time}});
  const view=await mount(h(Host,{api,role:'sent',initialId:id}));
  await api.release();await advance(100);await api.release();
  await click(view.button('Stop this job'));
  await act(()=>pendingDialog.onConfirm());await flush();
  assert.match(view.text(),/Stop pending delivery/);
  assert.match(view.text(),/cannot be reached/);
  assert.doesNotMatch(view.text(),/This job was cancelled before it started/);
  await api.answer(P(id)+'?circle=c1');
  assert.match(view.text(),/Stop pending delivery/,'a still-running remote job does not acknowledge the saved stop');
});

test('Job mounted: cancellation acknowledgement advances to a later stopped projection', async () => {
  const id=DIGEST('c'), time='2026-10-21T12:00:00.000Z';
  let phase='running', observedAt='2026-10-21T11:59:59.000Z';
  const api=createFakeApi({[P(id)]:()=>projectedJob(id,phase,observedAt),[P(id)+'/cancel']:{jobProjection:projectedJob(id,'stopping',time).jobProjection}});
  const view=await mount(h(Host,{api,role:'borrower',initialId:id}));
  await api.answer(P(id)+'?circle=c1');
  await act(()=>setters.setRevision(1));
  await advance(5000);
  assert.equal(api.openReads(P(id)+'?circle=c1').length,1,'a pre-cancel detail refresh is in flight');
  await click(view.button('Stop this job'));
  assert.ok(pendingDialog,'the stop action opened its confirmation');
  await act(async()=>{await pendingDialog.onConfirm();});
  await flush();
  assert.match(view.text(),/Stop requested/i,'the acknowledgement is shown while the old read remains current');

  phase='running'; observedAt='2026-10-21T11:59:59.500Z';
  await api.answer(P(id)+'?circle=c1');
  assert.match(view.text(),/Stop requested/i,'the in-flight older running read cannot overwrite the acknowledgement');
  await api.answer(P(id)+'?circle=c1',{...jobRecord('sent',id,'running'),jobProjection:{schemaVersion:2,kind:'job',phase:'result_accepted'}});
  await flush();
  assert.match(view.text(),/Stop requested/i,'an invalid successful post-ack projection cannot retire the known acknowledgement');

  await act(()=>setters.setRevision(2));
  await advance(5000);
  assert.equal(api.openReads(P(id)+'?circle=c1').length,1,'a new detail read follows the invalid response');
  phase='stopped'; observedAt='2026-10-21T12:00:02.000Z';
  await api.answer(P(id)+'?circle=c1');
  assert.match(view.text(),/Stopped/i,'the post-ack detail read advances to the confirmed server state');

  await act(()=>setters.setRevision(3));
  await advance(5000);
  assert.equal(api.openReads(P(id)+'?circle=c1').length,1,'a later ordinary revalidation is pending');
  await api.fail(P(id)+'?circle=c1',new Error('later detail read unavailable'));
  assert.match(view.text(),/Last known: Stopped/i,'a failed later read keeps the confirmed stopped projection');
  assert.doesNotMatch(view.text(),/Stop requested/i,'the consumed acknowledgement is not re-applied');
});

test('Job mounted: cancellation state does not carry to another job on an unkeyed route change', async () => {
  const a=DIGEST('d'), b=DIGEST('e'), time='2026-10-21T12:00:00.000Z';
  const api=createFakeApi({[P(a)]:()=>projectedJob(a,'running','2026-10-21T11:59:59.000Z'),
    [P(b)]:()=>projectedJob(b,'running','2026-10-21T12:00:01.000Z'),
    [P(a)+'/cancel']:{jobProjection:projectedJob(a,'stopping',time).jobProjection}});
  const view=await mount(h(Host,{api,role:'borrower',initialId:a,keyed:false}));
  await api.answer(P(a)+'?circle=c1');
  await click(view.button('Stop this job'));
  await act(async()=>{await pendingDialog.onConfirm();});
  await flush();
  assert.match(view.text(),/Stop requested/i);

  await act(()=>setters.setId(b));
  await api.answer(P(b)+'?circle=c1');
  assert.match(view.text(),/Working/i,'job B keeps its running projection and does not inherit job A cancellation');
});

test('Job mounted: confirmed apply stays added while its follow-up detail read fails', async () => {
  const id=DIGEST('f'), detail=P(id)+'?circle=c1', applyPath=P(id)+'/apply';
  const accepted={...projectedJob(id,'result_accepted','2026-10-21T12:00:00.000Z'),
    local:{title:'Fix the login loop',prompt:'Fix it',agent:'claude-code-subscription',sourcePath:'/work/project'},
    applied:undefined};
  const responses=[{repo:'/work/project',branch:'faravan/fix-login',base:'a'.repeat(40),head:'b'.repeat(40),
    current_branch:'main',files:1,files_changed:[{path:'fix.js',insertions:1,deletions:0}],job_digest:id,patch_hash:'d'.repeat(64)},
    {status:'applied',branch:'faravan/fix-login',repo:'/work/project',commit:'c'.repeat(40),job_digest:id,base:'a'.repeat(40),patch_hash:'d'.repeat(64)}];
  const table={[detail]:()=>accepted,[P(id)+'/changes']:patch,
    [P(id)+'/transcript']:{text:finalText('m1 completed'),live:false,at:'2026-10-21T12:00:01.000Z'}};
  Object.defineProperty(table,applyPath,{get:()=>responses.shift()});
  const api=createFakeApi(table);
  const view=await mount(h(Host,{api,role:'borrower',initialId:id,refreshOnAction:true}));
  await api.answer(detail);
  await api.answer(P(id)+'/changes?circle=c1');
  await api.answer(T(id));
  assert.ok(view.button('Add as a branch…'),'the accepted result offers its initial apply action');
  await click(view.button('Add as a branch…'));
  await flush();
  assert.equal(api.postsOf(applyPath).length,1,'opening the sheet checks the remembered source folder');
  await click(view.button('Add the branch'));
  assert.equal(api.postsOf(applyPath).length,2,'the confirmed apply request completed');
  await flush();
  assert.match(view.text(),/Added as a branch/,'the apply response updates the projection immediately');
  assert.ok(!view.button('Add as a branch…'),'the applied result has no duplicate primary apply action');

  await advance(5000);
  assert.equal(api.openReads(detail).length,1,'the post-apply detail refresh is pending after the read interval');
  await api.fail(detail,new Error('detail refresh unavailable'));
  assert.match(view.text(),/Added as a branch/,'a failed refresh does not erase the locally confirmed application outcome');
  assert.ok(!view.button('Add as a branch…'));
});

test('fresh job status stays current through an SSE outage and optional resource error', async () => {
  const id=DIGEST('b'), projection={schemaVersion:2,kind:'job',phase:'failed',reasonCode:'wall_timeout',
    result:{available:false,digest:null},application:{outcome:null,appliedBranch:null},
    evidence:{rawState:'failed',attemptPresent:true,approval:null,approvedAt:null,executionStartedAt:null,computeStopped:false},
    version:{jobDigest:id},times:{observedAt:new Date(Date.now()).toISOString(),validUntil:null,nextTransitionAt:null},actionHints:[]};
  const api=createFakeApi({
    [P(id)]:()=>({...jobRecord('sent',id,'failed'),jobProjection:projection}),
  });
  const view=await mount(h(OutageHost,{api,id}));
  await api.answer(P(id)+'?circle=c1');
  await api.fail(P(id)+'/retention?circle=c1',new Error('optional retention read failed'));
  assert.match(view.text(),/finish/i);
  assert.doesNotMatch(view.text(),/Last known:/i);
  assert.equal(api.count(P(id)+'/retention?circle=c1'),1,'the optional retention read failed independently');
});

test('Job mounted: a ready-state transition preserves its in-flight thread read', async () => {
  const id=DIGEST('1'), detail=P(id)+'?circle=c1', thread=P(id)+'/thread?circle=c1', continuation=P(id)+'/continuation?circle=c1';
  let phase='running';
  const api=createFakeApi({
    [detail]:()=>jobRecord('sent',id,phase==='running'?'running':'result-accepted'),
    [T(id)]:()=>({text:lines('m1 working'),live:phase==='running'}),
    [thread]:{thread:[]},
    [P(id)+'/changes']:patch,
    [P(id)+'/prompt']:{text:'Fix it'},
  });
  const view=await mount(h(Host,{api,role:'sent',initialId:id}));
  await api.answer(detail);
  await api.answer(T(id),{text:lines('m1 working'),live:true});
  assert.equal(api.openReads(thread).length,1,'the running job started its initial thread read');
  await api.answer(thread,{thread:[]});

  // Start the current-revision thread read and the next job-status read together. The
  // former remains the one held response throughout the rendered transition below.
  await act(()=>setters.setRevision(1));
  await advance(5000);
  assert.equal(api.openReads(detail).length,1,'the new job status is pending');
  const pendingThread=api.openReads(thread)[0];
  assert.ok(pendingThread,'the current-revision thread read is held');
  assert.equal(api.count(thread),2,'one completed initial read and one held current read exist');

  phase='ended';
  await api.answer(detail);
  assert.match(view.text(),/Loading result/,'the terminal status rendered the result-loading state');
  assert.equal(pendingThread.signal.aborted,false,'the status transition keeps the still-needed thread read alive');

  await api.answer(P(id)+'/changes?circle=c1',patch);
  await api.answer(T(id),{text:finalText('m1 working'),live:false,at:'2026-10-20T15:00:05.000Z'});
  assert.doesNotMatch(view.text(),/Loading result/,'the changes and final transcript complete result loading');
  assert.equal(pendingThread.signal.aborted,false,'result rendering keeps the held thread read alive');
  assert.equal(api.openReads(thread).length,1,'the same thread read stays pending through the full transition');
  assert.equal(api.count(thread),2,'moving JobThread between visual slots starts no duplicate read');
  assert.equal(api.count(continuation),1,'result rendering starts one separately owned continuation read');

  await api.answer(thread,{thread:[
    {job_digest:id,title:'Fix the login loop',submittedAt:'2026-10-20T14:59:00.000Z'},
    {job_digest:DIGEST('2'),title:'Earlier job',submittedAt:'2026-10-20T14:58:00.000Z'},
  ]});
  assert.equal(pendingThread.signal.aborted,false,'the original held response resolved without cancellation');
  assert.match(view.text(),/Earlier job/,'the handoff panel renders the original thread response');
  assert.equal(api.count(thread),2,'resolving the held response starts no duplicate thread read');
  assert.equal(api.openReads(thread).length,0,'no thread read is left open after the response resolves');
  assert.equal(api.peak(thread),1,'the job route never has overlapping thread reads');

  await act(()=>setters.setRevision(2));
  await advance(5000);
  const routeAwayThread=api.openReads(thread)[0];
  assert.ok(routeAwayThread,'the result page has a later thread read to cancel on route exit');
  await view.unmount();
  assert.equal(routeAwayThread.signal.aborted,true,'leaving the job route cancels its thread read');
});

for (const [who, role] of ROLES) {
  test(`Job mounted (${who}): the transcript grows without a job-state change, one read at a time, slow reads finish`, async () => {
    const id = DIGEST('a'), world = {phase: 'running', lines: ['m1 hello']};
    const api = createFakeApi(serve(id, role, world));
    const view = await mount(h(Host, {api, role, initialId: id}));
    await api.release();
    assert.match(view.text(), /m1 hello/);
    assert.equal(api.count(T(id)), 1);
    world.lines.push('m2 progress');
    await advance(1100);
    assert.equal(api.count(T(id)), 2, 'the poll read the transcript again; the job state never changed');
    assert.equal(api.count(P(id) + '?circle=c1'), 1, 'and the job record was not re-read');
    await api.release(T(id));
    assert.match(view.text(), /m2 progress/);
    // A slow read: the next 1.1-second live poll starts it; the clock then ticks for twelve seconds.
    world.lines.push('m3 slow');
    await advance(1100);
    const slow = api.openReads(T(id))[0];
    assert.ok(slow, 'a third read is in flight');
    const count = api.count(T(id));
    await advance(12000);
    assert.equal(api.count(T(id)), count, 'the poll does not start a second read while one is open');
    assert.ok(!slow.aborted, 'ticks and rerenders left the slow read alone');
    assert.equal(api.peak(T(id)), 1, 'never two transcript reads at once');
    await api.release(T(id));
    assert.match(view.text(), /m3 slow/, 'the slow read finished and was shown');
    world.lines.push('m4 later');
    assert.equal(api.count(T(id)), count + 1, 'a fresh live read follows the completed slow response without an extra idle delay');
    await api.release(T(id));
    assert.match(view.text(), /m4 later/);
    assert.equal(api.peak(T(id)), 1);
  });

  test(`Job mounted (${who}): switching jobs aborts the old job's reads and drops its late answers`, async () => {
    const a = DIGEST('a'), b = DIGEST('b'), world = {phase: 'running', lines: ['alpha says hi']}, worldB = {phase: 'running', lines: ['beta says hi']};
    const api = createFakeApi({...serve(a, role, world), ...serve(b, role, worldB)});
    const view = await mount(h(Host, {api, role, initialId: a}));
    await api.release();
    assert.match(view.text(), /alpha says hi/);
    world.lines.push('alpha LATE');
    await advance(5000);
    const slow = api.openReads(T(a))[0];
    assert.ok(slow, 'a slow poll read for job A is open');
    slow.ignoreAbort = true;
    await act(() => { setters.setId(b); });
    await flush();
    for (const call of api.reads.filter(call => call.path.startsWith(P(a)))) assert.ok(call.aborted || call.state !== 'open', call.path + ' was cancelled');
    assert.ok(slow.aborted);
    await api.release();
    assert.match(view.text(), /beta says hi/);
    slow.settle('ok', {text: lines('alpha says hi', 'alpha LATE'), live: true});
    await advance(10000);
    assert.doesNotMatch(view.text(), /alpha/, 'job A\'s late answer never reaches job B');
    assert.match(view.text(), /beta says hi/);
  });

  test(`Job mounted (${who}): a terminal job stops polling and the page ends on the FINAL output`, async () => {
    const id = DIGEST('a'), world = {phase: 'running', lines: ['m1 working'], finalServed: false};
    const api = createFakeApi(serve(id, role, world));
    const view = await mount(h(Host, {api, role, initialId: id}));
    await api.release();
    await advance(5000); await api.release();
    await advance(5000); await api.release();
    assert.ok(api.count(T(id)) >= 3, 'polling is alive while the job works');
    assert.doesNotMatch(view.text(), /FINAL OUTPUT/);
    // The job finishes. The shell's revision moves; the transcript read it triggers can run before the
    // job record says "finished", so it still carries the partial text. The record then arrives.
    world.phase = 'ended';
    await act(() => { setters.setRevision(1); });
    await advance(6000);
    const transcript = api.openReads(T(id))[0], record = api.openReads(P(id) + '?circle=c1')[0];
    assert.ok(transcript && record, 'both the transcript and the record were invalidated by the revision');
    transcript.settle('ok', {text: lines('m1 working'), live: true});
    await flush();
    assert.doesNotMatch(view.text(), /FINAL OUTPUT/);
    await api.answer(P(id) + '?circle=c1');
    for (let n = 0; n < 6; n++) { await advance(6000); await api.release(); }
    assert.match(view.text(), /FINAL OUTPUT: shipped the fix/, 'the last read after the end brought the final output');
    const settled = api.count(T(id)), progress = api.count(P(id) + '/progress?circle=c1');
    for (let n = 0; n < 12; n++) { await advance(10000); await api.release(); }
    assert.equal(api.count(T(id)), settled, 'a finished job is not polled');
    assert.equal(api.count(P(id) + '/progress?circle=c1'), progress);
    assert.equal(api.openReads(T(id)).length, 0);
    assert.equal(api.peak(T(id)), 1);
    assert.match(view.text(), /FINAL OUTPUT: shipped the fix/);
  });
}

test('running job and Lending use the same actual stop confirmation',async()=>{
  const {Lend,LendingCard}=await import('./lend.jsx');
  const {projectLendingState}=await import('../../../lib/v1/state-projection.mjs');
  const {lendPageVM}=await import('./view-models.mjs');
  const id=DIGEST('9'),api=createFakeApi({[P(id)]:()=>jobRecord('ran',id,'running')});
  const jobView=await mount(h(Host,{api,initialId:id}));
  await api.answer(P(id)+'?circle=c1');
  await click(jobView.button('Stop this job'));
  const fromJob=pendingDialog;assert.ok(fromJob);
  const words=d=>{
    const value=part=>typeof part==='function'?part():part;
    return {title:value(d.title),confirmLabel:value(d.confirmLabel),cancelLabel:d.cancelLabel,body:value(d.children)?.props?.children};
  };
  await jobView.unmount();
  const lending={enabled:true,circle:'c1',mode:'ask',status:'running',current:'a1',
    limits:{timeZone:'UTC',dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,quotaReserve:30}};
  const lendingProjection=projectLendingState({effective:{intent:{on:true,state:'ready'},execution:{state:'running',job:'a1'}},dailyLimitReached:false});
  let fromLend;
  const lendView=await mount(h(Lend,{api:{get:async()=>({enabled:true})},agents:[{id:'codex',installed:true,signedIn:true,useForLending:true}],lending,circles:[circle],circle:'c1',selected:circle,members:[],
    refresh(){},setCircle(){},setDialog:d=>{fromLend=d;},mutate:async()=>({}),
    data:{readiness:{ready:true,checks:[]},approvals:[],activity:[],jobs:[],home:{state:'ready',lending,lendingProjection,execution:{person:'Sam'}}}}));
  const stop=[...document.querySelectorAll('button')].find(b=>/^Stop .*job/.test(b.textContent));
  assert.ok(stop);await click(stop);assert.ok(fromLend);
  assert.deepEqual(words(fromLend),words(fromJob),'same executing-job decision on both actual mounted surfaces');
  assert.equal(fromLend.cancelLabel,'Keep going');
  await lendView.unmount();

  let fromHome;
  const agents=[{id:'codex',installed:true,signedIn:true,useForLending:true}],
    home={state:'ready',lending,lendingProjection,execution:{person:'Sam'}},
    homeVm=lendPageVM(home,{agents,readiness:{ready:true,checks:[]}});
  const homeView=await mount(h(LendingCard,{vm:homeVm,device:'This computer',circle:'c1',lending,agents,api:{},
    mutate:async()=>({}),setDialog:d=>{fromHome=d;},refresh(){}}));
  const homeStop=[...document.querySelectorAll('button')].find(b=>/^Stop .*job/.test(b.textContent));
  assert.ok(homeStop);await click(homeStop);assert.ok(fromHome);
  assert.deepEqual(words(fromHome),words(fromJob),'the Home lending card keeps the same executing-job decision');
  await homeView.unmount();
});

for(const [label,signedKind,expectedKind,expected] of [
  ['verified Git','git','git','can review the changes and add them as a branch.'],
  ['archive','archive','archive','can review the returned changes.'],
  ['future source kind','future-source','future-source','can review the returned changes.'],
  ['missing provenance',undefined,undefined,'can review the returned changes.'],
])test('lender delivery consumes createJobOperations.get sourceKind for '+label,async()=>{
  const id=DIGEST('8'),projection=await projectSignedJob(id,signedKind);
  assert.equal(projection.sourceKind,expectedKind,'the actual projection preserves the signed source kind');
  assert.equal(Object.hasOwn(projection,'job'),false,'the API projection does not expose a fabricated nested job');
  const world={phase:'ended',finalServed:true,lines:['Finished work']},table=serve(id,'ran',world);
  table[P(id)]=()=>({...jobRecord('ran',id,'result-accepted'),...projection});
  const api=createFakeApi(table),view=await mount(h(Host,{api,initialId:id}));
  await api.release();await api.release();
  assert.ok(view.text().includes(expected),view.text());
  if(expectedKind!=='git')assert.doesNotMatch(view.text(),/add them as a branch/);
  await view.unmount();
});

for(const [kind,output,phrase] of [
 ['message',{format:'message',message:{markdown:'Useful answer'},files:[]},'can read it and keep a copy.'],
 ['no changes',{format:'diff',diff:'',files:[],diffstat:{files:0,insertions:0,deletions:0}},'can read the result. No file changes were returned.'],
 ])test('lender delivery preserves '+kind+' control',async()=>{
 const id=DIGEST('7'),sourceKind=kind==='message'?'none':'git',
   projection=await projectSignedJob(id,sourceKind,kind==='message'?{kind:'message'}:undefined);
 assert.equal(projection.sourceKind,sourceKind);
 const world={phase:'ended',finalServed:true,lines:['Done']},table=serve(id,'ran',world);
 table[P(id)]=()=>({...jobRecord('ran',id,'result-accepted'),...projection});
 table[P(id)+'/changes']=output;
 const api=createFakeApi(table),view=await mount(h(Host,{api,initialId:id}));await api.release();await api.release();
 assert.ok(view.text().includes(phrase),view.text());
 assert.doesNotMatch(view.text(),/add them as a branch/);
 await view.unmount();
});

const KNOWN_PROMPT='Previously authorized unique request';
const UNAVAILABLE_PROMPT=/prompt is not available|request couldn.t be loaded|prompt couldn.t be loaded/i;
function watchPrompt(view) {
  const samples=[];
  const observer=new MutationObserver(()=>samples.push(view.text()));
  observer.observe(document.body,{subtree:true,childList:true,characterData:true});
  return {samples,stop:()=>observer.disconnect()};
}
for(const response of ['reject','empty'])test('accepted prompt survives terminal '+response+' refresh',async()=>{
  const id=DIGEST('4'),detail=P(id)+'?circle=c1',promptPath=P(id)+'/prompt?circle=c1';
  let phase='running';
  const api=createFakeApi({[P(id)]:()=>jobRecord('ran',id,phase),
    [P(id)+'/prompt']:{text:KNOWN_PROMPT},[P(id)+'/changes']:patch,
    [P(id)+'/transcript']:()=>({text:finalText('Done'),live:phase==='running'})});
  const view=await mount(h(Host,{api,initialId:id}));
  await api.release();await api.release();assert.ok(view.text().includes(KNOWN_PROMPT));
  const watched=watchPrompt(view);
  phase='result-accepted';await act(()=>setters.setRevision(1));await advance(5000);
  await api.answer(detail);
  await api.answer(P(id)+'/changes?circle=c1',patch);
  await api.answer(T(id),{text:finalText('Done'),live:false});
  assert.ok(api.openReads(promptPath).length,'status key invalidates prompt');
  assert.ok(view.text().includes(KNOWN_PROMPT),'held refresh retains request');
  if(response==='reject')await api.fail(promptPath,new Error('prompt refresh failed'));
  else await api.answer(promptPath,{text:''});
  await advance(21000);
  assert.ok(view.text().includes(KNOWN_PROMPT),'known request survives refresh outcome');
  watched.stop();
  for(const text of watched.samples)assert.doesNotMatch(text,UNAVAILABLE_PROMPT);
});
test('accepted prompt survives actual holder role drop and restoration without pinning Stop',async()=>{
  const id=DIGEST('5'),detail=P(id)+'?circle=c1',promptPath=P(id)+'/prompt?circle=c1';
  let holder='fp-1';
  const api=createFakeApi({[P(id)]:()=>{const r=jobRecord('ran',id,'running');r.current_attempt.holder=holder;return r;},
    [P(id)+'/prompt']:{text:KNOWN_PROMPT},[P(id)+'/transcript']:{text:lines('Working'),live:true}});
  const view=await mount(h(Host,{api,initialId:id}));await api.release();await api.release();
  assert.ok(view.text().includes(KNOWN_PROMPT));assert.ok(view.button('Stop this job'));
  const watched=watchPrompt(view);
  holder='fp-2';await act(()=>setters.setRevision(1));await advance(5000);
  const read=api.openReads(detail)[0];assert.ok(read);
  read.settle('ok',jobRecord('other',id,'running'));
  await flushRendersWithoutEffects();
  assert.ok(view.text().includes(KNOWN_PROMPT),'render before effects retains authorized content');
  await flush();
  assert.ok(view.text().includes(KNOWN_PROMPT),'null prompt path retains same-job content');
  assert.ok(!view.button('Stop this job'),'content retention must not pin execution authority');
  holder='fp-1';await act(()=>setters.setRevision(2));await advance(5000);await api.answer(detail);
  assert.ok(api.openReads(promptPath).length,'restored role reads again');
  assert.ok(view.text().includes(KNOWN_PROMPT),'restored role with held read keeps content');
  watched.stop();for(const text of watched.samples)assert.doesNotMatch(text,UNAVAILABLE_PROMPT);
});
let promptRoute;
function PromptIdentityHost({api,initialId}) {
  const [route,setRoute]=useState({id:initialId,circle:'c1'});promptRoute=setRoute;
  return h(Job,{id:route.id,requestedCircle:route.circle,api,circle:route.circle,circles:[circle,{...circle,id:'c2'}],
    revision:0,mutate:async()=>({}),setDialog(){},members:[],headingRef:{current:null},refresh:async()=>{},
    draft:{submission:null},data:{jobs:[],devices:{fingerprint:'fp-1',name:'MacBook',circles:[]}}});
}
for(const target of ['job','circle'])test('accepted prompt never crosses unkeyed '+target+' identity; unknown initial request stays unknown',async()=>{
  const a=DIGEST('6'),b=DIGEST('7');
  const api=createFakeApi({[P(a)]:()=>jobRecord('ran',a,'running'),[P(b)]:()=>jobRecord('ran',b,'running')});
  const view=await mount(h(PromptIdentityHost,{api,initialId:a}));
  await api.answer(P(a)+'?circle=c1');await api.answer(P(a)+'/prompt?circle=c1',{text:KNOWN_PROMPT});
  assert.ok(view.text().includes(KNOWN_PROMPT));
  for(const route of [target==='job'?{id:b,circle:'c1'}:{id:a,circle:'c2'}]){
    await act(()=>promptRoute(route));await flushRendersWithoutEffects();
    assert.ok(!view.text().includes(KNOWN_PROMPT),'new identity masks old text before effects');
    await flush();
    await api.answer(P(route.id)+'?circle='+route.circle,{...jobRecord('ran',route.id,'running'),circle:{id:route.circle}});
    const path=P(route.id)+'/prompt?circle='+route.circle;
    await api.answer(path,{text:''});await advance(21000);
    assert.ok(!view.text().includes(KNOWN_PROMPT));
    assert.match(view.text(),UNAVAILABLE_PROMPT,'unknown identity does not fabricate accepted content');
  }
});

function revokedRequesterJob(id, kind) {
  const job=projectedJob(id,kind==='holder-stop'?'stopping':'running','2026-10-21T12:00:02.000Z');
  job.local.title='Revoked '+kind;
  if(kind==='unavailable')job.jobProjection.evidence.sharedStopRequestUnavailable=true;
  if(kind==='holder-stop')job.jobProjection.evidence.sharedStopRequestedAt='2026-10-21T12:00:01.000Z';
  if(kind==='saved')job.savedAt='2026-10-21T12:00:01.000Z';
  return job;
}
for(const kind of ['unavailable','holder-stop','saved'])for(const timing of ['before effects','after effects','restored']) {
  test('requester Stop revocation: '+kind+' / '+timing,async()=>{
    const id=DIGEST('a');let world=projectedJob(id,'running','2026-10-21T12:00:00.000Z');
    const api=createFakeApi({
      [P(id)]:()=>world,
      [P(id)+'/cancel']:{...projectedJob(id,'stopping','2026-10-21T12:00:03.000Z'),requested_at:'2026-10-21T12:00:03.000Z'},
    });
    const view=await mount(h(NewsHost,{api,id}));
    await api.answer(P(id)+'?circle=c1');
    await click(view.button('Stop this job'));
    const oldDialog=pendingDialog;assert.ok(oldDialog);
    await api.answer(P(id)+'?circle=c1');await flush();
    world=revokedRequesterJob(id,kind);
    await act(()=>newsSetter(1));await flush();
    const read=api.openReads(P(id)+'?circle=c1')[0];assert.ok(read);
    await flushRendersWithoutEffects(()=>read.settle('ok',world));
    assert.equal(view.$('h1')?.textContent,'Revoked '+kind,'the revoking record committed before passive effects');
    assert.ok(!view.button('Stop this job'),'the page withdrew the requester action');
    if(timing==='before effects') {
      assert.ok(view.button('Stop job'),'the old dialog is still mounted before passive invalidation');
      await act(async()=>{await oldDialog.onConfirm();});
    } else if(timing==='after effects') {
      await flush();
      // Click the normal dialog action: either the stale Stop (before the fix) or its replacement review notice.
      const button=view.button('Stop job')||view.button('Review current job');
      assert.ok(button,'the open decision has an explicit action');
      await click(button);
    } else {
      await flush();
      world=projectedJob(id,'running','2026-10-21T12:00:04.000Z');
      await act(()=>newsSetter(2));await api.answer(P(id)+'?circle=c1');await flush();
      assert.ok(view.button('Stop this job'),'healthy restored eligibility allows a NEW decision');
      await act(async()=>{await oldDialog.onConfirm();});
    }
    assert.deepEqual(api.postsOf(P(id)+'/cancel'),[],'a revoked requester token never posts cancellation');
    assert.deepEqual(api.postsOf('lending/stop'),[],'requester revocation never switches to lender Stop');
    if(timing==='before effects')assert.match(view.text(),/Job changed/,'the stale callback leaves an explanation');
  });
}
for(const scenario of ['healthy requester','local lender','waiting to running']) {
  test('Stop revocation positive control: '+scenario,async()=>{
    const id=DIGEST('b');
    let world=scenario==='local lender'?jobRecord('ran',id,'running'):
      scenario==='waiting to running'?waitingProjection(id):projectedJob(id,'running','2026-10-21T12:00:00.000Z');
    const api=createFakeApi({
      [P(id)]:()=>world,
      [P(id)+'/cancel']:{...projectedJob(id,'stopping','2026-10-21T12:00:03.000Z'),requested_at:'2026-10-21T12:00:03.000Z'},
      'lending/stop':{accepted:true},
    });
    const view=await mount(h(NewsHost,{api,id}));
    await api.answer(P(id)+'?circle=c1');
    await click(view.button(scenario==='waiting to running'?'Cancel job':'Stop this job'));
    if(scenario==='waiting to running')world=projectedJob(id,'running','2026-10-21T12:00:02.000Z');
    await api.answer(P(id)+'?circle=c1');await flush();
    assert.ok(view.button('Stop job'),'the current executing job can still be stopped');
    await click(view.button('Stop job'));
    assert.deepEqual(api.postsOf(P(id)+'/cancel'),scenario==='local lender'?[]:[
      {path:P(id)+'/cancel',body:{circle:'c1'}},
    ]);
    assert.deepEqual(api.postsOf('lending/stop'),scenario==='local lender'?[
      {path:'lending/stop',body:{attemptId:'a1',confirmed:true}},
    ]:[]);
  });
}


// A valid submit acknowledgement may arrive before the shell's first circles response.
function createdSeed(id) {
  return {jobDigest:id,job_digest:id,circle:{id:'c1',name:'Weekend projects'},
    title:'Fix the dates',prompt:'Fix the dates',submittedByMe:true,status:'Waiting',state:'queued'};
}
function seedNavigation(t,id,type='navigate') {
  t.mock.method(performance,'getEntriesByType',()=>[{type}]);
  history.pushState({createdJob:createdSeed(id)},'', '#/job/'+enc(id)+'/c1');
}
function SeedHost({api,id,rawCircles,revision=0}) {
  return h(Job,{id,requestedCircle:'c1',api,circle:'c1',circles:rawCircles||[],revision,
    mutate:async()=>({}),setDialog(value){pendingDialog=value;},members:[],
    headingRef:{current:null},refresh:async()=>{},draft:{submission:null},
    data:{jobs:[],...(rawCircles===undefined?{}:{circles:rawCircles}),
      devices:{fingerprint:'fp-1',name:'MacBook',circles:[]}}});
}
const assertSeed=view=>{
  assert.equal(view.$('h1')?.textContent,'Fix the dates');
  assert.match(view.text(),/Waiting|Nobody has started it/);
  assert.doesNotMatch(view.text(),/Loading job/);
};
test('created acknowledgement survives initially unknown circle membership and its matching response',async t=>{
  const id=DIGEST('c'),api=createFakeApi();seedNavigation(t,id);
  const view=await mount(h(SeedHost,{api,id}));
  assert.equal(api.openReads(P(id)+'?circle=c1').length,1,'detail is held');
  assertSeed(view);
  assert.equal(history.state?.createdJob,undefined,'the history seed is consumed, not replayed');
  await view.rerender(h(SeedHost,{api,id,rawCircles:[circle]}));
  assertSeed(view);
  assert.equal(api.openReads(P(id)+'?circle=c1').length,1,'membership arrival does not answer detail');
  await api.answer(P(id)+'?circle=c1',projectedJob(id,'running','2026-10-21T12:00:00.000Z'));
  assert.equal(view.$('h1')?.textContent,'Fix the login loop','valid detail replaces the seed');
  assert.match(view.text(),/Working/);
});
for(const rawCircles of [[],[{...circle,id:'c2'}]])test('confirmed missing circle permanently retires created acknowledgement: '+rawCircles.length,async t=>{
  const id=DIGEST('c'),api=createFakeApi();seedNavigation(t,id);
  const view=await mount(h(SeedHost,{api,id,rawCircles:[circle]}));assertSeed(view);
  await view.rerender(h(SeedHost,{api,id,rawCircles}));
  assert.doesNotMatch(view.text(),/Fix the dates/);
  await view.rerender(h(SeedHost,{api,id,rawCircles:[circle]}));
  assert.doesNotMatch(view.text(),/Fix the dates/,'restoring membership cannot replay retired seed');
});
for(const status of [403,404,500])test('detail error retires created acknowledgement: '+status,async t=>{
  const id=DIGEST('c'),api=createFakeApi();seedNavigation(t,id);
  const view=await mount(h(SeedHost,{api,id,rawCircles:[circle]}));assertSeed(view);
  await api.fail(P(id)+'?circle=c1',Object.assign(new Error('detail unavailable'),{status}));
  assert.doesNotMatch(view.text(),/Fix the dates/);
  await view.rerender(h(SeedHost,{api,id,rawCircles:[circle],revision:1}));
  await advance(5000);
  assert.doesNotMatch(view.text(),/Fix the dates/,'pending retry does not restore the seed');
});
for(const type of ['reload','back_forward'])test('created acknowledgement is not replayed on '+type,async t=>{
  const id=DIGEST('c'),api=createFakeApi();seedNavigation(t,id,type);
  const view=await mount(h(SeedHost,{api,id,rawCircles:[circle]}));
  assert.doesNotMatch(view.text(),/Fix the dates/);
  assert.equal(history.state?.createdJob,undefined);
});
test('unmount and return cannot replay a consumed navigate acknowledgement',async t=>{
  const id=DIGEST('c'),api=createFakeApi();seedNavigation(t,id);
  const first=await mount(h(SeedHost,{api,id,rawCircles:[circle]}));assertSeed(first);
  await first.unmount();
  const returned=await mount(h(SeedHost,{api,id,rawCircles:[circle]}));
  assert.doesNotMatch(returned.text(),/Fix the dates/);
});

test('successful local deletion prevents a created acknowledgement from being replayed',async t=>{
  const id=DIGEST('c'),api=createFakeApi();seedNavigation(t,id);
  const view=await mount(h(SeedHost,{api,id,rawCircles:[circle]}));assertSeed(view);
  await api.answer(P(id)+'?circle=c1',projectedJob(id,'stopped','2026-10-21T12:00:00.000Z'));
  await api.answer(P(id)+'/retention?circle=c1',{deletable:true});
  const remove=view.button('Delete this job…');assert.ok(remove,'terminal detail offers deletion');
  await click(remove);assert.ok(pendingDialog);
  await act(async()=>{await pendingDialog.onConfirm();});
  assert.deepEqual(api.postsOf(P(id)+'/delete'),[{path:P(id)+'/delete',body:{circle:'c1'}}]);
  await view.unmount();
  // Even an old history entry carrying the original acknowledgement cannot undo local deletion.
  history.pushState({createdJob:createdSeed(id)},'', '#/job/'+enc(id)+'/c1');
  const returned=await mount(h(SeedHost,{api,id,rawCircles:[circle]}));
  assert.doesNotMatch(returned.text(),/Fix the dates/);
  assert.equal(api.openReads(P(id)+'?circle=c1').length,1,'the replacement detail is still held');
});

function stoppedLabelRecord(role, empty = false) {
  const id = DIGEST('a');
  return {...jobRecord(role, id, 'result-accepted'),role,
    receipt:{candidate_format:'diff',diffstat:{files:empty ? 0 : 1}},
    stopRequest:{attempt_id:'a1',generation:1,job_digest:id,requested_at:'2026-10-21T12:00:00.000Z'}};
}
for (const [role, empty, word] of [
  ['sent', false, 'Stopped early · ready to review'],
  ['ran', false, 'Stopped early · sent back'],
  ['sent', true, 'Stopped early · no changes'],
  ['ran', true, 'Stopped early · no changes'],
]) {
  test('stopped result status mounts in Jobs and ResultCard: ' + role + ' / empty=' + empty, async () => {
    const record = stoppedLabelRecord(role, empty);
    const list = jobsListVM([record]);
    const row = list.groups[0].rows[0];
    // Exercise the reusable card with the real list projection. Home selects only
    // nonempty sender results; the component must still display its supplied status.
    const vm = {result:row,preview:{lines:[],prompt:'Partial repair'},resultCopy:{lead:'Review the result.',action:'Review',summary:false}};
    const view = await mount(h(Fragment, null, h(JobsList, {vm:list}), h(ResultCard, {vm})));
    assert.equal(view.$('.job-status .st').textContent, word);
    assert.ok(view.$('.result-card').textContent.includes(word), 'the card uses the projected status, not a fixed Ready to review');
    assert.ok(view.$('.result-card').textContent.includes(row.stopNote), 'keep the explanation');
  });
  test('stopped result job headline preserves its qualifier: ' + role + ' / empty=' + empty, async () => {
    const record = stoppedLabelRecord(role, empty), id = record.job_digest;
    const changes = empty ? {format:'diff',diff:'',files:[],diffstat:{files:0}} : patch;
    const api = createFakeApi({[P(id)]:record,[P(id)+'/changes']:changes,
      [P(id)+'/prompt']:{text:'Fix it'},[P(id)+'/transcript']:{text:'',live:false}});
    const view = await mount(h(Host, {api,role,initialId:id}));
    await api.answer(P(id)+'?circle=c1');
    await api.answer(P(id)+'/changes?circle=c1');
    if (role === 'ran') await api.answer(P(id)+'/prompt?circle=c1');
    assert.ok(view.$('.jh').textContent.includes(word), 'the job header uses the stopped-early word even for no changes');
  });
}
test('ResultCard never calls a supplied hard-stopped job Ready to review', async () => {
  const record = {...jobRecord('sent',DIGEST('b'),'cancelled'),role:'sent'};
  record.current_attempt.compute_stopped = true;
  const row = jobsListVM([record]).groups[0].rows[0];
  assert.equal(row.key, 'stopped');
  const vm = {result:row,preview:{lines:[]},resultCopy:{lead:'Nothing returned.',action:'Open',summary:false}};
  const view = await mount(h(ResultCard, {vm}));
  assert.doesNotMatch(view.text(), /Ready to review/);
  assert.match(view.text(), /Stopped/);
});

test('Jobs hydrates past 20 cached receipts and drains bounded result batches', async () => {
  const records = Array.from({length:61}, (_, index) => ({
    ...jobRecord('sent', 'sha256:' + index.toString(16).padStart(64,'0'), 'result-accepted'),
    role:'sent',
    local:{title:'Hydration job ' + (index + 1), submittedAt:new Date(Date.now()).toISOString()},
  }));
  const receipt = {receipt:{harness:'codex',candidate_format:'diff',diffstat:{files:0}}};
  const receiptPath = job => P(job.job_digest) + '/receipt?circle=c1';
  const api = createFakeApi();
  for (const job of records.slice(0,20)) {
    const pending = loadJobReceipt(api,job);
    await api.answer(receiptPath(job),receipt);
    await pending;
  }
  const view = await mount(h(Jobs,{api,circles:[circle],selected:circle,revision:0,
    data:{jobs:records,devices:{name:'MacBook',circles:[]}}}));
  const status = job => view.$('a[href="#/job/' + enc(job.job_digest) + '/c1"] .job-status .st')?.textContent;
  assert.equal(status(records[0]),'No changes','cached details are shown immediately');
  assert.equal(status(records[20]),'Ready to review','unknown details are not guessed');
  assert.equal(api.openReads(receiptPath(records[20])).length,1,'cached rows do not starve row 21');
  assert.equal(api.openReads(receiptPath(records[24])).length,0,'only four reads run at once');
  assert.equal(api.openReads(receiptPath(records[40])).length,0,'the second batch waits');
  for (const job of records.slice(20,39)) {
    await api.answer(receiptPath(job),receipt);
  }
  assert.equal(status(records[20]),'No changes','row 21 converges to the detail result');
  assert.equal(api.openReads(receiptPath(records[40])).length,0,'the next batch waits for all 20 reads');
  await api.answer(receiptPath(records[39]),receipt);
  await flush();
  assert.equal(api.openReads(receiptPath(records[40])).length,1,'remaining unknown rows are drained');
  await api.answer(receiptPath(records[40]),receipt);
  assert.equal(status(records[40]),'No changes');
  for (const job of records.slice(41)) await api.answer(receiptPath(job),receipt);
  assert.equal(status(records[60]),'No changes','all three batches drain');
  assert.equal(status(records[0]),'No changes','mounted rows retain evidence after shared cache eviction');
  assert.equal(status(records[20]),'No changes','earlier hydrated rows also retain evidence');
  await click(view.button('Needs you 0'));
  assert.match(view.text(),/No jobs match your search or filters/);
});

// A finished job whose signed result has no changed files: the page pill must say No changes, not Finished.
const zeroChanges = {format:'diff',diff:'',files:[],diffstat:{files:0,insertions:0,deletions:0}};
function zeroChangeRecord(id, stopped = false) {
  return {...jobRecord('sent', id, 'result-accepted'),
    ...(stopped ? {stopRequest:{attempt_id:'a1',generation:1,job_digest:id,requested_at:'2026-10-21T12:00:00.000Z'}} : {})};
}
async function mountZeroChangeJob(id, stopped) {
  const api = createFakeApi({[P(id)]: zeroChangeRecord(id, stopped), [P(id)+'/changes']: zeroChanges,
    [P(id)+'/prompt']: {text: 'Fix it'}, [P(id)+'/transcript']: {text: finalText('Done'), live: false}});
  const view = await mount(h(Host, {api, role: 'sent', initialId: id}));
  await api.answer(P(id)+'?circle=c1');
  await api.answer(P(id)+'/changes?circle=c1');
  return view;
}
test('finished job with a signed zero-file result says No changes in its page pill, not Finished', async () => {
  const view = await mountZeroChangeJob(DIGEST('c'), false);
  assert.equal(view.$('.jh .pill').textContent, 'No changes', 'the job page pill names the zero-change result');
  assert.doesNotMatch(view.$('.jh').textContent, /Finished/, 'the page never calls a zero-change result Finished');
});
test('stopped-early job with a signed zero-file result keeps its stopped-early word, not No changes', async () => {
  const view = await mountZeroChangeJob(DIGEST('d'), true);
  const pill = view.$('.jh .pill').textContent;
  assert.match(pill, /^Stopped early/, 'the stopped-early word still shows');
  assert.doesNotMatch(pill, /No changes|Finished/);
});

// Live is a claim about the last confirmed transcript read (liveFreshness in transcript-feed.mjs), not about the agent's own timestamps.
for (const [name, ageMs, shown] of [['fresh', 5000, true], ['stale', 31000, false]]) {
  test(`Job mounted: a running job whose last live transcript read is ${name} ${shown ? 'shows' : 'does not show'} the Live badge`, async () => {
    const id = DIGEST('c');
    const api = createFakeApi({[P(id)]: () => jobRecord('ran', id, 'running'),
      [P(id) + '/transcript']: () => ({text: lines('Working on the login loop'), live: true}),
      [P(id) + '/changes']: () => patch, [P(id) + '/prompt']: () => ({text: 'Fix it'})});
    const view = await mount(h(Host, {api, initialId: id}));
    await api.release();
    assert.match(view.text(), /Working on the login loop/);
    assert.notEqual(document.querySelector('.activity-live'), null, 'the first confirmed read is live');
    await advance(ageMs);
    assert.equal(document.querySelector('.activity-live') !== null, shown, 'the badge follows the age of the last confirmed read');
  });
}
// The present-execution line needs a timestamped agent update inside the same window; a live read alone does not make a claim.
const timedLine = (text, at) => JSON.stringify({type: 'assistant', timestamp: new Date(at).toISOString(), message: {role: 'assistant', content: [{type: 'text', text}]}});
for (const [name, ageMs, claimed] of [['recent', 5000, true], ['old', 60000, false]]) {
  test(`Job mounted: a running job whose agent update is ${name} ${claimed ? 'states its activity' : 'makes no activity claim but keeps its start and limit'}`, async () => {
    const id = DIGEST('e'), at = Date.now() - ageMs;
    const api = createFakeApi({[P(id)]: () => ({...jobRecord('ran', id, 'running'), runTiming: {hardStopAt: new Date(Date.now() + 3600000).toISOString()}}),
      [P(id) + '/transcript']: () => ({text: timedLine('Working on the login loop', at), live: true}),
      [P(id) + '/changes']: () => patch, [P(id) + '/prompt']: () => ({text: 'Fix it'})});
    const view = await mount(h(Host, {api, initialId: id}));
    await api.release();
    assert.match(view.text(), /Working on the login loop/);
    assert.equal(document.querySelector('.activity-intro b') !== null, claimed, 'the claim follows the age of the agent’s own update');
    // The observed start and time limit are not live claims, so an old agent update must not hide them.
    const intro = document.querySelector('.activity-intro');
    assert.notEqual(intro, null, 'the observed start and time limit stay shown');
    assert.match(intro.textContent, /Started .*ago/, 'the observed start is shown');
    assert.match(intro.textContent, /Time limit/, 'the time limit is shown');
  });
}

import {useLendingReadiness} from './lending-readiness-read.mjs';

// Exercise the actual hook. Control source changes through state so a render
// can be inspected before passive effects, without replacing its algorithm.
function ReadinessHarness({source, expose, initial=null}) {
  const [input,setInput]=useState(source);
  const result=useLendingReadiness(input.api,input.readiness,input.agents,initial);
  expose.set=setInput;expose.retry=result.retry;
  return h('output',null,JSON.stringify({value:result.value,error:result.error}));
}
const readinessValue=view=>JSON.parse(view.$('output').textContent);
const readinessApi=()=>{
  const api=createFakeApi(),get=api.get.bind(api);
  api.get=(path,signal)=>{
    const promise=get(path,signal);
    api.reads.at(-1).startedAt=Date.now();
    return promise;
  };
  return api;
};
// flushRendersWithoutEffects leaves frames queued. Tick that owned frame queue
// before expecting a read; this is not the 15-second observation deadline.
const readinessEffects=()=>advance(100,20);
async function closeReadiness(view,...apis) {
  try {await view?.unmount();}
  finally {
    for(const api of apis)for(const call of api.openReads('lending/readiness'))
      call.settle('err',new Error('owned fixture cleanup'));
    await flush();
  }
}
for(const dependency of ['readiness','agents'])test('readiness hook hides changed '+dependency+' before effects and starts after frames',async()=>{
  const api=readinessApi(),expose={},source={api,readiness:{revision:1},agents:[]};
  let view;
  try {
    view=await mount(h(ReadinessHarness,{source,expose}));
    await readinessEffects();
    assert.equal(api.openReads('lending/readiness').length,1);
    await api.answer('lending/readiness',{ready:'old'});
    assert.deepEqual(readinessValue(view).value,{ready:'old'});
    const changed={...source,[dependency]:dependency==='agents'?[{}]:{revision:2}};
    await flushRendersWithoutEffects(()=>expose.set(changed));
    assert.equal(readinessValue(view).value,null,'old evidence hides synchronously');
    await readinessEffects();
    assert.equal(api.openReads('lending/readiness').length,1,'new effect owns a real read');
    await api.answer('lending/readiness',{ready:'new'});
    assert.deepEqual(readinessValue(view).value,{ready:'new'});
  } finally {await closeReadiness(view,api);}
});
test('readiness refresh waits for the same API read without cancelling it on screen',async()=>{
  const api=readinessApi(),expose={},source={api,readiness:{},agents:[]};
  let view;
  try {
    view=await mount(h(ReadinessHarness,{source,expose}));
    const first=api.openReads('lending/readiness')[0];
    await act(()=>expose.set({...source,readiness:{changed:true},agents:[{}]}));
    await readinessEffects();
    assert.equal(first.signal.aborted,false,'same API input refresh must not abort the browser request');
    assert.equal(api.count('lending/readiness'),1);
    await api.answer('lending/readiness',{ready:'stale'});
    assert.equal(readinessValue(view).value,null,'the older response cannot publish');
    await readinessEffects();
    assert.equal(api.count('lending/readiness'),2);
    await api.answer('lending/readiness',{ready:'current'});
    assert.deepEqual(readinessValue(view).value,{ready:'current'});
  } finally {await closeReadiness(view,api);}
});
test('readiness hook binds fetched evidence to API and retry before effects',async()=>{
  const a=readinessApi(),b=readinessApi(),expose={},source={api:a,readiness:{},agents:[]};
  let view;
  try {
    view=await mount(h(ReadinessHarness,{source,expose}));
    await readinessEffects();await a.answer('lending/readiness',{ready:'A'});
    await flushRendersWithoutEffects(()=>expose.set({...source,api:null}));
    assert.equal(readinessValue(view).value,null,'null API immediately hides A');
    await readinessEffects();
    assert.equal(readinessValue(view).value,null);
    await flushRendersWithoutEffects(()=>expose.set({...source,api:b}));
    assert.equal(readinessValue(view).value,null);
    await readinessEffects();
    assert.equal(b.openReads('lending/readiness').length,1);
    await b.answer('lending/readiness',{ready:'B'});
    assert.deepEqual(readinessValue(view).value,{ready:'B'});
    await flushRendersWithoutEffects(()=>expose.retry());
    assert.equal(readinessValue(view).value,null,'retry hides fetched evidence before its effect');
    await readinessEffects();
    assert.equal(b.openReads('lending/readiness').length,1);
    await b.answer('lending/readiness',{ready:'retry'});
    assert.deepEqual(readinessValue(view).value,{ready:'retry'});
    await flushRendersWithoutEffects(()=>expose.set(source));
    assert.equal(readinessValue(view).value,null,'returning to A does not resurrect its result');
    await readinessEffects();await a.answer('lending/readiness',{ready:'fresh A'});
    assert.deepEqual(readinessValue(view).value,{ready:'fresh A'});
  } finally {await closeReadiness(view,a,b);}
});
test('readiness hook keeps only the unchanged first no-get seed',async()=>{
  const expose={},source={api:null,readiness:{},agents:[]},seed={ready:'explicit seed'};
  let view;
  try {
    view=await mount(h(ReadinessHarness,{source,expose,initial:seed}));
    assert.deepEqual(readinessValue(view).value,seed);
    await readinessEffects();
    await flushRendersWithoutEffects(()=>expose.set({...source}));
    assert.deepEqual(readinessValue(view).value,seed,'same identities retain the explicit seed');
    await flushRendersWithoutEffects(()=>expose.set({...source,api:{}}));
    assert.equal(readinessValue(view).value,null,'changed unusable API cannot reuse the seed');
    await readinessEffects();
    await flushRendersWithoutEffects(()=>expose.set(source));
    assert.equal(readinessValue(view).value,null,'returning source cannot replay retired seed');
    await readinessEffects();
    await flushRendersWithoutEffects(()=>expose.retry());
    assert.equal(readinessValue(view).value,null);
  } finally {await closeReadiness(view);}
});
test('readiness timeout aborts but three retries cannot release an ignored-abort physical read',async()=>{
  const api=readinessApi(),expose={},source={api,readiness:{},agents:[]};
  let view;
  try {
    view=await mount(h(ReadinessHarness,{source,expose}));
    await readinessEffects();
    const first=api.openReads('lending/readiness')[0];assert.ok(first);
    assert.ok(first.signal instanceof AbortSignal);
    first.ignoreAbort=true;
    await advance(first.startedAt+14999-Date.now());
    assert.equal(first.signal.aborted,false,'the owned deadline has not elapsed');
    await advance(1);
    assert.equal(first.aborted,true);assert.equal(first.signal.aborted,true);
    assert.equal(first.state,'open','abort is not settlement');
    assert.deepEqual(readinessValue(view),{value:null,error:true});
    for(let i=0;i<3;i++){
      await flushRendersWithoutEffects(()=>expose.retry());
      assert.equal(readinessValue(view).value,null);
      await readinessEffects();
      assert.equal(api.count('lending/readiness'),1);
      assert.equal(api.openReads('lending/readiness').length,1);
    }
    await flushRendersWithoutEffects(()=>expose.set({...source,readiness:{changed:true},agents:[{}]}));
    assert.equal(readinessValue(view).value,null);
    await readinessEffects();
    assert.equal(api.count('lending/readiness'),1,'dependency changes also keep the physical slot');
    assert.equal(api.openReads('lending/readiness').length,1);
    // Real rejection, not timeout or abort, releases this API's physical slot.
    first.settle('err',new Error('late owned rejection'));await flush();
    await readinessEffects();
    assert.equal(api.count('lending/readiness'),2,'only the latest retry starts');
    assert.equal(api.openReads('lending/readiness').length,1);
    assert.equal(api.peak('lending/readiness'),1);
    assert.equal(readinessValue(view).value,null);
    assert.equal(readinessValue(view).error,false,'old rejection cannot poison replacement');
    await api.answer('lending/readiness',{ready:'latest'});
    assert.deepEqual(readinessValue(view).value,{ready:'latest'});
  } finally {await closeReadiness(view,api);}
});
for(const late of ['fulfill','reject'])test('readiness API B progresses while disposed A ignores abort; old A '+late+' cannot replace B',async()=>{
  const a=readinessApi(),b=readinessApi(),expose={},source={api:a,readiness:{},agents:[]};
  let view;
  try {
    view=await mount(h(ReadinessHarness,{source,expose}));
    const first=a.openReads('lending/readiness')[0];assert.ok(first);
    assert.ok(first.signal instanceof AbortSignal);
    assert.equal(first.signal.aborted,false);
    first.ignoreAbort=true;
    // This case observes committed disposal, not the separate pre-effect hiding seam.
    await act(()=>expose.set({...source,api:b}));
    await flush();
    const replacement=b.openReads('lending/readiness')[0];
    assert.ok(replacement,'normal committed B effect started a real GET');
    assert.equal(replacement.path,'lending/readiness');
    assert.ok(replacement.signal instanceof AbortSignal);
    assert.equal(replacement.signal.aborted,false);
    assert.equal(first.state,'open','B progresses before ignored-abort A settles');
    assert.equal(first.signal.aborted,true,'the captured A controller was aborted by disposal');
    assert.equal(first.aborted,true,'the actual fake API abort listener ran');
    assert.equal(a.count('lending/readiness'),1);
    assert.equal(a.openReads('lending/readiness').length,1);
    assert.equal(b.count('lending/readiness'),1);
    assert.equal(readinessValue(view).value,null);
    await b.answer('lending/readiness',{ready:'B'});
    assert.deepEqual(readinessValue(view).value,{ready:'B'},'current B publishes positively');
    first.settle(late==='fulfill'?'ok':'err',late==='fulfill'?{ready:'stale A'}:new Error('late A rejection'));
    await flush();
    assert.deepEqual(readinessValue(view),{value:{ready:'B'},error:false});
    assert.equal(a.count('lending/readiness'),1,'obsolete A never restarts');
    assert.equal(b.count('lending/readiness'),1,'old A does not release/restart B');
    assert.equal(a.peak('lending/readiness'),1);assert.equal(b.peak('lending/readiness'),1);
    await act(()=>expose.retry());await flush();
    const pending=b.openReads('lending/readiness')[0];assert.ok(pending);pending.ignoreAbort=true;
    assert.ok(pending.signal instanceof AbortSignal);
    assert.equal(b.count('lending/readiness'),2);
    await view.unmount();view=null;
    assert.equal(pending.signal.aborted,true);assert.equal(pending.aborted,true);
    assert.equal(pending.state,'open','unmount abort is not physical settlement');
    pending.settle('err',new Error('late after unmount'));await flush();
    assert.equal(b.count('lending/readiness'),2,'unmount starts no work');
    assert.equal(a.count('lending/readiness'),1);
    assert.equal(b.openReads('lending/readiness').length,0);
  } finally {await closeReadiness(view,a,b);}
});

const handoffButton=(view,label)=>Array.from(view.$('#job-handoff')?.querySelectorAll('button')??[]).find(button=>button.textContent.trim()===label);
const continuationRoute=id=>P(id)+'/continuation?circle=c1';
const mainThreadRoute=id=>P(id)+'/thread?circle=c1';
// continuationFor returns this envelope; buildHandoff emits string changes/claims and bound scan metadata.
// These are mounted transport fixtures, not evidence of executing the producer or its signature verifier.
const mountedContinuation=(id,objective='Route handoff')=>({
 parentJob:id,parentResult:DIGEST('f'),sourceKind:'folder',
 base:{path:'/work/project',branch:'review/result',commit:'a'.repeat(40)},
 handoff:{schema:'faravan.continuation.v1',mode:'summary',trust:'untrusted',objective,latest_instruction:objective,changes:'Work completed',agent_claims:'Work completed',open_issues:[],next_steps:[],observed_checks:[{cmd:'npm test',exit:0,timed_out:false,observed_by:'sandbox'}],scan:{status:'passed',policy:'credential-rules-v1'}},thread:[],
});
const continuationFailure=()=>Object.assign(new Error('Read unavailable'),{code:'invalid_request',status:400});
async function mountedContinuationJob(t,{id=DIGEST('a'),role='sent',result=true,routeCircle='c1'}={}) {
 const api=createFakeApi(),initialHash=location.hash;
 const put=(next,nextRole=role,nextResult=result)=>{Object.assign(api.table,{
 [P(next)]:()=>jobRecord(nextRole,next,nextResult?'result-accepted':'running'),[P(next)+'/changes']:patch,[P(next)+'/prompt']:{text:'Fix it'},[P(next)+'/transcript']:{text:finalText('Work completed'),live:!nextResult},});};
 put(id);
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'location');
 let reloads=0,copies=0;
 const locationProxy=new Proxy(globalThis.location,{get(target,key){if(key==='reload')return ()=>{reloads++;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
 Object.defineProperty(globalThis,'location',{configurable:true,value:locationProxy});
 const clipboard=Object.getOwnPropertyDescriptor(navigator,'clipboard');
 Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{copies++;}}});
 const storageSnapshot=()=>Array.from({length:localStorage.length},(_,i)=>localStorage.key(i)).sort().map(key=>[key,localStorage.getItem(key)]);
 const beforeStorage=storageSnapshot();let view;
 t.after(async()=>{try {await view?.unmount();for(const call of api.openReads(()=>true))call.settle('ok',{});await flush();} finally {Object.defineProperty(globalThis,'location',descriptor);if(clipboard)Object.defineProperty(navigator,'clipboard',clipboard);else delete navigator.clipboard;}});
 view=await mount(h(Host,{api,role,initialId:id,routeCircle}));
 const ready=async next=>{await api.answer(P(next)+'?circle=c1');for(let turn=0;turn<3;turn++)await api.release(path=>!path.includes('/thread')&&!path.includes('/continuation'));};
 if(routeCircle)await ready(id);
 const unchanged=()=>{assert.deepEqual(api.posts,[]);assert.equal(reloads,0);assert.equal(copies,0);assert.equal(location.hash,initialHash);assert.deepEqual(storageSnapshot(),beforeStorage);};
 return {api,view,ready,put,unchanged};
}

test('mounted Job bare result wires its literal continuation route and independent causal retry',async t=>{
 const id=DIGEST('a'),f=await mountedContinuationJob(t,{id});const path=continuationRoute(id),main=mainThreadRoute(id);
 assert.equal(path,'jobs/sha256%3A'+'a'.repeat(64)+'/continuation?circle=c1');assert.equal(f.api.count(path),1,'one child-owned continuation GET through actual Job');
 await f.api.answer(main,{thread:[{job_digest:id,title:'Current'},{job_digest:DIGEST('b'),title:'Main sibling stays'}]});await f.api.fail(path,continuationFailure());
 assert.match(f.view.text(),/Main sibling stays/);assert.ok(f.view.$('#job-handoff section[aria-label="Continue this work"] [role="alert"]'));
 const baseline=f.api.count(main),button=f.view.$('#job-handoff section[aria-label="Continue this work"] button');assert.equal(button.textContent.trim(),'Try again');
 await click(button);await forceClick(button);await forceClick(button);assert.equal(f.api.count(path),2);assert.equal(button.getAttribute('aria-busy'),'true');await flush();assert.equal(button.getAttribute('aria-busy'),'true','owned read has not settled');
 await f.api.fail(path,continuationFailure());assert.notEqual(button.getAttribute('aria-busy'),'true');await click(f.view.$('#job-handoff section[aria-label="Continue this work"] button'));assert.equal(f.api.count(path),3);
 await f.api.answer(path,mountedContinuation(id));assert.match(f.view.text(),/Route handoff/);assert.match(f.view.text(),/npm test.*exit 0/);assert.ok(f.view.button('Copy summary'));assert.ok(handoffButton(f.view,'Send a follow-up job'));assert.match(f.view.text(),/Main sibling stays/);assert.equal(f.api.count(main),baseline,'continuation retry does not reload main thread');assert.equal(f.api.peak(path),1);f.unchanged();
});
for(const control of ['nonowner','nonresult','no-circle'])test('mounted Job continuation eligibility: '+control,async t=>{
 const id=DIGEST('c');const f=await mountedContinuationJob(t,{id,role:control==='nonowner'?'ran':'sent',result:control!=='nonresult',routeCircle:control==='no-circle'?'':'c1'});
 assert.equal(f.api.count(path=>path.includes('/continuation')),0);assert.ok(!f.view.$('section[aria-label="Continue this work"]'));
 if(control==='nonresult'){await f.api.answer(mainThreadRoute(id),{thread:[{job_digest:id,title:'Current'},{job_digest:DIGEST('b'),title:'Ordinary thread sibling'}]});assert.match(f.view.text(),/Ordinary thread sibling/,'ordinary slot keeps its main resource with null continuation');assert.equal(f.api.count(mainThreadRoute(id)),1);}
 f.unchanged();
});
// continuationFor's unavailable scan fallback is a withheld buildHandoff with empty prose/checks.
// A missing response object is deliberately malformed transport data, not a producer success schema.
for(const condition of ['withheld','malformed-missing','unready'])test('mounted Job continuation keeps honest '+condition+' state without side effects',async t=>{
 const id=DIGEST('d'),f=await mountedContinuationJob(t,{id});const path=continuationRoute(id),safe=mountedContinuation(id);
 if(condition==='unready')await f.api.fail(path,Object.assign(new Error('Wait for the result before continuing.'),{status:409,code:'result_not_delivered'}));else await f.api.answer(path,condition==='malformed-missing'?{}:{...safe,handoff:{...safe.handoff,objective:'',latest_instruction:'',changes:'',agent_claims:'',observed_checks:[],scan:{status:'withheld',policy:'credential-rules-v1',reason:'known_value_scan_unavailable'}}});
 assert.ok(!f.view.button('Copy summary'));assert.doesNotMatch(f.view.text(),/Route handoff/);
 if(condition==='withheld'){assert.match(f.view.text(),/scan withheld the handoff summary/);assert.ok(handoffButton(f.view,'Send a follow-up job'),'existing source-only follow-up remains available');}else if(condition==='malformed-missing'){assert.match(f.view.text(),/No handoff summary is available/);assert.ok(!handoffButton(f.view,'Send a follow-up job'));}else assert.ok(f.view.$('#job-handoff section[aria-label="Continue this work"] [role="alert"]'));
 f.unchanged();
});

test('mounted Job keyed route and unmount cancel continuation while ignored late replies cannot publish',async t=>{
 const a=DIGEST('a'),b=DIGEST('b'),f=await mountedContinuationJob(t,{id:a});
 const old=f.api.openReads(continuationRoute(a))[0];assert.ok(old);old.ignoreAbort=true;f.put(b);
 await act(()=>setters.setId(b));await flush();await f.ready(b);assert.equal(old.signal.aborted,true,'route exit requests old cancellation');assert.equal(f.api.count(continuationRoute(b)),1);
 await f.api.answer(continuationRoute(b),mountedContinuation(b,'Replacement handoff'));old.settle('ok',mountedContinuation(a,'Late old handoff'));await flush();
 assert.match(f.view.text(),/Replacement handoff/);assert.doesNotMatch(f.view.text(),/Late old handoff/);f.unchanged();
 await act(()=>setters.setRevision(1));await advance(5000);const abandoned=f.api.openReads(continuationRoute(b))[0];assert.ok(abandoned);abandoned.ignoreAbort=true;
 await f.view.unmount();assert.equal(abandoned.signal.aborted,true);abandoned.settle('ok',mountedContinuation(b,'Unmounted handoff'));await flush();assert.equal(document.body.textContent,'');f.unchanged();
});
