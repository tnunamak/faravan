import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AsyncLocalStorage} from 'node:async_hooks';
import * as sbxRuntimeModule from '../lib/sbx-runtime.mjs';
import * as commandDiagnostics from '../lib/sandbox-command-diagnostic.mjs';
import {sandboxCommandDiagnostic} from '../lib/sandbox-command-observation.mjs';
import {deadlineRecoveryHold as recoveryHoldFor, deadlineRecoveryError, sandboxServiceUnavailableHold} from '../lib/sandbox-remediation.mjs';

// Hermetic exact-source method slices, NOT a full backend import/integration
// test. The full graph imports a file outside this assignment's read scope.
// These tests never start sbx, Docker, services, network, providers or a model.
const source=readFileSync(new URL('../lib/docker-backend.mjs',import.meta.url),'utf8');
const slice=(start,end)=>{
  const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a,`exact method boundary exists: ${start}`);
  return source.slice(a,b);
};
const methods=[
  slice('  async _rowRun(row,args,options={}) {','  sandboxOwnership()'),
  slice('  _noteCleanupListingFailure(', '  // Availability is not an absence proof.'),
  slice('  deadlineRecoveryHold() {','  async inspectCleanupRemediation'),
  slice('  _invalidateOwnedStartupRecovery() {','  isOwnedSandboxProofCurrent('),
  slice('  async admitJob(job,','  async prepareSignIn('),
  slice('  async prepare(validatedJob, deadlineOrOptions = null, options = {}) {','  async _prepare('),
  slice('  async _dispatchProtected(handle, signal, launch,','  /** Rules that apply to this sandbox'),
].join('\n');
const defer=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const policyError=(code,message)=>Object.assign(new Error(message),{code});
const parseSbxListing=result=>{
  if(result?.code!==0)return null;
  try{const rows=JSON.parse(result.stdout);return Array.isArray(rows)?rows.map(row=>row.name):null;}catch{return null;}
};
function fixture({recover=async()=>true,status=()=>({compute_cleanup_pending:44}),run=async()=>({code:0,stdout:'[]'}),platformName='darwin'}={}){
  let home='/fake/current-home',recoverCalls=0,dispatches=0;
  const daemonJobContext=new AsyncLocalStorage(),deadlineRecoveryContext=new AsyncLocalStorage();
  const {cleanupSbxRuntime,withSbxRuntime,assertSbxRuntime,hostDefaultSbxRuntime,restoreSbxRuntime,createSbxRuntime,currentSbxRuntime}=sbxRuntimeModule;
  const parameters={...commandDiagnostics,sandboxCommandDiagnostic,cleanupSbxRuntime,withSbxRuntime,assertSbxRuntime,hostDefaultSbxRuntime,restoreSbxRuntime,createSbxRuntime,currentSbxRuntime,daemonJobContext,deadlineRecoveryContext,recoveryHoldFor,deadlineRecoveryError,sandboxServiceUnavailableHold,completeSbxListing:r=>r?.code===0,
    sbxHome:()=>home,sbxChildEnv:()=>({}),credentialStoreEnv:()=>({}),parseSbxListing,policyError,
    borrowedCredentialMechanismAllowed:()=>true,admitDockerJob:()=>({ok:true}),signInJobs:new WeakSet(),preparationObservations:new WeakMap(),preparationId:value=>typeof value==="string"&&value.length>0,preparationView:value=>value,
    sandboxDeadlineReservation:()=>({deadline_at:999999,deadline_clock:{}}),sandboxDeadlineRemaining:()=>60000,PREFLIGHT_COMMAND_TIMEOUT_MS:1000,
    runSbxStreaming:async()=>{dispatches++;return {code:0};},
  };
  const Backend=new Function(...Object.keys(parameters),`return class Backend {${methods}}`)(...Object.values(parameters));
  const backend=new Backend();
  Object.assign(backend,{
    _legacyDaemonOptions:{platformName},_deadlineRecovery:null,_deadlineRecoveryHold:null,
    _deadlineRecoveryHome:undefined,_diskSentries:new Map(),_ownedStartupGeneration:0,_preparing:0,
    sandboxDeadlines:{activeSync:()=>true},deadlineClock:()=>({}),monotonic:()=>0,storage:{available:async()=>true},
    _rowHomeMatches:row=>row.sbx_home===home,assertActive:async()=>{},_cleanupRuntime:()=>createSbxRuntime({path:'/fake/sbx',fence(){}}),
    // This seam isolates recovery policy; availability has its own real-backend tests.
    _cleanupListingReady:async()=>{},_now:()=>0,_cleanupListingRetryMs:15000,
    _cleanupListingSleep:async()=>{},_cleanupListingTimeoutMs:1000,
    _prepare:async()=>{dispatches++;return {};},
    runSbx:async(...args)=>{dispatches++;return run(...args);},
    cleanupJournal:{authority:()=>({deadline_enforcer:{}}),admissionAuthority:()=>({deadline_enforcer:{}}),recoverDeadlines:async(...args)=>{recoverCalls++;return recover(...args);},status},
  });
  return {backend,setHome:value=>{home=value;},recoverCalls:()=>recoverCalls,dispatches:()=>dispatches};
}
const job=()=>({execution_scope:'owner',resources:{wall_seconds:60},required_limits:[]});

