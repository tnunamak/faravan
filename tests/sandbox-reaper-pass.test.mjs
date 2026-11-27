import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSandboxCleanupJournal} from '../lib/sandbox-cleanup-journal.mjs';
import {acquireProcessLockSync} from '../lib/v1/lock.mjs';
import {runDeadlineCommand} from '../lib/sandbox-deadline.mjs';

async function fixture(t,{destroy,onSummary,inspectPass}={}) {
  const root=await mkdtemp(join(tmpdir(),'reaper-pass-')),directory=join(root,'journal'),scratch=join(root,'scratch');
  await mkdir(scratch);let now=10;const summaries=[];
  const journal=createSandboxCleanupJournal({directory,scratchRoot:()=>scratch,home:()=>root,monotonic:()=>now,
    destroy:destroy??(async()=>{now+=7;}),inspectPass,onSummary:onSummary??(row=>summaries.push(row))});
  t.after(()=>rm(root,{recursive:true,force:true}));
  async function seed(n=1){
    const rows=[];
    for(let i=0;i<n;i++){
      const sandbox_id='wf-'+i.toString(16).padStart(16,'0'),handle={job_id:'private-job-'+i,sandbox_id,scratch_dir:await mkdtemp(join(scratch,'wf-job-'+sandbox_id+'-'))};
      journal.register(handle);journal.mark(handle,{create:'dispatched',absent_since:0});journal.finish(handle,{removed:false});rows.push(handle);
    }return rows;
  }
  return{journal,summaries,seed,directory,setNow:n=>{now=n;}};
}

test('one reaper summary per physical pass, not per coalesced caller',async t=>{
  let unblock,entered;const reached=new Promise(r=>{entered=r;}),held=new Promise(r=>{unblock=r;});
  const f=await fixture(t,{destroy:async()=>{entered();await held;f.setNow(17);}});await f.seed();
  const first=f.journal.reap();await reached;const second=f.journal.reap();assert.equal(first,second);unblock();await Promise.all([first,second]);
  assert.equal(f.summaries.length,1);
  assert.deepEqual(f.summaries[0],{event:'reaper_pass',duration_ms:7,budget_ms:null,budget_exhausted:false,rows_total:1,rows_visited:1,rows_attempted:1,rows_settled:0,rows_deferred:0,rows_locked:0,rows_watch:1,rows_legacy:0,rows_unknown:0,rows_foreign:0,inventory_calls:0,command_calls:0,outcome:'completed'});
});

test('reaper summaries cover contention, inventory failure, and pre-abort',async t=>{
  const f=await fixture(t,{inspectPass:async()=>{throw Error('private inventory detail');}});const [row]=await f.seed();
  const unlock=acquireProcessLockSync(join(f.directory,row._cleanupId+'.json.lock'));
  await f.journal.reap();unlock();
  assert.equal(f.summaries.length,1);assert.equal(f.summaries[0].rows_locked,1);assert.equal(f.summaries[0].rows_attempted,0);
  await f.journal.reap({signal:AbortSignal.abort()});
  assert.equal(f.summaries.length,2);assert.equal(f.summaries[1].outcome,'aborted');assert.equal(f.summaries[1].rows_deferred,1);
  assert.equal(JSON.stringify(f.summaries).includes('private'),false);
});

test('summary throw/rejection/re-entry cannot fail cleanup or duplicate a pass',async t=>{
  for(const kind of ['throw','reject','reenter']){
    let count=0;const f=await fixture(t,{onSummary:()=>{count++;if(kind==='throw')throw Error('logger');if(kind==='reject')return Promise.reject(Error('logger'));if(kind==='reenter')void f.journal.reap();}});
    await f.seed();await f.journal.reap();await new Promise(resolve=>setImmediate(resolve));assert.equal(count,1);
  }
});

test('deadline transport counts real dispatch and ignores a throwing metric callback',async()=>{
  let count=0;
  const result=await runDeadlineCommand(process.execPath,['-e','process.stdout.write("ok")'],{env:process.env,onCommand:()=>{count++;throw Error('metric only');}});
  assert.equal(count,1);assert.equal(result.code,0);assert.equal(result.stdout,'ok');
});

test('reaper summary distinguishes cap deferral, unknown input and foreign input',async t=>{
  const f=await fixture(t);const rows=await f.seed(34);
  const files=fs.readdirSync(f.directory).filter(n=>n.endsWith('.json')).sort();
  fs.writeFileSync(join(f.directory,files[0]),'not-json');
  const foreign=JSON.parse(fs.readFileSync(join(f.directory,files[1]),'utf8'));foreign.owner_scope='foreign';fs.writeFileSync(join(f.directory,files[1]),JSON.stringify(foreign));
  await f.journal.reap();const summary=f.summaries[0];
  assert.equal(summary.rows_total,34);assert.equal(summary.rows_visited,32);assert.equal(summary.rows_deferred,2);
  assert.equal(summary.rows_unknown,1);assert.equal(summary.rows_foreign,1);assert.equal(summary.rows_attempted,30);assert.equal(summary.rows_watch,30);
  assert.equal(rows.length,34);
});

test('settled means record deletion, while a resolver-suppressed reap emits nothing',async t=>{
  const f=await fixture(t,{destroy:async row=>f.journal.finish(row,{removed:true,sbx_home:row.sbx_home,scratch_removed:true,policy_removed:true})});await f.seed();
  await f.journal.reap();assert.equal(f.summaries[0].rows_settled,1);
  let enter,release;const reached=new Promise(r=>{enter=r;}),held=new Promise(r=>{release=r;});
  const g=await fixture(t,{destroy:async()=>{enter();await held;}});await g.seed();
  const pending=g.journal.resolveJobs(['private-job-0']);await reached;await g.journal.reap();assert.equal(g.summaries.length,0);release();await pending;
});

test('unreadable journal still emits one failed summary',async t=>{
  const f=await fixture(t);fs.writeFileSync(f.directory,'not a directory');
  await assert.rejects(f.journal.reap());assert.equal(f.summaries.length,1);assert.equal(f.summaries[0].outcome,'failed');
});

test('failed inventory and mid-pass abort emit one final summary',async t=>{
  const controller=new AbortController();const f=await fixture(t,{inspectPass:async()=>{throw Error('inventory');},destroy:async()=>controller.abort()});
  await f.seed(3);await f.journal.reap({signal:controller.signal});
  assert.equal(f.summaries.length,1);assert.equal(f.summaries[0].outcome,'aborted');assert.equal(f.summaries[0].rows_attempted,1);assert.equal(f.summaries[0].rows_deferred,2);
});

test('successful empty physical passes emit no summary',async t=>{
  const f=await fixture(t);
  await f.journal.reap();await f.journal.reap();
  assert.deepEqual(f.summaries,[]);
});

test('a held row still emits to an injected sink after empty passes',async t=>{
  const f=await fixture(t);
  await f.journal.reap();await f.seed();await f.journal.reap();
  assert.equal(f.summaries.length,1);
  assert.equal(f.summaries[0].rows_attempted,1);
  assert.equal(f.summaries[0].rows_settled,0);
});
