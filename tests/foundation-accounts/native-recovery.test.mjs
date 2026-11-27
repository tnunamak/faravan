import {tmpdir} from 'node:os';
import '../helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createSandboxCleanupJournal} from '../../lib/sandbox-cleanup-journal.mjs';
import {sandboxOwnerScope} from '../../lib/sandbox-name.mjs';
import {DockerSbxBackend} from '../../lib/docker-backend.mjs';
import {createLaunchBackend} from '../../lib/v1/launch-backend.mjs';

const attempt={attemptId:'native-attempt',jobId:'native-job',generation:7,leaseProof:{schemaVersion:1,signedEnvelope:'test-proof'}};
const selection={accountId:'native-account',providerId:'codex',modelId:'model',effortId:null};
function fixture(t,mode){
 const root=fs.mkdtempSync(join(tmpdir(),'faravan-native-registry-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const nativeDirectory=join(root,'native'),scratch=join(root,'scratch');fs.mkdirSync(nativeDirectory);fs.mkdirSync(scratch);
 let removed=0,row;
 const openRegistry=()=>createSandboxCleanupJournal({directory:nativeDirectory,scratchRoot:()=>scratch,home:()=>root,destroy:async()=>assert.fail('no broad reap')});
 let registry=openRegistry();
 const backend={
  prepare:async()=>{
   const name='wf-'+randomUUID().replaceAll('-','').slice(0,16),id=randomUUID();
   row={version:2,_cleanupId:id,owner_scope:sandboxOwnerScope(),sbx_home:root,job_id:attempt.jobId,sandbox_id:name,
    scratch_dir:join(scratch,'wf-job-'+name+'-'+randomUUID()),account_attempt:{jobId:attempt.jobId,attemptId:attempt.attemptId,generation:attempt.generation,accountId:selection.accountId,providerId:selection.providerId},
    create:'dispatched',compute_created:true,create_settled:true,compute_stopped:false,data_cleanup:'owned',policy_cleanup:'owned'};
   fs.mkdirSync(row.scratch_dir);fs.writeFileSync(join(nativeDirectory,id+'.json'),JSON.stringify(row));
   if(mode==='reject')throw Error('create then lost response');
   return structuredClone(row);
  },
  start:async()=>assert.fail('recovery never launches'),cancel:async()=>{},inspect:async h=>({job_id:h.job_id,status:'exited'}),
  destroy:async h=>{
   assert.equal(h._cleanupId,row._cleanupId);assert.equal(h.sandbox_id,row.sandbox_id);removed++;
   fs.rmSync(h.scratch_dir,{recursive:true});fs.unlinkSync(join(nativeDirectory,h._cleanupId+'.json'));
   return {job_id:h.job_id,sandbox_id:h.sandbox_id,removed:true,scratch_removed:true,policy_removed:true,storage_removed:true};
  },
  recoverAccountRun:binding=>DockerSbxBackend.prototype.recoverAccountRun.call({cleanupJournal:registry},binding),
 };
 const bridge=()=>createLaunchBackend({backend,journalDirectory:join(root,'bridge'),clock:()=>2000,
  resolveJob:async()=>({job_id:attempt.jobId}),bindRun:async()=>assert.fail('recovery cannot bind'),
  recoverHandle:binding=>backend.recoverAccountRun(binding)});
 return {root,backend,bridge,reopen:()=>{registry=openRegistry();return bridge();},row:()=>row,removed:()=>removed,
  mutate:fn=>{fn(row);fs.writeFileSync(join(nativeDirectory,row._cleanupId+'.json'),JSON.stringify(row));}};
}
test('real bridge reopens a create-then-reject through the native registry and removes the exact incarnation',async t=>{
 const f=fixture(t,'reject');assert.equal((await f.bridge().prepare({attempt,selection})).ok,false);
 const bridge=f.reopen();assert.deepEqual(await bridge.reconcilePreparation({attempt,operationId:'recover'}),{ok:true,value:{kind:'removed'}});
 assert.equal(f.removed(),1);
 assert.deepEqual(await f.reopen().reconcilePreparation({attempt,operationId:'recover'}),{ok:true,value:{kind:'removed'}});
 assert.equal(f.removed(),1);
});
for(const mutation of ['unknown','foreign-attempt','foreign-generation','foreign-account','foreign-incarnation'])test('native reopen retains preparation debt for '+mutation,async t=>{
 const f=fixture(t,'return'),first=f.bridge();assert.equal((await first.prepare({attempt,selection})).ok,true);
 if(mutation==='unknown')fs.unlinkSync(join(f.root,'native',f.row()._cleanupId+'.json'));
 else f.mutate(row=>{
  if(mutation==='foreign-attempt')row.account_attempt.attemptId='other';
  if(mutation==='foreign-generation')row.account_attempt.generation++;
  if(mutation==='foreign-account')row.account_attempt.accountId='other';
  if(mutation==='foreign-incarnation')row._cleanupId=randomUUID();
 });
 const result=await f.reopen().reconcilePreparation({attempt,operationId:'recover'});
 assert.equal(result.ok,false);assert.equal(f.removed(),0);
});

test('native registry survives the bridge binding persistence failure after creation',async t=>{
 const f=fixture(t,'return'),rename=fs.renameSync;let failed=false;
 const mock=t.mock.method(fs,'renameSync',(from,to)=>{
  if(!failed&&f.row()&&to.startsWith(join(f.root,'bridge')+'/')){failed=true;throw Object.assign(Error('owned binding write failure'),{code:'EIO'});}
  return rename(from,to);
 });
 assert.equal((await f.bridge().prepare({attempt,selection})).ok,false);assert.equal(failed,true);
 mock.mock.restore();
 assert.deepEqual(await f.reopen().reconcilePreparation({attempt,operationId:'after-binding-failure'}),{ok:true,value:{kind:'removed'}});
 assert.equal(f.removed(),1);
});
