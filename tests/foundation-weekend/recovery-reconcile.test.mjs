import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as turn} from 'node:timers/promises';
import {createLendingLaunch, createLendingLedger} from '../../lib/v1/lending-launch.mjs';
import {createLaunchBackend} from '../../lib/v1/launch-backend.mjs';

const ok = value => ({ok:true,value});
const deferred = () => { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve}; };
const attempt = {attemptId:'a1',jobId:'j1',generation:1,leaseProof:{schemaVersion:1,signedEnvelope:'synthetic'}};
const selection = {accountId:'acct1',providerId:'synthetic',modelId:'model1',effortId:null};
const amount = {unit:'window_micro_points',byResource:[{id:'weekly',instance:'w1',amount:100}]};
const receipt = {schemaVersion:1,accountId:'acct1',jobId:'j1',attemptId:'a1',policyVersion:'p1',
  quotedLedgerRevision:0,settingsRevision:1,evaluatedAtMs:1000,amount,mode:'observed'};
const enforcement = {amount,wallLimitMs:1000,stopOnBudget:true,metering:'measured',limitations:[]};
const run = {schemaVersion:1,command:'synthetic',args:[],env:{},proxy:{},receipt,enforcement};

test('conservative assumption: absent handle during pending preparation is NOT cessation, including a recreated coordinator', async () => {
  const directory = await mkdtemp(join(tmpdir(),'recovery-launch-'));
  const began = deferred(), prepared = deferred();
  let removed=0, released=0, keys=0;
  const journal={directory}, settings=()=>({revision:1});
  const ledger=createLendingLedger({journal,settings});
  const ports={journal,ledger,settings,clock:()=>1000,
    backend:{prepare:async()=>{began.resolve(); return prepared.promise;},remove:async()=>{removed++;return ok();}},
    broker:{issueJobKey:async()=>{keys++;return ok({keyId:'k1',key:'synthetic'});},revokeJobKey:async()=>({aborted:[],unconfirmed:[]})},
    providers:{getProvider:()=>ok({makeRun:()=>ok(run)})},
    coordinator:{release:async()=>{released++;return ok({kind:'released'});}}};
  let pending;
  try {
    const launch=createLendingLaunch(ports);
    pending=launch.prepareLend({attempt,selection,receipt,enforcement,operationId:'prepare1'});
    await began.promise;
    const resumed=createLendingLaunch(ports); // same durable journal, no copied in-memory handles
    assert.equal((await resumed.stopLend({attemptId:'a1',reason:'cancel'})).ceasedAtMs,null);
    assert.equal((await ledger.snapshot('acct1')).resources[0].reserved,100);
    assert.equal((await resumed.releaseBeforeStart({attemptId:'a1',reason:'paused',operationId:'release1'})).ok,false);
    assert.equal(removed,0); assert.equal(released,0);
    prepared.resolve(ok({sandboxId:'s1'}));
    assert.equal((await pending).ok,false);
    assert.equal(removed,1); assert.equal(released,1); assert.equal(keys,1);
    assert.equal((await ledger.snapshot('acct1')).resources[0].reserved,0);
  } finally {
    prepared.resolve(ok({sandboxId:'s1'}));
    await pending?.catch(()=>{});
    await rm(directory,{recursive:true,force:true});
  }
});

