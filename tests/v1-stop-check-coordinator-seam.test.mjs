import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createStopCheckCoordinator} from '../lib/v1/stop-check-coordinator.mjs';

const tick = () => new Promise(r => setImmediate(r));

test('the coordinator deadline runs on an injected timer: no real wait, abort observed, timer cleared after the flight', async () => {
  const timers = new Set(); let abortedWith = null, checks = 0;
  const setTimer = (fn, ms) => { const t = {fn, ms, unref() {}}; timers.add(t); return t; };
  const clearTimer = t => timers.delete(t);
  const coordinator = createStopCheckCoordinator({
    store: {current: async () => null}, binding: async () => ({backend_id: 'b', sbx_version: '1'}),
    check: ({signal}) => { checks++; signal.addEventListener('abort', () => { abortedWith = signal.reason; }); return new Promise(() => {}); },
    setTimer, clearTimer, deadlineMs: 480000,
  });
  coordinator.start(); await tick(); await tick();
  assert.equal(checks, 1);
  assert.equal(timers.size, 1);
  assert.equal([...timers][0].ms, 480000);
  coordinator.start(); await tick();
  assert.equal(checks, 1, 'a second start joins the running check');
  [...timers][0].fn(); await tick(); await tick();
  assert.equal(abortedWith?.name, 'TimeoutError');
  assert.equal(timers.size, 1, 'only the cooldown timer remains after the flight');
  assert.equal([...timers][0].ms, 600_000);
  coordinator.close();
  assert.equal(timers.size, 0, 'shutdown disarms the cooldown timer');
});

function harness({at=0, measured_at=0, gate} = {}) {
  let checks=0, id=0; const timers=new Map();
  const coordinator=createStopCheckCoordinator({
    store:{current:async()=> measured_at!==null && at-measured_at<24*60*60_000 ? {measured_at} : null},
    binding:async()=>({backend_id:'fixture',sbx_version:'1'}),
    check:async()=>{checks++; if(gate) await gate; measured_at=at; return {ok:true};},
    now:()=>at, setTimer(fn,ms){ const key={id:++id,fn,due:at+ms,unref(){}}; timers.set(key,key); return key; },
    clearTimer:key=>timers.delete(key),
  });
  return {coordinator,timers,checks:()=>checks,async advance(to){ at=to; for(const key of [...timers.keys()]) if(key.due<=at){timers.delete(key);key.fn();} await tick(); }};
}
test('lifecycle renews a valid receipt at 20 hours without an admission or view read', async()=>{
  const hour=60*60_000, h=harness();
  h.coordinator.start(); await tick();
  assert.equal([...h.timers.keys()][0]?.due,20*hour);
  await h.advance(20*hour-1); assert.equal(h.checks(),0);
  await h.advance(20*hour); assert.equal(h.checks(),1);
  assert.equal([...h.timers.keys()][0]?.due,40*hour);
  h.coordinator.close(); assert.equal(h.timers.size,0);
});
test('expired lifecycle start coalesces manual and job triggers',async()=>{
  let release; const gate=new Promise(r=>{release=r;});
  const h=harness({at:24*60*60_000,gate});
  h.coordinator.start(); await tick();
  h.coordinator.retry(); const ensure=h.coordinator.ensure(); await tick();
  assert.equal(h.checks(),1);
  release(); assert.deepEqual(await ensure,{ok:true});
  h.coordinator.close(); assert.equal(h.timers.size,0);
});

test('parked renewal ignores an old timer, re-arms on resume, and stays closed', async()=>{
  const hour=60*60_000, h=harness();
  h.coordinator.start(); await tick();
  const parked=[...h.timers.keys()][0];
  assert.equal(parked?.due,20*hour);
  h.coordinator.disableRenewal();
  assert.equal(h.timers.size,0);
  parked.fn(); await h.advance(20*hour);
  assert.equal(h.checks(),0);
  h.coordinator.start(); await tick();
  assert.equal(h.checks(),1);
  const rearmed=[...h.timers.keys()][0];
  assert.equal(rearmed?.due,40*hour);
  h.coordinator.close();
  h.coordinator.start(); rearmed.fn(); await h.advance(40*hour);
  assert.equal(h.checks(),1);
  assert.equal(h.timers.size,0);
});
