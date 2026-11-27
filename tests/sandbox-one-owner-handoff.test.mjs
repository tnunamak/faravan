import './helpers/no-browser.mjs';
import {superviseBound} from './helpers/supervise-bound.mjs';
// A record counts as handed off only when the watcher's acknowledgment matches the current challenge, and the guard leaves a record
// only for a watcher that is actually serving it. These cases drive the real journal, manager, guard loop and record owner with
// injected process and clock seams; the serving watcher is the test process itself holding the watcher's files and locks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {createSandboxCleanupJournal} from '../lib/sandbox-cleanup-journal.mjs';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import {createSandboxDeadlineManager,deadlineSupervisorPayload,deadlineBinding,deadlineProcessStartSync} from '../lib/sandbox-deadline.mjs';
import {superviseSandboxDeadline,takeRecordFence} from '../lib/sandbox-deadline-supervisor.mjs';
import {WATCHER_BUILD,adoptSandboxWatch,createSharedSandboxWatcher,sharedWatchServing} from '../lib/v1/sandbox-shared-watcher.mjs';
import {watchProofStore,watchProofDirectory} from '../lib/v1/sandbox-watch-proofs.mjs';
import {acquireRecordOwner} from '../lib/v1/sandbox-record-owner.mjs';
import {acquireProcessLockSync} from '../lib/v1/lock.mjs';
import {DockerSbxBackend} from '../lib/docker-backend.mjs';

const NAME='wf-0123456789abcdef',BINARY='/fixture/sbx';
const CLOCK=()=>({wall:10000,boot_id:'fixture',boot_ms:10000});
const GUARD_CLOCK=()=>({wall:5,boot_id:'boot',boot_ms:5});
const T={timeout:30000};

function tree(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wf-one-owner-')),cleanups=[];
  // Handles are released before the tree goes: releasing a lock after its directory is removed would fail.
  t.after(()=>{for(const end of cleanups.reverse())try{end();}catch{/* Already released. */}fs.rmSync(root,{recursive:true,force:true});});
  const directory=path.join(root,'journal'),scratch=path.join(root,'scratch');fs.mkdirSync(directory);fs.mkdirSync(scratch);
  const id=randomUUID(),owner=sandboxOwnerScope();
  const row={version:2,_cleanupId:id,owner_scope:owner,sbx_home:root,job_id:'job-one-owner',sandbox_id:NAME,
    scratch_dir:path.join(scratch,'wf-job-'+NAME+'-'+randomUUID()),create:'dispatched',compute_created:false,create_settled:false,
    compute_stopped:false,data_cleanup:'pending',policy_cleanup:'pending',deadline_at:10_000_000,deadline_clock:{version:1,boot_id:'fixture',boot_at:10_000_000}};
  const record=path.join(directory,id+'.json');
  fs.writeFileSync(record,JSON.stringify(row));
  const journal=(extra={})=>createSandboxCleanupJournal({directory,scratchRoot:()=>scratch,home:()=>root,destroy:async()=>({removed:false}),
    retryWatchDebts:async()=>({policy_revoked:false}),...extra});
  const saved=()=>JSON.parse(fs.readFileSync(record,'utf8'));
  return {root,directory,scratch,id,owner,row,record,journal,saved,later:end=>{cleanups.push(end);return end;},watchDir:path.join(root,'.faravan-shared-watch')};
}

