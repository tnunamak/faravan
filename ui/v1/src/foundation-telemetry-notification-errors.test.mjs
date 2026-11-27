import test from 'node:test';
import assert from 'node:assert/strict';
import {createTelemetryStore} from './telemetry-store.mjs';
import {connectBrowserPolicy} from './posthog-policy.mjs';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function fixture(store=createTelemetryStore()) {
  const bootstraps=[];let reads=0,state={consent:'on',generation:1,remoteEnabled:true,noticePending:false};
  const browser={stop(){},tick(){},connection(){},bootstrap:value=>bootstraps.push(value)};
  const api={get:async()=>{reads++;return {...state};},post:async()=>({effective:'off',version:2})};
  const policy=connectBrowserPolicy({store,api,browser,setTimer:()=>1,clearTimer(){}});
  return {store,api,policy,bootstraps,get reads(){return reads;},set state(value){state=value;}};
}

test('saved OFF survives throwing subscribers and completion notifications',async()=>{
  const store=createTelemetryStore(),response={effective:'off',version:2},seen=[],done=[],offs=[];
  store.set({effective:'on',version:1});
  offs.push(store.subscribe(()=>{throw new Error('subscriber');}));
  offs.push(store.subscribe(value=>seen.push(value)));
  offs.push(store.afterChange(()=>{throw new Error('completion');}));
  offs.push(store.afterChange((path,body,saved)=>done.push({path,body,saved})));
  const f=fixture(store),body={level:'off'};
  try{
    await f.policy.check();
    f.state={consent:'off',generation:2,remoteEnabled:true,noticePending:false};
    f.api.post=async()=>response;
    assert.equal(await store.post(f.api,'telemetry/choose',body),response);
    await flush();
    assert.equal(store.get(),response);assert.deepEqual(seen,[response]);
    assert.deepEqual(done,[{path:'telemetry/choose',body,saved:true}]);
    const count=f.reads;await f.policy.check();assert.equal(f.reads,count+1,'policy is not stuck pending');
  }finally{for(const off of offs)off();f.policy.stop();}
});

test('API rejection remains the original rejection and does not fabricate OFF',async()=>{
  const store=createTelemetryStore(),before={effective:'on'},failure=new Error('API'),saved=[];
  store.set(before);
  const a=store.afterChange(()=>{throw new Error('notification');});
  const b=store.afterChange((_p,_b,ok)=>saved.push(ok));
  const f=fixture(store);
  try{
    await f.policy.check();f.api.post=async()=>{throw failure;};
    await assert.rejects(store.post(f.api,'telemetry/choose',{level:'off'}),error=>error===failure);
    await flush();assert.equal(store.get(),before);assert.deepEqual(saved,[false]);
    assert.equal(f.bootstraps.length,1,'old ON cannot reopen after failed OFF');
    f.state={consent:'on',generation:2,remoteEnabled:true,noticePending:false};
    await f.policy.check();assert.equal(f.bootstraps.at(-1).generation,2);
  }finally{a();b();f.policy.stop();}
});

test('throwing privacy precondition aborts API but releases policy completion',async()=>{
  const f=fixture(),failure=new Error('privacy'),saved=[];let writes=0;
  const guard=f.store.beforeChange(()=>{throw failure;});
  const completed=f.store.afterChange((_p,_b,ok)=>saved.push(ok));
  f.api.post=async()=>{writes++;return {effective:'off'};};
  try{
    await f.policy.check();
    await assert.rejects(f.store.post(f.api,'telemetry/choose',{level:'off'}),error=>error===failure);
    await flush();assert.equal(writes,0);assert.equal(f.store.get(),null);assert.deepEqual(saved,[false]);
    assert.equal(f.bootstraps.length,1,'failed OFF keeps old ON fenced');
    guard();f.state={consent:'on',generation:2,remoteEnabled:true,noticePending:false};
    await f.policy.check();assert.equal(f.bootstraps.at(-1).generation,2);
  }finally{guard();completed();f.policy.stop();}
});

test('a precondition before policy cannot consume another overlapping write completion',async()=>{
  const store=createTelemetryStore(),body={level:'off'},pending=deferred();let rejectNext=false,writes=0;
  const guard=store.beforeChange(()=>{if(rejectNext)throw new Error('guard');});
  const f=fixture(store);
  f.api.post=async()=>{writes++;return pending.promise;};
  try{
    await f.policy.check();
    const first=store.post(f.api,'telemetry/choose',body);
    rejectNext=true;
    await assert.rejects(store.post(f.api,'telemetry/choose',body),/guard/);
    const count=f.reads;await f.policy.check();
    assert.equal(f.reads,count,'first write is still pending even with identical path/body');
    assert.equal(writes,1);
    f.state={consent:'off',generation:2,remoteEnabled:true,noticePending:false};
    pending.resolve({effective:'off'});await first;await flush();
    const after=f.reads;await f.policy.check();assert.equal(f.reads,after+1);
    assert.equal(store.get(),null,'failed last-started write still invalidates first answer');
    rejectNext=false;
  }finally{pending.resolve({effective:'off'});guard();f.policy.stop();}
});

test('late notice/read and overlapping writes keep existing store fences',async()=>{
  const store=createTelemetryStore(),read=deferred(),notice=deferred(),off=deferred(),during=deferred();
  const remove=store.subscribe(()=>{throw new Error('notification');});
  const api={get:()=>read.promise,post:path=>path==='telemetry/notice'?notice.promise:off.promise};
  try{
    const loading=store.load(api),n=store.post(api,'telemetry/notice'),o=store.post(api,'telemetry/choose',{level:'off'});
    const inWrite=store.load({get:()=>during.promise});
    const authoritative={effective:'off'};off.resolve(authoritative);assert.equal(await o,authoritative);
    read.resolve({effective:'on'});await loading;
    during.resolve({effective:'on'});await inWrite;
    notice.resolve({effective:'on'});await n;
    assert.equal(store.get(),authoritative);
    await store.load({get:async()=>{throw new Error('read');}});
    assert.equal(store.get(),authoritative,'failed loads retain last authoritative view');
  }finally{remove();}
});

test('late actual policy bootstrap cannot reopen saved OFF after notification errors',async()=>{
  const f=fixture(),late=deferred();const remove=f.store.subscribe(()=>{throw new Error('notification');});
  try{
    await f.policy.check();f.api.get=()=>late.promise;
    const checking=f.policy.check();
    await f.store.post(f.api,'telemetry/choose',{level:'off'});
    late.resolve({consent:'on',generation:1,remoteEnabled:true,noticePending:false});await checking;
    assert.equal(f.bootstraps.length,1);
    f.api.get=async()=>({consent:'off',generation:2,remoteEnabled:true,noticePending:false});
    await f.policy.check();assert.equal(f.bootstraps.at(-1).consent,'off');
  }finally{late.resolve({consent:'off',generation:2});remove();f.policy.stop();}
});
