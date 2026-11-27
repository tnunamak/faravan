import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {appFixture,syntheticBackend,api,waitFor} from './helpers/v1-app-fixture.mjs';
import {fileSbx,receiptBackend,receiptJob} from './helpers/sandbox-receipt-fixture.mjs';
import {sandboxDeadlineUnit} from '../lib/sandbox-deadline.mjs';
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test('app startup runs deadline recovery before cleanup, checks or admission, and serves status meanwhile',async t=>{
  const f=await appFixture(t),backend=syntheticBackend(f.root),entered=gate(),resume=gate(),events=[];
  backend.recoverSandboxDeadlines=async()=>{events.push('deadline');entered.resolve();await resume.promise;events.push('recovered');return true;};
  backend.reapCleanup=async()=>{events.push('reap');};
  const starting=f.start('deadline-startup',{backend});
  let app;
  try {
    await entered.promise;
    // docs/design/SANDBOX-CLEANUP-RECOVERY.md: "The app still starts and serves status while recovery is pending or held."
    ({app}=await starting);
    assert.deepEqual(events,['deadline']);
    assert.ok(await api(app,'/api/status'));
  }finally{resume.resolve();}
  await waitFor(()=>events.includes('reap'),'cleanup after recovery');
  assert.ok(events.indexOf('recovered')<events.indexOf('reap'));
  assert.ok(await api(app,'/api/status'));
});

// Cleanup isolation rule keeps unproven daemon ownership global.
test('unproven startup daemon ownership holds admission and allows retry',async t=>{
  const f=await appFixture(t),backend=syntheticBackend(f.root),original=Object.assign(Error('deadline recovery unavailable'),{code:'daemon_owner_repair_required'});
  backend.recoverSandboxDeadlines=async()=>{throw original;};
  const {app}=await f.start('deadline-retry',{backend});
  assert.ok((await api(app,'/api/status')).blockers.some(row=>row.kind==='cessation_unverified'));
  backend.recoverSandboxDeadlines=async()=>true;
  await api(app,'/api/readiness?refresh=true');
  assert.equal((await api(app,'/api/status')).blockers.some(row=>row.kind==='cessation_unverified'),false);
});

for(const mode of ['success','refused','stalled'])test('Quit '+mode+' keeps independent protection until compute absence',async t=>{
  const f=await appFixture(t),name='deadline-quit-'+mode,home=await f.home(name),armed=new Set();
  const priorScratch=process.env.FARAVAN_SCRATCH_ROOT;
  process.env.FARAVAN_SCRATCH_ROOT=join(f.root,'deadline-scratch');fs.mkdirSync(process.env.FARAVAN_SCRATCH_ROOT);
  t.after(()=>{if(priorScratch===undefined)delete process.env.FARAVAN_SCRATCH_ROOT;else process.env.FARAVAN_SCRATCH_ROOT=priorScratch;});
  const sbx=fileSbx(join(f.root,'deadline-inventory'));
  const external={register:async row=>{armed.add(row.sandbox_id);return {kind:'systemd',unit:sandboxDeadlineUnit(row),binary:'/fake/sbx'};},
    active:async row=>armed.has(row.sandbox_id),cancel:async row=>{assert.equal(sbx.read().includes(row.sandbox_id),false);armed.delete(row.sandbox_id);return true;}};
  const compute=receiptBackend(f.root,sbx,{home,sandboxDeadlines:external});
  const handle=await compute.prepare(receiptJob());
  // A prior app left the running sandbox and its independent action behind.
  compute.cleanupJournal.finish(handle,{removed:false,scratch_removed:false,policy_removed:false});
  const backend=syntheticBackend(f.root);backend.sandboxOwnership=()=>compute.sandboxOwnership();
  backend.recoverSandboxDeadlines=()=>compute.recoverSandboxDeadlines();
  const reconcile=pending=>compute.reconcilePending(pending);
  backend.reconcilePending=mode==='stalled'?()=>new Promise(()=>{}):reconcile;
  const run=compute.runSbx;let failRemoval=mode==='refused';
  compute.runSbx=(args,options)=>failRemoval&&args[0]==='rm'?Promise.resolve({code:1,stdout:'',stderr:'unavailable'}):run(args,options);
  const {app}=await f.start(name,{backend,shutdownProofMs:500});
  const counters=join(home,'v1/app-counters.json'),pending={attemptId:'deadline-stop',jobId:handle.job_id,sandboxId:handle.sandbox_id,
    ...compute.sandboxOwnership(),attempt:{attempt_id:'deadline-stop',job_digest:'sha256:'+'a'.repeat(64),generation:1}};
  fs.writeFileSync(counters,JSON.stringify({pending}));
  try {
    if(mode!=='success') {
      await api(app,'/api/shutdown',{method:'POST',body:{},status:409});
      assert.equal(armed.has(handle.sandbox_id),true);assert.ok(compute.cleanupJournal.authority(handle).deadline_at);
      assert.ok(await api(app,'/api/status'));
      // The independent action bypasses both a hung callback and journal locks.
      await sbx.run(['rm','--force',handle.sandbox_id]);
      failRemoval=false;backend.reconcilePending=reconcile;
    }
    await api(app,'/api/shutdown',{method:'POST',body:{},status:202});await app.close();
    // Design "Release rule: no guard hand-off": the app never signals a guard. After proven absence the guard ends itself, by
    // reading its record or at its own deadline, so the app's only part is that the sandbox is gone.
    assert.equal(armed.has(handle.sandbox_id),true,'the app does not cancel the guard');assert.deepEqual(sbx.read(),[]);
  }finally{failRemoval=false;backend.reconcilePending=reconcile;await compute.reconcilePending(pending);await compute.destroy(handle);await app.close();}
});
