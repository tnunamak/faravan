import './helpers/no-browser.mjs';
import {testSbxRuntimeFields} from './helpers/sandbox-receipt-fixture.mjs';
import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DockerSbxBackend,_internal} from '../lib/docker-backend.mjs';
import {legacySandboxNameFor as sandboxNameFor,sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import {seedSandboxOwner} from './helpers/sandbox-owner.mjs';
import {createLender} from '../lib/v1/lender.mjs';
import {lenderFixture,until} from './helpers/v1-lender-fixture.mjs';
let root,oldHome,oldScratch;
beforeEach(async()=>{root=await mkdtemp(join(join(tmpdir(),'rh-XXXXXX').length<=22?tmpdir():'/tmp','rh-'));oldHome=process.env.FARAVAN_HOME;oldScratch=process.env.FARAVAN_SCRATCH_ROOT;process.env.FARAVAN_HOME=root;process.env.FARAVAN_SCRATCH_ROOT=join(root,'scratch');seedSandboxOwner();});
afterEach(async()=>{if(oldHome===undefined)delete process.env.FARAVAN_HOME;else process.env.FARAVAN_HOME=oldHome;if(oldScratch===undefined)delete process.env.FARAVAN_SCRATCH_ROOT;else process.env.FARAVAN_SCRATCH_ROOT=oldScratch;await rm(root,{recursive:true,force:true});});
for(const kind of ['pending','journal','scratch'])test('recorded HOME cannot be replaced by an empty current HOME: '+kind,async()=>{
 const jobId='recorded-job',name=sandboxNameFor(jobId),scratch=join(root,'scratch','wf-job-'+name+'-'+randomUUID()),journal=join(root,'v1','sandbox-cleanup'),scratchJournal=join(root,'scratch-journal');await mkdir(scratch,{recursive:true});await mkdir(journal,{recursive:true});await mkdir(scratchJournal,{mode:0o700});
 let released=false;const backend=new DockerSbxBackend({home:root,cleanupDirectory:journal,scratchJournal,storage:{release:async()=>{released=true;}},runCommand:async()=>({code:0,stdout:'[]',stderr:''}),legacyDaemonOptions:{inspectDaemons:async()=>[]}});
 const row={owner_scope:sandboxOwnerScope(),sbx_home:'/old/sandbox/home',jobId,attemptId:'attempt',attempt:{attempt_id:'attempt'},sandboxId:name};
 if(kind==='pending')assert.equal((await backend.reconcilePending(row)).removed,false);
 if(kind==='journal'){const id=randomUUID();await writeFile(join(journal,id+'.json'),JSON.stringify({...row,version:1,_cleanupId:id,job_id:jobId,sandbox_id:name,scratch_dir:scratch}));assert.equal((await backend.reconcileOwnedSandboxes()).removed,false);}
 if(kind==='scratch'){await writeFile(join(scratchJournal,name+'.json'),JSON.stringify({...row,v:1,sandboxId:name,parent:join(root,'scratch'),scratch,ownerPid:2147483647}),{mode:0o600});await backend.reconcileOrphanedScratch();}
 assert.equal(released,false,'the old HOME hold remains');
});
for(const cause of ['migration','wrong directory','missing scratch','outside scratch','historical mac HOME'])test('legacy HOME prerequisites: '+cause,async()=>{
 const directory=join(root,'v1');await mkdir(directory);const scratch=join(root,cause==='outside scratch'?'outside':'scratch','old-work');await mkdir(scratch,{recursive:true});
 const backend=new DockerSbxBackend({home:root,runCommand:async args=>({code:0,stdout:args[0]==='daemon'?'Status: running':'[]',stderr:''}),storage:{release:async()=>{}},legacyDaemonOptions:{platformName:cause==='historical mac HOME'?'darwin':'linux',selectHome:options=>({home:_internal.sbxHome(),migration:options?.pathExists?null: cause==='migration'?'using_legacy_home':null}),inspectDaemons:async({home})=>[{pid:123,environ:{HOME:home}}],isProcessAlive:()=>true,inspectProcesses:async()=>({complete:true,references:[]})}});
 const pending={jobId:'legacy-job',attemptId:'attempt',attempt:{attempt_id:'attempt'},...(cause==='missing scratch'?{}:{scratchDir:scratch}),...(cause==='historical mac HOME'?{sbx_home:'/historical/other/home'}:{})};
 assert.equal((await backend.reconcilePending(pending,{sourceDirectory:cause==='wrong directory'?root:directory})).removed,false);
});
test('a denied stopped legacy attempt retains its full charge',async t=>{
 const f=await lenderFixture(t),attempt=f.attempt();f.policy.enabled=false;f.policy.recoveryOnly=true;
 await f.policy.storage.set({day:'2026-10-09',jobs:1,milliseconds:120000,pending:{jobId:'old-job',attemptId:attempt.attempt_id,attempt,reservedMs:120000,agentStartDenied:true,stopReason:'stopped_by_lender',stopReleaseKey:'release',stopReportKey:'report'}});
 f.backend.reconcilePending=async row=>({removed:true,full_charge:true,attemptId:row.attemptId});
 const controller=new AbortController(),lender=createLender({...f.runOptions,client:f.client,backend:f.backend,policy:f.policy,adapters:f.adapters,clock:f.clock});const running=lender.start(controller.signal);running.catch(()=>{});
 try{await until(()=>f.saved().pending===null,'legacy stop closes');assert.equal(f.saved().jobs,1);assert.equal(f.saved().milliseconds,120000);}finally{controller.abort();await running.catch(()=>{});}
});

test('a cleanup receipt from another HOME cannot clear a recorded hold',async()=>{
 const directory=join(root,'v1','sandbox-cleanup'),name=sandboxNameFor('receipt-home'),scratch=join(root,'scratch','wf-job-'+name+'-'+randomUUID());await mkdir(scratch,{recursive:true});
 const backend=new DockerSbxBackend({home:root,cleanupDirectory:directory,runCommand:async()=>({code:0,stdout:'[]'})});
 const handle={job_id:'receipt-home',sandbox_id:name,scratch_dir:scratch};backend.cleanupJournal.register(handle);
 backend.cleanupJournal.finish(handle,{removed:true,scratch_removed:true,policy_removed:true,sbx_home:'/different/home'});
 assert.notEqual(backend.cleanupStatus().state,'clear');
});
test('cached startup proof does not survive a sandbox HOME change',async()=>{
 const backend=new DockerSbxBackend({home:root,runCommand:async()=>({code:0,stdout:'[]'})});
 const proof=await backend.reconcileOwnedSandboxes();assert.equal(proof.removed,true);
 const saved=process.env.FARAVAN_SBX_HOME;process.env.FARAVAN_SBX_HOME='/different/home';
 try{assert.equal(backend.isOwnedSandboxProofCurrent(proof),false);}finally{if(saved===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=saved;}
});

test('pending recovery rejects proof for a different recorded HOME',async t=>{
 const f=await lenderFixture(t),attempt=f.attempt(),events=[];f.policy.enabled=false;f.policy.recoveryOnly=true;
 await f.policy.storage.set({day:'2026-10-09',jobs:1,milliseconds:120000,pending:{...f.backend.sandboxOwnership(),jobId:'scoped-job',attemptId:attempt.attempt_id,attempt,reservedMs:120000}});
 f.backend.isSandboxHomeCurrent=()=>true;
 f.backend.reconcilePending=async row=>({removed:true,sbx_home:'/another/home',attemptId:row.attemptId});
 const controller=new AbortController(),lender=createLender({...f.runOptions,client:f.client,backend:f.backend,policy:f.policy,adapters:f.adapters,clock:f.clock,onEvent:e=>events.push(e)});const running=lender.start(controller.signal);running.catch(()=>{});
 try{await until(()=>f.saved().pending===null||events.some(e=>e.reason==='cleanup_pending'),'bound recovery decision');assert.ok(f.saved().pending,'a different HOME cannot discharge the recorded hold');}
 finally{controller.abort();await running.catch(()=>{});}
});

// A scoped record without a HOME never falls back to the current HOME.
for(const kind of ['pending','journal','scratch'])test('a scoped record with no recorded HOME removes nothing: '+kind,async()=>{
 const name='wf-'+'d'.repeat(16),scratch=join(root,'scratch','wf-job-'+name+'-'+randomUUID()),journal=join(root,'v1','sandbox-cleanup'),scratchJournal=join(root,'scratch-journal');
 await mkdir(scratch,{recursive:true});await mkdir(journal,{recursive:true});await mkdir(scratchJournal,{mode:0o700});
 const calls=[];let released=false;
 const backend=new DockerSbxBackend({home:root,cleanupDirectory:journal,scratchJournal,storage:{release:async()=>{released=true;}},
  runCommand:async args=>{calls.push(args);return {code:0,stdout:JSON.stringify([{name}]),stderr:''};},legacyDaemonOptions:{inspectDaemons:async()=>[]}});
 const row={owner_scope:sandboxOwnerScope(),jobId:'no-home-job',attemptId:'attempt',attempt:{attempt_id:'attempt'},sandboxId:name};
 if(kind==='pending')assert.equal((await backend.reconcilePending(row)).removed,false);
 if(kind==='journal'){const id=randomUUID();await writeFile(join(journal,id+'.json'),JSON.stringify({...row,version:2,_cleanupId:id,job_id:'no-home-job',sandbox_id:name,scratch_dir:scratch,create:'dispatched',compute_created:true,create_settled:true,compute_stopped:false,data_cleanup:'owned',policy_cleanup:'owned'}));
  assert.equal((await backend.reconcileOwnedSandboxes()).removed,false);await backend.reapCleanup();}
 if(kind==='scratch'){await writeFile(join(scratchJournal,name+'.json'),JSON.stringify({...row,v:1,sandboxId:name,parent:join(root,'scratch'),scratch,ownerPid:2147483647}),{mode:0o600});await backend.reconcileOrphanedScratch();}
 assert.deepEqual(calls.filter(args=>args[0]==='rm'||args[0]==='stop'),[]);
 assert.equal(released,false);
});

function legacyBackend(listing,options={}) {
 const calls=[];
 const backend=new DockerSbxBackend({home:root,storage:{release:async()=>{}},...options,
  runCommand:async args=>{calls.push(args);return {code:0,stdout:args[0]==='daemon'?'Status: running':JSON.stringify(listing.map(name=>({name}))),stderr:''};},
  legacyDaemonOptions:{platformName:'linux',selectHome:()=>({home:_internal.sbxHome(),migration:null}),inspectDaemons:async({home})=>[{pid:123,environ:{HOME:home}}],
   isProcessAlive:()=>true,inspectProcesses:async()=>({complete:true,references:[]})}});
 return {backend,calls};
}

test('an old scratch record in the default sandbox journal reaches the owner report',async()=>{
 const name='wf-'+'e'.repeat(16),journal=join(_internal.sbxHome(),'scratch-journal'),scratch=join(root,'scratch','wf-job-'+name+'-'+randomUUID());
 await mkdir(journal,{recursive:true,mode:0o700});await mkdir(scratch,{recursive:true});
 await writeFile(join(journal,name+'.json'),JSON.stringify({v:1,sandboxId:name,parent:join(root,'scratch'),scratch,ownerPid:2147483647}),{mode:0o600});
 const {backend,calls}=legacyBackend([name]);
 await backend.reconcileOrphanedScratch();
 assert.ok(backend.cleanupStatus().remediation?.some(row=>row.name===name),'the default journal location is reported');
 assert.deepEqual(calls.filter(args=>args[0]==='rm'),[]);
});

test('an old pending attempt closes on a verified absent listing, charged in full, without removal',async()=>{
 const directory=join(root,'v1');await mkdir(directory,{recursive:true});const scratch=join(root,'scratch','old-work');await mkdir(scratch,{recursive:true});
 const {backend,calls}=legacyBackend([]);
 const proof=await backend.reconcilePending({...testSbxRuntimeFields(root),jobId:'legacy-job',attemptId:'attempt',attempt:{attempt_id:'attempt'},scratchDir:scratch},{sourceDirectory:directory});
 assert.equal(proof.removed,true);
 assert.equal(proof.full_charge,true);
 assert.deepEqual(calls.filter(args=>args[0]==='rm'),[]);
});
