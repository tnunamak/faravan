import test from 'node:test';
import assert from 'node:assert/strict';
import {connectBrowserPolicy} from './posthog-policy.mjs';
import {createTelemetryStore} from './telemetry-store.mjs';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function setup(get=async()=>({consent:'on'})) {
  const calls=[],store=createTelemetryStore();let timer;
  const browser={stop:()=>calls.push('stop'),connection:value=>calls.push(['connection',value]),bootstrap:value=>calls.push(['bootstrap',value]),tick(){}};
  let stream;
  const api={get,post:async()=>({effective:'off'}),request:async()=>new Response(new ReadableStream({start(controller){stream=controller;}}),{headers:{'Content-Type':'text/event-stream'}})};
  const policy=connectBrowserPolicy({api,browser,store,setTimer:fn=>{timer=fn;return 1;},clearTimer(){}});
  return {calls,store,browser,policy,api,tick:()=>timer(),end:()=>stream.close()};
}
test('consent is checked every five seconds and late answers cannot reopen local OFF',async()=>{
  let resolve;const f=setup(()=>new Promise(done=>{resolve=done;}));
  try{
    for(let i=0;i<4;i++)f.tick();assert.equal(resolve,undefined);f.tick();assert.equal(typeof resolve,'function');
    await f.store.post(f.api,'telemetry/choose',{level:'off'});resolve({consent:'on'});await flush();
    assert.equal(f.calls.some(call=>Array.isArray(call)&&call[0]==='bootstrap'),false);
    assert.equal(f.calls[0],'stop');
  }finally{f.policy.stop();resolve?.({consent:'off',generation:2});await flush();}
});
test('event stream end stops immediately even if polling still says connected',async()=>{
  const f=setup();try{
    const response=await f.policy.api.request('events?after=0',{});const reader=response.body.getReader();
    f.end();await reader.read();
    assert.deepEqual(f.calls.at(-1),['connection',false]);
    const count=f.calls.length;f.policy.connection(true);await flush();
    assert.equal(f.calls.slice(count).some(call=>Array.isArray(call)&&call[0]==='connection'&&call[1]===true),false);
  }finally{f.policy.stop();}
});
test('telemetry event invalidates earlier bootstrap before reading new policy',async()=>{
  let resolve;const f=setup(()=>new Promise(done=>{resolve=done;}));try{
    const pending=f.policy.check();f.policy.event({type:'telemetry'});resolve({consent:'on'});await pending;
    assert.ok(f.calls.includes('stop'));assert.equal(f.calls.some(call=>Array.isArray(call)&&call[0]==='bootstrap'),false);
  }finally{f.policy.stop();resolve?.({consent:'off',generation:2});await flush();}
});

test('two tabs reconcile a newer ON generation after local OFF without accepting stale ON',async()=>{
  let state={consent:'on',generation:1},resolvePending,hold=false;
  const read=()=>hold?new Promise(resolve=>{resolvePending=resolve;}):Promise.resolve({...state});
  const a=setup(read),b=setup(read);
  const saved=[];
  for(const tab of [a,b]){
    tab.api.post=async(_path,body)=>{state={consent:body.level,generation:state.generation+1};saved.push({...state});return {effective:state.consent};};
  }
  try{
    await a.policy.check();await b.policy.check();
    hold=true;const stale=a.policy.check();
    let finishOff;const post=a.api.post;
    a.api.post=async(...args)=>{const result=await post(...args);await new Promise(resolve=>{finishOff=resolve;});return result;};
    const off=a.store.post(a.api,'telemetry/choose',{level:'off'});await flush();
    // This reply belongs to the read before OFF, even though it arrives during the write.
    resolvePending({consent:'on',generation:1});await stale;
    assert.equal(a.calls.filter(call=>call[0]==='bootstrap').length,1);
    hold=false;finishOff();await off;await flush();
    a.api.post=post;
    await b.store.post(b.api,'telemetry/choose',{level:'on'});await flush();
    a.policy.event({type:'telemetry'});await flush();
    assert.deepEqual(a.calls.filter(call=>call[0]==='bootstrap').at(-1),['bootstrap',{consent:'on',generation:3}]);
    // A later read returning an older ON generation must not undo the OFF boundary.
    state={consent:'on',generation:1};const count=a.calls.filter(call=>call[0]==='bootstrap').length;
    await a.policy.check();assert.equal(a.calls.filter(call=>call[0]==='bootstrap').length,count);
    assert.deepEqual(saved,[{consent:'off',generation:2},{consent:'on',generation:3}]);
  }finally{a.policy.stop();b.policy.stop();}
});

test('a failed OFF write still permits a later authoritative ON generation',async()=>{
  let state={consent:'on',generation:1};const f=setup(async()=>({...state}));
  f.api.post=async()=>{throw new Error('write failed');};
  try{
    await f.policy.check();
    await assert.rejects(f.store.post(f.api,'telemetry/choose',{level:'off'}));await flush();
    assert.equal(f.calls.filter(call=>call[0]==='bootstrap').length,1,'old ON remains fenced');
    state={consent:'on',generation:2};f.policy.event({type:'telemetry'});await flush();
    assert.deepEqual(f.calls.filter(call=>call[0]==='bootstrap').at(-1),['bootstrap',state]);
  }finally{f.policy.stop();}
});

test('a request-level OFF restriction can clear without a saved policy generation change',async()=>{
  let state={consent:'off',generation:1};const f=setup(async()=>({...state}));
  try{
    await f.policy.check();
    state={consent:'on',generation:1};await f.policy.check();
    assert.deepEqual(f.calls.filter(call=>call[0]==='bootstrap').at(-1),['bootstrap',state]);
  }finally{f.policy.stop();}
});
