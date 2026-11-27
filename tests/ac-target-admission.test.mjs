import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AsyncLocalStorage} from 'node:async_hooks';
import {sandboxCommandDiagnostic} from '../lib/sandbox-command-observation.mjs';
import {bindSandboxCommandDiagnostic} from '../lib/sandbox-command-diagnostic.mjs';
import {deadlineRecoveryHold as recoveryHoldFor,deadlineRecoveryError,sandboxServiceUnavailableHold} from '../lib/sandbox-remediation.mjs';

// Exact production methods, isolated from the excluded backend dependency graph.
// These contracts do not claim full app/backend integration coverage.
const source=readFileSync(new URL('../lib/docker-backend.mjs',import.meta.url),'utf8');
const part=(a,b)=>{const start=source.indexOf(a),end=source.indexOf(b,start+a.length);assert.ok(start>=0&&end>start);return source.slice(start,end);};
const methods=[part('  _noteCleanupListingFailure(','  // Availability is not an absence proof.'),part('  async _rowRun(row,args,options={}) {','  async _runStorageCommand('),part('  deadlineRecoveryHold() {','  async inspectCleanupRemediation'),
  part('  cleanupStatus(options)','  _invalidateOwnedStartupRecovery()'),
  part('  reconcileOwnedSandboxes(','\n  /**'),part('  async admitJob(job','  async prepareSignIn('),
  part('  async _runStorageCommand(','  sandboxOwnership()'),
  part('  async _dispatchProtected(','  /** Rules that apply to this sandbox')].join('\n');
function fixture({report={complete:true,rows:[]},proof={removed:true},recover}={}) {
  let runs=0,calls=0;const home='/fake/home';
  const policyError=(code,message,details)=>Object.assign(Error(message),{code,...details});
  const values={sbxHome:()=>home,daemonJobContext:new AsyncLocalStorage(),deadlineRecoveryContext:new AsyncLocalStorage(),recoveryHoldFor,deadlineRecoveryError,sandboxServiceUnavailableHold,completeSbxListing:()=>true,policyError,sandboxCommandDiagnostic,bindSandboxCommandDiagnostic,assertSbxRuntime:()=>{},
    borrowedCredentialMechanismAllowed:()=>true,admitDockerJob:()=>({ok:true}),sbxChildEnv:()=>({}),credentialStoreEnv:()=>({}),parseSbxListing:result=>result?.code===0?[]:null,sandboxDeadlineRemaining:()=>60000,
    runSbxStreaming:async()=>{runs++;return {code:0};},withSbxRuntime:(_runtime,work)=>work()};
  const Backend=Function(...Object.keys(values),'return class Backend {'+methods+'}')( ...Object.values(values));
  const backend=new Backend();
  // This source seam isolates per-target admission. Whole-pass availability
  // has real-backend coverage in sandbox-listing-unavailable.test.mjs.
  Object.assign(backend,{_now:Date.now,_cleanupListingRetryMs:15000,_cleanupListingReady:async()=>{},_legacyDaemonOptions:{platformName:'linux'},_ownedStartupGeneration:0,_diskSentries:new Map(),
    deadlineClock:()=>({}),sandboxDeadlines:{activeSync:()=>true},monotonic:()=>0,assertActive:async()=>{},_rowHomeMatches:()=>true,_cleanupRuntime:()=>({path:'/fake/sbx'}),_retryCleanupListing:run=>run(),
    cleanupJournal:{recoverDeadlines:async()=>{calls++;return recover?recover():report;},status:()=>({state:'pending',compute_cleanup_pending:report.rows?.length??0}),
      reconcileOwned:async()=>proof,authority:()=>({deadline_enforcer:{}})},storage:{supported:async()=>true},
    runSbx:async()=>{runs++;return {code:0};}});
  return {backend,home,runs:()=>runs,calls:()=>calls};
}
const bad=(status='failed')=>({id:'old-id',name:'wf-0000000000000000',home:'/fake/home',status,reason:'unsafe_record'});
const job={execution_scope:'owner',required_limits:[]};
for(const status of ['foreign_locked','failed','in_progress'])test(status+' debt blocks only the same physical name or cleanup id',async()=>{
  const row=bad(status),f=fixture({report:{complete:false,rows:[row]}});
  assert.equal((await f.backend.admitJob(job)).ok,true);
  assert.equal(f.backend.deadlineRecoveryHold(),null);
  for(const target of [{sandbox_id:row.name},{name:row.name},{_cleanupId:row.id},{id:row.id},{sandbox_id:row.name,_cleanupId:'fresh-token'}])
    await assert.rejects(f.backend.admitJob({...job,...target}),error=>error.code==='cessation_unverified'&&error.recovery_scope==='target'&&!error.recovery_hold);
  assert.equal((await f.backend.admitJob({...job,sandbox_id:'wf-1111111111111111'})).ok,true);
  assert.equal((await f.backend.admitJob({...job,sandbox_id:row.name,sbx_home:'/another/home'})).ok,true,'name is scoped to its HOME');
  assert.equal(f.runs(),0);
});
test('malformed unnamed debt is visible but cannot invent a target or cessation proof',async()=>{
  const row={id:'unknown-id',status:'failed',reason:'unsafe_record'},f=fixture({report:{complete:false,rows:[row]},proof:{removed:false}});
  assert.equal((await f.backend.admitJob(job)).ok,true);
  await assert.rejects(f.backend.admitJob({...job,_cleanupId:row.id}),error=>error.recovery_scope==='target');
  const status=f.backend.cleanupStatus();assert.deepEqual(status.deadline_recovery.debt,[row]);assert.equal(status.deadline_recovery.complete,false);
  const proof=await f.backend.reconcileOwnedSandboxes();assert.equal(proof.removed,false);assert.equal(proof.admission_allowed,true);assert.deepEqual(proof.cleanup_debt,[row]);
});
test('incomplete rows cannot be upgraded by a contradictory all-owned removal proof',async()=>{
  const row=bad(),f=fixture({report:{complete:false,rows:[row]},proof:{removed:true}});
  const proof=await f.backend.reconcileOwnedSandboxes();
  assert.equal(proof.removed,false);assert.equal(proof.admission_allowed,true);assert.deepEqual(proof.cleanup_debt,[row]);
  assert.ok(!f.backend._ownedStartupProof);
});
// Cleanup isolation rule: unknown failures keep local debt, never a global stop.
test('whole recovery failure keeps local debt without inventing removal',async()=>{
  const f=fixture({report:{complete:false,fatal:'journal_unavailable',rows:[]}});
  assert.equal((await f.backend.admitJob(job)).ok,true);
  assert.equal(f.backend.deadlineRecoveryHold(),null);
  const proof=await f.backend.reconcileOwnedSandboxes();assert.equal(proof.removed,false);assert.equal(proof.admission_allowed,true);
});
test('target debt fences direct and storage create/run even with a fresh token',async()=>{
  const row=bad('foreign_locked'),f=fixture({report:{complete:false,rows:[row]}});
  const handle={sandbox_id:row.name,_cleanupId:'fresh-token',sbx_home:f.home};
  for(const command of ['create','run']) {
    await assert.rejects(f.backend._runJobCommand(handle,[command,'--name',row.name]),error=>error.recovery_scope==='target');
    await assert.rejects(f.backend._runStorageCommand([command,'--name',row.name]),error=>error.recovery_scope==='target');
    await assert.rejects(f.backend._dispatchProtected(handle,undefined,()=>assert.fail('must not launch'),{create:true}),error=>error.recovery_scope==='target');
  }
  assert.equal(f.runs(),0);
});
test('a failed daemon listing holds the pass even when a row adapter would report partial debt',async()=>{
  const report={complete:false,rows:[bad()]},f=fixture({report,recover:async()=>{
    await f.backend._rowRun({sbx_home:f.home},['ls','--json']);return report;
  }});
  f.backend.runSbx=async()=>({code:1,stderr:'the host is not fully awake'});
  // Round-three availability rule: a failed daemon inventory is a service
  // blocker, and cannot be hidden by an otherwise valid partial row report.
  await assert.rejects(f.backend.recoverSandboxDeadlines(),{code:'cessation_unverified'});
  assert.equal(f.backend.deadlineRecoveryHold().error_code,'sbx_daemon_unavailable');
  await assert.rejects(f.backend.admitJob(job),{code:'cessation_unverified'});
});

