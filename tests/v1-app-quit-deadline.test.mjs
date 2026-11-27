import './helpers/no-browser.mjs';
import test from 'node:test';
import {AppLifetime} from '../lib/v1/app-lifetime.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {proveDurableCessation} from '../lib/v1/durable-cessation.mjs';

// Same production-source/VM convention as v1-app-quit-start-fence.test.mjs.
// Execute the real route, not a test reimplementation of its timeout policy.
const source = await readFile(process.env.LIFECYCLE_APP_SOURCE??new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
const begin = source.indexOf("        if(parts[1]==='shutdown'&&parts.length===2) {");
const end = source.indexOf("        if(parts[1]==='hosting'&&parts[2]==='keep-awake'",begin);
assert.ok(begin >= 0 && end > begin,'shutdown route extraction markers');
const shutdownSource = source.slice(begin,end);
const settleSource = (await readFile(new URL('../lib/v1/settle-within.mjs',import.meta.url),'utf8'))
  .replace('export async function settleWithin','async function settleWithin');
const gate = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise,resolve};
};
const flush = async () => { for (let i=0;i<32;i++) await Promise.resolve(); };
function clock() {
  let time=0,sequence=0;
  const jobs = new Map();
  const setTimer = (fn,delay=0,...args) => {
    const handle = {id:++sequence,unref(){return this;}};
    jobs.set(handle,{at:time+Math.max(0,Number(delay)||0),fn:()=>fn(...args)});
    return handle;
  };
  const clearTimer = handle => jobs.delete(handle);
  return {
    get now(){return time;},
    Date:class extends Date { static now(){return time;} },
    setTimeout:setTimer,clearTimeout:clearTimer,
    setImmediate:(fn,...args)=>setTimer(fn,0,...args),clearImmediate:clearTimer,
    async advance(ms) {
      const target=time+ms;
      await flush();
      for(let turns=0;;turns++) {
        assert.ok(turns<1000,'virtual timer loop did not converge');
        const next=[...jobs].filter(([,job])=>job.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];
        if(!next)break;
        time=next[1].at;jobs.delete(next[0]);next[1].fn();await flush();
      }
      time=target;await flush();
    },
  };
}
function fixture(stage) {
  const timers=clock(),blocked=gate(),entered=gate();
  const attemptId='synthetic-attempt';
  const pending={attemptId,owner_scope:'synthetic-owner',sbx_home:'/synthetic/sbx',
    attempt:{attempt_id:attemptId,job_digest:'sha256:'+'a'.repeat(64),generation:1}};
  const log={residentQuit:0,close:0,success:0,pauseRescheduled:0};
  const pause = async name => {if(stage===name){entered.resolve();await blocked.promise;}};
  const c={
    approvals:new Map(),quitting:false,closed:false,safetyEpoch:0,pauseTimer:null,requestStartedAt:0,
    settings:{intent:'on',enabled:true},policy:{enabled:true},home:'/synthetic/home',
    options:{shutdownProofMs:60000},controller:new AbortController(),loop:Promise.resolve(),
    counterStore:{directory:'/synthetic/counters',get:async()=>{
      await pause('store');await pause('quiet');return stage==='quiet'?{}:{pending:structuredClone(pending)};
    }},
    backend:{isSandboxHomeCurrent:()=>true,reconcilePending:async record=>{
      await pause('reconcile');
      return {removed:true,attemptId:record.attemptId,sbx_home:record.sbx_home};
    }},
    lender:stage==='quiet'?{
      getState:()=>({current:null,counters:{}}),pause(){},cessation:()=>({proven:true}),
    }:stage==='stop'?{
      getState:()=>({current:attemptId,currentJobs:[{attemptId}],counters:{pending}}),
      stopCurrentJob:async()=>pause('stop'),pause(){},cessation:()=>({proven:true}),
    }:null,
    save:async()=>pause('save'),proveDurableCessation,structuredClone,AbortController,
    fail:(code,status=400)=>{throw Object.assign(new Error(code),{code,status});},
    setResidentQuit:()=>{log.residentQuit++;},cancelResumes:()=>{},
    schedulePauseEnd:()=>{log.pauseRescheduled++;},
    shutdownBoundMs:()=>60000,
    close:async()=>{log.close++;c.closed=true;},
    send:(body,status=200)=>{if(status===202)log.success++;return {body,status};},
    lifetimeNow:()=>timers.now,Date:timers.Date,setTimeout:timers.setTimeout,clearTimeout:timers.clearTimeout,
    setImmediate:timers.setImmediate,clearImmediate:timers.clearImmediate,
  };
  c.lifetime=new AppLifetime({now:()=>timers.now,setTimer:timers.setTimeout,clearTimer:timers.clearTimeout});
  c.settingsHandle=c.lifetime.register('settings','consumer');
  const quit=runInNewContext(settleSource+'\n'+
    '(async function quit(input){const parts=["api","shutdown"];\n'+shutdownSource+'\n})',c);
  return {c,log,timers,blocked,entered,quit,input:stage==='stop'?{attemptId,confirmed:true}:{}};
}

