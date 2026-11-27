// Component wiring only. Dependency: fv-build-result-selection-display-1114 owns schema/crypto qualification.
// TESTS NOT RUN. Use the host JSX-capable landing gate; not raw node against JSX.
import {createFakeApi, flush, advance, installClock, mount, resetPage, teardown} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {Job} from './jobs.jsx';

beforeEach(()=>{resetPage('#/job/x');installClock();});
afterEach(teardown);
const ID='sha256:'+'e'.repeat(64), OTHER='sha256:'+'f'.repeat(64);
const RESULT='sha256:'+'a'.repeat(64), NEXT_RESULT='sha256:'+'b'.repeat(64);
const circles=[{id:'c1',name:'Weekend projects',origin:'http://x',owned:true},
  {id:'c2',name:'Other projects',origin:'http://y',owned:true}];
const path=(id,circle,suffix='')=>'jobs/'+encodeURIComponent(id)+suffix+'?circle='+circle;
const choice=(extra={})=>({intent:'strongest',model:'lender-choice',effort:'high',rule_version:'auto-run-v1',
  reason:'highest_capability_rank',capped:false,pricing_revision:'prices-sha256:'+'a'.repeat(64),...extra});
const receipt=(extra={})=>({harness:'codex',harness_version:'1.2.3',model:'provider-observed',backend:'docker-sbx',
  duration_ms:60000,egress_applied:'provider-only',auto_run_v1:choice(),...extra});
const record=(state,{id=ID,circle='c1',...extra}={})=>({job_digest:id,circle:{id:circle},state,status:state,
  requestedAutoRun:'strongest',...(state==='result-accepted'?{result_digest:RESULT}:{}),
  current_attempt:{holder:'fp-2',attempt_id:'a1',generation:1,...(state==='queued'?{}:
    {execution_started_at:new Date(Date.now()-60000).toISOString()})},
  local:{title:'Fix the login loop',prompt:'Fix it',agent:'codex',submittedAt:new Date(Date.now()-120000).toISOString()},
  ...extra});
const changes=extra=>({format:'diff',diff:'',files:[],diffstat:{files:0,insertions:0,deletions:0},...extra});
const props=(api,id=ID,circle='c1',revision=0)=>({key:id+':'+circle,id,requestedCircle:circle,api,circle,circles,
  revision,mutate:async()=>({}),setDialog(){},members:[],headingRef:{current:null},
  draft:{submission:null},data:{jobs:[],devices:{fingerprint:'fp-1',name:'MacBook',circles:[]}}});
async function start(job=record('result-accepted'),extra={},defer=false){
  const id=job.job_digest,circle=job.circle.id;
  const api=createFakeApi({[path(id,circle)]:job,[path(id,circle,'/changes')]:changes(extra),
    [path(id,circle,'/prompt')]:{text:'Fix it'},[path(id,circle,'/transcript')]:{text:'',live:false}});
  const view=await mount(h(Job,props(api,id,circle)));
  await api.answer(path(id,circle));await flush();
  if(job.state==='result-accepted'&&!defer){await api.answer(path(id,circle,'/changes'));await flush();}
  return {api,view};
}
function finished(view){
  assert.ok(view.$('.job-result'),'mounted finished-result layout exists');
  assert.equal(view.$('[aria-label="Loading result"]'),null);
  assert.ok(view.$('[aria-label="Result actions and details"]'));
  assert.ok(view.button('Send a follow-up job'),'supported no-change result has its real action');
  assert.doesNotMatch(view.text(),/Unsupported result format:/);
}
function separated(view,{intent='Strongest offered',selected='lender-choice / high effort',reported='provider-observed'}={}){
  const text=view.text();
  assert.ok(text.includes('Asked for: '+intent));
  assert.ok(text.includes('Requested for this run: '+selected));
  assert.ok(text.includes('Provider reported: '+reported));
  assert.ok(text.includes('Provider effort: not reported'));
  assert.doesNotMatch(text,/Provider effort: (high|max|low)/);
}

