import './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {act, advance, click, createFakeApi, installClock, mount, resetPage, teardown} from './mounted.test-helper.mjs';
import {Compose} from './compose.jsx';
import {sendUncertain, loadDraft} from './compose-draft.mjs';
import * as draftStorage from './compose-draft.mjs';
import {createApi} from './api.mjs';

const START = Date.UTC(2026, 9, 23, 15, 0, 0);
const CIRCLE = {id:'circle-1',name:'Friends',origin:'https://friends.example',membershipProjection:{
  schemaVersion:2,kind:'membership',phase:'approved',evidence:{enrollmentState:'approved',origin:true},invitationPolicy:'unknown',
}};
const DRAFT_ID = 'original-draft-1023';

beforeEach(() => {
  resetPage('#/borrow');
  installClock(START);
  localStorage.setItem('faravan-compose-first-send-notice-seen', 'yes');
  localStorage.setItem('faravan-compose-draft:' + CIRCLE.id, JSON.stringify({
    id:DRAFT_ID,sourceKind:'none',prompt:'Send one job',path:'',workingDirectory:'',gitUrl:'',gitCommit:'',
    files:[],zip:null,includeUncommitted:false,agent:'',verifyCmd:'',verifyEdited:false,sending:false,
    uncertainSince:null,sendAnyway:false,
  }));
});
afterEach(teardown);

test('send uncertainty follows the explicit outcome field, not the HTTP status class', async () => {
  assert.equal(sendUncertain({status:409,outcome:'unknown'}), true);
  assert.equal(sendUncertain({status:503,outcome:'not_applied'}), false);
  const api = createApi('synthetic-session',async () => new Response(JSON.stringify({
    code:'network_error',message:'The host response was lost.',outcome:'unknown',operationKey:'host-key-1023',
  }),{status:503,headers:{'content-type':'application/json'}}));
  await assert.rejects(api.post('jobs',{}),error=>error.outcome==='unknown'&&error.operationKey==='host-key-1023');
  const dropped = createApi('synthetic-session',async () => { throw new TypeError('connection dropped'); });
  await assert.rejects(dropped.post('jobs',{draft_id:DRAFT_ID}),error=>error.outcome==='unknown'&&error.operationKey===DRAFT_ID);
});

test('an unknown submit keeps its draft id and retries against one accepted job', async () => {
  const api = createFakeApi(), calls = [], accepted = new Map();
  api.get = async path => path === 'folders?path=' ? {home:''} : {circle:CIRCLE.id,lenders:[],runRequestSupported:false};
  api.post = async (path, body) => {
    if (path !== 'jobs') return {};
    calls.push(structuredClone(body));
    let job = accepted.get(body.draft_id);
    if (!job) {
      job = {jobDigest:'sha256:' + 'a'.repeat(64)};
      accepted.set(body.draft_id, job);
    }
    if (calls.length === 1) throw Object.assign(new Error('response lost'), {
      code:'network_error',status:409,outcome:'unknown',operationKey:'host-operation-key',
    });
    return job;
  };
  const page = await mount(h(Compose, {circles:[CIRCLE],circle:CIRCLE.id,api,refresh:()=>{},setCircle:()=>{}}));

  await click(page.button('Send'));
  assert.equal(JSON.parse(localStorage.getItem('faravan-compose-draft:' + CIRCLE.id)).id, DRAFT_ID);
  assert.match(page.text(), /Checking whether it was sent…/);

  await advance(3000, 3000);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(body => body.draft_id), [DRAFT_ID,DRAFT_ID]);
  assert.deepEqual(calls[1],calls[0],'the retry preserves the original submitted payload');
  assert.equal(accepted.size, 1, 'the host returns the first job for the repeated key');
});

test('an explicit not-applied retry resolves the checking state', async () => {
  const api = createFakeApi(), calls = [];
  api.get = async path => path === 'folders?path=' ? {home:''} : {circle:CIRCLE.id,lenders:[],runRequestSupported:false};
  api.post = async (path, body) => {
    if (path !== 'jobs') return {};
    calls.push(structuredClone(body));
    if (calls.length === 1) throw Object.assign(new Error('The first response was lost.'), {
      code:'network_error',status:409,outcome:'unknown',operationKey:DRAFT_ID,
    });
    throw Object.assign(new Error('The host refused this job.'), {
      code:'host_refused',status:503,outcome:'not_applied',operationKey:DRAFT_ID,
    });
  };
  const page = await mount(h(Compose, {circles:[CIRCLE],circle:CIRCLE.id,api,refresh:()=>{},setCircle:()=>{}}));

  await click(page.button('Send'));
  assert.match(page.text(), /Checking whether it was sent…/);
  await advance(3000, 3000);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(body => body.draft_id), [DRAFT_ID,DRAFT_ID]);
  const saved = JSON.parse(localStorage.getItem('faravan-compose-draft:' + CIRCLE.id));
  assert.notEqual(saved.id,DRAFT_ID,'a definite refusal releases the original intent key');
  assert.equal(saved.prompt,'Send one job');
  assert.doesNotMatch(page.text(), /Checking whether it was sent…/);
});

