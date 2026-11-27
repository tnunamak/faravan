import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createSandboxCleanupJournal} from '../lib/sandbox-cleanup-journal.mjs';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import {createDeadlineRecoveryGate} from '../lib/v1/deadline-recovery-gate.mjs';

// HOST MUST RUN: the ordinary app fixture imports the full production graph.
// The journal is real; cleanup uses deterministic expired synthetic targets.
function fixture(t) {
  const root=fs.mkdtempSync(join(tmpdir(),'cleanup-unreadable-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const directory=join(root,'journal'),scratch=join(root,'scratch');
  fs.mkdirSync(directory);fs.mkdirSync(scratch);
  const clock=()=>({wall:1000,boot_id:'unreadable-test',boot_ms:1000}),cleaned=[];
  const journal=createSandboxCleanupJournal({directory,scratchRoot:()=>scratch,home:()=>root,
    destroy:async row=>{
      cleaned.push(row.sandbox_id);
      // A real receipt names the sandbox home it removed from; finish keeps the record without it.
      const result={removed:true,sbx_home:row.sbx_home,scratch_removed:true,policy_removed:true};
      journal.finish(row,result);return result;
    }});
  const manager={active:async()=>false,register:async()=>assert.fail('expired rows do not need a new guard')};
  const backend={recoverSandboxDeadlines:()=>journal.recoverDeadlines(manager,{clock}),cleanupStatus:()=>journal.status()};
  const gate=createDeadlineRecoveryGate({backend});
  const row=i=>{
    const id=randomUUID(),name='wf-'+i.toString(16).padStart(16,'0');
    return {version:2,_cleanupId:id,owner_scope:sandboxOwnerScope(),sbx_home:root,job_id:'job-'+i,sandbox_id:name,
      scratch_dir:join(scratch,'wf-job-'+name+'-'+randomUUID()),create:'dispatched',
      compute_created:true,create_settled:true,compute_stopped:false,data_cleanup:'owned',policy_cleanup:'owned',
      deadline_at:900,deadline_clock:{version:1,boot_id:clock().boot_id,boot_at:900}};
  };
  return {root,directory,journal,gate,cleaned,row};
}

for(const wholeJournal of [false,true])test(wholeJournal
  ?'startup serves status without a global stop when the journal cannot be opened'
  :'startup serves one unreadable count among twelve while eleven recover and lending is not globally held',async t=>{
  const {appFixture,syntheticBackend,api,waitFor}=await import('./helpers/v1-app-fixture.mjs');
  const f=fixture(t),host=await appFixture(t),id=randomUUID(),file=join(f.directory,id+'.json');
  const bytes=Buffer.from('{"PRIVATE_RECOVERY":');
  if(wholeJournal){fs.rmdirSync(f.directory);fs.writeFileSync(f.directory,bytes);}
  else {
    fs.writeFileSync(file,bytes);
    for(let i=1;i<=11;i++){const row=f.row(i);fs.writeFileSync(join(f.directory,row._cleanupId+'.json'),JSON.stringify(row));}
  }
  const manager={active:async()=>false,register:async()=>assert.fail('expired rows do not need a guard')};
  const backend=syntheticBackend(host.root),clock=()=>({wall:1000,boot_id:'unreadable-test',boot_ms:1000});
  let report;
  backend.recoverSandboxDeadlines=async()=>report=await f.journal.recoverDeadlines(manager,{clock});
  backend.cleanupStatus=()=>({...f.journal.status(),...(report?{deadline_recovery:report}:{})});
  const {app}=await host.start('cleanup-recovery-'+wholeJournal,{backend,freshLending:'automatic',
    lendingProbeRunner:async()=>({ok:false,reason:'test_unavailable'})});
  const status=await waitFor(async()=>{
    const value=await api(app,'/api/status');
    return wholeJournal?value.deadline_recovery?.state==='clear'&&value
      :value.deadline_recovery?.unreadable_records===1&&value;
  },'recovery status');
  const home=await api(app,'/api/home');
  assert.doesNotMatch(JSON.stringify(status.deadline_recovery),/PRIVATE_RECOVERY|ENOTDIR|cleanup-unreadable-|SyntaxError|Unexpected token/);
  if(wholeJournal) {
    // Cleanup isolation rule: unreadable cleanup state is local, never a whole-lender stop.
    assert.equal(status.blockers.some(row=>row.kind==='cessation_unverified'),false);
    assert.equal(home.cleanup.unreadable_records,0);
    assert.deepEqual(fs.readFileSync(f.directory),bytes);
  } else {
    assert.equal(status.blockers.some(row=>row.kind==='cessation_unverified'),false);
    // SANDBOX-CLEANUP-RECOVERY.md, Status and checks: one unreadable record among twelve does not globally hold lending.
    // Status exposes no admission object unless admission is evaluated, so check the recovery hold it does expose.
    assert.equal(status.deadline_recovery.recovery_hold,undefined);
    assert.equal(home.cleanup.unreadable_records,1);
    assert.equal(home.cleanup.unreadable_message,'1 cleanup record could not be read');
    assert.equal(status.deadline_recovery.unreadable_message,'1 cleanup record could not be read');
    assert.equal(f.cleaned.length,11);
    assert.deepEqual(fs.readFileSync(file),bytes);
    assert.deepEqual(fs.readdirSync(f.directory).filter(name=>name.endsWith('.json')),[id+'.json']);
  }
  await api(app,'/api/readiness?refresh=true');
  const again=await api(app,'/api/status');
  assert.equal(again.blockers.some(row=>row.kind==='cessation_unverified'),false);
});
