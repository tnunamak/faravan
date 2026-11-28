import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext as runVM} from 'node:vm';
import {clientFailure} from '../lib/v1/client.mjs';
function runInNewContext(source,context) {
  context.clientFailure=clientFailure;
  context.resumeRetryAt??=0;context.resumeRetryDelay??=0;
  return runVM(source,context);
}

import { appFixture, api, waitFor } from './helpers/v1-app-fixture.mjs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { lenderDayKey } from '../lib/v1/lender.mjs';
import { APP_DEFAULTS } from '../lib/v1/app.mjs';
import { effectiveState } from '../lib/v1/lending-state.mjs';
import { fakeClock } from './helpers/v1-lender-fixture.mjs';
import { createSyntheticPace50Source } from './helpers/pace50-synthetic-source.mjs';
import {settleWithin} from '../lib/v1/settle-within.mjs';

const pace50 = () => ({source:createSyntheticPace50Source({start:Date.now()}),
  account_week_id:'synthetic-week-1'});
const durableSettings = async home => JSON.parse(await readFile(join(home,'v1','app-settings.json'),'utf8'));

test('Pause returns after five seconds when approval and offer settlement never finish', async () => {
  const source=await readFile(new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
  const begin=source.indexOf("            if(['off','pause'].includes(parts[2])) {");
  const end=source.indexOf("          if(parts[1]==='approvals'",begin);
  assert.ok(begin>=0&&end>begin,'extract the production Pause route');
  const outerEnd=source.lastIndexOf('\n          }',end);
  const route=source.slice(begin,outerEnd),id='approval-1';
  const waiting={decision:null,finish(){this.finished=true;context.approvals.delete(id);}};
  const never=new Promise(()=>{});let paused=false;
  const context={cancelResumes:()=>{},parts:['api','lending','pause'],settings:{enabled:true,intent:'on',pause_until:null,paused:false},policy:{enabled:true},
    safetyEpoch:0,safetyIntentEpoch:0,closed:false,approvals:new Map([[id,waiting]]),acceptedApprovalPromises:new Set([never]),
    answerApproval:(_id,verb)=>{waiting.decision=verb;return never;},schedulePauseEnd:()=>{},now:()=>Date.now(),paceEventId:()=> 'pause-event',save:async()=>{},
    emit:()=>{},readinessChanged:()=>{},closeReadingSandboxes:async()=>{},settleWithin,lendingRuntime:{pace50:{deliver:async()=>{}}},
    lender:{pause:()=>{paused=true;},hideWaitingOffers:()=>never,settleAcceptedOffers:()=>never},
    lendingView:()=>({enabled:context.settings.enabled}),fail:(code,status=400)=>{throw Object.assign(new Error(code),{code,status});}};
  const pause=runInNewContext(`(async function(input){${route}})`,context);
  const started=Date.now(),pending=pause({});
  assert.ok(paused,'claim admission pauses before the settlement wait begins');
  const answer=await pending;
  assert.ok(paused,'claim admission pauses before waiting on approval or offer work');
  assert.ok(Date.now()-started<6000,'Pause is bounded to its five-second settlement window');
  assert.equal(answer.enabled,false);
  assert.equal(waiting.finished,true,'a waiting approval closes when its skip cannot settle in time');
});

async function lendingOn(app, circle) {
  await api(app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false}});
  await api(app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await api(app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'ask'}});
  await api(app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
}

test('a timed pause shows paused until its end, then lending resumes by itself', {timeout: 120000}, async t => {
  const f = await appFixture(t), {lender, circle} = await f.connect({lendingPace50:pace50()});
  await lendingOn(lender.app, circle);
  await waitFor(async () => (await api(lender.app, '/api/status')).state === 'ready', 'lending ready');
  const until = Date.now() + 1500;
  await api(lender.app, '/api/lending/pause', {method: 'POST', body: {until}});
  const paused = await api(lender.app, '/api/status');
  assert.deepEqual([paused.state, paused.until], ['paused', until]);
  assert.match(paused.summary.reason, /^Paused until /);
  const savedPause=await durableSettings(lender.home);
  assert.deepEqual([savedPause.intent,savedPause.pause_until],['on',until],'owner intent and its timed pause are durable');
  await waitFor(async () => (await api(lender.app, '/api/status')).state === 'ready', 'lending resumed after the pause', 20000);
  const savedResume=await durableSettings(lender.home);
  assert.deepEqual([savedResume.intent,savedResume.pause_until],['on',null],'the timer clears the durable pause through the app route');
  assert.equal((await api(lender.app, '/api/status')).until, null);
});

