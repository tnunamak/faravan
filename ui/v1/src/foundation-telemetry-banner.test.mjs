import {mount, teardown, resetPage, flush, act, click, createFakeApi} from './mounted.test-helper.mjs';
import test, {beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {FirstRunCard, PrivacyCard} from './telemetry-ui.jsx';
import {telemetryStore, createTelemetryStore} from './telemetry-store.mjs';

const pending=()=>({level:null,effective:'off',reason:{kind:'default'},uploadable:true,notice:{pending:true},recordings:false});
const enabled=()=>({...pending(),effective:'on',notice:{pending:false}});
const off=()=>({...pending(),level:'off',effective:'off',reason:{kind:'choice'},notice:{pending:false}});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
let observers,originalObserver,visibilityDescriptor;
class Observer {
  constructor(callback){this.callback=callback;this.targets=new Set();this.disconnected=false;observers.push(this);}
  observe(target){this.targets.add(target);}
  unobserve(target){this.targets.delete(target);}
  disconnect(){this.disconnected=true;this.targets.clear();}
  emit(target,isIntersecting=true){this.callback([{target,isIntersecting}]);}
}
function visible(value){
  Object.defineProperty(document,'visibilityState',{configurable:true,value});
  document.dispatchEvent(new Event('visibilitychange'));
}
function geometry(node,onscreen=true){
  node.getBoundingClientRect=()=>onscreen?{top:10,left:10,bottom:50,right:300,width:290,height:40}
    :{top:10000,left:10,bottom:10040,right:300,width:290,height:40};
}
const active=()=>observers.findLast(observer=>!observer.disconnected);
beforeEach(()=>{
  resetPage();telemetryStore.set(null);observers=[];
  originalObserver=Object.getOwnPropertyDescriptor(globalThis,'IntersectionObserver');
  visibilityDescriptor=Object.getOwnPropertyDescriptor(document,'visibilityState');
  Object.defineProperty(globalThis,'IntersectionObserver',{configurable:true,writable:true,value:Observer});
  visible('visible');
});
afterEach(async()=>{
  await teardown();telemetryStore.set(null);
  if(originalObserver)Object.defineProperty(globalThis,'IntersectionObserver',originalObserver);
  else delete globalThis.IntersectionObserver;
  if(visibilityDescriptor)Object.defineProperty(document,'visibilityState',visibilityDescriptor);
  else delete document.visibilityState;
});

test('actual quiet notice requires connection, current geometry, visibility and fresh intersection; acknowledges once',async()=>{
  const api=createFakeApi({'telemetry/notice':enabled()});
  telemetryStore.set(pending());
  const card=await mount(h(FirstRunCard,{api}));
  const notice=card.$('aside[role="status"]');assert.ok(notice);
  assert.equal(notice.getAttribute('aria-label'),'Usage reports');
  assert.equal(card.$('[role="dialog"],[aria-modal="true"],dialog,[role="alert"]'),null);
  assert.equal(card.$$('button[disabled]').length,0);
  const observer=active();assert.ok(observer);assert.equal(api.posts.length,0);
  geometry(notice,false);await act(()=>observer.emit(notice));
  assert.equal(api.posts.length,0,'intersection alone is not visible geometry');
  geometry(notice);await act(()=>visible('hidden'));await act(()=>observer.emit(notice));
  assert.equal(api.posts.length,0,'hidden document cannot acknowledge');
  await act(()=>visible('visible'));assert.equal(api.posts.length,0,'visibility requires fresh entry');
  const parent=notice.parentNode;notice.remove();await act(()=>observer.emit(notice));
  assert.equal(api.posts.length,0,'disconnected notice cannot acknowledge');
  parent.append(notice);await act(()=>observer.emit(notice));await flush();
  assert.equal(api.postsOf('telemetry/notice').length,1);
  await act(()=>observer.emit(notice));await card.rerender(h(FirstRunCard,{api}));
  assert.equal(api.postsOf('telemetry/notice').length,1);
  await card.unmount();assert.ok(observer.disconnected);
  await act(()=>{observer.emit(notice);visible('visible');});
  assert.equal(api.postsOf('telemetry/notice').length,1,'late observer callback is fenced');
});

test('dismissal and unmount before observation never acknowledge',async()=>{
  const api=createFakeApi({'telemetry/notice':enabled()});telemetryStore.set(pending());
  const card=await mount(h(FirstRunCard,{api}));
  const notice=card.$('aside'),observer=active();geometry(notice);
  await click(card.$('button'));await act(()=>observer.emit(notice));await flush();
  assert.equal(api.posts.length,0);assert.ok(observer.disconnected);
  await card.unmount();
  const again=await mount(h(FirstRunCard,{api}));assert.equal(again.$('aside'),null);
  assert.equal(api.posts.length,0,'durable browser dismissal is not server consent');
  await again.unmount();localStorage.clear();
  const fresh=await mount(h(FirstRunCard,{api}));
  const oldNotice=fresh.$('aside'),oldObserver=active();geometry(oldNotice);
  await fresh.unmount();await act(()=>oldObserver.emit(oldNotice));
  assert.equal(api.posts.length,0);
});

test('unavailable destination and absent observer fail closed without notice POST',async()=>{
  const api=createFakeApi();telemetryStore.set({...pending(),uploadable:false});
  const card=await mount(h(FirstRunCard,{api}));
  assert.equal(card.$('aside'),null);assert.equal(api.posts.length,0);
  globalThis.IntersectionObserver=undefined;telemetryStore.set(pending());await flush();
  assert.ok(card.$('aside'));assert.equal(api.posts.length,0);
});

test('late notice response cannot replace explicit OFF; mounted privacy choice and reload stay OFF',async()=>{
  const noticeReply=deferred(),api=createFakeApi({'telemetry/notice':noticeReply.promise,'telemetry/choose':off()});
  telemetryStore.set(pending());
  const card=await mount(h(FirstRunCard,{api}));
  const node=card.$('aside');geometry(node);await act(()=>active().emit(node));
  assert.equal(api.postsOf('telemetry/notice').length,1);
  await act(()=>telemetryStore.post(api,'telemetry/choose',{level:'off'}));
  assert.equal(telemetryStore.get().level,'off');
  await act(()=>noticeReply.resolve(enabled()));await flush();
  assert.equal(telemetryStore.get().level,'off','older notice answer must not overwrite newer explicit choice');
  await card.rerender(h(FirstRunCard,{api}));assert.equal(card.$('aside'),null);
  await card.unmount();
  const privacy=await mount(h(PrivacyCard,{api}));
  await api.answer('telemetry',off());
  assert.equal(privacy.$('input[value="off"]').checked,true);
  await privacy.unmount();
  // Page restart is represented by a fresh store loading an authoritative saved OFF DTO.
  const restarted=createTelemetryStore(),restartApi=createFakeApi();
  const loading=restarted.load(restartApi);await restartApi.answer('telemetry',off());await loading;
  assert.equal(restarted.get().level,'off');
});

test('store fences older loads and notice replies across OFF, reset-ID and pending purge responses',async()=>{
  const store=createTelemetryStore(),api=createFakeApi(),noticeReply=deferred(),resetReply=deferred();
  api.table['telemetry/notice']=noticeReply.promise;
  api.table['telemetry/choose']=off();
  api.table['telemetry/reset-id']=resetReply.promise;
  const observed=[],unsubscribe=store.subscribe(value=>observed.push(value));
  store.set(pending());
  const oldLoad=store.load(api),notice=store.post(api,'telemetry/notice');
  await store.post(api,'telemetry/choose',{level:'off'});
  const resetting=store.post(api,'telemetry/reset-id');
  // Reset and purge are server operations; the fixture supplies their OFF response,
  // it does not claim to execute backend deletion or alter actual telemetry queues.
  await api.answer('telemetry',enabled());await oldLoad;
  noticeReply.resolve(enabled());await notice;
  assert.equal(store.get().level,'off');
  resetReply.resolve(off());await resetting;
  assert.equal(store.get().level,'off');
  const afterOff=observed.findIndex(value=>value?.level==='off');
  assert.ok(afterOff>=0);assert.ok(observed.slice(afterOff).every(value=>value.level==='off'));
  unsubscribe();const length=observed.length;store.set(off());assert.equal(observed.length,length);
});

test('saved OFF and restricted DTOs render no active consent or blocking modal across remounts',async()=>{
  for(const state of [
    off(),
    {...off(),reason:{kind:'env',env:'DO_NOT_TRACK'}},
  ]){
    telemetryStore.set(state);const api=createFakeApi();
    const card=await mount(h(FirstRunCard,{api}));
    assert.equal(card.$('aside,dialog,[aria-modal="true"]'),null);
    assert.equal(api.posts.length,0);await card.unmount();
    const privacy=await mount(h(PrivacyCard,{api}));
    await api.answer('telemetry',state);
    assert.equal(privacy.$('input[value="off"]').checked,true);
    if(state.reason.kind==='env')assert.equal(privacy.$('fieldset').disabled,true);
    await privacy.unmount();
  }
});

test('read begun during OFF write cannot publish its stale default after the write finishes',async()=>{
  const store=createTelemetryStore(),api=createFakeApi(),reply=deferred();
  store.set(enabled());api.table['telemetry/choose']=reply.promise;
  const saving=store.post(api,'telemetry/choose',{level:'off'});
  const loading=store.load(api);
  reply.resolve(off());await saving;
  await api.answer('telemetry',enabled());await loading;
  assert.equal(store.get().level,'off');
});