test('lost preparation handle: only exact authoritative registry reconnect permits progress, never recreate', async () => {
  const directory=await mkdtemp(join(tmpdir(),'recovery-backend-'));
  const handle={sandbox_id:'s1',job_id:'j1',_cleanupId:'inc1'};
  let recover=null, creates=0, destroyed=0, status='running';
  const ports={journalDirectory:directory,clock:()=>1000,
    resolveJob:async()=>({job_id:'j1'}),bindRun:async()=>{},recoverHandle:async()=>recover,
    backend:{prepare:async()=>{creates++;throw new Error('created but response lost');},
      start:async()=>{},cancel:async()=>{},
      inspect:async()=>({job_id:'j1',status}),
      destroy:async()=>{destroyed++;return {job_id:'j1',sandbox_id:'s1',removed:true,scratch_removed:true,policy_removed:true,storage_removed:true};}}};
  try {
    assert.equal((await createLaunchBackend(ports).prepare({attempt,selection})).ok,false);
    const resumed=createLaunchBackend(ports);
    assert.equal((await resumed.prepare({attempt,selection})).ok,false);
    recover={...handle,job_id:'other'};
    assert.equal((await resumed.prepare({attempt,selection})).ok,false);
    recover=handle;
    assert.deepEqual(await resumed.prepare({attempt,selection}),ok({sandboxId:'s1'}));
    assert.equal(creates,1);
    assert.equal((await resumed.stop({sandboxId:'s1'})).ceasedAtMs,null);
    status='exited';
    assert.equal((await resumed.stop({sandboxId:'s1'})).ceasedAtMs,1000);
    assert.equal((await resumed.remove({sandboxId:'s1',operationId:'remove1'})).ok,true);
    assert.equal(destroyed,1);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('unsettled durable start stays fenced after recreation; live completion plus inspection permits cessation without replay', async () => {
  const directory=await mkdtemp(join(tmpdir(),'recovery-start-'));
  const handle={sandbox_id:'s1',job_id:'j1',_cleanupId:'inc1'}, done=deferred();
  let starts=0, destroyAttempts=0, removalConfirmed=false;
  const ports={journalDirectory:directory,clock:()=>1000,
    resolveJob:async()=>({job_id:'j1'}),bindRun:async()=>{},recoverHandle:async()=>handle,
    backend:{prepare:async()=>handle,start:()=>{starts++;return done.promise;},cancel:async()=>{},
      inspect:async()=>({job_id:'j1',status:'exited'}),
      destroy:async()=>{
        destroyAttempts++;
        return {job_id:'j1',sandbox_id:'s1',removed:removalConfirmed,scratch_removed:removalConfirmed,
          policy_removed:removalConfirmed,storage_removed:removalConfirmed};
      }}};
  try {
    const initial=createLaunchBackend(ports);
    assert.equal((await initial.prepare({attempt,selection})).ok,true);
    assert.equal((await initial.start({sandboxId:'s1',run,operationId:'start1'})).value.kind,'uncertain');
    const resumed=createLaunchBackend(ports);
    assert.equal((await resumed.start({sandboxId:'s1',run,operationId:'start1'})).value.kind,'uncertain');
    assert.equal(starts,1);
    // The recovered owner tries exact removal, but the backend has not
    // confirmed it. An exited snapshot cannot resolve that outstanding start.
    assert.equal((await resumed.stop({sandboxId:'s1'})).ceasedAtMs,null);
    assert.equal(destroyAttempts,1);
    done.resolve(); await turn();
    assert.equal((await resumed.stop({sandboxId:'s1'})).ceasedAtMs,1000);
    assert.equal(destroyAttempts,1,'settled start uses inspection without another destruction attempt');
    removalConfirmed=true;
    assert.equal((await resumed.remove({sandboxId:'s1',operationId:'remove1'})).ok,true);
    assert.equal(destroyAttempts,2);
    assert.equal(starts,1);
  } finally {done.resolve();await turn();await rm(directory,{recursive:true,force:true});}
});

for(const destruction of ['unconfirmed','throws'])test('late recovered-start callback stays fenced with exact native handles: '+destruction, async () => {
  const directory=await mkdtemp(join(tmpdir(),'recovery-late-start-'));
  const handle=Object.freeze({sandbox_id:'s1',job_id:'j1',_cleanupId:'inc1'});
  const foreign=Object.freeze({sandbox_id:'foreign-sandbox',job_id:'foreign-job',_cleanupId:'foreign-incarnation'});
  const foreignState={running:true,removed:false}, beforeForeign=structuredClone(foreignState);
  const calls={start:[],cancel:[],inspect:[],destroy:[],recover:[]}, done=deferred();
  let observed, status='exited', removalConfirmed=false, settled=false, now=1000;
  const nativeTargets=new Map([[handle,{running:true,removed:false}],[foreign,foreignState]]);
  const ports={journalDirectory:directory,clock:()=>now,
    resolveJob:async()=>({job_id:'j1'}),bindRun:async()=>{},
    recoverHandle:async request=>{calls.recover.push(request);return handle;},
    backend:{
      prepare:async()=>handle,
      start:(h,{onExecutionStarted})=>{
        calls.start.push(h);observed=onExecutionStarted;
        return done.promise.then(()=>{settled=true;});
      },
      cancel:async h=>{calls.cancel.push(h);},
      inspect:async h=>{calls.inspect.push(h);return {job_id:h?.job_id,status};},
      destroy:async h=>{
        calls.destroy.push(h);
        if(!removalConfirmed&&destruction==='throws')throw new Error('synthetic destruction unavailable');
        if(removalConfirmed&&nativeTargets.has(h))nativeTargets.get(h).removed=true;
        // Never synthesize s1/j1 for an incorrect argument.
        return {job_id:h?.job_id,sandbox_id:h?.sandbox_id,removed:removalConfirmed,
          scratch_removed:removalConfirmed,policy_removed:removalConfirmed,storage_removed:removalConfirmed};
      },
    }};
  const exactCalls=()=>{
    for(const name of ['start','cancel','inspect','destroy'])
      for(const h of calls[name])assert.strictEqual(h,handle,name+' must receive the exact native handle');
    assert.deepEqual(foreignState,beforeForeign,'foreign native resource remains untouched');
  };
  try{
    const initial=createLaunchBackend(ports);
    assert.equal((await initial.prepare({attempt,selection})).ok,true);
    assert.equal((await initial.start({sandboxId:'s1',run,operationId:'start1'})).value.kind,'uncertain');
    assert.equal(typeof observed,'function');
    const resumed=createLaunchBackend(ports);
    assert.equal((await resumed.stop({sandboxId:'s1'})).ceasedAtMs,null);
    assert.equal(calls.destroy.length,1);
    assert.deepEqual(calls.recover,[{sandboxId:'s1',attemptId:'a1',jobId:'j1',generation:1,
      accountId:'acct1',providerId:'synthetic',incarnation:'inc1',operationId:'start1'}]);
    exactCalls();
    const cancelsBefore=calls.cancel.length;
    await observed(); // Execution begins after recovered stop, with start still pending.
    assert.equal(settled,false);
    assert.equal(calls.cancel.length,cancelsBefore+1,'late callback must request cancellation');
    exactCalls();
    const replay=await resumed.start({sandboxId:'s1',run,operationId:'start1'});
    assert.equal(replay.ok,true);assert.equal(replay.value.kind,'started');
    assert.equal(calls.start.length,1,'same operation cannot dispatch another native start');
    // Even an exited inspection cannot resolve the still-pending original start.
    assert.equal((await initial.stop({sandboxId:'s1'})).ceasedAtMs,null);
    assert.equal(calls.inspect.length,1);
    assert.equal((await resumed.stop({sandboxId:'s1'})).ceasedAtMs,null);
    assert.equal(calls.destroy.length,2);
    assert.equal(settled,false);
    exactCalls();
    done.resolve();await turn();
    assert.equal(settled,true);
    status='running';
    assert.equal((await resumed.stop({sandboxId:'s1'})).ceasedAtMs,null,'settlement alone is insufficient');
    assert.equal(calls.destroy.length,2,'settled execution no longer needs speculative destruction');
    status='exited';
    assert.equal((await resumed.stop({sandboxId:'s1'})).ceasedAtMs,1000);
    assert.equal(calls.inspect.length,3,'cessation uses authoritative post-settlement inspection');
    assert.equal(calls.cancel.length,cancelsBefore+4);
    exactCalls();
    assert.equal((await resumed.start({sandboxId:'s1',run,operationId:'start1'})).value.kind,'started');
    assert.equal(calls.start.length,1);
    removalConfirmed=true;
    assert.equal((await resumed.remove({sandboxId:'s1',operationId:'remove1'})).ok,true);
    assert.equal(calls.destroy.length,3);
    assert.equal(nativeTargets.get(handle).removed,true);
    exactCalls();
    // Adapter recreation with the original owner still live: removal does not
    // authorize redispatch of the same durable start operation.
    const replayAfterRemoval=await resumed.start({sandboxId:'s1',run,operationId:'start1'});
    assert.deepEqual(replayAfterRemoval,replay,'removed start retains its recorded result');
    assert.equal(calls.start.length,1,'post-removal replay cannot dispatch another native start');
    exactCalls();
    assert.equal((await resumed.remove({sandboxId:'s1',operationId:'remove1'})).ok,true);
    assert.equal(calls.destroy.length,3,'repeated remove must not destroy again');
    assert.equal(nativeTargets.get(handle).removed,true);
    exactCalls(); // Includes the unchanged foreign resource after repeated removal.
    // The original owner can still deliver an observation after confirmed removal.
    // Its contract permits cancellation of the exact old handle, not resurrection.
    const cancelsAtRemoval=calls.cancel.length, inspectionsAtRemoval=calls.inspect.length;
    const removedState=structuredClone(nativeTargets.get(handle));
    now=2000;
    await observed();
    assert.equal(calls.cancel.length,cancelsAtRemoval+1,'stale observation cancels only the old execution');
    assert.equal(settled,true,'observation cannot reopen the settled start');
    assert.deepEqual(nativeTargets.get(handle),removedState);
    exactCalls();
    const afterCallback=createLaunchBackend(ports); // Read persisted state without either adapter cache.
    assert.equal((await afterCallback.stop({sandboxId:'s1'})).ceasedAtMs,1000,'stale callback preserves saved cessation, not the new clock');
    const staleReplay=await afterCallback.start({sandboxId:'s1',run,operationId:'start1'});
    assert.equal(staleReplay.ok,true);
    assert.equal(staleReplay.value.kind,'started');
    assert.equal(calls.start.length,1,'stale callback cannot authorize redispatch after recreation');
    assert.equal((await afterCallback.remove({sandboxId:'s1',operationId:'remove1'})).ok,true);
    assert.equal(calls.destroy.length,3,'stale callback cannot erase durable removal');
    assert.equal(calls.inspect.length,inspectionsAtRemoval,'saved cessation needs no new native inspection');
    assert.equal(calls.cancel.length,cancelsAtRemoval+1,'recreated adapter needs no further cancellation');
    assert.deepEqual(nativeTargets.get(handle),removedState);
    exactCalls();
  }finally{done.resolve();await turn();await rm(directory,{recursive:true,force:true});}
});