test('a fresh sender reviews the first-send notice before posting and remembers the choice once', async () => {
  localStorage.removeItem('faravan-compose-first-send-notice-seen');
  const api = createFakeApi(), submitted = [];
  api.get = async path => path === 'folders?path=' ? {home:''} : {circle:CIRCLE.id,lenders:[],runRequestSupported:false};
  api.post = async (path, body) => {
    if (path !== 'jobs') return {};
    submitted.push(structuredClone(body));
    return {jobDigest:'sha256:' + 'b'.repeat(64)};
  };
  const props = {circles:[CIRCLE],circle:CIRCLE.id,api,refresh:()=>{},setCircle:()=>{}};
  const page = await mount(h(Compose, props));

  await click(page.button('Send'));
  assert.ok(page.$('dialog[open]'), 'the notice opens before the request');
  assert.equal(submitted.length, 0);
  assert.match(page.text(), /Before your first job goes to a friend/);
  assert.match(page.text(), /logs on that computer may receive or store/);

  const savedBeforeCancel = localStorage.getItem('faravan-compose-draft:' + CIRCLE.id);
  await click(page.button('Not now'));
  assert.equal(page.$('dialog[open]'), null);
  assert.equal(submitted.length, 0);
  assert.equal(localStorage.getItem('faravan-compose-draft:' + CIRCLE.id), savedBeforeCancel);

  await click(page.button('Send'));
  assert.ok(page.$('dialog[open]'));
  assert.equal(localStorage.getItem('faravan-compose-first-send-notice-seen'), null,
    'opening the notice does not consume it');
  await click(page.button('Send job'));
  assert.equal(submitted.length, 1);
  assert.equal(localStorage.getItem('faravan-compose-first-send-notice-seen'), 'yes');

  await page.unmount();
  const reopened = await mount(h(Compose, props));
  assert.equal(reopened.$('dialog[open]'), null, 'the first-send notice stays closed after the choice was saved');
});

test('a failed first send leaves the notice in place for the first successful send', async () => {
  localStorage.removeItem('faravan-compose-first-send-notice-seen');
  const api = createFakeApi(), calls = [];
  api.get = async path => path === 'folders?path=' ? {home:''} : {circle:CIRCLE.id,lenders:[],runRequestSupported:false};
  api.post = async (path, body) => {
    if (path !== 'jobs') return {};
    calls.push(structuredClone(body));
    if (calls.length === 1) throw Object.assign(new Error('The host refused this job.'), {
      code:'host_refused', status:503, outcome:'not_applied',
    });
    return {jobDigest:'sha256:' + 'c'.repeat(64)};
  };
  const page = await mount(h(Compose, {circles:[CIRCLE],circle:CIRCLE.id,api,refresh:()=>{},setCircle:()=>{}}));

  await click(page.button('Send'));
  await click(page.button('Send job'));
  assert.equal(calls.length, 1);
  assert.equal(localStorage.getItem('faravan-compose-first-send-notice-seen'), null,
    'a definite refusal does not consume the notice');

  await click(page.button('Send'));
  assert.ok(page.$('dialog[open]'), 'the next attempt still asks first');
  await click(page.button('Send job'));
  assert.equal(calls.length, 2);
  assert.equal(localStorage.getItem('faravan-compose-first-send-notice-seen'), 'yes',
    'the notice is remembered after the host accepts the job');
});

