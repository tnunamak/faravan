import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createLendingLedger} from '../lib/v1/lending-ledger.mjs';
import {createLendingProbe,createLendingReadings,PROBE_USAGE_LINE} from '../lib/v1/lending-probe.mjs';
import {createLendingReadingRunner} from '../lib/v1/lending-reading-runner.mjs';
import {createGuardReads} from '../lib/v1/guard-read.mjs';
import {createRealPace50Source} from './helpers/real-source.mjs';
import {strategyCeilingMicro,normalizeLendingPolicy} from '../lib/v1/lending-policy.mjs';
import {LIVE_QUOTA_POLL_MS,LIVE_QUOTA_STALE_MS,LIVE_QUOTA_APP_SIDE_BOUND_MS,LIVE_QUOTA_INITIAL_READ_GRACE_MS,LIVE_QUOTA_STARTUP_APP_SIDE_BOUND_MS,PROVIDER_LIMIT_STOP_ANSWER_MS,PROVIDER_LIMIT_STOP_RETURN_MS} from '../lib/v1/lending-quota-timing.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {NOW,MICRO as M} from './helpers/pace50-fixtures.mjs';

const ID={status:200,account_sha256_16:'1111222233334444',email_sha256_16:'aaaabbbbccccdddd'};
const MODEL='claude-haiku-5-5';
const drain=async () => {for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));};
function fakeTime() {
  let at=NOW,seq=0;
  const timers=new Map();
  const setTimer=(fn,ms)=>{const id=++seq;timers.set(id,{fn,at:at+ms});return id;};
  const clearTimer=id=>timers.delete(id);
  return {now:()=>at,setTimer,clearTimer,async advanceTo(end){
    for(;;){await drain();const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];
      if(!next||next[1].at>end)break;
      at=next[1].at;timers.delete(next[0]);next[1].fn();}
    at=end;await drain();
  }};
}

async function readingStack(t,{native=true,mode='fresh',clock=fakeTime(),directory=null,perJobPct=100}={}) {
  directory??=await mkdtemp(join(tmpdir(),'owner-reading-'));
  const startedAt=clock.now();
  const meter={owner:20,lent:0,reported:20},calls=[],observations=[],coldRuns=[],hostReads=[];
  let running=false;
  const output=()=>PROBE_USAGE_LINE+',"status":200}\n'+JSON.stringify({faravan_probe:1,status:200,identity:ID,
    guest_auth:{loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'},body:{
      five_hour:{utilization:40,resets_at:new Date(startedAt+1.25*3600e3).toISOString()},
      seven_day:{utilization:mode==='repeated-body'?meter.reported:meter.owner+meter.lent,resets_at:new Date(startedAt+42*3600e3).toISOString()},
      extra_usage:{is_enabled:false}}})+'\n';
  const runner=createLendingReadingRunner({reader:{read:args=>reader.read({...args,cold:true})}});
  // The guard reads from the host with the account's own credential: a fake provider answers, and no sandbox is involved.
  const reader={async read({provider,accountKey,signal,cold=false}){
    const dispatched=clock.now();if(!cold)hostReads.push({at:dispatched,provider,accountKey});
    if(mode==='failed'&&!cold)throw new Error('fake provider transport failed');
    if(!cold&&['hung','delayed'].includes(mode))await new Promise((resolve,reject)=>{
      let timer;
      const abort=()=>{clock.clearTimer(timer);reject(signal.reason);};
      signal.addEventListener('abort',abort,{once:true});
      if(mode==='delayed')timer=clock.setTimer(()=>{signal.removeEventListener('abort',abort);resolve();},45_000);
    });
    return {exitCode:0,stdout:output(),usage_seen_at:dispatched,host_read:true,account_key:accountKey,generation:'g1'};
  }};
  const cold=async args=>{coldRuns.push(clock.now());return runner(args);};
  const ledger=createLendingLedger({file:join(directory,'meter.json'),now:clock.now});
  const probe=createLendingProbe({ledger,runGuest:cold,now:clock.now});
  const readings=createLendingReadings({ledger,probe,plans:()=>({claude:'max20'}),jobRunning:()=>running,now:clock.now});
  const real=createRealPace50Source({readings,funding:p=>probe.funding(p),stopBoundMs:35_000,
    expectedIdentity:()=>({email_sha256_16:ID.email_sha256_16}),
    expectedExecutor:{backend_id:'docker-sbx',accepts:v=>v==='test-sbx'},
    windowOrigin:()=>new Map([['five_hour','owner']]),
    ...(native?{}:{kappaForUsage:({window})=>({binding:{account_sha256_16:ID.account_sha256_16},
      upper_micro:window==='weekly'?50_000:200_000,lower_micro:window==='weekly'?50_000:200_000}),kappaFloor:()=>null})});
  const source={...real,async observe(args){const out=await real.observe(args);observations.push(out);return out;}};
  // Only demand/history are simulated; every quota window, timestamp and identity comes from the real reader above.
  const demand=createSyntheticPace50Source({start:startedAt}).objectiveInputFor;
  const policy=normalizeLendingPolicy({strategy:'fixed_share',strategyParams:{fixedSharePct:100,keepPct:30,perJobPct},providerConsent:{claude:true}});
  const first=await source.observe({provider:'claude',model:MODEL,plan:'max20',forceRefresh:true});
  assert.equal(first.identity.account_id,ID.account_sha256_16);
  assert.equal(first.complete,true);
  assert.equal(first.stop.bounded_execution,'proven');
  const options={directory,now:clock.now,account:'reader-test',account_week_id:first.account_week_id,source,
    contextFor:()=>({consent:true,ownerAbsent:true,strategy:policy.strategy,strategyParams:policy.strategyParams,plan:'max20'}),
    objectiveInputFor:args=>({...demand(args),strategy:policy.strategy,strategyParams:policy.strategyParams}),
    ownerSettings:{limit:()=>({state:'set',maxJobUsd:10})},nativeGuard:{setTimer:clock.setTimer,clearTimer:clock.clearTimer},
    ...(mode==='busy'?{}:{guardReads:createGuardReads({reader})})};
  const pace=createPace50Candidate(options),admissionAdapters=[];
  const close=async()=>{for(const adapter of admissionAdapters)await adapter.close();await pace.candidate.cancelObservations();await probe.close();await pace.adapter.close();};
  t.after(async()=>{await close();await rm(directory,{recursive:true,force:true});});
  const job={requirements:{limits:{wall_seconds:300}},expires_at:new Date(startedAt+3600e3).toISOString()};
  return {pace,source,clock,meter,calls,observations,coldRuns,hostReads,job,close,policy,
    freeCandidate(){const free=createPace50Candidate({...options,directory:join(directory,'free')});admissionAdapters.push(free.adapter);return free;},run:()=>{running=true;},
    async start(){const grant=await pace.candidate.reserve({attemptId:'running',jobId:'first',provider:'claude',model:MODEL,job,automatic:true,ownerAbsent:true});
      assert.equal(grant.ok,true,JSON.stringify(grant));await pace.candidate.started('running',{ok:true});running=true;return grant;}};
}

