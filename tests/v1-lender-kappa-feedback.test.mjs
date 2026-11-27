import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createLender} from '../lib/v1/lender.mjs';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {parseGuardLine} from '../lib/faravan-guard-host.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {lenderFixture,until,deferred} from './helpers/v1-lender-fixture.mjs';

// The lender's abort bound after a delivered provider-limit Stop.
const PROVIDER_LIMIT_STOP_ANSWER_MS=45000;
const PROVIDER_LIMIT_STOP_RETURN_MS=10000;

for (const delivery of ['delivered', 'finished', 'unproven', 'throws', 'hangs', 'running', 'running-repeat', 'hangs-returned', 'running-returned'])
test(`parsed guard meter travels through real lender onMeter and durably reprices the running attempt (${delivery})`, {timeout:60000},async t=>{
 const f=await lenderFixture(t,{hold:true,policy:{mode:'auto'},run:{model:'gpt-6-sol'},
  mutateJob:job=>{job.budget_v1={max_list_usd:10};job.requirements.capabilities.push('budget_v1');}});
 f.policy.userActive=async()=>false;
 const source=createSyntheticPace50Source({start:f.clock.now(),used:{weekly:0,short:0},kappa:{weekly:100000,short:100000}});
 const runtime=createLendingRuntime({directory:join(f.root,'pace50'),now:f.clock.now,
  settings:()=>({intent:'on',limits:{lendingPolicy:{}}}),pace50:{source,account:'synthetic-account',account_week_id:'synthetic-week-1',
   contextFor:()=>({consent:true,ownerAbsent:true})}});
 f.policy.lendingRuntime=runtime;
 // The lender calls finish only after runJob has returned and jobReturned=true.
 // This observes that boundary without waiting for durable settlement/finished,
 // which can still be waiting for the in-flight Stop recheck.
 let returnedToLender=false;
 const finish=runtime.candidate.finish.bind(runtime.candidate);
 runtime.candidate.finish=(...args)=>{returnedToLender=true;return finish(...args);};
 const stopAnswer=deferred();
 const original=f.backend.start.bind(f.backend);let delivered=false, executionSignal;
 const stops=[];
 f.backend.requestStop=async(handle,reason)=>{
  stops.push(reason);
  if(delivery==='throws')throw new Error('synthetic Stop delivery failure');
  if(delivery.startsWith('hangs'))return new Promise(()=>{});
  if(delivery==='running-returned')return stopAnswer.promise;
  if(['delivered','finished'].includes(delivery))f.execution.resolve();
  // 'running' answers delivered but its run keeps going, against the backend contract.
  return {delivered:['delivered','running','running-repeat','running-returned'].includes(delivery), ...(delivery==='finished'?{running:false}:{})};
 };
 f.backend.start=(handle,opts={})=>original(handle,{...opts,onMeter:()=>{
  source.state.used.weekly=3e6;source.state.used.short=3e6;
  const frame=JSON.stringify({type:'faravan.meter',v:1,seq:1,at:new Date(f.clock.now()).toISOString(),source:'codex-rollout',
   tokens:{},cost_usd:10,windows:[],final:false});
  executionSignal=opts.signal;
  const parsed=parseGuardLine(frame);assert.equal(parsed.type,'meter');delivered=true;
  opts.onMeter(parsed);
 }});
 const controller=new AbortController();
 const lender=createLender({client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock,
  approve:async()=>true,onEvent:event=>f.events.push(event)});
 const run=lender.start(controller.signal);run.catch(()=>{});
 f.stop=async()=>{
  controller.abort();f.execution.resolve();stopAnswer.resolve({delivered:true});
  // Failure cleanup must also release a pending fake-clock Stop answer.
  f.clock.advance(PROVIDER_LIMIT_STOP_ANSWER_MS);
  let timer;
  try {await Promise.race([run.catch(error=>{if(error.name!=='AbortError')throw error;}),
   new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('lender shutdown timed out')),2000);})]);}
  finally {clearTimeout(timer);}
 };
 await until(()=>runtime.pace50.state().rate_feedback?.blocked,'guard event produced durable feedback');
 await until(()=>stops.length>0,'feedback requested graceful Stop');
 assert.equal(stops[0],'provider_limit');
 if(delivery==='running-returned'){
  await until(()=>f.clock.pending().includes(PROVIDER_LIMIT_STOP_ANSWER_MS),'Stop answer timer is armed');
  stopAnswer.resolve({delivered:true});
 }
 const providerLimitStop=()=>f.events.some(e=>e.status==='stopping'&&e.reason==='provider_limit');
 // A Stop that never answers, or a run still going after a delivered Stop, must not keep spending: the lender aborts.
 if(['hangs','running','running-repeat'].includes(delivery)) {
  const bound=delivery==='hangs'?PROVIDER_LIMIT_STOP_ANSWER_MS:PROVIDER_LIMIT_STOP_RETURN_MS;
  await until(()=>f.clock.pending().includes(bound),'bounded Stop timer is armed');
  assert.ok(executionSignal,'real lender execution signal captured');
  if(delivery==='running-repeat'){
   // A second provider-limit hit before the bound must not push the abort later.
   f.clock.advance(bound-1000);
   const entry=runtime.candidate.registry.entry(runtime.pace50.state().attempts[0].id);
   await entry.stop('provider_limit');
   assert.equal(stops.length,2,'the second hit asked for Stop again');
   f.clock.advance(999);
   await Promise.resolve();
   assert.equal(executionSignal.aborted,false,'must not abort before the first bound');
   f.clock.advance(1);
   await until(()=>executionSignal.aborted,'must abort at the first bound');
  }else{
  f.clock.advance(bound-1);
  await Promise.resolve();
  assert.equal(executionSignal.aborted,false,'must not abort before the bound');
  assert.equal(providerLimitStop(),false,'must not emit stopping before the bound');
  f.clock.advance(1);
  await until(()=>executionSignal.aborted,'must abort at the bound');
  }
  assert.equal(providerLimitStop(),true,'must emit stopping at the bound');
 }
 // Capture the pending recheck now instead of relying on a later registry lookup.
 const rechecking=runtime.candidate.registry.entry(runtime.pace50.state().attempts[0].id).rechecking;
 let rechecked=false,recheckError;
 Promise.resolve(rechecking).then(()=>{rechecked=true;},error=>{recheckError=error;rechecked=true;});
 if(['hangs-returned','running-returned'].includes(delivery)) {
  const bound=delivery==='hangs-returned'?PROVIDER_LIMIT_STOP_ANSWER_MS:PROVIDER_LIMIT_STOP_RETURN_MS;
  await until(()=>f.clock.pending().includes(bound),'bounded Stop timer is armed');
  assert.ok(executionSignal,'real lender execution signal captured');
  f.execution.resolve();
  await until(()=>returnedToLender,'runJob returned to the lender before the Stop deadline');
  assert.equal(executionSignal.aborted,false);
  assert.equal(providerLimitStop(),false);
  if(delivery==='hangs-returned'){
   assert.ok(f.clock.pending().includes(bound),'unanswered Stop deadline is still pending after return');
   // Only now release the answer race; do not wait for finished first.
   f.clock.advance(bound);
  }else{
   await until(()=>f.events.some(e=>e.status==='finished'),'returned run finishes');
   await until(()=>!f.clock.pending().includes(PROVIDER_LIMIT_STOP_RETURN_MS),'settlement clears the return timer');
   // The return timer is canceled, not fired. Crossing its former deadline
   // tests cleanup; removing only the post-answer guard does not break this case.
   f.clock.advance(bound);
  }
  await until(()=>rechecked,'late Stop recheck settles');
  if(recheckError)throw recheckError;
  assert.equal(executionSignal.aborted,false,'late timeout must not abort a returned job');
  assert.equal(providerLimitStop(),false,'late timeout must not emit a stale stopping event');
  await until(()=>f.events.some(e=>e.status==='finished'),'returned run finishes after Stop recheck');
 }
 await until(()=>rechecked,'Stop recheck settles');
 if(recheckError)throw recheckError;
 if(['delivered','finished'].includes(delivery)){
  await until(()=>f.events.some(e=>['finished','failed','stopped'].includes(e.status)),'run returned');
  f.clock.advance(PROVIDER_LIMIT_STOP_RETURN_MS);
  assert.equal(providerLimitStop(),false,'a delivered Stop or a finished guard must preserve the metered result');
 }
 if(['unproven','throws'].includes(delivery))await until(()=>f.events.some(e=>e.status==='stopping'&&e.reason==='provider_limit'),'unproven delivery falls back to abort');
 assert.equal(delivered,true);
 assert.ok(runtime.pace50.state().attempts[0].resources.every(r=>r.kappa_micro===300000));
 await f.stop();
});
