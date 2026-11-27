import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createSandboxCleanupJournal} from '../lib/sandbox-cleanup-journal.mjs';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import {acquireProcessLockSync} from '../lib/v1/lock.mjs';
import {writeCreateReceipt} from './helpers/sandbox-receipt-fixture.mjs';

const NAMES=['wf-0123456789abcdef','wf-fedcba9876543210'];
const HOME='/sbx-home';

async function journalWith(t,{destroy,count=2}) {
  const root=await mkdtemp(join(tmpdir(),'wf-collide-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const scratchRoot=join(root,'scratch'),directory=join(root,'journal');
  await mkdir(scratchRoot,{recursive:true});
  for(const name of NAMES.slice(0,count))
    await writeCreateReceipt(directory,{jobId:'job-'+name,name,ownerScope:sandboxOwnerScope(),home:HOME,scratchRoot});
  return createSandboxCleanupJournal({directory,scratchRoot:()=>scratchRoot,destroy,home:()=>HOME});
}
const removedReceipt={removed:true,scratch_removed:true,policy_removed:true};

test('a startup check that meets a running reaper pass waits for it instead of holding',async t=>{
  let gate,destroying;
  const started=new Promise(r=>{destroying=r;});
  const hold=new Promise(r=>{gate=r;});
  let calls=0;
  const journal=await journalWith(t,{destroy:async()=>{
    // The first destroy is the reaper's: slow, as 7 s of sbx calls per row are.
    if(calls++===0){destroying();await hold;}
    return removedReceipt;
  }});
  const reaping=journal.reap();
  await started;
  const checking=journal.reconcileOwned({inventory:async()=>[]});
  setTimeout(gate,50);
  const proof=await checking;
  await reaping;
  assert.equal(proof.removed,true,'a row the reaper holds for a moment is not an unresolved cleanup');
  assert.equal(proof.remediation,undefined);
});

test('a reaper pass does not start while a startup check is running',async t=>{
  let gate,destroying;
  const started=new Promise(r=>{destroying=r;});
  const hold=new Promise(r=>{gate=r;});
  let active=0,overlap=false;
  const journal=await journalWith(t,{destroy:async()=>{
    active++;if(active>1)overlap=true;
    destroying();await hold;active--;
    return removedReceipt;
  }});
  const checking=journal.reconcileOwned({inventory:async()=>[]});
  await started;
  setTimeout(gate,100);
  await journal.reap();
  await checking;
  assert.equal(overlap,false,'the reaper never destroys while the check holds a row');
});

async function gatedReaper(t) {
  let gate,destroying;
  const started=new Promise(r=>{destroying=r;});
  const hold=new Promise(r=>{gate=r;});
  const journal=await journalWith(t,{count:1,destroy:async()=>{destroying();await hold;return removedReceipt;}});
  const reaping=journal.reap();
  await started;
  // Let the pass finish before the journal directory is removed.
  return {journal,finish:()=>{gate();return reaping;}};
}
const settlesBefore=(promise,ms)=>Promise.race([promise.then(()=>'settled'),new Promise(r=>setTimeout(()=>r('pending'),ms))]);

test('a cancelled cleanup does not wait for a running reaper pass',async t=>{
  const {journal,finish}=await gatedReaper(t);
  const controller=new AbortController();controller.abort();
  const result=journal.resolveJobs(['job-'+NAMES[0]],{signal:controller.signal});
  try {
    assert.equal(await settlesBefore(result,1000),'settled','an already-cancelled caller is answered while the reaper still runs');
    assert.equal((await result).resolved,false);
  } finally {await finish();await result;}
});

test('cancelling a cleanup that waits for the reaper answers it at once',async t=>{
  const {journal,finish}=await gatedReaper(t);
  const controller=new AbortController();
  const result=journal.resolveJobs(['job-'+NAMES[0]],{signal:controller.signal});
  try {
    assert.equal(await settlesBefore(result,50),'pending','it waits for the running pass');
    controller.abort();
    assert.equal(await settlesBefore(result,1000),'settled');
    assert.equal((await result).resolved,false);
  } finally {await finish();await result;}
});

// A slow reaper row that the caller did not select must not use up the caller's time. The reaper's first row is gated,
// whichever row the directory lists first; `other` is the job the reaper has not reached.
async function reaperOnFirstRow(t,{cleanupHold}={}) {
  let gate,destroying,cleaning;
  const started=new Promise(r=>{destroying=r;}),hold=new Promise(r=>{gate=r;});
  const cleanupStarted=new Promise(r=>{cleaning=r;});
  const destroyed=[];
  const journal=await journalWith(t,{destroy:async row=>{
    destroyed.push(row.sandbox_id);
    if(destroyed.length===1){destroying();await hold;}
    else {cleaning();await cleanupHold;}
    return removedReceipt;
  }});
  const reaping=journal.reap();
  await started;
  const other=NAMES.find(name=>name!==destroyed[0]);
  return {journal,destroyed,other,cleanupStarted,finish:()=>{gate();return reaping;}};
}

test('a cleanup for a job with no record does not wait for an unrelated reaper row',async t=>{
  const {journal,finish}=await reaperOnFirstRow(t);
  const result=journal.resolveJobs(['job-without-record']);
  try {
    assert.equal(await settlesBefore(result,1000),'settled','nothing to stop, so the answer comes at once');
    const proof=await result;
    assert.equal(proof.resolved,true);
    assert.equal(proof.rows,0);
  } finally {await finish();await result;}
});

test('a cleanup for another job does not wait for the reaper row',async t=>{
  const {journal,destroyed,other,finish}=await reaperOnFirstRow(t);
  const result=journal.resolveJobs(['job-'+other]);
  try {
    assert.equal(await settlesBefore(result,1000),'settled');
    const proof=await result;
    assert.equal(proof.resolved,true);
    assert.equal(proof.rows,1);
    assert.deepEqual(destroyed,[NAMES.find(name=>name!==other),other],'the cleanup destroyed its own row while the reaper held the other');
  } finally {await finish();await result;}
});

test('a reaper pass stops before its next row while a cleanup runs',async t=>{
  let cleanupGate;
  const cleanupHold=new Promise(r=>{cleanupGate=r;});
  const {journal,destroyed,other,cleanupStarted,finish}=await reaperOnFirstRow(t,{cleanupHold});
  const result=journal.resolveJobs(['job-'+other]);
  let reaping;
  try {
    await settlesBefore(cleanupStarted,1000);
    reaping=finish();
    assert.equal(await settlesBefore(reaping,1000),'settled','the pass ends after its own row');
  } finally {cleanupGate();await reaping;await result;}
  assert.equal((await result).resolved,true);
  assert.deepEqual(destroyed,[NAMES.find(name=>name!==other),other],'the reaper never reached the row the cleanup holds');
});

// A record from before create receipts: the reaper only reports it, under its record lock, while it inspects the listing.
test('a cleanup for a legacy record the reaper is inspecting waits for it and then closes it',async t=>{
  const root=await mkdtemp(join(tmpdir(),'wf-legacy-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const scratchRoot=join(root,'scratch'),directory=join(root,'journal'),id=randomUUID();
  const scratch=join(scratchRoot,'wf-job-'+NAMES[0]+'-'+randomUUID());
  await mkdir(scratch,{recursive:true});await mkdir(directory,{recursive:true});
  await writeFile(join(directory,id+'.json'),JSON.stringify({version:1,_cleanupId:id,job_id:'legacy-job',sandbox_id:NAMES[0],scratch_dir:scratch}));
  let gate,inspecting,calls=0;
  const started=new Promise(r=>{inspecting=r;}),hold=new Promise(r=>{gate=r;});
  const journal=createSandboxCleanupJournal({directory,scratchRoot:()=>scratchRoot,destroy:async()=>removedReceipt,home:()=>HOME,
    inspectLegacy:async()=>{if(calls++===0){inspecting();await hold;}return {names:[],home:HOME,command:name=>'sbx rm '+name};}});
  const reaping=journal.reap();
  await started;
  const result=journal.resolveJobs(['legacy-job']);
  try {
    assert.equal(await settlesBefore(result,50),'pending','the reaper holds the record lock while it inspects');
  } finally {gate();await reaping;}
  const proof=await result;
  assert.equal(proof.resolved,true,'once the reaper lets go, the absent legacy record closes');
  assert.equal(existsSync(join(directory,id+'.json')),false);
});

test('a row whose sandbox is still listed keeps the hold',async t=>{
  const journal=await journalWith(t,{destroy:async()=>({removed:false}),count:1});
  const proof=await journal.reconcileOwned({inventory:async()=>[NAMES[0]]});
  assert.equal(proof.removed,false);
  assert.equal(proof.remediation[0].reason,'cleanup_incomplete');
});

// The hold names the sandbox and a fixed reason, so a log line says what stayed.
const heldFor=(t,{destroy=async()=>removedReceipt})=>journalWith(t,{destroy,count:1});
test('a record whose home does not match is held with a named reason',async t=>{
  const journal=await heldFor(t,{});
  const proof=await journal.reconcileOwned({inventory:async()=>[],validateRow:()=>false});
  assert.equal(proof.removed,false);
  assert.deepEqual(proof.remediation,[{reason:'cleanup_incomplete',name:NAMES[0],failure:'home_mismatch'}]);
});

test('a record whose destroy throws is held with a named reason',async t=>{
  const journal=await heldFor(t,{destroy:async()=>{throw new Error('boom');}});
  const proof=await journal.reconcileOwned({inventory:async()=>[]});
  assert.deepEqual(proof.remediation,[{reason:'cleanup_incomplete',name:NAMES[0],failure:'destroy_failed'}]);
});

test('a record whose storage release fails is held with a named reason',async t=>{
  const journal=await heldFor(t,{destroy:async()=>{throw Object.assign(new Error('disk'),{cleanup_failure:'storage_release_failed'});}});
  const proof=await journal.reconcileOwned({inventory:async()=>[]});
  assert.deepEqual(proof.remediation,[{reason:'cleanup_incomplete',name:NAMES[0],failure:'storage_release_failed'}]);
});

test('a record another process locks is held as busy',async t=>{
  const root=await mkdtemp(join(tmpdir(),'wf-busy-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const scratchRoot=join(root,'scratch'),directory=join(root,'journal');
  await mkdir(scratchRoot,{recursive:true});
  const id=await writeCreateReceipt(directory,{jobId:'job-1',name:NAMES[0],ownerScope:sandboxOwnerScope(),home:HOME,scratchRoot});
  const journal=createSandboxCleanupJournal({directory,scratchRoot:()=>scratchRoot,destroy:async()=>removedReceipt,home:()=>HOME});
  const release=acquireProcessLockSync(join(directory,id+'.json.lock'));
  let proof;
  try{proof=await journal.reconcileOwned({inventory:async()=>[]});}finally{release();}
  assert.deepEqual(proof.remediation,[{reason:'cleanup_incomplete',name:NAMES[0],failure:'busy'}]);
});
