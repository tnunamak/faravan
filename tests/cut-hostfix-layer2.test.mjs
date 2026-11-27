import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createSandboxCleanupJournal} from '../lib/sandbox-cleanup-journal.mjs';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
function journalFixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'cut-journal-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const directory=path.join(root,'journal'),scratch=path.join(root,'scratch');fs.mkdirSync(directory);fs.mkdirSync(scratch);let destroyed=[];let journal;
 journal=createSandboxCleanupJournal({directory,scratchRoot:()=>scratch,home:()=>root,destroy:async row=>{destroyed.push(row.sandbox_id);journal.finish(row,{removed:true,scratch_removed:true,policy_removed:true});return {removed:true,scratch_removed:true,policy_removed:true};}});
 const seed=(change={})=>{const id=randomUUID(),name='wf-'+id.replaceAll('-','').slice(0,16);const row={version:2,_cleanupId:id,owner_scope:sandboxOwnerScope(),sbx_home:root,job_id:id,sandbox_id:name,scratch_dir:path.join(scratch,'wf-job-'+name+'-'+randomUUID()),create:'dispatched',compute_created:true,create_settled:true,compute_stopped:false,data_cleanup:'owned',policy_cleanup:'owned',...change};fs.writeFileSync(path.join(directory,id+'.json'),JSON.stringify(row));return row;};
 return {root,directory,journal,seed,destroyed};}
const manager={active:async()=>false,register:async()=>{throw Error('not applicable');}};
const watcher={acknowledge:async row=>({watch_generation:row.watch_generation,challenge:row.watch_challenge,binary:'/fake/sbx'})};
test('watch recovery does not reinterpret materialized no-deadline rows as unsafe',async t=>{const f=journalFixture(t),row=f.seed();const report=await f.journal.recoverDeadlines(manager,{watcher});assert.deepEqual(report.rows,[]);const proof=await f.journal.reconcileOwned({inventory:async()=>[]});assert.equal(proof.removed,true);assert.deepEqual(f.destroyed,[row.sandbox_id]);});
test('malformed sibling remains byte-unchanged while materialized no-deadline row cleans up',async t=>{const f=journalFixture(t),row=f.seed(),file=path.join(f.directory,'00000000-0000-0000-0000-000000000000.json');fs.writeFileSync(file,'null');const report=await f.journal.recoverDeadlines(manager,{watcher});const debt=new Set(report.rows.filter(r=>r.status==='failed').map(r=>r.id));const proof=await f.journal.reconcileOwned({inventory:async()=>[],deferredIds:debt});assert.equal(proof.removed,false);assert.deepEqual(f.destroyed,[row.sandbox_id]);assert.equal(fs.readFileSync(file,'utf8'),'null');});
test('empty reconciliation retains failed final inventory reason',async t=>{const f=journalFixture(t);let n=0;const proof=await f.journal.reconcileOwned({inventory:async()=>++n===1?[]:null});assert.equal(proof.removed,false);assert.equal(proof.remediation[0].reason,'inventory_unavailable');});

test('watch adoption keeps sanitized policy failure detail without a listing or cessation claim',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cut-watch-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const directory=path.join(root,'journal'),scratch=path.join(root,'scratch');fs.mkdirSync(directory);fs.mkdirSync(scratch);
 const id=randomUUID(),name='wf-0000000000000009',row={version:2,_cleanupId:id,owner_scope:sandboxOwnerScope(),sbx_home:root,job_id:id,sandbox_id:name,
 scratch_dir:path.join(scratch,'wf-job-'+name+'-'+randomUUID()),create:'dispatched',compute_created:false,create_settled:false,compute_stopped:false,data_cleanup:'pending',policy_cleanup:'pending'};
 fs.writeFileSync(path.join(directory,id+'.json'),JSON.stringify(row));
 let retries=0;const journal=createSandboxCleanupJournal({directory,scratchRoot:()=>scratch,home:()=>root,destroy:()=>assert.fail('no compute destroy'),
 retryWatchDebts:async()=>{retries++;return {policy_revoked:false,revocation:{step:'github_secret',error:'listing_failed',stderr:'SECRET'}};}});
 const report=await journal.recoverDeadlines(manager,{watcher});assert.equal(report.rows[0].admission_released,true);
 assert.equal(retries,0,'admission does not wait on non-compute cleanup');await journal.reap();
 const proof=await journal.reconcileOwned({inventory:()=>assert.fail('no listing required')});assert.equal(proof.removed,false);assert.equal(proof.watching,1);
 assert.deepEqual(proof.remediation,[{name,home:root,reason:'credential_revocation_pending',step:'github_secret',error:'listing_failed'}]);
 assert.equal(journal.jobsStopped([id]),false);assert.equal(retries,1);assert.doesNotMatch(fs.readFileSync(path.join(directory,id+'.json'),'utf8'),/SECRET/);
});

