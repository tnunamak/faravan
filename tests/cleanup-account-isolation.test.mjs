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
  const id=randomUUID(),name='wf-'+i.toString(16).padStart(16,'0'),row={version:2,_cleanupId:id,...backend.sandboxOwnership(),job_id:'fixture-'+i,sandbox_id:name,scratch_dir:path.join(root,'scratch','wf-job-'+name+'-fixture'),create:'dispatched',compute_created:false,create_settled:false,compute_stopped:!live,data_cleanup:'removed',policy_cleanup:'blocked',absent_since:Date.now()-60*3600000,watch_state:'watch_adopted',exec_fenced:true,create_incarnation:id,watch_generation:'fixture',watch_challenge:'fixture',watch_debt_retry:{policy_revoked:true,scratch:'awaiting_compute',storage:'awaiting_compute',name:'reserved'},...(i%2===0?{account_key:'claude',account_slot:0}:{})};
  rows.push(row);fs.writeFileSync(path.join(directory,id+'.json'),JSON.stringify(row));
  if(fenced)fs.writeFileSync(path.join(directory,name+'.scope.reserved'),JSON.stringify({id,owner_scope:row.owner_scope,sbx_home:row.sbx_home,sandbox_id:name}));
 }
 return {backend,rows,directory,releases:()=>releases,policyRemovals:()=>policyRemovals,removals:()=>removals,setListed:value=>{present=value;}};
}
for(const count of [1,20])test(count+' unresolvable rows reserve A/fallback slot but B admits',async t=>{
 const f=fixture(t,{count,kit:false,live:true}),workers=[];let disk={jobs:0,milliseconds:0,accounts:{'claude:0':{jobs:0,milliseconds:0,pending:{attemptId:'old-attempt',resources:{cpu:2,memoryBytes:4*1024**3}}}}};
 const controller=new AbortController();
 const pool=createLendingPool({backend:f.backend,storage:{get:async()=>disk,set:async v=>{disk=v;},acquire:async()=>()=>{}},capacity:2,policy:{enabled:true,dailyJobs:null,dailyMinutes:null},adapters:[{spec:{harness_id:'claude-code-subscription'}},{spec:{harness_id:'codex'}}],createLender:opts=>{const facts=poolFactCache(opts.policy);const worker={start:async signal=>{await facts.refresh();if(!signal.aborted)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));},refreshAdmission:()=>facts.refresh(),getState:()=>({status:opts.accountKey==='claude'?'stopping':'idle',reason:opts.accountKey==='claude'?'cleanup_pending':null,current:null}),admits:()=>facts.reason,cessation:()=>({proven:true})};workers.push(worker);return worker;}});
 const running=pool.start(controller.signal);t.after(async()=>{controller.abort();await running;});
 while(workers.length<2)await new Promise(resolve=>setImmediate(resolve));
 await pool.refreshAdmission();
 assert.equal(workers[0].admits(),'cleanup_pending');assert.equal(workers[1].admits(),null);assert.equal(pool.admits(),null);assert.equal(pool.getState().status,'idle');
 assert.throws(()=>f.backend.assertDeadlineTargetClear(f.rows[0]),/cleanup|reserved/);
});
for(const mode of ['kit','non-kit','live','unfenced'])test('stopped watched residue: '+mode,async t=>{
 const f=fixture(t,{kit:mode!=='non-kit',live:mode==='live',fenced:mode!=='unfenced'});
 await f.backend.recoverSandboxDeadlines().catch(()=>{});await f.backend.reapCleanup().catch(()=>{});
 const exists=fs.existsSync(path.join(f.directory,f.rows[0]._cleanupId+'.json'));
 assert.equal(exists,mode!=='kit');
 if(mode==='kit'){assert.ok(f.releases()>0);assert.ok(f.policyRemovals()>0);const fence=JSON.parse(fs.readFileSync(path.join(f.directory,f.rows[0].sandbox_id+'.scope.reserved')));assert.ok(fence.policy_residue.length);}
});
test('row text names its sandbox and home, never undefined',()=>{
 const [line]=sandboxRemediationLines([{reason:'cleanup_deferred',name:'wf-0000000000000001',home:'/synthetic/home'}]);assert.doesNotMatch(line,/undefined|could not prove that this install created/);assert.match(line,/wf-0000000000000001/);assert.match(line,/Clean up now/);
});
test('blockers uses the same blocked admission as lending summary',async()=>{
 const status={intent:{on:true,state:'ready'},execution:{state:'stopping'},admission:{reason:'cessation_unverified'},summary:{headline:"Jobs can't start",phase:'waiting'},headline:'Lending is on',blockers:[]};
 const result=await opById('status.blockers').handler({call:async id=>id==='status.get'?status:id==='readiness.get'?{ready:true,checks:[]}:[]},{});
 assert.equal(result.can_lend,false);assert.equal(result.headline,status.summary.headline);assert.ok(result.blockers.some(b=>b.kind==='cleanup_pending'));
});
test('unavailable listing stays global',async t=>{const f=fixture(t,{listingFailed:true});await assert.rejects(f.backend.recoverSandboxDeadlines());assert.equal(f.backend.deadlineRecoveryHold().error_code,'sbx_daemon_unavailable');});

