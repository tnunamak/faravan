import './helpers/no-browser.mjs';
import {superviseBound} from './helpers/supervise-bound.mjs';
// For this release the shared watcher holds a record's owner lock for one action only, every pending row with a deadline has a
// guard after recovery; admission waits at 16 retained deadlines, including stopped rows with cleanup debt
// (docs/design/SANDBOX-CLEANUP-RECOVERY.md, "Release rule: 16 is an admission threshold").
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createSandboxCleanupJournal} from '../lib/sandbox-cleanup-journal.mjs';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import {createSandboxDeadlineManager,deadlineBinding,SANDBOX_GUARD_BUILD_ID} from '../lib/sandbox-deadline.mjs';
import {superviseSandboxDeadline} from '../lib/sandbox-deadline-supervisor.mjs';
import {createWatchPoller} from '../lib/v1/sandbox-shared-watcher.mjs';
import {watchProofStore} from '../lib/v1/sandbox-watch-proofs.mjs';
import {ownerLockPath} from '../lib/v1/sandbox-record-owner.mjs';
import {processLockOwners} from '../lib/v1/lock.mjs';

const NAME='wf-0123456789abcdef',BINARY='/fixture/sbx',T={timeout:30000};
const CLOCK=()=>({wall:10000,boot_id:'fixture',boot_ms:10000});
const DUE=()=>({wall:5,boot_id:'boot',boot_ms:5});
const SOON_CLOCK={version:1,boot_id:'boot',boot_at:1_000_000};

function tree(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wf-guard-bounds-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const directory=path.join(root,'journal'),scratch=path.join(root,'scratch');fs.mkdirSync(directory);fs.mkdirSync(scratch);
  const id=randomUUID(),owner=sandboxOwnerScope(),generation=randomUUID(),challenge=randomUUID();
  // The shape an earlier version saved after a hand-off: acknowledged, with the deadline fields still in it.
  const row={version:2,_cleanupId:id,owner_scope:owner,sbx_home:root,job_id:'job-guard-bounds',sandbox_id:NAME,
    scratch_dir:path.join(scratch,'wf-job-'+NAME+'-'+randomUUID()),create:'dispatched',compute_created:false,create_settled:false,
    compute_stopped:false,data_cleanup:'pending',policy_cleanup:'pending',deadline_at:10_000_000,deadline_clock:{version:1,boot_id:'fixture',boot_at:10_000_000},
    exec_fenced:true,watch_state:'watch_adopted',watch_generation:generation,watch_challenge:challenge,create_incarnation:id,
    watch_ack:{challenge,binary:BINARY}};
  const record=path.join(directory,id+'.json');
  fs.writeFileSync(record,JSON.stringify(row));
  const journal=(extra={})=>createSandboxCleanupJournal({directory,scratchRoot:()=>scratch,home:()=>root,destroy:async()=>({removed:false,watching:true}),
    retryWatchDebts:async()=>({policy_revoked:false}),...extra});
  return {root,directory,id,owner,row,record,journal,saved:()=>JSON.parse(fs.readFileSync(record,'utf8')),watchDir:path.join(root,'.faravan-shared-watch')};
}
const item=row=>({name:row.sandbox_id,create_incarnation:row._cleanupId,watch_generation:row.watch_generation,state:'watch_adopted',challenge:row.watch_challenge});

// The real guard loop over the saved record. `sandbox` says whether the name is listed. Bounded by the rounds it may wait.
async function guard(f,{clock=DUE,deadline={deadline_at:1,deadline_clock:{version:1,boot_id:'boot',boot_at:1}},rounds=4,listed=true,fence}={}) {
  const calls=[],states=[],stop=Error('enough rounds');let pauses=0,removed=false,ended=true;
  const row={sandbox_id:NAME,sbx_home:f.root,binary:BINARY,...deadline};
  try {
    await superviseBound(superviseSandboxDeadline,row,{clock,readRecord:()=>JSON.parse(fs.readFileSync(f.record,'utf8')),publish:state=>states.push(state),
      pause:async()=>{if(++pauses>=rounds)throw stop;},...(fence?{fence}:{}),
      run:async args=>{calls.push(args);if(args[0]==='rm')removed=true;return {code:0,stdout:JSON.stringify(listed&&!removed?[{name:NAME}]:[]),stderr:''};}});
  }catch(error){if(error!==stop)throw error;ended=false;}
  return {calls,states,ended,removed};
}

