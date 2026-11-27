import {mount, click, forceClick, flush, resetPage, teardown, installClock, createFakeApi, act} from './mounted.test-helper.mjs';
import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {loadHomePreview,loadHomeReceipt} from './home-preview.mjs';
import {h} from 'preact';
import {Home} from './home.jsx';
import {COMPOSE_DRAFT_PREFIX, HOME_TEXT_KEY} from './compose-draft.mjs';
import {onboardingVM} from './onboarding.mjs';
afterEach(teardown);
test('a finished preview shares its in-flight read and stays cached across route changes',async()=>{
 let release,calls=0;const gate=new Promise(resolve=>{release=resolve;});
 const api={get:async(path,signal)=>{calls++;assert.equal(path,'jobs/result/changes?circle=shared');assert.equal(signal.aborted,false);await gate;return {diffstat:{files:1,insertions:1,deletions:1}};}};
 const first=loadHomePreview(api,'jobs/result/changes?circle=shared'),second=loadHomePreview(api,'jobs/result/changes?circle=shared');
 assert.equal(first,second);release();await first;assert.equal(await loadHomePreview(api,'jobs/result/changes?circle=shared'),await first);assert.equal(calls,1);
});
test('a failed preview can retry and separate app sessions never share result data',async()=>{
 let calls=0;const api={get:async()=>{if(++calls===1)throw new Error('network');return {files:[]};}};
 await assert.rejects(loadHomePreview(api,'result'));await loadHomePreview(api,'result');assert.equal(calls,2);
 const other={get:async()=>({other:true})};assert.deepEqual(await loadHomePreview(other,'result'),{other:true});
});

test('the lightweight summary reads the signed receipt endpoint for the same result and circle',async()=>{
 const paths=[],api={get:async path=>{paths.push(path);return {receipt:{candidate_format:'diff',diffstat:{files:1}}};}};
 await loadHomeReceipt(api,'jobs/result/changes?circle=shared');assert.deepEqual(paths,['jobs/result/receipt?circle=shared']);
});

test('F6 failed preview and receipt both retry once at unchanged result paths',async()=>{
 const attempts=new Map(),api={get:async path=>{
   const n=(attempts.get(path)||0)+1;attempts.set(path,n);
   if(n===1)throw Error('offline');return {files:[]};
 }};
 const path='jobs/result/changes?circle=shared';
 await Promise.all([assert.rejects(loadHomePreview(api,path)),assert.rejects(loadHomeReceipt(api,path))]);
 assert.deepEqual([...attempts.values()],[1,1]);
 await Promise.all([loadHomePreview(api,path),loadHomeReceipt(api,path)]);
 assert.deepEqual([...attempts.values()],[2,2]);
});

const homeCircle={id:'c1',name:'Weekend projects',origin:'http://fixture',owned:true};
const homeAgent={id:'codex',installed:true,signedIn:true,useForLending:true};
function homeProps(api,jobs=[]){
  const lending={enabled:false,circle:'c1',mode:'ask',status:'idle',limits:{timeZone:'UTC',dailyJobs:3,dailyMinutes:60}};
  return {api,circles:[homeCircle],agents:[homeAgent],lending,circle:'c1',selected:homeCircle,members:[],mutate:async()=>({}),refresh(){},setDialog(){},
    data:{home:{lending,intent:{on:false,state:'off'}},circles:[homeCircle],agents:[homeAgent],jobs,approvals:[],activity:[],devices:{name:'Test computer',ownerName:'Owner',fingerprint:'own',circles:[]},readiness:{ready:false,checks:[]}}};
}
async function typeHome(app,value){
  await act(()=>{const input=app.$('#home-task');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));});
  await flush();
}
test('R2 a suggestion needs consent and a failed save preserves the typed Home text',async()=>{
  resetPage('/');installClock();
  const props=homeProps(createFakeApi()),app=await mount(h(Home,props));
  await typeHome(app,'My original work');
  const task=onboardingVM({home:props.data.home,circles:props.circles,jobs:[],agents:props.agents}).suggestions[0];
  assert.ok(Boolean(task),'fixture must offer a suggested task');
  const labels=Object.values(task).filter(value=>typeof value==='string' && value.trim());
  const suggestion=app.$$('button').find(button=>labels.some(label=>button.textContent.includes(label)));
  assert.ok(Boolean(suggestion),'fixture must expose a suggested task');
  await click(suggestion);
  assert.equal(app.$('#home-task').value,'My original work');
  assert.ok(Boolean(app.button('Use suggested task')));
  await click(app.button('Keep my text'));
  assert.equal(app.$('#home-task').value,'My original work');
  await click(suggestion);
  const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  const broken={getItem(){return null;},setItem(){throw Error('quota');}};
  Object.defineProperty(globalThis,'localStorage',{value:broken,configurable:true});
  try{
    await click(app.button('Use suggested task'));
    assert.equal(app.$('#home-task').value,'My original work');
    assert.match(app.text(),/couldn’t save your request/);
    assert.notEqual(location.hash,'#/new');
  }finally{Object.defineProperty(globalThis,'localStorage',original);}
});
test('R3 mounted preview retry preserves its focused control through pending and success',async()=>{
  resetPage('/');installClock();
  const api=createFakeApi();
  const job={job_digest:'result',status:'Finished',local:{title:'Fix result',prompt:'Fix parser'},circle:homeCircle,waitingTiming:{submittedAt:new Date(Date.now()-60000).toISOString()}};
  const app=await mount(h(Home,homeProps(api,[job])));
  const changes='jobs/result/changes?circle=c1',receipt='jobs/result/receipt?circle=c1';
  await api.fail(changes,Error('offline'));await api.fail(receipt,Error('offline'));
  const retry=app.button('Try preview again');assert.ok(Boolean(retry));retry.focus();
  await click(retry);
  assert.equal(app.button('Try preview again')===retry,true);
  assert.equal(document.activeElement===retry,true);
  assert.match(app.text(),/Loading preview and run details/);
  await forceClick(retry);
  assert.equal(api.count(changes),2);assert.equal(api.count(receipt),2);
  await api.answer(changes,{files:[]});await api.answer(receipt,{receipt:{candidate_format:'diff',diffstat:{files:1}}});
  assert.equal(app.button('Try preview again'),null,'a successful preview needs no retry');
  assert.doesNotMatch(app.text(),/Loading preview and run details/);
});

test('R1 recovery refuses to discard typed Home text or overwrite a protected draft',async()=>{
  for(const extra of [{sending:true},{uncertainSince:123},{agentRefusal:{label:'Busy',message:'Wait'}}]){
    resetPage('/');installClock();
    const saved=JSON.stringify({id:'draft-123456',prompt:'Previous request',sourceKind:'none',...extra});
    localStorage.setItem(COMPOSE_DRAFT_PREFIX+'c1',saved);
    const app=await mount(h(Home,homeProps(createFakeApi())));
    await typeHome(app,'Keep my new work');
    await act(()=>app.$('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await flush();
    const recovery=app.button(extra.agentRefusal?'Review earlier request':'Check earlier request');
    assert.ok(Boolean(recovery));await click(recovery);
    // The earlier request opens unchanged, and the new text is kept for Home instead of being discarded.
    assert.equal(localStorage.getItem(COMPOSE_DRAFT_PREFIX+'c1'),saved);
    assert.equal(localStorage.getItem(HOME_TEXT_KEY),'Keep my new work');
    await app.unmount();await teardown();
  }
});