for (const status of [500,429]) test('compose resource failure '+status+' disables Send without losing draft and recovers', async () => {
  let failure = false;
  const api = createFakeApi();
  api.get = async path => {
    if (path === 'folders?path=') return {home:''};
    if (failure) throw Object.assign(new Error('read unavailable'), {status,code:status===429?'rate_limited':'server_error'});
    return {circle:CIRCLE.id,networked:true,host:{reachable:true,label:'Host'},lenders:[],runRequestSupported:false};
  };
  const page = await mount(h(Compose,{circles:[CIRCLE],circle:CIRCLE.id,api,refresh:()=>{},setCircle:()=>{}}));
  const disabled = () => page.button('Send').disabled || page.button('Send').getAttribute('aria-disabled') === 'true';
  assert.equal(Boolean(disabled()),false);
  failure = true;
  await advance(15000,15000);
  assert.equal(Boolean(disabled()),true);
  assert.match(page.text(),/couldn.t refresh|needs an update/i);
  assert.doesNotMatch(page.text(),/host.*down|is unreachable/i);
  assert.equal(JSON.parse(localStorage.getItem('faravan-compose-draft:'+CIRCLE.id)).prompt,'Send one job');
  failure = false;
  await advance(15000,15000);
  assert.equal(Boolean(disabled()),false);
});


test('a routine circle refresh keeps confirmed Send readiness while its response is pending', async () => {
  let reads = 0, finish;
  const state = {circle:CIRCLE.id,networked:true,host:{reachable:true,label:'Host'},lenders:[],runRequestSupported:false};
  const api = createFakeApi();
  api.get = async path => {
    if (path === 'folders?path=') return {home:''};
    if (++reads === 1) return state;
    return new Promise(resolve => { finish = () => resolve(state); });
  };
  const page = await mount(h(Compose,{circles:[CIRCLE],circle:CIRCLE.id,api,refresh:()=>{},setCircle:()=>{}}));
  const disabled = () => page.button('Send').disabled || page.button('Send').getAttribute('aria-disabled') === 'true';
  assert.equal(Boolean(disabled()),false);
  await advance(15000,15000);
  try {
    assert.equal(reads,2);
    assert.equal(Boolean(disabled()),false,'an ordinary pending refresh does not discard the last confirmed response');
    assert.doesNotMatch(page.text(),/Checking circle details/);
  } finally { finish?.(); await advance(1,1); }
});

test('F1 navigating away never says a deferred send was cancelled', async () => {
  const api=createFakeApi(), calls=[]; let accept;
  api.get=async path=>path==='folders?path='?{home:''}:{circle:CIRCLE.id,lenders:[],runRequestSupported:false};
  api.post=async (path,body)=>{calls.push(body);return new Promise(resolve=>{accept=resolve;});};
  const page=await mount(h(Compose,{circles:[CIRCLE],circle:CIRCLE.id,api,refresh(){},setCircle(){}}));
  await click(page.button('Send'));
  assert.match(page.text(),/Leaving this page does not cancel the request/);
  assert.ok(page.button('Back to jobs'));
  await click(page.button('Back to jobs'));
  assert.equal(calls.length,1);
  assert.equal(JSON.parse(localStorage.getItem('faravan-compose-draft:'+CIRCLE.id)).id,DRAFT_ID);
  await page.unmount();
  accept({jobDigest:'sha256:'+'a'.repeat(64)});
  await advance(1,1);
  assert.equal(calls.length,1);
});
test('F2 a busy retry keeps every control locked and resends the original body', async () => {
  const api=createFakeApi(), calls=[];
  api.get=async path=>path==='folders?path='?{home:''}:{circle:CIRCLE.id,lenders:[],runRequestSupported:false};
  api.post=async (path,body)=>{calls.push(structuredClone(body));if(calls.length===1)throw Object.assign(new Error('busy'),{code:'rate_limited',outcome:'not_applied'});return {jobDigest:'sha256:'+'b'.repeat(64)};};
  const page=await mount(h(Compose,{circles:[CIRCLE],circle:CIRCLE.id,api,refresh(){},setCircle(){throw new Error('must stay locked');}}));
  await click(page.button('Send'));
  assert.match(page.text(),/Waiting to send…/);
  for(const selector of ['#cmp-prompt','[aria-label="Circle"]','[aria-label="Agent"]'])assert.equal(page.$(selector).disabled,true);
  await advance(2000,2000);
  assert.equal(calls.length,2);
  assert.deepEqual(calls[1],calls[0]);
});
test('F3 failed persistence blocks a first send before any network side effect', async () => {
  const api=createFakeApi();let posts=0;
  api.get=async path=>path==='folders?path='?{home:''}:{circle:CIRCLE.id,lenders:[],runRequestSupported:false};
  api.post=async()=>{posts++;return {};};
  const page=await mount(h(Compose,{circles:[CIRCLE],circle:CIRCLE.id,api,refresh(){},setCircle(){}}));
  // Replace the global storage reference, not a named property on a Storage proxy.
  const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  const storage=globalThis.localStorage;
  const unavailable={
    getItem:key=>storage.getItem(key),
    setItem:()=>{throw new Error('quota');},
    removeItem:key=>storage.removeItem(key),
  };
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:unavailable});
  try {
    assert.equal(globalThis.localStorage,unavailable,'the persistence fault is installed');
    assert.throws(()=>localStorage.setItem('fixture-probe','value'),/quota/);
    await click(page.button('Send'));
    assert.equal(posts,0);
    assert.match(page.text(),/couldn’t save your draft/);
    assert.doesNotMatch(page.text(),/Your draft is kept/);
  } finally {
    if(original)Object.defineProperty(globalThis,'localStorage',original);
    else delete globalThis.localStorage;
  }
});
test('F7 manual circle retry shares the in-flight guard with automatic refresh', async () => {
  const api=createFakeApi();let reads=0, finish;
  api.get=async path=>{if(path==='folders?path=')return {home:''};reads++;if(reads===1)throw new Error('unavailable');return new Promise(resolve=>{finish=resolve;});};
  const page=await mount(h(Compose,{circles:[CIRCLE],circle:CIRCLE.id,api,refresh(){},setCircle(){}}));
  assert.match(page.text(),/retries every 15 seconds/);
  await click(page.button('Check again'));
  await click(page.button('Check again'));
  assert.equal(reads,2);
  finish({circle:CIRCLE.id,lenders:[],runRequestSupported:false});
  await advance(1,1);
});

