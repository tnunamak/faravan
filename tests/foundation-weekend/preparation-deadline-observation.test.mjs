import '../helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DockerSbxBackend} from '../../lib/docker-backend.mjs';
import {createSandboxCleanupJournal} from '../../lib/sandbox-cleanup-journal.mjs';
import {createSandboxDeadlineManager, deadlineSupervisorPayload, deadlineBinding} from '../../lib/sandbox-deadline.mjs';

const context={jobId:'deadline-job',attemptId:'deadline-attempt',generation:1};
async function fixture(t) {
  const parent=path.join(os.homedir(),'.tmp');
  fs.mkdirSync(parent,{recursive:true,mode:0o700});
  const root=fs.mkdtempSync(path.join(parent,'preparation-deadline-'));
  fs.chmodSync(root,0o700);
  const directory=path.join(root,'journal'),scratchRoot=path.join(root,'scratch');
  fs.mkdirSync(scratchRoot,{mode:0o700});
  let mono=100,boot=1000,live=true,state,handle,releaseCleanup;
  const effects={prepare:0,start:0,cleanup:0,commands:0};
  const clock=()=>({wall:100000,boot_id:'synthetic-boot',boot_ms:boot});
  const journal=createSandboxCleanupJournal({directory,scratchRoot:()=>scratchRoot,home:()=>root,
    destroy:async()=>{effects.cleanup++;return {};}});
  t.after(()=>{releaseCleanup?.();if(handle)journal.finish(handle,{removed:false});fs.rmSync(root,{recursive:true,force:true});});
  const manager=createSandboxDeadlineManager({directory,binary:'/synthetic/sbx',clock,
    stateReader:()=>state,processStartSync:pid=>live&&pid===12345?'synthetic-start':null,
    run:async()=>{effects.commands++;throw Error('No command allowed');},
    spawnGuard:()=>{effects.commands++;throw Error('No guard launch allowed');}});
  const backend=Object.assign(Object.create(DockerSbxBackend.prototype),{
    cleanupJournal:journal,sandboxDeadlines:manager,monotonic:()=>mono,deadlineClock:clock,_now:()=>1234,
    ensureSandboxAdmission:async()=>{},assertDeadlineTargetClear(){},_assertCreateSignIn(){},_preparing:0,
    _prepare:async(_job,_shared,options)=>{
      effects.prepare++;
      const sandbox_id='wf-0000000000000001';
      handle={job_id:context.jobId,sandbox_id,scratch_dir:fs.mkdtempSync(path.join(scratchRoot,'wf-job-'+sandbox_id+'-')),
        deadline_at:options.deadlineAt,deadline_clock:options.deadlineClockData,
        _deadline:{endsAt:options.localDeadlineAt,expired:false,controller:new AbortController()}};
      journal.register(handle);
      journal.mark(handle,{create:'dispatched',compute_created:true,create_settled:true,
        deadline_enforcer:{kind:'guard',binary:'/synthetic/sbx',pid:12345,start:'synthetic-start'}});
      const row=journal.admissionAuthority(handle);
      state={binding:deadlineBinding(deadlineSupervisorPayload(row,'/synthetic/sbx',directory,'guard')),
        state:'armed',pid:12345,start:'synthetic-start'};
      return handle;
    },
    start:async()=>{effects.start++;throw Error('No start allowed');},
    cancel:async()=>{effects.cleanup++;throw Error('No cancel allowed');},
    destroy:async()=>{effects.cleanup++;throw Error('No destroy allowed');},
  });
  const caller=new AbortController();
  await backend.prepare({job_id:context.jobId,resources:{wall_seconds:60}},{preparationContext:context,signal:caller.signal});
  const positive=backend.getPreparationObservation(context);
  assert.equal(positive.state,'prepared');
  assert.equal(positive.observedAtMs,1234);
  assert.equal(journal.admissionAuthority({...handle}),null);
  backend._now=()=>9999; // Later reads must not restamp old preparation as fresh.
  return {backend,journal,handle,caller,effects,positive,
    localElapsed(){mono=handle._deadline.endsAt;},
    journalElapsed(){boot=handle.deadline_clock.boot_at;},
    loseGuard(){live=false;},
    replaceBinding(){journal.mark(handle,{deadline_enforcer:{kind:'guard',binary:'/synthetic/replacement',pid:12345,start:'synthetic-start'}});},
    invalidateDeadline(){const file=path.join(directory,handle._cleanupId+'.json');const row=JSON.parse(fs.readFileSync(file));row.deadline_clock.version=0;fs.writeFileSync(file,JSON.stringify(row));},
    holdCleanup(){handle._deadline.expired=true;handle._deadline.controller.abort();handle._deadline.cleanup=new Promise(resolve=>{releaseCleanup=resolve;});},
  };
}
for(const kind of ['localElapsed','journalElapsed','holdCleanup','loseGuard','replaceBinding','invalidateDeadline']) {
  test('preparation observation fails closed: '+kind,async t=>{
    const f=await fixture(t),before={...f.effects};
    f[kind]();
    assert.equal(f.caller.signal.aborted,false,'independent expiry is not caller cancellation');
    const observation=f.backend.getPreparationObservation(context);
    assert.equal(observation.state,'unknown');
    assert.equal(typeof observation?.then,'undefined','getter stays synchronous even with held cleanup');
    assert.deepEqual(f.effects,before,'display must not prepare, start, clean up or launch commands');
  });
}
test('observation needs synchronous guard proof and rejects a binding changed during observation',async t=>{
  const f=await fixture(t),sync=f.backend.sandboxDeadlines.activeSync,before={...f.effects};
  f.backend.sandboxDeadlines.activeSync=undefined;
  assert.equal(f.backend.getPreparationObservation().state,'unknown');
  f.backend.sandboxDeadlines.activeSync=()=>Promise.resolve(true);
  assert.equal(f.backend.getPreparationObservation().state,'unknown','thenable is not synchronous evidence');
  f.backend.sandboxDeadlines.activeSync=()=>{throw Error('unreadable guard');};
  assert.equal(f.backend.getPreparationObservation().state,'unknown');
  f.backend.sandboxDeadlines.activeSync=sync;
  assert.deepEqual(f.backend.getPreparationObservation(),f.positive,'successful reread keeps original timestamp');
  f.backend.sandboxDeadlines.activeSync=row=>{const active=sync(row);f.replaceBinding();return active;};
  assert.equal(f.backend.getPreparationObservation().state,'unknown','recheck binding after guard observation');
  assert.deepEqual(f.effects,before);
});
