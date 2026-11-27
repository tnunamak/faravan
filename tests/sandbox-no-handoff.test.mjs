import './helpers/no-browser.mjs';
import {superviseBound} from './helpers/supervise-bound.mjs';
// For this release a deadline guard is never handed to the shared watcher. These current-build fixtures keep their guard as the
// deadline remover of its own record until it proves the removal or its own deadline acts; the watcher never retires, cancels or
// replaces a guard, and no guard exits because a watcher serves its record. Different-build replacement is covered separately
// by the build-recovery tests (docs/design/SANDBOX-CLEANUP-RECOVERY.md, "Release rule: no guard hand-off").
// These cases drive the real journal, manager, guard loop and record owner with injected process and clock seams. The watcher that
// serves is the test process itself, holding the watcher's files and locks. A signal is detected two ways: the manager's `kill`
// seam (where an older manager sent one) and `process.kill`, which is replaced so that no fake PID is ever really signalled (a liveness probe is passed through).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createSandboxCleanupJournal} from '../lib/sandbox-cleanup-journal.mjs';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import {createSandboxDeadlineManager,deadlineSupervisorPayload,deadlineBinding,deadlineProcessStartSync,SANDBOX_GUARD_BUILD_ID} from '../lib/sandbox-deadline.mjs';
import {superviseSandboxDeadline} from '../lib/sandbox-deadline-supervisor.mjs';
import {watchProofStore} from '../lib/v1/sandbox-watch-proofs.mjs';
import {acquireProcessLockSync} from '../lib/v1/lock.mjs';

const NAME='wf-0123456789abcdef',BINARY='/fixture/sbx';
const CLOCK=()=>({wall:10000,boot_id:'fixture',boot_ms:10000});
const GUARD_CLOCK=()=>({wall:5,boot_id:'boot',boot_ms:5});
const T={timeout:30000};

function tree(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wf-no-handoff-')),cleanups=[];
  t.after(()=>{for(const end of cleanups.reverse())try{end();}catch{/* Already released. */}fs.rmSync(root,{recursive:true,force:true});});
  const directory=path.join(root,'journal'),scratch=path.join(root,'scratch');fs.mkdirSync(directory);fs.mkdirSync(scratch);
  const id=randomUUID(),owner=sandboxOwnerScope();
  // A dispatched create with no absence receipt (`absent_since`): the app never saw the name absent.
  const row={version:2,_cleanupId:id,owner_scope:owner,sbx_home:root,job_id:'job-no-handoff',sandbox_id:NAME,
    scratch_dir:path.join(scratch,'wf-job-'+NAME+'-'+randomUUID()),create:'dispatched',compute_created:false,create_settled:false,
    compute_stopped:false,data_cleanup:'pending',policy_cleanup:'pending',deadline_at:10_000_000,deadline_clock:{version:1,boot_id:'fixture',boot_at:10_000_000}};
  const record=path.join(directory,id+'.json');
  fs.writeFileSync(record,JSON.stringify(row));
  const journal=(extra={})=>createSandboxCleanupJournal({directory,scratchRoot:()=>scratch,home:()=>root,destroy:async()=>({removed:false}),
    retryWatchDebts:async()=>({policy_revoked:false}),...extra});
  const saved=()=>JSON.parse(fs.readFileSync(record,'utf8'));
  return {root,directory,scratch,id,owner,row,record,journal,saved,later:end=>{cleanups.push(end);return end;},watchDir:path.join(root,'.faravan-shared-watch')};
}

