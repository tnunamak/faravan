import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileHostControl} from '../lib/v1/host-recovery.mjs';

const owner={pid:4321,executable:'/fixture/bin/faravan-coordinator',
  configPath:'/fixture/coordinator/host.json',start:'boot-a'};
const status={status:'listening',port:8787,pid:owner.pid,owner};
const cfg={protocol_version:1,host_wanted:true,stop_generation:'g1',
  circle_id:'circle-a',port:8787};

function fixture(overrides={}){
  const calls=[];
  const io={home:'/fixture/coordinator',expectedGeneration:'g1',
    read:async()=>({config:{...cfg},status:{...status}}),
    verify:async candidate=>{calls.push(['verify',candidate.pid]);return owner;},
    lock:async fn=>{calls.push(['lock']);return fn();},
    stop:async value=>{calls.push(['stop',value]);return {portQuiet:true};},
    ...overrides};
  return {io,calls};
}

test('verified running old host is adoptable without old launcher handle',async()=>{
  const {io,calls}=fixture();
  const v=await reconcileHostControl(io);
  assert.equal(v.status,'adopted');
  assert.equal(v.owner.pid,4321);
  assert.equal(calls.some(x=>x[0]==='verify'),true);
  assert.equal(calls.some(x=>x[0]==='stop'),false);
});

test('owner stop under the lock stops only the reverified owner',async()=>{
  const {io,calls}=fixture();
  const v=await reconcileHostControl({...io,action:'stop'});
  assert.equal(v.status,'stopped');
  assert.equal(v.portQuiet,true);
  assert.equal(calls[0][0],'lock','verification and stop run inside the lock');
  assert.equal(calls.filter(x=>x[0]==='stop').length,1);
  assert.equal(calls.find(x=>x[0]==='stop')[1].pid,owner.pid);
});

test('uncertain owner is never signalled',async()=>{
  const {io,calls}=fixture({verify:async()=>{throw Error('identity_mismatch');}});
  const v=await reconcileHostControl({...io,action:'stop'});
  assert.equal(v.status,'unverified');
  assert.equal(calls.some(x=>x[0]==='stop'),false);
});

test('old generation after explicit stop cannot adopt or restart',async()=>{
  const {io,calls}=fixture({read:async()=>({config:{...cfg,host_wanted:false,
    stop_generation:'g2'},status})});
  const v=await reconcileHostControl(io);
  assert.notEqual(v.status,'adopted');
  assert.equal(calls.some(x=>x[0]==='stop'),false);
});

test('PID replacement between checks is never stopped',async()=>{
  let n=0;const {io,calls}=fixture({verify:async()=>{
    n++;if(n>1)throw Error('pid_reused');return owner;
  }});
  const v=await reconcileHostControl({...io,action:'stop'});
  assert.equal(v.status,'unverified');
  assert.equal(calls.some(x=>x[0]==='stop'),false);
});

test('port-not-quiet is not a successful stop',async()=>{
  const {io}=fixture({stop:async()=>({portQuiet:false})});
  const v=await reconcileHostControl({...io,action:'stop'});
  assert.notEqual(v.status,'stopped');
});

test('a supplied generation that no longer matches is refused for both actions, even when the host is not wanted',async()=>{
  for(const action of ['adopt','stop']){
    for(const wanted of [true,false]){
      const {io,calls}=fixture({read:async()=>({config:{...cfg,host_wanted:wanted,stop_generation:'g2'},status:{...status}})});
      const v=await reconcileHostControl({...io,action});
      assert.notEqual(v.status,'stopped',`${action}/${wanted}`);
      assert.notEqual(v.status,'adopted',`${action}/${wanted}`);
      assert.equal(calls.some(x=>x[0]==='verify'||x[0]==='stop'),false,`${action}/${wanted} must not verify or signal a newer generation`);
    }
  }
});

test('an owner stop with no supplied generation still works when the host is not wanted',async()=>{
  const {io,calls}=fixture({expectedGeneration:undefined,read:async()=>({config:{...cfg,host_wanted:false},status:{...status}})});
  const v=await reconcileHostControl({...io,action:'stop'});
  assert.equal(v.status,'stopped');
  assert.equal(calls.filter(x=>x[0]==='stop').length,1);
});

test('a public_listening owner is adopted and stopped like a listening one',async()=>{
  const read=async()=>({config:{...cfg},status:{...status,status:'public_listening'}});
  const {io,calls}=fixture({read});
  assert.equal((await reconcileHostControl({...io})).status,'adopted');
  assert.equal((await reconcileHostControl({...io,action:'stop'})).status,'stopped');
  assert.equal(calls.filter(x=>x[0]==='stop').length,1);
});
