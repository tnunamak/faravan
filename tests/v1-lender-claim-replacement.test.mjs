import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createLender} from '../lib/v1/lender.mjs';
import {lenderFixture,deferred,until} from './helpers/v1-lender-fixture.mjs';

for(const failReplacement of [true,false])test(`an observation acknowledgment preserves accepted work after a ${failReplacement?'failed':'successful'} replacement write`,{timeout:15000},async t=>{
  const f=await lenderFixture(t),ack=deferred(),writes=[];
  const report=f.backend.lenderCapabilities();
  const advertisement={harnesses:['codex'],models:['example-model'],capabilities:[],egress:report.egress,
    enforced_limits:report.enforced_limits,max_limits:report.max_limits};
  const expired={...f.attempt(),lease_expires_at:new Date(f.clock.now()-1000).toISOString()};
  const original={jobDigest:f.jobDigest,job:f.job,advertisement,leaseSeconds:120,idempotencyKey:'accepted-expired',
    state:'expired-unstarted',acceptedAt:f.clock.now()-1000,ruleId:null,
    claimError:{code:'lease_expired',status:409,committedAttempt:expired}};
  const observation={idempotencyKey:'previous-execution-observation',observedAt:new Date(f.clock.now()-1000).toISOString(),
    attempt:{...f.attempt(),attempt_id:randomUUID(),execution_started_at:new Date(f.clock.now()-1000).toISOString()}};
  await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,claimPending:original,observationPending:[observation]});
  // A durable read returns a snapshot, not the object held by the running lender.
  f.policy.storage.get=async()=>structuredClone(f.saved());
  f.client.observeExecutionStart=async()=>{await ack.promise;return {execution_observed_at:observation.observedAt};};
  f.client.getJob=async()=>({state:'queued',current_attempt:expired});
  const set=f.policy.storage.set,realClaim=f.client.claimNext.bind(f.client);
  let replacement=null,acknowledged=false,controller,loop,complete=false;
  const sent=[];
  f.policy.storage.set=async value=>{
    if(!replacement&&value.claimPending&&value.claimPending.idempotencyKey!==original.idempotencyKey){
      replacement=structuredClone(value.claimPending);
      writes.push(failReplacement?'replacement failed':'replacement committed');
      ack.resolve();
      // Queue the real observation-clear save behind this in-flight write.
      await new Promise(resolve=>setImmediate(resolve));
      if(failReplacement)throw Object.assign(new Error('replacement write failed'),{code:'EIO'});
    }
    await set(value);
    if(replacement&&!acknowledged&&value.observationPending?.length===0){
      acknowledged=true;writes.push('observation committed');controller.abort();
    }
  };
  f.client.claimJob=async(digest,offer,options)=>{
    sent.push({digest,advertisement:structuredClone(offer),key:options.idempotencyKey});
    await realClaim(offer,{...options,waitSeconds:0});
    complete=true;controller.abort();return null;
  };
  const start=()=>{
    controller=new AbortController();
    const lender=createLender({client:f.client,backend:f.backend,policy:f.policy,adapters:f.adapters,clock:f.clock,
      approve:async()=>true,onEvent:event=>f.events.push(event)});
    loop=lender.start(controller.signal);loop.catch(()=>{});
    f.stop=async()=>{controller.abort();await loop.catch(()=>{});};
    return loop;
  };
  const first=start();
  await until(()=>acknowledged,'observation acknowledgment committed after replacement attempt');
  await first.catch(error=>assert.equal(error.code,'EIO'));
  const restored=structuredClone(f.saved());
  assert.deepEqual(writes,[failReplacement?'replacement failed':'replacement committed','observation committed']);
  assert.deepEqual(restored.observationPending,[]);
  assert.equal(sent.length,0,'the first process stops before sending the replacement');
  const restarted=start();
  await until(()=>complete||f.saved().claimPending===null,'restored accepted job is sent or dropped');
  controller.abort();await restarted;
  assert.equal(sent.length,1,JSON.stringify({restored:{key:restored.claimPending?.idempotencyKey,state:restored.claimPending?.state},
    events:f.events.slice(-4).map(({status,reason})=>({status,reason}))}));
  assert.equal(sent[0].digest,f.jobDigest);
  assert.deepEqual(sent[0].advertisement,advertisement);
  assert.notEqual(sent[0].key,original.idempotencyKey);
  if(!failReplacement)assert.equal(sent[0].key,replacement.idempotencyKey,'the committed replacement is retained');
  assert.equal(f.count('/jobs/claim-next'),1,'the accepted job reaches the coordinator after restart');
});
