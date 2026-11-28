import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext as runVM} from 'node:vm';
import {AppLifetime} from '../lib/v1/app-lifetime.mjs';
import {clientFailure} from '../lib/v1/client.mjs';
function runInNewContext(source,context) {
  context.lifetime??=new AppLifetime();
  context.stopCheckCoordinator??=null;
  context.clientFailure=clientFailure;
  context.resumeRetryAt??=0;context.resumeRetryDelay??=0;
  return runVM(source,context);
}

import {createLendingPool} from '../lib/v1/lending-pool.mjs';
import {pendingAttempts} from '../lib/v1/durable-cessation.mjs';
import {settleWithin} from '../lib/v1/settle-within.mjs';

// Run production controls and pool dispatch with held worker/offer effects. These
// tests establish ordering, not provider or sandbox behavior.
const source=await readFile(new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
const slice=(from,to)=>{const a=source.indexOf(from),b=source.indexOf(to,a);assert.ok(a>=0&&b>a,from);return source.slice(a,b);};
const starts=slice('  async function startLending(circle,options={}) {','  // The standing rules a mode change would leave;');
const recovery=slice('  async function resumeAfterStopRecovery(', '  // Owner Stop requests this process accepted');
const stopRoute=slice("            if(parts[2]==='stop') {","            if(parts[2]==='requester-limits'");
const pauseBegin=source.indexOf("            if(['off','pause'].includes(parts[2])) {");
const pauseEnd=source.lastIndexOf('\n          }',source.indexOf("          if(parts[1]==='approvals'",pauseBegin));
const pauseRoute=source.slice(pauseBegin,pauseEnd);
const poolBegin=source.indexOf('    lender=createLendingPool(');
const callbackBegin=source.indexOf('onEvent:',poolBegin)+'onEvent:'.length;
const callbackEnd=source.indexOf('\n    }});',callbackBegin)+6;
assert.ok(poolBegin>=0&&callbackBegin>poolBegin&&callbackEnd>callbackBegin,'extract the pool callback');
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const fail=(code,status=400)=>{throw Object.assign(new Error(code),{code,status});};

async function stopFixture(t,{sibling='idle'}={}) {
  let disk=null;
  const children=[],events=[],deliveries=[],started=gate(),abort=new AbortController();
  const c={updateAdmissionHeld:()=>false,settings:{enabled:true,intent:'on',activeCircle:'circle',paused:false,pause_until:null},policy:{enabled:true},
    safetyEpoch:0,safetyIntentEpoch:0,timedResume:null,resumeFailed:null,closed:false,quitting:false,lenderInit:null,now:()=>100,stopFlights:new Map(),lendingStopRecords:new Map(),stopReceipt:null,lenderStoppedJob:null,
    checkSignInBeforeClaim:async()=>{},
    cancelResumes:()=>{},parts:['api','lending','stop'],runningJobView:async()=>({requester:'friend'}),save:async()=>{},fail,
    paceEventId:type=>type,lendingRuntime:null,pendingAttempts,
    confirmedExecutionAttempts:new Map(),lenderObservationSignature:null,lenderObservationGeneration:0,
    device:{keyId:'owner'},selected:{id:'circle'},lastLendingShape:null,
    publicState:value=>value,emit:()=>{},nudgeHeartbeat:()=>{},readinessChanged:()=>{},closeReadingSandboxes:async()=>{},
    resumeDurableCandidate:async()=>{deliveries.push('on');}};
  c.lendingView=()=>({enabled:c.settings.enabled,intent:c.settings.intent});
  runInNewContext(recovery,c);
  const callback=runInNewContext('('+source.slice(callbackBegin,callbackEnd)+')',c);
  const storage={get:async()=>structuredClone(disk),set:async value=>{disk=structuredClone(value);},acquire:async()=>()=>{}};
  c.counterStore=storage;
  c.lender=createLendingPool({storage,policy:c.policy,capacity:2,
    adapters:[{spec:{harness_id:'claude-code-subscription'}},{spec:{harness_id:'codex'}}],
    onEvent:event=>{events.push(event);callback(event);},
    createLender:options=>{
      const child={options,state:{status:'idle',current:null},
        getState:()=>child.state,pause(){},resume(){child.resumes++;},resumes:0,cessation:()=>({proven:true}),
        start:signal=>new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true})),
        stopCurrentJob:async id=>{
          assert.equal(id,child.state.current);
          const saved=await options.policy.storage.get();
          await options.policy.storage.set({...saved,pending:{...saved.pending,stopReason:'stopped_by_lender'}});
          child.state={status:'stopping',reason:'stopped_by_lender',current:id};
        }};
      children.push(child);if(children.length===2)started.resolve();return child;
    }});
  const loop=c.lender.start(abort.signal);
  t.after(async()=>{abort.abort();await loop;});
  await started.promise;
  async function running(index) {
    const child=children[index],attemptId='attempt-'+index;
    child.state={status:'running',current:attemptId};
    await child.options.policy.storage.set({jobs:0,milliseconds:0,pending:{attemptId,
      attempt:{attempt_id:attemptId,job_digest:'job-'+index,generation:1}}});
  }
  if(sibling==='running')await running(0);
  await running(1);
  const stop=runInNewContext(`(async function(input){${stopRoute}})`,c);
  async function complete(index) {
    const child=children[index],store=child.options.policy.storage,saved=await store.get();
    const attempt=saved.pending.attempt;
    await store.set({...saved,pending:null});
    child.state={status:'stopped',reason:'stopped_by_lender',current:null};
    child.options.onEvent({...child.state,stopCompletion:{attemptId:attempt.attempt_id,jobDigest:attempt.job_digest,generation:attempt.generation}});
    await tick();
  }
  return {c,children,events,deliveries,stop,complete};
}

