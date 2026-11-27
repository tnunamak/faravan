import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createSandboxCleanupJournal} from '../lib/sandbox-cleanup-journal.mjs';
import {readSbxOwner} from '../lib/sbx-daemon-owner.mjs';

// The actual journal, not a backend slice. Its dependencies stay within the
// allowed journal/ownership/lock graph. No backend, executor, sbx, Docker,
// service manager, detached guard, provider or network is invoked.
test('an overdue never-observed create with an active owner remains per-target debt after finish watching',async t=>{
  assert.equal(process.env.HOME,process.env.FARAVAN_TEST_HOME);
  assert.ok(readSbxOwner(),'the no-browser prelude seeds a synthetic sandbox owner');
  const root=fs.mkdtempSync(join(process.env.FARAVAN_TEST_HOME,'active-owner-deadline-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const directory=join(root,'cleanup'),scratchRoot=join(root,'scratch'),home=join(root,'sbx');
  fs.mkdirSync(scratchRoot);fs.mkdirSync(home);
  const sandboxId='wf-0123456789abcdef',scratch=join(scratchRoot,`wf-job-${sandboxId}-${randomUUID()}`);
  fs.mkdirSync(scratch);fs.writeFileSync(join(scratch,'retained.txt'),'keep until compute is proven gone');
  const calls=[];
  const unexpected=action=>async()=>{calls.push(action);throw new Error(`unexpected ${action}`);};
  const journal=createSandboxCleanupJournal({directory,scratchRoot:()=>scratchRoot,home:()=>home,
    monotonic:()=>0,destroy:unexpected('destroy'),inspectLegacy:unexpected('legacy inventory')});
  let activeChecks=0;
  const manager={active:async()=>{activeChecks++;return false;},register:unexpected('guard register'),cancel:unexpected('guard cancel')};
  let at=900_000;
  const clock=()=>({wall:at,boot_id:'fake-active-owner-boot',boot_ms:at});
  const handle={job_id:'active-owner-create',sandbox_id:sandboxId,scratch_dir:scratch,sbx_home:home,
    deadline_at:1_000_000,deadline_clock:{version:1,boot_id:'fake-active-owner-boot',boot_at:1_000_000}};
  const session={active:true,unproven:new Set(),invalidate:()=>calls.push('invalidate')};
  journal.register(handle,{session});
  assert.equal(journal.mark(handle,{create:'dispatched',compute_created:false,create_settled:false,
    absent_since:800_000,deadline_enforcer:{kind:'guard',pid:900001,start:'fake-process-start',binary:'/fake/sbx'}}),true);
  journal.finish(handle,{removed:false,scratch_removed:false,policy_removed:false,watching:true});
  // finish releases the preparation lease, but a live owner and its unresolved
  // create remain. Therefore the overdue result must not be a lock side effect.
  assert.equal(journal.mark(handle,{compute_stopped:true}),false,'the preparation lease was released');
  const file=join(directory,handle._cleanupId+'.json'),before=fs.readFileSync(file,'utf8');
  const entriesBefore=fs.readdirSync(directory).sort();
  assert.equal(session.active,true);assert.equal(session.unproven.has(handle._cleanupId),true);
  assert.equal(journal.authority(handle)?.create,'dispatched');
  assert.equal(journal.authority(handle)?.compute_created,false);
  assert.equal(journal.authority(handle)?.create_settled,false);
  assert.equal(journal.status().compute_cleanup_pending,1);
  // An owner alone is never protection. Both before and after expiry the row
  // stays deferred; only a read-only enforcer check is permitted.
  const check=async()=>{
    const report=await journal.recoverDeadlines(manager,{clock,validateRow:row=>row.sbx_home===home});
    assert.equal(report.complete,false);assert.equal(report.fatal,undefined);
    assert.equal(report.rows.length,1);assert.equal(report.rows[0].id,handle._cleanupId);
    assert.equal(report.rows[0].status,'in_progress');assert.notEqual(report.rows[0].protected,true);
  };
  await check();
  at=1_000_001;
  for(let attempt=0;attempt<2;attempt++)
    await check();
  assert.equal(activeChecks,3);
  assert.deepEqual(calls,[],'recovery must neither register/cancel guards nor destroy a live-owner row');
  assert.equal(fs.readFileSync(file,'utf8'),before,'recovery must not rewrite the durable obligation');
  assert.deepEqual(fs.readdirSync(directory).sort(),entriesBefore,'recovery must not create or remove journal entries');
  assert.equal(fs.readFileSync(join(scratch,'retained.txt'),'utf8'),'keep until compute is proven gone');
  assert.equal(journal.closed(handle),false);assert.equal(journal.recorded(sandboxId),true);
  assert.equal(journal.authority(handle)?.compute_stopped,false);
  assert.equal(journal.status().compute_cleanup_pending,1);
  assert.equal(session.unproven.has(handle._cleanupId),true);
});
