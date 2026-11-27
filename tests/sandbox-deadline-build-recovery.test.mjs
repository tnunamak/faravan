import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import childProcess,{spawn} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {once} from 'node:events';
import {SANDBOX_GUARD_BUILD_ID,deadlineProcessStart,listDeadlineGuardProcesses} from '../lib/sandbox-deadline.mjs';
import {EventEmitter} from 'node:events';
import {superviseSandboxDeadline} from '../lib/sandbox-deadline-supervisor.mjs';
import {createSandboxDeadlineManager,deadlineSupervisorPayload,deadlineBinding,sandboxDeadlineUnit} from '../lib/sandbox-deadline.mjs';
import {createSandboxCleanupJournal} from '../lib/sandbox-cleanup-journal.mjs';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import {acquireProcessLockSync} from '../lib/v1/lock.mjs';

function fixture(t){
  const realKill=process.kill.bind(process);
  t.mock.method(process,'kill',(pid,signal)=>{if(signal===0)return realKill(pid,signal);throw Error('Real process signaling is forbidden in this fixture');});
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'guard-build-')),directory=path.join(root,'journal'),scratch=path.join(root,'scratch');
  fs.mkdirSync(directory);fs.mkdirSync(scratch);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const id=randomUUID(),name='wf-0123456789abcdef',row={version:2,_cleanupId:id,sandbox_id:name,sbx_home:root,owner_scope:sandboxOwnerScope(),job_id:'guard-build',
    scratch_dir:path.join(scratch,'wf-job-'+name+'-fixture'),create:'dispatched',compute_created:false,create_settled:false,compute_stopped:false,
    data_cleanup:'pending',policy_cleanup:'pending',deadline_at:20000,deadline_clock:{version:1,boot_id:'fixture',boot_at:20000}};
  row.deadline_enforcer={kind:'systemd',unit:sandboxDeadlineUnit(row),binary:'/fake/sbx'};
  const file=path.join(directory,id+'.json');fs.writeFileSync(file,JSON.stringify(row));
  return {root,directory,scratch,row,file,payload:deadlineSupervisorPayload(row,'/fake/sbx',directory)};
}

test('an expired never-created guard settles behind a durable name fence and exits within two attempts',async t=>{
  const f=fixture(t),states=[];let calls=0,waits=0;
  // Capture the actual fixture record before the supervisor durably fences it.
  const originalRecord=structuredClone(f.row);
  await superviseSandboxDeadline(f.payload,{originalRecord,clock:()=>({wall:30000,boot_id:'fixture',boot_ms:30000}),publish:s=>states.push(s),
    run:async args=>{assert.equal(args[0],'ls');calls++;return {code:0,stdout:'[]',stderr:''};},
    pause:async()=>{if(++waits===2)throw Error('never-created guard did not exit');}});
  assert.ok(calls<=2);assert.equal(states.at(-1).state,'removed');
  const row=JSON.parse(fs.readFileSync(f.file));
  assert.equal(row.create_abandoned,true);assert.equal(row.compute_created,false);assert.equal(row.create_settled,false);
  assert.equal(row.data_cleanup,'pending');assert.equal(row.policy_cleanup,'pending');
  const fence=JSON.parse(fs.readFileSync(path.join(f.directory,f.row.sandbox_id+'.scope.reserved')));
  assert.equal(fence.abandoned_create,true);assert.equal(fence.id,f.row._cleanupId);
});

