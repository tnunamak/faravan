import './helpers/no-browser.mjs';
import test from 'node:test';
import {AppLifetime} from '../lib/v1/app-lifetime.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {scheduleUpdates} from '../lib/v1/self-update.mjs';
import {createUpdateService} from '../lib/v1/update-service.mjs';

const source=await readFile(new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
const scheduleBegin=source.indexOf('    // Update lifetime admission');
const scheduleEnd=source.indexOf('    schedulePauseEnd();',scheduleBegin);
const closeBegin=source.indexOf('    // Application lifetime shutdown',scheduleEnd);
const closeEnd=source.indexOf('    // Only the native managed supervisor',closeBegin);
assert.ok(scheduleBegin>=0&&scheduleEnd>scheduleBegin&&closeBegin>scheduleEnd&&closeEnd>closeBegin,
  'production update wiring and close extraction markers');
const terminalBegin=source.indexOf("  lifetime.register('update relaunch'");
const terminalSource=source.slice(terminalBegin,source.indexOf('\n',terminalBegin));
const scheduleSource=source.slice(scheduleBegin,scheduleEnd);
const closeSource=source.slice(closeBegin,closeEnd);
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const flush=async()=>{for(let i=0;i<32;i++)await Promise.resolve();};

function fixture() {
  const entered=gate(),release=gate(),handles=new Set();
  const log={applied:0,relaunch:0,listenerCloses:0,changes:[],events:[]};
  const done=Promise.resolve(),noop=()=>{},ok=async()=>{};
  const setTimer=()=>{const handle={unref(){return this;}};handles.add(handle);return handle;};
  const clearTimer=handle=>handles.delete(handle);
  const updater={startDelayMs:100,intervalMs:1000,installDir:'/synthetic/install',
    tick:async()=>{entered.resolve();return release.promise;},
    status:async()=>({candidate:'99.0.0'})};
  // These collaborators are inert. The close function and onApplied wiring below
  // are the production code, not a replacement close implementation.
  const c={
    lifetimeNow:Date.now,shutdownStartedAt:undefined,quitting:false,quitDeadline:null,updater,updateSchedule:null,updateService:null,options:{relaunch:()=>{log.relaunch++;}},
    updateIdle:async()=>true,updateExclusive:async()=>()=>{},managedUpdateContext:null,
    relaunchApp:()=>{throw Error('real process relaunch is forbidden in this test');},
    emit:(name,value)=>log.events.push({name,value,afterClose:c.closed}),
    scheduleUpdates:options=>scheduleUpdates({...options,setTimer,clearTimer,
      onApplied:async()=>{log.applied++;await options.onApplied();}}),
    closed:false,historyLearningGeneration:0,telemetryFactsTimer:null,
    telemetryFacts:{close:noop},refreshAbort:new AbortController(),DOMException,
    heartbeat:{stop:noop},nudgeTimer:null,heartbeatController:new AbortController(),
    inFlight:null,controller:new AbortController(),approvals:new Map(),
    updateBootTimer:null,pauseTimer:null,blockerTimer:null,handoff:{clear:noop},
    pollTimer:null,approvalTimer:null,shutdownBoundMs:()=>100,
    loop:done,settleWithin:async promise=>{await promise;return true;},
    lendingLiveAttempts:[],
    lendingRuntime:{pace50:{recover:ok},close:async()=>({live_attempts:[]}),cancelObservations:ok},
    lendingProbe:{close:ok},memberRefreshes:new Map(),identityProbes:new Map(),
    lendingIdentityControllers:new Map(),lendingIdentityChecks:new Map(),
    chatgptStarting:null,stopChatgpt:ok,signin:{close:ok},priceRefresh:{close:noop},
    dataCleanupController:new AbortController(),dataCleanupTimer:null,dataCleanupWork:done,diskScheduler:null,
    checkSandboxes:{close:ok},replaying:done,mutation:done,agentChoices:done,sweeping:done,
    historyLearningLane:done,telemetry:{close:ok},contributions:{snapshot:ok},history:{flush:ok},
    startupRecovery:done,probeReceipts:{flush:ok},
    recordDiagnostic:{flush:ok},streams:new Map(),phoneAccess:{close:ok},
    server:{close(callback){log.listenerCloses++;queueMicrotask(callback);},closeAllConnections:noop},
    circleTransport:{close:noop},sessions:{close:ok},refreshRun:null,jobWatchers:new Map(),
    notificationFeed:{settled:()=>done},jobMeta:{settled:()=>done},
    supportReadinessCache:{flush:ok},removeDiscovery:ok,releaseAppLock:ok,
    clearInterval:noop,clearTimeout:clearTimer,setTimeout:setTimer,
    console:{warn:noop},AbortController,queueMicrotask,
  };
  c.lifetime=new AppLifetime({now:Date.now,budgetMs:100});
  c.closePromise=undefined;c.stopPromise=undefined;c.cleanupApp=undefined;
  c.updaterHandle=c.lifetime.register('updater','producer',{blockedByHold:true,seal:()=>{c.updateSchedule?.stop();c.updateService?.close();},drain:()=>c.updateSchedule?.settled()});
  c.lifetime.register('app work','consumer',{seal:()=>{c.closed=true;c.updateSchedule?.stop();},drain:()=>c.closePromise??=c.cleanupApp()});
  c.updaterForRelaunch=updater;
  runInNewContext(terminalSource,c);
  let quitting=false,hold;
  Object.defineProperty(c,'quitting',{get:()=>quitting,set:value=>{quitting=value;if(value)hold=c.lifetime.register('Quit attempt','producer',{provisional:true});else hold?.cancel();}});
  c.updateService=createUpdateService({updater,currentVersion:'1.0.0',now:()=>1000,
    onChange:view=>log.changes.push({view,afterClose:c.closed})});
  const app=runInNewContext(closeSource+'\n'+scheduleSource+'\n({close,schedule:updateSchedule});',c);
  return {c,app,log,entered,release,handles};
}

test('an applied update completing after scheduler stop and app close cannot publish or relaunch',async()=>{
  const f=fixture();
  const step=f.app.schedule.step();
  await f.entered.promise;
  f.app.schedule.stop();
  const closing=f.app.close(); // Actual production closeApp, with inert collaborators.
  await flush();
  assert.equal(f.c.closed,true);
  // A fixed close may drain the outstanding tick. Do not deadlock that valid design.
  const changesBefore=f.log.changes.length,eventsBefore=f.log.events.length;
  f.release.resolve('applied');
  await Promise.all([step,closing]);await flush();
  assert.deepEqual({
    onApplied:f.log.applied,relaunch:f.log.relaunch,
    onChange:f.log.changes.length-changesBefore,
    lateEvents:f.log.events.length-eventsBefore,
    listenerCloses:f.log.listenerCloses,
  },{onApplied:0,relaunch:0,onChange:0,lateEvents:0,listenerCloses:1},
  'closing revokes pending update callbacks as well as scheduled future ticks');
  f.handles.clear();
});

test('an applied update finishing while a pending Quit is still proving does not relaunch the app',async()=>{
  const f=fixture();
  const step=f.app.schedule.step();
  await f.entered.promise;
  f.c.quitting=true; // The update was already pending when Quit proof began.
  f.release.resolve('applied');
  await step;await flush();
  assert.deepEqual({relaunch:f.log.relaunch,closed:f.c.closed,listenerCloses:f.log.listenerCloses},
    {relaunch:0,closed:false,listenerCloses:0});
  f.handles.clear();
});

test('a tick whose idle check was parked across stop never starts the updater',async()=>{
  const idle=gate();let ticks=0;
  const schedule=scheduleUpdates({updater:{tick:async()=>{ticks++;return 'current';}},isIdle:()=>idle.promise,
    exclusive:async()=>()=>{},onApplied:async()=>{},setTimer:()=>({unref(){}}),clearTimer(){}});
  const step=schedule.step();
  await flush();
  schedule.stop();
  idle.resolve(true);
  await step;await flush();
  assert.equal(ticks,0);
});

test('close drains use the time left of a Quit attempt, not a fresh allowance',async()=>{
  const f=fixture(),waits=[];
  f.c.settleWithin=async(promise,ms)=>{waits.push(ms);return true;};
  f.c.lendingRuntime.close=async({drainMs})=>{waits.push(drainMs);return {live_attempts:[]};};
  f.c.quitDeadline=Date.now()+30; // far less than the 100 ms ordinary allowance of this fixture
  await f.app.close();
  assert.ok(waits.length>=2,'the bounded drains ran');
  assert.ok(waits.every(ms=>ms<=30),'every bounded drain got at most the time left: '+waits);
  f.handles.clear();
});


test('a ready packaged helper arriving during Quit proof is cancelled',async()=>{
  const f=fixture(),prepared=gate(),ready=gate();let cancelled=0,handoffs=0;
  f.c.updater.kind='packaged-mac';f.c.updater.tick=async()=> 'handoff';
  f.c.updater.prepareHandoff=async()=>{prepared.resolve();await ready.promise;return {ready:true,cancel:async()=>{cancelled++;}};};
  f.c.managedUpdateContext={markHandoff:()=>{handoffs++;return true;}};
  const step=f.app.schedule.step();await prepared.promise;
  f.c.quitting=true;ready.resolve();await step;
  assert.deepEqual({cancelled,handoffs,closed:f.c.closed},{cancelled:1,handoffs:0,closed:false});
  f.app.schedule.stop();f.handles.clear();
});

test('a Quit body finishing after update close begins is refused before acceptance',async()=>{
  const begin=source.indexOf('        let input=await body(req);');
  const end=source.indexOf("        // Telemetry consent:",begin);
  const input=gate();let accepted=false;
  const c={closed:false,quitting:false,req:{},parts:['api','shutdown'],body:()=>input.promise,
    fail:(code,status)=>{throw Object.assign(new Error(code),{code,status});},accept:()=>{accepted=true;}};
  const route=runInNewContext('(async()=>{'+source.slice(begin,end)+';accept();})',c);
  const owner=new AppLifetime();c.requestHandle=owner.register('HTTP admission','producer');
  const request=route();c.closed=true;owner.stop('update');input.resolve({});
  await assert.rejects(request,{code:'app_closing'});assert.equal(accepted,false);
});

test('a refused provisional Quit unblocks future update checks',async()=>{
  const f=fixture();let ticks=0;
  f.c.updater.tick=async()=>{ticks++;return 'current';};
  f.c.quitting=true;await f.app.schedule.step();assert.equal(ticks,0);
  f.c.quitting=false;await f.app.schedule.step();assert.equal(ticks,1);
  f.app.schedule.stop();f.handles.clear();
});

test('an already applied update waits for refused Quit proof before publishing a relaunch',async()=>{
  const f=fixture(),step=f.app.schedule.step();await f.entered.promise;
  f.c.quitting=true;f.release.resolve('applied');await step;
  assert.equal(f.log.relaunch,0);assert.equal(f.c.closed,false);
  f.c.quitting=false;await f.app.schedule.step();
  assert.equal(f.log.relaunch,1);assert.equal(f.c.closed,true);assert.equal(f.log.listenerCloses,1);
  f.handles.clear();
});

test('a cancelled helper ticket does not prevent a fresh handoff after refusal',async()=>{
  const f=fixture(),prepared=gate(),ready=gate();let cancelled=0,handoffs=0,preparations=0;
  f.c.updater.kind='packaged-mac';f.c.updater.tick=async()=> 'handoff';
  f.c.updater.prepareHandoff=async()=>{if(++preparations===1){prepared.resolve();await ready.promise;}return {ready:true,cancel:async()=>{cancelled++;}};};
  f.c.managedUpdateContext={markHandoff:()=>{handoffs++;return true;}};
  const step=f.app.schedule.step();await prepared.promise;f.c.quitting=true;ready.resolve();await step;
  assert.equal(cancelled,1);assert.equal(handoffs,0);
  f.c.quitting=false;await f.app.schedule.step();
  assert.equal(handoffs,1);assert.equal(f.c.closed,true);assert.equal(f.log.relaunch,0);
  f.handles.clear();
});

test('stop retains ownership while a refused helper ticket is still cancelling',async()=>{
  const f=fixture(),prepared=gate(),ready=gate(),cancelling=gate(),cancelled=gate();
  f.c.updater.tick=async()=> 'handoff';
  f.c.updater.prepareHandoff=async()=>{prepared.resolve();await ready.promise;return {ready:true,cancel:async()=>{cancelling.resolve();await cancelled.promise;}};};
  const step=f.app.schedule.step();await prepared.promise;f.c.quitting=true;ready.resolve();await cancelling.promise;
  f.c.quitting=false;let finished=false;
  const closing=f.app.close().then(()=>{finished=true;});
  for(let turn=0;turn<1000;turn++)await Promise.resolve();
  try{assert.equal(finished,false,'ticket cancellation is part of updater drain');}
  finally{cancelled.resolve();await Promise.all([step,closing]);f.handles.clear();}
});

test('an applied update rechecks idleness after a refused Quit before relaunch',async()=>{
  const owner=new AppLifetime(),handle=owner.register('updater','producer',{blockedByHold:true});
  let idle=true,applied=0,ticks=0,attempt;
  const schedule=scheduleUpdates({updater:{tick:async()=>{ticks++;attempt=owner.register('Quit attempt','producer',{provisional:true});return 'applied';}},
    isIdle:async()=>idle,admit:()=>handle.commit(()=>{}),onApplied:async()=>{handle.commit(()=>{applied++;});},setTimer:()=>({unref(){}}),clearTimer:()=>{}});
  await schedule.step();attempt.cancel();idle=false;await schedule.step();assert.equal(applied,0);
  idle=true;await schedule.step();assert.equal(applied,1);assert.equal(ticks,1);schedule.stop();
});

test('unproven helper cancellation makes stop interrupted and cessation unknown',async()=>{
  const f=fixture(),prepared=gate(),ready=gate();
  f.c.updater.tick=async()=> 'handoff';
  f.c.updater.prepareHandoff=async()=>{prepared.resolve();await ready.promise;return {ready:true,cancel:async()=>{throw new Error('helper cessation unverified');}};};
  const step=f.app.schedule.step();await prepared.promise;f.c.quitting=true;ready.resolve();await step;
  f.c.quitting=false;const result=await f.app.close();
  assert.equal(result.state,'interrupted');assert.equal(result.cessation,'unknown');assert.ok(result.unfinished.includes('updater'));
  f.handles.clear();
});

test('scheduler drain accepts synchronous injected collaborators',async()=>{
  const schedule=scheduleUpdates({updater:{tick:()=> 'current'},isIdle:()=>true,
    setTimer:()=>({unref(){}}),clearTimer:()=>{}});
  await schedule.step();await schedule.settled();schedule.stop();
});
