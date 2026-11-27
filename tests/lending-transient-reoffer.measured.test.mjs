import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createLender} from '../lib/v1/lender.mjs';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {declineCodeFor} from '../lib/v1/lender-pace50.mjs';
import {isPassingDecline} from '../lib/v1/failures.mjs';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {jobStatusContract} from '../lib/v1/status-contract.mjs';

const inFlight = new Set();
let deliveryPaused = false;
// Drain finite RPCs before advancing the injected clock; watches and their long polls are separate.
async function turn() {
  do { await new Promise(resolve => setImmediate(resolve)); } while(inFlight.size&&!deliveryPaused);
}
async function until(check,label='expected condition',turns=30000) {
  for(let n=0;n<turns;n++){if(await check())return;await turn();}
  assert.fail('Did not reach: '+label);
}
function tracked(client) {
  return new Proxy(client,{get(target,key){
    const value=target[key];
    if(typeof value!=='function'||String(key).startsWith('watch'))return value;
    return (...args)=>{
      if(key==='listOffers')args[0]={...args[0],waitSeconds:0};
      if(key==='claimNext')args[1]={...args[1],waitSeconds:0};
      const call=value.apply(target,args);
      if(!call||typeof call.then!=='function')return call;
      inFlight.add(call);return call.finally(()=>inFlight.delete(call));
    };
  }});
}
function launch(f, client=f.client, policy=f.policy) {
  const controller = new AbortController();
  const lender = createLender({client:tracked(client),backend:f.backend,adapters:f.adapters,policy,clock:f.clock,
    approve:async()=>true,onEvent:e=>f.events.push(e)});
  const loop = lender.start(controller.signal);
  return async()=>{controller.abort();await loop;};
}

