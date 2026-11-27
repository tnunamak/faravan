import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createSandboxCleanupJournal} from '../lib/sandbox-cleanup-journal.mjs';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import {createSandboxDeadlineManager,deadlineSupervisorPayload,deadlineBinding} from '../lib/sandbox-deadline.mjs';
import {acquireProcessLockSync} from '../lib/v1/lock.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createDeadlineRecoveryGate} from '../lib/v1/deadline-recovery-gate.mjs';
import {cleanupStatusSummary} from '../lib/v1/cleanup-status.mjs';
const clock=()=>({wall:10000,boot_id:'fixture',boot_ms:10000});
// Rows that carry no deadline are the only ones the watcher may take: a row with a deadline keeps its guard.
function fixture(t,{count=2,ackFailure,deadline=true}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'watch-compose-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const directory=path.join(root,'journal'),scratch=path.join(root,'scratch');fs.mkdirSync(directory);fs.mkdirSync(scratch);
  const rows=Array.from({length:count},(_,i)=>{
    const id=(i+1).toString(16).padStart(8,'0')+'-1234-1234-1234-123456789012',name='wf-'+i.toString(16).padStart(16,'0');
    const row={version:2,_cleanupId:id,owner_scope:sandboxOwnerScope(),sbx_home:root,job_id:'job-'+i,sandbox_id:name,
      scratch_dir:path.join(scratch,'wf-job-'+name+'-'+randomUUID()),create:'dispatched',compute_created:false,create_settled:false,
      compute_stopped:false,data_cleanup:'pending',policy_cleanup:'pending',...deadline&&{deadline_at:1000,deadline_clock:{version:1,boot_id:'fixture',boot_at:1000}}};
    fs.writeFileSync(path.join(directory,id+'.json'),JSON.stringify(row));return row;
  });
  const file=row=>path.join(directory,row._cleanupId+'.json'),calls={destroy:0,inventory:0,register:0,ack:[],debts:[]};
  const manager={active:async()=>false,register:async()=>{calls.register++;throw Error('no second per-name guard');}};
  const watcher={acknowledge:async row=>{calls.ack.push(row._cleanupId);if(row.job_id===ackFailure)throw Error('unavailable');
    return {watch_generation:row.watch_generation,challenge:row.watch_challenge,binary:'/fake/sbx'};}};
  const journal=createSandboxCleanupJournal({directory,scratchRoot:()=>scratch,home:()=>root,
    destroy:async()=>{calls.destroy++;throw Error('503 inventory must not be needed');},
    inspectPass:async()=>{calls.inventory++;throw Error('no legacy listing for adopted watches');},
    retryWatchDebts:async row=>{calls.debts.push(row._cleanupId);return {policy_revoked:true};}});
  return {root,directory,rows,file,calls,journal,manager,watcher,
    recover:()=>journal.recoverDeadlines(manager,{clock,watcher,validateRow:r=>r.sbx_home===root})};
}
const result=(report,row)=>report.rows.find(r=>r.id===row._cleanupId);
test('first malformed row does not block later no-listing durable adoptions',async t=>{
  const f=fixture(t,{count:3,deadline:false});fs.writeFileSync(f.file(f.rows[0]),'broken');
  const report=await f.recover();assert.equal(report.complete,false);assert.equal(result(report,f.rows[0]).status,'failed');
  for(const row of f.rows.slice(1)){const r=result(report,row);assert.equal(r.status,'watching');assert.equal(r.admission_released,true);assert.equal(r.protected,true);}
  assert.equal(f.calls.destroy,0);assert.equal(f.calls.inventory,0);assert.equal(f.calls.register,0);
});
test('endless listing failure cannot prevent adoption; compute and every debt remain explicit',async t=>{
  const f=fixture(t,{deadline:false});const report=await f.recover();assert.equal(report.complete,true);
  for(const row of f.rows){const saved=JSON.parse(fs.readFileSync(f.file(row)));assert.equal(saved.watch_state,'watch_adopted');
    assert.equal(saved.compute_stopped,false);assert.equal(saved.create_settled,false);assert.equal(saved.data_cleanup,'pending');assert.equal(saved.policy_cleanup,'pending');}
  const status=f.journal.status();assert.equal(status.create_watch,2);assert.equal(status.compute_cleanup_pending,2);assert.equal(status.data_cleanup_pending,2);
  assert.equal(f.journal.jobsStopped(f.rows.map(r=>r.job_id)),false);assert.equal(f.calls.destroy,0);assert.equal(f.calls.register,0);
});
test('one missing acknowledgment stays row-local and later row adopts',async t=>{
  const f=fixture(t,{ackFailure:'job-0',deadline:false}),report=await f.recover();
  assert.equal(result(report,f.rows[0]).status,'failed');assert.equal(result(report,f.rows[0]).admission_released,false);
  assert.equal(result(report,f.rows[1]).admission_released,true);
});
test('own record and name locks remain untouched while siblings adopt',async t=>{
  for(const kind of ['record','name']){
    const f=fixture(t,{deadline:false}),row=f.rows[0],before=fs.readFileSync(f.file(row));
    const release=acquireProcessLockSync(kind==='record'?f.file(row)+'.lock':path.join(f.directory,row.sandbox_id+'.scope'));
    try{const report=await f.recover();assert.equal(result(report,row).status,'in_progress');assert.equal(result(report,f.rows[1]).admission_released,true);
      assert.deepEqual(fs.readFileSync(f.file(row)),before);}finally{release();}
  }
});
test('restart replays adoption without reconstructing another guard',async t=>{
  const f=fixture(t,{count:1,deadline:false});await f.recover();const before=JSON.parse(fs.readFileSync(f.file(f.rows[0])));
  const restarted=createSandboxCleanupJournal({directory:f.directory,scratchRoot:()=>path.join(f.root,'scratch'),home:()=>f.root,
    destroy:()=>assert.fail('restart cannot inventory an adopted name')});
  const report=await restarted.recoverDeadlines(f.manager,{clock,watcher:f.watcher});const after=JSON.parse(fs.readFileSync(f.file(f.rows[0])));
  assert.equal(result(report,f.rows[0]).admission_released,true);assert.equal(after.watch_generation,before.watch_generation);
  assert.notEqual(after.watch_challenge,before.watch_challenge);assert.equal(f.calls.register,0);assert.equal(after.compute_stopped,false);
});
test('legacy reaper skips adopted compute and retries only explicit non-compute debt work',async t=>{
  const f=fixture(t,{deadline:false});await f.recover();const before=f.rows.map(row=>JSON.parse(fs.readFileSync(f.file(row))));await f.journal.reap();
  assert.equal(f.calls.inventory,0);assert.equal(f.calls.destroy,0);assert.equal(f.calls.debts.length,2);
  for(let i=0;i<f.rows.length;i++){const after=JSON.parse(fs.readFileSync(f.file(f.rows[i])));assert.equal(after.watch_generation,before[i].watch_generation);
    assert.equal(after.watch_ack.challenge,before[i].watch_ack.challenge);assert.equal(after.compute_stopped,false);assert.equal(after.data_cleanup,'pending');}
});
test('actual protected-dispatch method rejects stale adopted handle before launch',async t=>{
  const f=fixture(t,{count:1,deadline:false});await f.recover();const source=fs.readFileSync(new URL('../lib/docker-backend.mjs',import.meta.url),'utf8');
  const start=source.indexOf('  async _dispatchProtected('),end=source.indexOf('  async _runJobCommand(',start);
  assert.ok(start>0&&end>start);
  const method=Function('policyError','sandboxDeadlineRemaining','sbxHome','return ({'+source.slice(start,end)+'})._dispatchProtected')(
    (code,message)=>Object.assign(Error(message),{code}),()=>1000,()=>f.root);
  let launched=0;const backend={assertActive:async()=>{},cleanupJournal:f.journal,assertDeadlineTargetClear:()=>{},sandboxDeadlines:{activeSync:()=>true},deadlineClock:clock,monotonic:()=>0};
  await assert.rejects(method.call(backend,f.rows[0],null,()=>{launched++;}),/reserved for cleanup/);assert.equal(launched,0);
});
test('never-created current row without a deadline still adopts before listing without inventing a guard',async t=>{
  const f=fixture(t,{count:1}),row={...f.rows[0]};delete row.deadline_at;delete row.deadline_clock;fs.writeFileSync(f.file(row),JSON.stringify(row));
  const report=await f.recover();assert.equal(result(report,row).admission_released,true);assert.equal(f.calls.register,0);assert.equal(f.calls.destroy,0);
});
test('materialization evidence from a bound supervisor is never discarded into a never-created watch',async t=>{
  const f=fixture(t,{count:1});f.manager.observed=()=>true;
  const report=await f.recover();assert.equal(result(report,f.rows[0]).status,'failed');assert.equal(f.calls.ack.length,0);
  assert.notEqual(JSON.parse(fs.readFileSync(f.file(f.rows[0]))).watch_state,'watch_adopted');
});
// Execute exact production backend methods plus the real startup gate and
// journal, without importing or substituting the excluded credential module.
function composedBackend(f) {
  const source=fs.readFileSync(new URL('../lib/docker-backend.mjs',import.meta.url),'utf8');
  const part=(a,b)=>{const start=source.indexOf(a),end=source.indexOf(b,start+a.length);assert.ok(start>0&&end>start);return source.slice(start,end);};
  const methods=[part('  deadlineRecoveryHold() {','  async inspectCleanupRemediation'),part('  cleanupStatus(options)','  _invalidateOwnedStartupRecovery()'),
    part('  reconcileOwnedSandboxes(','\n  /**'),part('  isOwnedSandboxProofCurrent(','  beginLendingSession(')].join('\n');
  const policyError=(code,message,details)=>Object.assign(Error(message),{code,...details});
  const values={sbxHome:()=>f.root,daemonJobContext:new AsyncLocalStorage(),deadlineRecoveryContext:new AsyncLocalStorage(),
    recoveryHoldFor:()=>({cause_code:'cleanup_unavailable'}),deadlineRecoveryError:()=>policyError('cessation_unverified','unavailable'),policyError,
    parseSbxListing:()=>{throw Error('listing unavailable');},sandboxDeadlineRemaining:()=>1000};
  const Backend=Function(...Object.keys(values),'return class {'+methods+'}')( ...Object.values(values));
  // This seam starts after a successful app availability check. Watcher
  // inventory failures below are separate from that current-home precheck.
  const backend=new Backend();Object.assign(backend,{_cleanupListingReady:async()=>{f.calls.availability=(f.calls.availability??0)+1;},cleanupJournal:f.journal,sandboxDeadlines:f.manager,deadlineClock:clock,
    _ownedStartupGeneration:0,_legacyDaemonOptions:{platformName:'linux'},_rowHomeMatches:row=>row.sbx_home===f.root,
    _sharedSandboxWatcher:()=>({...f.watcher,status:()=>({healthy:true,count:f.rows.length,listing_failed:true})}),
    _rowRun:async()=>{f.calls.inventory++;return {code:503};}});return backend;
}
test('composed watcher handoff tolerates stale listing failures after verified app availability',async t=>{
  const f=fixture(t,{deadline:false});for(const row of f.rows)fs.writeFileSync(f.file(row),JSON.stringify({...row,unknown:'creation_unproven'}));
  const backend=composedBackend(f),gate=createDeadlineRecoveryGate({backend});await gate.retry();assert.equal(gate.current(),null);assert.ok(f.calls.availability>0);
  const proof=await backend.reconcileOwnedSandboxes();assert.equal(proof.admission_allowed,true);assert.equal(proof.removed,false);
  assert.equal(backend.isOwnedSandboxAdmissionCurrent(proof),true);assert.equal(backend.isOwnedSandboxProofCurrent(proof),false);
  // Cleanup isolation rule: every unresolved name stays fenced, including watched names.
  for(const row of f.rows)assert.throws(()=>backend.assertDeadlineTargetClear(row),e=>e.recovery_scope==='target');
  const summary=cleanupStatusSummary(backend.cleanupStatus());assert.equal(summary.shared_watch.message,'watching 2 names until listing works');
  assert.equal(summary.data_cleanup_pending,2);assert.equal(summary.compute_cleanup_pending,2);assert.equal(f.calls.inventory,0);
});
test('composed missing watcher acknowledgment blocks its target only and startup serves the row set',async t=>{
  const f=fixture(t,{ackFailure:'job-0',deadline:false}),backend=composedBackend(f),gate=createDeadlineRecoveryGate({backend});await gate.retry();
  assert.equal(gate.current(),null);const proof=await backend.reconcileOwnedSandboxes();assert.equal(proof.admission_allowed,true);assert.equal(proof.removed,false);
  assert.throws(()=>backend.assertDeadlineTargetClear(f.rows[0]),e=>e.recovery_scope==='target');
  assert.throws(()=>backend.assertDeadlineTargetClear(f.rows[1]),e=>e.recovery_scope==='target');assert.doesNotThrow(()=>backend.assertDeadlineTargetClear({sandbox_id:'wf-ffffffffffffffff'}));
  assert.equal(f.calls.inventory,0);
});

