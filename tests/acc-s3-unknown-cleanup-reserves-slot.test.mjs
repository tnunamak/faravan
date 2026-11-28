import {poolFactCache} from './helpers/pool-fact-cache.mjs';
import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileSbx,receiptBackend,receiptJob} from './helpers/sandbox-receipt-fixture.mjs';
import {sandboxRemediationLines} from '../lib/sandbox-remediation.mjs';
import {createLendingPool} from '../lib/v1/lending-pool.mjs';
import {opById} from '../lib/v1/ops/registry.mjs';
function fixture(t,{count=1,kit=true,live=false,fenced=true,listingFailed=false,removalWorks=false,kitProvenance=false,storageWait}={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cleanup-isolated-')),saved=process.env.FARAVAN_SBX_HOME;
 process.env.FARAVAN_SBX_HOME=path.join(root,'sbx');t.after(()=>{if(saved===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=saved;fs.rmSync(root,{recursive:true,force:true});});
 const sbx=fileSbx(root),run=sbx.run,rows=[],directory=path.join(root,'profile/v1/sandbox-cleanup');let releases=0,policyRemovals=0,present=live,removals=0;
 sbx.run=async(args,options)=>{
  if(args[0]==='ls'&&listingFailed)return {code:1,stdout:'',stderr:'503 Service Unavailable'};
  if(args[0]==='ls')return {code:0,stdout:JSON.stringify(present?rows.map(r=>({name:r.sandbox_id})):[]),stderr:''};
  if(args[0]==='rm'){removals++;if(removalWorks)present=false;}
  if(args[0]==='policy'&&args[1]==='ls')return {code:0,stdout:JSON.stringify({rules:rows.map(r=>({id:'residue-'+r._cleanupId,type:kit?'kit':'user',resource:'sandbox:'+r.sandbox_id,scope:'sandbox:'+r.sandbox_id,applies_to:'sandbox:'+r.sandbox_id,resource_type:'network',decision:'allow',status:'active',editable:kit,...(kitProvenance?{type:undefined,editable:false,origin:'scoped',layer:'local',provenance:{created_via:'provisioned',source:'sandboxes'}}:{})}))}),stderr:''};
  if(args[0]==='policy'&&args[1]==='rm'){policyRemovals++;return {code:1,stdout:'',stderr:'kit managed rule cannot be removed'};}
  return run(args,options);
 };
 const backend=receiptBackend(root,sbx,{onReaperSummary:()=>{},storage:{release:async()=>{releases++;await storageWait;}}});fs.mkdirSync(directory,{recursive:true});
 for(let i=0;i<count;i++){
  const id=randomUUID(),name='wf-'+i.toString(16).padStart(16,'0'),row={version:2,_cleanupId:id,...backend.sandboxOwnership(),job_id:'fixture-'+i,sandbox_id:name,scratch_dir:path.join(root,'scratch','wf-job-'+name+'-fixture'),create:'dispatched',compute_created:false,create_settled:false,compute_stopped:!live,data_cleanup:'removed',policy_cleanup:'blocked',absent_since:Date.now()-60*3600000,watch_state:'watch_adopted',exec_fenced:true,create_incarnation:id,watch_generation:'fixture',watch_challenge:'fixture',watch_debt_retry:{policy_revoked:true,scratch:'awaiting_compute',storage:'awaiting_compute',name:'reserved'},};
  rows.push(row);fs.writeFileSync(path.join(directory,id+'.json'),JSON.stringify(row));
  if(fenced)fs.writeFileSync(path.join(directory,name+'.scope.reserved'),JSON.stringify({id,owner_scope:row.owner_scope,sbx_home:row.sbx_home,sandbox_id:name}));
 }
 return {backend,rows,directory,releases:()=>releases,policyRemovals:()=>policyRemovals,removals:()=>removals,setListed:value=>{present=value;}};
}
// Slice 3, behavior 5: a failed cleanup whose account is unknown (the row names no account) reserves one machine slot, so no
// new job starts in it. Rows here carry no account_key. Machine capacity is 1 job, so that reserved slot is the only one.
test('a failed cleanup with an unknown account reserves one machine slot: no worker admits a new job',async t=>{
 const f=fixture(t,{count:1,kit:false,live:true}),workers=[];
 let disk={jobs:0,milliseconds:0,accounts:{}};
 const controller=new AbortController();
 const pool=createLendingPool({backend:f.backend,storage:{get:async()=>disk,set:async v=>{disk=v;},acquire:async()=>()=>{}},capacity:1,policy:{enabled:true,dailyJobs:null,dailyMinutes:null},adapters:[{spec:{harness_id:'claude-code-subscription'}},{spec:{harness_id:'codex'}}],createLender:opts=>{const facts=poolFactCache(opts.policy);const worker={start:async signal=>{await facts.refresh();if(!signal.aborted)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));},refreshAdmission:()=>facts.refresh(),getState:()=>({status:'idle',reason:null,current:null}),admits:()=>facts.reason,cessation:()=>({proven:true})};workers.push(worker);return worker;}});
 const running=pool.start(controller.signal);t.after(async()=>{controller.abort();await running;});
 while(workers.length<2)await new Promise(resolve=>setImmediate(resolve));
 await pool.refreshAdmission();
 const reasons=workers.map(w=>w.admits());
 assert.ok(reasons.every(r=>r!==null),'every worker is held while the unknown-account cleanup holds the machine slot: '+JSON.stringify(reasons));
 assert.notEqual(pool.admits(),null,'the pool admits no new job');
});