for(const platform of ['linux','darwin'])for(const [same,cut] of [[false,false],[true,false],[false,true]])test(platform+' startup '+(cut?'survives a crash cut before retirement':same?'keeps the same guard build':'replaces a different guard build')+' without changing its deadline',async t=>{
  const f=fixture(t),build='current-build',payload={...f.payload,launchMode:platform==='linux'?'systemd':'guard'};let stops=0,launches=0,live=true,successorLive=false,waiting,crash=cut;
  // P1 replacement rule: ready standby overlaps the predecessor; its active
  // publication appears only after the predecessor releases the status lock.
  Object.assign(f.row,{compute_created:true,create_settled:true});
  if(platform==='darwin')f.row.deadline_enforcer={kind:'guard',pid:process.pid,start:'old-start',binary:'/fake/sbx'};
  fs.writeFileSync(f.file,JSON.stringify(f.row));
  const releaseStatus=acquireProcessLockSync(f.file+'.deadline.lock');
  let state={binding:deadlineBinding(payload),pid:process.pid,start:'old-start',state:'armed',build_id:same?build:'older-build'};
  const launch=()=>{launches++;assert.equal(live,true,'standby launches while predecessor still runs');successorLive=true;waiting={...state,pid:202021,start:'new-start',build_id:build,state:'waiting'};};
  const retire=()=>{assert.ok(waiting&&successorLive,'ready successor exists before retirement');if(crash)throw Error('simulated app crash before retirement');stops++;live=false;releaseStatus();state={...waiting,state:'armed'};};
  const run=async(binary,args)=>{
    if(binary==='systemctl'&&args.includes('stop')){retire();return {code:0,stdout:'',stderr:''};}
    if(binary==='systemd-run'){assert.equal(args.at(-1),'--standby');assert.notEqual(args.find(arg=>arg.startsWith('--unit=')), '--unit='+sandboxDeadlineUnit(f.row),'successor uses a separate unit');launch();return {code:0,stdout:'',stderr:''};}
    if(binary==='busctl'){
      const object='/org/freedesktop/systemd1/unit/'+(args.includes('GetUnit')?args.at(-1):args.find(arg=>arg.startsWith('/org/freedesktop/systemd1/unit/')).split('/').at(-1));
      const argv=['/usr/bin/env','-i','HOME='+f.root,process.execPath,new URL('../lib/sandbox-deadline-supervisor.mjs',import.meta.url).pathname,JSON.stringify(payload),...(/_b[a-f0-9]{12}/.test(object)?['--standby']:[])];
      return {code:0,stdout:JSON.stringify({data:args.includes('GetUnit')?[object.replaceAll('-','_').replaceAll('.','_')]:[[argv[0],argv,false,0,0,0,0,0,0,0]]}),stderr:''};
    }
    const next=args.some(arg=>/-b[a-f0-9]{12}[.]service$/.test(arg));
    return {code:!args.includes('is-active')||(next?successorLive:live)?0:1,stdout:'',stderr:''};
  };
  const clock=()=>({wall:10000,boot_id:'fixture',boot_ms:10000});
  const identity=pid=>pid===process.pid&&live?'old-start':pid===202021&&successorLive?'new-start':null;
  const manager=createSandboxDeadlineManager({directory:f.directory,binary:'/fake/sbx',platform,buildId:build,clock,run,
    stateReader:file=>file===payload.statusPath?state:waiting,processStart:async pid=>identity(pid),
    listProcesses:async()=>live?[{pid:process.pid,payload}]:[],processStartSync:identity,
    signalGuard:retire,spawnGuard:(_binary,args)=>{
      assert.equal(args.at(-1),'--standby');launch();const child=new EventEmitter();child.connected=true;child.disconnect=()=>{child.connected=false;};child.unref=()=>{};child.kill=()=>{};return child;
    },readyTimeoutMs:100});
  const journal=createSandboxCleanupJournal({directory:f.directory,scratchRoot:()=>f.scratch,home:()=>f.root,destroy:()=>assert.fail('future compute is not destroyed')});
  try {let report=await journal.recoverDeadlines(manager,{clock});
    if(cut){
      assert.equal(report.complete,false);assert.equal(live,true);assert.equal(successorLive,true);assert.equal(stops,0);
      crash=false;report=await journal.recoverDeadlines(manager,{clock});
      assert.equal(launches,1,'restart reuses the independently ready successor');
    }
    assert.equal(report.complete,true,JSON.stringify(report));assert.equal(stops,same?0:1);assert.equal(launches,same?0:1);
    const saved=JSON.parse(fs.readFileSync(f.file));assert.equal(saved.deadline_at,20000);
    assert.equal(await manager.active(saved,{recovery:true}),true);
    if(platform==='linux'&&!same)assert.equal((await manager.register(f.row,{recovery:true})).unit,saved.deadline_enforcer.unit,'a crash before saving the new unit cannot lose its successor');
  }finally{releaseStatus();}
});