test('E: a watcher paused while it observes a record does not keep a guard past its deadline from removing the name',T,async t=>{
  const f=tree(t),proofs=watchProofStore({home:f.root,owner:f.owner});
  // The watcher's inventory listing never answers: it is paused in the middle of observing the record.
  let release;const hung=new Promise(resolve=>{release=resolve;});
  const poller=createWatchPoller({read:()=>({names:[item(f.row)]}),publish:()=>{},proofs,run:()=>hung});
  poller.claim([item(f.row)]);
  const tick=poller.tick();
  const outcome=await guard(f);
  assert.deepEqual(outcome.calls.filter(args=>args[0]==='rm'),[['rm','--force',NAME]],'the guard removes the name');
  assert.equal(outcome.states.some(state=>state.reason==='record_held'),false,'the guard is never refused the record');
  assert.equal(outcome.states.at(-1).state,'removed');
  assert.deepEqual(processLockOwners(ownerLockPath(proofs.directory,NAME)),[],'the watcher holds no record lock between actions');
  poller.stop();release({code:1});await tick;await poller.drain();
});

test('E2: a watcher action that meets a guard acting on the record is skipped, and the watcher acts on a later pass',T,async t=>{
  const f=tree(t),proofs=watchProofStore({home:f.root,owner:f.owner});
  const listing=[{name:NAME}];
  const poller=createWatchPoller({read:()=>({names:[item(f.row)]}),publish:()=>{},proofs,run:async args=>({code:0,stdout:JSON.stringify(args[0]==='ls'?listing:[]),stderr:''})});
  // The guard holds the record for its action; the watcher's pass neither fails nor waits.
  const {takeRecordFence}=await import('../lib/sandbox-deadline-supervisor.mjs');
  const handle=takeRecordFence({sandbox_id:NAME,sbx_home:f.root},f.row);
  try {poller.claim([item(f.row)]);await poller.tick();}finally{handle.release();}
  assert.equal(processLockOwners(ownerLockPath(proofs.directory,NAME)).length,0);
  poller.claim([item(f.row)]);await poller.tick();await poller.drain();
  assert.equal(proofs.matching(f.row)?.seen_present,true,'the watcher saved its sighting once the guard let go');
  poller.stop();await poller.drain();
});

function managerFor(f) {
  const launches=[],alive=new Set();let state=null;
  const m=createSandboxDeadlineManager({binary:BINARY,platform:'darwin',directory:f.directory,clock:CLOCK,run:async()=>({code:1,stdout:'',stderr:''}),
    processStart:async pid=>alive.has(pid)?'boot:'+pid:null,processStartSync:pid=>alive.has(pid)?'boot:'+pid:null,listProcesses:async()=>[],
    stateReader:()=>state,spawnGuard:(_binary,args)=>{
      const child=new EventEmitter(),payload=JSON.parse(args[1]),pid=40000+launches.length;
      Object.assign(child,{pid,kill:()=>{},disconnect:()=>{},unref:()=>{},connected:true});
      launches.push(payload);alive.add(pid);state={build_id:SANDBOX_GUARD_BUILD_ID,binding:deadlineBinding(payload),state:'armed',pid,start:'boot:'+pid};
      queueMicrotask(()=>child.emit('message',{ready:true}));return child;
    }});
  return {launches,alive,manager:m};
}