// The owner's Stop turns lending off (lending.stop_job contract), so recovery has nothing to restore. Recovery still
// restores a saved On intent for a stop the owner did not make (a Quit stops the job and keeps On for the next start).
// The tests below model that saved intent after the Stop with keepOn.
const keepOn=f=>{f.c.settings.intent='on';};

for(const sibling of ['idle','running'])test('owner Stop of the second account turns lending off and recovery leaves it off beside its '+sibling+' sibling',async t=>{
  const f=await stopFixture(t,{sibling});
  await f.stop({attemptId:'attempt-1',confirmed:true});
  assert.equal(f.c.settings.intent,'off');assert.equal(f.c.settings.enabled,false);
  await f.complete(1);
  assert.equal(f.c.settings.enabled,false,'Stop recovery must not turn lending back on');
  assert.equal(f.c.settings.intent,'off');assert.equal(f.c.policy.enabled,false);
  assert.deepEqual(f.deliveries,[],'the durable candidate stays off');
  assert.deepEqual(f.events.at(-1).stopCompletion,{attemptId:'attempt-1',jobDigest:'job-1',generation:1});
  assert.equal(f.children[0].state.current,sibling==='running'?'attempt-0':null,'the sibling is undisturbed');
});

for(const sibling of ['idle','running'])test('recovery restores a saved On intent beside its '+sibling+' sibling',async t=>{
  const f=await stopFixture(t,{sibling});
  await f.stop({attemptId:'attempt-1',confirmed:true});keepOn(f);
  assert.equal(f.c.settings.enabled,false);
  await f.complete(1);
  assert.equal(f.c.settings.enabled,true,'the source Stop completion restores admission');
  assert.equal(f.c.policy.enabled,true);
  assert.deepEqual(f.deliveries,['on']);
  assert.deepEqual(f.events.at(-1).stopCompletion,{attemptId:'attempt-1',jobDigest:'job-1',generation:1});
  assert.equal(f.events.at(-1).account,'codex:0');
  assert.equal(f.children[0].state.current,sibling==='running'?'attempt-0':null,'the sibling is undisturbed');
});