for(const flaw of ['not listed','changed identity'])test('an old guard with '+flaw+' is not signaled or replaced',async t=>{
  const f=fixture(t),payload={...f.payload,launchMode:'guard'};let signals=0;
  f.row.deadline_enforcer={kind:'guard',pid:202020,start:'old-start',binary:'/fake/sbx'};
  const state={binding:deadlineBinding(payload),pid:202020,start:'old-start',state:'armed',build_id:'older-build'};
  const manager=createSandboxDeadlineManager({directory:f.directory,binary:'/fake/sbx',platform:'darwin',buildId:'current-build',stateReader:()=>state,
    processStart:async()=>state.start,processStartSync:()=>flaw==='changed identity'?'another-process':state.start,
    listProcesses:async()=>flaw==='not listed'?[]:[{pid:state.pid,payload}],run:async()=>({code:1,stdout:'',stderr:''}),
    signalGuard:()=>{signals++;},spawnGuard:()=>assert.fail('unknown old owner cannot be replaced')});
  await assert.rejects(manager.register(f.row,{recovery:true}));assert.equal(signals,0);
});

// Review P1: establish an independently ready successor before relinquishing
// the only remover. These cuts use injected controls, never host units/signals.
for(const platform of ['darwin','linux'])for(const cut of ['launch throws','not ready','crash after launch'])
test(platform+' upgrade preserves protection when '+cut,async t=>{
  const f=fixture(t),payload={...f.payload,launchMode:platform==='linux'?'systemd':'guard'};
  const build='current-build',old={binding:deadlineBinding(payload),pid:202020,start:'old-start',state:'armed',build_id:'old-build'};
  let oldLive=true,successorLive=false,stops=0,attempts=0;
  const run=async(binary,args)=>{
    if(binary==='systemd-run'){
      attempts++;
      if(cut==='launch throws')throw Error('launch failed');
      successorLive=true;
      assert.equal(oldLive,true,'the predecessor still protects the launch crash cut');
      if(cut==='crash after launch')throw Error('simulated app crash');
      return {code:0,stdout:'',stderr:''};
    }
    if(binary==='systemctl'&&args.includes('stop')){oldLive=false;stops++;return {code:0,stdout:'',stderr:''};}
    if(binary==='busctl'){
      const argv=['/usr/bin/env','-i','HOME='+f.root,process.execPath,new URL('../lib/sandbox-deadline-supervisor.mjs',import.meta.url).pathname,JSON.stringify(payload)];
      return {code:0,stdout:JSON.stringify({data:args.includes('GetUnit')?['/org/freedesktop/systemd1/unit/fixture']:[[argv[0],argv,false,0,0,0,0,0,0,0]]}),stderr:''};
    }
    return {code:oldLive||!args.includes('is-active')?0:1,stdout:'',stderr:''};
  };
  const manager=createSandboxDeadlineManager({directory:f.directory,binary:'/fake/sbx',platform,buildId:build,clock:()=>({wall:10000,boot_id:'fixture',boot_ms:10000}),run,
    stateReader:file=>file===payload.statusPath?old:null,processStart:async pid=>pid===old.pid&&oldLive?old.start:null,
    processStartSync:pid=>pid===old.pid&&oldLive?old.start:null,listProcesses:async()=>oldLive?[{pid:old.pid,payload}]:[],
    signalGuard:()=>{oldLive=false;stops++;},readyTimeoutMs:20,spawnGuard:()=>{
      attempts++;
      if(cut==='launch throws')throw Error('launch failed');
      successorLive=true;assert.equal(oldLive,true,'the predecessor still protects the launch crash cut');
      if(cut==='crash after launch')throw Error('simulated app crash');
      const child=new EventEmitter();Object.assign(child,{connected:true,kill(){successorLive=false;},disconnect(){this.connected=false;},unref(){}});return child;
    }});
  if(platform==='darwin')f.row.deadline_enforcer={kind:'guard',pid:old.pid,start:old.start,binary:'/fake/sbx'};
  await assert.rejects(manager.register(f.row,{recovery:true}));
  assert.equal(attempts,1);assert.equal(stops,0,'a successor that is not ready cannot authorize retirement');
  assert.equal(oldLive,true,'failed upgrade keeps the original independent remover');
  if(cut==='crash after launch')assert.ok(oldLive||successorLive);
});