import {removeSandboxPolicies} from '../lib/sandbox-policy-cleanup.mjs';
const backendSource=fs.readFileSync(new URL('../lib/docker-backend.mjs',import.meta.url),'utf8');
const retryStart=backendSource.indexOf('  async _retryWatchedCleanupDebts('),retryEnd=backendSource.indexOf('  _noteCleanupListingFailure(',retryStart);
const retryMethod=github=>Function('removeSandboxGitHub','removeSandboxPolicies','AbortSignal','return ({'+backendSource.slice(retryStart,retryEnd)+'})._retryWatchedCleanupDebts')(github,removeSandboxPolicies,AbortSignal);
const watchedName='wf-0000000000000010';
const provisioned={id:'p1',scope:'sandbox:'+watchedName,applies_to:'sandbox:'+watchedName,resource_type:'network',decision:'allow',actions:['net:connect:tcp'],status:'active',origin:'scoped',layer:'local',editable:false,provenance:{created_via:'provisioned',source:'sandboxes'}};
const badRules={source:r=>({...r,provenance:{...r.provenance,source:'cli'}}),missing_source:r=>({...r,provenance:{created_via:'provisioned'}}),global_layer:r=>({...r,layer:'global'}),missing_layer:({layer,...r})=>r,changed_origin:r=>({...r,origin:'user'}),missing_origin:({origin,...r})=>r,other_scope:r=>({...r,scope:'sandbox:wf-9999999999999999'}),user_creator:r=>({...r,provenance:{created_via:'user'}}),other_target:r=>({...r,applies_to:'sandbox:wf-9999999999999999'})};
for(const mode of ['clean','provisioned','github_throw','github_remains','policy_throw','policy_partial','removal_refused',...Object.keys(badRules)])test('real watched debt method preserves access safety and fixed detail: '+mode,async()=>{
 const row={sandbox_id:watchedName,watch_state:'watch_adopted'},commands=[];
 const github=async()=>{if(mode==='github_throw')throw Error('SECRET');return mode!=='github_remains';};
 const rules=mode==='clean'?[]:mode==='removal_refused'?[{...provisioned,editable:true}]:[badRules[mode]?.(provisioned)??provisioned];
 const backend={cleanupJournal:{authority:()=>row},_rowHomeMatches:()=>true,_rowRun:async(r,args)=>{assert.equal(r,row);commands.push(args);
 if(mode==='policy_throw')throw Error('SECRET');if(args[1]==='rm')return {code:1,stderr:'SECRET'};
 return {code:0,stdout:JSON.stringify({rules}),stderr:mode==='policy_partial'?'SECRET':''};}};
 const result=await retryMethod(github).call(backend,row);
 assert.doesNotMatch(JSON.stringify(result),/SECRET/);
 if(['clean','provisioned'].includes(mode))assert.deepEqual(result,{policy_revoked:true});
 else {assert.equal(result.policy_revoked,false);assert.equal(result.revocation.step,mode.startsWith('github')?'github_secret':'network_policy');
 const expected=mode==='github_remains'?'value_remains':mode==='removal_refused'?'removal_refused':['github_throw','policy_throw','policy_partial','other_scope','other_target'].includes(mode)?'listing_failed':'rule_remains';assert.equal(result.revocation.error,expected);}
 if(mode!=='removal_refused')assert.equal(commands.some(args=>args[1]==='rm'),false);
 assert.equal(row.compute_stopped,undefined);assert.equal(row.data_cleanup,undefined);
});