test('two concurrent Stops reopen a saved On intent only after both recovery journals clear',async t=>{
  const f=await stopFixture(t,{sibling:'running'});
  await Promise.all([f.stop({attemptId:'attempt-0',confirmed:true}),f.stop({attemptId:'attempt-1',confirmed:true})]);keepOn(f);
  // A worker can be locally idle while its stopped report remains unacknowledged.
  f.children[0].state={status:'stopped',reason:'stopped_by_lender',current:null};
  await f.complete(1);
  assert.equal(f.c.settings.enabled,false,'the other Stop still owns a recovery hold');
  assert.deepEqual(f.deliveries,[],'do not turn the durable candidate on early');
  await f.complete(0);
  assert.equal(f.c.settings.enabled,true);
  assert.deepEqual(f.deliveries,['on']);
});

test('Stop during automatic start fences it, and recovery leaves lending off',async t=>{
  const f=await stopFixture(t),entered=gate(),release=gate();
  t.after(()=>release.resolve());
  f.c.lendingTarget=async()=>{entered.resolve();await release.promise;return {id:'circle'};};
  f.c.clearTimeout=()=>{};f.c.pauseTimer=null;
  const start=runInNewContext(starts+'\nstartLending;',f.c);
  const starting=start('circle',{auto:true,expectedEpoch:f.c.safetyEpoch,expectedStopReceipt:f.c.stopReceipt});
  await entered.promise;
  await f.stop({attemptId:'attempt-1',confirmed:true});
  assert.equal(f.c.settings.intent,'off','Stop turns lending off while cessation is pending');
  assert.equal(f.c.settings.enabled,false);
  release.resolve();
  await assert.rejects(starting,{code:'lending_busy'});
  assert.equal(f.c.settings.enabled,false,'the stale automatic start cannot reopen admission');
  await f.complete(1);
  assert.equal(f.c.settings.intent,'off');
  assert.equal(f.c.settings.enabled,false,'cessation proof does not turn lending back on');
  assert.ok(!f.children.some(child=>child.resumes>0),'recovery does not resume the worker');
});

test('Stop recovery waits for a sibling Stop that has not written its journal yet',async t=>{
  const f=await stopFixture(t,{sibling:'running'}),entered=gate(),release=gate();
  t.after(()=>release.resolve({requester:'friend'}));
  await f.stop({attemptId:'attempt-1',confirmed:true});keepOn(f);
  f.c.runningJobView=()=>{entered.resolve();return release.promise;};
  const stopping=f.stop({attemptId:'attempt-0',confirmed:true});
  await entered.promise;
  await f.complete(1);
  assert.equal(f.c.settings.enabled,false,'an accepted Stop owns a hold before its journal write');
  assert.deepEqual(f.deliveries,[]);
  release.resolve({requester:'friend'});await stopping;keepOn(f);await tick();
  assert.equal(f.c.settings.enabled,false,'the newly written Stop journal retains the hold');
  await f.complete(0);
  assert.equal(f.c.settings.enabled,true);
});

test('a release-only Stop journal also holds recovery admission',async t=>{
  const f=await stopFixture(t),store=f.children[0].options.policy.storage;
  await f.stop({attemptId:'attempt-1',confirmed:true});
  await store.set({jobs:0,milliseconds:0,declinePending:{stoppedByLender:true,attempt:{attempt_id:'release-only'}}});
  await f.complete(1);
  assert.equal(f.c.settings.enabled,false);
  assert.deepEqual(f.deliveries,[]);
});

test('a refused Resume does not cancel Stop recovery already restoring On',async t=>{
  const f=await stopFixture(t),entered=gate(),release=gate();
  t.after(()=>release.resolve());
  await f.stop({attemptId:'attempt-1',confirmed:true});keepOn(f);
  f.c.resumeDurableCandidate=async()=>{entered.resolve();await release.promise;};
  await f.complete(1);await entered.promise;
  f.c.clearTimeout=()=>{};f.c.pauseTimer=null;
  f.c.lendingTarget=async()=>fail('circle_required',409);
  const start=runInNewContext(starts+'\nstartLending;',f.c);
  await assert.rejects(start('circle',{resume:true}),{code:'circle_required'});
  release.resolve();await tick();
  assert.equal(f.c.settings.enabled,true,'a refused control does not supersede recovery');
});

