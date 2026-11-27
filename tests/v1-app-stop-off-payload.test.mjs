import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, mkdtemp, open, rename, rm} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {runInNewContext as runVM} from 'node:vm';
import {AppLifetime} from '../lib/v1/app-lifetime.mjs';
import {clientFailure} from '../lib/v1/client.mjs';
function runInNewContext(source,context) {
  context.lifetime??=new AppLifetime();
  context.clientFailure=clientFailure;
  context.resumeRetryAt??=0;context.resumeRetryDelay??=0;
  return runVM(source,context);
}

import {setImmediate as tick} from 'node:timers/promises';
import {settleWithin} from '../lib/v1/settle-within.mjs';
import fs from 'node:fs';
import {durableWriteAsync} from '../lib/durable-write.mjs';
import {pendingAttempts} from '../lib/v1/durable-cessation.mjs';
assert.equal(process.env.FARAVAN_NO_BROWSER,'1');
assert.equal(process.env.FARAVAN_NO_BROWSER,'1');
const source=await readFile(new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
const slice=(from,to)=>{const a=source.indexOf(from),b=source.indexOf(to,a);assert.ok(a>=0&&b>a,from);return source.slice(a,b);};
const route=slice("            if(parts[2]==='stop') {","            if(parts[2]==='requester-limits'");
const starts=slice('  async function startLending(circle,options={}) {','  // The standing rules a mode change would leave;');
const writes=slice('  let settingsWrites=Promise.resolve();','  const counterStore=createLenderCounterStorage');
const atomicSource=slice('async function atomic(','/** Last definite facts retain their observation time;');
const request={attemptId:'A',confirmed:true};
const failure=code=>Object.assign(new Error(code),{code,status:409});
const gate=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const outcome=p=>p.then(value=>({value}),error=>({error}));
function fixture(){
 const state={current:'A',currentJobs:[{attemptId:'A'}]};
 const writesSeen=[];
 const c={stopCheckCoordinator:null,initHost:()=>({}),updateAdmissionHeld:()=>false,quitting:false,lenderInit:null,cancelResumes:()=>{},parts:['api','lending','stop'],lendingRuntime:null,lenderStoppedJob:null,stopReceipt:null,stopFlights:new Map(),lendingStopRecords:new Map(),
  safetyEpoch:0,safetyIntentEpoch:0,timedResume:null,settings:{enabled:true,intent:'on',activeCircle:'circle'},policy:{enabled:true},
  checkSignInBeforeClaim:async()=>{},
  runningJobView:async()=>({requester:'synthetic-person'}),now:()=>0,emit:()=>{},readinessChanged:()=>{},
  fail:(code,status=400)=>{throw Object.assign(new Error(code),{code,status});},clearTimeout:()=>{},pauseTimer:null,closed:false,
  resumeFailed:null,lendingTarget:async()=>({id:'circle'}),settingsFile:'synthetic-settings'};
 c.lender={getState:()=>state,stopCurrentJob:async id=>{if(state.current!==id)throw failure('no_current_job');state.current=null;state.currentJobs=[];},resume:()=>{}};
 c.lendingView=()=>({enabled:c.settings.enabled,intent:c.settings.intent,current:state.current});
 c.save=async()=>{writesSeen.push({...c.settings});};
 c.durableJsonAsync=(file,value)=>durableWriteAsync(file,JSON.stringify(value),{
  io:{...fs.promises,mkdir:(...args)=>c.mkdir(...args),rename:(...args)=>c.rename(...args)}});
 const stop=runInNewContext('(async function(input){'+route+'})',c);
 const start=runInNewContext(starts+'\nstartLending;',c);
 return {c,state,writesSeen,stop,start};
}

test('Stop turns lending off, and a later Resume starts another job',async t=>{
 const f=fixture(),entered=gate(),release=gate(),resuming=gate();
 const directory=await mkdtemp(join(tmpdir(),'stop-recheck3-'));
 f.c.settingsFile=join(directory,'settings.json');
 await writeFile(f.c.settingsFile,JSON.stringify(f.c.settings));
 const written=[];let mkdirCalls=0;
 Object.assign(f.c,{dirname,randomUUID,open,rm,
  mkdir:async(...args)=>{await mkdir(...args);if(++mkdirCalls===1){entered.resolve();await release.promise;}},
  rename:async(from,to)=>{await rename(from,to);written.push(JSON.parse(await readFile(to,'utf8')).intent);}});
 f.c.atomic=runInNewContext(atomicSource+'\natomic;',f.c);
 f.c.save=runInNewContext(writes+'\nsave;',f.c);
 let stopped,retried,started,final;
 try {
  const first=outcome(f.stop(request));await entered.promise;
  const retry=outcome(f.stop(request));
  f.c.lender.resume=()=>{f.state.current='B';f.state.currentJobs=[{attemptId:'B'}];resuming.resolve();};
  const resume=outcome(f.start('circle',{resume:true}));await resuming.promise;
  release.resolve();[stopped,retried,started]=await Promise.all([first,retry,resume]);
  final=JSON.parse(await readFile(f.c.settingsFile,'utf8'));
 } finally {release.resolve();await rm(directory,{recursive:true,force:true});}
 t.diagnostic(JSON.stringify({written,stopped,retryError:retried?.error?.code,started,final,flights:f.c.stopFlights.size}));
 assert.equal(stopped.error,undefined);
 assert.equal(started.error,undefined);
 assert.equal(retried.error?.code,'no_current_job');
 assert.equal(f.c.stopFlights.size,0);
 assert.equal(written[0],'off','Stop turns lending off');
 assert.equal(written.at(-1),'on','the later Resume stands');
});

test('a queued Stop hold write turns lending off after an earlier settings write',async t=>{
 const f=fixture(),entered=gate(),release=gate(),resuming=gate();
 const directory=await mkdtemp(join(tmpdir(),'stop-recheck3-queue-'));
 f.c.settingsFile=join(directory,'settings.json');
 await writeFile(f.c.settingsFile,JSON.stringify(f.c.settings));
 const written=[];let mkdirCalls=0;
 Object.assign(f.c,{dirname,randomUUID,open,rm,
  mkdir:async(...args)=>{await mkdir(...args);if(++mkdirCalls===1){entered.resolve();await release.promise;}},
  rename:async(from,to)=>{await rename(from,to);written.push(JSON.parse(await readFile(to,'utf8')).intent);}});
 f.c.atomic=runInNewContext(atomicSource+'\natomic;',f.c);
 f.c.save=runInNewContext(writes+'\nsave;',f.c);
 let stopped,retried,started,prior;
 try {
  const predecessor=outcome(f.c.save());await entered.promise;
  const first=outcome(f.stop(request));await tick();assert.equal(f.c.settings.intent,'off','Stop turns lending off in memory at once');
  const retry=outcome(f.stop(request));
  f.c.lender.resume=()=>{f.state.current='B';f.state.currentJobs=[{attemptId:'B'}];resuming.resolve();};
  const resume=outcome(f.start('circle',{resume:true}));await resuming.promise;
  release.resolve();[prior,stopped,retried,started]=await Promise.all([predecessor,first,retry,resume]);
 } finally {release.resolve();await rm(directory,{recursive:true,force:true});}
 t.diagnostic(JSON.stringify({written,stopped,retryError:retried?.error?.code,started,flights:f.c.stopFlights.size}));
 assert.equal(prior.error,undefined);assert.equal(stopped.error,undefined);assert.equal(started.error,undefined);
 assert.equal(retried.error?.code,'no_current_job');assert.equal(f.c.stopFlights.size,0);
 assert.equal(written.at(-1),'on','a queued Stop write saves memory as it is when it runs, so the owner\'s later Resume is not undone');
});

test('Resume remains allowed after Stop turns lending off',async t=>{
 const f=fixture(),offLanded=gate(),release=gate(),resuming=gate();
 const directory=await mkdtemp(join(tmpdir(),'stop-recheck3-order-'));
 f.c.settingsFile=join(directory,'settings.json');const written=[];
 Object.assign(f.c,{dirname,randomUUID,open,rm,mkdir,
  rename:async(from,to)=>{await rename(from,to);written.push(JSON.parse(await readFile(to,'utf8')).intent);
   if(written.length===1){offLanded.resolve();await release.promise;}}});
 f.c.atomic=runInNewContext(atomicSource+'\natomic;',f.c);f.c.save=runInNewContext(writes+'\nsave;',f.c);
 let stopped,started;
 try {
  const first=outcome(f.stop(request));await offLanded.promise;
  f.c.lender.resume=()=>{f.state.current='B';f.state.currentJobs=[{attemptId:'B'}];resuming.resolve();};
  const resume=outcome(f.start('circle',{resume:true}));await resuming.promise;
  release.resolve();[stopped,started]=await Promise.all([first,resume]);
 } finally {release.resolve();await rm(directory,{recursive:true,force:true});}
 t.diagnostic(JSON.stringify({written,stopped,started}));
 assert.equal(stopped.error,undefined);assert.equal(started.error,undefined);
 assert.deepEqual(written,['off','on']);assert.equal(stopped.value.intent,'on');assert.equal(f.c.stopFlights.size,0);
});

test('failing Stop hold persistence rejects Stop even when Resume succeeds',async t=>{
 const f=fixture(),entered=gate(),release=gate(),resuming=gate();
 const directory=await mkdtemp(join(tmpdir(),'stop-recheck3-eio-'));
 f.c.settingsFile=join(directory,'settings.json');const written=[];let mkdirCalls=0;
 Object.assign(f.c,{dirname,randomUUID,open,rm,
  mkdir:async(...args)=>{await mkdir(...args);if(++mkdirCalls===1){entered.resolve();await release.promise;throw failure('EIO');}},
  rename:async(from,to)=>{await rename(from,to);written.push(JSON.parse(await readFile(to,'utf8')).intent);}});
 f.c.atomic=runInNewContext(atomicSource+'\natomic;',f.c);f.c.save=runInNewContext(writes+'\nsave;',f.c);
 let stopped,started;
 try {
  const first=outcome(f.stop(request));await entered.promise;
  f.c.lender.resume=()=>{f.state.current='B';f.state.currentJobs=[{attemptId:'B'}];resuming.resolve();};
  const resume=outcome(f.start('circle',{resume:true}));await resuming.promise;
  release.resolve();[stopped,started]=await Promise.all([first,resume]);
 } finally {release.resolve();await rm(directory,{recursive:true,force:true});}
 t.diagnostic(JSON.stringify({written,stopError:stopped?.error?.code,started}));
 assert.equal(stopped.error?.code,'EIO');assert.equal(started.error,undefined);
 assert.deepEqual(written,['on']);assert.equal(f.c.stopFlights.size,0);
});

for(const durable of [false,true])test('Stop hold keeps a rule revocation queued ahead of it'+(durable?' with the durable engine':''),async()=>{
 const f=fixture(),entered=gate(),release=gate();const disk=[];let held=true;
 Object.assign(f.c.settings,{modes:{circle:'auto'},standingRules:[{id:'rule'}],configVersion:0});
 // The first write is the rule revocation; it waits in the queue while Stop runs.
 f.c.atomic=async(_file,value)=>{const copy=structuredClone(value);if(held){held=false;entered.resolve();await release.promise;}disk.push(copy);};
 if(durable)f.c.lendingRuntime={candidate:{ownerStop:async()=>({applied:true})},
  pace50:{state:()=>({mode:'off',event_ids:['A:owner-stop'],attempts:[]})}};
 const applySaved=slice('  const applySavedSettings=','  const automaticReceipt=');
 const queue=runInNewContext(writes+applySaved+'\n({save,saveThenApply});',f.c);f.c.save=queue.save;
 const revoking=outcome(queue.saveThenApply({standingRules:[],modes:{circle:'ask'},configVersion:1}));
 await entered.promise;
 const stopping=outcome(f.stop(request));await tick();
 release.resolve();
 const [revoked,stopped]=await Promise.all([revoking,stopping]);
 assert.equal(revoked.error,undefined);assert.equal(stopped.error,undefined);
 assert.equal(disk.length,2,'the revocation, then the Stop hold');
 assert.deepEqual(f.c.settings.standingRules,[]);
 assert.deepEqual(disk.at(-1).standingRules,[],'the Stop hold write keeps the revocation on disk');
 assert.equal(disk.at(-1).configVersion,1);assert.equal(disk.at(-1).modes.circle,'ask');
 assert.equal(disk.at(-1).enabled,false,'the Stop hold is on disk');assert.equal(disk.at(-1).intent,'off','Stop turns lending off');
});

test('a Resume saved while Stop waits for the job is not undone by the Stop hold write',async()=>{
 const f=fixture(),stopEntered=gate(),stopRelease=gate(),disk=[];
 f.c.atomic=async(_file,value)=>{disk.push(structuredClone(value));};
 f.c.save=runInNewContext(writes+'\nsave;',f.c);
 f.c.lender.stopCurrentJob=async id=>{stopEntered.resolve();await stopRelease.promise;
  if(f.state.current===id){f.state.current=null;f.state.currentJobs=[];}};
 f.c.lender.resume=()=>{f.state.current='B';f.state.currentJobs=[{attemptId:'B'}];};
 const stopping=outcome(f.stop(request));await stopEntered.promise;
 assert.equal(f.c.settings.enabled,false,'Stop holds lending in memory before it signals the job');
 const resumed=await outcome(f.start('circle',{resume:true}));
 assert.equal(resumed.error,undefined);assert.equal(disk.at(-1).enabled,true,'the Resume is on disk');
 stopRelease.resolve();
 const stopped=await stopping;
 assert.equal(stopped.error,undefined);
 assert.equal(f.c.settings.enabled,true,'the owner resumed after the Stop');
 assert.equal(disk.at(-1).enabled,f.c.settings.enabled,'disk agrees with memory, so a restart keeps the Resume');
});

const automatic=slice('  function autoResume(circleId,','  function schedulePauseEnd()');
const adoption=slice('  async function adoptJoinedCircle(circle) {','  // The person whose job this computer');
function automaticFixture({durable=false}={}) {
 const f=fixture(),entered=gate(),release=gate(),disk=[];
 Object.assign(f.c,{serialize:fn=>fn(),agentCheckTimeoutMs:1000,backgroundCheck:null,
  lenderEvidence:async()=>({due:false}),refreshAgents:async()=>{},lentIds:()=>[],settleWithin,performance,paceEventId:type=>type,
  counterStore:{get:async()=>null},pendingAttempts,
  settingsFile:'fake',atomic:async(_file,value)=>disk.push(structuredClone(value))});
 Object.assign(f.c.settings,{enabled:false,pause_until:100,paused:false});
 f.c.policy.enabled=false;f.c.save=runInNewContext(writes+'\nsave;',f.c);
 f.c.startLending=f.start;
 if(durable)f.c.lendingRuntime={candidate:{ownerStop:async()=>({applied:true})},
  pace50:{deliver:async()=>({applied:true}),state:()=>({mode:'off',event_ids:['A:owner-stop'],attempts:[]})}};
 f.c.lender.stopCurrentJob=async()=>{entered.resolve();await release.promise;f.state.current=null;f.state.currentJobs=[];};
 return {...f,entered,release,disk,auto:runInNewContext(automatic+'\nautoResume;',f.c)};
}

for(const durable of [false,true])test('timer resume waits for Stop and preserves its hold'+(durable?' with durable engine':''),async()=>{
 const f=automaticFixture({durable});
 const stopping=outcome(f.stop(request));await f.entered.promise;
 let finished=false;const resuming=outcome(f.auto('circle',{pauseUntil:100})).then(x=>{finished=true;return x;});
 await tick();const enabledDuringStop=f.c.settings.enabled,finishedDuringStop=finished;
 f.release.resolve();const [stopped,resumed]=await Promise.all([stopping,resuming]);
 assert.equal(stopped.error,undefined);assert.equal(resumed.error,undefined);
 assert.equal(finishedDuringStop,false);assert.equal(enabledDuringStop,false);
 assert.equal(f.c.settings.enabled,false);assert.equal(f.disk.at(-1).enabled,false);
});

test('failed Stop restores the earlier lending state and a later save keeps it',async()=>{
 const f=fixture(),disk=[];
 f.c.atomic=async(_file,value)=>disk.push(structuredClone(value));f.c.save=runInNewContext(writes+'\nsave;',f.c);
 f.c.lender.stopCurrentJob=async()=>{throw failure('EIO');};
 const stopped=await outcome(f.stop(request));await f.c.save();
 assert.equal(stopped.error?.code,'EIO');assert.equal(f.c.settings.enabled,true);
 assert.equal(f.c.policy.enabled,true);assert.equal(disk.at(-1).enabled,true);
});

test('automatic start cannot resume a lender during an open Stop flight',async()=>{
 const f=fixture(),release=gate();f.c.stopFlights.set('A',release.promise);
 const started=await outcome(f.start('circle',{auto:true,expectedEpoch:0}));
 release.resolve();assert.equal(started.error?.code,'lending_busy');assert.equal(f.c.safetyEpoch,0);
});

test('circle adoption stands down while a Stop is persisting its hold',async()=>{
 const f=fixture(),release=gate();f.state.current=null;f.state.currentJobs=[];f.c.stopFlights.set('A',release.promise);
 let stopped=0;Object.assign(f.c,{device:{listCircles:async()=>[]},projectMembership:()=>({phase:'approved'}),
  stopIdleLender:async()=>{stopped++;},applyJoinMode:async()=>{},startLending:async()=>{},now:()=>100});
 await runInNewContext(adoption+'\nadoptJoinedCircle;',f.c)({id:'other',origin:'remote'});
 release.resolve();assert.equal(stopped,0);assert.equal(f.c.settings.activeCircle,'circle');
});

// The approval sweep is internal, so the Quit refusal on API routes does not cover it.
test('circle adoption stands down during an accepted Quit, before and after its first await',async()=>{
 for(const late of [false,true]) {
  const f=fixture();f.state.current=null;f.state.currentJobs=[];
  let stopped=0,started=0;Object.assign(f.c,{projectMembership:()=>({phase:'approved'}),now:()=>100,
   device:{listCircles:async()=>{if(late)f.c.quitting=true;return [];}},
   stopIdleLender:async()=>{stopped++;},applyJoinMode:async()=>{},startLending:async()=>{started++;}});
  if(!late)f.c.quitting=true;
  await runInNewContext(adoption+'\nadoptJoinedCircle;',f.c)({id:'other',origin:'remote'});
  assert.equal(started,0);assert.equal(stopped,0);assert.equal(f.c.settings.activeCircle,'circle');
 }
});

test('durable engine keeps an explicit Resume made while Stop waits for the job',async()=>{
 const f=automaticFixture({durable:true});f.c.settings.enabled=true;f.c.policy.enabled=true;
 const stopping=outcome(f.stop(request));await f.entered.promise;
 const resumed=await outcome(f.start('circle',{resume:true}));f.release.resolve();
 const stopped=await stopping;
 assert.equal(resumed.error,undefined);assert.equal(stopped.error,undefined);
 assert.equal(f.c.settings.enabled,true);assert.equal(f.disk.at(-1).enabled,true);
});

test('timer resumes after a failed Stop releases its flight',async()=>{
 const f=automaticFixture();
 f.c.lender.stopCurrentJob=async()=>{f.entered.resolve();await f.release.promise;throw failure('EIO');};
 const stopping=outcome(f.stop(request));await f.entered.promise;
 const resuming=outcome(f.auto('circle',{pauseUntil:100}));await tick();f.release.resolve();
 const [stopped,resumed]=await Promise.all([stopping,resuming]);
 assert.equal(stopped.error?.code,'EIO');assert.equal(resumed.error,undefined);
 assert.equal(f.c.settings.enabled,true);assert.equal(f.disk.at(-1).enabled,true);
});

test('a newer Off supersedes a timer waiting for a Stop',async()=>{
 const f=automaticFixture();const stopping=outcome(f.stop(request));await f.entered.promise;
 const resuming=outcome(f.auto('circle',{pauseUntil:100}));await tick();
 f.c.safetyEpoch++;f.c.settings.intent='off';f.c.settings.enabled=false;await f.c.save();
 f.release.resolve();await Promise.all([stopping,resuming]);
 assert.equal(f.c.settings.enabled,false);assert.equal(f.disk.at(-1).intent,'off');
});

test('a later Off is not undone when Stop signalling fails',async()=>{
 const f=fixture(),entered=gate(),release=gate();
 f.c.lender.stopCurrentJob=async()=>{entered.resolve();await release.promise;throw failure('EIO');};
 const stopping=outcome(f.stop(request));await entered.promise;
 f.c.safetyEpoch++;f.c.settings.enabled=false;f.c.settings.intent='off';f.c.policy.enabled=false;
 release.resolve();assert.equal((await stopping).error?.code,'EIO');
 assert.equal(f.c.settings.enabled,false);assert.equal(f.c.policy.enabled,false);
});

test('automatic start checks again if Stop begins while its target is resolved',async()=>{
 const f=fixture(),entered=gate(),release=gate(),flight=gate();
 f.c.lendingTarget=async()=>{entered.resolve();await release.promise;return {id:'circle'};};
 const starting=outcome(f.start('circle',{auto:true,expectedEpoch:0}));await entered.promise;
 f.c.stopFlights.set('A',flight.promise);release.resolve();const started=await starting;flight.resolve();
 assert.equal(started.error?.code,'lending_busy');assert.equal(f.c.safetyEpoch,0);
});

test('timer reports lending_busy when a Stop does not settle',async()=>{
 const f=automaticFixture(),flight=gate();f.c.stopFlights.set('A',flight.promise);
 const startedAt=performance.now();const resumed=await outcome(f.auto('circle',{pauseUntil:100}));
 flight.resolve();assert.equal(resumed.error?.code,'lending_busy');
 assert.ok(performance.now()-startedAt>=4900);assert.equal(f.c.settings.enabled,false);
});

test('circle adoption stands down if a Stop finishes while circles are loading',async()=>{
 const f=fixture(),entered=gate(),release=gate();f.state.current=null;f.state.currentJobs=[];
 let stopped=0;Object.assign(f.c,{device:{listCircles:async()=>{entered.resolve();await release.promise;return [];}},
  projectMembership:()=>({phase:'approved'}),stopIdleLender:async()=>{stopped++;},
  applyJoinMode:async()=>{},startLending:async()=>{},now:()=>100});
 const adopting=runInNewContext(adoption+'\nadoptJoinedCircle;',f.c)({id:'other',origin:'remote'});
 await entered.promise;f.c.stopReceipt={attemptId:'A',ok:true};release.resolve();await adopting;
 assert.equal(stopped,0);assert.equal(f.c.settings.activeCircle,'circle');
});

test('Stop for a signed account attempt reaches its lender without a legacy journal entry', async () => {
 const f=fixture();
 let legacyCalls=0,stopped=[];
 f.c.lendingRuntime={pace50:{state:()=>({mode:'on',event_ids:[]})},
   candidate:{ownerStop:async()=>{legacyCalls++;return {applied:false,reason:'attempt_not_found'};}}};
 f.c.lender.ownsSignedAccountAttempt=id=>id==='A';
 const stop=f.c.lender.stopCurrentJob;
 f.c.lender.stopCurrentJob=async id=>{stopped.push(id);await stop(id);};
 const result=await f.stop(request);
 assert.equal(result.intent,'off');
 assert.deepEqual(stopped,['A']);
 assert.equal(legacyCalls,0);
 assert.equal(f.writesSeen.at(-1).intent,'off');
 const replay=await f.stop(request);
 assert.equal(replay.intent,'off');
 assert.deepEqual(stopped,['A']);
});
