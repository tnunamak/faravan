import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import * as launch from '../lib/v1/macos-launch.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(r=>setImmediate(r));
test('managed retries at 5s and 10s, records fixed code, clears on success',async()=>{
 const owner=deferred(),server=new EventEmitter(),waits=[],failures=[];let starts=0,released=0,cleared=0,closed=0;
 const run=launch.superviseMacLaunch({home:'/unused',managed:true,background:true,ownerGone:owner.promise,
 acquireLock:async()=>()=>released++,discover:async()=>null,
 startApp:async()=>{if(++starts<3)throw Object.assign(Error('private secret'),{code:'sandbox_start_failed'});return {server,close:async()=>closed++};},
 sleep:async ms=>{waits.push(ms);},onStartFailure:r=>failures.push(r),onStartReady:()=>cleared++});
 run.catch(()=>{});await tick();
 assert.equal(starts,3);assert.deepEqual(waits,[5000,10000]);assert.equal(failures.length,2);
 assert.equal(failures[0].code,'sandbox_start_failed');assert.ok(!JSON.stringify(failures).includes('secret'));
 assert.equal(cleared,1);owner.resolve('quit');assert.equal((await run).reason,'quit');assert.equal(closed,1);assert.equal(released,1);
});
test('quit during backoff aborts timer, no further start, reaches shutdown',async()=>{
 const owner=deferred();let sleeping=false,aborted=false,starts=0,finished=0,released=0;
 const run=launch.superviseMacLaunch({home:'/unused',managed:true,background:true,ownerGone:owner.promise,
 acquireLock:async()=>()=>released++,discover:async()=>null,startApp:async()=>{starts++;throw Object.assign(Error(),{code:'sandbox_start_failed'});},
 sleep:(ms,signal)=>new Promise(resolve=>{sleeping=true;signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true});}),
 finishShutdown:async()=>finished++});
 run.catch(()=>{});await tick();assert.equal(sleeping,true);owner.resolve('quit');
 assert.equal((await run).reason,'quit');assert.equal(aborted,true);assert.equal(starts,1);assert.equal(finished,1);assert.equal(released,1);
});
test('backoff caps at five minutes and quitting never launches again',async()=>{
 const owner=deferred(),waits=[];let starts=0;
 const run=launch.superviseMacLaunch({home:'/unused',managed:true,background:true,ownerGone:owner.promise,
 acquireLock:async()=>()=>{},discover:async()=>null,startApp:async()=>{starts++;throw Error('private');},
 sleep:async ms=>{waits.push(ms);if(waits.length===9)owner.resolve('quit');}});
 await run;assert.deepEqual(waits,[5000,10000,20000,40000,80000,160000,300000,300000,300000]);assert.equal(starts,9);
});
test('failure classifier is fixed and resists hostile error properties',()=>{
 assert.equal(launch.launchFailure({code:'sandbox_start_failed',message:'secret'}).code,'sandbox_start_failed');
 assert.deepEqual(launch.launchFailure({code:'secret',name:'secret'}),{code:'app_start_failed',kind:'Error'});
 assert.deepEqual(launch.launchFailure(new Proxy({}, {get(){throw Error('private');}})),{code:'app_start_failed',kind:'Error'});
});