for(const timed of [false,true])test('held Pause settlement cannot override '+(timed?'timed expiry':'a newer Resume'),async()=>{
  const entered=gate(),release=gate(),events=[],actions=[];
  let time=100,durable='on',timer;
  const c={stopCheckCoordinator:null,initHost:()=>({}),updateAdmissionHeld:()=>false,cancelResumes:()=>{},parts:['api','lending','pause'],settings:{enabled:true,intent:'on',activeCircle:'circle',paused:false,pause_until:null},
    policy:{enabled:true},safetyEpoch:0,safetyIntentEpoch:0,timedResume:null,closed:false,quitting:false,lenderInit:null,resumeFailed:null,pauseTimer:null,stopFlights:new Map(),stopReceipt:null,
    checkSignInBeforeClaim:async()=>{},
    approvals:new Map(),acceptedApprovalPromises:new Set(),clearTimeout:()=>{},now:()=>time,
    paceEventId:type=>type,emit:(kind,event)=>{if(kind==='lending-action')actions.push(event.action);},readinessChanged:()=>{},closeReadingSandboxes:async()=>{},
    settleWithin,save:async()=>{},lendingTarget:async()=>({id:'circle'}),fail,pendingAttempts,counterStore:{get:async()=>null},
    lender:{getState:()=>({current:null}),pause:()=>{},resume:()=>{},settleAcceptedOffers:()=>{entered.resolve();return release.promise;}}};
  c.save=async()=>{const event=c.settings.paused||c.settings.pause_until?'pause':c.settings.intent;events.push(event);durable=event==='pause'?'paused':event;};
  c.lendingView=()=>({enabled:c.settings.enabled,intent:c.settings.intent});
  const start=runInNewContext(starts+'\nstartLending;',c);
  // Capture the production timer callback, then fire it at the deadline with a
  // controlled clock. autoResume executes the same start wrapper as the route.
  c.setTimeout=fn=>{timer=fn;return {unref(){}};};
  c.autoResume=(_circle,options)=>start('circle',{resume:true,auto:true,expectedEpoch:options.epoch});
  runInNewContext(slice('  function schedulePauseEnd() {','  async function lendingTarget('),c);
  const pause=runInNewContext(`(async function(input){${pauseRoute}})`,c);
  const pausing=pause(timed?{until:200}:{});
  await entered.promise;
  // Capture is synchronous. Let the mock durable/save microtasks finish so
  // Pause is waiting for settlement before the newer control starts.
  await tick();
  assert.equal(c.policy.enabled,false);
  if(timed){time=200;timer();await tick();}else await start('circle',{resume:true});
  assert.equal(c.settings.enabled,true,'Resume completed while settlement is held');
  assert.equal(durable,'on');
  release.resolve();const response=await pausing;
  assert.equal(response.enabled,true,'the older request returns the current resumed view');
  assert.equal(c.settings.intent,'on');
  assert.equal(c.settings.paused,false);
  assert.equal(c.settings.pause_until,null);
  assert.equal(durable,'on','the older continuation cannot overwrite the resumed settings');
  assert.deepEqual(events,['pause','on'],'durable Pause precedes settlement and Resume');
  assert.equal(actions.at(-1),'resumed','no stale paused action follows Resume');
});