test('expired timed pause retries one transient resume failure without manual Resume', {timeout:120000}, async t=>{
  let blockerTick;
  const f=await appFixture(t),{owner,lender,circle}=await f.connect({
    blockerRecheckMs:1000,lendingPace50:pace50(),
    // Observe the failed status before giving the automatic retry its next tick.
    setInterval:tick=>{blockerTick=tick;return setInterval(()=>{},1000);},
  });
  await lendingOn(lender.app,circle);
  await waitFor(async()=>(await api(lender.app,'/api/status')).state==='ready','lending ready');
  const until=Date.now()+500;
  await api(lender.app,'/api/lending/pause',{method:'POST',body:{until}});
  const select=lender.app.device.selectCircle.bind(lender.app.device);
  let resumes=0;
  lender.app.device.selectCircle=async(...args)=>{
    if(++resumes===1)throw Object.assign(new Error('offline'),{code:'http_error',status:502,retryable:true});
    return select(...args);
  };
  try {
    const status=await waitFor(async()=>{
      const view=await api(lender.app,'/api/status');
      return view.intent.reason==='resume_failed'&&view;
    },'transient automatic resume failure');
    assert.equal(status.lendingProjection.admission,'blocked');
    assert.equal(status.summary.reason,'Lending could not resume. No new jobs start.');
    const file=join(lender.home,'v1','app-settings.json');
    const failed=JSON.parse(await readFile(file,'utf8'));
    assert.equal(failed.pause_until,until,'failed automatic resume retains the saved pause');
    assert.equal(failed.enabled,false);
    blockerTick();
    await waitFor(()=>resumes>=2,'a second automatic resume',10000);
    await waitFor(async()=>{
      const saved=JSON.parse(await readFile(file,'utf8'));
      return saved.enabled===true&&saved.pause_until===null&&saved.paused===false;
    },'successful automatic resume is saved',10000);
    assert.equal(await durableMode(lender.home),'on');
    const resumed=await api(lender.app,'/api/status');
    assert.notEqual(resumed.intent.reason,'resume_failed');
    assert.equal((await api(lender.app,'/api/lending')).enabled,true);
    await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',
      commit:'1'.repeat(40),prompt:'Eligible after automatic recovery',harness:'codex'}});
    await waitFor(async()=>(await api(lender.app,'/api/approvals')).length>0,'recovered lender offers an eligible job',20000);
  } finally {lender.app.device.selectCircle=select;}
});

test('a plain pause or off stays off, and a bad end time is refused', {timeout: 120000}, async t => {
  const f = await appFixture(t), {lender, circle} = await f.connect({});
  await lendingOn(lender.app, circle);
  for (const until of [Date.now() - 1, Date.now() + 8 * 86400000, 'soon']) {
    await api(lender.app, '/api/lending/pause', {method: 'POST', body: {until}, status: 400});
  }
  await api(lender.app, '/api/lending/off', {method: 'POST', body: {until: Date.now() + 60000}});
  assert.equal((await api(lender.app, '/api/status')).state, 'off', 'only pause takes an end time');
});