// The watcher as the test process: its manifest entry, its status, its process lock and its tenure of the record.
function serve(f,row) {
  fs.mkdirSync(f.watchDir,{recursive:true});
  const releaseLock=acquireProcessLockSync(path.join(f.watchDir,'watcher.lock'));
  const tenure=watchProofStore({home:f.root,owner:f.owner}).own(row,{role:'watcher'});tenure.mark();
  const generation=randomUUID();
  fs.writeFileSync(path.join(f.watchDir,'names.json'),JSON.stringify({version:1,home:f.root,owner:f.owner,generation,
    names:[{name:row.sandbox_id,create_incarnation:row._cleanupId,watch_generation:row.watch_generation,state:'watch_adopted',challenge:row.watch_challenge}]}));
  const status={ready:true,pid:process.pid,start:deadlineProcessStartSync(process.pid),home:f.root,owner:f.owner,generation,binary:BINARY,count:1};
  const write=extra=>fs.writeFileSync(path.join(f.watchDir,'status.json'),JSON.stringify({...status,...extra}));
  write({});
  return {stop:()=>write({ready:false}),release:()=>{tenure.release();releaseLock();}};
}
const ackFor=row=>({watch_generation:row.watch_generation,challenge:row.watch_challenge,binary:BINARY});
// A watcher the journal may hand a row to. It serves each row it is asked to take, and counts the requests.
function watcherFor(f) {
  const state={asked:0,served:null};
  f.later(()=>state.served?.release());
  return {state,acknowledge:async row=>{state.asked++;state.served=serve(f,row);return ackFor(row);}};
}
const handedOffRow=row=>({...row,exec_fenced:true,watch_state:'watch_adopted',watch_generation:row.watch_generation??randomUUID(),
  watch_challenge:row.watch_challenge??randomUUID(),create_incarnation:row._cleanupId,watch_ack:null});
const withAck=row=>({...row,watch_ack:{challenge:row.watch_challenge,binary:BINARY}});

// Runs the real guard loop over the saved record until a bounded pause ends it, and returns what it did.
const GUARD_ROW=f=>({sandbox_id:NAME,sbx_home:f.root,binary:BINARY,deadline_at:1,deadline_clock:{version:1,boot_id:'boot',boot_at:1}});
async function guardRounds(f,{rounds=4}={}) {
  const calls=[],states=[],stop=Error('enough rounds');let pauses=0,removed=false,ended=true;
  try {
    await superviseBound(superviseSandboxDeadline,GUARD_ROW(f),{clock:GUARD_CLOCK,readRecord:()=>JSON.parse(fs.readFileSync(f.record,'utf8')),publish:state=>states.push(state),
      pause:async()=>{if(++pauses>=rounds)throw stop;},
      run:async args=>{calls.push(args);if(args[0]==='rm')removed=true;return {code:0,stdout:JSON.stringify(removed?[]:[{name:NAME}]),stderr:''};}});
  }catch(error){if(error!==stop)throw error;ended=false;}
  return {calls,states,ended};
}

// Every signal sent to a PID during the test. `process.kill` is replaced, so a fake PID is never really signalled.
function signals(t) {
  const sent=[],real=process.kill.bind(process);
  // A liveness probe (signal 0) sends nothing and is passed through; anything else is recorded and not delivered.
  t.mock.method(process,'kill',(pid,signal)=>{if(signal===0)return real(pid,0);sent.push([pid,signal]);return true;});
  return sent;
}
// A guard process as the manager sees it: one PID with one start identity. `onSync` runs inside every synchronous identity read.
function guardFixture(f,row,{pid=424242,onSync=()=>{}}={}) {
  const identity='start-'+pid,kills=[],life={alive:true};
  const enforcer={kind:'guard',pid,start:identity,binary:BINARY};
  const payload=deadlineSupervisorPayload({...row,deadline_enforcer:enforcer},BINARY,f.directory,'guard');
  const manager=createSandboxDeadlineManager({binary:BINARY,platform:'hermetic',directory:f.directory,clock:CLOCK,
    processStart:async()=>life.alive?identity:null,processStartSync:()=>{onSync();return life.alive?identity:null;},
    listProcesses:async()=>life.alive?[{pid,payload}]:[],
    stateReader:()=>({build_id:SANDBOX_GUARD_BUILD_ID,binding:deadlineBinding(payload),pid,start:identity,state:'armed'}),
    kill:(...args)=>{kills.push(args);life.alive=false;}});
  return {manager,kills,life,enforcer,payload,pid};
}
const outcomeOf=(report,row)=>report.rows.find(item=>item.id===row._cleanupId);

