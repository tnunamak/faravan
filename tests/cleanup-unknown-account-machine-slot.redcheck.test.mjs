import {poolFactCache} from './helpers/pool-fact-cache.mjs';
import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileSbx,receiptBackend} from './helpers/sandbox-receipt-fixture.mjs';
import {createLendingPool} from '../lib/v1/lending-pool.mjs';

// One retained cleanup row whose compute may still run and whose account is unknown
// (no account_key), plus Claude and Codex workers in a one-machine pool.
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'unknown-debt-slot-')),saved=process.env.FARAVAN_SBX_HOME;
  process.env.FARAVAN_SBX_HOME=path.join(root,'sbx');
  t.after(()=>{if(saved===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=saved;fs.rmSync(root,{recursive:true,force:true});});
  const sbx=fileSbx(root),run=sbx.run,rows=[],directory=path.join(root,'profile/v1/sandbox-cleanup');
  const present=true;
  sbx.run=async(args,options)=>{
    if(args[0]==='ls')return {code:0,stdout:JSON.stringify(present?rows.map(r=>({name:r.sandbox_id})):[]),stderr:''};
    if(args[0]==='policy'&&args[1]==='ls')return {code:0,stdout:JSON.stringify({rules:[]}),stderr:''};
    return run(args,options);
  };
  const backend=receiptBackend(root,sbx,{onReaperSummary:()=>{},storage:{release:async()=>{}}});
  fs.mkdirSync(directory,{recursive:true});
  const id=randomUUID(),name='wf-'+'0'.repeat(15)+'1';
  // account_key is absent, so this row's ownership is unknown; compute_stopped is false, so it may still run.
  const row={version:2,_cleanupId:id,...backend.sandboxOwnership(),job_id:'fixture-unknown',sandbox_id:name,
    scratch_dir:path.join(root,'scratch','wf-job-'+name+'-fixture'),create:'dispatched',compute_created:true,
    create_settled:false,compute_stopped:false,data_cleanup:'removed',policy_cleanup:'blocked',
    absent_since:Date.now()-60*3600000,watch_state:'watch_adopted',exec_fenced:true,create_incarnation:id,
    watch_generation:'fixture',watch_challenge:'fixture',
    watch_debt_retry:{policy_revoked:true,scratch:'awaiting_compute',storage:'awaiting_compute',name:'reserved'}};
  rows.push(row);fs.writeFileSync(path.join(directory,id+'.json'),JSON.stringify(row));
  fs.writeFileSync(path.join(directory,name+'.scope.reserved'),JSON.stringify({id,owner_scope:row.owner_scope,sbx_home:row.sbx_home,sandbox_id:name}));
  return {backend,row};
}

test('one unknown-account cleanup debt reserves the single machine slot',async t=>{
  const f=fixture(t);
  // The rule: an unknown-account compute debt reserves one machine slot, so a
  // one-machine pool has no slot left for any worker, whatever its provider.
  const obligations=f.backend.cleanupJournal.obligations();
  assert.equal(obligations.length,1);
  assert.equal(obligations[0].compute_may_run,true);
  assert.equal(obligations[0].account_key,null);
  const workers=[];
  let disk={jobs:0,milliseconds:0,accounts:{}};
  const controller=new AbortController();
  const pool=createLendingPool({
    backend:f.backend,
    storage:{get:async()=>disk,set:async value=>{disk=value;},acquire:async()=>()=>{}},
    capacity:1,
    policy:{enabled:true,dailyJobs:null,dailyMinutes:null,lendingPolicy:{accountSlots:1,machineSlots:1}},
    adapters:[{spec:{harness_id:'claude-code-subscription'}},{spec:{harness_id:'codex'}}],
    createLender:opts=>{
      const facts=poolFactCache(opts.policy);const worker={start:async signal=>{await facts.refresh();if(!signal.aborted)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));},refreshAdmission:()=>facts.refresh(),
        getState:()=>({status:'idle',reason:null,current:null}),
        admits:()=>facts.reason,
        cessation:()=>({proven:true})};
      workers.push({accountKey:opts.accountKey,worker});return worker;
    }});
  const running=pool.start(controller.signal);
  t.after(async()=>{controller.abort();await running;});
  while(workers.length<2)await new Promise(resolve=>setImmediate(resolve));
 await pool.refreshAdmission();
  const claude=workers.find(w=>w.accountKey==='claude').worker,codex=workers.find(w=>w.accountKey==='codex').worker;
  // The row is live debt: the fallback worker already refuses on it.
  assert.notEqual(claude.admits(),null,'the retained row must still hold the fallback worker');
  assert.notEqual(codex.admits(),null,
    'unknown-account compute debt must reserve the one machine slot, so Codex must not admit');
});