for (const ready of [false,true]) for (const mode of ['ok','unrelated','sending','uncertain','metadata-throw','metadata-silent','circle-silent']) {
  test('mounted '+(ready?'ready resend':'timeout recovery')+' preserves drafts and routes to the job circle: '+mode, async () => {
    const {Job}=await import('./jobs.jsx');
    const {loadDraft}=await import('./compose-draft.mjs');
    const storage=globalThis.localStorage, descriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
    const key='faravan-compose-draft:'+CIRCLE.id;
    storage.removeItem(key);
    storage.setItem('faravan-compose-circle','other-circle');
    const otherKey='faravan-compose-draft:other-circle';
    storage.setItem(otherKey,JSON.stringify({id:'other-circle-draft',prompt:'Other circle work',sourceKind:'none'}));
    const otherBefore=storage.getItem(otherKey);
    if(['unrelated','sending','uncertain'].includes(mode))storage.setItem(key,JSON.stringify({
      id:'keep-this-identity',sourceKind:'none',path:'',prompt:mode==='unrelated'?'Unsent unrelated request':'',
      sending:mode==='sending',uncertainSince:mode==='uncertain'?123:null,
    }));
    const before=storage.getItem(key), id='sha256:'+'f'.repeat(64), base='jobs/'+encodeURIComponent(id), query='?circle='+CIRCLE.id;
    const job={job_digest:id,circle:{id:CIRCLE.id},role:'sent',submittedByMe:true,sourceKind:'none',
      state:ready?'result-accepted':'failed',result_digest:ready?'sha256:'+'e'.repeat(64):undefined,
      local:{sourceKind:'none',prompt:'Original timed out task',submittedAt:new Date(START).toISOString()},
      current_attempt:ready?null:{state:'failed',reason:{code:'wall_timeout',phase:'run'}}};
    const api=createFakeApi({
      [base+query]:job,
      [base+'/changes'+query]:{format:'message',message:{markdown:'Returned answer'},files:[]},
    });
    let dialog;
    const page=await mount(h(Job,{id,requestedCircle:CIRCLE.id,circle:'other-circle',circles:[CIRCLE],
      api,data:{jobs:[],circles:[CIRCLE],devices:{}},revision:0,draft:{},members:[],refresh(){},mutate(){},
      setDialog:value=>{dialog=typeof value==='function'?value(dialog):value;}}));
    await api.release();await api.release();
    const action=page.button(ready?'Send again…':'Prepare another request…');
    assert.ok(action,'the actual job page exposes its recovery action');
    const faulty={getItem:key=>storage.getItem(key),removeItem:key=>storage.removeItem(key),setItem(k,value) {
      if(k===key && mode==='metadata-throw')throw new Error('quota');
      if(k===key && mode==='metadata-silent')return;
      if(k==='faravan-compose-circle' && mode==='circle-silent')return;
      storage.setItem(k,value);
    }};
    Object.defineProperty(globalThis,'localStorage',{configurable:true,value:faulty});
    try {
      await click(action);
      assert.equal(dialog.confirmLabel,'Prepare a new request');
      assert.equal(location.hash,'#/borrow','opening the action does not navigate');
      if(mode==='ok') {
        dialog.onConfirm();
        assert.equal(location.hash,'#/new');
        assert.equal(storage.getItem('faravan-compose-circle'),CIRCLE.id);
        const restored=loadDraft(storage,CIRCLE.id);
        assert.equal(restored.prompt,'Original timed out task');
        assert.equal(restored.sourceKind,'none');
        assert.equal(restored.sending,false);
      } else {
        assert.throws(()=>dialog.onConfirm(),mode==='circle-silent'?/select its circle/:
          mode.startsWith('metadata')?/save the new request/:/saved or pending request/);
        assert.equal(location.hash,'#/borrow');
        assert.equal(storage.getItem('faravan-compose-circle'),'other-circle');
        if(mode!=='circle-silent')assert.equal(storage.getItem(key),before);
        else assert.equal(loadDraft(storage,CIRCLE.id).prompt,'Original timed out task');
      }
      assert.equal(storage.getItem(otherKey),otherBefore,'never touch the selected other-circle request');
    } finally {
      Object.defineProperty(globalThis,'localStorage',descriptor);
      await page.unmount();
    }
  });
}

