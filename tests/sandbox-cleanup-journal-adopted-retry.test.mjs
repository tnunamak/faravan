import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import {createSandboxCleanupJournal} from '../lib/sandbox-cleanup-journal.mjs';
import {watchProofStore} from '../lib/v1/sandbox-watch-proofs.mjs';

// After a pass resolves a watched row, it retries the row's revocation debts and saves their state. That retry waits, and by
// then another actor may have finished the row and deleted it, or handed the name over again. A deleted record stays
// deleted, and a newer hand-off is not overwritten.
const NAME='wf-0123456789abcdef';
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'wf-journal-retry-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const directory=join(root,'journal'),scratch=join(root,'scratch');mkdirSync(directory);mkdirSync(scratch);
  const id=randomUUID(),row={version:2,_cleanupId:id,owner_scope:sandboxOwnerScope(),sbx_home:root,job_id:'job-retry',sandbox_id:NAME,
    scratch_dir:join(scratch,'wf-job-'+NAME+'-'+randomUUID()),create:'dispatched',compute_created:false,create_settled:false,compute_stopped:false,
    data_cleanup:'pending',policy_cleanup:'pending',exec_fenced:true,watch_state:'watch_adopted',watch_generation:randomUUID(),watch_challenge:randomUUID()};
  const record=join(directory,id+'.json');
  writeFileSync(record,JSON.stringify(row));
  return {root,directory,scratch,id,row,record};
}
async function savedProof(f) {
  const store=watchProofStore({home:f.root,owner:sandboxOwnerScope()});
  await store.observe(f.row,true,{listedAt:await store.stamp()});await store.observe(f.row,false,{listedAt:await store.stamp()});
}
function journalWith(f,{duringRetry}) {
  let journal;
  journal=createSandboxCleanupJournal({directory:f.directory,scratchRoot:()=>f.scratch,home:()=>f.root,destroy:async()=>({removed:false}),
    // The backend closes what it can and keeps the row: compute is proven gone, scratch and rules are not yet.
    resolveAdopted:async locked=>{journal.finish(locked,{removed:true,sbx_home:locked.sbx_home,scratch_removed:false,policy_removed:false});return {};},
    retryWatchDebts:async()=>{await duringRetry();return {policy_revoked:false};}});
  return journal;
}

test('a cleanup record that another actor finished and deleted during the retry stays deleted',async t=>{
  const f=fixture(t);await savedProof(f);
  const journal=journalWith(f,{duringRetry:async()=>{
    // The pass has released its locks. Another actor completes the cleanup and deletes the record.
    unlinkSync(f.record);
  }});
  await journal.reap();
  assert.equal(existsSync(f.record),false,'the deleted record is not written back');
});

test('a newer hand-off of the name is not overwritten by the retry of an older one',async t=>{
  const f=fixture(t);await savedProof(f);
  const newer={...f.row,watch_generation:randomUUID(),watch_challenge:randomUUID(),watch_ack:{challenge:'newer',binary:'/fixture/watcher'}};
  const journal=journalWith(f,{duringRetry:async()=>{writeFileSync(f.record,JSON.stringify(newer));}});
  await journal.reap();
  const saved=JSON.parse(readFileSync(f.record,'utf8'));
  assert.equal(saved.watch_challenge,newer.watch_challenge,'the newer challenge stays');
  assert.deepEqual(saved.watch_ack,newer.watch_ack,'the newer acknowledgment stays');
  assert.equal(saved.watch_debt_retry,undefined,'nothing from the older retry is written onto the newer hand-off');
});

test('the retry of a row still owned by the pass records its debts',async t=>{
  const f=fixture(t);
  const journal=createSandboxCleanupJournal({directory:f.directory,scratchRoot:()=>f.scratch,home:()=>f.root,destroy:async()=>({removed:false}),
    resolveAdopted:async()=>({unknown:'present_without_receipt'}),retryWatchDebts:async()=>({policy_revoked:false})});
  await journal.reap();
  const saved=JSON.parse(readFileSync(f.record,'utf8'));
  assert.equal(saved.watch_debt_retry?.unknown,'present_without_receipt');
  assert.equal(saved.watch_challenge,f.row.watch_challenge);
});