test('a detached successor acknowledges standby and takes the status lock after parent disconnect',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'guard-standby-')),id=randomUUID(),recordPath=path.join(root,id+'.json');
  const payload={sandbox_id:'dl-0123456789abcdef',sbx_home:root,binary:'/not-executed/sbx',launchMode:'guard',deadline_at:Date.now()+60000,recordPath,statusPath:recordPath+'.deadline'};
  fs.writeFileSync(recordPath,JSON.stringify({...payload,compute_created:true,create_settled:true}));
  const release=acquireProcessLockSync(payload.statusPath+'.lock');
  fs.writeFileSync(payload.statusPath,JSON.stringify({old:true,binding:deadlineBinding(payload),pid:process.pid,start:await deadlineProcessStart(process.pid),observed:true,state:'armed'}));
  const child=spawn(process.execPath,[new URL('../lib/sandbox-deadline-supervisor.mjs',import.meta.url).pathname,JSON.stringify(payload),'--standby'],{detached:true,stdio:['ignore','ignore','ignore','ipc'],env:{HOME:root}});
  const exited=once(child,'exit');let timer;
  t.after(async()=>{clearTimeout(timer);release();if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await exited;fs.rmSync(root,{recursive:true,force:true});});
  const message=await Promise.race([once(child,'message').then(([m])=>m),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('standby readiness timed out')),5000);})]);clearTimeout(timer);
  assert.equal(message.waiting,true,'standby readiness precedes taking the occupied status lock');
  assert.equal(JSON.parse(fs.readFileSync(payload.statusPath)).old,true);
  await new Promise(resolve=>setTimeout(resolve,300));assert.ok(await deadlineProcessStart(child.pid),'standby survives IPC disconnection');
  release();
  const until=Date.now()+5000;let state;
  do{state=JSON.parse(fs.readFileSync(payload.statusPath));if(state.pid===child.pid)break;await new Promise(resolve=>setTimeout(resolve,20));}while(Date.now()<until);
  assert.equal(state.pid,child.pid);assert.equal(state.build_id,SANDBOX_GUARD_BUILD_ID);assert.equal(state.state,'armed');assert.equal(state.observed,true,'the successor retains materialization evidence');
});

test('macOS process discovery retains a successor launched with the standby flag',async t=>{
  const payload={sandbox_id:'wf-0123456789abcdef',sbx_home:'/synthetic/home',recordPath:'/synthetic/row.json',statusPath:'/synthetic/row.json.deadline'};
  const original=childProcess.execFile;
  childProcess.execFile=(binary,args,options,callback)=>{
    assert.equal(binary,'/bin/ps');
    callback(null,'202021 /synthetic/node /synthetic/sandbox-deadline-supervisor.mjs '+JSON.stringify(payload)+' --standby\n');
  };
  syncBuiltinESMExports();t.after(()=>{childProcess.execFile=original;syncBuiltinESMExports();});
  assert.deepEqual(await listDeadlineGuardProcesses({platform:'darwin'}),[{pid:202021,payload}]);
});