test('Pause closes waiting reviews without hiding offers before durable storage',async()=>{
  const durable=gate();let hidden=false,finished=false;
  const c={updateAdmissionHeld:()=>false,cancelResumes:()=>{},parts:['api','lending','pause'],settings:{enabled:true,intent:'on'},policy:{enabled:true},
    safetyEpoch:0,safetyIntentEpoch:0,timedResume:null,closed:false,approvals:new Map([['offer-a',{finish:()=>{finished=true;}}]]),acceptedApprovalPromises:new Set(),schedulePauseEnd:()=>{},
    now:()=>100,paceEventId:type=>type,emit:()=>{},readinessChanged:()=>{},closeReadingSandboxes:async()=>{},settleWithin,fail,
    save:()=>durable.promise,
    lender:{pause:()=>{},hideWaitingOffers:async()=>{hidden=true;},settleAcceptedOffers:async()=>{}},
    lendingView:()=>({enabled:false})};
  const pause=runInNewContext(`(async function(input){${pauseRoute}})`,c);
  const pausing=pause({});
  await tick();assert.equal(finished,true);assert.equal(hidden,false);
  durable.resolve({applied:true});await pausing;
});

test('a refused Resume cannot discard the earlier Pause save',async()=>{
  const durable=gate(),writes=[];
  const c={updateAdmissionHeld:()=>false,cancelResumes:()=>{},parts:['api','lending','pause'],settings:{enabled:true,intent:'on',activeCircle:'circle',paused:false,pause_until:null},
    policy:{enabled:true},safetyEpoch:0,safetyIntentEpoch:0,timedResume:null,closed:false,quitting:false,lenderInit:null,pauseTimer:null,clearTimeout:()=>{},resumeFailed:null,
    checkSignInBeforeClaim:async()=>{},
    approvals:new Map(),acceptedApprovalPromises:new Set(),schedulePauseEnd:()=>{},now:()=>100,paceEventId:type=>type,
    save:async value=>{writes.push(structuredClone(value??c.settings));await durable.promise;},emit:()=>{},readinessChanged:()=>{},closeReadingSandboxes:async()=>{},settleWithin,fail,
    lendingTarget:async()=>fail('circle_required',409),
    lender:{getState:()=>({current:null}),pause:()=>{},hideWaitingOffers:async()=>{},settleAcceptedOffers:async()=>{}}};
  c.lendingView=()=>({enabled:c.settings.enabled,intent:c.settings.intent});
  const pause=runInNewContext(`(async function(input){${pauseRoute}})`,c);
  const start=runInNewContext(starts+'\nstartLending;',c);
  const pausing=pause({});
  await assert.rejects(start('circle',{resume:true}),{code:'circle_required'});
  durable.resolve({applied:true});await pausing;
  assert.equal(writes.at(-1)?.intent,'paused','acknowledged Pause remains durable when a newer start fails');
  assert.equal(writes.at(-1)?.paused,true);
});

test('On can retire a legacy local lender before waiting for a real circle',async()=>{
  const c={updateAdmissionHeld:()=>false,settings:{enabled:false,intent:'off',activeCircle:'legacy'},safetyEpoch:0,safetyIntentEpoch:0,timedResume:null,resumeFailed:null,closed:false,quitting:false,lenderInit:null,pauseTimer:null,
    checkSignInBeforeClaim:async()=>{},
    clearTimeout:()=>{},lendingTarget:async()=>null,device:{listCircles:async()=>[{id:'legacy',origin:null}]},
    lender:{getState:()=>({current:null})},save:async()=>{},fail};
  c.stopIdleLender=async()=>{c.lender=null;c.safetyEpoch++;};
  c.lendingView=()=>({enabled:c.settings.enabled,intent:c.settings.intent,circle:c.settings.activeCircle});
  const start=runInNewContext(starts+'\nstartLending;',c);
  assert.deepEqual(await start(),{enabled:false,intent:'on',circle:null});
});

