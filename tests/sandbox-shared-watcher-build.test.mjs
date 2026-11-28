import './helpers/no-browser.mjs';
// A watcher left running by an older Faravan build must not stay in charge of a sandbox home. It keeps its own sbx path and
// lock, so the new app saw it as healthy (same path) or timed out behind its lock (different path). The new app now
// recognises a watcher of another build by the build it publishes, retires it once its identity is proven, and starts its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {createSharedSandboxWatcher,sharedWatchServing,sharedWatchBound} from '../lib/v1/sandbox-shared-watcher.mjs';
import {createSandboxDeadlineManager,deadlineProcessStart,sandboxDeadlineClock} from '../lib/sandbox-deadline.mjs';
import {acquireProcessLock,acquireProcessLockSync,processLockOwners} from '../lib/v1/lock.mjs';
import {durableWrite} from '../lib/durable-write.mjs';

const enabled=process.platform==='linux';
const first='wf-0123456789abcdef',second='wf-fedcba9876543210';
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
async function until(check,message,{timeout=8000}={}) {
  const deadline=Date.now()+timeout;
  for(;;){const result=await check();if(result)return result;if(Date.now()>=deadline)assert.fail(message);await sleep(25);}
}
function fixture(t) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'watch-child-'));
  const present=path.join(home,'present'),directory=path.join(home,'records'),log=path.join(home,'commands.jsonl');
  fs.mkdirSync(present);fs.mkdirSync(directory);
  const binary=path.join(home,'fake-sandbox.mjs');
  fs.writeFileSync(binary,`#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';
const home=${JSON.stringify(home)},args=process.argv.slice(2),present=path.join(home,'present');
if(process.env.HOME!==home)throw Error('Fake CLI escaped temporary HOME');
fs.appendFileSync(path.join(home,'commands.jsonl'),JSON.stringify({pid:process.pid,parent:process.ppid,args,home:process.env.HOME})+'\\n');
if(args.length===2&&args[0]==='ls'&&args[1]==='--json')console.log(JSON.stringify(fs.readdirSync(present).map(name=>({name}))));
else if(args.length===3&&args[0]==='rm'&&args[1]==='--force'&&/^wf-[a-f0-9]{16}$/.test(args[2]))fs.rmSync(path.join(present,args[2]),{force:true});
else throw Error('Unexpected fake CLI command');\n`,{mode:0o700});
  const children=[];
  const launch=(command,args,options)=>{
    assert.equal(command,process.execPath);
    assert.deepEqual(options.env,{HOME:home});
    const child=spawn(command,args,{...options,stdio:options.stdio==='ignore'?['ignore','ignore','pipe']:['ignore','ignore','pipe','ipc']});
    const item={child,stderr:'',exited:false,exit:new Promise(resolve=>child.once('exit',(code,signal)=>{item.exited=true;item.code=code;item.signal=signal;resolve();}))};
    child.stderr.on('data',data=>item.stderr+=data);children.push(item);return child;
  };
  const watcher=(extra={})=>createSharedSandboxWatcher({home,owner:'lifecycle-owner',binary,spawnWatcher:launch,readyMs:8000,...extra});
  // Explicit non-Linux manager branch selects the detached guard without probing a service manager.
  const guard=(extra={})=>createSandboxDeadlineManager({binary,platform:'hermetic-guard',directory,spawnGuard:launch,readyTimeoutMs:2000,
    run:()=>{throw Error('Host service-manager command is forbidden');},...extra});
  const row=(name=first)=>{
    const clock=sandboxDeadlineClock();
    return {_cleanupId:randomUUID(),sandbox_id:name,sbx_home:home,owner_scope:'lifecycle-owner',create:'dispatched',compute_created:false,compute_stopped:false,
      deadline_at:clock.wall+60_000,deadline_clock:{version:1,boot_id:clock.boot_id,boot_at:clock.boot_ms+60_000}};
  };
  const adopted=source=>({...source,exec_fenced:true,watch_state:'watch_adopted',watch_generation:randomUUID(),watch_challenge:randomUUID(),watch_ack:null});
  const record=source=>path.join(directory,source._cleanupId+'.json');
  const persist=source=>durableWrite(record(source),JSON.stringify(source));
  const commands=()=>{try{return fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}catch{return [];}};
  const locations={manifest:path.join(home,'.faravan-shared-watch/names.json'),status:path.join(home,'.faravan-shared-watch/status.json'),lock:path.join(home,'.faravan-shared-watch/watcher.lock')};
  const liveChildren=()=>children.filter(item=>!item.exited);
  t.after(async()=>{
    for(const item of liveChildren())item.child.kill('SIGTERM');
    await until(()=>liveChildren().length===0,'Fixture children failed to terminate',{timeout:4000}).catch(async error=>{
      for(const item of liveChildren())item.child.kill('SIGKILL');await Promise.all(children.map(item=>item.exit));throw error;
    });
    fs.rmSync(home,{recursive:true,force:true});
  });
  return {home,present,directory,binary,children,watcher,guard,row,adopted,record,persist,commands,...locations,liveChildren};
}
function saveAck(f,row,ack) {
  row.watch_ack={challenge:ack.challenge,binary:ack.binary};f.persist(row);return row;
}