test('successful recovery coalesces concurrent requests but rechecks later admission',async()=>{
  const wait=defer(),f=fixture({recover:()=>wait.promise});
  const first=f.backend.recoverSandboxDeadlines(),second=f.backend.recoverSandboxDeadlines();
  assert.equal(first,second);wait.resolve(true);assert.equal(await first,true);
  assert.equal(f.backend.deadlineRecoveryHold(),null);
  await f.backend.recoverSandboxDeadlines();assert.equal(f.recoverCalls(),2);
});

test('row-local debt never becomes a global hold for unrelated admission',async()=>{
  const report={complete:false,rows:[{id:'00000000-0000-4000-8000-000000000001',name:'wf-0000000000000001',home:'/fake/current-home',status:'foreign_locked'}]};
  const f=fixture({recover:async()=>report});
  assert.deepEqual(await f.backend.recoverSandboxDeadlines(),report);
  assert.equal(f.backend.deadlineRecoveryHold(),null);
  assert.deepEqual(await f.backend.admitJob(job()),{ok:true});
  assert.equal(f.backend.deadlineRecoveryHold(),null);
  assert.equal(f.recoverCalls(),2);
});

// Cleanup isolation rule: unknown failures are local; service/owner failures remain global.
test('false or malformed recovery retains local debt and never invents cessation',async()=>{
  for(const result of [false,null,undefined,{},'yes',1]){
    const f=fixture({recover:()=>result});
    const report=await f.backend.recoverSandboxDeadlines();
    assert.equal(report.complete,false);assert.equal(report.rows[0].status,'failed');assert.equal(f.backend.deadlineRecoveryHold(),null);
  }
});

test('unproven daemon ownership preserves its internal cause and survives unreadable status',async()=>{
  const original=Object.assign(Error('/private/token-secret'),{code:'daemon_owner_repair_required'});
  const f=fixture({recover:()=>{throw original;},status:()=>{throw Error('/private/journal');}});
  await assert.rejects(f.backend.recoverSandboxDeadlines(),error=>{
    assert.equal(error.cause,original);assert.equal(error.recovery_hold.row_count,null);
    assert.equal(error.recovery_hold.error_code,'daemon_owner_repair_required');assert.equal(JSON.stringify(error).includes('/private'),false);return true;
  });
  assert.ok(f.backend.deadlineRecoveryHold());
});

test('abort preserves its original rejection and existing daemon ownership hold',async()=>{
  const aborted=new AbortController();const original=Object.assign(Error('private cancellation'),{code:'ABORT_ERR'});aborted.abort(original);
  const f=fixture({recover:(_manager,{signal})=>{signal.throwIfAborted();},status:()=>({compute_cleanup_pending:'44'})});
  f.backend._deadlineRecoveryHold=recoveryHoldFor({code:'daemon_owner_repair_required'},{rowCount:44});
  const hold=f.backend.deadlineRecoveryHold();
  await assert.rejects(f.backend.recoverSandboxDeadlines({signal:aborted.signal}),error=>error===original);
  assert.equal(f.backend.deadlineRecoveryHold(),hold);
});

test('failed listing aborts cleanup with an honest service-unavailable hold',async()=>{
  const f=fixture({run:async()=>({code:1,stdout:'',stderr:'/private/home: the host is not fully awake: secret'})});
  f.backend.cleanupJournal.recoverDeadlines=async()=>{
    await f.backend._rowRun({sbx_home:'/fake/current-home'},['ls','--json']);
    return false;
  };
  await assert.rejects(f.backend.recoverSandboxDeadlines(),error=>{
    // The written availability rule requires a sandbox-service blocker for failed inventory.
    assert.equal(error.recovery_hold.error_code,'sbx_daemon_unavailable');
    assert.match(error.message,/sandbox service is unavailable/);
    assert.match(error.fix.human,/Open Setup/);
    assert.equal(JSON.stringify(error).includes('/private'),false);return true;
  });
});