test('Off preserves a rule save already ahead of it in the production settings queue',async()=>{
  const entered=gate(),release=gate();let disk;
  const c={updateAdmissionHeld:()=>false,cancelResumes:()=>{},parts:['api','lending','off'],settings:{enabled:true,intent:'on',modes:{},standingRules:[]},policy:{enabled:true},
    safetyEpoch:0,safetyIntentEpoch:0,timedResume:null,closed:false,settingsFile:'synthetic-settings',atomic:async(_file,value)=>{disk=structuredClone(value);},
    approvals:new Map(),schedulePauseEnd:()=>{},now:()=>100,paceEventId:type=>type,
    lender:{pause:()=>{}},emit:()=>{},readinessChanged:()=>{},closeReadingSandboxes:async()=>{},fail};
  c.lendingView=()=>({enabled:c.settings.enabled,intent:c.settings.intent});
  const writes=slice('  let settingsWrites=Promise.resolve();','  const counterStore=createLenderCounterStorage');
  const queue=runInNewContext(writes+'\n({save,persistSettings});',c);c.save=queue.save;
  const saving=queue.persistSettings(async()=>{entered.resolve();await release.promise;
    Object.assign(c.settings,{modes:{circle:'auto'},standingRules:[{id:'rule'}]});await c.atomic(c.settingsFile,c.settings);});
  await entered.promise;
  const off=runInNewContext(`(async function(input){${pauseRoute}})`,c)({});
  release.resolve();await saving;await off;
  assert.equal(disk.enabled,false);
  assert.equal(disk.modes.circle,'auto');
  assert.deepEqual(disk.standingRules,[{id:'rule'}]);
});

// Quit stops the running job through the same Stop path. That Stop's completion must leave lending off: Quit is proving
// cessation, and a resumed pool could claim a new job while the app closes.
test('a Stop completion during an accepted Quit does not turn lending back on',async t=>{
  const f=await stopFixture(t);
  await f.stop({attemptId:'attempt-1',confirmed:true});
  f.c.quitting=true;
  await f.complete(1);
  assert.equal(f.c.settings.enabled,false);
  assert.equal(f.c.policy.enabled,false);
  assert.deepEqual(f.deliveries,[],'the durable candidate is not turned on');
});

// Stop recovery runs from the blocker timer as well as at startup. It must not start a recovery pool behind an accepted
// Quit, whether Quit was accepted before the check or while the saved counters were being read.
test('Stop recovery does not start a recovery pool during an accepted Quit',async()=>{
  for(const late of [false,true]) {
    const starts=[];let reads=0;
    const c={updateAdmissionHeld:()=>false,closed:false,quitting:!late,lender:null,recoveringLender:null,safetyEpoch:0,hasObservationJournal:()=>false,hasUnfinishedLending:v=>Boolean(v?.pending),
      counterStore:{get:async()=>{if(late&&!reads++)c.quitting=true;return {circle:'circle',pending:{attemptId:'attempt-1'}};}},
      startLendingAttempt:async(...args)=>{starts.push(args);}};
    const recover=runInNewContext('let recoveringLender=null;'+slice('    const recoverLender=','    for(const circle of await device.listCircles())')+'\nrecoverLender;',c);
    await recover();
    assert.deepEqual(starts,[],late?'Quit accepted while the counters were read':'Quit accepted before the check');
    c.quitting=false;await recover();
    assert.equal(starts.length,1,'outside Quit the same journal starts recovery');
  }
});

