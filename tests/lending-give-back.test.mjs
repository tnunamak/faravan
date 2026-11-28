import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLender} from '../lib/v1/lender.mjs';
import {lenderFixture,until} from './helpers/v1-lender-fixture.mjs';

test('post-claim wait returns reason and deadline, preserves approval, and has no global cooldown',{timeout:60000},async t=>{
 const f=await lenderFixture(t);
 const due=f.clock.now()+180000;
 let invalidated=0;
 f.backend.invalidateLendingCapabilities=()=>{invalidated++;};
 f.runOptions.accountExecution.wrap=async()=>{throw Object.assign(Error('no_spare'),{code:'no_spare',admissionDecline:true,retryAtMs:due});};
 const c=new AbortController();
 const lender=createLender({...f.runOptions,client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock,approve:async()=>true,onEvent:e=>f.events.push(e)});
 const run=lender.start(c.signal);run.catch(()=>{});
 f.stop=async()=>{c.abort();await run;};
 await until(()=>f.requests.some(r=>r.route.endsWith('/release')),'give-back');
 await until(()=>f.saved()?.declinePending===null,'release persisted');
 const release=f.requests.find(r=>r.route.endsWith('/release'));
 assert.deepEqual(JSON.parse(release.body.reason),{code:'no_spare',until:due});
 const saved=f.saved();
 assert.equal(saved.declined[0].expiresAt,due);
 assert.equal(saved.declineUntil,0);
 assert.equal(saved.jobConsents.length,1,'approval survives give-back');
 assert.equal(invalidated,1,'post-claim finding invalidates cached discovery');
});

for(const resume of ['time','epoch'])test('same lender reclaims only after '+resume+' and keeps approval',{timeout:60000},async t=>{
 const f=await lenderFixture(t);
 const due=f.clock.now()+120000;
 let approvals=0,wraps=0,releases=0,reclaims=0,latest=null;
 f.runOptions.accountExecution.wrap=async()=>{wraps++;throw Object.assign(Error('no_spare'),{code:'no_spare',admissionDecline:true,retryAtMs:f.clock.now()+120000});};
 f.override=async({route,body,res})=>{
  if(route.endsWith('/release')){releases++;f.json(res,{...(latest??f.attempt()),state:'released'});return true;}
  if(latest&&route==='/attempts/'+latest.attempt_id){f.json(res,latest);return true;}
  if(latest&&route==='/attempts/'+latest.attempt_id+'/renew'){latest.lease_expires_at=new Date(f.clock.now()+120000).toISOString().replace('.000Z','Z');f.json(res,latest);return true;}
  if(route==='/jobs/claim-next'&&releases){
   if(body.exclude?.includes(f.jobDigest)){f.json(res,null);return true;}
   reclaims++;
   latest={...f.attempt(),attempt_id:'aaaaaaaa-aaaa-4aaa-8aaa-000000000002',generation:2,state:'active',lease_expires_at:new Date(f.clock.now()+120000).toISOString().replace('.000Z','Z')};
   f.json(res,{job_digest:f.jobDigest,job:f.job,attempt:latest});return true;
  }
 };
 const controller=new AbortController();
 const lender=createLender({...f.runOptions,client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock,
  approve:async()=>{approvals++;return true;},onEvent:e=>f.events.push(e)});
 const run=lender.start(controller.signal);run.catch(()=>{});f.stop=async()=>{controller.abort();await run;};
 await until(()=>releases===1&&f.saved()?.declinePending===null,'first give-back');
 await until(()=>lender.getState().current===null,'give-back leaves current');
 await until(()=>f.requests.filter(r=>r.route==='/jobs/claim-next').length>=2,'idle polling resumes');
 assert.ok(f.requests.filter(r=>r.route==='/jobs/claim-next').at(-1).body.exclude.includes(f.jobDigest));
 assert.equal(reclaims,0);assert.equal(wraps,1);
 if(resume==='time'){f.clock.advance(due-f.clock.now());lender.reconfigure();}
 else {await lender.refreshAdmission();lender.reconfigure();f.clock.advance(1000);}
 await until(()=>{if(wraps<2)f.clock.advance(Math.min(1000,Math.max(0,(resume==='epoch'?due-1:due+30000)-f.clock.now())));return wraps===2;},'reclaim after deadline or readiness change');
 if(resume==='epoch')assert.ok(f.clock.now()<due,'readiness change releases the job before its original deadline');
 assert.equal(reclaims,1);assert.equal(approvals,1,'consent survives re-claim');
});

test('a restart preserves a saved per-job not-before time',{timeout:60000},async t=>{
 const f=await lenderFixture(t);
 const due=f.clock.now()+120000;
 await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,
  declined:[{jobDigest:f.jobDigest,expiresAt:due,boot:'previous-process',epoch:7,exclusionVersion:1}]});
 const c=new AbortController();
 const lender=createLender({...f.runOptions,client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock,approve:async()=>true});
 const run=lender.start(c.signal);run.catch(()=>{});f.stop=async()=>{c.abort();await run;};
 await until(()=>f.requests.some(r=>r.route==='/jobs/claim-next'),'first poll after restart');
 assert.ok(f.requests.find(r=>r.route==='/jobs/claim-next').body.exclude.includes(f.jobDigest));
});

for(const resetBeforeExpiry of [true,false])test('provider hold gives back until the earlier reset or job expiry: '+resetBeforeExpiry,async t=>{
 const f=await lenderFixture(t),expiry=Date.parse(f.job.payload.expires_at);
 const reset=resetBeforeExpiry?f.clock.now()+120000:expiry+120000;
 f.runOptions.accountExecution.wrap=async()=>{throw Object.assign(Error('provider_limit_reached'),{code:'provider_limit_reached',admissionDecline:true,retryAtMs:reset});};
 const c=new AbortController(),worker=createLender({...f.runOptions,client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock,approve:async()=>true,onEvent:e=>f.events.push(e)});
 const run=worker.start(c.signal);f.stop=async()=>{c.abort();await run;};
 await until(()=>f.saved()?.lastDeclineOutcome?.code==='released','provider hold released');
 assert.deepEqual(JSON.parse(f.requests.find(r=>r.route.endsWith('/release')).body.reason),{code:'provider_limit_reached',until:Math.min(expiry,reset)});
 assert.equal(f.saved().declined[0].expiresAt,Math.min(expiry,reset));
});