test('stopped non-kit debt resolves awaiting_compute without consuming a slot',async t=>{
 const f=fixture(t,{kit:false});await f.backend.reapCleanup();
 const row=JSON.parse(fs.readFileSync(path.join(f.directory,f.rows[0]._cleanupId+'.json')));
 assert.equal(row.compute_stopped,true);assert.equal(row.watch_debt_retry.scratch,'removed');assert.equal(row.watch_debt_retry.storage,'released');
 assert.equal(f.backend.cleanupSlotHold('claude'),null);assert.equal(f.backend.cleanupStatus().items.length,1);
});
test('unknown recovery failure is local and keeps its named debt',async t=>{
 const f=fixture(t,{live:true});f.backend.cleanupJournal.recoverDeadlines=async()=>{throw Error('synthetic failure');};
 const proof=await f.backend.reconcileOwnedSandboxes();assert.equal(proof.admission_allowed,true);assert.equal(f.backend.isOwnedSandboxAdmissionCurrent(proof),true);assert.equal(f.backend.deadlineRecoveryHold(),null);
 assert.equal(f.backend.cleanupSlotHold('claude'), 'cessation_unverified');assert.equal(f.backend.cleanupSlotHold('codex'),null);
});
test('cleanup retry and status expose one honest item for each retained row',{timeout:20000},async t=>{
 const {appFixture,syntheticBackend,api}=await import('./helpers/v1-app-fixture.mjs');
 const app=await appFixture(t),f=fixture(t,{kit:false});const backend=syntheticBackend(app.root);
 for(const method of ['recoverSandboxDeadlines','deadlineRecoveryHold','deadlineRecoveryPending','cleanupStatus','reapCleanup'])backend[method]=(...args)=>f.backend[method](...args);
 const started=await app.start('cleanup-items',{backend,cleanupRecheckMs:60000,shutdownProofMs:1000});
 const status=await api(started.app,'/api/status'),blockers=await api(started.app,'/api/ops/status.blockers',{method:'POST',body:{}});
 for(const value of [status,blockers]){const items=value.blockers.filter(row=>row.kind==='cleanup_pending');assert.equal(items.length,1);assert.equal(items[0].blocking,false);assert.match(items[0].message,new RegExp(f.rows[0].sandbox_id));assert.doesNotMatch(items[0].message,/undefined/);assert.equal(items[0].fix.human,'Clean up now');}
 const retry=await api(started.app,'/api/cleanup/retry',{method:'POST',body:{}});assert.equal(retry.items.length,1);assert.match(retry.items[0].message,/access rules/);assert.equal(retry.hold,null);
});