// After a restart the pool's loop restores a saved Stop hold only after it reads the counters. An automatic start
// that reaches the running pool first must leave the hold to Stop recovery; once recovery clears it, a start resumes.
for(const where of ['pending','declinePending'])test('an automatic start keeps a saved Stop hold ('+where+') until Stop recovery clears it',async()=>{
  let saved=where==='pending'?{pending:{attemptId:'attempt-1',stopReason:'stopped_by_lender'}}:
    {accounts:{'codex:0':{declinePending:{stoppedByLender:true}}}};
  let resumes=0;
  const c={updateAdmissionHeld:()=>false,settings:{enabled:false,intent:'on',activeCircle:'circle',paused:false,pause_until:null},policy:{enabled:false},
    safetyEpoch:0,safetyIntentEpoch:0,timedResume:null,closed:false,quitting:false,lenderInit:null,resumeFailed:null,pauseTimer:null,stopFlights:new Map(),stopReceipt:null,clearTimeout:()=>{},now:()=>100,
    checkSignInBeforeClaim:async()=>{},
    paceEventId:type=>type,emit:()=>{},save:async()=>{},lendingTarget:async()=>({id:'circle'}),fail,pendingAttempts,lendingRuntime:null,
    counterStore:{get:async()=>structuredClone(saved)},
    lender:{getState:()=>({current:null,counters:null}),resume:()=>{resumes++;}}};
  c.lendingView=()=>({enabled:c.settings.enabled,intent:c.settings.intent});
  const start=runInNewContext(starts+'\nstartLending;',c);
  await assert.rejects(start('circle',{auto:true,expectedEpoch:0}),{code:'lending_recovery_required'});
  assert.equal(resumes,0,'the automatic start does not resume the pool');
  assert.equal(c.settings.enabled,false);
  assert.equal(c.policy.enabled,false);
  saved={jobs:0,milliseconds:0}; // Stop recovery proved the stopped job ended and cleared its record
  await start('circle',{auto:true,expectedEpoch:c.safetyEpoch});
  assert.equal(resumes,1,'the automatic start resumes once the hold is cleared');
  assert.equal(c.settings.enabled,true);
});

// Adopting a newly joined circle starts lending outside the serialized lane, so the failed-resume retry must not
// start a second attempt meanwhile, and an adoption that lost a start race must not overwrite the winner's settings.
test('the failed-resume retry stands aside while a joined circle is adopted, and a lost adoption keeps the running lender',async()=>{
  const listed=gate();let resumes=0;
  const c={updateAdmissionHeld:()=>false,settings:{enabled:false,intent:'on',activeCircle:'old',paused:false,pause_until:null},closed:false,quitting:false,lenderInit:null,lender:null,
    backgroundCheck:null,stopFlights:new Map(),stopReceipt:null,safetyEpoch:0,safetyIntentEpoch:0,timedResume:null,resumeFailed:{code:'network_error'},options:{blockerRecheckMs:10},
    performance:{now:()=>1e9},machineHold:()=>null,autoResume:async()=>{resumes++;},now:()=>100,save:async()=>{},
    projectMembership:()=>({phase:'approved'}),applyJoinMode:async()=>{},device:{listCircles:()=>listed.promise},
    startLending:async()=>{c.lender={getState:()=>({current:null})};c.settings.enabled=true;fail('lending_busy',409);}};
  runInNewContext(slice('  const RETRYABLE_RESUME=','  function schedulePauseEnd() {'),c);
  const retry=runInNewContext('retryFailedResume',c),adopt=runInNewContext(slice('  async function adoptJoinedCircle(','  // The person whose job')+'\nadoptJoinedCircle;',c);
  const adopting=adopt({id:'joined',origin:'https://host',name:'Joined'});
  retry();
  assert.equal(resumes,0,'no retry while the adoption is in flight');
  listed.resolve([]);await adopting;
  assert.equal(c.settings.enabled,true,'the running lender keeps lending on');
  assert.deepEqual(c.resumeFailed,{code:'network_error'},'no lending_busy failure is recorded over it');
});

test('fresh automatic resume cannot start after Quit is accepted',async()=>{
  let starts=0;
  const c={closed:false,quitting:true,safetyEpoch:1,safetyIntentEpoch:0,timedResume:null,settings:{intent:'on',activeCircle:'circle',enabled:false,pause_until:null},
    stopReceipt:null,stopFlights:new Map(),backgroundCheck:null,serialize:fn=>fn(),agentCheckTimeoutMs:100,
    lenderEvidence:async()=>({due:false}),performance:{now:()=>0},startLending:async()=>{starts++;},resumeFailed:null,emit:()=>{}};
  const auto=runInNewContext(slice('  function autoResume(', '  // A computer often starts')+'\nautoResume;',c);
  await auto('circle');assert.equal(starts,0);
});

