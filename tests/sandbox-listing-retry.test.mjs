import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileSbx,receiptBackend,receiptedHandle} from './helpers/sandbox-receipt-fixture.mjs';

async function fixture(t,{results=[],sleep=async()=>{},timeout=30,midPass=false,release=true}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'listing-retry-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const sbx=fileSbx(root),delays=[];let calls=0;
  const backend=receiptBackend(root,sbx,{cleanupListingTimeoutMs:timeout,
    cleanupListingSleep:async(ms,options)=>{delays.push(ms);assert.equal(backend._preparing,0);return sleep(ms,options);},
    runCommand:async(args,options)=>{
      if(args[0]!=='ls')return sbx.run(args,options);
      calls++;const result=results[calls-1];
      if(result==='hang')return new Promise(()=>{});
      if(result instanceof Error)throw result;
      return result??sbx.run(args,options);
    }});
  const handle=await receiptedHandle(backend,{job_id:'retry-job'});
  t.after(()=>fs.rmSync(handle.scratch_dir,{recursive:true,force:true}));
  if(release)backend.cleanupJournal.finish(handle,{removed:false});
  // Use the real admission and recovery wrappers, with a bounded row action so
  // one pass has exactly one inventory boundary at the selected location.
  backend.cleanupJournal.recoverDeadlines=async(_deadlines,{signal})=>{
    if(midPass)await backend._rowRun(backend.cleanupJournal.authority(handle),['ls','--json'],{signal});
    return {complete:true,rows:[]};
  };
  return {root,backend,handle,delays,calls:()=>calls};
}
const valid={code:0,stdout:'[]',stderr:''};
const bad={code:1,stdout:'[]',stderr:'error: unavailable'};
for(const midPass of [false,true])for(const [kind,result]of Object.entries({exit:bad,stderr:{...valid,stderr:'warning'},timeout:'hang',throw:Error('transport down'),malformed:{...valid,stdout:'{'},daemon:Object.assign(Error('daemon unverified'),{code:'sbx_daemon_unavailable'})})) {
  test(`transient ${kind} listing recovers; mid-pass=${midPass}`,{timeout:2000},async t=>{
    const f=await fixture(t,{midPass,results:[...(midPass?[valid]:[]),result,valid]});
    assert.equal((await f.backend.recoverSandboxDeadlines()).complete,true);
    assert.equal(f.calls(),midPass?3:2);assert.deepEqual(f.delays,[1000]);
    assert.equal(f.backend.deadlineRecoveryHold(),null);
  });
}
for(const midPass of [false,true])test(`all rejected listings preserve the hold; mid-pass=${midPass}`,async t=>{
  const f=await fixture(t,{midPass,results:[...(midPass?[valid]:[]),bad,bad,bad]});
  const expected=f.backend._noteCleanupListingFailure(bad,1).recovery_hold;
  f.backend._cleanupListingFailure=null;
  await assert.rejects(f.backend.recoverSandboxDeadlines(),{code:'cessation_unverified'});
  assert.deepEqual(f.backend.deadlineRecoveryHold(),expected);
  assert.equal(f.calls(),midPass?4:3);assert.deepEqual(f.delays,[1000,3000]);
});
test('a valid present listing and a failed stop are never retried',async t=>{
  const present={...valid,stdout:JSON.stringify([{name:'wf-0123456789abcdef',status:'running'}])};
  const f=await fixture(t,{results:[present]});
  assert.deepEqual(await f.backend._rowRun(f.backend.cleanupJournal.authority(f.handle),['ls','--json']),present);
  assert.equal(f.calls(),1);assert.deepEqual(f.delays,[]);
  f.backend.runSbx=async()=>bad;
  assert.equal(await f.backend._rowRun(f.backend.cleanupJournal.authority(f.handle),['rm','--force',f.handle.sandbox_id]),bad);
  assert.deepEqual(f.delays,[]);
});
test('abort during backoff leaves no hold, row write or late listing',{timeout:1000},async t=>{
  const controller=new AbortController();let entered;
  const backoff=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{results:[bad],sleep:async(_ms,{signal})=>{
    entered();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }});
  const before=JSON.stringify(f.backend.cleanupJournal.authority(f.handle));
  const work=f.backend.recoverSandboxDeadlines({signal:controller.signal});
  await backoff;controller.abort(Error('cancel retry'));
  await assert.rejects(work,/cancel retry/);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls(),1);assert.equal(f.backend.deadlineRecoveryHold(),null);
  assert.equal(JSON.stringify(f.backend.cleanupJournal.authority(f.handle)),before);
});
for(const result of [bad,{...valid,stderr:'warning'},'hang'])test('transient listing permits real journal cleanup: '+String(result==='hang'?'timeout':result.code),async t=>{
  const f=await fixture(t,{results:[result,valid]});
  await f.backend.reapCleanup();
  assert.equal(f.backend.deadlineRecoveryHold(),null);
  assert.equal(f.backend.cleanupJournal.status().compute_cleanup_pending,0);
  assert.equal(f.backend.cleanupJournal.status().data_cleanup_pending,0);
  assert.deepEqual(f.delays,[1000]);
});

test('a sandbox still present after a refused stop keeps real cleanup debt immediately',async t=>{
  const f=await fixture(t,{release:false});
  fs.writeFileSync(path.join(f.root,'inventory.json'),JSON.stringify([f.handle.sandbox_id]));
  const run=f.backend.runSbx;let stops=0;
  f.backend.runSbx=async(args,options)=>{
    if(args[0]==='rm'){stops++;return bad;}
    return run(args,options);
  };
  const result=await f.backend.destroy(f.handle);
  assert.equal(result.removed,false);
  assert.equal(f.backend.cleanupJournal.status().compute_cleanup_pending,1);
  assert.equal(stops,1);assert.equal(f.calls(),2);assert.deepEqual(f.delays,[]);
});