for (const mode of ['plain','pending','uncertain','refused','malformed','unreadable']) {
  test('R1 changing to a circle with its own request keeps both requests: '+mode, async () => {
    const other={...CIRCLE,id:'circle-2',name:'Other'}, key='faravan-compose-draft:'+other.id;
    const storage=localStorage, descriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
    const saved={id:'destination-original-id',prompt:'Keep B',sourceKind:'none',
      sending:mode==='pending'||mode==='uncertain',uncertainSince:mode==='uncertain'?START:null,
      agentRefusal:mode==='refused'?{label:'Agent',message:'Unavailable'}:null};
    storage.setItem(key,mode==='malformed'?'not-json':JSON.stringify(saved));
    const api=createFakeApi(), selected=[];
    api.get=async path=>path==='folders?path='?{home:''}:{circle:path.includes(other.id)?other.id:CIRCLE.id,lenders:[],runRequestSupported:false};
    const page=await mount(h(Compose,{circles:[CIRCLE,other],circle:CIRCLE.id,api,refresh(){},setCircle:id=>selected.push(id)}));
    const currentKey='faravan-compose-draft:'+CIRCLE.id, a=loadDraft(storage,CIRCLE.id);
    if(mode==='unreadable')Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{
      getItem(k){if(k===key)throw new Error('Destination unreadable');return storage.getItem(k);},
      setItem:(k,v)=>storage.setItem(k,v),removeItem:k=>storage.removeItem(k),
    }});
    try {
      await act(()=>{const select=page.$('[aria-label="Circle"]');select.value=other.id;select.dispatchEvent(new Event('change',{bubbles:true}));});
      await advance(1,1);
      const kept=loadDraft(storage,CIRCLE.id);
      assert.equal(kept.id,a.id,'A keeps its send identity');
      assert.equal(kept.prompt,'Send one job','A keeps its typed work');
      if(mode==='unreadable'){
        assert.deepEqual(selected,[],'an unreadable destination is refused before selection changes');
        assert.equal(page.$('#cmp-prompt').value,'Send one job');
        assert.match(page.text(),/Couldn’t open that circle’s saved request/);
        return;
      }
      assert.deepEqual(selected,[other.id]);
      if(mode==='malformed'){assert.equal(page.$('#cmp-prompt'),null,'a malformed recovery record must not start fresh');assert.ok(page.button('Retry'));assert.equal(storage.getItem(key),'not-json');return;}
      const b=loadDraft(storage,other.id);
      assert.equal(b.id,'destination-original-id','B and its recovery identity are untouched');
      assert.equal(b.prompt,'Keep B');
      assert.equal(page.$('#cmp-prompt').value,'Keep B','B opens with its own request');
    } finally {Object.defineProperty(globalThis,'localStorage',descriptor);}
  });
}

test('R1 changing to an empty circle moves the request with a new send identity', async () => {
  const other={...CIRCLE,id:'circle-2',name:'Other'}, api=createFakeApi(), selected=[];
  api.get=async path=>path==='folders?path='?{home:''}:{circle:path.includes(other.id)?other.id:CIRCLE.id,lenders:[],runRequestSupported:false};
  const page=await mount(h(Compose,{circles:[CIRCLE,other],circle:CIRCLE.id,api,refresh(){},setCircle:id=>selected.push(id)}));
  const a=loadDraft(localStorage,CIRCLE.id);
  await act(()=>{const select=page.$('[aria-label="Circle"]');select.value=other.id;select.dispatchEvent(new Event('change',{bubbles:true}));});
  await advance(1,1);
  assert.deepEqual(selected,[other.id]);
  assert.equal(localStorage.getItem('faravan-compose-draft:'+CIRCLE.id),null,'nothing stays behind in A');
  assert.equal(page.$('#cmp-prompt').value,'Send one job','the typed work follows the destination');
  const b=loadDraft(localStorage,other.id);
  assert.equal(b.prompt,'Send one job');
  assert.notEqual(b.id,a.id,'a new destination gets a new send identity');
  assert.equal(b.attachmentId,a.attachmentId);
});

