import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitingSummary,jobStatusContract,jobEventSignature } from '../lib/v1/status-contract.mjs';
const now=Date.parse('2026-10-20T12:00Z');
test('waiting names aggregate availability without exposing private budgets',()=>{
  const devices=[{device:'self',online:true,intent:{state:'ready'}},{device:'a',online:true,source:'heartbeat',last_heartbeat_at:new Date(now).toISOString(),intent:{state:'ready'},budget:{remaining:12}},
    {device:'b',online:true,source:'heartbeat',last_heartbeat_at:new Date(now).toISOString(),intent:{state:'running'}},
    {device:'c',online:true,source:'heartbeat',last_heartbeat_at:new Date(now).toISOString(),intent:{state:'resting'}}];
  const result=waitingSummary({devices},{id:'self',now});
  assert.match(result,/1 computer is ready/);assert.match(result,/1 computer is answering another job/);assert.match(result,/1 computer is keeping time for itself/);
  assert.doesNotMatch(result,/12|budget|quota|%/);
});
test('a ready computer without a matching account offer does not count as ready for the signed job',()=>{
  const lender={device:'lender',online:true,source:'heartbeat',last_heartbeat_at:new Date(now).toISOString(),intent:{state:'ready'}};
  const view={state:'queued',presence:{devices:[lender]}};
  const held=jobStatusContract(view,{now,accountMismatchDevices:new Set([lender.device])});
  assert.equal(held.explanation,'Nobody can take it right now · 1 computer is not offering the requested model or effort.');
  assert.match(jobStatusContract(view,{now,accountMismatchDevices:new Set()}).explanation,/1 computer is ready/);
  assert.match(jobStatusContract(view,{now}).explanation,/1 computer is ready/,'ordinary harness jobs keep their legacy readiness');
});
test('a poll without fresh account offers keeps signed-job availability unknown',()=>{
  const polled={device:'lender',online:true,source:'poll',last_poll_at:new Date(now).toISOString(),intent:{state:'ready'}};
  const view={state:'queued',presence:{devices:[polled]}};
  const signed=jobStatusContract(view,{now,accountMismatchDevices:new Set([polled.device])});
  assert.match(signed.explanation,/^Waiting for someone to run it/);
  assert.match(signed.explanation,/account availability is unconfirmed/);
  assert.doesNotMatch(signed.explanation,/not offering|computer is ready/);
  const legacy = jobStatusContract(view,{now}).explanation;
  assert.match(legacy, /lending status is unconfirmed/);
  assert.doesNotMatch(legacy, /computer is ready/);
});
test('missing and stale presence do not invent readiness',()=>{
  assert.equal(waitingSummary(null),null);
  assert.match(waitingSummary({devices:[{online:true,intent:{state:'ready'},last_heartbeat_at:'2020-01-01'}]},{now}),/hasn.t checked in recently/);
});
test('inherited and unknown waiting reasons retain fixed string explanations',()=>{
  for(const waiting_reason of ['constructor','toString','valueOf','unknown_reason'])
    assert.equal(jobStatusContract({state:'queued',waiting_reason},{now}).explanation,'Waiting for someone to run it.');
});
test('contract identifies responsibility, observation and actions, without invented start time',()=>{
  const c=jobStatusContract({state:'queued',presence:{devices:[]}},{now});
  assert.equal(c.lifecycle,'waiting');assert.equal(c.responsibleParty,'circle');assert.deepEqual(c.allowedActions,['cancel']);assert.equal(c.observedAt,new Date(now).toISOString());assert.equal(c.nextCheckAt,null);
  assert.equal(jobStatusContract({state:'cancelled',current_attempt:{compute_stopped:false}},{now}).lifecycle,'stop_requested');
  assert.equal(jobStatusContract({state:'queued',waiting_reason:'daily_limit'},{now}).explanation,
    'Available computers have reached their daily limit.');
});

