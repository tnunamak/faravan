import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createLender} from '../lib/v1/lender.mjs';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {declineCodeFor} from '../lib/v1/lender-pace50.mjs';
import {isPassingDecline} from '../lib/v1/failures.mjs';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
import {until} from './helpers/v1-lender-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';

const turn = () => new Promise(resolve => setTimeout(resolve,30));
function launch(f, client=f.client, policy=f.policy) {
  const controller = new AbortController();
  const lender = createLender({client,backend:f.backend,adapters:f.adapters,policy,clock:f.clock,
    approve:async()=>true,onEvent:e=>f.events.push(e)});
  const loop = lender.start(controller.signal);
  return async()=>{controller.abort();await loop;};
}

for (const [offers,automatic] of [[true,false],[false,false],[true,true]]) test(`native exposure keeps the next job blocked (offers=${offers}, auto=${automatic})`,{timeout:30000},async t=>{
  const f = await realLenderFixture(t,{offers,members:true,policy:{mode:automatic?'auto':'ask'},run:{model:'gpt-6-sol'},mutateJob:job=>{job.expires_at='2026-10-09T18:00:00Z';}});
  const start = f.clock.now(); let nextShort = null;
  f.policy.userActive=async()=>false;
  const source=createSyntheticPace50Source({start,override:({base})=>({...base,resources:base.resources.map(r=>({...r,
    conversion:'native_window',kappa_micro:null,kappa_lower_micro:null,
    ...(r.kind==='short'&&nextShort?{instance:'next-short',anchor_at:nextShort,resets_at:nextShort+18000000}:{})}))})});
  const build=source.objectiveInputFor;
  source.objectiveInputFor=args=>({...build(args),strategy:'fixed_share',strategyParams:{fixedSharePct:20,keepPct:0,perJobPct:2}});
  const runtime=createLendingRuntime({directory:join(f.root,'native'),settings:()=>({intent:'on',limits:{lendingPolicy:{providerConsent:{codex:true}}}}),
    backend:{},presence:()=>false,now:f.clock.now,pace50:{account:'synthetic-account',account_week_id:'synthetic-week-1',source,ownerSettings:{limit:()=>({state:'set',maxJobUsd:2})}}});
  f.policy.lendingRuntime=runtime;
  const old=await runtime.candidate.reserve({attemptId:'job-1',jobId:'job-1',provider:'codex',model:'gpt-6-sol',job:f.job.payload,automatic:true,ownerAbsent:true});
  assert.equal(old.ok,true,JSON.stringify(old));
  await runtime.candidate.started('job-1',{ok:true});
  await runtime.candidate.recordCleanup('job-1',{removed:true});
  f.clock.advance(121000);await runtime.candidate.probeHeld();
  assert.equal(runtime.pace50.state().attempts[0].hold_closed,false);
  // A post-delay reading does not release the hold. Keep a real headroom blocker for this re-offer test.
  source.state.used.weekly=98_000_000;
  let gateCalls=0;
  const gate=runtime.candidate.gate.bind(runtime.candidate);
  runtime.candidate.gate=args=>{if(args.job)gateCalls++;return gate(args);};
  // The fake clock cannot advance HTTP long polls, which use real timers.
  const listOffers=f.client.listOffers.bind(f.client);
  f.client.listOffers=options=>listOffers({...options,waitSeconds:0});
  const declinedJobClaims=new Set();
  for(const method of ['claimJob','claimNext']) {
    if(!f.client[method])continue;
    const claim=f.client[method].bind(f.client);
    f.client[method]=async(...args)=>{
      if(method==='claimNext')args[1]={...args[1],waitSeconds:0};
      const result=await claim(...args);
      if(result?.job_digest===f.jobDigest)declinedJobClaims.add(result.attempt.attempt_id);
      return result;
    };
  }
  f.stop=launch(f);
  if (automatic) await until(()=>gateCalls>0,'automatic screening before claim');
  else await until(()=>f.events.some(e=>e.reason===declineCodeFor('native_attempt_in_flight')),'the next job is declined');
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
  const envelope=held.resources.map(r=>r.initial_micro);
  for(const r of held.resources)source.state.used[r.kind]=r.baseline_used_micro+r.initial_micro;
  f.clock.advance(900001);nextShort=f.clock.now();source.state.used.short=40000000;
  await runtime.candidate.probeHeld();
  const after=runtime.pace50.state().attempts[0];
  assert.equal(after.hold_closed,false,'aggregate movement is not interval coverage');
  for(const [index,r] of after.resources.entries()) {
    if(r.resets_at<=f.clock.now()) {
      assert.equal(r.held_micro+r.unrepresented_micro,0,'a reset settles its own resource');
      assert.equal(r.spent_micro+r.settled_micro,r.initial_micro);
    } else assert.equal(r.held_micro+r.unrepresented_micro,envelope[index],
      'an open resource keeps its full unresolved exposure');
    assert.equal(r.released_micro,0);
  }
  // The same real capacity blocker stays in place while the coordinator retries this job.
  source.state.used.weekly=98_000_000;
  const retry=await runtime.candidate.reserve({attemptId:'followup-after-meter-rise',jobId:'followup-after-meter-rise',
    provider:'codex',model:'gpt-6-sol',job:f.job.payload,automatic:true,ownerAbsent:true});
  assert.equal(retry.ok,false,JSON.stringify(retry));
  assert.equal(f.calls.filter(([kind])=>kind==='run').length,0,'the blocked job never launches');
  assert.equal((await f.owner.getJob(f.jobDigest)).attempts_started,0);
  await f.stop();
  assert.equal(runtime.pace50.state().attempts[0].hold_closed,false);
});