test('a thrown listing error retains its cause even if journal returns false',async()=>{
  const original=Object.assign(Error('the host is not fully awake /private'),{code:'SECRET_TOKEN'});
  const f=fixture({run:async()=>{throw original;},platformName:'linux'});
  f.backend.cleanupJournal.recoverDeadlines=async()=>{
    await f.backend._rowRun({sbx_home:'/fake/current-home'},['ls','--json']).catch(()=>{});
    return false;
  };
  await assert.rejects(f.backend.recoverSandboxDeadlines(),error=>{
    assert.equal(error.cause,original);assert.equal(error.recovery_hold.error_code,'sbx_daemon_unavailable');
    assert.match(error.message,/sandbox service is unavailable/);return true;
  });
});

test('even a swallowed failed listing followed by true cannot reopen admission',async()=>{
  const f=fixture({run:async()=>({code:1,stdout:'',stderr:'the host is not fully awake'})});
  f.backend.cleanupJournal.recoverDeadlines=async()=>{
    await f.backend._rowRun({sbx_home:'/fake/current-home'},['ls','--json']);return true;
  };
  await assert.rejects(f.backend.recoverSandboxDeadlines(),{code:'cessation_unverified'});
});

test('home changes and startup invalidation do not clear an existing hold',async()=>{
  let ready=false;const f=fixture({recover:()=>{if(!ready)throw {code:'daemon_owner_repair_required'};return true;}});
  await assert.rejects(f.backend.recoverSandboxDeadlines());const hold=f.backend.deadlineRecoveryHold();
  f.backend._invalidateOwnedStartupRecovery();assert.equal(f.backend.deadlineRecoveryHold(),hold);
  f.setHome('/fake/new-home');await assert.rejects(f.backend.recoverSandboxDeadlines());assert.ok(f.backend.deadlineRecoveryHold());
  ready=true;await f.backend.recoverSandboxDeadlines();assert.equal(f.backend.deadlineRecoveryHold(),null);
  f.backend._invalidateOwnedStartupRecovery();await f.backend.recoverSandboxDeadlines();assert.equal(f.recoverCalls(),4);
});

test('an older successful flight cannot erase a newer failure hold',async()=>{
  const old=defer();let first=true;const f=fixture({recover:()=>{if(first){first=false;return old.promise;}throw {code:'daemon_owner_repair_required'};}});
  const stale=f.backend.recoverSandboxDeadlines();await Promise.resolve();
  f.backend._invalidateOwnedStartupRecovery();await assert.rejects(f.backend.recoverSandboxDeadlines());
  const hold=f.backend.deadlineRecoveryHold();old.resolve(true);await assert.rejects(stale,{code:'cessation_unverified'});
  assert.equal(f.backend.deadlineRecoveryHold(),hold);
});

test('admit, prepare, direct create/run and auxiliary storage create/run refuse dispatch while held',async()=>{
  const f=fixture({recover:async()=>{throw {code:'daemon_owner_repair_required'};}}),handle={sandbox_id:'wf-fake',_sbxRuntime:sbxRuntimeModule.createSbxRuntime({path:'/fake/sbx',fence(){}})};
  const actions=[()=>f.backend.admitJob(job()),()=>f.backend.prepare(job()),
    ...['create','run'].flatMap(command=>[
      ()=>f.backend._runJobCommand(handle,[command,'--name','wf-fake']),
      ()=>f.backend._runJobCommand(handle,[command,'--name','wf-fake'],()=>{}),
      ()=>f.backend._runStorageCommand([command,'--name','wf-fake']),
    ])];
  for(const action of actions)await assert.rejects(action(),{code:'cessation_unverified'});
  assert.equal(f.dispatches(),0);
});

test('recovery inventory/removal and storage inspections remain usable without recursive gating',async()=>{
  const f=fixture({recover:async()=>{throw {code:'daemon_owner_repair_required'};}});await assert.rejects(f.backend.recoverSandboxDeadlines());
  const calls=f.recoverCalls();
  await f.backend._rowRun({sbx_home:'/fake/current-home'},['ls','--json']);
  await f.backend._rowRun({sbx_home:'/fake/current-home'},['rm','--force','wf-fake']);
  await f.backend._runStorageCommand(['version']);
  await f.backend._runStorageCommand(['exec','wf-fake','--','lsblk']);
  assert.equal(f.recoverCalls(),calls);assert.equal(f.dispatches(),4);assert.ok(f.backend.deadlineRecoveryHold());
});