test('F: a row an earlier version handed off, whose guard retired, has a live guard after startup that removes a late sandbox',T,async t=>{
  const f=tree(t);
  // The earlier version's guard retired after the acknowledgment: the row names it, and it is gone.
  fs.writeFileSync(f.record,JSON.stringify({...f.row,deadline_enforcer:{kind:'guard',pid:424300,start:'boot:424300',binary:BINARY}}));
  const m=managerFor(f);
  const report=await f.journal().recoverDeadlines(m.manager,{clock:CLOCK,watcher:{acknowledge:async()=>assert.fail('a row with a deadline is never handed off again')}});
  assert.equal(m.launches.length,1,'one guard is started for the row');
  const saved=f.saved();
  assert.equal(saved.deadline_enforcer.kind,'guard');assert.equal(saved.deadline_enforcer.pid,40000);
  assert.equal(await m.manager.active(saved,{recovery:true}),true,'the row has a live guard');
  assert.equal(report.rows.find(row=>row.id===f.id).protected,true);
  assert.deepEqual({challenge:saved.watch_ack.challenge,generation:saved.watch_generation},{challenge:f.row.watch_challenge,generation:f.row.watch_generation},'no new acknowledgment is written');
  // The sandbox appears only now. The guard reaches its deadline and removes it, though a watcher also names the row.
  const later=await guard(f);
  assert.deepEqual(later.calls.filter(args=>args[0]==='rm'),[['rm','--force',NAME]]);
  assert.equal(later.states.at(-1).state,'removed');
});

test('F2: a second recovery starts no second guard, and a live guard of an adopted row is never replaced',T,async t=>{
  const f=tree(t);
  fs.writeFileSync(f.record,JSON.stringify({...f.row,deadline_enforcer:{kind:'guard',pid:424300,start:'boot:424300',binary:BINARY}}));
  const m=managerFor(f);
  await f.journal().recoverDeadlines(m.manager,{clock:CLOCK});
  await f.journal().recoverDeadlines(m.manager,{clock:CLOCK});
  assert.equal(m.launches.length,1,'the guard that runs is adopted');
  // The launch path never reconstructs a guard for an adopted row: only recovery does.
  await assert.rejects(m.manager.register(f.saved()),/reserved for cleanup/);
});

test('G: a guard ends on a gone proof bound to its record, and not on a proof of another create',T,async t=>{
  const f=tree(t),proofs=watchProofStore({home:f.root,owner:f.owner});
  const future={clock:DUE,deadline:{deadline_at:1_000_000,deadline_clock:SOON_CLOCK}};
  // Before any proof the guard keeps waiting.
  assert.equal((await guard(f,future)).ended,false);
  // A proof of another create of the same name does not end it.
  const other={...f.row,_cleanupId:randomUUID(),create_incarnation:undefined};other.create_incarnation=other._cleanupId;
  const tenure=proofs.own(other,{role:'watcher'});
  try {await proofs.observe(other,true,{tenure});await proofs.observe(other,false,{tenure,listedAt:(await proofs.stamp())});}finally{tenure.release();}
  assert.equal(proofs.gone(other)?.state,'gone');assert.equal((await guard(f,future)).ended,false);
  // Present, then absent, for this exact create: the name is proven gone.
  const own=proofs.own(f.row,{role:'watcher'});
  try {await proofs.observe(f.row,true,{tenure:own});await proofs.observe(f.row,false,{tenure:own,listedAt:await proofs.stamp()});}finally{own.release();}
  assert.equal(proofs.gone(f.row)?.state,'gone');
  const done=await guard(f,future);
  assert.equal(done.ended,true,'the guard ends on its own');assert.deepEqual(done.calls,[],'without a command');
  assert.equal(done.states.at(-1).state,'removed');
});