test('an unconfirmed launch takes precedence over lender availability until the job is requeued', () => {
  const at = new Date(now).toISOString();
  const lender = {
    device: 'lender', online: true, source: 'heartbeat', last_heartbeat_at: at, intent: {state: 'ready'},
  };
  const current_attempt = {
    state: 'released', execution_started_at: at, execution_observed_at: null,
    compute_stopped: false, lease_expires_at: at,
  };
  const job = {state: 'claimed', current_attempt, expiry: new Date(now + 300_000).toISOString()};
  for (const devices of [[], [lender]]) {
    const status = jobStatusContract({...job, presence: {devices}}, {now});
    assert.equal(status.lifecycle, 'waiting');
    assert.equal(status.explanation, 'Waiting for the lender to confirm the last try stopped.');
  }
  const requeued = jobStatusContract({...job, state: 'queued', presence: {devices: [lender]}}, {now});
  assert.match(requeued.explanation, /1 computer is ready/);
});

test('observing unchanged status again does not generate another job event',()=>{
 const view={state:'queued',statusContract:{lifecycle:'waiting',observedAt:'2026-10-20T12:00Z'},
  jobProjection:{schemaVersion:2,kind:'job',phase:'waiting',reasonCode:null,times:{observedAt:'2026-10-20T12:00:00Z'}}};
 assert.equal(jobEventSignature(view),jobEventSignature({...view,statusContract:{...view.statusContract,observedAt:'2026-10-20T12:01Z'},
  jobProjection:{...view.jobProjection,times:{observedAt:'2026-10-20T12:01:00Z'}}}));
 assert.notEqual(jobEventSignature(view),jobEventSignature({...view,state:'claimed'}));
 assert.notEqual(jobEventSignature(view),jobEventSignature({...view,jobProjection:{...view.jobProjection,phase:'approved'}}));
});
test('stale availability names computers and says what the missing signal means',()=>{
 const line=waitingSummary({devices:[{device:'a',deviceName:'kestrel',online:false,last_heartbeat_at:'2026-10-20T11:20:00Z'}]},{now,timeZone:'UTC'});
 assert.match(line,/kestrel hasn.t checked in since 11:20 AM/);assert.doesNotMatch(line,/1 was|Availability does not guarantee/);
});

test('new check-in times for an online lender do not turn an unchanged waiting job into a job event',()=>{
  const device={device:'a',online:true,source:'poll',last_poll_at:'2026-10-20T12:00Z',last_heartbeat_at:'2026-10-20T11:59Z',intent:{state:'ready'}};
  const before={state:'queued',presence:{devices:[device]}};
  const after={...before,presence:{devices:[{...device,last_poll_at:'2026-10-20T12:01Z',last_heartbeat_at:'2026-10-20T12:01Z'}]}};
  assert.equal(jobEventSignature(before),jobEventSignature(after));
  assert.notEqual(jobEventSignature(before),jobEventSignature({...after,presence:{devices:[{...device,online:false}]}}));
  assert.notEqual(jobEventSignature(before),jobEventSignature({...after,presence:{devices:[{...device,intent:{state:'running'}}]}}));
  const offline={...device,online:false};
  assert.notEqual(jobEventSignature({presence:{devices:[offline]}}),jobEventSignature({presence:{devices:[{...offline,last_poll_at:'2026-10-20T12:01Z'}]}}),'offline last-known check-in remains meaningful');
});