for(const native of [true,false])test(`real ${native?'native':'converted'} readings include concurrent owner usage and refuse and stop at the floor`,async t=>{
  const f=await readingStack(t,{native}),stops=[];
  await f.start();
  f.pace.candidate.registry.bind('running',{stop:reason=>stops.push({reason,at:f.clock.now()})});
  const coldCount=f.coldRuns.length;
  f.meter.owner=70;
  await f.clock.advanceTo(NOW+LIVE_QUOTA_POLL_MS);
  assert.deepEqual(stops,[{reason:native?'allowance_reached':'provider_limit',at:NOW+LIVE_QUOTA_POLL_MS}]);
  assert.ok(stops[0].at-NOW<=LIVE_QUOTA_APP_SIDE_BOUND_MS);
  assert.equal(f.meter.lent,0);
  assert.equal(f.coldRuns.length,coldCount,'the live check makes no sandbox read');
  assert.ok(f.hostReads.length>0&&f.hostReads.every(read=>read.provider==='claude'&&read.accountKey==='claude'),'the live check reads the lent attempt\'s own account from the host');
  const reading=f.observations.at(-1);
  assert.equal(reading.observed_at,NOW+LIVE_QUOTA_POLL_MS);
  assert.equal(reading.identity.account_id,ID.account_sha256_16);
  assert.equal(reading.resources.find(r=>r.kind==='weekly').used_micro,70*M);
  // A separate free execution slot consumes the same real cached reading, without the first job's concurrency hold.
  const free=f.freeCandidate();
  const refusal=await free.candidate.reserve({attemptId:'next',jobId:'second',provider:'claude',model:MODEL,
    job:f.job,automatic:true,ownerAbsent:true});
  assert.equal(refusal.ok,false);
  assert.equal(refusal.policyReason,native?'strategy_limit':'budget_too_small',JSON.stringify(refusal));
  const weekly=reading.resources.find(r=>r.kind==='weekly');
  assert.equal(strategyCeilingMicro(f.policy,{usedMicro:weekly.used_micro,lentMicro:0},f.clock.now()),0);
  assert.equal(free.adapter.state().attempts.length,0);
});