import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
test('private fixed-code record reaches offline status, live app wins and success clears it',async t=>{
 const home=await mkdtemp(join(tmpdir(),'launcher-failure-'));t.after(()=>rm(home,{recursive:true,force:true}));
 launch.saveLaunchFailure(home,Object.assign(Error('token=secret'),{code:'sandbox_start_failed'}),{now:()=>123});
 const text=await readFile(join(home,'v1','start-failure.json'),'utf8');
 assert.ok(!text.includes('secret'));assert.equal((await stat(join(home,'v1','start-failure.json'))).mode&0o777,0o600);
 const status=await launch.offlineLaunchStatus(home,{discover:async()=>null});
 assert.equal(status.running,false);assert.equal(status.start_failure.code,'sandbox_start_failed');
 assert.equal(await launch.offlineLaunchStatus(home,{discover:async()=>({origin:'live'})}),null);
 launch.clearLaunchFailure(home);assert.equal(launch.readLaunchFailure(home),null);
});
test('readiness waits its injected 15s budget then exposes only saved code',async t=>{
 const home=await mkdtemp(join(tmpdir(),'launcher-readiness-'));t.after(()=>rm(home,{recursive:true,force:true}));
 launch.saveLaunchFailure(home,{code:'sandbox_start_failed'});
 let now=0,reads=0;
 await assert.rejects(launch.waitForLaunch(home,{now:()=>now,discover:async()=>{reads++;return null;},sleep:async ms=>{now+=ms;}}),
   error=>error.code==='sandbox_start_failed'&&!error.message.includes('secret'));
 assert.equal(now,15000);assert.equal(reads,151);
 const live={origin:'live'};
 assert.equal(await launch.waitForLaunch(home,{discover:async()=>live}),live);
});
test('untrusted or malformed persisted diagnostics cannot supply arbitrary codes',async t=>{
 const home=await mkdtemp(join(tmpdir(),'launcher-malformed-'));t.after(()=>rm(home,{recursive:true,force:true}));
 launch.saveLaunchFailure(home,{code:'sandbox_start_failed'});
 await writeFile(join(home,'v1','start-failure.json'),JSON.stringify({version:1,code:'secret',kind:'Error',at:1}));
 assert.equal(launch.readLaunchFailure(home),null);
});
test('a quit during a real backoff leaves no timer keeping the isolated Node process idle',{timeout:5000},async()=>{
 const module=new URL('../lib/v1/macos-launch.mjs',import.meta.url).href;
 const child=spawn(process.execPath,['--input-type=module','-e',`
   import {superviseMacLaunch} from ${JSON.stringify(module)};
   let quit;const ownerGone=new Promise(r=>quit=r);
   let calls=0;
   const result=await superviseMacLaunch({home:'/unused',managed:true,background:true,ownerGone,
     acquireLock:async()=>()=>{},discover:async()=>null,
     startApp:async()=>{calls++;setImmediate(()=>quit('quit'));throw Object.assign(Error(),{code:'sandbox_start_failed'});}});
   if(calls!==1||result.reason!=='quit')process.exitCode=3;
 `],{stdio:'ignore'});
 assert.deepEqual(await once(child,'exit'),[0,null]);
});
test('non-managed launch retains failure behavior and releases its lock',async()=>{
 let released=0;
 await assert.rejects(launch.superviseMacLaunch({home:'/unused',ownerGone:new Promise(()=>{}),
   acquireLock:async()=>()=>released++,discover:async()=>null,startApp:async()=>{throw Object.assign(Error(),{code:'sandbox_start_failed'});}}),
   error=>error.code==='sandbox_start_failed');
 assert.equal(released,1);
});
test('quit while startup resolves still closes the late app, without starting a tray',async()=>{
 const owner=deferred(),ready=deferred();let closed=0,trays=0;
 const run=launch.superviseMacLaunch({home:'/unused',managed:true,background:true,ownerGone:owner.promise,trayPath:'/fake',
 acquireLock:async()=>()=>{},discover:async()=>null,startApp:()=>ready.promise,spawnTray:()=>{trays++;}});
 await tick();owner.resolve('quit');await tick();ready.resolve({close:async()=>closed++});
 assert.equal((await run).reason,'quit');assert.equal(closed,1);assert.equal(trays,0);
});
test('tray exists while startup is retrying and its Quit aborts backoff',async()=>{
 const owner=deferred(),tray=new EventEmitter();tray.stdin={end(){}};let spawned=0,starts=0,aborted=false;
 const run=launch.superviseMacLaunch({home:'/unused',managed:true,background:true,ownerGone:owner.promise,trayPath:'/fake',
 acquireLock:async()=>()=>{},discover:async()=>null,startApp:async()=>{starts++;throw Error('private');},
 spawnTray:()=>{spawned++;return tray;},sleep:(_ms,signal)=>new Promise(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}))});
 await tick();const seen=spawned;tray.emit('exit',0);await tick();const quitWorked=aborted;
 owner.resolve('quit');const result=await run;
 assert.equal(seen,1);assert.equal(quitWorked,true);assert.equal(result.reason,'tray');assert.equal(starts,1);
});
test('durable CLI Quit stops a managed retry and clears its polling timer',async t=>{
 const home=await mkdtemp(join(tmpdir(),'launcher-quit-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const {setResidentQuit}=await import('../lib/v1/resident-intent.mjs');const owner=deferred();let starts=0,aborted=false;
 const run=launch.superviseMacLaunch({home,managed:true,background:true,ownerGone:owner.promise,quitPollMs:5,
 acquireLock:async()=>()=>{},discover:async()=>null,startApp:async()=>{starts++;throw Error();},
 sleep:(_ms,signal)=>new Promise(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}))});
 await tick();setResidentQuit(true,home);await new Promise(r=>setTimeout(r,40));const seen=aborted;
 owner.resolve('owner');const result=await run;assert.equal(seen,true);assert.equal(result.reason,'quit');assert.equal(starts,1);
});
test('a retry success reuses the tray already serving startup status',async()=>{
 const owner=deferred(),tray=new EventEmitter();tray.stdin={end(){}};let spawned=0,starts=0;
 const run=launch.superviseMacLaunch({home:'/unused',managed:true,background:true,ownerGone:owner.promise,trayPath:'/fake',
 acquireLock:async()=>()=>{},discover:async()=>null,startApp:async()=>{if(++starts===1)throw Error();return {server:new EventEmitter(),close:async()=>{}};},
 spawnTray:()=>{spawned++;return tray;},sleep:async()=>{assert.equal(spawned,1);}});
 run.catch(()=>{});await tick();owner.resolve('quit');await run;assert.equal(spawned,1);
});