test('a retained stopped row holds its own slot again when its name reappears',async t=>{
 const f=fixture(t,{kit:false});await f.backend.reapCleanup();f.setListed(true);await f.backend.reapCleanup();
 assert.ok(f.removals()>0);assert.equal(f.backend.cleanupSlotHold('claude'),'cessation_unverified');assert.equal(f.backend.cleanupSlotHold('codex'),null);
});
test('a never-dispatched record holds its name but no execution slot',t=>{
 const f=fixture(t,{live:true}),row={...f.rows[0],create:'reserved',watch_state:undefined};
 fs.writeFileSync(path.join(f.directory,row._cleanupId+'.json'),JSON.stringify(row));
 assert.equal(f.backend.cleanupSlotHold('claude'),null);assert.throws(()=>f.backend.assertDeadlineTargetClear(row),/cleanup/);
});
test('a permanently reserved live name is retried even without an old absence receipt',async t=>{
 const f=fixture(t,{kit:false,live:true,removalWorks:true}),row={...f.rows[0],absent_since:undefined};
 fs.writeFileSync(path.join(f.directory,row._cleanupId+'.json'),JSON.stringify(row));await f.backend.reapCleanup();
 assert.ok(f.removals()>0);assert.equal(f.backend.cleanupSlotHold('claude'),null);assert.equal(f.backend.cleanupStatus().items.length,1);
});
test('unreadable journal status stays responsive with one fallback obligation',t=>{
 const f=fixture(t);fs.rmSync(f.directory,{recursive:true});fs.writeFileSync(f.directory,'synthetic unreadable journal');
 const status=f.backend.cleanupStatus();assert.equal(status.items.length,1);assert.equal(status.items[0].reason,'journal_unreadable');
 assert.equal(f.backend.cleanupSlotHold('claude',{fallback:true}),'cessation_unverified');assert.equal(f.backend.cleanupSlotHold('codex'),null);
});

test('kit residue recognizes the strict provisioned JSON form used by older sbx',async t=>{
 const f=fixture(t,{kitProvenance:true});await f.backend.reapCleanup();
 assert.equal(fs.existsSync(path.join(f.directory,f.rows[0]._cleanupId+'.json')),false);
 const fence=JSON.parse(fs.readFileSync(path.join(f.directory,f.rows[0].sandbox_id+'.scope.reserved')));assert.deepEqual(fence.policy_residue,[{id:'residue-'+f.rows[0]._cleanupId,type:'kit'}]);
});

test('an account cleanup hold is one row item, not a second whole-lender blocker',async()=>{
 const item={kind:'cleanup_pending',blocking:false,name:'wf-0000000000000001',message:'Sandbox wf-0000000000000001 could still be running.',fix:{op:'cleanup.retry',human:'Clean up now',input:{}}};
 const status={intent:{on:true,state:'ready'},execution:{state:'idle'},admission:{reason:'cessation_unverified'},summary:{headline:"Jobs can't start",phase:'waiting'},blockers:[item]};
 const result=await opById('status.blockers').handler({call:async id=>id==='status.get'?status:id==='readiness.get'?{ready:true,checks:[]}:[]},{});
 assert.equal(result.can_lend,false);assert.equal(result.blockers.length,1);assert.equal(result.blockers[0].name,item.name);
});

test('a resolved row leaves its name fenced against direct and storage create',async t=>{
 const f=fixture(t);await f.backend.reapCleanup();const row=f.rows[0];
 assert.equal(fs.existsSync(path.join(f.directory,row._cleanupId+'.json')),false);
 assert.throws(()=>f.backend.assertDeadlineTargetClear({sandbox_id:row.sandbox_id,sbx_home:row.sbx_home}),{code:'cessation_unverified'});
 await assert.rejects(f.backend._runStorageCommand(['create','--name',row.sandbox_id]),{code:'cessation_unverified'});
});