test('invalidated recovery joins the current flight before allowing waiting admission',async()=>{
  const old=defer(),current=defer();let first=true;
  const f=fixture({recover:()=>{if(first){first=false;return old.promise;}return current.promise;}});
  let admitted=false;const admission=f.backend.admitJob(job()).then(result=>{admitted=true;return result;});
  await Promise.resolve();f.backend._invalidateOwnedStartupRecovery();
  const next=f.backend.recoverSandboxDeadlines();old.resolve(true);await Promise.resolve();await Promise.resolve();
  assert.equal(admitted,false);current.reject({code:'daemon_owner_repair_required'});
  await assert.rejects(next,{code:'cessation_unverified'});await assert.rejects(admission,{code:'cessation_unverified'});
  assert.equal(admitted,false);assert.equal(f.dispatches(),0);
});

test('invalidated success retries when no replacement recovery has begun',async()=>{
  const old=defer();let first=true;
  const f=fixture({recover:()=>{if(first){first=false;return old.promise;}throw {code:'daemon_owner_repair_required'};}});
  const original=f.backend.recoverSandboxDeadlines();await Promise.resolve();f.backend._invalidateOwnedStartupRecovery();old.resolve(true);
  await assert.rejects(original,{code:'cessation_unverified'});assert.equal(f.recoverCalls(),2);
});


test('create admission rechecks after the initial protection wait before onDispatch',async()=>{
  let ready=true;const f=fixture({recover:()=>{if(!ready)throw {code:'daemon_owner_repair_required'};return true;}}),protection=defer(),entered=defer();
  await f.backend.recoverSandboxDeadlines();
  f.backend.assertActive=async()=>{entered.resolve();await protection.promise;};
  let dispatchMarked=false;
  const command=f.backend._runJobCommand({sandbox_id:'wf-fake',_sbxRuntime:sbxRuntimeModule.createSbxRuntime({path:'/fake/sbx',fence(){}})},['create','--name','wf-fake'],undefined,{onDispatch:()=>{dispatchMarked=true;}});
  await entered.promise;f.backend._invalidateOwnedStartupRecovery();ready=false;protection.resolve();
  await assert.rejects(command,{code:'cessation_unverified'});assert.equal(dispatchMarked,false);assert.equal(f.dispatches(),0);
});

test('actual create transport rechecks after daemon/protection wait but exec stays ungated',async()=>{
  let ready=true;const f=fixture({recover:()=>{if(!ready)throw {code:'daemon_owner_repair_required'};return true;}}),protection=defer(),entered=defer();
  await f.backend.recoverSandboxDeadlines();
  f.backend.assertActive=async()=>{entered.resolve();await protection.promise;};
  let launched=0;
  const command=f.backend._dispatchProtected({sandbox_id:'wf-fake'},undefined,()=>{launched++;},{create:true});
  await entered.promise;f.backend._invalidateOwnedStartupRecovery();ready=false;protection.resolve();
  await assert.rejects(command,{code:'cessation_unverified'});assert.equal(launched,0);
  await f.backend._dispatchProtected({sandbox_id:'wf-fake'},undefined,()=>{launched++;});assert.equal(launched,1);
});

test('raw sbx wrapper preserves a typed recovery refusal from the final transport gate',async()=>{
  const original=deadlineRecoveryError(recoveryHoldFor(false,{rowCount:44}));
  const raw=slice('async function runSbx(args, { input, beforeSpawn, binary, sbxRuntime, ...options } = {}) {','// Daemon preparation may wait.');
  const values={...commandDiagnostics,sandboxCommandDiagnostic,daemonJobContext:new AsyncLocalStorage(),dispatchSbx:async()=>{throw original;},launchRuntime:()=>null,withSbxRuntime:(_runtime,work)=>work()};
  const run=new Function(...Object.keys(values),`${raw};return runSbx;`)(...Object.values(values));
  await assert.rejects(run(['create','--name','wf-fake']),error=>error===original);
});


test('daemon owner inventory refusal keeps a safe service-unavailable diagnostic',async()=>{
  const f=fixture({run:async()=>({code:1,errorCode:'SBX_DAEMON_UNVERIFIED',status:'daemon_owner_repair_required',stderr:'/private/daemon'})});
  f.backend.cleanupJournal.recoverDeadlines=async()=>{await f.backend._rowRun({sbx_home:'/fake/current-home'},['ls','--json']);return false;};
  await assert.rejects(f.backend.recoverSandboxDeadlines(),error=>error.recovery_hold.error_code==='sbx_daemon_unavailable');
});
