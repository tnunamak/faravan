import './helpers/no-browser.mjs';
import test from 'node:test';
import {AppLifetime} from '../lib/v1/app-lifetime.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {scheduleUpdates} from '../lib/v1/self-update.mjs';

const source=await readFile(new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
const scheduleBegin=source.indexOf('    // Update lifetime admission');
const scheduleEnd=source.indexOf('    schedulePauseEnd();',scheduleBegin);
const closeBegin=source.indexOf('    // Application lifetime shutdown',scheduleEnd);
const closeEnd=source.indexOf('    // Only the native managed supervisor',closeBegin);
assert.ok(scheduleBegin>=0&&scheduleEnd>scheduleBegin&&closeBegin>scheduleEnd&&closeEnd>closeBegin,
  'production update wiring and close extraction markers');

const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const flush=async()=>{for(let i=0;i<32;i++)await Promise.resolve();};

test('a tick whose idle check was parked across stop never starts the updater',async()=>{
  const idle=gate();let ticks=0;
  const schedule=scheduleUpdates({updater:{tick:async()=>{ticks++;return 'current';}},isIdle:()=>idle.promise,
    exclusive:async()=>()=>{},onApplied:async()=>{},setTimer:()=>({unref(){}}),clearTimer(){}});
  const step=schedule.step();
  await flush();
  schedule.stop();
  idle.resolve(true);
  await step;await flush();
  assert.equal(ticks,0);
});

test('a Quit body finishing after update close begins is refused before acceptance',async()=>{
  const begin=source.indexOf('        let input=await body(req);');
  const end=source.indexOf("        // Telemetry consent:",begin);
  const input=gate();let accepted=false;
  const c={closed:false,quitting:false,req:{},parts:['api','shutdown'],body:()=>input.promise,
    fail:(code,status)=>{throw Object.assign(new Error(code),{code,status});},accept:()=>{accepted=true;}};
  const route=runInNewContext('(async()=>{'+source.slice(begin,end)+';accept();})',c);
  const owner=new AppLifetime();c.requestHandle=owner.register('HTTP admission','producer');
  const request=route();c.closed=true;owner.stop('update');input.resolve({});
  await assert.rejects(request,{code:'app_closing'});assert.equal(accepted,false);
});

test('an applied update rechecks idleness after a refused Quit before relaunch',async()=>{
  const owner=new AppLifetime(),handle=owner.register('updater','producer',{blockedByHold:true});
  let idle=true,applied=0,ticks=0,attempt;
  const schedule=scheduleUpdates({updater:{tick:async()=>{ticks++;attempt=owner.register('Quit attempt','producer',{provisional:true});return 'applied';}},
    isIdle:async()=>idle,admit:()=>handle.commit(()=>{}),onApplied:async()=>{handle.commit(()=>{applied++;});},setTimer:()=>({unref(){}}),clearTimer:()=>{}});
  await schedule.step();attempt.cancel();idle=false;await schedule.step();assert.equal(applied,0);
  idle=true;await schedule.step();assert.equal(applied,1);assert.equal(ticks,1);schedule.stop();
});

test('scheduler drain accepts synchronous injected collaborators',async()=>{
  const schedule=scheduleUpdates({updater:{tick:()=> 'current'},isIdle:()=>true,
    setTimer:()=>({unref(){}}),clearTimer:()=>{}});
  await schedule.step();await schedule.settled();schedule.stop();
});
