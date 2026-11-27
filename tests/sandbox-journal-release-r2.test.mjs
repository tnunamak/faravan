import './helpers/no-browser.mjs';
import {legacySandboxNameFor as sandboxNameFor} from '../lib/sandbox-name.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs,{mkdtempSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSandboxCleanupJournal} from '../lib/sandbox-cleanup-journal.mjs';
import {acquireProcessLockSync} from '../lib/v1/lock.mjs';

test('R2 a reaper returns its journal record and scope locks once and preserves a replacement owner',()=>{
  const root=mkdtempSync(join(tmpdir(),'r2-journal-release-'));
  const lock=new URL('../lib/v1/lock.mjs',import.meta.url).href;
  const journal=new URL('../lib/sandbox-cleanup-journal.mjs',import.meta.url).href;
  const source=`
    import fs from 'node:fs';
    import {join,sep} from 'node:path';
    import {registerHooks} from 'node:module';
    globalThis.releaseCalls=[];
    registerHooks({load(url,context,next){
      const loaded=next(url,context);
      if(url!==${JSON.stringify(lock)})return loaded;
      return {...loaded,source:String(loaded.source).replace('export function acquireProcessLockSync(','function acquireProcessLockSync(')+
        '\\nexport function countedAcquire(...args){const release=acquireProcessLockSync(...args);return()=>{globalThis.releaseCalls.push(args[0]);return release();};} export {countedAcquire as acquireProcessLockSync};'};
    }});
    const {legacySandboxNameFor:sandboxNameFor}=await import(${JSON.stringify(new URL('../lib/sandbox-name.mjs',import.meta.url).href)});
    const {createSandboxCleanupJournal}=await import(${JSON.stringify(journal)});
    const {acquireProcessLockSync}=await import(${JSON.stringify(lock)});
    const root=process.argv[1],directory=join(root,'journal'),job_id='r2-releases';
    const sandbox_id=sandboxNameFor(job_id);
    const handle={job_id,sandbox_id,scratch_dir:join(root,'wf-job-'+sandbox_id+'-owned')};
    fs.mkdirSync(handle.scratch_dir);
    const initial=createSandboxCleanupJournal({directory,scratchRoot:()=>root,destroy(){}});
    initial.register(handle);initial.finish(handle,{});
    globalThis.releaseCalls=[];
    let replacement;
    const reaper=createSandboxCleanupJournal({directory,scratchRoot:()=>root,destroy:async row=>{
      fs.rmSync(row.scratch_dir,{recursive:true});
      reaper.finish(row,{removed:true,scratch_removed:true,policy_removed:true});
      replacement=acquireProcessLockSync(join(directory,sandbox_id+'.scope'));
    }});
    await reaper.reap();
    let protectedOwner=false;
    try{acquireProcessLockSync(join(directory,sandbox_id+'.scope'));}catch(error){protectedOwner=error.code==='lock_busy';}
    const releases=globalThis.releaseCalls.filter(file=>file.startsWith(directory+sep)).length;
    replacement();
    console.log(JSON.stringify({releases,protectedOwner,scratchGone:!fs.existsSync(handle.scratch_dir),state:reaper.status().state}));
  `;
  const output=execFileSync(process.execPath,['--input-type=module','-e',source,root],{encoding:'utf8',timeout:10000});
  const result=JSON.parse(output);
  assert.equal(result.releases,2,'record and scope releases are each invoked exactly once');
  assert.equal(result.protectedOwner,true);
  assert.equal(result.scratchGone,true);
  assert.equal(result.state,'clear');
});

test('R2 a completed cleanup tolerates an already absent record and releases its scope',t=>{
  const root=mkdtempSync(join(tmpdir(),'r2-journal-missing-')),directory=join(root,'journal');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const job_id='r2-missing-record',sandbox_id=sandboxNameFor(job_id);
  const handle={job_id,sandbox_id,scratch_dir:join(root,'wf-job-'+sandbox_id+'-owned')};
  fs.mkdirSync(handle.scratch_dir);
  const journal=createSandboxCleanupJournal({directory,scratchRoot:()=>root,destroy(){}});
  journal.register(handle);
  fs.rmSync(handle.scratch_dir,{recursive:true});
  fs.unlinkSync(join(directory,handle._cleanupId+'.json'));
  assert.doesNotThrow(()=>journal.finish(handle,{removed:true,scratch_removed:true,policy_removed:true}));
  assert.equal(journal.status().state,'clear');
  const release=acquireProcessLockSync(join(directory,sandbox_id+'.scope'));release();
});