test('A: a restart before any listing leaves the guard in charge, and it removes the name at its deadline',T,async t=>{
  const sent=signals(t),f=tree(t),g=guardFixture(f,f.row),watcher=watcherFor(f);
  fs.writeFileSync(f.record,JSON.stringify({...f.row,deadline_enforcer:g.enforcer}));
  // The app restarts. The guard survived it, the row has no absence receipt, and a watcher is ready to take the name.
  // The app cannot prove the name absent, so it keeps watching it: the answer of the backend for a name it never saw absent.
  const report=await f.journal({destroy:async()=>({removed:false,watching:true})}).recoverDeadlines(g.manager,{clock:CLOCK,watcher});
  assert.equal(watcher.state.asked,0,'the watcher is never asked to take a record that has a guard');
  assert.deepEqual([...g.kills,...sent],[],'the guard is never retired');
  assert.equal(g.life.alive,true);
  assert.equal(f.saved().watch_state,undefined,'the record is not handed off');
  assert.equal(fs.existsSync(path.join(f.watchDir,'names.json')),false,'the watcher manifest does not name the record');
  assert.equal(outcomeOf(report,f.row).protected,true,'the guard protects the record');
  // The sandbox appeared before the first listing and stays present. The guard reaches its deadline and removes it: no watcher can,
  // since nothing ever saw the name absent.
  const {calls,states,ended}=await guardRounds(f);
  assert.deepEqual(calls.filter(args=>args[0]==='rm'),[['rm','--force',NAME]],'the guard removes the name at its deadline');
  assert.equal(states.some(state=>state.state==='watch_adopted'),false,'no guard exits because a watcher serves its record');
  assert.equal(states.at(-1).state,'removed');assert.equal(ended,true,'the guard ends itself once removal is proven');
});

test('B: a watcher that stops during the identity lookup before a signal still leaves every guard unsignalled',T,async t=>{
  const sent=signals(t),f=tree(t),watcher=watcherFor(f);
  // The identity of the guard is read synchronously right before a signal would be sent. The watcher stops in that read.
  const g=guardFixture(f,f.row,{onSync:()=>watcher.state.served?.stop()});
  fs.writeFileSync(f.record,JSON.stringify({...f.row,deadline_enforcer:g.enforcer}));
  await f.journal().recoverDeadlines(g.manager,{clock:CLOCK,watcher});
  assert.deepEqual([...g.kills,...sent],[],'no recovery path signals the guard');
  assert.equal(g.life.alive,true);
  // An older guard of a record the watcher already serves, found while the watcher stops during the identity read.
  const h=tree(t),served=watcherFor(h),row=withAck(handedOffRow(h.row));
  const other=guardFixture(h,row,{pid:424243,onSync:()=>served.state.served?.stop()});
  fs.writeFileSync(h.record,JSON.stringify(row));
  served.state.served=serve(h,row);
  const report=await other.manager.reconcileGuards({directory:h.directory,rowFor:id=>id===row._cleanupId?row:null});
  assert.deepEqual([...other.kills,...sent],[],'the older guard is not signalled either');
  assert.equal(report.adopted.some(guard=>guard.pid===424243)||report.blocked.some(guard=>guard.pid===424243),true,'the guard is still accounted for');
});

