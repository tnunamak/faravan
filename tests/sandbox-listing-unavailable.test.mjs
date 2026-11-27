import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileSbx,receiptBackend} from './helpers/sandbox-receipt-fixture.mjs';
import {appFixture,syntheticBackend,api,waitFor,bounded} from './helpers/v1-app-fixture.mjs';
import {sandboxDeadlineUnit} from '../lib/sandbox-deadline.mjs';

// Synthesized from the four supplied v2 shapes. No source identities, homes,
// paths, clock identities or job values are retained in the fixture.
const shapes=JSON.parse(fs.readFileSync(new URL('./fixtures/sandbox-cleanup-service-unavailable.json',import.meta.url)));
const DETAIL='503 Service Unavailable: docker login service unavailable: the host is not fully awake docker session';
const CANARY='ghp_SYNTHETIC_SECRET_CANARY_123456789';
const execute=promisify(execFile);
async function cli(home,args){
  try{return await execute(process.execPath,[new URL('../bin/faravan',import.meta.url).pathname,...args],{env:{...process.env,FARAVAN_HOME:home},timeout:5000});}
  catch(error){if(error.killed)throw error;return {stdout:error.stdout,stderr:error.stderr};}
}
function setup(t,{root=fs.mkdtempSync(path.join(os.tmpdir(),'listing-down-')),directory=path.join(root,'profile','v1','sandbox-cleanup'),count=319,hang=false,firstSuccess=false}={}){
  const saved={FARAVAN_SBX_HOME:process.env.FARAVAN_SBX_HOME,FARAVAN_SCRATCH_ROOT:process.env.FARAVAN_SCRATCH_ROOT};
  process.env.FARAVAN_SBX_HOME=path.join(root,'sbx-home');process.env.FARAVAN_SCRATCH_ROOT=path.join(root,'scratch');
  fs.mkdirSync(directory,{recursive:true});fs.mkdirSync(process.env.FARAVAN_SCRATCH_ROOT,{recursive:true});
  const sbx=fileSbx(root);let calls=0,failed=0,available=false;
  const backend=receiptBackend(root,sbx,{cleanupDirectory:directory,cleanupListingTimeoutMs:100,cleanupListingRetryMs:15000,cleanupListingSleep:async()=>{},onReaperSummary:()=>{},
    runCommand:async(args,options)=>{
      if(args[0]!=='ls')return sbx.run(args,options);
      calls++;
      if(firstSuccess&&calls===1)return sbx.run(args,options);
      if(available)return sbx.run(args,options);
      if(hang)return new Promise(()=>{});
      await new Promise(resolve=>setTimeout(resolve,15));failed++;
      return {code:1,stdout:'',stderr:DETAIL+' https://synthetic.invalid/?token='+CANARY+'\n'+CANARY};
    }});
  const bytes=new Map();
  for(let i=0;i<count;i++){
    const row={...shapes[i%shapes.length],...backend.sandboxOwnership(),_cleanupId:randomUUID(),job_id:'synthetic-job-'+i,sandbox_id:'wf-'+i.toString(16).padStart(16,'0')};
    row.scratch_dir=path.join(process.env.FARAVAN_SCRATCH_ROOT,'wf-job-'+row.sandbox_id+'-fixture');
    if(row.deadline_at!==undefined)row.deadline_enforcer={kind:'systemd',unit:sandboxDeadlineUnit(row),binary:'/synthetic/sbx'};
    const file=path.join(directory,row._cleanupId+'.json');fs.writeFileSync(file,JSON.stringify(row));bytes.set(file,fs.readFileSync(file));
  }
  t.after(()=>{for(const [key,value]of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;fs.rmSync(root,{recursive:true,force:true});});
  return {root,directory,backend,setAvailable:value=>{available=value;},calls:()=>calls,failed:()=>failed,unchanged:()=>{for(const [file,expected]of bytes)assert.deepEqual(fs.readFileSync(file),expected);}};
}
function assertHold(hold){
  assert.ok(hold);assert.equal(hold.error_code,'sbx_daemon_unavailable');
  assert.match(hold.message,/sandbox service is unavailable/i);assert.ok(hold.message.includes(DETAIL));
  assert.equal(hold.fix.human,'Open Setup and choose Check again.');
  assert.doesNotMatch(JSON.stringify(hold),/ghp_|SYNTHETIC_SECRET|https?:|synthetic[.]invalid/);
}
for(const hang of [false,true])test('cleanup fails as one bounded pass without changing rows; hung transport='+hang,{timeout:10000},async t=>{
  const f=setup(t,{hang}),controller=new AbortController(),work=f.backend.recoverSandboxDeadlines({signal:controller.signal});
  try{
  await assert.rejects(bounded(work,'listing refusal',2000));
  assert.equal(f.calls(),3,'three rejected attempts stop the pass before any row');
  const hold=f.backend.deadlineRecoveryHold();assert.ok(hold);assert.equal(hold.error_code,'sbx_daemon_unavailable');
  if(!hang)assertHold(hold);
  for(let i=0;i<3;i++)await f.backend.reapCleanup({force:false}).catch(()=>{});
  assert.equal(f.calls(),3,'failed availability is backed off, never treated as absence');f.unchanged();
  }finally{controller.abort();if(!hang)await work.catch(()=>{});}
});

for(const surface of ['status','blockers','agents'])test('listing refusal stays bounded and visible through '+surface,{timeout:15000},async t=>{
  const app=await appFixture(t),home=await app.home('listing-'+surface),f=setup(t,{root:path.join(app.root,'compute'),directory:path.join(home,'v1','sandbox-cleanup')});
  const backend=syntheticBackend(app.root);
  for(const method of ['recoverSandboxDeadlines','deadlineRecoveryHold','deadlineRecoveryPending','cleanupStatus','reapCleanup'])backend[method]=(...args)=>f.backend[method](...args);
  const started=await bounded(app.start('listing-'+surface,{backend,cleanupRecheckMs:50,shutdownProofMs:200,agentCheckTimeoutMs:1000}),'app start',5000);
  await waitFor(()=>f.failed()>0,'the failed sandbox inventory');await new Promise(resolve=>setTimeout(resolve,100));
  if(surface==='agents'){
    const error=await bounded(api(started.app,'/api/ops/agents.check',{method:'POST',body:{},status:409}),'agents refusal',2500);
    assert.equal(error.code,'cessation_unverified');assert.match(error.message,/sandbox service is unavailable/i);assert.ok(error.message.includes(DETAIL));
    assert.doesNotMatch(JSON.stringify(error),/agent_check_timeout|ghp_|https?:/);
    const printed=await cli(home,['agents','check']);
    const text=printed.stdout+' '+printed.stderr;assert.match(text,/sandbox service is unavailable/i);assert.match(text,/Open Setup and choose Check again\./);assert.doesNotMatch(text,/agent_check_timeout|ghp_|https?:/);
  }else{
    const result=await bounded(api(started.app,surface==='status'?'/api/status':'/api/ops/status.blockers',surface==='status'?{}:{method:'POST',body:{}}),surface+' response',2500);
    assertHold(result.blockers.find(row=>row.kind==='cessation_unverified'));
    if(surface==='blockers'){const printed=await cli(home,['status','blockers','--json']);assert.match(printed.stdout,/sandbox service is unavailable/i);assert.match(printed.stdout,/Open Setup/);assert.doesNotMatch(printed.stdout,/ghp_|https?:/);}
  }
  await waitFor(()=>fs.existsSync(path.join(home,'v1','lending-errors.jsonl')),'persisted refusal');
  const entries=()=>fs.readFileSync(path.join(home,'v1','lending-errors.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(row=>row.phase==='deadline_recovery');
  await new Promise(resolve=>setTimeout(resolve,150));assert.equal(entries().length,1,'one durable refusal per unchanged outage');
  assert.ok(entries()[0].message.includes(DETAIL));assert.doesNotMatch(JSON.stringify(entries()),/ghp_|https?:/);
  const diagnostic=entries()[0].details.sandbox_command;
  assert.equal(diagnostic.attempts,3);assert.equal(diagnostic.subcommand,'ls --json');assert.equal(diagnostic.stage,'exit');assert.equal(diagnostic.exit_code,1);
  assert.match(diagnostic.stderr_first_line,/withheld|redacted/);
  assert.ok(Buffer.byteLength(JSON.stringify(entries()[0])+'\n')<1024,'the existing app row stays below one KiB');
  assert.equal(f.calls(),3);f.unchanged();
});

test('an explicit backend recovery can recheck a restored service without waiting for backoff',async t=>{
  const f=setup(t,{count:1});
  await f.backend.recoverSandboxDeadlines().catch(()=>{});assert.equal(f.calls(),3);assertHold(f.backend.deadlineRecoveryHold());
  f.setAvailable(true);await f.backend.recoverSandboxDeadlines().catch(()=>{});
  assert.ok(f.calls()>3,'explicit recovery must not stay behind the background refusal cache');
  assert.notEqual(f.backend.deadlineRecoveryHold()?.error_code,'sbx_daemon_unavailable');
});

test('a service failure after the availability read stops the pass before changing any row',async t=>{
  const f=setup(t,{firstSuccess:true}),controller=new AbortController(),work=f.backend.recoverSandboxDeadlines({signal:controller.signal});
  try{
    await assert.rejects(bounded(work,'mid-pass listing refusal',2000));
    assert.equal(f.calls(),4,'one initial read and three attempts at the refused owned read');
    assertHold(f.backend.deadlineRecoveryHold());f.unchanged();
  }finally{controller.abort();await work.catch(()=>{});}
});