// The watcher as the test process: its manifest entry, its status, its process lock and its tenure of the record. `stop` is what a
// stopping watcher publishes; it stays alive with the same identity.
function serve(f,row,{ready=true}={}) {
  fs.mkdirSync(f.watchDir,{recursive:true});
  const releaseLock=acquireProcessLockSync(path.join(f.watchDir,'watcher.lock'));
  const tenure=watchProofStore({home:f.root,owner:f.owner}).own(row,{role:'watcher'});tenure.mark();
  const generation=randomUUID();
  fs.writeFileSync(path.join(f.watchDir,'names.json'),JSON.stringify({version:1,home:f.root,owner:f.owner,generation,
    names:[{name:row.sandbox_id,create_incarnation:row._cleanupId,watch_generation:row.watch_generation,state:'watch_adopted',challenge:row.watch_challenge}]}));
  const status={ready,pid:process.pid,start:deadlineProcessStartSync(process.pid),home:f.root,owner:f.owner,generation,binary:BINARY,build:WATCHER_BUILD,count:1};
  const write=extra=>fs.writeFileSync(path.join(f.watchDir,'status.json'),JSON.stringify({...status,...extra}));
  write({});
  return {stop:()=>write({ready:false}),release:()=>{tenure.release();releaseLock();}};
}
// Runs the real guard loop over the saved record for at most `rounds` rounds (a bounded pause ends it), and returns what it did.
const GUARD_ROW=f=>({sandbox_id:NAME,sbx_home:f.root,binary:BINARY,deadline_at:1,deadline_clock:{version:1,boot_id:'boot',boot_at:1}});
async function guardRounds(f,{rounds=3,present=true}={}) {
  const calls=[],states=[],stop=Error('enough rounds');let pauses=0,removed=false;
  try {
    await superviseBound(superviseSandboxDeadline,GUARD_ROW(f),{clock:GUARD_CLOCK,readRecord:()=>JSON.parse(fs.readFileSync(f.record,'utf8')),publish:state=>states.push(state),
      pause:async()=>{if(++pauses>=rounds)throw stop;},
      run:async args=>{calls.push(args);if(args[0]==='rm')removed=true;return {code:0,stdout:JSON.stringify(present&&!removed?[{name:NAME}]:[]),stderr:''};}});
  }catch(error){if(error!==stop)throw error;}
  return {calls,states};
}
const ackFor=row=>({watch_generation:row.watch_generation,challenge:row.watch_challenge,binary:BINARY});
const handedOff=row=>({...row,exec_fenced:true,watch_state:'watch_adopted',watch_generation:row.watch_generation??randomUUID(),
  watch_challenge:row.watch_challenge??randomUUID(),create_incarnation:row._cleanupId,watch_ack:null});
const withAck=row=>({...row,watch_ack:{challenge:row.watch_challenge,binary:BINARY}});

// A guard process as the manager sees it: one PID with one start identity. `alive` ends when the manager signals it.
function guardFixture(f,row,pid=424242) {
  const identity='start-'+pid,kills=[],life={alive:true};
  const enforcer={kind:'guard',pid,start:identity,binary:BINARY};
  const payload=deadlineSupervisorPayload({...row,deadline_enforcer:enforcer},BINARY,f.directory,'guard');
  const manager=createSandboxDeadlineManager({binary:BINARY,platform:'hermetic',directory:f.directory,clock:CLOCK,
    processStart:async()=>life.alive?identity:null,processStartSync:()=>life.alive?identity:null,
    listProcesses:async()=>life.alive?[{pid,payload}]:[],
    stateReader:()=>({binding:deadlineBinding(payload),pid,start:identity,state:'armed'}),
    kill:(...args)=>{kills.push(args);life.alive=false;}});
  return {manager,kills,life,enforcer,payload};
}
const outcomeOf=(report,row)=>report.rows.find(item=>item.id===row._cleanupId);

test('a hand-off fault right after the adopted row is saved leaves a guard that still removes its bound name at the deadline',T,async t=>{
  const f=tree(t),row=handedOff(f.row);
  fs.writeFileSync(f.record,JSON.stringify(row));
  const {calls,states}=await guardRounds(f);
  assert.deepEqual(calls.filter(args=>args[0]==='rm'),[['rm','--force',NAME]],'the guard removes the name bound to its own row');
  assert.equal(states.some(state=>state.state==='failed'&&state.reason==='record_changed'),false);
});