test('C: a recovery pass over a row with a live guard never writes watch_adopted and never signals',T,async t=>{
  const sent=signals(t);
  // The row names its guard.
  {
    const f=tree(t),g=guardFixture(f,f.row),watcher=watcherFor(f);
    fs.writeFileSync(f.record,JSON.stringify({...f.row,deadline_enforcer:g.enforcer}));
    await f.journal().recoverDeadlines(g.manager,{clock:CLOCK,watcher});
    const row=f.saved();
    assert.equal(watcher.state.asked,0);
    for(const key of ['watch_state','watch_generation','watch_challenge','watch_ack','exec_fenced','create_incarnation'])assert.equal(row[key],undefined,key+' is not written');
    assert.deepEqual([...g.kills,...sent],[]);
  }
  // The guard published its status before the row learned of it: the row names no guard, a guard still runs.
  {
    const f=tree(t),g=guardFixture(f,f.row),watcher=watcherFor(f);
    await f.journal().recoverDeadlines(g.manager,{clock:CLOCK,watcher});
    const row=f.saved();
    assert.equal(watcher.state.asked,0);
    assert.equal(row.watch_state,undefined);assert.equal(row.exec_fenced,undefined);
    assert.deepEqual([...g.kills,...sent],[]);assert.equal(g.life.alive,true);
  }
  // A record an earlier version began to hand off (no acknowledgment yet) with its guard still running: nothing is rewritten.
  {
    const f=tree(t),g=guardFixture(f,f.row),watcher=watcherFor(f),adopted={...handedOffRow(f.row),deadline_enforcer:g.enforcer};
    fs.writeFileSync(f.record,JSON.stringify(adopted));
    const before=fs.readFileSync(f.record,'utf8');
    await f.journal().recoverDeadlines(g.manager,{clock:CLOCK,watcher});
    assert.equal(watcher.state.asked,0,'no new hand-off is asked for');
    assert.equal(fs.readFileSync(f.record,'utf8'),before,'the record is not rewritten with a new challenge');
    assert.deepEqual([...g.kills,...sent],[]);assert.equal(g.life.alive,true);
  }
});

test('D: a current-build guard found after an app upgrade is adopted and left running',T,async t=>{
  const sent=signals(t);
  // A guard whose status names its exact PID and start, while the record names another guard.
  {
    const f=tree(t),row={...f.row,deadline_enforcer:{kind:'guard',pid:424999,start:'start-424999',binary:BINARY}};
    const g=guardFixture(f,row,{pid:424250});
    fs.writeFileSync(f.record,JSON.stringify(row));
    const report=await g.manager.reconcileGuards({directory:f.directory,rowFor:id=>id===row._cleanupId?row:null});
    assert.deepEqual(report.adopted.map(guard=>guard.pid),[424250]);assert.deepEqual(report.blocked,[]);
    assert.deepEqual([...g.kills,...sent],[],'it is not signalled');assert.equal(g.life.alive,true);
  }
  // A guard of a record an earlier version handed off, while a watcher serves that record.
  {
    const f=tree(t),row=withAck(handedOffRow(f.row)),g=guardFixture(f,row,{pid:424251});
    fs.writeFileSync(f.record,JSON.stringify({...row,deadline_enforcer:g.enforcer}));
    const watcher=serve(f,row);f.later(watcher.release);
    const report=await g.manager.reconcileGuards({directory:f.directory,rowFor:id=>id===row._cleanupId?{...row,deadline_enforcer:g.enforcer}:null});
    assert.deepEqual(report.adopted.map(guard=>guard.pid),[424251]);
    assert.deepEqual([...g.kills,...sent],[],'a serving watcher does not retire it');assert.equal(g.life.alive,true);
  }
  // The same upgrade through a recovery pass: the guard stays and the record is not handed off again.
  {
    const f=tree(t),row=withAck(handedOffRow(f.row)),g=guardFixture(f,row,{pid:424252}),watcher=watcherFor(f);
    fs.writeFileSync(f.record,JSON.stringify({...row,deadline_enforcer:g.enforcer}));
    const served=serve(f,row);f.later(served.release);
    await f.journal().recoverDeadlines(g.manager,{clock:CLOCK,watcher});
    assert.deepEqual([...g.kills,...sent],[]);assert.equal(g.life.alive,true);assert.equal(watcher.state.asked,0);
  }
});