for(const mode of ['failed','busy','hung','delayed'])test(`the real reader fails closed at the stale deadline with ${mode} live reads`,async t=>{
  const f=await readingStack(t,{mode}),stops=[];
  await f.start();
  f.pace.candidate.registry.bind('running',{stop:reason=>stops.push({reason,at:f.clock.now()})});
  f.meter.owner=70;
  await f.clock.advanceTo(NOW+LIVE_QUOTA_STALE_MS-1);
  assert.deepEqual(stops,[]);
  await f.clock.advanceTo(NOW+LIVE_QUOTA_STALE_MS);
  assert.deepEqual(stops,[{reason:'meter_stale',at:NOW+LIVE_QUOTA_STALE_MS}]);
  assert.ok(stops[0].at-NOW<=LIVE_QUOTA_APP_SIDE_BOUND_MS);
  if(mode==='delayed'){
    await f.clock.advanceTo(NOW+75_000);
    assert.equal(f.observations.at(-1).observed_at,NOW+30_000,'late delivery keeps the dispatch timestamp');
    assert.equal(f.pace.candidate.nativeGuard.status('running').last_fresh_at,NOW);
  }
});

test('fresh host timestamps cannot bound a provider that repeats an old usage body',async t=>{
  const f=await readingStack(t,{mode:'repeated-body'}),stops=[];
  await f.start();f.pace.candidate.registry.bind('running',{stop:reason=>stops.push(reason)});
  f.meter.owner=70;
  await f.clock.advanceTo(NOW+120_000);
  assert.deepEqual(stops,[],'the provider has not reported the owner usage yet');
  assert.equal(f.observations.at(-1).observed_at,NOW+120_000);
  assert.equal(f.observations.at(-1).resources.find(r=>r.kind==='weekly').used_micro,20*M);
  f.meter.reported=70;
  await f.clock.advanceTo(NOW+150_000);
  assert.deepEqual(stops,['allowance_reached'],'the next real read stops once the provider reports the rise');
});

for(const native of [true,false])for(const answered of [true,false])test(`real ${native?'native':'converted'} meter exhaustion reaches stop and cleanup within the app budget (answer=${answered})`, {timeout:60000},async t=>{
  const {createLender}=await import('../lib/v1/lender.mjs');
  const {lenderFixture,until}=await import('./helpers/v1-lender-fixture.mjs');
  const f=await lenderFixture(t,{hold:true,harness:'claude-code-subscription',run:{model:MODEL},
    policy:{mode:'auto',idleOnly:false,lendingPolicy:normalizeLendingPolicy(),userActive:()=>assert.fail('presence is off')},
    mutateJob:payload=>{payload.requirements.limits.wall_seconds=300;payload.requirements.model={any_of:[MODEL]};}});
  f.adapters[0].models=[MODEL];
  const clock={now:f.clock.now,setTimer:f.clock.setTimeout,clearTimer:f.clock.clearTimeout};
  const reading=await readingStack(t,{native,clock,directory:join(f.root,'real-reader')});
  f.policy.lendingRuntime={candidate:reading.pace.candidate,effortMax:()=> 'high',close:reading.close};
  const requests=[],cancels=[];
  f.backend.requestStop=async (handle,reason)=>{requests.push({at:clock.now(),reason});
    if(!answered)return new Promise(()=>{});
    await new Promise(resolve=>clock.setTimer(resolve,PROVIDER_LIMIT_STOP_ANSWER_MS-5000));return {delivered:true};};
  const cancel=f.backend.cancel.bind(f.backend);
  f.backend.cancel=async (...args)=>{cancels.push(clock.now());return cancel(...args);};
  const start=f.backend.start.bind(f.backend);
  f.backend.start=(handle,options)=>start(handle,{...options,onMeter:()=>{}});
  const controller=new AbortController();
  const lender=createLender({client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock,
    onEvent:event=>f.events.push(event)});
  const running=lender.start(controller.signal);
  f.stop=async()=>{controller.abort();await running;};
  await f.entered.promise;
  reading.run();reading.meter.owner=70;
  const crossedAt=clock.now();
  for(let elapsed=0;elapsed<LIVE_QUOTA_APP_SIDE_BOUND_MS;elapsed+=5000){
    f.clock.advance(5000);await drain();
    if(cancels.length)break;
  }
  assert.deepEqual(requests,[{reason:'provider_limit',at:crossedAt+LIVE_QUOTA_POLL_MS}]);
  assert.equal(cancels[0],crossedAt+LIVE_QUOTA_POLL_MS+PROVIDER_LIMIT_STOP_ANSWER_MS+
    (answered?PROVIDER_LIMIT_STOP_RETURN_MS-5000:0));
  assert.ok(cancels[0]-crossedAt<=LIVE_QUOTA_APP_SIDE_BOUND_MS);
  await until(()=>reading.pace.adapter.state().attempts[0]?.cleanup_proven===true,'backend cleanup is recorded separately from the stop request');
  assert.equal(reading.meter.lent,0);
  await f.stop();
});