for(const stage of ['reconcile','stop','store','save']) {
  test('Quit attempt is bounded while '+stage+' is pending, and rejects late success',async()=>{
    const f=fixture(stage);
    let outcome={state:'pending'};
    const work=f.quit(f.input).then(
      result=>{outcome={state:'response',status:result.status,body:result.body};},
      error=>{outcome={state:'refused',code:error.code,status:error.status};},
    );
    // This drives the real route's setImmediate without wall-clock sleeps.
    await f.timers.advance(0);
    let reached=false;f.entered.promise.then(()=>{reached=true;});await flush();
    assert.equal(reached,true,'the requested production await was reached');
    assert.equal(f.c.quitting,true,'Quit proof began before the parked await');
    let atBudget;
    try {
      await f.timers.advance(60001);
      atBudget={...outcome,quitting:f.c.quitting};
    } finally {
      // Release even on a failed assertion; the test never awaits a permanently hung promise.
      f.blocked.resolve();
      await f.timers.advance(0);
      await work;
      await f.timers.advance(1000);
    }
    assert.deepEqual({
      atBudget,after:outcome,residentQuit:f.log.residentQuit,
      success:f.log.success,close:f.log.close,quitting:f.c.quitting,
    },{
      atBudget:{state:'refused',code:'cessation_unverified',status:409,quitting:false},
      after:{state:'refused',code:'cessation_unverified',status:409},
      residentQuit:0,success:0,close:0,quitting:false,
    },'deadline refusal is terminal, clears quitting, and cannot become a late successful Quit');
  });
}

// A Quit that timed out was refused; whatever it was waiting on may finish later, and must not touch the lending state
// that the person has since resumed.
for(const stage of ['stop','quiet']) {
  test('a refused Quit whose '+stage+' step finishes late leaves settings, policy, controller and lender alone',async()=>{
    const f=fixture(stage);
    const lenderBefore=f.c.lender,controllerBefore=f.c.controller;
    let outcome={state:'pending'};
    const work=f.quit(f.input).then(r=>{outcome={state:'response'};},e=>{outcome={state:'refused',code:e.code};});
    await f.timers.advance(0);
    await f.entered.promise;
    await f.timers.advance(60001);
    assert.deepEqual(outcome,{state:'refused',code:'cessation_unverified'});
    // The person resumes lending after the refusal.
    f.c.settings.enabled=true;f.c.policy.enabled=true;
    f.blocked.resolve();
    await f.timers.advance(1000);await work;
    assert.deepEqual({
      enabled:f.c.settings.enabled,policy:f.c.policy.enabled,aborted:f.c.controller.signal.aborted,
      sameController:f.c.controller===controllerBefore,sameLender:f.c.lender===lenderBefore,
    },{enabled:true,policy:true,aborted:false,sameController:true,sameLender:true});
  });
}

// A queued save must retain the attempt fence, not just check after save resolves.
test('refused Quit never dispatches its queued settings write',async()=>{
  const f=fixture('none'),first=gate(),entered=gate(),writes=[];
  f.c.atomic=async(file,value)=>{writes.push(structuredClone(value));if(writes.length===1){entered.resolve();await first.promise;}};
  f.c.settingsFile='/synthetic/settings';
  const queueBegin=source.indexOf('  let settingsWrites=Promise.resolve();');
  const queueEnd=source.indexOf('  const counterStore=',queueBegin);
  const save=runInNewContext(source.slice(queueBegin,queueEnd)+'\nsave;',f.c);
  f.c.save=save;
  const earlier=save();await entered.promise;
  const quitting=f.quit({}).catch(error=>error.code);
  await f.timers.advance(60001);
  first.resolve();await earlier;await f.timers.advance(0);
  assert.equal(await quitting,'cessation_unverified');
  assert.equal(writes.length,1,'expired queued callback must never dispatch atomic');
});

test('time already spent reading the request body reduces the proof budget',async()=>{
  const f=fixture('save');f.c.requestStartedAt=-5000;
  const work=f.quit({}).catch(error=>error.code);await f.timers.advance(0);await f.entered.promise;
  await f.timers.advance(55001);assert.equal(await work,'cessation_unverified');
  f.blocked.resolve();await f.timers.advance(0);
});

test('a request whose body consumed its budget refuses before acquiring a scope or mutating settings',async()=>{
  const f=fixture('none');f.c.requestStartedAt=-60001;
  await assert.rejects(f.quit({}),{code:'cessation_unverified'});
  assert.equal(f.c.quitting,false);assert.equal(f.c.settings.enabled,true);
  assert.equal(await f.c.lifetime.register('ordinary','producer').run(()=>true),true);
});