const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};

test('watcher lock observation rescans when a holder releases between listing and reading', async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'watch-lock-scan-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const lock=path.join(home,'watcher.lock'), owners=lock+'.owners-v1';
  const release=acquireProcessLockSync(lock,{durable:false});
  const readdir=fs.readdirSync;
  let scans=0;
  const mock=t.mock.method(fs,'readdirSync',(file,...args)=>{
    const entries=readdir(file,...args);
    if(file===owners&&++scans===1)release();
    return entries;
  });
  try {
    assert.deepEqual(processLockOwners(lock),[]);
    assert.equal(scans,2,'a fresh listing is needed to establish that no owner remains');
  } finally {mock.mock.restore();release();}
  const acquired=await acquireProcessLock(lock);
  try {assert.equal(processLockOwners(lock)[0].pid,process.pid);}
  finally {acquired();}
});

test('watcher lock observation refuses a malformed registration without retry or removal', t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'watch-lock-malformed-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const lock=path.join(home,'watcher.lock'), owners=lock+'.owners-v1';
  fs.mkdirSync(owners);
  const malformed=path.join(owners,randomUUID()+'.choosing');
  fs.writeFileSync(malformed,'not a registration',{mode:0o600});
  const readdir=fs.readdirSync;
  let scans=0;
  const mock=t.mock.method(fs,'readdirSync',(file,...args)=>{
    if(file===owners)scans++;
    return readdir(file,...args);
  });
  try {
    assert.throws(()=>processLockOwners(lock),error=>error.reason==='lock_stale'&&error.retryable!==true);
    assert.equal(scans,1);
    assert.equal(fs.readFileSync(malformed,'utf8'),'not a registration');
  } finally {mock.mock.restore();}
});

test('a watcher of another build is retired and replaced, and the names it held stay watched', {skip:!enabled,timeout:30000},async t=>{
  const f=fixture(t),old=f.watcher({build:'older-build'}),one=f.adopted(f.row());f.persist(one);
  saveAck(f,one,await old.acknowledge(one));
  const before=read(f.status);assert.equal(before.build,'older-build');
  const current=f.watcher(),two=f.adopted(f.row(second));f.persist(two);
  saveAck(f,two,await current.acknowledge(two));
  await until(()=>!alive(before.pid),'The older watcher was left running');
  const after=read(f.status);
  assert.notEqual(after.pid,before.pid);assert.notEqual(after.build,'older-build');
  assert.equal(processLockOwners(f.lock).length,1);assert.equal(processLockOwners(f.lock)[0].pid,after.pid);
  assert.deepEqual(read(f.manifest).names.map(item=>item.name).sort(),[first,second].sort(),'no name is dropped by the takeover');
  assert.equal(current.status().healthy,true);
});

