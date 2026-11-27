import test from 'node:test';
import assert from 'node:assert/strict';
import {connectBrowserPolicy} from './posthog-policy.mjs';
import {createTelemetryStore} from './telemetry-store.mjs';

const state=generation=>({consent:'on',generation,remoteEnabled:true,noticePending:false});
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function fixture(t){
  let now=0,next=0,periodic,cleared=0;
  const timers=new Map(),reads=[],calls=[];
  t.mock.method(globalThis,'setTimeout',(callback,delay)=>{
    const id=++next;timers.set(id,{callback,at:now+delay});return id;
  });
  t.mock.method(globalThis,'clearTimeout',id=>{timers.delete(id);});
  const store=createTelemetryStore();
  const api={get(path,signal){
    assert.equal(path,'telemetry/bootstrap');
    let resolve,reject;
    const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
    reads.push({resolve,reject,signal});return promise;
  },post:async()=>({effective:'off'})};
  const browser=Object.fromEntries(['stop','tick','connection','version','bootstrap'].map(name=>[name,(...args)=>calls.push([name,...args])]));
  const policy=connectBrowserPolicy({api,store,browser,onStop:()=>calls.push(['onStop']),
    setTimer:callback=>{periodic=callback;return 1;},clearTimer:()=>{cleared++;}});
  t.after(async()=>{
    policy.stop();for(const read of reads)read.resolve(state(99));
    await settle();timers.clear();t.mock.restoreAll();
  });
  return {policy,store,reads,calls,timers,api,browser,periodic:()=>periodic(),
    get cleared(){return cleared;},
    advance(ms){now+=ms;for(const [id,timer]of [...timers])if(timer.at<=now){timers.delete(id);timer.callback();}}};
}

for(const outcome of ['resolve','reject']){
  test('stopped held bootstrap has no asynchronous callbacks after late '+outcome,async t=>{
    const f=fixture(t),checking=f.policy.check();
    const deadline=[...f.timers.values()][0].callback;
    f.store.set({version:1}); // Demand while held must be discarded at disposal.
    assert.equal(f.reads.length,1);
    f.policy.stop();
    const stoppedCalls=[...f.calls];
    assert.equal(f.cleared,1);
    assert.equal(f.reads[0].signal.aborted,true,'stop aborts its owned request');
    assert.equal(f.timers.size,0,'stop cancels the active deadline');
    f.advance(5000);
    deadline(); // A callback already queued at disposal is harmless too.
    f.periodic();
    f.store.set({version:2});
    await f.store.post(f.api,'telemetry/choose',{level:'on'});
    if(outcome==='resolve')f.reads[0].resolve(state(2));
    else f.reads[0].reject(new Error('late synthetic failure'));
    await checking;await settle();
    assert.deepEqual(f.calls,stoppedCalls);
    assert.equal(f.reads.length,1,'no demanded follow-up after disposal');
    assert.equal(f.calls.some(call=>call[0]==='bootstrap'),false);
    // Preserve the existing synchronous semantics of explicit repeated stop().
    f.policy.stop();
    assert.deepEqual(f.calls.slice(stoppedCalls.length),[['stop'],['onStop']]);
  });
}

test('completed deadline cannot abort or clear the newer active owner',async t=>{
  const f=fixture(t),first=f.policy.check();
  const oldDeadline=[...f.timers.values()][0].callback;
  f.reads[0].resolve(state(1));await first;await settle();
  assert.equal(f.timers.size,0);
  assert.equal(f.reads[0].signal.aborted,false);
  const second=f.policy.check();
  const afterFirst=[...f.calls];
  assert.equal(f.timers.size,1);
  oldDeadline();
  assert.equal(f.reads[1].signal.aborted,false);
  assert.equal(f.timers.size,1,'old cleanup cannot remove the new deadline');
  assert.deepEqual(f.calls,afterFirst);
  f.advance(4500);
  assert.equal(f.reads[1].signal.aborted,true,'new owner still has its own deadline');
  assert.equal(f.reads[0].signal.aborted,false,'old request is not aborted');
  const timedOut=[...f.calls];
  f.reads[1].resolve(state(2));await second;await settle();
  assert.deepEqual(f.calls,timedOut,'late timed-out data cannot capture');
  assert.equal(f.reads.length,2,'timeout alone creates no retry');
  assert.deepEqual(f.calls.filter(call=>call[0]==='bootstrap'),[['bootstrap',state(1)]]);
});

test('failed OFF remains fenced while later disposal releases its held check',async t=>{
  const f=fixture(t),initial=f.policy.check();
  f.reads[0].resolve(state(1));await initial;
  assert.deepEqual(f.calls.filter(call=>call[0]==='bootstrap'),[['bootstrap',state(1)]]);
  const held=f.policy.check(),failure=new Error('owned one-shot stop failure');
  const stop=f.browser.stop;
  let armed=true,writes=0;
  f.browser.stop=(...args)=>{
    stop(...args);
    if(armed){armed=false;throw failure;}
  };
  f.api.post=async()=>{writes++;throw new Error('unexpected consent write');};
  await assert.rejects(f.store.post(f.api,'telemetry/choose',{level:'off'}),error=>error===failure);
  assert.equal(armed,false);
  assert.equal(writes,0);
  f.reads[1].resolve(state(2));await held;await settle();
  assert.equal(f.reads.length,3,'failed OFF retains exactly one demanded recheck');
  f.reads[2].resolve(state(1));await settle();
  assert.deepEqual(f.calls.filter(call=>call[0]==='bootstrap'),[['bootstrap',state(1)]],
    'neither stale pre-OFF nor same-generation post-OFF data can re-grant capture');
  const final=f.policy.check(),last=f.reads[3];
  assert.equal(f.reads.length,4);
  const deadline=[...f.timers.values()][0].callback;
  f.policy.stop();
  const stoppedCalls=[...f.calls];
  assert.equal(last.signal.aborted,true);
  assert.equal(f.timers.size,0);
  deadline();f.periodic();
  last.resolve(state(3));await final;await settle();
  assert.deepEqual(f.calls,stoppedCalls,'disposed policy ignores queued and late work after failed OFF');
  assert.equal(f.reads.length,4);
  assert.equal(writes,0);
});