test('cleanup in progress keeps its row visible until the final step finishes',{timeout:10000},async t=>{
 let resume;const storageWait=new Promise(resolve=>{resume=resolve;}),f=fixture(t,{storageWait});const work=f.backend.reapCleanup();
 try {
  const until=Date.now()+5000;while(!f.releases()&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(f.releases()>0);const status=f.backend.cleanupStatus();assert.equal(status.items.length,1);assert.equal(status.items[0].name,f.rows[0].sandbox_id);
 }finally{resume();await work;}
 assert.deepEqual(f.backend.cleanupStatus().items,[]);
});

test('fresh B admission does not join a stalled A cleanup pass',{timeout:10000},async t=>{
 const f=fixture(t,{kit:false,live:true});let entered,resume;
 const started=new Promise(resolve=>{entered=resolve;}),paused=new Promise(resolve=>{resume=resolve;});
 f.backend.cleanupJournal.recoverDeadlines=async()=>{entered();await paused;return {complete:false,rows:[{id:f.rows[0]._cleanupId,name:f.rows[0].sandbox_id,status:'failed'}]};};
 const recovery=f.backend.recoverSandboxDeadlines();await started;const admission=f.backend.admitJob(receiptJob({required_limits:[]}));let timer;
 try {const answer=await Promise.race([admission,new Promise(resolve=>{timer=setTimeout(()=>resolve('blocked by another account'),1000);})]);assert.notEqual(answer,'blocked by another account');assert.equal(answer.ok,true);}
 finally{clearTimeout(timer);resume();await recovery;await admission.catch(()=>{});}
});
test('the startup gate releases after availability, while A cleanup continues',{timeout:10000},async t=>{
 const {createDeadlineRecoveryGate}=await import('../lib/v1/deadline-recovery-gate.mjs');const f=fixture(t,{live:true});let entered,resume;
 const started=new Promise(resolve=>{entered=resolve;}),paused=new Promise(resolve=>{resume=resolve;});
 f.backend.cleanupJournal.recoverDeadlines=async()=>{entered();await paused;return {complete:false,rows:[{id:f.rows[0]._cleanupId,status:'failed'}]};};
 const gate=createDeadlineRecoveryGate({backend:f.backend}),work=gate.begin();await started;
 try{assert.equal(gate.current(),null);assert.equal(f.backend.cleanupSlotHold('codex'),null);}
 finally{resume();await work;}
});
test('workspace readiness does not wait for account cleanup to finish',{timeout:15000},async t=>{
 const {appFixture,syntheticBackend,api}=await import('./helpers/v1-app-fixture.mjs');const f=await appFixture(t),backend=syntheticBackend(f.root);let resume,entered;
 const paused=new Promise(resolve=>{resume=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 backend.ensureSandboxAdmission=async()=>true;
 backend.recoverSandboxDeadlines=async()=>{entered();await paused;return {complete:false,rows:[{id:'synthetic-row',status:'failed'}]};};
 const {app}=await f.start('available-before-cleanup',{backend,cleanupRecheckMs:60000,shutdownProofMs:500});await started;
 const reading=api(app,'/api/readiness?refresh=true');let timer;
 try{const readiness=await Promise.race([reading,new Promise(resolve=>{timer=setTimeout(()=>resolve('waited for cleanup'),3000);})]);assert.notEqual(readiness,'waited for cleanup');assert.equal(readiness.ready,true);}
 finally{clearTimeout(timer);resume();await reading.catch(()=>{});}
});

test('a real B worker starts while another account recovery is stalled',{timeout:15000},async t=>{
 const {lenderFixture}=await import('./helpers/v1-lender-fixture.mjs'),{createLender}=await import('../lib/v1/lender.mjs');
 const debt=fixture(t,{kit:false,live:true}),f=await lenderFixture(t);let entered,resume;
 const started=new Promise(resolve=>{entered=resolve;}),paused=new Promise(resolve=>{resume=resolve;});
 debt.backend.cleanupJournal.recoverDeadlines=async()=>{entered();await paused;return {complete:false,rows:[{id:debt.rows[0]._cleanupId,status:'failed'}]};};
 const recovery=debt.backend.recoverSandboxDeadlines();await started;
 f.backend.reconcileOwnedSandboxes=options=>debt.backend.reconcileOwnedSandboxes(options);
 f.backend.reconcileLendingAdmission=debt.backend.reconcileLendingAdmission?.bind(debt.backend);
 f.backend.isOwnedSandboxAdmissionCurrent=proof=>debt.backend.isOwnedSandboxAdmissionCurrent(proof);
 f.backend.deadlineRecoveryPending=()=>debt.backend.deadlineRecoveryPending();
 f.backend.sandboxAdmissionPending=debt.backend.sandboxAdmissionPending?.bind(debt.backend);
 f.policy.observeLending=()=>({waits:debt.backend.cleanupSlotHold('codex')?[{reason:'cleanup_pending',nextEvaluationAtMs:f.clock.now()+120000}]:[]});
 const controller=new AbortController(),worker=createLender({...f.runOptions,client:f.client,backend:f.backend,policy:f.policy,adapters:f.adapters,clock:f.clock,approve:async()=>true,credentialValues:async()=>[],accountKey:'codex'}),running=worker.start(controller.signal);
 try{const until=Date.now()+3000;while(!f.calls.some(([kind])=>kind==='run')&&Date.now()<until){f.clock.advance(250);await new Promise(resolve=>setTimeout(resolve,10));}assert.ok(f.calls.some(([kind])=>kind==='run'),'B starts before A recovery is released');}
 finally{controller.abort();resume();await recovery;await running;}
});

test('B can persist a fresh reservation while A has unproven cleanup',{timeout:10000},async t=>{
 const f=fixture(t,{kit:false,live:true}),workers=[],options=[],controller=new AbortController();
 let disk={jobs:0,milliseconds:0,accounts:{'claude:0':{jobs:0,milliseconds:0,pending:{attemptId:'old-A',resources:{cpu:2,memoryBytes:4*1024**3}}}}};
 const pool=createLendingPool({backend:f.backend,storage:{get:async()=>disk,set:async v=>{disk=v;},acquire:async()=>()=>{}},capacity:2,maxResources:{cpu:2,memoryBytes:4*1024**3},policy:{enabled:true,dailyJobs:null,dailyMinutes:null},adapters:[{spec:{harness_id:'claude-code-subscription'}},{spec:{harness_id:'codex'}}],createLender:opts=>{options.push(opts);const facts=poolFactCache(opts.policy);const worker={start:async signal=>{await facts.refresh();if(!signal.aborted)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));},refreshAdmission:()=>facts.refresh(),getState:()=>({status:opts.accountKey==='claude'?'stopping':'idle',reason:opts.accountKey==='claude'?'cleanup_pending':null,current:null}),admits:()=>facts.reason,cessation:()=>({proven:true})};workers.push(worker);return worker;}});
 const running=pool.start(controller.signal);t.after(async()=>{controller.abort();await running;});
 while(workers.length<2)await new Promise(resolve=>setImmediate(resolve));
 await pool.refreshAdmission();
 const store=options[1].policy.storage,current=await store.get();assert.equal(pool.admits(),null);
 await assert.doesNotReject(store.set({...current,pending:{attemptId:'fresh-B',resources:{cpu:2,memoryBytes:4*1024**3}}}));
 assert.equal(disk.accounts['codex:0'].pending.attemptId,'fresh-B');assert.equal(disk.accounts['claude:0'].pending.attemptId,'old-A');
});

test('a foreign-scope retained row stays visible and reserves only the fallback slot',async t=>{
 const f=fixture(t,{kit:false,live:true}),row={...f.rows[0],owner_scope:'0'.repeat(64)},file=path.join(f.directory,row._cleanupId+'.json');
 fs.writeFileSync(file,JSON.stringify(row));const bytes=fs.readFileSync(file);
 const status=f.backend.cleanupStatus();assert.equal(status.items.length,1);assert.equal(status.items[0].name,row.sandbox_id);
 assert.equal(f.backend.cleanupSlotHold('claude',{fallback:true}),'cessation_unverified');assert.equal(f.backend.cleanupSlotHold('codex'),null);
 await f.backend.reapCleanup();assert.deepEqual(fs.readFileSync(file),bytes);assert.equal(f.removals(),0);
});