test('G2: a guard does not end on a record that is deleted or flagged settled; only a gone proof ends it',T,async t=>{
  const f=tree(t),future={clock:DUE,deadline:{deadline_at:1_000_000,deadline_clock:SOON_CLOCK}};
  assert.equal((await guard(f,future)).ended,false);
  fs.writeFileSync(f.record,JSON.stringify({...f.row,compute_stopped:true,deadline_at:undefined,deadline_clock:undefined,deadline_enforcer:undefined}));
  // Frozen change (immutable startup binding, no ENOENT removal receipt): a record that is flagged stopped, loses its deadline, or is
  // deleted is metadata, not proof. The guard keeps its duty until an exact-binding `gone` proof exists (test G).
  assert.equal((await guard(f,future)).ended,false,'a record flagged stopped does not end its guard without a gone proof');
  fs.rmSync(f.record);
  const missing=await guard(f,future);
  assert.equal(missing.ended,false,'a deleted record does not end its guard');
  assert.equal(missing.states.some(state=>state.state==='removed'),false);
});

test('H: the journal counts the rows that still need a guard',T,async t=>{
  const f=tree(t);
  assert.equal(f.journal().retainedGuards(),1);
  fs.writeFileSync(f.record,JSON.stringify({...f.row,compute_stopped:true,deadline_at:undefined,deadline_clock:undefined}));
  assert.equal(f.journal().retainedGuards(),0,'a removal that is proven needs no guard');
});

// Cleanup isolation rule: the global backlog cap goes away as a whole-lender stop.
test('H2: retained row count never closes unrelated admission',T,async t=>{
  const {fileSbx,receiptBackend,receiptJob}=await import('./helpers/sandbox-receipt-fixture.mjs');
  const {GUARD_CAP,cleanupBacklogHold}=await import('../lib/sandbox-remediation.mjs');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wf-guard-cap-')),previous=process.env.FARAVAN_SCRATCH_ROOT;
  process.env.FARAVAN_SCRATCH_ROOT=path.join(root,'scratch');fs.mkdirSync(process.env.FARAVAN_SCRATCH_ROOT);
  t.after(()=>{if(previous===undefined)delete process.env.FARAVAN_SCRATCH_ROOT;else process.env.FARAVAN_SCRATCH_ROOT=previous;fs.rmSync(root,{recursive:true,force:true});});
  const armed=new Set(),deadlines={register:async row=>{armed.add(row._cleanupId);return {kind:'guard',pid:12345,start:'boot:100',binary:'/fake/sbx'};},
    active:async row=>armed.has(row._cleanupId),activeSync:row=>armed.has(row._cleanupId)};
  const backend=receiptBackend(root,fileSbx(root),{sandboxDeadlines:deadlines});
  assert.equal(GUARD_CAP,16);
  let retained=GUARD_CAP-1;backend.cleanupJournal.backlogHold=()=>retained>=GUARD_CAP?cleanupBacklogHold(retained):null;
  const first=await backend.prepare(receiptJob());await backend.destroy(first);
  retained=GUARD_CAP;
  const next=await backend.prepare(receiptJob());await backend.destroy(next);
  assert.equal(backend.deadlineRecoveryHold(),null);
  retained=GUARD_CAP-1;
  const again=await backend.prepare(receiptJob());await backend.destroy(again);
  assert.equal(backend.deadlineRecoveryHold(),null,'the hold is gone once a row has left');
});