for (const [offers,automatic] of [[true,false],[false,false],[true,true]]) test(`retained native exposure reoffers job 2 after coverage (offers=${offers}, auto=${automatic})`,{timeout:30000},async t=>{
  const f = await realLenderFixture(t,{offers,members:true,policy:{mode:automatic?'auto':'ask'},run:{model:'gpt-6-sol'},mutateJob:job=>{job.expires_at='2026-10-09T18:00:00Z';}});
  const start = f.clock.now(); let nextShort = null;
  f.policy.userActive=async()=>false;
  const source=createSyntheticPace50Source({start,override:({base})=>({...base,resources:base.resources.map(r=>({...r,
    conversion:'native_window',kappa_micro:null,kappa_lower_micro:null,
    ...(r.kind==='short'&&nextShort?{instance:'next-short',anchor_at:nextShort,resets_at:nextShort+18000000}:{})}))})});
  const build=source.objectiveInputFor;
  source.objectiveInputFor=args=>({...build(args),strategy:'fixed_share',strategyParams:{fixedSharePct:20,keepPct:0,perJobPct:2}});
  const runtime=createLendingRuntime({directory:join(f.root,'native'),settings:()=>({intent:'on',limits:{lendingPolicy:{providerConsent:{codex:true}}}}),
    backend:{},presence:()=>false,now:f.clock.now,pace50:{postingLagBoundMs:120000,account:'synthetic-account',account_week_id:'synthetic-week-1',source,ownerSettings:{limit:()=>({state:'set',maxJobUsd:2})}}});
  f.policy.lendingRuntime=runtime;
  const old=await runtime.candidate.reserve({attemptId:'job-1',jobId:'job-1',provider:'codex',model:'gpt-6-sol',job:f.job.payload,automatic:true,ownerAbsent:true});
  assert.equal(old.ok,true,JSON.stringify(old));
  await runtime.candidate.started('job-1',{ok:true});
  await runtime.candidate.recordCleanup('job-1',{removed:true});
  f.clock.advance(121000);await runtime.candidate.probeHeld();
  assert.equal(runtime.pace50.state().attempts[0].hold_closed,false);
  // A post-delay reading releases the large hold. Keep a real headroom blocker for this re-offer test.
  source.state.used.weekly=98_000_000;
  let gateCalls=0;
  const gate=runtime.candidate.gate.bind(runtime.candidate);
  runtime.candidate.gate=args=>{if(args.job)gateCalls++;return gate(args);};
  // The fake clock cannot advance HTTP long polls, which use real timers.
  const listOffers=f.client.listOffers.bind(f.client);
  f.client.listOffers=options=>listOffers({...options,waitSeconds:0});
  const declinedJobClaims=new Set();
  let covered=false,reoffered=false,resume;
  const race=new Promise(resolve=>{resume=()=>{deliveryPaused=false;resolve();};});
  for(const method of ['claimJob','claimNext']) {
    if(!f.client[method])continue;
    const claim=f.client[method].bind(f.client);
    f.client[method]=async(...args)=>{
      if(covered){reoffered=true;deliveryPaused=true;await race;}
      if(method==='claimNext')args[1]={...args[1],waitSeconds:0};
      const result=await claim(...args);
      if(result?.job_digest===f.jobDigest)declinedJobClaims.add(result.attempt.attempt_id);
      return result;
    };
  }
  t.after(()=>resume());
  const stopInitial=launch(f);f.stop=async()=>{resume();await stopInitial();};
  if (automatic) await until(()=>gateCalls>0,'automatic screening before claim');
  else await until(()=>f.events.some(e=>e.reason===declineCodeFor('native_attempt_in_flight')),'job 2 declined');
  await until(()=>!f.saved()?.pending&&!f.saved()?.acceptedClaim&&!f.saved()?.declinePending,'decline cleanup');
  const waiting=await f.owner.getJob(f.jobDigest);
  assert.equal(waiting.attempts_started,0);
  const claimRequests=()=>f.realRequests.filter(r=>r.url.includes('/claim')).length;
  // One simulated hour blocked: a five-minute retry ceiling, never a three-second claim loop.
  for(let n=0;n<120;n++){f.clock.advance(30000);await turn();}
  assert.ok(declinedJobClaims.size<=13,`blocked hour claimed the declined job ${declinedJobClaims.size} times`);
  if(automatic)assert.equal(claimRequests(),0,'automatic screen holds the offer without claiming');
  else assert.ok(declinedJobClaims.size>=2,'the blocked-hour simulation includes a retry');
  t.diagnostic(`blocked hour: ${declinedJobClaims.size} claims of the declined job; ${claimRequests()} total claim requests (offers=${offers}, auto=${automatic})`);
  if(automatic)return; // This path screens before claiming; the decline regression is in the two paths above.
  const held=runtime.pace50.state().attempts[0];
  for(const r of held.resources)source.state.used[r.kind]=Math.max(source.state.used[r.kind],r.baseline_used_micro+r.initial_micro);
  f.clock.advance(900001);nextShort=f.clock.now();source.state.used.short=40000000;
  await runtime.candidate.probeHeld();
  assert.equal(runtime.pace50.state().attempts[0].hold_closed,true);
  covered=true;
  for(let n=0;n<12&&!reoffered;n++){f.clock.advance(30000);await turn();}
  await until(()=>reoffered,'original lender reoffers job 2 after coverage',5000);
  // Race another lender against the retry; the coordinator must grant only one run.
  let otherSaved=null;
  const stopOther=launch(f,f.clientFor(3),{...f.policy,storage:{get:async()=>otherSaved,set:async value=>{otherSaved=value;}}});
  const stopFirst=f.stop;f.stop=async()=>{resume();await Promise.all([stopFirst(),stopOther()]);};
  resume();
  for(let n=0;n<12&&!f.events.some(e=>e.status==='finished');n++){f.clock.advance(30000);await turn();}
  await until(()=>f.events.some(e=>e.status==='finished'),'job 2 offered again and run',5000);
  if(!automatic)assert.match(jobStatusContract(waiting).explanation,/ready to try again/);
  await f.stop();
  assert.equal(f.calls.filter(([kind])=>kind==='run').length,1);
  assert.equal((await f.owner.getJob(f.jobDigest)).attempts_started,1);
});