test('capacity causes are passing; owner decisions and unknown refusals stay excluded',()=>{
  for(const reason of ['native_attempt_in_flight','window_not_open','meter_coverage_required','objective_evidence_unknown'])
    assert.equal(isPassingDecline(declineCodeFor(reason)),true,reason);
  for(const code of ['quota_reserve','daily_limit','requester_limit'])assert.equal(isPassingDecline(code),true,code);
  for(const code of ['approval_denied','requirements_unsupported','unknown_refusal'])
    assert.equal(isPassingDecline(code),false,code);
});

for(const code of ['approval_denied','requirements_unsupported','unknown_refusal'])
  test(`lasting decline never reoffers over an hour: ${code}`,async t=>{
    const f=await realLenderFixture(t,{offers:true,mutateJob:job=>{job.expires_at='2026-10-09T18:00:00Z';}});
    let prepares=0;
    f.backend.prepare=async()=>{prepares++;throw Object.assign(new Error(code),{code});};
    f.stop=launch(f);
    await until(()=>f.events.some(e=>e.status==='preparation-failed'),'lasting decline');
    for(let n=0;n<12;n++){f.clock.advance(300000);await turn();}
    assert.equal(prepares,1);
    assert.equal(f.calls.filter(([kind])=>kind==='run').length,0);
  });

for(const offers of [true,false]) test(`a declined native job does not delay a different runnable job (offers=${offers})`,{timeout:60000},async t=>{
  const f=await realLenderFixture(t,{offers,mutateJob:job=>{job.expires_at='2026-10-09T18:00:00Z';}});
  const declinedJob=f.jobDigest;
  f.policy.lendingRuntime.candidate.gate=async({jobId})=>jobId===declinedJob?'native_attempt_in_flight':null;
  f.stop=launch(f);
  await until(()=>f.events.some(e=>e.reason==='native_attempt_in_flight'),'job A declined');
  await until(()=>!f.saved()?.pending&&!f.saved()?.acceptedClaim&&!f.saved()?.declinePending,'job A cleanup');
  const runnableJob=await f.submit();
  const declinedAt=f.clock.now();
  for(let n=0;n<6;n++){f.clock.advance(1000);await turn();}
  await until(()=>f.events.some(e=>e.status==='finished'),'job B finishes within six seconds of clock time');
  const [a,b]=await Promise.all([f.owner.getJob(declinedJob),f.owner.getJob(runnableJob)]);
  assert.equal(a.attempts_started,0);
  assert.equal(b.state,'result-accepted');
  assert.equal(b.attempts_started,1);
  assert.equal(f.calls.filter(([kind])=>kind==='run').length,1);
  assert.ok(f.clock.now()-declinedAt<=6000);
  t.diagnostic(`job B claimed ${Date.parse(b.current_attempt.claimed_at)-declinedAt} ms after job A was declined; finished within 6000 ms`);
  assert.equal(f.saved().declined.find(row=>row.jobDigest===declinedJob).expiresAt,declinedAt+300000,
    'the longer exclusion applies only to job A');
});

test('user_active keeps its three-second per-job exclusion',async t=>{
  const f=await realLenderFixture(t,{offers:true});
  f.policy.lendingRuntime.candidate.gate=async({jobId})=>jobId?'user_active':null;
  f.stop=launch(f);
  await until(()=>f.events.some(e=>e.reason==='user_active'),'owner activity decline');
  const exclusion=f.saved().declined.find(row=>row.jobDigest===f.jobDigest);
  assert.equal(exclusion.expiresAt-f.clock.now(),3000);
  assert.equal(f.saved().declineUntil-f.clock.now(),3000);
});

test('a structural passing decline excludes the same job for five minutes',async t=>{
  const f=await realLenderFixture(t,{offers:true});
  f.policy.lendingRuntime.candidate.gate=async({jobId})=>jobId?'resources_incomplete':null;
  f.stop=launch(f);
  await until(()=>f.events.some(e=>e.reason==='resources_incomplete'),'structural decline');
  const exclusion=f.saved().declined.find(row=>row.jobDigest===f.jobDigest);
  assert.equal(exclusion.expiresAt-f.clock.now(),300000);
  assert.equal(f.saved().declineUntil-f.clock.now(),3000,'other jobs keep the short global wait');
});

test('a refusal from a limit window that stopped being reported or cannot be read is reconsidered', ()=>{
  for(const reason of ['lending_window_missing','lending_window_memory_unreadable', 'lending_window_invalid'])
    assert.equal(isPassingDecline(reason),true,reason);
});