// This is a dead publication, not a live supervisor. The guard was the Linux
// service-manager fallback and exited before its enforcer reached the journal.
test('exited published guard materialization prevents never-created adoption without a saved enforcer',async t=>{
  const f=fixture(t,{count:1}),row=f.rows[0],binary='/fake/sbx';
  const payload=deadlineSupervisorPayload(row,binary,f.directory,'guard');
  const state={binding:deadlineBinding(payload),state:'removed',observed:true,pid:2147483647,start:'exited-audit-guard'};
  fs.writeFileSync(payload.statusPath,JSON.stringify(state));
  let spawnCalls=0,acks=0;
  const manager=createSandboxDeadlineManager({binary,platform:'linux',directory:f.directory,clock,
    // No host service-manager process or real CLI can be reached by this test.
    run:async()=>({code:1,stdout:'',stderr:''}),
    processStart:async()=>null,processStartSync:()=>null,
    spawnGuard:()=>{spawnCalls++;throw Error('A historical observation must not launch a replacement guard');}});
  const withGuard={...row,deadline_enforcer:{kind:'guard',pid:state.pid,start:state.start,binary}};
  assert.equal(manager.observed(withGuard),true,'The exact historical guard payload proves materialization');
  assert.equal(await manager.active(withGuard,{recovery:true}),false,'The historical guard has exited');
  assert.equal(JSON.parse(fs.readFileSync(f.file(row))).deadline_enforcer,undefined);
  const report=await f.journal.recoverDeadlines(manager,{clock,validateRow:r=>r.sbx_home===f.root,
    watcher:{acknowledge:async()=>{acks++;throw Error('Do not retire any guard in this regression test');}}});
  assert.equal(acks,0,'An exited, bound materialization must not enter the never-created watch handoff');
  const saved=JSON.parse(fs.readFileSync(f.file(row)));
  assert.notEqual(saved.watch_state,'watch_adopted');
  assert.equal(saved.compute_created,true);assert.equal(saved.create_settled,true);
  assert.equal(saved.compute_stopped,false,'Observation alone does not establish cessation');
  assert.equal(spawnCalls,0,'Do not reconstruct an independent guard to recover historical observation');
  assert.equal(result(report,row).status,'failed','The fixture intentionally has no inventory/cessation proof');
});