test('a watcher that publishes no build (an older app) is treated as another build', {skip:!enabled,timeout:30000},async t=>{
  const f=fixture(t),old=f.watcher({build:'older-build'}),one=f.adopted(f.row());f.persist(one);
  saveAck(f,one,await old.acknowledge(one));
  const state=read(f.status),{build:_dropped,...legacy}=state;
  // An older app wrote its status without a build. Keep the same identity, so only the missing build tells them apart.
  durableWrite(f.status,JSON.stringify(legacy));
  const current=f.watcher();
  assert.equal(current.status().healthy,false,'a watcher with no build is not the current one');
  const replay={...one,watch_challenge:randomUUID(),watch_ack:null};f.persist(replay);
  saveAck(f,replay,await current.acknowledge(replay));
  await until(()=>!alive(state.pid),'The watcher without a build was left running');
  assert.equal(read(f.status).build!==undefined,true);
});

test('a name already handed to an older build is not served until the current build takes it', {skip:!enabled,timeout:30000},async t=>{
  const f=fixture(t),old=f.watcher({build:'older-build'}),one=f.adopted(f.row());f.persist(one);
  saveAck(f,one,await old.acknowledge(one));
  await until(()=>f.commands().some(command=>command.args[0]==='ls'),'The older watcher did not start');
  assert.equal(sharedWatchServing(one)!==null,false,'the fast path must not accept a watcher of another build');
  const current=f.watcher(),replay={...one,watch_challenge:randomUUID(),watch_ack:null};f.persist(replay);
  saveAck(f,replay,await current.acknowledge(replay));
  assert.notEqual(sharedWatchServing(replay),null);
});

test('a watcher of the same build is reused and never signalled', {skip:!enabled,timeout:30000},async t=>{
  const f=fixture(t),a=f.watcher(),one=f.adopted(f.row());f.persist(one);
  saveAck(f,one,await a.acknowledge(one));
  const before=read(f.status),b=f.watcher(),two=f.adopted(f.row(second));f.persist(two);
  saveAck(f,two,await b.acknowledge(two));
  assert.equal(read(f.status).pid,before.pid);assert.equal(alive(before.pid),true);
  await until(()=>f.liveChildren().length===1,'A second child stayed alive');
});

test('a lock holder whose identity does not match the published status is never signalled', {skip:!enabled,timeout:30000},async t=>{
  const f=fixture(t),old=f.watcher({build:'older-build'}),one=f.adopted(f.row());f.persist(one);
  saveAck(f,one,await old.acknowledge(one));
  const state=read(f.status);
  // Freeze the holder so it cannot republish its own status, then make the published start identity wrong: the pid may
  // belong to something else now.
  process.kill(state.pid,'SIGSTOP');
  try {
    durableWrite(f.status,JSON.stringify({...state,start:'another-process-start'}));
    const current=f.watcher({readyMs:1500}),two=f.adopted(f.row(second));f.persist(two);
    await assert.rejects(current.acknowledge(two),/unavailable/);
    assert.equal(alive(state.pid),true,'an unproven holder is never signalled');
    process.kill(state.pid,0);
    // A signal would stay pending on a stopped process, so check that none was sent: it must still be running when resumed.
  } finally { process.kill(state.pid,'SIGCONT'); }
  await sleep(300);
  assert.equal(alive(state.pid),true,'no signal was delivered to the unproven holder');
});

test('the takeover keeps working when the older watcher has already exited', {skip:!enabled,timeout:30000},async t=>{
  const f=fixture(t),old=f.watcher({build:'older-build'}),one=f.adopted(f.row());f.persist(one);
  saveAck(f,one,await old.acknowledge(one));
  const state=read(f.status),item=f.children.find(entry=>entry.child.pid===state.pid);
  item.child.kill('SIGKILL');await item.exit;
  const current=f.watcher(),replay={...one,watch_challenge:randomUUID(),watch_ack:null};f.persist(replay);
  saveAck(f,replay,await current.acknowledge(replay));
  assert.notEqual(read(f.status).pid,state.pid);assert.equal(current.status().healthy,true);
});
