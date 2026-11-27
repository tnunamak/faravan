import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {pendingAttempts} from '../lib/v1/durable-cessation.mjs';

// Run the production start path (durable delivery and startLendingAttempt) with held sign-in and heartbeat
// awaits, so a Quit, an Off or a Resume can land inside them.
const source=await readFile(new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
const begin=source.indexOf('  async function resumeDurableCandidate(');
const end=source.indexOf('  // The standing rules a mode change',begin);
assert.ok(begin>=0&&end>begin);
const startAttempt=source.slice(begin,end);
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function fixture({lender=null,settings={}}={}) {
  const log={starts:0,resumes:0,pools:0,saves:0,deliveries:0,signIns:0,claims:0};
  const hold={signIn:null,beat:null};
  // A pool claims when its loop runs, it is not paused, and its policy admits work. Like the real claim poll, it looks
  // after the caller's synchronous step, here once after start and once after each resume.
  const pool=({policy})=>{
    let running=false,paused=false;
    const claim=()=>queueMicrotask(()=>{if(running&&!paused&&policy.enabled)log.claims++;});
    return {getState:()=>({status:'starting'}),start:()=>{log.starts++;running=true;claim();return new Promise(()=>{});},
      pause(){paused=true;},resume(){log.resumes++;paused=false;claim();}};
  };
  const c={updateAdmissionHeld:()=>false,safetyEpoch:4,safetyIntentEpoch:0,closed:false,quitting:false,now:()=>100,
    settings:{intent:'on',enabled:false,activeCircle:'circle',limits:{},standingRules:[],requesterLimits:[],modes:{},pause_until:null,paused:false,...settings},
    stopFlights:new Map(),stopReceipt:null,policy:{enabled:false},lender,
    lendingTarget:async()=>({id:'circle',name:'circle'}),counterStore:{get:async()=>null},pendingAttempts,
    checkSignInBeforeClaim:async()=>{log.signIns++;await hold.signIn?.promise;},hasObservationJournal:()=>false,
    fail:(code,status=400)=>{throw Object.assign(new Error(code),{code,status});},
    lendingRuntime:{pace50:{deliver:async()=>{log.deliveries++;return {applied:true};}}},paceEventId:type=>type,
    readHostProfile:async()=>{},lenderAdapters:async()=>[],machineHold:()=>'sandbox_not_ready',options:{},
    device:{keyId:'owner',client:async()=>({})},availableParallelism:()=>1,totalmem:()=>8*1024**3,
    machineCapacity:()=>({}),AbortController,backend:{},accountExecution:null,createLender:()=>{},createLendingPool:options=>{log.pools++;return pool(options);},
    lendingHashes:{clear:()=>{}},controller:null,loop:null,lenderInit:null,stopCheckCoordinator:null,initHost:()=>({}),consumeLendingOnTrigger:()=>{},mintIntentGeneration:()=>{},
    heartbeat:{beat:async()=>{await hold.beat?.promise;}},approval:()=>{},decisions:{record:()=>{}},automaticReceipt:()=>{},markNotApplied:()=>{},
    recordDiagnostic:async()=>{},telemetry:null,transcripts:new Map(),lastLendingShape:'',
    emit:()=>{},publicState:value=>value,nudgeHeartbeat:()=>{},readinessChanged:()=>{},
    pauseTimer:null,clearTimeout:()=>{},save:async()=>{log.saves++;},lendingView:()=>({enabled:c.settings.enabled}),
    readQuota:async()=>({}),daemonGate:null,userActive:()=>false,resumeFailed:null,hostRateLimited:false,hostPollEpoch:0};
  const start=runInNewContext(`${startAttempt}\nstartLendingAttempt;`,c);
  return {c,start,log,hold};
}
// What an accepted Quit does synchronously before its first await (app.mjs shutdown route).
const acceptQuit=c=>{c.quitting=true;c.safetyEpoch++;c.lender?.pause();c.settings.enabled=false;c.policy.enabled=false;};
const outcome=async promise=>{try{await promise;return null;}catch(error){return error;}};

test('a start called after Quit is accepted fails before the sign-in check',async()=>{
  const f=fixture();f.c.quitting=true;
  assert.equal((await outcome(f.start('circle',{})))?.code,'app_quitting');
  assert.equal(f.log.signIns,0);assert.equal(f.log.pools,0);assert.equal(f.log.saves,0);
});

test('owner Resume held in the sign-in check does not resume the lender after Quit',async()=>{
  const f=fixture({lender:{pause(){},getState:()=>({status:'idle'})}});
  let resumes=0;f.c.lender.resume=()=>{resumes++;};
  f.hold.signIn=gate();
  const resuming=f.start('circle',{resume:true}); // the HTTP route passes no expectedEpoch
  await tick();acceptQuit(f.c);f.hold.signIn.resolve();
  assert.equal((await outcome(resuming))?.code,'app_quitting');
  assert.equal(resumes,0,'the paused lender stays paused');
  assert.equal(f.c.settings.enabled,false);assert.equal(f.c.policy.enabled,false);
  assert.equal(f.log.deliveries,0,'no durable on event');assert.equal(f.log.saves,0,'nothing persisted');
});

test('owner On held in the sign-in check builds nothing and rewrites no intent after Quit',async()=>{
  const until=1000;
  const f=fixture({settings:{activeCircle:'other',pause_until:until}});
  f.hold.signIn=gate();
  const starting=f.start('circle',{});
  await tick();acceptQuit(f.c);f.hold.signIn.resolve();
  assert.equal((await outcome(starting))?.code,'app_quitting');
  assert.equal(f.log.pools,0);assert.equal(f.log.starts,0);assert.equal(f.c.lender,null);
  assert.equal(f.c.settings.activeCircle,'other','Quit is not Off: the saved circle stays');
  assert.equal(f.c.settings.pause_until,until,'Quit is not Off: the timed pause stays');
  assert.equal(f.log.deliveries,0,'no durable on event');assert.equal(f.log.saves,0,'nothing persisted');
});

test('Off during the heartbeat still starts the pool, paused, and a later Resume lends',async()=>{
  const f=fixture();f.hold.beat=gate();
  const starting=f.start('circle',{});
  await tick();await tick();
  assert.ok(f.c.lender,'the pool is installed before the heartbeat');
  // The Off route: bump the epoch, pause the lender, keep it.
  f.c.safetyEpoch++;f.c.settings.enabled=false;f.c.settings.intent='off';f.c.policy.enabled=false;f.c.lender.pause();
  f.hold.beat.resolve();
  assert.equal(await outcome(starting),null);
  assert.equal(f.log.starts,1,'the pool loop runs, so a later Resume reaches a live pool');
  assert.equal(f.log.claims,0,'the started pool is paused by Off and claims nothing');
  await f.start('circle',{resume:true});
  assert.equal(f.log.resumes,1);assert.equal(f.log.starts,1);assert.equal(f.log.claims,1,'Resume reopens claims');
});

test('an owner Resume during the heartbeat of an automatic start does not strand the pool',async()=>{
  const f=fixture();f.hold.beat=gate();
  const first=f.start('circle',{auto:true,expectedEpoch:4}); // startup autoResume
  await tick();await tick();
  assert.ok(f.c.lender);
  const resuming=f.start('circle',{resume:true}); // not serialized while a lender exists; it waits for the pool to start
  await tick();f.hold.beat.resolve();
  assert.equal(await outcome(first),null);
  assert.equal(await outcome(resuming),null);
  assert.equal(f.log.starts,1,'the pool is started exactly once');assert.equal(f.c.settings.enabled,true);
});

for(const [name,quit] of [
  ['an accepted Quit',acceptQuit],
  ['quitting alone, with no epoch change',c=>{c.quitting=true;}],
])test(`${name} during the heartbeat rejects the start and tears down the unstarted pool`,async()=>{
  const f=fixture();f.hold.beat=gate();
  const starting=f.start('circle',{});
  await tick();await tick();
  const controller=f.c.controller;
  assert.ok(f.c.lender&&controller);
  quit(f.c); // Quit leaves the lender in place while its counters are pending
  f.hold.beat.resolve();
  assert.equal((await outcome(starting))?.code,'lending_busy');
  assert.equal(f.log.starts,0);
  assert.equal(f.c.lender,null,'no never-started pool is left behind');
  assert.equal(f.c.settings.enabled,false);assert.equal(f.c.policy.enabled,false);
  assert.equal(controller.signal.aborted,true);
});

test('a pool replaced during the heartbeat is not started, and the replacement is kept',async()=>{
  const f=fixture();f.hold.beat=gate();
  const starting=f.start('circle',{});
  await tick();await tick();
  const first=f.c.controller,other={pause(){},resume(){}};
  f.c.lender=other;f.c.controller=new AbortController();
  f.hold.beat.resolve();
  assert.equal((await outcome(starting))?.code,'lending_busy');
  assert.equal(f.log.starts,0);assert.equal(f.c.lender,other);
  assert.equal(first.signal.aborted,true);assert.equal(f.c.controller.signal.aborted,false);
});

test('Quit accepted while the durable on is delivered, after the pool is installed, leaves no pool marked on',async()=>{
  const f=fixture(),delivering=gate(),release=gate();
  f.c.lendingRuntime.pace50.deliver=async()=>{f.log.deliveries++;delivering.resolve();await release.promise;return {applied:true};};
  const starting=f.start('circle',{});
  await delivering.promise;
  const controller=f.c.controller;
  assert.ok(f.c.lender&&controller,'the pool is installed before the durable on');
  acceptQuit(f.c);release.resolve();
  assert.ok(['app_quitting','lending_busy'].includes((await outcome(starting))?.code));
  assert.equal(f.c.settings.enabled,false,"Quit's Off-for-now is not overwritten");assert.equal(f.c.policy.enabled,false);
  assert.equal(f.c.lender,null);assert.equal(f.log.starts,0,'no loop');assert.equal(controller.signal.aborted,true);
});

// A Resume that reports success must leave a live pool (its loop started), unless a newer owner action superseded it.
function holdFirstDelivery(f) {
  const held=gate(),release=gate();let calls=0;
  f.c.lendingRuntime.pace50.deliver=async()=>{f.log.deliveries++;if(++calls===1){held.resolve();await release.promise;}return {applied:true};};
  return {held:held.promise,release:release.resolve};
}

test('a Resume during the first durable on of a starting pool acknowledges only a live pool',async()=>{
  const f=fixture(),d=holdFirstDelivery(f);
  const starting=f.start('circle',{});
  await d.held;
  const resuming=f.start('circle',{resume:true});
  await tick();d.release();
  assert.equal(await outcome(starting),null);
  assert.equal(await outcome(resuming),null);
  assert.ok(f.c.lender,'the pool is still installed');
  assert.equal(f.log.starts,1,'and its loop runs');
  assert.equal(f.c.settings.enabled,true);assert.equal(f.log.claims>0,true);
});

test('a Resume that waits on a starting pool and is then followed by Off is superseded, and nothing claims',async()=>{
  const f=fixture(),d=holdFirstDelivery(f);
  const starting=f.start('circle',{});
  await d.held;
  const resuming=f.start('circle',{resume:true});
  await tick();
  f.c.safetyEpoch++;f.c.safetyIntentEpoch++;f.c.settings.enabled=false;f.c.settings.intent='off';f.c.policy.enabled=false;f.c.lender?.pause();
  d.release();
  await outcome(starting);
  const resumed=await outcome(resuming);
  assert.ok(resumed!==null||f.log.starts===1,'a successful Resume left a live pool');
  assert.equal(resumed?.code,'lending_busy','the later Off supersedes the Resume');
  assert.equal(f.c.settings.enabled,false);assert.equal(f.c.settings.intent,'off');assert.equal(f.log.claims,0);
});

test('a Resume during a heartbeat that then fails acknowledges only a live pool',async()=>{
  const f=fixture(),beat=gate();let beats=0;
  f.c.heartbeat.beat=async()=>{if(++beats===1){await beat.promise;throw new Error('heartbeat_failed');}};
  const starting=f.start('circle',{});
  await tick();await tick();
  assert.ok(f.c.lender);
  const resuming=f.start('circle',{resume:true});
  await tick();beat.resolve();
  assert.equal((await outcome(starting))?.message,'heartbeat_failed');
  assert.equal(await outcome(resuming),null);
  assert.ok(f.c.lender,'Resume built a new pool after the first one failed');
  assert.equal(f.log.starts,1,'and its loop runs');assert.equal(f.c.settings.enabled,true);
});
