import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {AppLifetime} from '../lib/v1/app-lifetime.mjs';
import {createTelemetryFacts,requestedJob} from '../lib/v1/telemetry-facts.mjs';

const source=readFileSync(new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
const begin=source.indexOf("  lifetime.register('telemetry','consumer',");
const end=source.indexOf('\n  telemetry=options.telemetry',begin);
assert.ok(begin>=0&&end>begin,'production telemetry ownership registration');
const registration=source.slice(begin,end);
const flush=async()=>{for(let i=0;i<64;i++)await Promise.resolve();};

for(const mode of ['cutoff','drain error','startup cutoff'])test('facts publication stops before telemetry release after '+mode,async t=>{
  let time=0,consume=false,underlyingClosed=false,lateBootstraps=0,resolveRead;
  const timers=new Map(),events=[];
  const setTimer=(kind,callback,ms)=>{
    const handle={unref(){}};timers.set(handle,{kind,callback,at:time+ms});return handle;
  };
  const clearTimer=handle=>timers.delete(handle);
  t.mock.method(globalThis,'setTimeout',(callback,ms)=>setTimer('facts',callback,ms));
  t.mock.method(globalThis,'clearTimeout',clearTimer);
  const telemetry={
    bootstrap:()=>{
      if(consume){consume=false;time+=1000;}
      if(underlyingClosed)lateBootstraps++;
      return {remoteEnabled:true,generation:1};
    },
    observeFact:name=>{events.push({name,afterClose:underlyingClosed});return true;},
    close:()=>{underlyingClosed=true;events.push({name:'telemetry.close',afterClose:false});},
  };
  const facts=createTelemetryFacts({telemetry,monotonic:()=>time+120_000,
    schedule:callback=>setTimer('queued',callback,25)});
  facts.job('job',requestedJob({harness:'codex'}),{surface:'cli'});facts.drain();
  facts.finishBorrower('job','finished',()=>new Promise(resolve=>{resolveRead=resolve;}));facts.drain();
  await flush();
  const lifetime=new AppLifetime({now:()=>time,budgetMs:60_000,
    setTimer:(callback,ms)=>setTimer('owner',callback,ms),clearTimer});
  const context={lifetime,lifetimeNow:()=>time,
    telemetryFacts:facts,telemetryFactsTimer:null,telemetryFactsClose:undefined,telemetry,clearInterval:()=>{}};
  runInNewContext(registration,context);
  if(mode==='startup cutoff')lifetime.register('slow producer','producer',{seal:()=>{time+=1000;}});
  consume=true;
  const stopping=lifetime.stop('close',{startedAt:0});
  const factsDeadlines=[...timers.values()].filter(timer=>timer.kind==='facts').map(timer=>timer.at);
  if(mode==='drain error') {
    const rejected=Promise.reject(Error('injected drain failure'));rejected.catch(()=>{});
    context.telemetryFactsClose=rejected;
  }
  await flush();
  if(mode!=='drain error') {
    time=55_000;
    // Delay the facts timer to exercise release independently of timer order.
    for(const [handle,timer] of [...timers])if(timer.kind==='owner'&&timer.at<=time){timers.delete(handle);timer.callback();await flush();}
  }
  await stopping;
  assert.equal(underlyingClosed,true);
  time=mode!=='drain error'?55_500:2000;
  resolveRead({receipt:{harness:'codex',model:'gpt-5.4'}});await flush();
  assert.deepEqual(events.filter(event=>event.afterClose),[],'neither job completion nor app_closed may publish after telemetry.close');
  assert.equal(lateBootstraps,0,'late completion cannot bootstrap a closed telemetry sink');
  assert.deepEqual(factsDeadlines,[55_000],'the owner clock and absolute cutoff include synchronous close work');
  assert.equal(timers.size,0,'release cancels every remaining facts timer');
});
