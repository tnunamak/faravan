import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {AppLifetime} from '../lib/v1/app-lifetime.mjs';
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const flush=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
test('stop seals synchronously, fences late publication, and shares reentrant promise',async()=>{
  const owner=new AppLifetime(),blocked=gate(),log=[];
  let reentrant;
  const handle=owner.register('updates','producer',{seal:()=>{reentrant=owner.stop('again');}});
  const work=handle.run(async()=>{await blocked.promise;handle.commit(()=>log.push('late'));});
  const rejected=assert.rejects(work,{code:'app_closing'});
  const stopping=owner.stop('quit');
  assert.equal(stopping,reentrant);assert.equal(owner.stop('quit'),stopping);
  await assert.rejects(handle.run(()=>{}),{code:'app_closing'});
  blocked.resolve();await rejected;
  assert.equal((await stopping).state,'closed');assert.deepEqual(log,[]);
});
test('one deadline bounds stuck drains, keeps lock, and releases independent resources',async()=>{
  let now=0;const timers=new Map(),log=[];
  const owner=new AppLifetime({now:()=>now,setTimer:(fn,ms)=>{const key={};timers.set(key,{fn,at:now+ms});return key;},clearTimer:key=>timers.delete(key)});
  owner.register('lock','lock',{release:()=>log.push('lock')});
  owner.register('settings','consumer',{release:()=>log.push('settings')});
  owner.register('updates','producer',{drain:()=>new Promise(()=>{}),release:()=>log.push('updates')});
  let result;const closing=owner.stop('quit').then(value=>{result=value;});await flush();
  now=39999;assert.equal(result,undefined);
  now=40000;for(const [key,timer] of timers)if(timer.at<=now){timers.delete(key);timer.fn();}await flush();
  await closing;assert.equal(result.state,'interrupted');assert.deepEqual(result.unfinished,['updates']);
  assert.deepEqual(log,['updates','settings']);assert.equal(timers.size,0);
});
test('startup unwind preserves acquisition order within dependency phases',async()=>{
  for(let failAt=0;failAt<4;failAt++) {
    const owner=new AppLifetime(),log=[],original=new Error('startup');
    const names=['lock','sessions','transport','updater'];
    let caught;
    try {for(let i=0;i<=failAt;i++){const name=names[i];owner.register(name,i===0?'lock':i===1?'consumer':'producer',{release:()=>log.push(name)});if(i===failAt)throw original;}}
    catch(error){await owner.stop('startup_failed');caught=error;}
    assert.equal(caught,original);assert.deepEqual(log,names.slice(0,failAt+1).reverse());
  }
});

test('refusal cancels its attempt, releases updater admission, and allows a fresh attempt',async()=>{
  const owner=new AppLifetime(),updates=owner.register('updater','producer',{blockedByHold:true}),blocked=gate();
  let writes=0;
  const first=owner.register('Quit attempt','producer',{provisional:true});
  const work=first.run(async()=>{await blocked.promise;first.commit(()=>{writes++;});});
  const rejected=assert.rejects(work,{code:'app_closing'});
  await assert.rejects(updates.run(()=>{}),{code:'app_quitting'});
  first.cancel();assert.equal(await updates.run(()=> 'idle'),'idle');
  const retry=owner.register('Quit attempt','producer',{provisional:true});
  assert.throws(()=>updates.commit(()=>{}),{code:'app_quitting'});
  blocked.resolve();await rejected;assert.equal(writes,0);
  retry.cancel();assert.equal(updates.commit(()=> 'resumed'),'resumed');
  assert.equal((await owner.stop('quit')).state,'closed');
});

test('proof time is deducted from all phase cutoffs',async()=>{
  let now=30000;const timers=new Map();
  const owner=new AppLifetime({now:()=>now,setTimer:(fn,ms)=>{const key={};timers.set(key,{fn,at:now+ms});return key;},clearTimer:key=>timers.delete(key)});
  owner.register('updates','producer',{drain:()=>new Promise(()=>{})});
  let result;const stop=owner.stop('quit',{startedAt:0}).then(value=>{result=value;});await flush();
  assert.equal([...timers.values()][0].at,40000);
  now=40000;for(const [key,timer] of timers){timers.delete(key);timer.fn();}await stop;
  assert.equal(result.state,'interrupted');assert.deepEqual(result.unfinished,['updates']);
});

test('checkpoint and release use 55 and 60 seconds of the same budget',async()=>{
  let now=0;const timers=new Map(),log=[];
  const owner=new AppLifetime({now:()=>now,setTimer:(fn,ms)=>{const key={};timers.set(key,{fn,at:now+ms});return key;},clearTimer:key=>timers.delete(key)});
  owner.register('lock','lock',{release:()=>log.push('lock')});
  owner.register('checkpoint','consumer',{drain:()=>new Promise(()=>{}),release:()=>new Promise(()=>{})});
  let result;const stop=owner.stop('quit').then(value=>{result=value;});await flush();
  assert.equal([...timers.values()][0].at,55000);
  now=55000;for(const [key,timer] of [...timers])if(timer.at<=now){timers.delete(key);timer.fn();}await flush();
  assert.equal([...timers.values()][0].at,60000);assert.equal(result,undefined);
  now=60000;for(const [key,timer] of [...timers]){timers.delete(key);timer.fn();}await stop;
  assert.equal(result.state,'interrupted');assert.deepEqual(result.unfinished,['checkpoint']);assert.deepEqual(log,[]);
});