test('G3: after the app removes the name, the guard that reads the real record keeps its duty without a proof and signals no one',T,async t=>{
  const {fileSbx,receiptBackend,receiptJob}=await import('./helpers/sandbox-receipt-fixture.mjs');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wf-guard-end-')),previous=process.env.FARAVAN_SCRATCH_ROOT;
  process.env.FARAVAN_SCRATCH_ROOT=path.join(root,'scratch');fs.mkdirSync(process.env.FARAVAN_SCRATCH_ROOT);
  t.after(()=>{if(previous===undefined)delete process.env.FARAVAN_SCRATCH_ROOT;else process.env.FARAVAN_SCRATCH_ROOT=previous;fs.rmSync(root,{recursive:true,force:true});});
  const armed=new Set(),deadlines={register:async row=>{armed.add(row._cleanupId);return {kind:'guard',pid:12345,start:'boot:100',binary:'/fake/sbx'};},
    active:async row=>armed.has(row._cleanupId),activeSync:row=>armed.has(row._cleanupId)};
  const backend=receiptBackend(root,fileSbx(root),{sandboxDeadlines:deadlines});
  const handle=await backend.prepare(receiptJob());
  const row=backend.cleanupJournal.authority(handle),record=path.join(root,'profile','v1','sandbox-cleanup',row._cleanupId+'.json');
  assert.equal(fs.existsSync(record),true);
  const sent=[],kill=t.mock.method(process,'kill',(pid,signal)=>{if(signal!==0)sent.push([pid,signal]);return true;});void kill;
  // While the job runs, the guard waits.
  const waiting=await (async()=>{
    const stop=Error('rounds');let pauses=0,ended=true;
    try{await superviseBound(superviseSandboxDeadline,{sandbox_id:row.sandbox_id,sbx_home:row.sbx_home,binary:BINARY,deadline_at:row.deadline_at,deadline_clock:row.deadline_clock},
      {clock:()=>({wall:Date.now(),boot_id:row.deadline_clock.boot_id,boot_ms:row.deadline_clock.boot_at-(row.deadline_at-Date.now())}),
        readRecord:()=>JSON.parse(fs.readFileSync(record,'utf8')),pause:async()=>{if(++pauses>=3)throw stop;},run:async()=>assert.fail('no command before the deadline')});}
    catch(error){if(error!==stop)throw error;ended=false;}
    return ended;
  })();
  assert.equal(waiting,false);
  backend.removeScratch=async()=>{};
  assert.equal((await backend.destroy(handle)).removed,true);
  const states=[],stopped=Error('duty retained');
  await assert.rejects(()=>superviseBound(superviseSandboxDeadline,{sandbox_id:row.sandbox_id,sbx_home:row.sbx_home,binary:BINARY,deadline_at:row.deadline_at,deadline_clock:row.deadline_clock},
    {clock:()=>({wall:Date.now(),boot_id:row.deadline_clock.boot_id,boot_ms:row.deadline_clock.boot_at-(row.deadline_at-Date.now())}),
      readRecord:()=>JSON.parse(fs.readFileSync(record,'utf8')),publish:state=>states.push(state),
      pause:async()=>{throw stopped;},run:async()=>({code:0,stdout:'[]',stderr:''})}),error=>error===stopped);
  // Frozen change: the app's removal leaves no exact-binding gone proof here, so the guard keeps its duty rather than ending on the
  // vanished record. It still signals no process.
  assert.equal(states.some(state=>state.state==='removed'),false);assert.deepEqual(sent,[],'nothing is signalled');
});

test('a forward wall-clock jump cannot remove a running sandbox before its boot deadline',T,async t=>{
  const f=tree(t),deadline={deadline_at:100,deadline_clock:{version:1,boot_id:'boot',boot_at:100}};
  fs.writeFileSync(f.record,JSON.stringify({...f.row,...deadline,compute_created:true,create_settled:true}));
  const running=await guard(f,{deadline,clock:()=>({wall:100000,boot_id:'boot',boot_ms:50})});
  assert.equal(running.removed,false,'boot time still remains for the running job');
  assert.deepEqual(running.calls,[],'no sandbox command before boot expiry');
  const rebooted=await guard(f,{deadline,clock:()=>({wall:0,boot_id:'new-boot',boot_ms:0})});
  assert.equal(rebooted.removed,true,'a changed boot expires immediately');
});

test('stopped rows with retained deadlines and cleanup debt still count toward admission',T,async t=>{
  const f=tree(t);
  fs.writeFileSync(f.record,JSON.stringify({...f.row,compute_stopped:true,data_cleanup:'pending'}));
  const waiting=await guard(f,{clock:DUE,deadline:{deadline_at:1_000_000,deadline_clock:SOON_CLOCK}});
  assert.equal(waiting.ended,false,'the stopped row still retains its guard');
  assert.equal(f.journal().retainedGuards(),1,'retained deadline still consumes admission capacity');
});