// r8 O6: "Pause until I resume" read exactly like Off, with no Resume. A pause with no end is its own state.
test('a pause with no end time is paused, not off, until the person resumes', {timeout: 120000}, async t => {
  const f = await appFixture(t), {lender, circle} = await f.connect({});
  await lendingOn(lender.app, circle);
  await waitFor(async () => (await api(lender.app, '/api/status')).state === 'ready', 'lending ready');
  await api(lender.app, '/api/lending/pause', {method: 'POST', body: {}});
  const paused = await api(lender.app, '/api/status');
  assert.deepEqual([paused.state, paused.until, paused.intent.state, paused.intent.on], ['paused', null, 'paused', true]);
  assert.match(paused.headline, /^Paused/);
  assert.equal((await api(lender.app, '/api/lending')).enabled, false);
  await api(lender.app, '/api/lending/resume', {method: 'POST', body: {circle: circle.id}});
  await waitFor(async () => (await api(lender.app, '/api/status')).state === 'ready', 'lending resumed by the person');
  await api(lender.app, '/api/lending/off', {method: 'POST', body: {}});
  assert.equal((await api(lender.app, '/api/status')).state, 'off', 'turning lending off is still off');
});

test('an open-ended Pause persists as its own intent and survives restart', {timeout: 120000}, async t => {
  const f = await appFixture(t), {owner, lender, circle} = await f.connect({});
  await lendingOn(lender.app, circle);
  await waitFor(async () => (await api(lender.app, '/api/status')).state === 'ready', 'lending ready');
  await api(lender.app, '/api/lending/pause', {method: 'POST', body: {}});
  const saved = JSON.parse(await readFile(join(lender.home, 'v1', 'app-settings.json'), 'utf8'));
  assert.equal(saved.intent, 'paused');
  assert.equal(saved.enabled, false);
  await lender.app.close();
  const restarted = await f.start('lender');
  const status = await api(restarted.app, '/api/status');
  assert.equal(status.intent.state, 'paused');
  assert.equal(status.state, 'paused');
  assert.equal(status.intent.on, true);
  assert.equal((await api(restarted.app, '/api/lending')).enabled, false);
  await api(owner.app, '/api/jobs', {method: 'POST', body: {circle: circle.id, git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40), prompt: 'Queued while paused', harness: 'codex'}});
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(await api(restarted.app, '/api/approvals'), [], 'paused intent admits no new review cards');
  assert.equal(restarted.backend.calls.filter(([kind]) => kind === 'run').length, 0, 'paused intent starts no jobs');
  await api(restarted.app, '/api/lending/resume', {method: 'POST', body: {circle: circle.id}});
  await waitFor(async () => (await api(restarted.app, '/api/status')).state === 'ready', 'explicit Resume restores lending');
});

test('the status carries today\'s counted use against today\'s limits', {timeout: 120000}, async t => {
  const f = await appFixture(t), {lender, circle} = await f.connect({});
  assert.equal((await api(lender.app, '/api/status')).today, null, 'unknown until lending has counters');
  await lendingOn(lender.app, circle);
  const today = await waitFor(async () => (await api(lender.app, '/api/status')).today, 'counters');
  assert.deepEqual(today, {jobs: 0, jobLimit: 3, minutes: 0, minuteLimit: 60, jobMinutes: 20});
});

test('fresh app defaults use the host IANA time zone', async t => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(APP_DEFAULTS.timeZone, zone);
  const f = await appFixture(t), {app} = await f.start();
  assert.equal((await api(app, '/api/lending')).limits.timeZone, zone);
});

for (const [label, stored, expected] of [
  ['missing legacy zone', {}, Intl.DateTimeFormat().resolvedOptions().timeZone],
  ['unmarked legacy UTC', {limits: {timeZone: 'UTC'}}, Intl.DateTimeFormat().resolvedOptions().timeZone],
  ['explicitly chosen UTC', {limits: {timeZone: 'UTC'}, timeZoneChosen: true}, 'UTC'],
  ['saved non-UTC zone', {limits: {timeZone: 'Asia/Tokyo'}}, 'Asia/Tokyo'],
]) test('app startup preserves or migrates ' + label, async t => {
  const f = await appFixture(t), home = await f.home('owner');
  await mkdir(join(home, 'v1'), {recursive: true});
  await writeFile(join(home, 'v1', 'app-settings.json'), JSON.stringify({
    version: 1, name: 'Synthetic timezone', enabled: false, agents: {}, modes: {}, ...stored,
  }));
  const {app} = await f.start();
  assert.equal((await api(app, '/api/lending')).limits.timeZone, expected);
});