test('R2 late original success preserves a newer draft after accepted same-id retry', async () => {
  const api=createFakeApi(), calls=[];let originalAccept;
  api.get=async path=>path==='folders?path='?{home:''}:{circle:CIRCLE.id,lenders:[],runRequestSupported:false};
  api.post=async (path,body)=>{
    calls.push(structuredClone(body));
    if(calls.length===1)return new Promise(resolve=>{originalAccept=resolve;});
    return {jobDigest:'sha256:'+'c'.repeat(64)};
  };
  const props={circles:[CIRCLE],circle:CIRCLE.id,api,refresh(){},setCircle(){}};
  const original=await mount(h(Compose,props));
  await click(original.button('Send'));
  await original.unmount();
  const retry=await mount(h(Compose,props));
  await advance(3000,3000);
  assert.equal(calls.length,2);
  assert.deepEqual(calls[1],calls[0]);
  await retry.unmount();
  const newer=await mount(h(Compose,props));
  await act(()=>{const prompt=newer.$('#cmp-prompt');prompt.value='Keep newer N';prompt.dispatchEvent(new Event('input',{bubbles:true}));});
  await advance(1,1);
  const key='faravan-compose-draft:'+CIRCLE.id, before=localStorage.getItem(key), next=JSON.parse(before);
  assert.notEqual(next.id,DRAFT_ID);
  originalAccept({jobDigest:'sha256:'+'c'.repeat(64)});
  await advance(1,1);
  assert.equal(localStorage.getItem(key),before);
  await newer.unmount();
  const reopened=await mount(h(Compose,props));
  assert.equal(reopened.$('#cmp-prompt').value,'Keep newer N');
  assert.equal(loadDraft(localStorage,CIRCLE.id).id,next.id);
});

test('R2 completion cleanup refuses different malformed and unreadable records', () => {
  const {clearDraftIfCurrent} = draftStorage;
  const key='faravan-compose-draft:'+CIRCLE.id;
  for(const raw of [JSON.stringify({id:'newer-draft-id',attachmentId:'shared-bytes'}),'not-json']) {
    localStorage.setItem(key,raw);
    assert.equal(clearDraftIfCurrent(localStorage,CIRCLE.id,DRAFT_ID),false);
    assert.equal(localStorage.getItem(key),raw);
  }
  assert.equal(clearDraftIfCurrent({getItem(){throw new Error('unreadable');},removeItem(){assert.fail('must not delete');}},CIRCLE.id,DRAFT_ID),false);
  localStorage.setItem(key,JSON.stringify({id:DRAFT_ID}));
  assert.equal(clearDraftIfCurrent(localStorage,CIRCLE.id,DRAFT_ID),true);
  assert.equal(localStorage.getItem(key),null);
});

const r3Other={...CIRCLE,id:'circle-r3',name:'R3'};
const r3Key=id=>'faravan-compose-draft:'+id;
const r3Api=()=>{const api=createFakeApi();api.get=async path=>path==='folders?path='?{home:''}:{circle:path.includes(r3Other.id)?r3Other.id:CIRCLE.id,lenders:[]};return api;};
const r3Select=async(page,id)=>{await act(()=>{const select=page.$('[aria-label="Circle"]');select.value=id;select.dispatchEvent(new Event('change',{bubbles:true}));});await advance(1,1);};

