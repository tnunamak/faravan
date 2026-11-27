import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext as runVM} from 'node:vm';
import {AppLifetime} from '../lib/v1/app-lifetime.mjs';
const runInNewContext=(source,context)=>{context.lifetime??=new AppLifetime();return runVM(source,context);};

// Execute the actual route with controlled lender transitions. No server, provider,
// browser, timer or sandbox is started. This is a route unit test, not HTTP coverage.
const source=await readFile(new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
const begin=source.indexOf("            if(parts[2]==='stop') {");
const end=source.indexOf("            if(parts[2]==='requester-limits'",begin);
assert.ok(begin>=0&&end>begin,'extract the production Stop route');
const route=source.slice(begin,end);
function fixture({dropLender=false}={}) {
  const state={current:'attempt-1',currentJobs:[{attemptId:'attempt-1'}]};
  let stops=0;
  const context={updateAdmissionHeld:()=>false,cancelResumes:()=>{},parts:['api','lending','stop'],lendingRuntime:null,lendingStopRecords:new Map(),
    lenderStoppedJob:null,stopReceipt:null,stopFlights:new Map(),safetyEpoch:0,safetyIntentEpoch:0,settings:{enabled:true,intent:'on'},policy:{enabled:true},
    runningJobView:async()=>({requester:'synthetic-person'}),now:()=>0,
    save:async()=>{},emit:()=>{},readinessChanged:()=>{},
    fail:(code,status=400)=>{throw Object.assign(new Error(code),{code,status});}};
  context.lender={getState:()=>state,stopCurrentJob:async id=>{
    assert.equal(id,state.current);stops++;
    // Complete cessation before the first request returns; no scheduling race.
    state.current=null;state.currentJobs=[];
  }};
  context.lendingView=()=>({enabled:context.settings.enabled,paused:!context.settings.enabled});
  const stop=runInNewContext(`(async function(input){${route}})`,context);
  return {context,state,stop,stops:()=>stops,clear:()=>{if(dropLender)context.lender=null;}};
}
for(const dropLender of [false,true])test(`repeated Stop is idempotent after cessation, lender absent=${dropLender}`,async()=>{
  const f=fixture({dropLender});
  const request={attemptId:'attempt-1',confirmed:true};
  const first=await f.stop(request);assert.equal(first.enabled,false);
  f.clear();
  const repeated=await f.stop(request);
  assert.equal(repeated.enabled,false);assert.equal(repeated.paused,true);
  assert.equal(f.stops(),1,'do not dispatch cessation twice');
  await assert.rejects(f.stop({...request,attemptId:'unknown'}),{code:'no_current_job',status:409});
});
test('old Stop cannot acknowledge a different current attempt or a resumed session',async()=>{
  const f=fixture();await f.stop({attemptId:'attempt-1',confirmed:true});
  f.state.current='attempt-2';f.state.currentJobs=[{attemptId:'attempt-2'}];
  await assert.rejects(f.stop({attemptId:'attempt-1',confirmed:true}),{code:'no_current_job'});
  f.state.current=null;f.state.currentJobs=[];
  f.context.settings.enabled=true;f.context.settings.intent='on';f.context.stopReceipt=null;
  await assert.rejects(f.stop({attemptId:'attempt-1',confirmed:true}),{code:'no_current_job'});
  assert.equal(f.stops(),1);
});
test('a stop that never succeeded creates no retry receipt',async()=>{
  const f=fixture();f.context.lender.stopCurrentJob=async()=>{throw Object.assign(new Error('stop_failed'),{code:'stop_failed'});};
  await assert.rejects(f.stop({attemptId:'attempt-1',confirmed:true}),{code:'stop_failed'});
  // The failed Stop reopens admission, so lending is not left off without an owner choice.
  assert.equal(f.context.settings.enabled,true);assert.equal(f.context.policy.enabled,true);
  f.state.current=null;f.state.currentJobs=[];
  await assert.rejects(f.stop({attemptId:'attempt-1',confirmed:true}),{code:'no_current_job'});
  assert.equal(f.context.lenderStoppedJob,null);
});
test('Stop still requires confirmation and stoppedJob stays requester-only',async()=>{
  const f=fixture();
  await assert.rejects(f.stop({attemptId:'attempt-1'}),{code:'invalid_request',status:400});
  await assert.rejects(f.stop({attemptId:'attempt-1',confirmed:true,extra:true}),{code:'invalid_request',status:400});
  await f.stop({attemptId:'attempt-1',confirmed:true});
  const projection=source.match(/const stoppedJob=([^;]+);/)[1];
  const publicValue=runInNewContext(projection,f.context);
  assert.deepEqual(JSON.parse(JSON.stringify(publicValue)),{requester:'synthetic-person'});
});
test('repeated Stop succeeds when the job finishes between the state read and the stop call',async()=>{
  // The gate race: the route reads the lender state (job still listed), awaits, and by the time it
  // calls stopCurrentJob the stopped job has finished, so the lender answers no_current_job.
  const f=fixture();await f.stop({attemptId:'attempt-1',confirmed:true});
  f.state.current='attempt-1';f.state.currentJobs=[{attemptId:'attempt-1'}];
  f.context.lender.stopCurrentJob=async()=>{f.state.current=null;f.state.currentJobs=[];
    throw Object.assign(new Error('no_current_job'),{code:'no_current_job'});};
  const repeated=await f.stop({attemptId:'attempt-1',confirmed:true});
  assert.equal(repeated.enabled,false);assert.equal(repeated.paused,true);
  assert.equal(f.stops(),1);
});
test('the finish race never acknowledges a different job that is still running',async()=>{
  const f=fixture();await f.stop({attemptId:'attempt-1',confirmed:true});
  f.state.current='attempt-1';f.state.currentJobs=[{attemptId:'attempt-1'}];
  f.context.lender.stopCurrentJob=async()=>{f.state.current='attempt-2';f.state.currentJobs=[{attemptId:'attempt-2'}];
    throw Object.assign(new Error('no_current_job'),{code:'no_current_job'});};
  await assert.rejects(f.stop({attemptId:'attempt-1',confirmed:true}),{code:'no_current_job'});
});

// Witnesses from docs/reviews/repeated-stop-review-1026.md: persistence, durable receipts and concurrent Stops.
const gate=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const noCurrent=()=>Object.assign(new Error('no_current_job'),{code:'no_current_job',status:409});
function persistedFixture() {
  const f=fixture();const persisted={enabled:true,intent:'on'};let saves=0;
  f.context.save=async()=>{saves++;Object.assign(persisted,f.context.settings);};
  f.context.lender.stopCurrentJob=async id=>{if(f.state.current!==id)throw noCurrent();f.state.current=null;f.state.currentJobs=[];};
  return Object.assign(f,{persisted,saves:()=>saves});
}
function durableReceipt(f,{mode='on'}={}) {
  f.context.lendingRuntime={pace50:{state:()=>({mode,event_ids:['attempt-1:owner-stop'],attempts:[{id:'attempt-1',process_state:'ceased'}]})},
    candidate:{ownerStop:async()=>({reason:'duplicate_event'})}};
}
const request={attemptId:'attempt-1',confirmed:true};
test('a retry after a failed Stop hold write persists the hold before it answers',async()=>{
  const f=persistedFixture();
  f.context.save=async()=>{throw Object.assign(new Error('EIO'),{code:'EIO'});};
  await assert.rejects(f.stop(request),{code:'EIO'});
  f.context.save=async()=>{Object.assign(f.persisted,f.context.settings);};
  assert.equal((await f.stop(request)).enabled,false);
  assert.equal(f.persisted.enabled,false,'a successful retry leaves admission held on disk');
  assert.equal(f.persisted.intent,'off','Stop turns lending off, and the hold on disk says so');
});
test('a retry after a failed Stop hold write that fails again reports the failure',async()=>{
  const f=persistedFixture();
  f.context.save=async()=>{throw Object.assign(new Error('EIO'),{code:'EIO'});};
  await assert.rejects(f.stop(request),{code:'EIO'});
  await assert.rejects(f.stop(request),{code:'EIO'});
});
test('a retry waits for the first Stop hold write',async()=>{
  const f=persistedFixture(),entered=gate(),release=gate();
  f.context.save=async()=>{entered.resolve();await release.promise;Object.assign(f.persisted,f.context.settings);};
  const first=f.stop(request);await entered.promise;
  let answered=false;const retry=f.stop(request).then(view=>{answered=true;return view;});
  for(let i=0;i<5;i++)await Promise.resolve();
  assert.equal(answered,false,'the retry answered before the Stop hold was on disk');
  release.resolve();await first;assert.equal((await retry).enabled,false);
});
test('a durable receipt never acknowledges a Stop while another job runs in a resumed session',async()=>{
  const f=persistedFixture();await f.stop(request);durableReceipt(f);
  f.state.current='attempt-2';f.state.currentJobs=[{attemptId:'attempt-2'}];
  f.context.settings.enabled=true;f.context.settings.intent='on';f.context.policy.enabled=true;
  await assert.rejects(f.stop(request),{code:'no_current_job'});
});
test('a durable receipt cannot acknowledge after On resumes and the local receipt clears',async()=>{
  const f=persistedFixture();await f.stop(request);f.context.stopReceipt=null;f.context.lenderStoppedJob=null;durableReceipt(f);
  f.context.settings.enabled=true;f.context.settings.intent='on';f.context.policy.enabled=true;
  await assert.rejects(f.stop(request),{code:'no_current_job'});
  assert.equal(f.state.current,null,'the durable receipt cannot dispatch another Stop');
});
test('a durable receipt answers a retry after the local receipt is gone while lending stays off',async()=>{
  const f=persistedFixture();await f.stop(request);f.context.lenderStoppedJob=null;durableReceipt(f,{mode:'off'});
  assert.equal((await f.stop(request)).enabled,false);
});
test('two first Stops of the same attempt both succeed',async()=>{
  const f=persistedFixture(),firstView=gate(),secondView=gate();let views=0;
  f.context.runningJobView=()=>++views===1?firstView.promise:secondView.promise;
  const first=f.stop(request),second=f.stop(request);
  assert.equal(views,1,'the second Stop waits for the first instead of stopping again');
  firstView.resolve({requester:'synthetic-person'});await first;
  secondView.resolve({requester:'synthetic-person'});
  assert.equal((await second).enabled,false);
  assert.equal(f.saves(),1,'one Stop hold write');
});

// Witnesses from docs/reviews/repeated-stop-recheck-1026.md. They also run the real start wrapper and settings queue.
const slice=(from,to)=>{const a=source.indexOf(from),b=source.indexOf(to,a);assert.ok(a>=0&&b>a,from);return source.slice(a,b);};
const starts=slice('  async function startLending(circle,options={}) {','  // The standing rules a mode change would leave;');
const writes=slice('  let settingsWrites=Promise.resolve();','  const counterStore=createLenderCounterStorage');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const fail409=code=>Object.assign(new Error(code),{code,status:409});
function startFixture({durable=false}={}) {
  const state={current:'attempt-1',currentJobs:[{attemptId:'attempt-1'}]};
  const persisted={enabled:true,intent:'on'};let saves=0;
  const c={stopCheckCoordinator:null,initHost:()=>({}),updateAdmissionHeld:()=>false,cancelResumes:()=>{},parts:['api','lending','stop'],lendingRuntime:null,lendingStopRecords:new Map(),lenderStoppedJob:null,stopReceipt:null,stopFlights:new Map(),
    safetyEpoch:0,safetyIntentEpoch:0,timedResume:null,settings:{enabled:true,intent:'on',activeCircle:'circle'},policy:{enabled:true},
    checkSignInBeforeClaim:async()=>{},
    runningJobView:async()=>({requester:'synthetic-person'}),now:()=>0,emit:()=>{},readinessChanged:()=>{},
    fail:(code,status=400)=>{throw Object.assign(new Error(code),{code,status});},
    clearTimeout:()=>{},pauseTimer:null,closed:false,quitting:false,lenderInit:null,resumeFailed:null,
    lendingTarget:async()=>({id:'circle'}),settingsFile:'synthetic-settings'};
  c.lender={getState:()=>state,stopCurrentJob:async id=>{if(state.current!==id)throw fail409('no_current_job');state.current=null;state.currentJobs=[];},resume:()=>{}};
  c.lendingView=()=>({enabled:c.settings.enabled,intent:c.settings.intent,current:state.current});
  c.save=async()=>{saves++;Object.assign(persisted,c.settings);};
  if(durable)c.lendingRuntime={pace50:{state:()=>({mode:'off',event_ids:['attempt-1:owner-stop'],attempts:[{id:'attempt-1',process_state:'ceased'}]})},
    candidate:{ownerStop:async()=>({reason:'duplicate_event'})}};
  const stop=runInNewContext(`(async function(input){${route}})`,c);
  const start=runInNewContext(starts+'\nstartLending;',c);
  return {c,state,persisted,stop,start,saves:()=>saves};
}
test('concurrent retries after a failed Stop hold write share one recovery write',async()=>{
  const f=startFixture();f.c.save=async()=>{throw fail409('EIO');};
  await assert.rejects(f.stop(request),{code:'EIO'});
  const hold=gate();let recoveries=0;
  f.c.save=async()=>{recoveries++;await hold.promise;Object.assign(f.persisted,f.c.settings);};
  const a=f.stop(request),b=f.stop(request);await tick();
  const observed=recoveries;hold.resolve();await Promise.all([a,b]);
  assert.equal(observed,1);assert.equal(f.persisted.enabled,false);
});
test('a retry waiting for the Stop hold does not acknowledge A after a resume starts B',async()=>{
  const f=startFixture(),entered=gate(),release=gate(),resuming=gate();let n=0;
  f.c.atomic=async(_file,settings)=>{const snapshot={...settings};if(++n===1){entered.resolve();await release.promise;}Object.assign(f.persisted,snapshot);};
  f.c.save=runInNewContext(writes+'\nsave;',f.c);
  const first=f.stop(request);await entered.promise;
  const retry=f.stop(request);
  f.c.lender.resume=()=>{f.state.current='attempt-2';f.state.currentJobs=[{attemptId:'attempt-2'}];resuming.resolve();};
  const resumed=f.start('circle',{resume:true});await resuming.promise;
  release.resolve();
  const [,retried]=await Promise.allSettled([first,retry,resumed]);
  assert.equal(retried.status,'rejected');assert.equal(retried.reason.code,'no_current_job');
});
test('a retry during a refused start waits until the Stop hold is on disk',async()=>{
  const f=startFixture({durable:true});f.c.save=async()=>{throw fail409('EIO');};
  await assert.rejects(f.stop(request),{code:'EIO'});
  const selected=gate();f.c.lendingTarget=()=>selected.promise;
  const starting=f.start('circle',{resume:true}).then(()=>null,e=>e);
  assert.equal(f.c.lenderStoppedJob?.requester,'synthetic-person','the refused start keeps the requester explanation');
  assert.equal(f.c.lenderStoppedJob?.attemptId,'attempt-1');
  const response=await f.stop(request).then(view=>({view}),error=>({error}));
  selected.reject(fail409('lending_busy'));await starting;
  if(response.view)assert.equal(f.persisted.enabled,false,'a successful retry leaves admission held on disk');
  else assert.equal(response.error.code,'EIO');
});
test('a second first Stop waits while the first is still stopping the job',async()=>{
  const f=startFixture(),dispatch=gate(),release=gate();
  f.c.lender.stopCurrentJob=async id=>{if(f.state.current!==id)throw fail409('no_current_job');
    f.state.current=null;f.state.currentJobs=[];dispatch.resolve();await release.promise;};
  const first=f.stop(request),second=f.stop(request).then(value=>({value}),error=>({error}));
  await dispatch.promise;await tick();release.resolve();await first;
  const result=await second;
  assert.equal(result.error,undefined);assert.equal(result.value.enabled,false);
});
test('a refused start keeps the Stop explanation, and a retry waits for the hold write',async()=>{
  const f=startFixture(),entered=gate(),release=gate();
  f.c.save=async()=>{entered.resolve();await release.promise;Object.assign(f.persisted,f.c.settings);};
  const first=f.stop(request);await entered.promise;
  const explanation=f.c.lenderStoppedJob;
  f.c.lendingTarget=async()=>{throw fail409('lending_busy');};
  await assert.rejects(f.start('circle'),{code:'lending_busy'});
  assert.equal(f.c.lenderStoppedJob,explanation);
  const projected=runInNewContext(source.match(/const stoppedJob=([^;]+);/)[1],f.c);
  assert.deepEqual(JSON.parse(JSON.stringify(projected)),{requester:'synthetic-person'});
  let answered=false;const retry=f.stop(request).then(v=>{answered=true;return v;});await tick();
  const premature=answered;release.resolve();await Promise.all([first,retry]);
  assert.equal(premature,false);assert.equal(f.persisted.enabled,false);
});
test('failed recovery writes are reported, and a later retry can still succeed',async()=>{
  const f=startFixture();f.c.save=async()=>{throw fail409('EIO');};
  await assert.rejects(f.stop(request),{code:'EIO'});
  await Promise.all([assert.rejects(f.stop(request),{code:'EIO'}),assert.rejects(f.stop(request),{code:'EIO'})]);
  f.c.save=async()=>{Object.assign(f.persisted,f.c.settings);};
  assert.equal((await f.stop(request)).enabled,false);assert.equal(f.persisted.enabled,false);
});
test('a retry of a Stop whose first write fails waits and succeeds with one recovery write',async()=>{
  const f=startFixture(),entered=gate(),release=gate();let n=0;
  f.c.save=async()=>{if(++n===1){entered.resolve();await release.promise;throw fail409('EIO');}Object.assign(f.persisted,f.c.settings);};
  const first=f.stop(request),failed=assert.rejects(first,{code:'EIO'});await entered.promise;
  const retry=f.stop(request);release.resolve();await failed;
  assert.equal((await retry).enabled,false);assert.equal(f.persisted.enabled,false);assert.equal(n,2);
});
test('a successful start clears the receipt, so lending turned off later does not answer an old Stop',async()=>{
  const f=startFixture();await f.stop(request);
  await f.start('circle',{resume:true});
  assert.equal(f.c.stopReceipt,null);
  f.state.current=null;f.state.currentJobs=[];f.c.settings.enabled=false;f.c.settings.intent='off';
  await assert.rejects(f.stop(request),{code:'no_current_job'});
});

// Witnesses from docs/reviews/repeated-stop-recheck2-1027.md.
test('Stops waiting on a failed Stop share one new Stop of the job',async()=>{
  const f=startFixture(),entered=gate(),failFirst=gate(),secondEntered=gate(),releaseSecond=gate();let n=0;
  f.c.lender.stopCurrentJob=async id=>{
    n++;
    if(n===1){entered.resolve();await failFirst.promise;throw fail409('transient_stop_failure');}
    if(f.state.current!==id)throw fail409('no_current_job');
    f.state.current=null;f.state.currentJobs=[];secondEntered.resolve();await releaseSecond.promise;
  };
  const a=f.stop(request).then(value=>({value}),error=>({error}));await entered.promise;
  const b=f.stop(request),c=f.stop(request);
  failFirst.resolve();assert.equal((await a).error.code,'transient_stop_failure');
  await secondEntered.promise;await tick();
  const registered=f.c.stopFlights.size;
  releaseSecond.resolve();
  const [second,third]=await Promise.all([b,c]);
  assert.equal(second.enabled,false);assert.equal(third.enabled,false,'the third Stop adopts the second, not 409');
  assert.equal(n,2,'one failed dispatch and one shared retry');
  assert.equal(registered,1,'the running retry stays registered');
  assert.equal(f.c.stopFlights.size,0);
});
test('the first Stop answers with the state now, after its hold write, when a Resume ran meanwhile',async()=>{
  const f=startFixture(),entered=gate(),release=gate(),resuming=gate();let n=0;const written=[];
  f.c.atomic=async(_file,settings)=>{const snapshot={...settings};if(++n===1){entered.resolve();await release.promise;}
    written.push(snapshot.intent);Object.assign(f.persisted,snapshot);};
  f.c.save=runInNewContext(writes+'\nsave;',f.c);
  const first=f.stop(request);await entered.promise;
  const retry=f.stop(request);
  f.c.lender.resume=()=>{f.state.current='attempt-2';f.state.currentJobs=[{attemptId:'attempt-2'}];resuming.resolve();};
  const resumed=f.start('circle',{resume:true});await resuming.promise;
  release.resolve();
  const [stopped,retried,started]=await Promise.allSettled([first,retry,resumed]);
  // Stop(A) turns lending off first; the owner's Resume then starts B, and that later choice stands.
  assert.equal(stopped.status,'fulfilled');assert.deepEqual(stopped.value,{enabled:true,intent:'on',current:'attempt-2'});
  assert.equal(written[0],'off');assert.equal(written.at(-1),'on');assert.equal(f.persisted.intent,'on');
  assert.equal(retried.status,'rejected');assert.equal(retried.reason.code,'no_current_job');
  assert.equal(started.status,'fulfilled');
  assert.equal(f.c.stopFlights.size,0);
});
