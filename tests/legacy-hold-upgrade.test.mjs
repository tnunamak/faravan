import './helpers/no-browser.mjs';
import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {DockerSbxBackend,_internal} from '../lib/docker-backend.mjs';
import {seedSandboxOwner} from './helpers/sandbox-owner.mjs';
import {hostDefaultSbxRuntime,describeSbxRuntime} from '../lib/sbx-runtime.mjs';
import {legacySandboxNameFor,sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import {createLender} from '../lib/v1/lender.mjs';
import {lenderFixture,until} from './helpers/v1-lender-fixture.mjs';

// Legacy ownership and names still need their historical HOME checks. An old row that records no runtime
// names no account, so its inventory runs on the host default runtime for the current HOME; a lender with one
// account must be able to clear its own older record after an upgrade.
let root,oldHome,oldScratch;
beforeEach(async()=>{root=await mkdtemp('/tmp/lh-');oldHome=process.env.FARAVAN_HOME;oldScratch=process.env.FARAVAN_SCRATCH_ROOT;
  process.env.FARAVAN_HOME=root;process.env.FARAVAN_SCRATCH_ROOT=join(root,'scratch');seedSandboxOwner();});
afterEach(async()=>{if(oldHome===undefined)delete process.env.FARAVAN_HOME;else process.env.FARAVAN_HOME=oldHome;
  if(oldScratch===undefined)delete process.env.FARAVAN_SCRATCH_ROOT;else process.env.FARAVAN_SCRATCH_ROOT=oldScratch;await rm(root,{recursive:true,force:true});});

async function fixture({listing=[],ls,references=[],complete=true,pendingHome,migration=null,onScan,runtimeBound=true}={}) {
  const jobId='legacy-job',name=legacySandboxNameFor(jobId),directory=join(root,'v1'),journal=join(directory,'sandbox-cleanup');
  const scratch=join(root,'scratch','wf-job-'+name+'-'+randomUUID().slice(0,6));
  await mkdir(scratch,{recursive:true});await mkdir(journal,{recursive:true});
  const id=randomUUID();
  const binding=runtimeBound?{sbx_runtime:describeSbxRuntime(hostDefaultSbxRuntime({binary:process.env.FARAVAN_SBX_BIN??process.execPath,env:{...process.env,HOME:_internal.sbxHome()},profileHome:root,ownerScope:sandboxOwnerScope()}))}:{};
  await writeFile(join(journal,id+'.json'),JSON.stringify({...binding,version:1,_cleanupId:id,job_id:jobId,sandbox_id:name,scratch_dir:scratch,
    compute_stopped:false,data_cleanup:'owned',policy_cleanup:'owned',...(pendingHome?{sbx_home:pendingHome}:{})}));
  const calls=[];
  const backend=new DockerSbxBackend({home:root,cleanupDirectory:journal,storage:{release:async()=>{}},
    runCommand:async args=>{calls.push(args);
      if(args[0]==='daemon')return {code:0,stdout:'Status: running',stderr:''};
      if(args[0]==='ls')return ls?ls():{code:0,stdout:JSON.stringify(listing.map(n=>({name:n}))),stderr:''};
      return {code:0,stdout:'',stderr:''};},
    legacyDaemonOptions:{platformName:'linux',selectHome:()=>({home:_internal.sbxHome(),migration}),
      inspectDaemons:async({home:h})=>[{pid:123,environ:{HOME:h}}],isProcessAlive:()=>true,
      inspectProcesses:async()=>{onScan?.();return {complete,references};}}});
  const pending={...binding,attemptId:'att-1',attempt:{attempt_id:'att-1'},jobId,reservedMs:60000,executionStartRequested:false,sandboxId:name,scratchDir:scratch,...(pendingHome?{sbx_home:pendingHome}:{})};
  return {backend,calls,pending,directory,journal,scratch,name,jobId};
}
const files=async journal=>(await readdir(journal)).filter(n=>n.endsWith('.json'));

test('a verified-absent legacy sandbox resolves the old record, the pending attempt and the hold',async()=>{
  const f=await fixture();
  const proof=await f.backend.reconcilePending(structuredClone(f.pending),{sourceDirectory:f.directory});
  assert.equal(proof.removed,true,JSON.stringify(proof));
  assert.equal(proof.attemptId,'att-1');
  assert.deepEqual(await files(f.journal),[],'the old cleanup record is resolved');
  await assert.rejects(stat(f.scratch),{code:'ENOENT'});
  assert.equal((await f.backend.reconcileOwnedSandboxes()).removed,true,'lending is no longer blocked');
  assert.equal(f.backend.cleanupStatus().state,'clear');
  assert.deepEqual(f.calls.filter(a=>a[0]==='rm'||a[0]==='stop'),[],'nothing was removed or stopped');
});

test('the startup barrier clears an old record whose sandbox is verified absent',async()=>{
  const f=await fixture();
  assert.equal((await f.backend.reconcileOwnedSandboxes()).removed,true);
  assert.deepEqual(await files(f.journal),[]);
});

test('owner release-hold accepts an ownerless pending attempt once the sandbox is verified absent',async()=>{
  const f=await fixture();
  const proof=await f.backend.proveHoldAbsent({attemptId:'att-1',jobId:f.jobId,pending:f.pending});
  assert.deepEqual(proof,{absent:true,attemptId:'att-1'});
});

for(const [cause,options,reason] of [
  ['listing unavailable',{ls:()=>({code:1,stdout:'',stderr:'unrecognised failure'})},'sandbox_inventory_failed'],
  ['listing unreadable',{ls:()=>({code:0,stdout:'not json',stderr:''})},'sandbox_inventory_failed'],
  ['sandbox present',{listing:['@name']},'sandbox_present'],
  ['HOME mismatch',{pendingHome:'/some/other/home'},'sandbox_home_unverified'],
  ['HOME migration pending',{migration:'using_legacy_home'},'sandbox_home_unverified'],
  ['process alive',{references:['pid 42 mentions the job']},'process_evidence_unverified'],
  ['process scan incomplete',{complete:false},'process_evidence_unverified'],
])test('legacy hold stays refused: '+cause,async()=>{
  const f=await fixture({...options,listing:options.listing?.map(()=>legacySandboxNameFor('legacy-job'))});
  const proof=await f.backend.reconcilePending(structuredClone(f.pending),{sourceDirectory:f.directory});
  assert.equal(proof.removed,false);assert.equal(proof.code,'cessation_unverified');
  assert.equal((await files(f.journal)).length,1,'the old record is kept');
  assert.equal((await f.backend.reconcileOwnedSandboxes()).removed,false);
  assert.equal((await files(f.journal)).length,1);
  const hold=await f.backend.proveHoldAbsent({attemptId:'att-1',jobId:f.jobId,pending:f.pending});
  assert.equal(hold.absent,false);
  assert.equal(hold.reason,reason);
  await stat(f.scratch);
  assert.deepEqual(f.calls.filter(a=>a[0]==='rm'||a[0]==='stop'),[],'nothing was removed or stopped');
});

// The lender, not the backend alone, decides whether a proof closes the attempt.
for(const [cause,options,closes] of [['absent',{},true],['sandbox present',{listing:['@name']},false],['listing unavailable',{ls:()=>({code:1,stdout:'',stderr:'x'})},false]])
test('lender recovery of an old pending attempt through the real backend: '+cause,async t=>{
  const f=await fixture({...options,listing:options.listing?.map(()=>legacySandboxNameFor('legacy-job'))});
  const lf=await lenderFixture(t),attempt=lf.attempt();
  lf.policy.enabled=false;lf.policy.recoveryOnly=true;lf.policy.lendingRuntime={reconcileAttempt:async()=>{}};
  lf.policy.storage.directory=f.directory;
  const real=f.backend;
  lf.backend.reconcilePending=(row,o)=>real.reconcilePending(row,o);
  lf.backend.isSandboxHomeCurrent=home=>real.isSandboxHomeCurrent(home);
  await lf.policy.storage.set({day:'2026-10-09',jobs:1,milliseconds:120000,
    pending:{attemptId:attempt.attempt_id,attempt,jobId:f.jobId,reservedMs:120000,executionStartRequested:false,sandboxId:f.name,scratchDir:f.scratch,sbx_runtime:f.pending.sbx_runtime}});
  const controller=new AbortController(),lender=createLender({client:lf.client,backend:lf.backend,adapters:lf.adapters,policy:lf.policy,clock:lf.clock});
  const proofs=[];
  lf.backend.reconcilePending=async(row,o)=>{const proof=await real.reconcilePending(row,o);proofs.push(proof);return proof;};
  let failure=null;
  const running=lender.start(controller.signal);running.catch(error=>{failure=error;});
  try {
    await until(()=>proofs.length>0||failure,'recovery reconciled the old pending attempt');
    assert.equal(failure,null,'recovery did not reject');
    assert.equal(proofs[0].removed,closes,JSON.stringify(proofs[0]));
    if(closes){await until(()=>lf.saved().pending===null,'the old pending attempt closes');assert.equal(lf.saved().milliseconds,120000,'charged in full');}
    else {await new Promise(r=>setTimeout(r,200));assert.equal(lf.saved().pending?.attemptId,attempt.attempt_id,'the same hold stays');assert.equal(failure,null);}
  } finally {controller.abort();await running.catch(()=>{});}
});

test('a proof is refused when the sandbox HOME changes between the listing and the return',async()=>{
  const flipped='/another/sandbox/home',saved=process.env.FARAVAN_SBX_HOME;
  // The pending listing and the old record's own listing both ran under the first HOME; it changes after the last scan.
  let scans=0;
  const f=await fixture({onScan:()=>{if(++scans===2)process.env.FARAVAN_SBX_HOME=flipped;}});
  try {
    const proof=await f.backend.reconcilePending(structuredClone(f.pending),{sourceDirectory:f.directory});
    assert.equal(proof.removed,false);assert.equal(proof.code,'cessation_unverified');
    assert.equal(scans,2);
  } finally {if(saved===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=saved;}
});

test('owner release-hold refuses when the sandbox HOME changes during the awaited cleanup',async()=>{
  const flipped='/another/sandbox/home',saved=process.env.FARAVAN_SBX_HOME;
  const f=await fixture();
  // The listing and the scan ran under the first HOME; it changes while the old cleanup records close.
  const resolveJobs=f.backend.cleanupJournal.resolveJobs.bind(f.backend.cleanupJournal);
  let resolved=0;
  f.backend.cleanupJournal.resolveJobs=async(...args)=>{const out=await resolveJobs(...args);resolved++;process.env.FARAVAN_SBX_HOME=flipped;return out;};
  try {
    const proof=await f.backend.proveHoldAbsent({attemptId:'att-1',jobId:f.jobId,pending:f.pending});
    assert.equal(resolved,1,'the cleanup ran');
    assert.equal(proof.absent,false,JSON.stringify(proof));
    assert.equal(proof.reason,'sandbox_home_unverified');
  } finally {if(saved===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=saved;}
});

test('a legacy row with no recorded runtime is inventoried on the host default runtime and closes when absent',async()=>{
 const f=await fixture({runtimeBound:false});
 assert.equal((await f.backend.reconcilePending(f.pending,{sourceDirectory:f.directory})).removed,true);
 assert.deepEqual(await files(f.journal),[]);
 await assert.rejects(stat(f.scratch),{code:'ENOENT'});
 assert.deepEqual(f.calls.filter(a=>a[0]==='rm'||a[0]==='stop'),[],'nothing was removed or stopped');
});

test('a legacy row with no recorded runtime stays pending while its sandbox is listed',async()=>{
 const f=await fixture({runtimeBound:false,listing:[legacySandboxNameFor('legacy-job')]});
 assert.equal((await f.backend.reconcilePending(f.pending,{sourceDirectory:f.directory})).removed,false);
 assert.equal((await files(f.journal)).length,1);
 await stat(f.scratch);
});
