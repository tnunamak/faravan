import './helpers/no-browser.mjs';
import {legacySandboxNameFor as testSandboxName} from '../lib/sandbox-name.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCheckSandboxes} from '../lib/v1/check-sandboxes.mjs';
import {_internal} from '../lib/docker-backend.mjs';
const check='wf-pull-0000000000000000-01234567',job='wf-pull-123456789abcdef0-01234567';
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'spk-check-journal-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const file=join(root,'checks.json'),calls=[];
  let listing=[];
  const backend={
    async prepare(spec){const rows=JSON.parse(await readFile(file,'utf8'));assert.equal(rows[0].job_id,spec.job_id,'journal is durable before prepare');return {job_id:spec.job_id,sandbox_id:testSandboxName(spec.job_id),scratch_dir:join(_internal.scratchRoot(),'wf-job-'+testSandboxName(spec.job_id)+'-fake')};},
    async destroy(handle){calls.push(handle.sandbox_id);return {removed:true,scratch_removed:true};},
    async runSbx(){return {code:0,stdout:JSON.stringify(listing)};},
  };
  return {file,calls,backend,setListing:value=>listing=value};
}
test('checks are journaled before prepare and forgotten only after proven removal',async t=>{
  const f=await fixture(t),checks=createCheckSandboxes({...f,now:()=>100,timeoutMs:50});
  const handle=await checks.backend.prepare({job_id:check});
  assert.equal(JSON.parse(await readFile(f.file,'utf8'))[0].expires_at,150);
  await checks.backend.destroy(handle);assert.deepEqual(JSON.parse(await readFile(f.file,'utf8')),[]);
});
test('the reaper forgets only expired, unprotected check leases and never removes a sandbox',async t=>{
  const f=await fixture(t);let now=100;
  const first=createCheckSandboxes({...f,now:()=>now,timeoutMs:50});const handle=await first.backend.prepare({job_id:check});
  f.setListing([{name:handle.sandbox_id},{name:testSandboxName(job)},{name:'wf-unowned'}]);
  now=151;const restarted=createCheckSandboxes({...f,now:()=>now});
  assert.deepEqual(await restarted.reap({protectedJobIds:[check]}),{forgotten:[]});
  assert.deepEqual(await restarted.reap(),{forgotten:[check]});
  // The sandbox belongs to the cleanup record that reserved its name.
  assert.deepEqual(f.calls,[]);
  assert.deepEqual(JSON.parse(await readFile(f.file,'utf8')),[]);
});
test('the reaper reads no inventory and trusts no recorded path',async t=>{
  const f=await fixture(t),checks=createCheckSandboxes({...f,now:()=>100,timeoutMs:1});await checks.backend.prepare({job_id:check});
  const rows=JSON.parse(await readFile(f.file,'utf8'));rows[0].scratch_dir='/';await writeFile(f.file,JSON.stringify(rows));
  let reads=0;f.backend.runSbx=async()=>{reads++;return {code:1,stdout:''};};
  const restarted=createCheckSandboxes({...f,now:()=>200});
  assert.deepEqual(await restarted.reap(),{forgotten:[check]});
  assert.equal(reads,0);assert.deepEqual(f.calls,[]);
});

test('a crash during prepare never removes a name derived from the check',async t=>{
  const f=await fixture(t),name=testSandboxName(check);let names=[name,'wf-other-job'];
  f.backend.prepare=async()=>{throw new Error('simulated process death during prepare');};
  f.backend.runSbx=async args=>{if(args[0]==='rm')names=names.filter(n=>n!==args.at(-1));return {code:0,stdout:JSON.stringify(names.map(name=>({name})))};};
  const first=createCheckSandboxes({...f,now:()=>0,timeoutMs:1});
  await assert.rejects(first.backend.prepare({job_id:check}));
  const next=createCheckSandboxes({...f,now:()=>2});assert.deepEqual(await next.reap(),{forgotten:[check]});
  assert.deepEqual(names,[name,'wf-other-job']);
});
test('a journal of the wrong shape is an error, never an empty journal',async t=>{
  for(const body of ['{"job_id":"x"}','null','"rows"','42']) {
    const f=await fixture(t);await writeFile(f.file,body);
    const checks=createCheckSandboxes({...f,now:()=>200});
    await assert.rejects(checks.reap(),error=>error.code==='check_journal_invalid','reap for '+body);
    await assert.rejects(checks.backend.prepare({job_id:check}),error=>error.code==='check_journal_invalid','prepare for '+body);
    assert.equal(await readFile(f.file,'utf8'),body,'the unreadable journal is left for a person, not overwritten');
  }
});

test('a journal of the wrong shape is a visible cleanup blocker that names its file, and clears once readable',async t=>{
  const f=await fixture(t);await writeFile(f.file,'{"job_id":"x"}');
  const checks=createCheckSandboxes({...f,now:()=>200});
  await assert.rejects(checks.reap(),error=>error.code==='check_journal_invalid');
  const blocker=checks.journalBlocker();
  assert.ok(blocker,'the failed read is kept for the app to show, not swallowed');
  assert.ok(blocker.reason.includes(f.file),'the reason names the journal file');
  assert.equal(await readFile(f.file,'utf8'),'{"job_id":"x"}','the blocker does not overwrite the journal');
  await writeFile(f.file,'[]');
  assert.deepEqual(await checks.reap(),{forgotten:[]});
  assert.equal(checks.journalBlocker(),null,'a readable journal clears the blocker');
});