for(const mode of ['destination-readback','source-throw','source-noop']) test('R3 mounted failed move keeps source and rolls back destination: '+mode,async()=>{
  const storage=localStorage,descriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage'), selected=[];
  const props={circles:[CIRCLE,r3Other],circle:CIRCLE.id,api:r3Api(),refresh(){},setCircle:id=>selected.push(id)};
  const page=await mount(h(Compose,props)),before=storage.getItem(r3Key(CIRCLE.id));
  let written=false,failed=false;
  const faulty={
    getItem(k){if(mode==='destination-readback'&&written&&!failed&&k===r3Key(r3Other.id)){failed=true;throw new Error('raw disk error');}return storage.getItem(k);},
    setItem(k,v){storage.setItem(k,v);if(k===r3Key(r3Other.id))written=true;},
    removeItem(k){if(k===r3Key(CIRCLE.id)&&mode==='source-throw')throw new Error('remove fault');if(k===r3Key(CIRCLE.id)&&mode==='source-noop')return;storage.removeItem(k);},
  };
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:faulty});
  try{
    await r3Select(page,r3Other.id);
    assert.deepEqual(selected,[]);
    assert.equal(storage.getItem(r3Key(CIRCLE.id)),before);
    assert.equal(storage.getItem(r3Key(r3Other.id)),null);
    assert.match(page.text(),/We couldn't confirm the move/);
    assert.match(page.text(),/Your request is still in this circle/);
    assert.match(page.text(),/Don't send it from the other circle/);
    assert.equal(page.$('#cmp-prompt').readOnly,true);
    assert.doesNotMatch(page.text(),/raw disk error|remove fault/);
  }finally{Object.defineProperty(globalThis,'localStorage',descriptor);}
  await page.unmount();
  const reopened=await mount(h(Compose,props));
  assert.equal(reopened.$('#cmp-prompt').value,'Send one job');
  assert.equal(loadDraft(storage,CIRCLE.id).id,DRAFT_ID);
});

test('R3 mounted stale source refuses move without erasing newer recovery identity',async()=>{
  const selected=[],page=await mount(h(Compose,{circles:[CIRCLE,r3Other],circle:CIRCLE.id,api:r3Api(),refresh(){},setCircle:id=>selected.push(id)}));
  const newer=JSON.stringify({id:'newer-source-r3',prompt:'Keep newer pending work',sending:true,attachmentId:'seeded-attachment-r3'});
  localStorage.setItem(r3Key(CIRCLE.id),newer);
  await r3Select(page,r3Other.id);
  assert.deepEqual(selected,[]);
  assert.equal(localStorage.getItem(r3Key(CIRCLE.id)),newer);
  assert.equal(localStorage.getItem(r3Key(r3Other.id)),null);
  assert.match(page.text(),/The saved request no longer matches this page/);
});

test('R3 mount read failure after selection preserves exact pending record and Retry',async()=>{
  const storage=localStorage,descriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  const raw=JSON.stringify({id:'destination-pending-r3',prompt:'Keep pending B',sending:true,sourceKind:'none'});
  storage.setItem(r3Key(r3Other.id),raw);
  const page=await mount(h(Compose,{circles:[CIRCLE,r3Other],circle:CIRCLE.id,api:r3Api(),refresh(){},setCircle(){}}));
  let reads=0;
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{
    getItem(k){if(k===r3Key(r3Other.id)&&++reads===2)throw new Error('raw restore error');return storage.getItem(k);},
    setItem:(k,v)=>storage.setItem(k,v),removeItem:k=>storage.removeItem(k),
  }});
  try{
    await r3Select(page,r3Other.id);
    assert.equal(storage.getItem(r3Key(r3Other.id)),raw);
    assert.equal(page.$('#cmp-prompt'),null);
    assert.ok(page.button('Retry'));
    assert.doesNotMatch(page.text(),/raw restore error/);
    await click(page.button('Retry'));
    assert.equal(page.$('#cmp-prompt').value,'Keep pending B');
    assert.equal(loadDraft(storage,r3Other.id).id,'destination-pending-r3');
  }finally{Object.defineProperty(globalThis,'localStorage',descriptor);}
});

// Metadata-level attachment assertions deliberately do not claim IndexedDB byte coverage.
for(const mode of ['readback','remove-throw','remove-noop','rollback-throw','newer-source']) test('R3 seeded attachment metadata ownership: '+mode,()=>{
  const map=new Map(),key=r3Key(CIRCLE.id),to=r3Key(r3Other.id);
  const source={id:DRAFT_ID,prompt:'Seeded work',attachmentId:'seeded-attachment-r3',sourceKind:'files'};
  const raw=JSON.stringify(source);map.set(key,raw);let written=false,failed=false;
  const storage={
    getItem(k){if(mode==='readback'&&written&&!failed&&k===to){failed=true;throw new Error('readback');}return map.get(k)??null;},
    setItem(k,v){map.set(k,v);if(k===to)written=true;},
    removeItem(k){if(k===key&&['remove-throw','rollback-throw'].includes(mode))throw new Error('remove');if(k===key&&mode==='remove-noop')return;if(k===to&&mode==='rollback-throw')throw new Error('rollback');map.delete(k);},
  };
  if(mode==='newer-source')map.set(key,JSON.stringify({...source,id:'newer-source-r3',sending:true}));
  const before=map.get(key),result=draftStorage.moveDraft(storage,CIRCLE.id,r3Other.id,source);
  assert.equal(map.get(key),before);
  assert.equal(JSON.parse(map.get(key)).attachmentId,'seeded-attachment-r3');
  if(mode==='rollback-throw'){
    assert.equal(result.state,'unconfirmed');assert.equal(result.rolledBack,false);
    assert.equal(JSON.parse(map.get(to)).attachmentId,'seeded-attachment-r3');
  }else assert.equal(map.has(to),false);
});