// Model the precise cross-process interleaving using the existing synchronous
// boundary: another process commits the durable fence just after our read.
// The old handle has no registration lease, and the old guard remains live
// while the new watcher has not yet acknowledged/retired it.
test('dispatch cannot launch a stale handle adopted between fence read and authority reread',async t=>{
  const f=fixture(t,{count:1}),row={...f.rows[0],
    deadline_enforcer:{kind:'guard',pid:2147483647,start:'pending-retirement-guard',binary:'/fake/sbx'}};
  fs.writeFileSync(f.file(row),JSON.stringify(row));
  assert.equal(f.journal.admissionAuthority(row),null,'This is a stale, unleased handle');
  const checkFence=f.journal.assertExecAllowed;
  f.journal.assertExecAllowed=handle=>{
    checkFence(handle);
    // Equivalent to a foreign adopter's first durable write while holding
    // the now-available record/name locks. This is before acknowledgment.
    const adopted={...row,exec_fenced:true,watch_state:'watch_adopted',watch_generation:randomUUID(),
      create_incarnation:row._cleanupId,watch_challenge:randomUUID(),watch_ack:null};
    fs.writeFileSync(f.file(row),JSON.stringify(adopted));
  };
  const source=fs.readFileSync(new URL('../lib/docker-backend.mjs',import.meta.url),'utf8');
  const start=source.indexOf('  async _dispatchProtected('),end=source.indexOf('  async _runJobCommand(',start);
  assert.ok(start>0&&end>start);
  const method=Function('policyError','sandboxDeadlineRemaining','sbxHome','return ({'+source.slice(start,end)+'})._dispatchProtected')(
    (code,message)=>Object.assign(Error(message),{code}),()=>1000,()=>f.root);
  let launched=0;
  const backend={assertActive:async()=>{},cleanupJournal:f.journal,assertDeadlineTargetClear:()=>{},
    sandboxDeadlines:{activeSync:()=>true},deadlineClock:clock,monotonic:()=>0};
  await assert.rejects(method.call(backend,row,null,()=>{launched++;}),
    'A live old guard cannot grant exec authority after the registration lease is gone');
  assert.equal(launched,0);
});


