import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api,syntheticBackend,waitFor} from './helpers/v1-app-fixture.mjs';

const job=circle=>({circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),
  prompt:'Synthetic independent safety probe. No external execution.',harness:'codex'});
async function enable(lender,circle){
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'auto'}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
}

test('real app never starts the account sandbox when deadline preparation fails',{timeout:60000},async t=>{
  const f=await appFixture(t),backend=syntheticBackend(f.root,{});
  let preparations=0;
  backend.prepare=async()=>{preparations++;throw Object.assign(new Error('synthetic deadline arm failure'),{code:'sandbox_start_failed'});};
  const {owner,lender,circle}=await f.connect({backend});
  const sent=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:job(circle)});
  await enable(lender,circle);
  await waitFor(()=>preparations>0,'failed preparation',30000);
  await waitFor(()=>f.jobs.get(sent.jobDigest)?.state==='queued','job released after refusal',30000);
  assert.equal(backend.calls.filter(([kind])=>kind==='run').length,0);
  assert.ok(f.jobs.get(sent.jobDigest).current_attempt,'the refusal followed an actual claim');
});

test('real app shutdown bound covers backend recovery callbacks and the lender loop',{timeout:60000},async t=>{
  const f=await appFixture(t,{hold:true}),backend=syntheticBackend(f.root,{hold:true});
  let releaseRecovery,releaseCancel,entered;
  const recovery=new Promise(resolve=>{releaseRecovery=resolve;}),cancellation=new Promise(resolve=>{releaseCancel=resolve;});
  const recoveryEntered=new Promise(resolve=>{entered=resolve;});
  backend.ensureSandboxAdmission=async()=>true;
  backend.recoverSandboxDeadlines=async()=>{entered();await recovery;return true;};
  const cancel=backend.cancel.bind(backend);
  backend.cancel=async handle=>{await cancellation;return cancel(handle);};
  t.after(()=>{releaseRecovery();releaseCancel();backend.release();});
  const {owner,lender,circle}=await f.connect({backend,shutdownProofMs:100});
  await recoveryEntered;
  await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:job(circle)});
  await enable(lender,circle);
  await waitFor(()=>backend.calls.some(([kind])=>kind==='run'),'running account job',30000);
  const closing=lender.app.close();
  let timer;
  const outcome=await Promise.race([closing.then(()=>'closed'),new Promise(resolve=>{timer=setTimeout(()=>resolve('blocked'),300);})]);
  clearTimeout(timer);releaseRecovery();releaseCancel();backend.release();
  const closed=await closing;await closed.lending_loop_settled;
  assert.equal(outcome,'closed','recovery must not bypass the shutdown bound');
});