test('O4: a lender at its daily cap or without the job agent is not counted as ready',()=>{
  const at=new Date(now).toISOString(),base={online:true,source:'heartbeat',last_heartbeat_at:at};
  const capped={...base,device:'m',personName:'Maya Okafor',deviceName:'kestrel',intent:{state:'resting',reason:'daily_limit'}};
  let line=waitingSummary({devices:[capped]},{now});
  assert.doesNotMatch(line,/is ready|Another computer may still take/);
  assert.match(line,/^Nobody can take it right now · Maya Okafor is done for today\.$/);
  // A heartbeat sent before the cap carries the exhausted budget; it still is not ready.
  line=waitingSummary({devices:[{...capped,intent:{state:'ready'},budget:{jobs_left_today:0,minutes_left_today:12}}]},{now});
  assert.match(line,/Maya Okafor is done for today/);assert.doesNotMatch(line,/12|is ready/);
  line=waitingSummary({devices:[{...base,device:'a',intent:{state:'ready'},agents:[{adapter:'claude-code',readiness:'ready'}]}]},{now,harnesses:['codex']});
  assert.match(line,/^Nobody can take it right now · 1 computer doesn't lend the agent this job needs\.$/);
  line=waitingSummary({devices:[{...base,device:'a',intent:{state:'ready'},agents:[{adapter:'codex',readiness:'ready'}]}]},{now,harnesses:['codex']});
  assert.match(line,/1 computer is ready\. Another computer may still take this job\./);
  assert.match(jobStatusContract({state:'queued',job:{payload:{requirements:{harness:['codex']}}},presence:{devices:[{...base,device:'a',intent:{state:'ready'},agents:[{adapter:'gemini',readiness:'ready'}]}]}},{now}).explanation,/^Nobody can take it right now/);
});

test('O-F: a lender who is off and out of jobs today is named and called done for today, with a noun on every count',()=>{
  const at=new Date(now).toISOString(),base={online:true,source:'heartbeat',last_heartbeat_at:at};
  const maya={...base,device:'m',personName:'Maya Okafor',deviceName:'kestrel',intent:{state:'off'},budget:{jobs_left_today:0,minutes_left_today:30}};
  assert.equal(waitingSummary({devices:[maya]},{now}),"Nobody can take it right now · Maya Okafor isn't lending (done for today).");
  // Off with time left: named, no "done" claim.
  assert.equal(waitingSummary({devices:[{...maya,budget:{jobs_left_today:2,minutes_left_today:30}}]},{now}),"Nobody can take it right now · Maya Okafor isn't lending.");
  // Unnamed: the count still has a noun.
  assert.equal(waitingSummary({devices:[{...maya,personName:undefined,deviceName:undefined,budget:undefined}]},{now}),"Nobody can take it right now · 1 computer isn't lending.");
  const many=waitingSummary({devices:[{...base,device:'a',intent:{state:'running'}},{...base,device:'b',intent:{state:'running'}},{...base,device:'c',intent:{state:'resting'}}]},{now});
  assert.match(many,/2 computers are answering another job/);assert.match(many,/1 computer is keeping time for itself/);
});
// Judge r10 R3: a lender with 18 minutes left reads as done for a job that needs 20, not as "ready".
test('a lender whose minutes left do not fit this job is not ready for it',()=>{
  const lender={device:'a',personName:'Maya Okafor',online:true,source:'heartbeat',last_heartbeat_at:new Date(now).toISOString(),intent:{state:'ready'},
    budget:{jobs_left_today:10,minutes_left_today:18}};
  const tooLong=waitingSummary({devices:[lender]},{id:'self',now,wallSeconds:1200});
  assert.doesNotMatch(tooLong,/is ready/);
  assert.match(tooLong,/Maya Okafor/);
  assert.match(waitingSummary({devices:[lender]},{id:'self',now,wallSeconds:600}),/1 computer is ready/,'a 10-minute job still fits');
});

function failedProjection(reasonCode, failurePhase='result') {
  return {jobProjection:{schemaVersion:2,kind:'job',phase:'failed',reasonCode,
    result:{available:false,digest:null},application:{outcome:null,appliedBranch:null},
    evidence:{rawState:'failed',attemptPresent:true,executionStartedAt:'2026-10-20T11:59:00Z',failurePhase},
    times:{observedAt:new Date(now).toISOString(),nextTransitionAt:null}}};
}
test('meter delivery failure names the lender and offers the same resend as the job page',()=>{
  const c=jobStatusContract(failedProjection('meter_unavailable'),{now});
  assert.equal(c.responsibleParty,'lender');
  assert.equal(c.explanation,'The lender’s computer finished the work but could not send it back because its usage meter was unavailable. Nothing was added to your code. You can send it again or choose another lender.');
  assert.deepEqual(c.allowedActions,['resend']);
});
test('result delivery, lender crashes and lender stops are not attributed to the sender',()=>{
  for(const code of ['completion_rejected','candidate_missing','sandbox_crash','lender_failed','stopped_by_lender','lender_stopped']) {
    const c=jobStatusContract(failedProjection(code),{now});
    assert.equal(c.responsibleParty,'lender',code);
    assert.deepEqual(c.allowedActions,['resend'],code);
  }
  assert.doesNotMatch(jobStatusContract(failedProjection('completion_rejected'),{now}).explanation,/finished the work/);
});
test('execution failures and active responsibility mappings retain their copy',()=>{
  const timeout=jobStatusContract(failedProjection('wall_timeout','run'),{now});
  assert.equal(timeout.explanation,'The job could not finish.');
  assert.equal(timeout.responsibleParty,'you');
  assert.deepEqual(timeout.allowedActions,['followup']);
  for(const phase of ['approval_pending','approved','starting','running','stopping']) {
    const input=failedProjection(null);input.jobProjection.phase=phase;
    assert.equal(jobStatusContract(input,{now}).responsibleParty,'lender',phase);
  }
  const input=failedProjection(null);input.jobProjection.phase='waiting';
  assert.equal(jobStatusContract(input,{now}).responsibleParty,'circle');
});

test('a passing pre-start decline tells the sender the computer can try again',()=>{
 for(const code of ['quota_reserve','daily_limit','requester_limit'])
  assert.match(jobStatusContract({state:'queued',current_attempt:{state:'released',execution_started_at:null,reason:JSON.stringify({code})}}).explanation,/try again/);
 const view={state:'queued',job:{payload:{}},current_attempt:{state:'released',reason:JSON.stringify({code:'resources_incomplete'}),execution_started_at:null}};
 for(const presence of [undefined,{devices:[{device:'lender',online:true,source:'heartbeat',last_heartbeat_at:new Date(now).toISOString(),intent:{state:'ready'}}]}])
  assert.equal(jobStatusContract({...view,presence},{now}).explanation,'A computer could not start this job yet. Waiting for it to be ready to try again. Another computer may still take it.');
 for(const code of ['approval_denied','new_unknown_code']){
  assert.doesNotMatch(jobStatusContract({...view,current_attempt:{...view.current_attempt,reason:JSON.stringify({code})}}).explanation,/try again/);
 }
});
test('a review reported by an old heartbeat does not stay fresh through job polls',()=>{
  const at=ms=>new Date(now-ms).toISOString();
  const review={device:'a',personName:'Sam',online:true,intent:{state:'ready',reason:'approval_pending'},agents:[{adapter:'codex',readiness:'ready'}]};
  assert.equal(waitingSummary({devices:[{...review,source:'heartbeat',last_heartbeat_at:at(5000)}]},{now}),'Waiting for Sam to approve');
  // The heartbeat is ten minutes old; only the polls are fresh. The card may be long gone.
  const polled=waitingSummary({devices:[{...review,source:'poll',last_heartbeat_at:at(600000),last_poll_at:at(2000)}]},{now});
  assert.doesNotMatch(polled,/to approve|is ready/);
});

test('cleanup availability follows the current heartbeat instead of the previous decline', () => {
  const at = new Date(now).toISOString();
  const holder = {device: 'lender', online: true, source: 'heartbeat', last_heartbeat_at: at};
  const current_attempt = {
    state: 'released', holder: holder.device, execution_started_at: null, reason: '{"code":"cleanup_pending"}',
  };
  const job = {state: 'queued', current_attempt};
  const explanationFor = device => jobStatusContract({...job, presence: {devices: [device]}}, {now}).explanation;
  for (const reason of ['cleanup_pending', 'cessation_unverified', 'scratch_cleanup_pending']) {
    const blocked = {...holder, intent: {state: 'blocked', reason}};
    assert.match(explanationFor(blocked), /^Nobody can take it right now · 1 computer is waiting for cleanup/);
    assert.doesNotMatch(explanationFor(blocked), /is ready|isn't lending/);
    const polled = {...blocked, source: 'poll', last_poll_at: at, last_heartbeat_at: new Date(now - 180_000).toISOString()};
    assert.match(explanationFor(polled), /lending status is unconfirmed/);
    assert.doesNotMatch(explanationFor(polled), /waiting for cleanup|is ready/);
    assert.match(explanationFor({...polled, execution: {state: 'running'}}), /lending status is unconfirmed/);
    assert.match(explanationFor({...blocked, execution: {state: 'running'}}), /answering another job/);
  }
  assert.match(explanationFor({...holder, intent: {state: 'ready'}}), /1 computer is ready/);
  assert.doesNotMatch(explanationFor({...holder, intent: {state: 'ready'}}), /cleanup|cleaning/);
  assert.match(jobStatusContract(job, {now}).explanation, /The last try waited.*current status is unavailable/);
});