test('direct adoption retains exited guard materialization and refuses never-created handoff',async t=>{
  const f=fixture(t,{count:1}),row=f.rows[0],binary='/fake/sbx';
  const payload=deadlineSupervisorPayload(row,binary,f.directory,'guard');
  fs.writeFileSync(payload.statusPath,JSON.stringify({binding:deadlineBinding(payload),state:'removed',observed:true,
    pid:2147483647,start:'exited-direct-adoption-guard'}));
  let acks=0;
  const manager=createSandboxDeadlineManager({binary,platform:'linux',directory:f.directory,clock,
    run:async()=>({code:1,stdout:'',stderr:''}),processStart:async()=>null,processStartSync:()=>null,
    spawnGuard:()=>assert.fail('Direct adoption cannot launch a replacement guard')});
  const outcome=await f.journal.adoptWatch({id:row._cleanupId,name:row.sandbox_id,status:'watching'},manager,
    {acknowledge:async()=>{acks++;throw Error('An observed sandbox is not eligible for this handoff');}},
    {validateRow:r=>r.sbx_home===f.root});
  assert.equal(acks,0);assert.equal(outcome.status,'failed');assert.equal(outcome.admission_released,false);
  const saved=JSON.parse(fs.readFileSync(f.file(row)));
  assert.notEqual(saved.watch_state,'watch_adopted');
  assert.equal(saved.compute_created,true);assert.equal(saved.create_settled,true);assert.equal(saved.compute_stopped,false);
});
