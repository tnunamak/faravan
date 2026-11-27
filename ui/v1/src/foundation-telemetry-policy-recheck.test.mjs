import test from 'node:test';
import assert from 'node:assert/strict';
import {connectBrowserPolicy} from './posthog-policy.mjs';
import {createTelemetryStore} from './telemetry-store.mjs';

const state = generation => ({consent:'on',generation,remoteEnabled:true,noticePending:false});
const settle = async () => { for(let i=0;i<12;i++) await Promise.resolve(); };
function deferred() {
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
function fixture() {
  const store=createTelemetryStore(),reads=[],bootstraps=[];
  let active=0,maxActive=0,cleared=0;
  const api={get(path) {
    assert.equal(path,'telemetry/bootstrap');
    const held=deferred();reads.push(held);
    active++;maxActive=Math.max(maxActive,active);
    return held.promise.finally(()=>{active--;});
  },post:async()=>({effective:'off'})};
  const browser={stop(){},tick(){},connection(){},bootstrap:value=>bootstraps.push(value)};
  const policy=connectBrowserPolicy({api,store,browser,
    setTimer:()=>1,clearTimer:()=>{cleared++;}});
  return {api,store,policy,reads,bootstraps,
    get maxActive(){return maxActive;},get cleared(){return cleared;},
    async dispose() {
      policy.stop();
      for(const read of reads)read.resolve(state(99));
      await settle();
    }};
}

test('mid-read events and store notifications coalesce into one immediate latest read',async()=>{
  const f=fixture();
  try {
    const first=f.policy.check();
    f.policy.event({type:'telemetry'});
    f.store.set({version:2});
    f.policy.event({type:'reset'});
    assert.equal(f.reads.length,1,'never run parallel bootstrap reads');
    f.reads[0].resolve(state(1));
    await first;await settle();
    assert.equal(f.bootstraps.length,0,'invalidated answer never bootstraps');
    assert.equal(f.reads.length,2,'one demanded follow-up without periodic time');
    f.reads[1].resolve(state(2));await settle();
    assert.deepEqual(f.bootstraps,[state(2)]);
    assert.equal(f.reads.length,2,'consumed demand cannot cause another retry');
    assert.equal(f.maxActive,1);
  } finally {await f.dispose();}
});

test('pending writes retain demand but suppress checks until their completion',async()=>{
  const f=fixture(),write=deferred();let writing;
  f.api.post=()=>write.promise;
  try {
    const first=f.policy.check();
    writing=f.store.post(f.api,'telemetry/choose',{level:'off'});
    f.policy.event({type:'telemetry'});
    f.store.set({version:2});
    f.reads[0].resolve(state(1));await first;await settle();
    assert.equal(f.reads.length,1);
    assert.equal(f.bootstraps.length,0);
    write.resolve({effective:'off'});await writing;await settle();
    assert.equal(f.reads.length,2,'subscribe and completion demand coalesce');
    f.reads[1].resolve(state(2));await settle();
    assert.deepEqual(f.bootstraps,[state(2)]);
    assert.equal(f.maxActive,1);
  } finally {
    f.policy.stop();write.resolve({effective:'off'});
    if(writing)await writing;
    await f.dispose();
  }
});

test('stop removes subscriptions and discards demanded follow-up and late capture',async()=>{
  const f=fixture();
  try {
    const first=f.policy.check();
    f.store.set({version:1});
    f.policy.stop();
    f.store.set({version:2});
    await f.store.post(f.api,'telemetry/choose',{level:'on'});
    f.reads[0].resolve(state(2));await first;await settle();
    await f.policy.check();
    assert.equal(f.reads.length,1);
    assert.deepEqual(f.bootstraps,[]);
    assert.equal(f.cleared,1);
  } finally {await f.dispose();}
});

test('read errors alone do not create demand or retry loops',async()=>{
  const f=fixture();
  try {
    const first=f.policy.check();
    f.reads[0].reject(new Error('read failed'));await first;await settle();
    assert.equal(f.reads.length,1);
    const second=f.policy.check();
    f.policy.event({type:'telemetry'});
    f.reads[1].reject(new Error('invalidated read failed'));await second;await settle();
    assert.equal(f.reads.length,3,'one explicitly requested retry');
    f.reads[2].reject(new Error('latest read failed'));await settle();
    assert.equal(f.reads.length,3,'failure does not manufacture another request');
    assert.deepEqual(f.bootstraps,[]);
  } finally {await f.dispose();}
});

test('ambiguous failed OFF fences same generation; independently newer server response may reopen',async()=>{
  const f=fixture();
  try {
    const first=f.policy.check();f.reads[0].resolve(state(5));await first;
    f.api.post=async()=>{throw new Error('connection lost after possible commit');};
    await assert.rejects(f.store.post(f.api,'telemetry/choose',{level:'off'}));
    await settle();assert.equal(f.reads.length,2);
    f.reads[1].resolve(state(5));await settle();
    assert.deepEqual(f.bootstraps,[state(5)],'failed OFF never rolls back local fence');
    f.policy.event({type:'telemetry'});
    assert.equal(f.reads.length,3);
    // This is supplied as an authoritative bootstrap response, not inferred from a browser DTO.
    f.reads[2].resolve(state(6));await settle();
    assert.deepEqual(f.bootstraps,[state(5),state(6)]);
  } finally {await f.dispose();}
});

test('timeout without new demand does not schedule a retry or accept late data',async(t)=>{
  let deadline;
  t.mock.method(globalThis,'setTimeout',callback=>{deadline=callback;return 1;});
  t.mock.method(globalThis,'clearTimeout',()=>{});
  const f=fixture();
  try {
    const first=f.policy.check();
    deadline();
    f.reads[0].resolve(state(1));await first;await settle();
    assert.equal(f.reads.length,1);
    assert.deepEqual(f.bootstraps,[]);
  } finally {await f.dispose();t.mock.restoreAll();}
});
