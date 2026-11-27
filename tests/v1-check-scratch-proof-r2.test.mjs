import './helpers/no-browser.mjs';
import {legacySandboxNameFor as testSandboxName} from '../lib/sandbox-name.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCheckSandboxes} from '../lib/v1/check-sandboxes.mjs';
import {_internal} from '../lib/docker-backend.mjs';

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'r2-check-proof-')),file=join(root,'checks.json');
  const job_id='wf-pull-0000000000000000-71234567',sandbox_id=testSandboxName(job_id);
  const scratch_dir=await mkdtemp(join(_internal.scratchRoot(),'wf-job-'+sandbox_id+'-'));
  t.after(async()=>{await rm(scratch_dir,{recursive:true,force:true});await rm(root,{recursive:true,force:true});});
  await writeFile(join(scratch_dir,'source'),'private diagnostic source');
  const backend={prepare:async()=>({job_id,sandbox_id,scratch_dir}),destroy:async()=>({removed:true}),
    runSbx:async()=>({code:0,stdout:'[]'})};
  const checks=createCheckSandboxes({backend,file,now:()=>0,timeoutMs:1});
  const handle=await checks.backend.prepare({job_id});
  const restart=()=>createCheckSandboxes({backend,file,now:()=>2});
  // An expired lease is forgotten. Its scratch stays with the backend's
  // cleanup record, which removes it through that dispatch's own receipt.
  const recover=async()=>{
    let destroyed=0;backend.destroy=async()=>{destroyed++;return {removed:true,scratch_removed:true};};
    assert.deepEqual(await restart().reap(),{forgotten:[job_id]});
    assert.equal(destroyed,0);
    assert.equal(await readFile(join(scratch_dir,'source'),'utf8'),'private diagnostic source');
    assert.deepEqual(JSON.parse(await readFile(file,'utf8')),[]);
  };
  return {file,handle,checks,restart,recover,scratch_dir};
}

test('R2 a check destroy without scratch proof keeps its lease and the private source',async t=>{
  const f=await fixture(t);
  await f.checks.backend.destroy(f.handle);
  assert.equal(await readFile(join(f.scratch_dir,'source'),'utf8'),'private diagnostic source');
  assert.equal(JSON.parse(await readFile(f.file,'utf8')).length,1,'missing scratch evidence retains cleanup debt');
  await f.recover();
});

test('R2 the check reaper never removes scratch it does not own',async t=>{
  const f=await fixture(t);
  await f.recover();
});
