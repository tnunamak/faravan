import {advance,createFakeApi,installClock,mount,resetPage,teardown,flush} from './mounted.test-helper.mjs';
import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {App} from './main.jsx';
afterEach(teardown);
for(const mode of ['up','down','queued'])test('hidden approvals notify before expiry with SSE '+mode,async t=>{
  const offline=mode==='down';
  resetPage('#/circles');installClock();let visibility='visible';
  const original=Object.getOwnPropertyDescriptor(document,'visibilityState');
  Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>visibility});
  const previous=globalThis.Notification,notes=[];
  globalThis.Notification=class {static permission='granted';constructor(title,options){notes.push({title,options});}};
  t.after(()=>{if(original)Object.defineProperty(document,'visibilityState',original);else delete document.visibilityState;if(previous===undefined)delete globalThis.Notification;else globalThis.Notification=previous;});
  const api=createFakeApi({home:{lending:{enabled:true}},readiness:{ready:true,checks:[]},circles:[],agents:[],devices:{fingerprint:'me',circles:[]},approvals:[],activity:[],jobs:[],updates:{}});
  await mount(h(App,{api,takeJoinLink:()=>''}));await api.release();await advance(6000);await api.release();
  if(mode==='queued'){await api.emit('job',{state:'queued',jobDigest:'other'});await api.release();await flush();await api.emit('approval',{id:'expires-hidden',state:'pending'});assert.equal(api.openReads('approvals').length,0,'arrival is throttled before hiding');}
  visibility='hidden';document.dispatchEvent(new Event('visibilitychange'));await flush();
  const optional=api.reads.filter(r=>r.path!=='approvals').length;
  api.table.approvals=[{id:'expires-hidden',jobDigest:'sha256:'+'a'.repeat(64),requester:{name:'Member'},title:'Review request'}];
  if(offline){api.stream.closed=true;api.stream.waiting?.({done:true});api.stream.waiting=null;api.request=async()=>{throw Error('stream offline');};}
  else if(mode!=='queued')await api.emit('approval',{id:'expires-hidden',state:'pending'});
  await advance(6000);await api.release();await flush();
  assert.equal(notes.length,1,'notification arrives while card still exists');
  assert.match(document.title,/1/);
  assert.equal(api.reads.filter(r=>r.path!=='approvals').length,optional,'optional shell reads stay suspended');
  api.table.approvals=[];if(!offline)await api.emit('approval',{id:'expires-hidden',state:'expired'});
  for(let n=0;n<6;n++){await advance(5000);await api.release();await flush();}
  assert.equal(notes.length,1);assert.doesNotMatch(document.title,/\(1\)/);
  visibility='visible';document.dispatchEvent(new Event('visibilitychange'));await advance(6000);await api.release();assert.equal(notes.length,1);
});
