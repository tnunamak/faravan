import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLender} from '../lib/v1/lender.mjs';
import {lenderFixture,until} from './helpers/v1-lender-fixture.mjs';
for(const state of ['pass','failed','inconclusive'])test('isolation '+state+' precedes authorization and agent launch',{timeout:20000},async t=>{
 let probes=0,pauses=0,atProbe;
 const f=await lenderFixture(t,{policy:{
  checkJobIsolation:async()=>{
   probes++;
   atProbe={prepared:f.calls.some(c=>c[0]==='prepare'),startRequested:f.saved().pending.executionStartRequested,
    authorized:f.requests.some(r=>r.route.endsWith('/start')),agentStarted:f.calls.some(c=>c[0]==='run')};
   return {state,code:'isolation_check_'+state,blocker:'The sandbox could reach your home network. Check Docker Sandboxes, then resume lending.'};
  },onIsolationFailure:async()=>{pauses++;}
 }});
 const controller=new AbortController();
 const lender=createLender({client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock,approve:async()=>true,onEvent:e=>f.events.push(e)});
 const running=lender.start(controller.signal);
 t.after(async()=>{controller.abort();await running;});
 if(state==='pass'){
  await until(()=>f.result,'completed job');assert.ok(f.calls.some(c=>c[0]==='run'));
 }else{
  await until(()=>f.attempt().state==='released','pre-start decline');
  assert.equal(f.attempt().execution_started_at,null);
  assert.equal(f.requests.some(r=>r.route.endsWith('/start')),false);
  assert.equal(f.calls.some(c=>c[0]==='run'),false);
  assert.equal(JSON.parse(f.attempt().reason).code,'isolation_check_'+state);
 }
 assert.deepEqual(atProbe,{prepared:true,startRequested:false,authorized:false,agentStarted:false});
 assert.equal(probes,1);assert.equal(pauses,state==='failed'?1:0);
 assert.equal(lender.getState().paused,state==='failed');
});

test('an inconclusive isolation check records the step and elapsed time in the failure log',{timeout:20000},async t=>{
 const details={step:'credential_probe',elapsedMs:20400,budgetMs:20000},logged=[];
 const f=await lenderFixture(t,{policy:{checkJobIsolation:async()=>({state:'inconclusive',code:'isolation_check_inconclusive',details})}});
 const controller=new AbortController();
 const lender=createLender({client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock,approve:async()=>true,
  onEvent:e=>f.events.push(e),onDiagnostic:entry=>logged.push(entry)});
 const running=lender.start(controller.signal);
 t.after(async()=>{controller.abort();await running;});
 await until(()=>f.attempt().state==='released','pre-start decline');
 const entry=logged.find(e=>e.code==='isolation_check_inconclusive');
 assert.ok(entry,'the failure is logged');
 assert.deepEqual(entry.details,details);
});

import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
for(const state of ['failed','inconclusive'])test('real host re-offers isolation '+state+' without spending a start',{timeout:60000},async t=>{
 const f=await realLenderFixture(t,{members:true,policy:{checkJobIsolation:async()=>({state,code:'isolation_check_'+state,blocker:'The sandbox could reach your home network. Check Docker Sandboxes, then resume lending.'})}});
 const controller=new AbortController();
 const lender=createLender({client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock,approve:async()=>true,onEvent:e=>f.events.push(e)});
 const running=lender.start(controller.signal);let released=false;
 const release=f.client.release.bind(f.client);f.client.release=async(...args)=>{const result=await release(...args);released=true;return result;};
 f.stop=async()=>{controller.abort();await running;};
 await until(()=>released,'release accepted by host');await f.stop();
 const job=await f.owner.getJob(f.jobDigest);
 assert.equal(job.state,'queued');assert.equal(job.attempts_started,0);
 const caps=await f.backend.lenderCapabilities();
 const ad={harnesses:['codex'],models:['example-model'],capabilities:[],egress:caps.egress,enforced_limits:caps.enforced_limits,max_limits:caps.max_limits};
 // A repaired setup failure may take the job again: only a person's explicit refusal excludes a lender for the job's life.
 const retry=await f.client.claimJob(f.jobDigest,ad);assert.equal(retry.attempt.state,'active');await f.client.release(retry.attempt,JSON.stringify({code:'isolation_check_'+state}));
 const second=await f.clientFor(3).claimJob(f.jobDigest,ad);
 assert.equal(second.attempt.state,'active');
});

import {appFixture,api,waitFor} from './helpers/v1-app-fixture.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
test('a leftover result cannot hold lending or be treated as current evidence',{timeout:60000},async t=>{
 const f=await appFixture(t),{lender,circle}=await f.connect();
 const oldFile=join(lender.home,'v1','sandbox-test.json');
 await writeFile(oldFile,'{not valid JSON');
 await lender.app.close();
 const restarted=await f.start('lender');
 await api(restarted.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
 await api(restarted.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
 const status=await waitFor(async()=>{const value=await api(restarted.app,'/api/status');return value.state==='ready'&&value;},'legacy result ignored',20000);
 assert.equal(status.lending_blockers.items.some(item=>item.key==='sandbox_test'),false);
 assert.equal(await readFile(oldFile,'utf8'),'{not valid JSON');
});

import {appFixture as admissionFixture} from './helpers/triage-small-app-fixture.mjs';
test('a failed check pauses lending durably; Resume checks the returned job again',{timeout:90000},async t=>{
 let state='failed',probes=0;
 const blocker='The sandbox could read your agent sign-in. Check Docker Sandboxes, then resume lending to try again.';
 const f=await admissionFixture(t),{owner,lender,circle}=await f.connect({checkJobIsolation:async()=>{probes++;return state==='pass'?{state}:{state,code:'isolation_check_failed',blocker};}});
 const submit=prompt=>api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt,harness:'codex'}});
 const accept=async()=>{const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'job review',20000);await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});};
 await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
 await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
 await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
 await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
 await submit('First isolation job');await accept();
 const paused=await waitFor(async()=>{const home=await api(lender.app,'/api/home');return home.lending.paused&&home;},'lending paused by isolation',20000);
 assert.equal(paused.lending_blockers.items.find(row=>row.key==='isolation_check').detail,blocker);
 // Visible state can arrive while the durable pause write is still in progress.
 await waitFor(async()=>!(await api(lender.app,'/api/lending')).current,'refusal cleanup',20000);
 const saved=JSON.parse(await readFile(join(lender.home,'v1','app-settings.json'),'utf8'));
 assert.equal(saved.isolationFailure,blocker);assert.equal(saved.paused,true);
 assert.equal(lender.backend.calls.some(([kind])=>kind==='run'),false);
 assert.equal(lender.phases.includes('startAttempt'),false);assert.equal(probes,1);
 state='pass';
 await api(lender.app,'/api/lending/resume',{method:'POST',body:{circle:circle.id}});
 // The refused job returns by itself and keeps the approval already given, since nothing about it changed.
 await waitFor(()=>lender.backend.calls.some(([kind])=>kind==='run'),'job after Resume starts',20000);
 assert.equal(probes,2);
 assert.equal(JSON.parse(await readFile(join(lender.home,'v1','app-settings.json'),'utf8')).isolationFailure,undefined);
});
