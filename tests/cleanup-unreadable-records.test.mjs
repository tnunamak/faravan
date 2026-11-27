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
import {cleanupStatusSummary} from '../lib/v1/cleanup-status.mjs';
import {cleanupStatusVM} from '../ui/v1/src/cleanup-status.mjs';
import {sandboxRemediationLines} from '../lib/sandbox-remediation.mjs';

// Real journal, gate and display modules. Cleanup is a deterministic fixture;
// full backend/app startup is covered by the host-only launcher tests.
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

test('one unreadable row among twelve stays unchanged while eleven recover and unrelated admission stays open',async t=>{
  const f=fixture(t),badId=randomUUID(),badFile=join(f.directory,badId+'.json'),bytes=Buffer.from('{"PRIVATE_UNREADABLE":');
  fs.writeFileSync(badFile,bytes);
  for(let i=1;i<=11;i++){const row=f.row(i);fs.writeFileSync(join(f.directory,row._cleanupId+'.json'),JSON.stringify(row));}
  assert.equal(await f.gate.retry(),true);
  assert.equal(f.gate.current(),null);assert.doesNotThrow(()=>f.gate.assertReady());
  assert.equal(f.cleaned.length,11);
  const recovery=f.gate.status();assert.equal(recovery.rows.filter(row=>row.status==='resolved').length,11);
  assert.equal(recovery.debt.length,1);assert.equal(recovery.debt[0].id,badId);assert.equal(recovery.debt[0].name,undefined);
  const status=cleanupStatusSummary(f.journal.status());
  assert.equal(status.unreadable_records,1);
  assert.equal(status.unreadable_message,'1 cleanup record could not be read');
  const view=cleanupStatusVM(status);assert.equal(view.unreadable.line,'1 cleanup record could not be read');
  assert.doesNotMatch(JSON.stringify({status,view}),/PRIVATE_UNREADABLE|verdict|receipt|attempt|settled|lease|No new jobs/i);
  assert.deepEqual(fs.readFileSync(badFile),bytes);
  assert.deepEqual(fs.readdirSync(f.directory).filter(name=>name.endsWith('.json')),[badId+'.json']);
});

// Cleanup isolation rule: only service or daemon ownership failures hold globally.
test('an unreadable journal stays unchanged without a global stop',async t=>{
  const f=fixture(t);fs.rmdirSync(f.directory);fs.writeFileSync(f.directory,'PRIVATE_JOURNAL');
  assert.equal(await f.gate.retry(),false);assert.equal(f.gate.status().state,'clear');
  f.gate.assertReady();assert.equal(f.gate.current(),null);
  assert.doesNotMatch(JSON.stringify(f.gate.status()),/PRIVATE_JOURNAL|ENOTDIR|cleanup-unreadable-/);
  assert.equal(f.journal.status().unreadable_records,0,'a whole-journal failure is not one bad row');
  assert.equal(fs.readFileSync(f.directory,'utf8'),'PRIVATE_JOURNAL');
});

for(const kind of ['no name','invalid fields','symlink'])test(kind+' is counted without rewriting a record or following a link',async t=>{
  const f=fixture(t),row=f.row(1),file=join(f.directory,row._cleanupId+'.json');
  if(kind==='no name')delete row.sandbox_id;
  if(kind==='invalid fields')row.deadline_at='PRIVATE_INVALID';
  const bytes=JSON.stringify(row),target=join(f.root,'outside');
  if(kind==='symlink'){fs.writeFileSync(target,bytes);fs.symlinkSync(target,file);}else fs.writeFileSync(file,bytes);
  assert.equal(await f.gate.retry(),true);assert.equal(f.gate.current(),null);
  const status=f.journal.status();assert.equal(status.unreadable_records,1);
  assert.equal(cleanupStatusSummary(status).unreadable_message,'1 cleanup record could not be read');
  assert.equal(fs.readFileSync(file,'utf8'),bytes);assert.deepEqual(f.cleaned,[]);
  if(kind==='symlink')assert.equal(fs.lstatSync(file).isSymbolicLink(),true);
  if(kind==='invalid fields')assert.equal(f.gate.status().debt[0].name,row.sandbox_id);
});

test('unreadable count copy uses singular/plural and ignores untrusted supplied messages',()=>{
  for(const count of [1,2,12]) {
    const summary=cleanupStatusSummary({unreadable_records:count,unreadable_message:'PRIVATE receipt lease /raw/path'});
    const expected=count===1?'1 cleanup record could not be read':count+' cleanup records could not be read';
    assert.equal(summary.unreadable_message,expected);
    assert.equal(cleanupStatusVM(summary).unreadable.line,expected);
  }
  for(const value of [-1,0.5,NaN,Infinity,'2',null,undefined]) {
    const summary=cleanupStatusSummary({unreadable_records:value,unreadable_message:'PRIVATE'});
    assert.equal(summary.unreadable_records,undefined);assert.equal(summary.unreadable_message,undefined);
    assert.equal(cleanupStatusVM({unreadable_records:value,unreadable_message:'PRIVATE'}).unreadable,null);
  }
  assert.equal(cleanupStatusSummary({unreadable_records:0}).unreadable_message,undefined);
  assert.equal(cleanupStatusVM({unreadable_records:0}).unreadable,null);
  const lines=sandboxRemediationLines([{reason:'unsafe_record'},{reason:'unsafe_record',name:'wf-0123456789abcdef'}]);
  assert.doesNotMatch(lines.join(' '),/No new jobs|PRIVATE|undefined|HOME|verdict|receipt|attempt|settled|lease/i);
});
