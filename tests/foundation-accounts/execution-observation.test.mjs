import {enableFixtureModel} from '../helpers/account-model-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createCodexProvider} from '../../lib/v1/providers/codex.mjs';
import {parseExecutionResult} from '../../lib/harnesses/codex.adapter.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {tmpdir} from 'node:os';
import {createAccountStore,ok} from '../../lib/v1/accounts.mjs';
import {createAccountBroker} from '../../lib/v1/account-broker.mjs';
import {createFakeRegistry} from '../../lib/v1/providers/fixtures.mjs';
const adapter=createCodexProvider();
const response={id:'resp_fixture',object:'response',status:'completed',model:'reported-model'};
test('Codex execution observes completed authenticated Responses metadata, never requested stdout fields',()=>{
  assert.equal(parseExecutionResult('{"type":"turn.completed","model":"requested-model","usage":{"input_tokens":1,"output_tokens":2}}').model,null);
  assert.deepEqual(adapter.parseExecutionResponse({body:JSON.stringify(response),contentType:'application/json'}),{model:'reported-model'});
  for(const value of [{model:'requested-model'},{...response,status:'in_progress'},{...response,model:null},null])
    assert.equal(adapter.parseExecutionResponse({body:JSON.stringify(value),contentType:'application/json'}),null);
});
test('Codex stream requires completed response and refuses conflicting terminal observations',()=>{
  const event=value=>'data: '+JSON.stringify({type:'response.completed',response:value})+'\n\n';
  assert.deepEqual(adapter.parseExecutionResponse({body:event(response),contentType:'text/event-stream'}),{model:'reported-model'});
  assert.equal(adapter.parseExecutionResponse({body:'data: {"type":"response.created","response":'+JSON.stringify(response)+'}\n\n',contentType:'text/event-stream'}),null);
  assert.equal(adapter.parseExecutionResponse({body:event(response)+event({...response,model:'other'}),contentType:'text/event-stream'}),null);
});

for(const barrier of ['before mutation','after mutation','caller abort after mutation'])test('cancellation '+barrier+' of response publication retains debt without accepted observation',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'faravan-observation-publication-'));
  const store=createAccountStore({directory});
  const controller=new AbortController();
  let reached,release,armed=false;
  const arrived=new Promise(resolve=>{reached=resolve;});
  const held=new Promise(resolve=>{release=resolve;});
  const transaction=store.transaction.bind(store);
  store.transaction=fn=>transaction(async state=>{
    const stop=armed;armed=false;
    if(stop&&barrier==='before mutation'){reached();await held;}
    const result=await fn(state);
    if(stop&&barrier.includes('after mutation')){reached();await held;}
    return result;
  });
  const broker=createAccountBroker({store,providers:createFakeRegistry(),clock:()=>1000,
    authority:{verify:async()=>ok({expiresAtMs:600000,fence:3})},
    proxy:{dispatch:async()=>{armed=true;return ok({streamId:'upstream',observation:{model:'fixture-model'},response:new Response('done')});},
      revokeStreams:async()=>({aborted:[],unconfirmed:['upstream']})}});
  t.after(async()=>{release();try{await broker.close();}finally{await rm(directory,{recursive:true,force:true});}});
  const flow=await broker.enroll({providerId:'codex',label:'Fixture'});
  const account=(await broker.complete({flowId:flow.value.flowId,answer:'subject'})).value;
  await enableFixtureModel(store,account.id,'fixture-model');
  const selection={providerId:'codex',accountId:account.id,modelId:'fixture-model',effortId:null};
  const issued=await broker.issueJobKey({selection,jobId:'job',attemptId:'attempt',leaseProof:{schemaVersion:1,signedEnvelope:'proof'}});
  assert.equal(issued.ok,true);
  const dispatch=broker.proxy.dispatch({key:issued.value.key,signal:controller.signal,request:{method:'POST',url:'https://synthetic.invalid/v1/messages',headers:{},body:{kind:'empty'}}});
  await arrived;
  const revoked=barrier.startsWith('caller abort')?(controller.abort(),Promise.resolve()):broker.revokeJobKey(issued.value.keyId);
  release();
  const result=await dispatch;await revoked;
  assert.equal(result.error.code,'job_key_revoked');
  assert.equal(broker.executionObservation({selection,jobId:'job',attemptId:'attempt'}),null);
  const operations=Object.values(store.get(account.id).dispatchOperations);
  assert.equal(operations.length,1,'rejected observation never erases unresolved cessation debt');
  assert.equal(operations[0].upstreamId,'upstream');
  assert.equal(operations[0].binding.attemptId,'attempt');
});

