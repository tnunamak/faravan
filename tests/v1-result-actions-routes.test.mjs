import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rm, writeFile } from 'node:fs/promises';
import { appFixture, api } from './helpers/v1-app-fixture.mjs';
import { makeRepo, git } from './helpers/git-guest.mjs';
import { createJobMetaStore } from '../lib/v1/job-meta.mjs';

// The app routes for Apply to working tree and Remove this branch: input checks, the borrower-only rule, refusals as
// 409 with a job state, and Remove this branch acting only on the app's own Add as a branch record.
const testOptions = {timeout:120000};
const jobPath = digest => '/api/jobs/' + encodeURIComponent(digest);
const gitInput = circle => ({circle:circle.id,git:'https://github.com/example/synthetic.git',
  commit:'1'.repeat(40),prompt:'Synthetic task: write a greeting.',harness:'codex'});

test('Apply to working tree: the route checks its input and the job; a refusal is a 409 with its code',testOptions,async t=>{
  const f=await appFixture(t),{owner,circle}=await f.connect();
  const sent=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  const post=(body,status)=>api(owner.app,jobPath(sent.jobDigest)+'/working-tree',{method:'POST',body,status});
  await post({circle:circle.id,repo:'/x'},400);                                         // dry_run is required
  await post({circle:circle.id,dry_run:true,repo:'/x',surprise:1},400);                 // no unknown fields
  await post({circle:circle.id,dry_run:false,repo:'/x',files:'src/a.txt'},400);         // files is a list
  await post({circle:circle.id,dry_run:false,repo:'/x',files:['']},400);
  await post({circle:circle.id,dry_run:false,repo:'/x',expect:[1]},400);
  await api(owner.app,jobPath('sha256:'+'f'.repeat(64))+'/working-tree',{method:'POST',body:{circle:circle.id,dry_run:true,repo:'/x'},status:403});
  const refused=await post({circle:circle.id,dry_run:true,repo:'relative/dir'},409);
  assert.deepEqual([refused.code,refused.apply_code,refused.state],['apply_refused','repo_missing','job.apply-repo-missing']);
});

test('Remove this branch: only the recorded, untouched branch of this job is removed, and the record goes with it',testOptions,async t=>{
  const f=await appFixture(t),{owner,circle}=await f.connect();
  const sent=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)}),digest=sent.jobDigest;
  const post=(body,status)=>api(owner.app,jobPath(digest)+'/remove-branch',{method:'POST',body,status});
  const view=()=>api(owner.app,jobPath(digest)+'?circle='+circle.id);
  await post({circle:circle.id},400);
  await post({circle:circle.id,dry_run:false,applied:{branch:'main',repo:'/',commit:'a'.repeat(40)}},400,'the client never names the branch');
  assert.equal((await post({circle:circle.id,dry_run:true},409)).apply_code,'not_applied');
  await api(owner.app,jobPath('sha256:'+'f'.repeat(64))+'/remove-branch',{method:'POST',body:{circle:circle.id,dry_run:true},status:403});

  const repo=await makeRepo(); t.after(()=>rm(repo.dir,{recursive:true,force:true}));
  const meta=createJobMetaStore(join(owner.home,'v1'));
  const branchAt=(name,message)=>{git(repo.dir,'switch','-q','-c',name);return writeFile(join(repo.dir,name.replace('/','-')+'.txt'),'x\n').then(()=>{
    git(repo.dir,'add','-A');git(repo.dir,'commit','-qm',message);const commit=git(repo.dir,'rev-parse','HEAD');git(repo.dir,'switch','-q','main');return commit;});};
  const stranger=await branchAt('faravan/other','Not ours\n\nFaravan-Job: sha256:'+'b'.repeat(64));
  await meta.setApplied(digest,{branch:'faravan/other',repo:repo.dir,commit:stranger,at:new Date().toISOString()});
  assert.equal((await post({circle:circle.id,dry_run:false},409)).apply_code,'not_our_commit');
  assert.equal(git(repo.dir,'rev-parse','faravan/other'),stranger,'left alone');
  assert.equal((await view()).applied.commit,stranger,'record kept');

  const ours=await branchAt('faravan/ours','Result\n\nFaravan-Job: '+digest);
  await meta.setApplied(digest,{branch:'faravan/ours',repo:repo.dir,commit:ours,at:new Date().toISOString()});
  assert.equal((await post({circle:circle.id,dry_run:true})).status,'removable');
  assert.equal(git(repo.dir,'rev-parse','faravan/ours'),ours,'a dry run removes nothing');
  assert.equal((await post({circle:circle.id,dry_run:false})).status,'removed');
  assert.equal(git(repo.dir,'branch','--list','faravan/ours'),'');
  assert.equal((await view()).applied,null,'the job no longer says Added as a branch');
  assert.equal((await post({circle:circle.id,dry_run:false},409)).apply_code,'not_applied');
});
