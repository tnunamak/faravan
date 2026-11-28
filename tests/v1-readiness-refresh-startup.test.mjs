import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {dockerFacts} from '../lib/v1/docker-state.mjs';

// Exact scoped source seams with explicit fakes, not the app's excluded dependency graph.
const app=fs.readFileSync(new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
const pool=fs.readFileSync(new URL('../lib/v1/lending-pool.mjs',import.meta.url),'utf8');
const fixture=fs.readFileSync(new URL('./helpers/v1-app-fixture.mjs',import.meta.url),'utf8');
function slice(source,start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,start);return source.slice(a,b);}
const waitFor=Function('assert','return '+slice(fixture,'async function waitFor(','// Hang guards'))(assert);
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function readinessCache(readiness,{record=()=>{},onEmit=()=>{},reconcile=async()=>false}={}){
  const source=slice(app,'  let blockerCheck=null,blockerCheckedAt=0;','  // The app never sends a person');
  return Function('readiness','dockerFacts','record','onEmit','reconcile',`let closed=false;const backend={signInGeneration:0},deadlineRecovery={retry:async()=>{},admit:async()=>{},current:()=>null},now=Date.now,statusCheckNow=now,lender=null,options={},settings={},refreshAbort=new AbortController(),
    createSupportReadinessCache=()=>({record}),atomic=()=>{},join=()=>'',directory='',setupProgress={reconcile},resumeHook={},
    emit=onEmit,normalizeSbxVersion=x=>x,observedSbxVersion='test';
    ${source}
    return {cachedReadiness, close:()=>{closed=true;refreshAbort.abort();}, snapshot:()=>({defaultObservation,readinessCache})};`)(readiness,dockerFacts,record,onEmit,reconcile);
}
function poolAdmission(children){
  const source=slice(pool,'  admits(job){','  /** A known identity');
  return Function('children',`const loop=true,paused=false,options={},policy={enabled:true},root={accounts:{}},maxResources={cpu:10,memoryBytes:32*1024**3},withinSlots=c=>c.slot===0;
    ${slice(pool,' function activeReservations(', ' function aggregate()')}
    return ({${source}}).admits;`)(children);
}

test('explicit machine refresh settles with new evidence independently of delayed pool startup',async()=>{
  const gate=deferred(),children=[];
  const fresh={ready:false,checks:[{name:'guard_runtime',ok:false,reason:'guard_runtime_unavailable'}],protection:{observed_at:'2026-11-08T00:00:00.000Z'}};
  const cache=readinessCache(async()=>{await gate.promise;return fresh;});
  const admits=poolAdmission(children);let answered=false;
  const request=cache.cachedReadiness(true).then(value=>{answered=true;return value;});
  await Promise.resolve();assert.equal(answered,false,'refresh does not answer before the check finishes');
  gate.resolve();const result=await request;
  assert.equal(result.ready,false);assert.equal(result.checks[0].reason,'guard_runtime_unavailable');
  assert.equal(admits({}),'lender_starting','fresh machine checks do not manufacture a started account');
  const timer=setTimeout(()=>children.push({slot:0,worker:{admits:()=>'sandbox_cannot_start'}}),25);
  try {
    // Execute the checked-in test's precise wait/assert contract. Without its wait this is deterministically red.
    const integration=fs.readFileSync(new URL('./v1-app-readiness-requirements.test.mjs',import.meta.url),'utf8');
    const start=integration.indexOf("  assert.equal(lender.app.lendingAdmission(),'sandbox_cannot_start'");
    assert.ok(start>0);
    const before=integration.lastIndexOf('  await waitFor(',start);
    const contract=(before>=0&&integration.slice(before,start).includes('lender startup after the runtime refresh')?integration.slice(before,start):'')+
      integration.slice(start,integration.indexOf('\n',start));
    await Function('assert','waitFor','lender',`return (async()=>{${contract}})()`)(assert,waitFor,{app:{lendingAdmission:()=>admits({})}});
  } finally {clearTimeout(timer);}
});

test('an in-flight readiness result cannot publish or persist after App close',async()=>{
  const gate=deferred(),entered=deferred(),events=[];
  const cache=readinessCache(async()=>{entered.resolve();await gate.promise;return {
    ready:true,checks:[],protection:{observed_at:'2026-11-08T00:00:00.000Z'}
  };},{
    record:()=>events.push('persist'),
    onEmit:()=>events.push('publish'),
    reconcile:async()=>{events.push('reconcile');return false;},
  });
  const query=cache.cachedReadiness(true);
  await entered.promise;
  cache.close();
  gate.resolve();
  assert.equal((await query).ready,false);
  assert.deepEqual(cache.snapshot(),{defaultObservation:null,readinessCache:null});
  assert.deepEqual(events,[]);
});