test('accepted response observation is usable before cleanup and unavailable after key revocation',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'faravan-observation-accepted-'));
  const store=createAccountStore({directory});
  const broker=createAccountBroker({store,providers:createFakeRegistry(),clock:()=>1000,
    authority:{verify:async()=>ok({expiresAtMs:600000,fence:3})},
    proxy:{dispatch:async()=>ok({streamId:'upstream',observation:{model:'fixture-model'},response:new Response('done')}),
      revokeStreams:async()=>({aborted:[],unconfirmed:['upstream']})}});
  t.after(async()=>{try{await broker.close();}finally{await rm(directory,{recursive:true,force:true});}});
  const flow=await broker.enroll({providerId:'codex',label:'Fixture'});
  const account=(await broker.complete({flowId:flow.value.flowId,answer:'subject'})).value;
  await enableFixtureModel(store,account.id,'fixture-model');
  const selection={providerId:'codex',accountId:account.id,modelId:'fixture-model',effortId:null};
  const issued=await broker.issueJobKey({selection,jobId:'job',attemptId:'attempt',leaseProof:{schemaVersion:1,signedEnvelope:'proof'}});
  const result=await broker.proxy.dispatch({key:issued.value.key,request:{method:'POST',url:'https://synthetic.invalid/v1/messages',headers:{},body:{kind:'empty'}}});
  assert.equal(result.ok,true);await result.value.response.text();
  assert.equal(broker.executionObservation({selection,jobId:'job',attemptId:'attempt'}).model,'fixture-model');
  await broker.revokeJobKey(issued.value.keyId);
  assert.equal(broker.executionObservation({selection,jobId:'job',attemptId:'attempt'}),null);
  assert.equal(Object.keys(store.get(account.id).dispatchOperations).length,1);
});

for(const interruption of ['caller abort','key revocation','deadline'])test('held publication verification settles on '+interruption+' and cannot accept late evidence',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'faravan-observation-verification-'));
  const store=createAccountStore({directory}),caller=new AbortController();
  let release,reached,postResponse=false,verificationSignal,disposed=0,dispatch;
  const held=new Promise(resolve=>{release=resolve;});
  const arrived=new Promise(resolve=>{reached=resolve;});
  const broker=createAccountBroker({store,providers:createFakeRegistry(),clock:()=>1000,
    authority:{verify:async input=>{
      if(postResponse){verificationSignal=input.signal;reached();await held;}
      return ok({expiresAtMs:600000,fence:3});
    }},proxy:{dispatch:async()=>{postResponse=true;return ok({streamId:'known-upstream',
      observation:{model:'fixture-model'},response:new Response('done')});},
      revokeStreams:async()=>({aborted:[],unconfirmed:['known-upstream']})}});
  t.after(async()=>{release();try{await dispatch;await broker.close();}finally{t.mock.timers.reset();await rm(directory,{recursive:true,force:true});}});
  const flow=await broker.enroll({providerId:'codex',label:'Fixture'});
  const account=(await broker.complete({flowId:flow.value.flowId,answer:'subject'})).value;
  await enableFixtureModel(store,account.id,'fixture-model');
  const selection={providerId:'codex',accountId:account.id,modelId:'fixture-model',effortId:null};
  const issued=await broker.issueJobKey({selection,jobId:'job',attemptId:'attempt',leaseProof:{schemaVersion:1,signedEnvelope:'proof'}});
  // Only the publication check is held; authentication and upstream completion succeed.
  if(interruption==='deadline')t.mock.timers.enable({apis:['setTimeout']});
  dispatch=broker.proxy.dispatch({key:issued.value.key,signal:caller.signal,request:{method:'POST',
    url:'https://synthetic.invalid/v1/messages',headers:{},body:{kind:'one_shot',dispose:async()=>{disposed++;}}}});
  await arrived;
  const debt=Object.values(store.get(account.id).dispatchOperations);
  assert.equal(debt.length,1);
  assert.equal(debt[0].upstreamId,'known-upstream','known debt is saved before waiting on publication authority');
  assert.equal(debt[0].binding.attemptId,'attempt');
  let revoke;
  if(interruption==='caller abort')caller.abort('fixture cancellation');
  else if(interruption==='key revocation')revoke=broker.revokeJobKey(issued.value.keyId);
  else t.mock.timers.tick(10000);
  const result=await Promise.race([dispatch,delay(2000).then(()=>null)]);
  assert.notEqual(result,null,'dispatch must finish without releasing the uncooperative verifier');
  assert.equal(result.ok,false);
  assert.equal(result.error.code,interruption==='deadline'?'authority_unavailable':'job_key_revoked');
  assert.equal(verificationSignal.aborted,true,'the underlying coordinator read also receives cancellation');
  assert.equal(disposed,1);
  assert.equal(broker.executionObservation({selection,jobId:'job',attemptId:'attempt'}),null);
  release();await revoke;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(disposed,1,'late verification cannot dispose or publish twice');
  assert.equal(broker.executionObservation({selection,jobId:'job',attemptId:'attempt'}),null);
  assert.equal(Object.values(store.get(account.id).dispatchOperations)[0].upstreamId,'known-upstream');
});