test('only accepted explicit zone saves mark the choice and UTC survives restart', async t => {
  const f = await appFixture(t), first = await f.start();
  const file = join(first.home, 'v1', 'app-settings.json');
  const saved = async () => JSON.parse(await readFile(file, 'utf8'));
  await api(first.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 4}});
  assert.notEqual((await saved()).timeZoneChosen, true);
  await api(first.app, '/api/lending/limits', {method: 'POST', body: {timeZone: 'UTC', dailyJobs: 0}, status: 400});
  assert.notEqual((await saved()).timeZoneChosen, true);
  await api(first.app, '/api/lending/limits', {method: 'POST', body: {timeZone: 'UTC'}});
  assert.equal((await saved()).timeZoneChosen, true);
  assert.equal(Object.hasOwn((await saved()).limits, 'timeZoneChosen'), false);
  await first.app.close();
  const restarted = await f.start();
  assert.equal((await api(restarted.app, '/api/lending')).limits.timeZone, 'UTC');
  assert.equal((await saved()).timeZoneChosen, true);
});

test('status jobs and minutes reset at Chicago midnight, not UTC midnight', {timeout: 120000}, async t => {
  const clock = fakeClock();
  clock.advance(Date.now() - clock.now());
  const f = await appFixture(t), {lender, circle} = await f.connect({clock});
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {timeZone: 'America/Chicago'}});
  await writeFile(join(lender.home, 'v1', 'app-counters.json'), JSON.stringify({
    day: lenderDayKey(clock.now(), 'America/Chicago'), jobs: 3, milliseconds: 1800000, pending: null,
  }));
  await lendingOn(lender.app, circle);
  const today = await waitFor(async () => (await api(lender.app, '/api/status')).today, 'seeded local counters');
  assert.deepEqual(today, {jobs: 3, jobLimit: 3, minutes: 30, minuteLimit: 60, jobMinutes: 20});
  // Find the next Chicago date boundary without assuming today's DST offset.
  const day = lenderDayKey(clock.now(), 'America/Chicago');
  let low = clock.now(), high = low + 30 * 3600000;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (lenderDayKey(mid, 'America/Chicago') === day) low = mid;
    else high = mid;
  }
  clock.advance(low - clock.now());
  assert.deepEqual((await api(lender.app, '/api/status')).today, today, '23:59:59.999 Chicago retains usage');
  clock.advance(1);
  assert.deepEqual((await api(lender.app, '/api/status')).today,
    {jobs: 0, jobLimit: 3, minutes: 0, minuteLimit: 60, jobMinutes: 20});
});

// The Chicago-midnight test advances the lender's fake clock hours past real time. The synthetic coordinator must
// judge a signed request by the clock of the device that signed it, or any background request after the advance
// fails with clock_skew and the test depends on whether one happened to be in flight.
test('a lender on a fake clock hours ahead of real time still reaches the synthetic coordinator', {timeout: 120000}, async t => {
  const clock = fakeClock();
  clock.advance(Date.now() - clock.now());
  const f = await appFixture(t), {lender, circle} = await f.connect({clock});
  clock.advance(20 * 3600000);
  await lender.app.device.refreshRoster(circle.id);
  assert.deepEqual(f.failures, [], 'no coordinator-side assertion failed');
});


