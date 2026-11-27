import './helpers/no-browser.mjs';
// Quit while the app is still starting (lib/v1/macos-launch.mjs). Every boundary is injected; nothing runs a real app.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {superviseMacLaunch} from '../lib/v1/macos-launch.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const within=(promise,ms=2000)=>Promise.race([promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Quit waited for the app to finish starting')),ms).unref())]);
function fakeTray() {
  const child=new EventEmitter();
  child.stdin=new PassThrough();child.exitCode=null;child.signalCode=null;child.kill=()=>true;
  return child;
}
function fakeApp() {
  const app={server:new EventEmitter(),closed:0,handoffUrl:()=>'http://127.0.0.1:4100/',close:async()=>{app.closed++;}};
  return app;
}
function launch(overrides={}) {
  const owner=deferred(),calls={opened:[],trays:0,released:0,starts:0,finished:[],apps:[]};
  const options={home:'/home/someone/.faravan',trayPath:'/Apps/Faravan.app/Contents/MacOS/faravan-tray',background:false,
    ownerGone:owner.promise,acquireLock:async()=>()=>{calls.released++;},discover:async()=>null,
    requestHandoff:async()=>'http://127.0.0.1:4100/',openUrl:url=>calls.opened.push(url),
    spawnTray:()=>{calls.trays++;return fakeTray();},sleep:async()=>{},log:()=>{},waitMs:200,
    // The production boundary closes the app without waiting inside this call; the test keeps that shape.
    finishShutdown:({app,reason})=>{calls.finished.push({app,reason});app?.close();},
    ...overrides};
  return {owner,calls,options};
}

test('Quit finishes while the first start is still running, and the late app is closed',async()=>{
  const gate=deferred(),{owner,calls,options}=launch({startApp:()=>{calls.starts++;return gate.promise;}});
  const run=superviseMacLaunch(options);
  await tick();assert.equal(calls.starts,1,'the start is pending');
  owner.resolve('quit');
  const result=await within(run);
  assert.equal(result.reason,'quit');
  assert.equal(calls.trays,0);assert.deepEqual(calls.opened,[]);
  const late=fakeApp();gate.resolve(late);await tick();await tick();
  assert.equal(late.closed,1,'an app that finishes starting after Quit is closed');
});

test('Quit finishes while a retried start is still running',async()=>{
  const gate=deferred();let starts=0;
  const {owner,calls,options}=launch({managed:true,shouldQuit:()=>false,quitPollMs:60_000,
    onStartFailure:()=>{},startApp:()=>{starts++;if(starts===1)return Promise.reject(Object.assign(new Error('could not start'),{code:'app_start_failed'}));return gate.promise;}});
  const run=superviseMacLaunch(options);
  for(let i=0;i<50&&starts<2;i++)await tick();
  assert.equal(starts,2,'the retry is pending');
  owner.resolve('quit');
  const result=await within(run);
  assert.equal(result.reason,'quit');assert.deepEqual(calls.opened,[]);
  const late=fakeApp();gate.resolve(late);await tick();await tick();
  assert.equal(late.closed,1);
});

test('a start that fails after Quit is not an unhandled rejection',async()=>{
  const gate=deferred(),{owner,options}=launch({startApp:()=>gate.promise});
  const unhandled=[];const seen=error=>unhandled.push(error);process.on('unhandledRejection',seen);
  try {
    const run=superviseMacLaunch(options);
    await tick();owner.resolve('quit');
    await within(run);
    gate.reject(new Error('start failed after Quit'));
    await tick();await tick();await new Promise(resolve=>setTimeout(resolve,20));
    assert.deepEqual(unhandled,[]);
  } finally {process.off('unhandledRejection',seen);}
});
