import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {tempDir} from './helpers/temp-dir.mjs';
import {runJob} from '../lib/v1/run.mjs';
import {opError} from '../lib/v1/ops/execute.mjs';

for(const [state,exit] of [['result-accepted',0],['held',9],['expired',10],['failed',11],['timeout',5]]){
  test('agent run submits once and reports '+state,async()=>{
    const dir=await tempDir('agent-run-');await writeFile(join(dir,'task.md'),'Fix the parser');
    execFileSync('git',['init','-q',dir]);
    execFileSync('git',['-C',dir,'add','task.md']);
    execFileSync('git',['-C',dir,'-c','user.name=Test','-c','user.email=test@example.test','-c','commit.gpgsign=false','commit','-qm','Task source']);
    const calls=[],output=[];let waits=0;
    const digest='sha256:'+'a'.repeat(64);
    const client={call:async(id,input,opts)=>{
      calls.push({id,input,opts});
      if(id==='jobs.submit')return {jobDigest:digest};
      if(id==='jobs.wait'){
        waits++;
        now+=1000;
        return {done:state!=='timeout'&&waits>1,job:{state:waits===1?'queued':state,circle:{id:'friends'},
          ...(state==='held'&&waits>1?{status:'Needs approval',approval:{required:true}}:{}),reason:'Lender reason',lenderName:'Lender',model:'model',effort:'low'}};
      }
      if(id==='jobs.apply_preview')return {preview_token:'preview'};
      if(id==='jobs.apply')return {branch:input.branch,commit:'abc',status:'applied'};
      if(id==='jobs.changes')return {files:['a.mjs']};
      if(id==='jobs.result')return {path:dir};
      if(id==='jobs.transcript')return {text:'Checked the parser'};
      assert.fail(id);
    }};
    let now=0;
    const code=await runJob(['--source',dir,'--prompt-file',join(dir,'task.md'),'--circle','friends','--branch','faravan/parser','--timeout','3','--json'],
      {opsClient:client,now:()=>now,stdout:{write:s=>output.push(s)},stderr:{write:()=>{}},stdin:{isTTY:false}});
    assert.equal(code,exit,output.join(''));
    assert.equal(calls.filter(c=>c.id==='jobs.submit').length,1);
    assert.equal(calls[0].input.repo.includeUncommitted,false);
    assert.equal(calls[0].opts.confirmed,false);
    assert.equal(output.length,1);
    const result=JSON.parse(output[0]);assert.equal(result.job_id,digest);
    if(exit===0){assert.equal(result.branch,'faravan/parser');assert.deepEqual(result.changed_files,['a.mjs']);assert.ok(result.transcript_path);}
    else {assert.equal(result.state,state);assert.ok(result.reason);assert.equal(calls.some(c=>c.id==='jobs.apply'),false);}
  });
}

test('agent run refuses a non-Git source before sending a job',async()=>{
  const dir=await tempDir('agent-run-folder-');await writeFile(join(dir,'task.md'),'Task');
  let called=false;const output=[];
  const code=await runJob(['--source',dir,'--prompt-file',join(dir,'task.md'),'--json'],{opsClient:{call:async()=>{called=true;throw new Error('Unexpected send');}},
    stdout:{write:s=>output.push(s)},stderr:{write:()=>{}}});
  assert.equal(code,2);assert.equal(called,false);assert.match(JSON.parse(output[0]).message,/git repository/);
});

test('agent run keeps the app’s confirmation effect when there is no terminal',async()=>{
  const output=[];
  const code=await runJob(['--source',process.cwd(),'--prompt-file',new URL(import.meta.url).pathname,'--json'],{
    opsClient:{call:async()=>{throw opError('confirmation_required',428,'Confirm this send.',{effect:'Send this project to Friends.'});}},
    stdin:{isTTY:false},stdout:{write:s=>output.push(s)},stderr:{write:()=>{}}});
  assert.equal(code,6);assert.equal(JSON.parse(output[0]).effect,'Send this project to Friends.');
});
