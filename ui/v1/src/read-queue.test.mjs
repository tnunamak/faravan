import test from 'node:test';
import assert from 'node:assert/strict';
import {createReadQueue} from './read-queue.mjs';

const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const clock=t=>t.mock.timers.enable({apis:['setTimeout','Date'],now:0});

test('a person-initiated load starts at once even inside the spacing window; a background load waits for it',async t=>{
  clock(t);const starts=[];
  const queue=createReadQueue(async()=>{starts.push(Date.now());return 'ok';});
  await queue.load();t.mock.timers.tick(1000);
  queue.load();await flush();assert.deepEqual(starts,[0],'background load waits');
  queue.load({force:true});await flush();assert.deepEqual(starts,[0,1000],'forced load does not');
  t.mock.timers.tick(4000);await flush();assert.deepEqual(starts,[0,1000],'the forced load took over the waiting one');
  queue.stop();
});
test('loads while a read runs share one follow-up, and a forced one makes it forced',async t=>{
  clock(t);const starts=[],release=[];
  const queue=createReadQueue(()=>new Promise(resolve=>{starts.push(Date.now());release.push(()=>resolve('ok'));}));
  queue.load();await flush();queue.load();queue.load({force:true});queue.load();
  release[0]();await flush();assert.equal(starts.length,2,'one follow-up, started without waiting');
  release[1]();await flush();t.mock.timers.tick(30000);await flush();assert.equal(starts.length,2);queue.stop();
});
test('background loads are spaced by five seconds or twice the last read, whichever is longer',async t=>{
  clock(t);const starts=[];
  const queue=createReadQueue(()=>new Promise(resolve=>{starts.push(Date.now());setTimeout(()=>resolve('ok'),4000);}));
  queue.load();await flush();t.mock.timers.tick(4000);await flush();queue.load();
  t.mock.timers.tick(3999);await flush();assert.equal(starts.length,1);
  t.mock.timers.tick(1);await flush();assert.deepEqual(starts,[0,8000]);queue.stop();
});
test('failures retry by themselves with doubling delays that a success resets; cancellation never retries',async t=>{
  clock(t);const starts=[];let outcome='failed';
  const queue=createReadQueue(async()=>{starts.push(Date.now());return outcome;});
  queue.load();await flush();
  t.mock.timers.tick(5000);await flush();t.mock.timers.tick(9999);await flush();assert.deepEqual(starts,[0,5000]);
  t.mock.timers.tick(1);await flush();assert.deepEqual(starts,[0,5000,15000]);
  outcome='ok';t.mock.timers.tick(20000);await flush();assert.equal(starts.length,4);
  outcome='failed';queue.load();t.mock.timers.tick(5000);await flush();
  const before=starts.length;t.mock.timers.tick(5000);await flush();assert.equal(starts.length,before+1,'the first retry after a success is five seconds again');
  outcome='cancelled';t.mock.timers.tick(60000);await flush();const settled=starts.length;t.mock.timers.tick(120000);await flush();
  assert.equal(starts.length,settled);queue.stop();
});
test('stop aborts the read, frees waiting callers and leaves no timer to start another',async t=>{
  clock(t);let signal,starts=0;
  const queue=createReadQueue(s=>{starts++;signal=s;return new Promise(resolve=>s.addEventListener('abort',()=>resolve('cancelled')));});
  queue.load();await flush();const waiting=queue.load();
  queue.stop();await flush();assert.equal(signal.aborted,true);await waiting;
  t.mock.timers.tick(120000);await flush();assert.equal(starts,1);
  await queue.load();assert.equal(starts,1,'a stopped queue reads nothing');
});
test('load resolves with the read outcome, so a caller can tell a failed read from a good one',async t=>{
  clock(t);let outcome='failed';
  const queue=createReadQueue(async()=>outcome);
  assert.equal(await queue.load(),'failed');
  outcome='ok';
  assert.equal(await queue.load({force:true}),'ok');
  outcome='failed';
  const first=queue.load({force:true}),followUp=queue.load({force:true});
  assert.equal(await first,'failed');assert.equal(await followUp,'failed','a queued follow-up reports its own read');
  queue.stop();
});

test('routine five-second refreshes honor the failure retry deadline',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:0});
 const starts=[];const q=createReadQueue(async()=>{starts.push(Date.now());return 'failed';});
 q.load();await flush();
 for(let i=0;i<2;i++){t.mock.timers.tick(5000);await flush();q.load();await flush();}
 assert.deepEqual(starts,[0,5000], 'second failure requires ten seconds even when routine refreshes ask sooner');
 t.mock.timers.tick(5000);await flush();assert.deepEqual(starts,[0,5000,15000]);q.stop();
});
test('an explicit refresh still bypasses a failure delay',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:0});
 const starts=[];const q=createReadQueue(async()=>{starts.push(Date.now());return 'failed';});
 q.load();await flush();t.mock.timers.tick(5000);await flush();t.mock.timers.tick(1000);
 q.load({force:true});await flush();assert.deepEqual(starts,[0,5000,6000]);q.stop();
});