const held = () => {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function controlSource(begin,end) {
  const source=await readFile(new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
  const start=source.indexOf(begin),finish=source.indexOf(end,start);
  assert.ok(start>=0&&finish>start,'production control source is present');
  return source.slice(start,finish);
}
async function retryContext(code='network_error') {
  const source=await controlSource('  const RETRYABLE_RESUME','  function schedulePauseEnd');
  const calls=[],context={
    resumeFailed:{code,auto:{circleId:'circle',pauseUntil:100,intentEpoch:7,stopReceipt:null}},
    settings:{intent:'on',enabled:false,paused:false,pause_until:100,activeCircle:'circle'},
    closed:false,quitting:false,lender:{},backgroundCheck:null,stopFlights:new Map(),stopReceipt:null,
    safetyIntentEpoch:7,safetyEpoch:9,options:{blockerRecheckMs:10},time:200,hold:false,
    machineHold:()=>null,
  };
  context.now=()=>context.time;context.performance={now:()=>context.time};
  context.updateAdmissionHeld=()=>context.hold;
  context.autoResume=(...args)=>{calls.push(JSON.parse(JSON.stringify(args)));return Promise.resolve();};
  const retry=runInNewContext(source+'\nretryFailedResume',context);
  return {context,calls,retry};
}
test('due timed pause retries with its original deadline and fresh safety epoch',async()=>{
  const {context,calls,retry}=await retryContext();
  retry();
  assert.deepEqual(calls,[['circle',{pauseUntil:100,epoch:9}]]);
  retry();assert.equal(calls.length,1,'backoff prevents repeated starts');
  context.time+=10;retry();assert.equal(calls.length,2);
  context.time+=19;retry();assert.equal(calls.length,2,'backoff doubles');
  context.time++;retry();assert.equal(calls.length,3);
});
for(const [label,change] of [
  ['Quit',c=>{c.quitting=true;}],['closed app',c=>{c.closed=true;}],
  ['Off',c=>{c.settings.intent='off';}],['open pause',c=>{c.settings.paused=true;c.settings.pause_until=null;}],
  ['future pause',c=>{c.settings.pause_until=300;c.resumeFailed.auto.pauseUntil=300;}],
  ['new pause',c=>{c.settings.pause_until=99;}],['new owner intent',c=>{c.safetyIntentEpoch++;}],
  ['new circle',c=>{c.settings.activeCircle='other';}],['Stop',c=>{c.stopReceipt={};}],
  ['Stop in flight',c=>{c.stopFlights.set('job',Promise.resolve());}],
  ['enabled lending',c=>{c.settings.enabled=true;}],
])test('timed retry respects '+label,async()=>{const {context,calls,retry}=await retryContext();change(context);retry();assert.equal(calls.length,0);});
test('timed retry waits for the update admission hold to release',async()=>{
  const {context,calls,retry}=await retryContext('update_in_progress');
  context.hold=true;retry();assert.equal(calls.length,0);
  context.hold=false;retry();assert.equal(calls.length,1);
});
// Retry decisions honor HTTP status and retryability even when the code suggests a different cause.
for(const [label,failure,retried] of [
  ['a 502 with no body',{code:'http_error',status:502,retryable:true},true],
  ['a 503 with a problem code',{code:'unavailable',status:503,retryable:true},true],
  ['a 429',{code:'rate_limited',status:429,retryable:true},true],
  ['a refused connection',{code:'network_error',status:0,retryable:true},true],
  ['a 4xx with a transient code',{code:'circle_unreachable',status:403,retryable:false},false],
  ['a local update hold',{code:'update_in_progress',status:409},true],
  ['a 4xx refusal',{code:'forbidden',status:403,retryable:false},false],
  ['a signed-out agent',{code:'agent_not_ready',status:0,retryable:false},false],
])test('failed resume after '+label+(retried?' is retried':' is not retried'),async()=>{
  const {context,calls,retry}=await retryContext();
  Object.assign(context.resumeFailed,failure);retry();
  assert.equal(calls.length,retried?1:0);
});
test('a host that stays down is retried with doubling backoff capped at five minutes',async()=>{
  const {context,calls,retry}=await retryContext('http_error');
  context.resumeFailed.status=502;context.options.blockerRecheckMs=15000;
  const gaps=[];let last=context.time;
  // Call far more often than the backoff allows: only the backoff decides when a start is tried.
  for(let i=0;i<4000;i++){const before=calls.length;retry();if(calls.length>before){gaps.push(context.time-last);last=context.time;}context.time+=1000;}
  assert.deepEqual(gaps.slice(1,6),[15000,30000,60000,120000,240000]);
  assert.ok(gaps.slice(6).every(gap=>gap===300000),'the delay stops growing at five minutes');
  assert.ok(calls.length<=20,'about one start every five minutes, not a request storm: '+calls.length);
});
test('ordinary startup still retries only without an existing lender',async()=>{
  const {context,calls,retry}=await retryContext();
  context.settings.pause_until=null;context.resumeFailed.auto.pauseUntil=null;
  retry();assert.equal(calls.length,0);
  context.lender=null;retry();assert.equal(calls.length,1);
});

test('a failed cold automatic resume carries its authority through the retry',async()=>{
  const source=await controlSource('  function autoResume','  function schedulePauseEnd');
  const calls=[],stop={id:'before-pause'};
  const context={settings:{intent:'on',enabled:false,paused:false,pause_until:100,activeCircle:'circle'},
    closed:false,quitting:false,safetyEpoch:9,safetyIntentEpoch:7,stopReceipt:stop,stopFlights:new Map(),
    lender:null,backgroundCheck:null,resumeFailed:null,timedResume:null,agentCheckTimeoutMs:1000,
    options:{blockerRecheckMs:10},now:()=>200,performance:{now:()=>200},machineHold:()=>null,updateAdmissionHeld:()=>false,
    serialize:work=>Promise.resolve().then(work),lenderEvidence:async()=>({due:false}),emit:()=>{}};
  context.startLending=async(circle,options)=>{
    calls.push({circle,...options});
    if(calls.length===1){context.safetyEpoch++;throw Object.assign(new Error('offline'),{code:'network_error'});}
    context.settings.pause_until=null;context.settings.enabled=true;
  };
  const controls=runInNewContext(source+'\n({autoResume,retryFailedResume})',context);
  await assert.rejects(controls.autoResume('circle',{pauseUntil:100,epoch:9}),{code:'network_error'});
  await context.backgroundCheck;
  assert.equal(context.resumeFailed.auto.circleId,'circle');
  assert.equal(context.resumeFailed.auto.pauseUntil,100);
  assert.equal(context.resumeFailed.auto.intentEpoch,7);
  assert.equal(context.resumeFailed.auto.stopReceipt,stop);
  controls.retryFailedResume();await context.backgroundCheck;
  assert.equal(calls.length,2);
  assert.equal(calls[1].expectedEpoch,10,'a cold start can advance the safety epoch before it fails');
  assert.equal(calls[1].expectedStopReceipt,stop);
  assert.equal(calls[1].resume,true);assert.equal(calls[1].auto,true);
  assert.equal(context.settings.enabled,true);assert.equal(context.settings.pause_until,null);
  assert.equal(context.resumeFailed,null);assert.equal(context.timedResume,null);
});

for(const action of ['pause','off','stop'])test(`circle adoption cannot undo ${action} during circle lookup`,async()=>{
  const lookup=held();let starts=0;
  const context={quitting:false,closed:false,stopFlights:new Map(),stopReceipt:null,safetyEpoch:0,safetyIntentEpoch:0,
    settings:{intent:'on',enabled:false,paused:false,pause_until:null,activeCircle:null},lender:null,adopting:false,
    now:()=>100,projectMembership:()=>({phase:'approved'}),device:{listCircles:()=>lookup.promise},
    save:async()=>{},applyJoinMode:async()=>{},resumeFailed:null,
    startLending:async()=>{starts++;context.settings.intent='on';context.settings.enabled=true;}};
  const source=await controlSource('  async function adoptJoinedCircle(circle) {','  // The person whose job');
  const adopt=runInNewContext(source+'\nadoptJoinedCircle',context);
  const pending=adopt({id:'joined',origin:'https://circle.test'});
  context.safetyEpoch++;context.safetyIntentEpoch++;
  context.settings.intent=action==='pause'?'paused':'off';context.settings.paused=action==='pause';
  lookup.resolve([]);await pending;
  assert.equal(starts,0,'automatic start must retain its original authority');
  assert.equal(context.settings.intent,action==='pause'?'paused':'off');
  assert.equal(context.settings.enabled,false);
});

test('Stop closes admission before the requester lookup completes',async()=>{
  const lookup=held();let current='job';
  const context={cancelResumes:()=>{},parts:['api','lending','stop'],safetyEpoch:0,safetyIntentEpoch:0,stopFlights:new Map(),stopReceipt:null,
    settings:{intent:'on',enabled:true},policy:{enabled:true},lendingRuntime:{},lenderStoppedJob:null,lendingStopRecords:new Map(),
    lender:{getState:()=>({current}),stopCurrentJob:async()=>{current=null;}},runningJobView:()=>lookup.promise,
    save:async()=>{},now:()=>100,lendingView:()=>({}),emit:()=>{},readinessChanged:()=>{},closeReadingSandboxes:async()=>{},
    fail:(code)=>{throw Object.assign(new Error(code),{code});}};
  const source=await controlSource("            if(parts[2]==='stop') {","            if(parts[2]==='requester-limits'");
  const stop=runInNewContext(`(async function(input){${source}})`,context);
  context.resumeFailed={code:'network_error'};context.resumeRetryAt=300000;context.resumeRetryDelay=300000;
  const pending=stop({confirmed:true,attemptId:'job'});
  try {
    assert.equal(context.policy.enabled,false,'Stop must fence admission before any lookup');
    assert.equal(context.settings.enabled,false);
    assert.ok(context.safetyEpoch>0,'old automatic starts lose their epoch immediately');
  } finally {lookup.resolve(null);await pending;}
  assert.equal(context.settings.intent,'off','Stop stays Off until Resume');
  assert.equal(context.resumeFailed,null);assert.equal(context.resumeRetryAt,0);assert.equal(context.resumeRetryDelay,0);
});

for(const outcome of ['success','failure'])test(`timed resume remains Paused while durable start is pending: ${outcome}`,async()=>{
  const durable=held();
  const context={settings:{intent:'on',pause_until:100,paused:false,activeCircle:'circle'},safetyIntentEpoch:0,
    timedResume:null,resumeFailed:null,lenderStoppedJob:null,stopReceipt:null,policy:null,lender:null,
    startLendingAttempt:async()=>{context.settings.pause_until=null;await durable.promise;return {};}};
  const source=await controlSource('  async function startLending(circle,options={}) {','  async function resumeDurableCandidate');
  const start=runInNewContext(source+'\nstartLending',context);
  const pending=start('circle',{resume:true});
  // Consume rejection before releasing the asynchronous start.
  const result=pending.then(()=>null,error=>error);
  try {
    assert.equal(context.timedResume?.state,'resuming','clearing a timer is not a completed resume');
    const status=effectiveState({intent:context.settings.intent,pause_until:context.settings.pause_until,
      now:200,resuming:context.timedResume?.state==='resuming'});
    assert.equal(status.state,'paused');assert.equal(status.intent.resuming,true);
  } finally {
    if(outcome==='failure')durable.reject(Object.assign(new Error('offline'),{code:'network_error'}));else durable.resolve();
    await result;
  }
  if(outcome==='success')assert.equal(context.timedResume,null);
  else {
    assert.equal(context.timedResume?.state,'failed');assert.equal(context.timedResume?.code,'network_error');
    const status=effectiveState({intent:context.settings.intent,resumeError:context.timedResume?.code});
    assert.equal(status.state,'paused');assert.match(status.headline,/could not resume/);
  }
});

// Exercise the real Resume route, settings writer and cold-start reader. The host's gateway answers 502 after the
// early settings save. A circle host that is down is a normal state, not a pause: Resume saves the person's intent,
// answers at once with circle_unreachable, and the retry worker starts lending when the host is back.
test('cold timed resume with an unreachable host keeps lending on, not paused, through failed startup and restart', {timeout:120000}, async t=>{
  const f=await appFixture(t),{lender,circle}=await f.connect({});
  await lendingOn(lender.app,circle);
  const until=Date.now()+600000;
  await api(lender.app,'/api/lending/pause',{method:'POST',body:{until}});
  await lender.app.close();
  const cold=await f.start('lender');
  const client=cold.app.device.client.bind(cold.app.device);
  cold.app.device.client=async ()=>{throw Object.assign(new Error('offline'),{code:'http_error',status:502,retryable:true});};
  try {
    const began=Date.now();
    const answer=await api(cold.app,'/api/lending/resume',{method:'POST',body:{circle:circle.id},status:409});
    assert.ok(Date.now()-began<1500,'the answer does not wait for the host');
    assert.equal(answer.code,'circle_unreachable');
    const saved=JSON.parse(await readFile(join(cold.home,'v1','app-settings.json'),'utf8'));
    assert.equal(saved.intent,'on','the person intent is saved');
    assert.equal(saved.pause_until,null,'an unreachable host never turns into a pause');
    assert.equal(saved.paused,false);assert.equal(saved.enabled,false,'execution stays held');
  } finally {cold.app.device.client=client;}
  const failed=await api(cold.app,'/api/status');
  assert.notEqual(failed.state,'paused');assert.equal(failed.intent.on,true);
  await cold.app.close();
  const restarted=await f.start('lender');
  const status=await api(restarted.app,'/api/status');
  assert.equal(status.intent.on,true);assert.equal(status.until??null,null);
});

test('cold timed resume saves intent at once and answers resume_pending while startup is still waiting on the host', {timeout:120000}, async t=>{
  const f=await appFixture(t),{lender,circle}=await f.connect({});
  await lendingOn(lender.app,circle);
  const until=Date.now()+600000;
  await api(lender.app,'/api/lending/pause',{method:'POST',body:{until}});
  await lender.app.close();
  const cold=await f.start('lender');
  const file=join(cold.home,'v1','app-settings.json');
  const gate=held(),client=cold.app.device.client.bind(cold.app.device);
  cold.app.device.client=async(...args)=>{await gate.promise;return client(...args);};
  let answer;
  try {
    answer=await api(cold.app,'/api/lending/resume',{method:'POST',body:{circle:circle.id},status:202});
    assert.equal(answer.code,'resume_pending');assert.equal(answer.saved,true);
    const disk=JSON.parse(await readFile(file,'utf8'));
    assert.equal(disk.intent,'on');assert.equal(disk.pause_until,null,'the pause is cleared as soon as the intent is saved');
  } finally {gate.resolve();}
  await waitFor(async()=>(await api(cold.app,'/api/status')).state==='ready','cold resume is ready with no second call');
  await waitFor(async()=>JSON.parse(await readFile(file,'utf8')).enabled===true,'the started lender is saved');
  const saved=JSON.parse(await readFile(file,'utf8'));
  assert.equal(saved.pause_until,null);assert.equal(saved.paused,false);
  assert.equal((await api(cold.app,'/api/lending')).enabled,true);
});

test('failed final resume save restores the pause before another settings write can see On',async()=>{
  let paused=false;
  const context={settings:{intent:'on',pause_until:100,paused:false,enabled:false},safetyIntentEpoch:0,
    timedResume:null,resumeFailed:null,lenderStoppedJob:null,stopReceipt:null,policy:{enabled:false},lender:{pause:()=>{paused=true;}},
    startLendingAttempt:async()=>{
      context.settings.pause_until=null;context.settings.enabled=true;context.policy.enabled=true;
      throw Object.assign(new Error('disk unavailable'),{code:'operation_failed'});
    }};
  const source=await controlSource('  async function startLending(circle,options={}) {','  async function resumeDurableCandidate');
  const start=runInNewContext(source+'\nstartLending',context);
  await assert.rejects(start('circle',{resume:true}),{code:'operation_failed'});
  assert.equal(context.settings.pause_until,100);
  assert.equal(context.settings.enabled,false);assert.equal(context.policy.enabled,false);assert.equal(paused,true);
  assert.equal(context.timedResume.state,'failed');
});