test('a guard does not leave a record for a serving watcher, a stopping watcher or an unrelated lock holder',T,async t=>{
  // A stopping watcher: alive, holding the record, with the same identity, but it published "not ready".
  {
    const f=tree(t),row=withAck(handedOff(f.row));fs.writeFileSync(f.record,JSON.stringify(row));
    const watcher=serve(f,row);watcher.stop();
    try {
      const {calls,states}=await guardRounds(f);
      assert.equal(states.some(state=>state.state==='watch_adopted'),false,'a stopping watcher is not a replacement');
      assert.deepEqual(calls.filter(args=>args[0]==='rm'),[],'the held record is not removed either');
    }finally{watcher.release();}
  }
  // An unrelated holder of the record's lock.
  {
    const f=tree(t),row=withAck(handedOff(f.row));fs.writeFileSync(f.record,JSON.stringify(row));
    const other=acquireRecordOwner({directory:watchProofDirectory(f.root),name:NAME,role:'app',binding:{create_incarnation:row._cleanupId}});
    try {
      const {states}=await guardRounds(f);
      assert.equal(states.some(state=>state.state==='watch_adopted'),false,'a lock holder that is not a watcher of this record is not a replacement');
    }finally{other.release();}
  }
  // The watcher serves: the guard still does not report a hand-off and does not end; it only waits while the watcher holds the record.
  {
    const f=tree(t),row=withAck(handedOff(f.row));fs.writeFileSync(f.record,JSON.stringify(row));
    const watcher=serve(f,row);
    try {
      assert.ok(sharedWatchServing(row),'the fixture serves');
      const {calls,states}=await guardRounds(f);
      assert.equal(states.some(state=>state.state==='watch_adopted'),false,'a serving watcher is not a reason for a guard to end');
      assert.deepEqual(calls.filter(args=>args[0]==='rm'),[]);
    }finally{watcher.release();}
  }
});

test('two recovery passes over an adopted row whose watcher is healthy write nothing the second time',T,async t=>{
  const f=tree(t);delete f.row.deadline_at;delete f.row.deadline_clock;fs.writeFileSync(f.record,JSON.stringify(f.row));let watcher=null,acks=0;
  const manager=createSandboxDeadlineManager({binary:BINARY,platform:'hermetic',directory:f.directory,clock:CLOCK,listProcesses:async()=>[]});
  const serving={acknowledge:async row=>{acks++;watcher?.release();watcher=serve(f,row);return ackFor(row);}};
  f.later(()=>watcher?.release());
  const first=await f.journal().recoverDeadlines(manager,{clock:CLOCK,watcher:serving});
  assert.equal(outcomeOf(first,f.row).admission_released,true);assert.equal(acks,1);
  const row=fs.readFileSync(f.record,'utf8'),names=fs.readFileSync(path.join(f.watchDir,'names.json'),'utf8');
  assert.ok(sharedWatchServing(JSON.parse(row)),'the watcher serves the saved row');
  const second=await f.journal().recoverDeadlines(manager,{clock:CLOCK,watcher:serving});
  assert.equal(acks,1,'a healthy hand-off is not acknowledged again');
  assert.equal(fs.readFileSync(f.record,'utf8'),row,'no new challenge and no null acknowledgment is written');
  assert.equal(fs.readFileSync(path.join(f.watchDir,'names.json'),'utf8'),names,'the manifest is not rewritten');
  assert.equal(outcomeOf(second,f.row).admission_released,true);assert.equal(outcomeOf(second,f.row).protected,true);
});