test('held heartbeat cannot start a pool after Quit',async()=>{
  const entered=gate(),release=gate();let starts=0;
  const pool={start:()=>{starts++;return Promise.resolve();}},controller=new AbortController();
  const c={lender:pool,controller,heartbeat:{beat:()=>{entered.resolve();return release.promise;}},quitting:false,lenderInit:null,
    safetyEpoch:1,epoch:1,closed:false,settings:{enabled:true},policy:{enabled:true},recoveringStop:true,recovery:false,fail};
  const heartbeat=source.indexOf('    await heartbeat.beat();',source.indexOf('  async function startLendingAttempt('));
  const capture=source.lastIndexOf('    const pool=lender,poolController=controller;',heartbeat);
  const before=capture>source.indexOf('  async function startLendingAttempt(')?capture:heartbeat;
  const end=source.indexOf('    loop=lender.start(controller.signal)',before);
  assert.ok(before>0&&end>before);
  const run=runInNewContext('(async()=>{'+source.slice(before,end)+'\nreturn lender.start(controller.signal);})',c);
  const starting=run();await entered.promise;c.quitting=true;c.safetyEpoch++;release.resolve();
  await assert.rejects(starting,{code:'lending_busy'});assert.equal(starts,0);
});

test('an automatic start rejected because Off came during it reports no failed resume',async()=>{
  const events=[];
  const c={closed:false,quitting:false,lenderInit:null,safetyEpoch:1,safetyIntentEpoch:0,settings:{intent:'on',activeCircle:'circle',enabled:false,pause_until:null},
    stopReceipt:null,stopFlights:new Map(),backgroundCheck:null,serialize:fn=>fn(),agentCheckTimeoutMs:100,
    lenderEvidence:async()=>({due:false}),performance:{now:()=>0},resumeFailed:null,emit:(type,value)=>events.push([type,value]),
    startLending:async()=>{c.settings.intent='off';c.safetyEpoch++;fail('lending_busy',409);}};
  const auto=runInNewContext(slice('  function autoResume(', '  // A computer often starts')+'\nautoResume;',c);
  await assert.rejects(auto('circle'),{code:'lending_busy'});await tick();
  assert.equal(c.resumeFailed,null,'no "turn lending on" card for lending the person just turned off');
  assert.deepEqual(events,[]);
});

test('the failed-resume retry does not run while Quit is in progress',()=>{
  let resumes=0;
  const c={closed:false,quitting:true,lender:null,backgroundCheck:null,stopFlights:new Map(),resumeFailed:{code:'network_error'},updateAdmissionHeld:()=>false,safetyEpoch:0,safetyIntentEpoch:0,stopReceipt:null,
    settings:{intent:'on',enabled:false,paused:false,pause_until:null,activeCircle:'circle'},machineHold:()=>null,options:{},
    performance:{now:()=>0},autoResume:async()=>{resumes++;}};
  const retry=runInNewContext(slice('  const RETRYABLE_RESUME=', '  function schedulePauseEnd(')+'\nretryFailedResume;',c);
  retry();assert.equal(resumes,0);
  c.quitting=false;retry();assert.equal(resumes,1,'the same state retries once Quit is over');
});

test('an automatic start that bumped the epoch itself and then failed on the host is still reported',async()=>{
  const c={closed:false,quitting:false,lenderInit:null,safetyEpoch:1,safetyIntentEpoch:0,settings:{intent:'on',activeCircle:'circle',enabled:false,pause_until:null},
    stopReceipt:null,stopFlights:new Map(),backgroundCheck:null,serialize:fn=>fn(),agentCheckTimeoutMs:100,
    lenderEvidence:async()=>({due:false}),performance:{now:()=>0},resumeFailed:null,emit:()=>{},
    startLending:async()=>{c.safetyEpoch++;fail('network_error',503);}};
  const auto=runInNewContext(slice('  function autoResume(', '  // A computer often starts')+'\nautoResume;',c);
  await assert.rejects(auto('circle'),{code:'network_error'});await tick();
  assert.equal(c.resumeFailed?.code,'network_error','the retry timer needs this to try again');
});
