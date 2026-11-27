import './helpers/no-browser.mjs';
import {testSbxRuntimeFields} from './helpers/sandbox-receipt-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DockerSbxBackend} from '../lib/docker-backend.mjs';
import {createSandboxScratch, deadScratchOwners} from '../lib/sandbox-scratch.mjs';

// These concurrency cases exercise installed receipts with an inline runtime.
async function legacyScratch(id,home,journal){
  const runtime=testSbxRuntimeFields().sbx_runtime;
  const scratch=await createSandboxScratch(id,home,journal,{home,runtime});
  const file=join(journal,id+'.json');
  const record=JSON.parse(await readFile(file,'utf8'));
  await writeFile(file,JSON.stringify({...record,sbx_runtime:runtime}));
  return scratch;
}

test('a live PID, including conservative PID reuse, protects an unlisted slow start', async t=>{
  const home=await mkdtemp(join(tmpdir(),'review-r3-live-owner-'));
  const previousHome=process.env.FARAVAN_SBX_HOME,previousRoot=process.env.FARAVAN_SCRATCH_ROOT;
  process.env.FARAVAN_SBX_HOME=home;process.env.FARAVAN_SCRATCH_ROOT=home;
  t.after(()=>{if(previousHome===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=previousHome;if(previousRoot===undefined)delete process.env.FARAVAN_SCRATCH_ROOT;else process.env.FARAVAN_SCRATCH_ROOT=previousRoot;});
  const journal=join(home,'scratch-journal'),id='wf-1111111111111111';
  const scratch=await legacyScratch(id,home,journal);
  const removed=[],released=[];
  const backend=new DockerSbxBackend({runCommand:async args=>{if(args[0]==='rm')removed.push(args.at(-1));return {code:0,stdout:'[]'};},storage:{release:async id=>released.push(id)}});
  assert.deepEqual(await deadScratchOwners(journal,home),[]);
  await backend.reconcileOrphanedScratch();
  assert.equal((await stat(scratch)).isDirectory(),true);
  assert.deepEqual(removed,[]);assert.deepEqual(released,[]);
});

test('a stale concurrent sweep must preserve a replacement live generation', async t=>{
  const home=await mkdtemp(join(tmpdir(),'review-r3-orphan-race-'));
  const previousHome=process.env.FARAVAN_SBX_HOME,previousRoot=process.env.FARAVAN_SCRATCH_ROOT;
  process.env.FARAVAN_SBX_HOME=home;process.env.FARAVAN_SCRATCH_ROOT=home;
  t.after(()=>{if(previousHome===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=previousHome;if(previousRoot===undefined)delete process.env.FARAVAN_SCRATCH_ROOT;else process.env.FARAVAN_SCRATCH_ROOT=previousRoot;});
  const journal=join(home,'scratch-journal'),id='wf-2222222222222222';
  await legacyScratch(id,home,journal);
  const recordFile=join(journal,id+'.json');
  const record=JSON.parse(await readFile(recordFile,'utf8'));
  await writeFile(recordFile,JSON.stringify({...record,ownerPid:1073741824}));
  // A sweep recovers only scratch whose sandbox is absent from a verified listing; it never removes compute.
  let exists=false,reserved=true;
  let arrived,proceed;
  const atInventory=new Promise(resolve=>{arrived=resolve;});
  const barrier=new Promise(resolve=>{proceed=resolve;});
  let first=true;
  const storage={release:async()=>{reserved=false;}};
  const runner=async args=>{
    if(args[0]==='ls')return {code:0,stdout:JSON.stringify(exists?[{name:id,status:'running'}]:[])};
    throw new Error('unexpected command');
  };
  const a=new DockerSbxBackend({storage,runCommand:async(args,options)=>{if(args[0]==='ls'&&first){first=false;arrived();await barrier;}return runner(args,options);}});
  const b=new DockerSbxBackend({storage,runCommand:runner});
  const sweep=a.reconcileOrphanedScratch();
  await atInventory;
  await b.reconcileOrphanedScratch();
  const replacement=await legacyScratch(id,home,journal);
  exists=true;reserved=true;
  assert.deepEqual(await deadScratchOwners(journal,home),[],'replacement creator is live');
  proceed();await sweep;
  const scratchExists=await stat(replacement).then(()=>true,()=>false);
  t.diagnostic(JSON.stringify({liveVmExists:exists,liveReservationExists:reserved,liveScratchExists:scratchExists}));
  assert.equal(exists,true,'stale sweep removed the live replacement VM');
  assert.equal(reserved,true,'stale sweep refunded the replacement reservation');
  assert.equal(scratchExists,true,'stale sweep deleted the live replacement scratch');
});

test('replacement preparation waits while a sweep removes the old generation', async t=>{
  const home=await mkdtemp(join(tmpdir(),'review-r4-orphan-lock-'));
  const previousHome=process.env.FARAVAN_SBX_HOME,previousRoot=process.env.FARAVAN_SCRATCH_ROOT;
  process.env.FARAVAN_SBX_HOME=home;process.env.FARAVAN_SCRATCH_ROOT=home;
  t.after(()=>{if(previousHome===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=previousHome;if(previousRoot===undefined)delete process.env.FARAVAN_SCRATCH_ROOT;else process.env.FARAVAN_SCRATCH_ROOT=previousRoot;});
  const journal=join(home,'scratch-journal'),id='wf-3333333333333333';
  await legacyScratch(id,home,journal);
  const file=join(journal,id+'.json'),record=JSON.parse(await readFile(file,'utf8'));
  await writeFile(file,JSON.stringify({...record,ownerPid:1073741824}));
  let arrived,proceed;
  const atRelease=new Promise(resolve=>{arrived=resolve;});
  const barrier=new Promise(resolve=>{proceed=resolve;});
  t.after(()=>proceed());
  // The old generation's scratch is gone once its reservation is released; the identity lock spans both.
  const storage={release:async()=>{arrived();await barrier;}};
  const runner=async args=>{
    if(args[0]==='ls') return {code:0,stdout:'[]'};
    throw new Error('unexpected command');
  };
  const a=new DockerSbxBackend({storage,runCommand:runner});
  const b=new DockerSbxBackend({storage:{release:async()=>{}},runCommand:runner});
  const first=a.reconcileOrphanedScratch();
  await atRelease;
  const second=b.reconcileOrphanedScratch();
  const replacement=legacyScratch(id,home,journal);
  const createdEarly=await Promise.race([replacement.then(()=>true,()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),100))]);
  assert.equal(createdEarly,false,'replacement must wait until old removal and release complete');
  proceed();
  await first; await second;
  const scratch=await replacement;
  assert.ok((await stat(scratch)).isDirectory());
});