for(const report of [{rows:[]},{complete:true,rows:[null]},{complete:true,rows:[{id:'x',status:'made_up'}]},
  {complete:true,rows:[bad()]},{complete:true,rows:[{id:'x',status:'protected'}]}])test('malformed recovery report retains local debt: '+JSON.stringify(report),async()=>{
  const f=fixture({report});assert.equal((await f.backend.admitJob(job)).ok,true);
  assert.equal(f.backend.deadlineRecoveryHold(),null);assert.equal(f.backend.deadlineRecoveryDebt()[0].status,'failed');
});
test('whole owned reconciliation failure does not block unrelated admission',async()=>{
  const f=fixture({proof:{removed:false,fatal:'cleanup_check_failed'}});
  const proof=await f.backend.reconcileOwnedSandboxes();assert.equal(proof.admission_allowed,true);assert.equal(proof.removed,false);assert.equal(f.backend.deadlineRecoveryHold(),null);
});


test('actual dispatch cannot evade its current HOME debt by supplying a different HOME',async()=>{
  const row=bad('foreign_locked'),f=fixture({report:{complete:false,rows:[row]}}),handle={sandbox_id:row.name,sbx_home:'/another/home',_cleanupId:'fresh-token'};
  await assert.rejects(f.backend._runJobCommand(handle,['create','--name',row.name]),error=>error.recovery_scope==='target');
  await assert.rejects(f.backend._dispatchProtected(handle,undefined,()=>assert.fail('must not launch'),{create:true}),error=>error.recovery_scope==='target');
  assert.equal(f.runs(),0);
});

test('owned reconciliation debt without a deadline remains target-scoped through a later recovery',async()=>{
  const row={name:'wf-0000000000000000',home:'/fake/home',reason:'old_record'},f=fixture({proof:{removed:false,remediation:[row]}});
  const proof=await f.backend.reconcileOwnedSandboxes();assert.equal(proof.admission_allowed,true);assert.equal(proof.removed,false);
  assert.equal((await f.backend.admitJob(job)).ok,true);
  await assert.rejects(f.backend.admitJob({...job,sandbox_id:row.name}),error=>error.recovery_scope==='target');
  assert.equal(f.backend.cleanupStatus().deadline_recovery.debt.some(item=>item.name===row.name),true);
});