test('the app\'s destruction before adoption takes the record owner handle and never waits on a guard that holds it',T,async t=>{
  const f=tree(t),row={...f.row,absent_since:1};
  const commands=[];let during=null;
  const backend=Object.assign(Object.create(DockerSbxBackend.prototype),{
    _rowHomeMatches:()=>true,_watchInventoryCurrent:()=>false,_now:()=>1_000_000,sandboxDeadlines:{observed:()=>false},
    cleanupJournal:{authority:()=>({...row}),closed:()=>false,mark:()=>true},
    _rowRun:async(_row,args)=>{
      commands.push(args);
      if(args[0]==='ls'&&!during){
        // While the app lists, the guard cannot take the record: it is told at once.
        try{takeRecordFence(row,row).release();during='free';}catch(error){during=error.code;}
        return {code:0,stdout:JSON.stringify([{name:NAME}]),stderr:''};
      }
      if(args[0]==='ls')return {code:0,stdout:'[]',stderr:''};
      if(args[0]==='secret')return {code:0,stdout:JSON.stringify({secrets:[],custom_secrets:[],shadowed_services:[],env_only_count:0}),stderr:''};
      if(args[0]==='policy')return {code:0,stdout:'{"rules":[]}',stderr:''};
      return {code:0,stdout:'',stderr:''};
    }});
  // The guard holds the handle at its deadline.
  const guard=takeRecordFence(row,row);
  const answered=await Promise.race([backend._resolveCompute(row).catch(error=>({error})),sleep(4000).then(()=>'hung')]);
  assert.notEqual(answered,'hung','the app does not wait for the guard');
  assert.deepEqual(commands,[],'the app neither lists nor removes while the guard holds the record');
  assert.equal(answered.removed,false);assert.equal(answered.watching,true);
  guard.release();
  await backend._resolveCompute(row);
  assert.ok(commands.some(args=>args[0]==='ls'),'once the guard released it, the app resolves the name');
  assert.equal(during,'lock_busy','the app holds the record while it lists');
  // The handle is released afterwards.
  takeRecordFence(row,row).release();
});

test('a hand-off that meets a guard holding the record is refused, even when a receipt already exists',T,async t=>{
  const f=tree(t),row=withAck(handedOff({...f.row,absent_since:7,deadline_enforcer:undefined}));
  const adopted={...row,watch_ack:null};
  // The receipt exists from an earlier request.
  const proofs=watchProofStore({home:f.root,owner:f.owner}),tenure=proofs.own(adopted,{role:'app'});
  await proofs.receipt(adopted,7,{tenure});tenure.release();
  const guard=takeRecordFence(adopted,adopted);f.later(guard.release);
  const watcher=createSharedSandboxWatcher({home:f.root,owner:f.owner,binary:BINARY,readyMs:300,spawnWatcher:()=>({on(){},unref(){}})});
  const outcome=await Promise.race([watcher.acknowledge(adopted).then(()=>'answered',error=>error.code??error.message),sleep(4000).then(()=>'hung')]);
  assert.equal(outcome,'lock_busy','the guard, not a watcher, holds the record');
  assert.equal(fs.existsSync(path.join(f.watchDir,'names.json')),false,'the manifest does not name a record the guard holds');
});

test('a hand-off refused because a guard holds the record keeps that reason',T,async t=>{
  const refused=await adoptSandboxWatch({status:'watching',row:{version:2,_cleanupId:randomUUID(),create:'dispatched',compute_created:false,create_settled:false,
    compute_stopped:false,sandbox_id:NAME,owner_scope:'owner',sbx_home:os.tmpdir()}},
  {fence:()=>{},persist:()=>{},acknowledge:async()=>{throw Object.assign(new Error('busy'),{code:'lock_busy'});},});
  assert.equal(refused.status,'failed');assert.equal(refused.admission_released,false);
  assert.equal(refused.reason,'record_held');
  // Through the journal, the status row carries the same typed reason.
  const f=tree(t);delete f.row.deadline_at;delete f.row.deadline_clock;fs.writeFileSync(f.record,JSON.stringify(f.row));
  const report=await f.journal().recoverDeadlines(createSandboxDeadlineManager({binary:BINARY,platform:'hermetic',directory:f.directory,clock:CLOCK,listProcesses:async()=>[]}),{clock:CLOCK,
    watcher:{acknowledge:async()=>{throw Object.assign(new Error('busy'),{code:'lock_busy'});}}});
  const outcome=outcomeOf(report,f.row);
  assert.equal(outcome.admission_released,false);assert.equal(outcome.reason,'record_held');
});
