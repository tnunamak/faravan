import test from 'node:test';
import assert from 'node:assert/strict';
import {createTelemetryStore} from './telemetry-store.mjs';
import {connectBrowserPolicy} from './posthog-policy.mjs';

const on=generation=>({consent:'on',generation,remoteEnabled:true,noticePending:false});
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};

for(const failingPort of ['browser.stop','onStop'])test('matched OFF fences before one-shot '+failingPort+' failure',async()=>{
  const store=createTelemetryStore(),original={effective:'on',version:1};
  store.set(original);
  const failure=new Error('owned one-shot '+failingPort),reads=[],bootstraps=[],started=[],completed=[];
  let armed=false,writes=0,stops=0,onStops=0,cleared=0,disposed=false;
  const removeBefore=store.beforeChange((path,body,change)=>started.push({path,body,change}));
  const api={
    get(path){assert.equal(path,'telemetry/bootstrap');const read=deferred();reads.push(read);return read.promise;},
    async post(){writes++;throw new Error('API write must not be reached');},
  };
  const failOnce=port=>{if(armed&&port===failingPort){armed=false;throw failure;}};
  const browser={
    stop(){stops++;failOnce('browser.stop');},
    tick(){},connection(){},
    bootstrap(state){bootstraps.push(state);},
  };
  const policy=connectBrowserPolicy({store,api,browser,
    onStop(){onStops++;failOnce('onStop');},
    setTimer:()=>1,clearTimer(){cleared++;},
  });
  const removeAfter=store.afterChange((path,body,saved,change)=>completed.push({path,body,saved,change}));
  try {
    const initial=policy.check();assert.equal(reads.length,1);
    reads[0].resolve(on(1));await initial;
    assert.deepEqual(bootstraps,[on(1)],'positive validated ON reaches actual policy bootstrap');
    const old=policy.check();assert.equal(reads.length,2);
    const stopsBefore=stops,onStopsBefore=onStops;
    armed=true;
    await assert.rejects(store.post(api,'telemetry/choose',{level:'off'}),error=>error===failure);
    assert.equal(armed,false,'only the targeted effect throws once');
    assert.equal(stops,stopsBefore+1,'policy before hook reached the stop port');
    assert.equal(onStops,onStopsBefore+(failingPort==='onStop'?1:0));
    assert.equal(writes,0,'failed privacy precondition forbids the API write');
    assert.equal(store.get(),original,'no saved OFF or fabricated authoritative view');
    assert.equal(started.length,1);assert.equal(completed.length,1);
    assert.equal(completed[0].saved,false);
    assert.equal(completed[0].change,started[0].change,'completion retains the sole started identity');
    assert.equal(reads.length,2,'matched completion coalesces behind the held read');
    // Even a newer answer started before OFF is stale by revision, not just generation.
    reads[1].resolve(on(2));await old;await settle();
    assert.deepEqual(bootstraps,[on(1)],'held pre-OFF read must not grant capture');
    assert.equal(reads.length,3,'matched completion settled pending bookkeeping and requested one fresh read');
    reads[2].resolve(on(1));await settle();
    assert.deepEqual(bootstraps,[on(1)],'same-generation ON cannot re-grant after the failed stop effect');
    const fresh=policy.check();assert.equal(reads.length,4);
    reads[3].resolve(on(2));await fresh;
    assert.deepEqual(bootstraps,[on(1),on(2)],'new authoritative ON can recover once the effect port works');
    assert.equal(writes,0);
    // No claim that a throwing effect successfully disabled an actual SDK.
    policy.stop();disposed=true;
    assert.equal(cleared,1);
    const readsAfter=reads.length,stopsAfter=stops,onStopsAfter=onStops;
    store.set({effective:'on',version:2});await policy.check();await settle();
    assert.equal(reads.length,readsAfter);assert.equal(stops,stopsAfter);assert.equal(onStops,onStopsAfter);
  } finally {
    armed=false;
    if(!disposed)policy.stop();
    removeBefore();removeAfter();
    for(const read of reads)read.resolve(on(99));
    await settle();
  }
});