test('R3 strict restore does not turn unreadable or malformed metadata into fresh work',()=>{
  for(const storage of [{getItem(){throw new Error('disk');}},{getItem(){return 'not-json';}}]){
    assert.equal(draftStorage.restoreDraft(storage,CIRCLE.id).draft,undefined);
  }
  assert.equal(draftStorage.restoreDraft({getItem(){return null;}},CIRCLE.id).state,'absent');
});

for (const mode of ['false', 'unknown']) test('R3 mounted unconfirmed move does not claim a retained source: '+mode, async () => {
  const storage=localStorage, descriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  const sourceKey=r3Key(CIRCLE.id), destinationKey=r3Key(r3Other.id), selected=[], api=r3Api();
  const page=await mount(h(Compose,{circles:[CIRCLE,r3Other],circle:CIRCLE.id,api,refresh(){},setCircle:id=>selected.push(id)}));
  let removed=false, verificationFailed=false;
  const faulty={
    getItem(key){
      if(key===sourceKey && removed && (mode==='unknown' || !verificationFailed)){
        verificationFailed=true;
        throw new Error('source verification unavailable');
      }
      return storage.getItem(key);
    },
    setItem(key,value){
      // Restoration cannot persist. Keep the real destination recovery copy.
      if(key===sourceKey && removed)return;
      storage.setItem(key,value);
    },
    removeItem(key){storage.removeItem(key);if(key===sourceKey)removed=true;},
  };
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:faulty});
  try{
    await r3Select(page,r3Other.id);
    assert.equal(removed,true,'the source removal committed before its verification failed');
    assert.equal(verificationFailed,true,'the unconfirmed path was exercised');
    assert.equal(storage.getItem(sourceKey),null,'the old source copy is not present');
    const destination=JSON.parse(storage.getItem(destinationKey));
    assert.equal(destination.prompt,'Send one job','the sole recovery copy survives');
    assert.notEqual(destination.id,DRAFT_ID);
    assert.deepEqual(selected,[],'uncertainty does not navigate');
    assert.match(page.text(),/couldn't confirm the move or where your request is saved/);
    assert.match(page.text(),/copy your request before leaving/);
    assert.match(page.text(),/Check the saved requests in both circles before sending anything/);
    assert.doesNotMatch(page.text(),/Your request is still in this circle|Don't send it from the other circle|source verification unavailable/);
    assert.equal(page.$('#cmp-prompt').value,'Send one job','the visible request remains available to copy');
    assert.equal(page.$('#cmp-prompt').readOnly,true,'the request cannot be edited');
    assert.equal(page.$('#cmp-prompt').disabled,false,'keyboard users can still focus, select and copy the request');
    const send=page.button('Send');
    assert.ok(send);
    assert.equal(Boolean(send.disabled || send.getAttribute('aria-disabled')==='true'),true);
    assert.equal(api.posts.length,0);
  }finally{Object.defineProperty(globalThis,'localStorage',descriptor);}
});

for (const id of [undefined, 'short', 123]) test('R3 mounted valid JSON with invalid request ID stays recoverable: '+String(id), async () => {
  const key=r3Key(CIRCLE.id), raw=JSON.stringify({id,prompt:'Keep malformed recovery work',sourceKind:'none'});
  localStorage.setItem(key,raw);
  const api=r3Api(), page=await mount(h(Compose,{circles:[CIRCLE],circle:CIRCLE.id,api,refresh(){},setCircle(){}}));
  assert.equal(page.$('#cmp-prompt'),null,'do not mount a fresh autosaving composer');
  assert.ok(page.button('Retry'));
  assert.match(page.text(),/saved request could not be restored\. It has been kept unchanged/);
  assert.equal(localStorage.getItem(key),raw);
  await click(page.button('Retry'));
  assert.equal(page.$('#cmp-prompt'),null);
  assert.equal(localStorage.getItem(key),raw,'retry must not replace invalid-ID JSON');
  assert.equal(api.posts.length,0);
});
