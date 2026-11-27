import test from 'node:test';
import assert from 'node:assert/strict';
import {createTelemetryStore} from './telemetry-store.mjs';
import {connectBrowserPolicy} from './posthog-policy.mjs';

const on=generation=>({consent:'on',generation,remoteEnabled:true,noticePending:false});
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
function fixture() {
  const store=createTelemetryStore(),original={effective:'on',version:1},failure=new Error('earlier guard');
  store.set(original);
  let capturing=false,stops=0,writes=0,cleared=0;
  const reads=[],bootstraps=[],write=deferred();
  // This registration must precede policy.beforeChange.
  const removeGuard=store.beforeChange((path,body)=>{
    if(path==='telemetry/choose'&&body.level==='off')throw failure;
  });
  const api={
    get(path){assert.equal(path,'telemetry/bootstrap');const held=deferred();reads.push(held);return held.promise;},
    post(){writes++;return write.promise;},
  };
  const browser={
    stop(){stops++;capturing=false;},tick(){},connection(){},
    bootstrap(value){bootstraps.push(value);capturing=value.consent==='on'&&value.remoteEnabled&&!value.noticePending;},
  };
  const policy=connectBrowserPolicy({store,api,browser,setTimer:()=>1,clearTimer(){cleared++;}});
  return {store,api,policy,reads,write,bootstraps,original,failure,removeGuard,
    get capturing(){return capturing;},get stops(){return stops;},get writes(){return writes;},get cleared(){return cleared;},
    async start(){const first=policy.check();reads[0].resolve(on(1));await first;assert.equal(capturing,true);},
    async dispose(){policy.stop();removeGuard();write.resolve({effective:'on',version:2});
      for(const read of reads)read.resolve(on(99));await settle();},
  };
}

test('sole OFF rejected by earlier guard stops ON and invalidates older bootstrap',async()=>{
  const f=fixture();
  try {
    await f.start();
    const old=f.policy.check(),before=f.stops;
    const failed=f.store.post(f.api,'telemetry/choose',{level:'off'});
    const rejected=assert.rejects(failed,error=>error===f.failure);
    // The completion notification is synchronous, even before awaiting rejection.
    assert.equal(f.capturing,false);
    assert.equal(f.stops,before+1);
    await rejected;
    assert.equal(f.writes,0);
    assert.equal(f.store.get(),f.original,'failed precondition does not persist OFF');
    assert.equal(f.reads.length,2,'single-flight old read remains outstanding');
    // Higher generation deliberately proves revision invalidation, not merely the generation fence.
    f.reads[1].resolve(on(2));await old;await settle();
    assert.deepEqual(f.bootstraps,[on(1)],'pre-OFF read cannot restart capture even at generation 2');
    assert.equal(f.reads.length,3,'unmatched OFF requests one coalesced fresh check');
    f.reads[2].resolve(on(1));await settle();
    assert.equal(f.capturing,false);
    assert.deepEqual(f.bootstraps,[on(1)],'fresh same-generation ON remains fenced');
    const fresh=f.policy.check();f.reads[3].resolve(on(2));await fresh;
    assert.equal(f.capturing,true,'independently fetched newer authoritative consent may recover');
    assert.deepEqual(f.bootstraps,[on(1),on(2)]);
  } finally {await f.dispose();}
});

test('unmatched failed OFF cannot consume overlapping non-OFF identity; stop removes listeners',async()=>{
  const f=fixture();let writing;
  try {
    await f.start();
    writing=f.store.post(f.api,'telemetry/notice',{});
    assert.equal(f.writes,1);
    await assert.rejects(f.store.post(f.api,'telemetry/choose',{level:'off'}),error=>error===f.failure);
    const count=f.reads.length;
    await f.policy.check();
    assert.equal(f.reads.length,count,'other write still suppresses bootstrap');
    assert.equal(f.store.get(),f.original);
    const saved={effective:'on',version:2};
    f.write.resolve(saved);assert.equal(await writing,saved);await settle();
    assert.equal(f.reads.length,count+1,'only the matching completion releases pending count');
    f.reads[count].resolve(on(1));await settle();
    assert.equal(f.capturing,false,'no other OFF supplied the fence');
    assert.equal(f.store.get(),f.original,'failed newer intent still invalidates earlier write answer');
    f.policy.stop();f.removeGuard();
    const stoppedReads=f.reads.length,stoppedStops=f.stops;
    f.store.set({effective:'on',version:3});
    assert.equal(await f.store.post(f.api,'telemetry/choose',{level:'on'}),saved);
    await f.policy.check();await settle();
    assert.equal(f.reads.length,stoppedReads);
    assert.equal(f.stops,stoppedStops,'removed policy observers do not react to later writes');
    assert.equal(f.cleared,1);
  } finally {
    f.write.resolve({effective:'on',version:2});
    if(writing)await writing;
    await f.dispose();
  }
});
