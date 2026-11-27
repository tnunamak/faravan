import {advance, click, createFakeApi, installClock, mount, resetPage, teardown, window} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {Action, Connection} from './shared.jsx';
import {Jobs} from './jobs.jsx';
import {normalizeProblem} from '../../../lib/v1/problem.mjs';

beforeEach(()=>{resetPage('#/jobs');installClock();});
afterEach(async()=>{window.happyDOM.setWindowSize({width:1280,height:900});await teardown();delete globalThis.innerHeight;});

test('a device Action renders pairing recovery without raw server text or desktop commands',async()=>{
  window.happyDOM.setWindowSize({width:390,height:844});
  const page=await mount(h(Action,{run:async()=>{throw {status:401,message:'SECRET /home/private job_deadbeef'};}},'Save'));
  await click(page.button('Save'));
  assert.match(page.text(),/Settings → Pairing.*pair this device again/);
  assert.doesNotMatch(page.text(),/401|SECRET|\/home\/|job_deadbeef|tray|terminal/);
});

test('a rate-limited Action cannot repeat before Retry-After and never repeats by itself',async()=>{
  let sent=0;
  const problem=normalizeProblem({}, {status:429,retryAfter:'30',now:Date.now()});
  const page=await mount(h(Action,{run:async()=>{sent++;throw {problem};}},'Save'));
  await click(page.button('Save'));
  assert.equal(page.button('Save').disabled,true);
  await click(page.button('Save'));assert.equal(sent,1);
  await advance(29999);assert.equal(page.button('Save').disabled,true);
  await advance(1);assert.equal(page.button('Save').disabled,false);
  assert.equal(sent,1,'timer only unlocks the user action');
});

test('a failed empty snapshot never says there are no jobs; a shell-handled failure is said once',async()=>{
  const api={get:async()=>[]};
  const props={api,circles:[{id:'c',origin:'https://circle.test'}],data:{jobs:[]},errors:{jobs:{code:'network'}}};
  const page=await mount(h(Jobs,props));
  assert.doesNotMatch(page.text(),/No jobs yet|Run your first job/);
  assert.match(page.text(),/connect|reach/);
  await page.rerender(h(Connection.Provider,{value:{stale:true,offline:true}},h(Jobs,props)));
  assert.doesNotMatch(page.text(),/Can’t reach|could not connect/);
});

test('nonempty cached Jobs keep rows without repeating shell-owned session recovery',async()=>{
  const api={get:async()=>[]};
  const props={api,circles:[{id:'c',origin:'https://circle.test'}],data:{jobs:[{job_digest:'sha256:'+'a'.repeat(64),state:'queued',local:{title:'Keep this row'},circle:{id:'c'}}]},errors:{jobs:{status:401}}};
  const page=await mount(h(Connection.Provider,{value:{stale:true,offline:false}},h(Jobs,props)));
  assert.match(page.text(),/Keep this row/);
  assert.doesNotMatch(page.text(),/This page is no longer connected|pair this device|new app link/);
});

test('result recovery uses phone guidance and only binds actual read intents',async()=>{
  const {JobSummaryStatus}=await import('./jobs.jsx');
  window.happyDOM.setWindowSize({width:390,height:844});
  let reads=0;
  const page=await mount(h(JobSummaryStatus,{transcript:{error:{status:401}},onRetry:()=>reads++}));
  assert.match(page.text(),/Settings → Pairing/);
  assert.equal(page.$$('button').length,0,'pairing guidance cannot be wired to reload');
  await page.rerender(h(JobSummaryStatus,{transcript:{error:{code:'forbidden'}},onRetry:()=>reads++}));
  assert.match(page.text(),/Ask the owner/);
  assert.equal(page.$$('button').length,0,'owner guidance cannot be wired to reload');
  assert.equal(reads,0);
});

test('terminal result recovery unlocks at Retry-After with no unrelated update or automatic read',async()=>{
  const {JobSummaryStatus}=await import('./jobs.jsx');
  let reads=0;
  const problem=normalizeProblem({}, {status:429,retryAfter:'2',now:Date.now()});
  const page=await mount(h(JobSummaryStatus,{transcript:{error:{problem}},onRetry:()=>reads++}));
  assert.equal(page.$('button').disabled,true);
  await advance(2000);
  assert.equal(page.$('button').disabled,false);
  assert.equal(reads,0);
  await click(page.$('button'));assert.equal(reads,1);
});

test('image API failures keep their typed recovery instead of claiming a decode failure',async()=>{
  const {ImagePreview}=await import('./image-preview.jsx');
  globalThis.innerHeight=844;
  window.happyDOM.setWindowSize({width:390,height:844});
  const problem=normalizeProblem({status:401});
  const page=await mount(h(ImagePreview,{inline:true,file:{path:'image.png',preview:{url:'/api/image'}},api:{request:async()=>{throw {problem};}}}));
  await advance(50);
  assert.match(page.text(),/Settings → Pairing/);
  assert.doesNotMatch(page.text(),/decoded|401|terminal|tray/);
});

for(const status of [401,403])test('cached job detail keeps content and uses phone recovery after '+status,async()=>{
  const {Job}=await import('./jobs.jsx');
  window.happyDOM.setWindowSize({width:390,height:844});
  const id='sha256:'+'b'.repeat(64),base='jobs/'+encodeURIComponent(id);
  const circle={id:'c1',name:'Circle',origin:'http://fixture'};
  const api=createFakeApi({[base]:{job_digest:id,circle:{id:'c1'},state:'running',
    local:{title:'Keep this job',prompt:'Keep working'},current_attempt:{holder:'other',attempt_id:'a1'}}});
  const props={id,requestedCircle:'c1',api,circle:'c1',circles:[circle],revision:0,jobNews:0,
    mutate:async()=>({}),setDialog(){},members:[],headingRef:{current:null},refresh:async()=>{},draft:{submission:null},
    data:{jobs:[],devices:{fingerprint:'self',circles:[]}}};
  const page=await mount(h(Job,props));
  await api.release();
  assert.match(page.text(),/Keep this job/);
  await page.rerender(h(Job,{...props,jobNews:1}));
  await api.fail(base+'?circle=c1',{status,code:status===401?'unauthorized':'forbidden'});
  assert.match(page.text(),/Keep this job/);
  assert.match(page.text(),status===401?/Settings → Pairing/:/Ask the owner/);
  assert.equal(page.button('Reload job'),null);
  assert.doesNotMatch(page.text(),/Couldn’t refresh this job/);
});