test('an older cached admission keeps the existing 180-second first-live-read grace',async t=>{
  const f=await readingStack(t,{mode:'hung'}),stops=[];
  await f.clock.advanceTo(NOW+5*60_000);
  await f.start();
  const launchedAt=f.clock.now();
  f.pace.candidate.registry.bind('running',{stop:reason=>stops.push({reason,at:f.clock.now()})});
  await f.clock.advanceTo(launchedAt+LIVE_QUOTA_INITIAL_READ_GRACE_MS-1);
  assert.deepEqual(stops,[]);
  await f.clock.advanceTo(launchedAt+LIVE_QUOTA_INITIAL_READ_GRACE_MS);
  assert.deepEqual(stops,[{reason:'meter_stale',at:launchedAt+180_000}]);
  assert.equal(LIVE_QUOTA_APP_SIDE_BOUND_MS,145_000);
  assert.equal(LIVE_QUOTA_STARTUP_APP_SIDE_BOUND_MS,235_000);
});

for(const native of [true,false])test(`real ${native?'native':'converted'} quota exhaustion preserves final work through the lender`,{timeout:60000},async t=>{
  const {createLender}=await import('../lib/v1/lender.mjs');
  const {lenderFixture,until}=await import('./helpers/v1-lender-fixture.mjs');
  const text='Final work after quota stop.';
  const f=await lenderFixture(t,{hold:true,harness:'claude-code-subscription',run:{model:MODEL},
    stdout:JSON.stringify({type:'result',subtype:'success',is_error:false,result:text,model:MODEL,
      total_cost_usd:0.01,usage:{input_tokens:1,output_tokens:1}})+'\n',
    policy:{mode:'auto',idleOnly:false,lendingPolicy:normalizeLendingPolicy(),userActive:()=>assert.fail('presence is off')},
    mutateJob:payload=>{payload.requirements.limits.wall_seconds=300;payload.requirements.model={any_of:[MODEL]};}});
  f.adapters[0].models=[MODEL];
  const clock={now:f.clock.now,setTimer:f.clock.setTimeout,clearTimer:f.clock.clearTimeout};
  const reading=await readingStack(t,{native,perJobPct:10,clock,directory:join(f.root,'real-reader')});
  f.policy.lendingRuntime={candidate:reading.pace.candidate,effortMax:()=> 'high',close:reading.close};
  const requests=[],guardReasons=[],finalExecutions=[];
  const meter={tokens:{input:1,output:1},model:MODEL,cost_usd:0.01,final:true,limit_reached:true};
  let stoppingHandle;
  f.backend.requestStop=async(handle,reason)=>{
    requests.push(reason);guardReasons.push(reading.pace.candidate.nativeGuard.status(reading.pace.adapter.state().attempts[0].id)?.stop_reason);
    stoppingHandle=handle;f.execution.resolve();return {delivered:true};
  };
  const start=f.backend.start.bind(f.backend);
  f.backend.start=async(handle,options)=>{
    const result=await start(handle,{...options,onMeter:()=>{}});
    return handle===stoppingHandle?{...result,stop:{stop_reason:requests.at(-1)},meter}:result;
  };
  const finish=reading.pace.candidate.finish.bind(reading.pace.candidate);
  reading.pace.candidate.finish=async args=>{finalExecutions.push(args.execution);return finish(args);};
  const controller=new AbortController();
  const lender=createLender({client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock,
    onEvent:event=>f.events.push(event)});
  const running=lender.start(controller.signal);
  f.stop=async()=>{controller.abort();await running;};
  await f.entered.promise;
  reading.run();reading.meter.owner=30;
  f.clock.advance(LIVE_QUOTA_POLL_MS);await drain();
  await until(()=>requests.length||f.calls.some(([kind])=>kind==='cancel'),'quota stop is dispatched');
  assert.deepEqual(requests,['provider_limit'],'native and converted allowance exhaustion request the graceful stop');
  assert.deepEqual(guardReasons,['allowance_reached']);
  await until(()=>f.count('/complete')===1,'the final result reaches the borrower');
  assert.deepEqual(finalExecutions[0].lending_meter,meter,'the final metered result reaches accounting');
  assert.equal(f.calls.filter(([kind])=>kind==='cancel').length,0,'a successful final return is not aborted');
  assert.equal(f.count('/release'),0);
  const transcript=f.artifacts.get(f.result.payload.transcript.digest).toString();
  assert.match(transcript,/Stopped at the provider limit\./);
  assert.ok(transcript.includes(text),'the returned work is retained');
  assert.ok(f.artifacts.has(f.result.payload.candidate.digest));
  assert.equal(f.result.payload.receipt.usage.input_tokens,1);
  assert.equal(f.result.payload.receipt.usage.output_tokens,1);
  assert.ok(!f.events.some(event=>event.status==='stopped'&&event.reason==='allowance_reached'));
  await f.stop();
});