test('initial running Job has unknown selection; actual changes DTO supplies finished receipt',async()=>{
  const {api,view}=await start(record('running'));
  separated(view,{selected:'not chosen yet',reported:'nothing yet'});
  assert.equal(view.button('Send a follow-up job'),null);
  await view.rerender(h(Job,props(api,ID,'c1',1)));
  await advance(5000);
  await api.answer(path(ID,'c1'),record('result-accepted'));
  await flush();
  assert.ok(view.$('[aria-label="Loading result"]'),'receipt is not fabricated before changes arrival');
  await api.answer(path(ID,'c1','/changes'),changes({receipt:receipt()}));await flush();
  finished(view);separated(view);
});
test('changes receipt wins over an older job receipt without conflating model or effort',async()=>{
  const {view}=await start(record('result-accepted',{receipt:receipt({model:'old-job-model',
    auto_run_v1:choice({model:'old-job-choice'})})}),{receipt:receipt()});
  finished(view);separated(view);
  assert.doesNotMatch(view.text(),/old-job-model|old-job-choice/);
});
test('mismatched receipt intent never becomes the requested lender selection',async()=>{
  const {view}=await start(record('result-accepted'),{receipt:receipt({auto_run_v1:choice({intent:'cheapest',model:'wrong-intent-choice'})})});
  finished(view);separated(view,{selected:'not chosen yet'});
  assert.doesNotMatch(view.text(),/wrong-intent-choice|Asked for: Cheapest that fits/);
});
for(const selected of [undefined,null])test('missing selection '+String(selected)+' and null model stay unknown in finished Job',async()=>{
  const value=receipt({model:null});if(selected===undefined)delete value.auto_run_v1;else value.auto_run_v1=selected;
  const {view}=await start(record('result-accepted'),{receipt:value});
  finished(view);separated(view,{selected:'not chosen yet',reported:'model not reported'});
});
test('unknown requested intent without a saved selection does not fabricate automatic facts',async()=>{
  const value=receipt();delete value.auto_run_v1;
  const {view}=await start(record('result-accepted',{requestedAutoRun:'unsupported'}),{receipt:value});
  finished(view);
  assert.doesNotMatch(view.text(),/Asked for:|Requested for this run:|Provider reported:|Provider effort:/);
});
for(const dimension of ['job','circle'])test('delayed changes cannot leak after switching '+dimension,async()=>{
  const {api,view}=await start(record('result-accepted'),{},true);
  const old=api.openReads(path(ID,'c1','/changes'))[0];assert.ok(old);old.ignoreAbort=true;
  const id=dimension==='job'?OTHER:ID,circle=dimension==='circle'?'c2':'c1';
  await view.rerender(h(Job,props(api,id,circle)));
  await api.answer(path(id,circle),record('result-accepted',{id,circle,result_digest:NEXT_RESULT}));
  await api.answer(path(id,circle,'/changes'),changes({receipt:receipt({model:'current-provider',
    auto_run_v1:choice({model:'current-choice',effort:'low'})})}));
  finished(view);separated(view,{selected:'current-choice / low effort',reported:'current-provider'});
  assert.equal(old.aborted,true,'old resource is cancelled even if transport ignores cancellation');
  old.settle('ok',changes({receipt:receipt({model:'stale-provider',auto_run_v1:choice({model:'stale-choice'})})}));
  await flush();finished(view);
  separated(view,{selected:'current-choice / low effort',reported:'current-provider'});
  assert.doesNotMatch(view.text(),/stale-provider|stale-choice/);
});
test('delayed changes from an earlier result cannot bind to the replacement result',async()=>{
  const {api,view}=await start(record('result-accepted'),{},true);
  const old=api.openReads(path(ID,'c1','/changes'))[0];assert.ok(old);old.ignoreAbort=true;
  await view.rerender(h(Job,props(api,ID,'c1',1)));
  await advance(5000);
  await api.answer(path(ID,'c1'),record('result-accepted',{result_digest:NEXT_RESULT}));
  old.settle('ok',changes({receipt:receipt({model:'old-result-provider',auto_run_v1:choice({model:'old-result-choice'})})}));
  await flush();
  assert.doesNotMatch(view.text(),/old-result-provider|old-result-choice/);
  assert.equal(old.aborted,true);
  const fresh=api.openReads(path(ID,'c1','/changes')).find(call=>call!==old);
  assert.ok(fresh,'replacement result owns a fresh changes read');
  fresh.settle('ok',changes({receipt:receipt({model:'new-provider',auto_run_v1:choice({model:'new-choice'})})}));
  await flush();finished(view);separated(view,{selected:'new-choice / high effort',reported:'new-provider'});
});
test('unmount cancels outstanding changes and ignores late transport settlement',async()=>{
  const {api,view}=await start(record('result-accepted'),{},true);
  const old=api.openReads(path(ID,'c1','/changes'))[0];assert.ok(old);old.ignoreAbort=true;
  await view.unmount();assert.equal(old.aborted,true);
  const count=api.reads.length;
  old.settle('ok',changes({receipt:receipt()}));await flush();await advance(10000);
  assert.equal(api.reads.length,count);
  assert.equal(document.querySelector('.job-result'),null);
});
