import {enableFixtureModel} from '../helpers/account-model-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccountStore } from '../../lib/v1/accounts.mjs';
import { createAccountBroker } from '../../lib/v1/account-broker.mjs';

const ok = value => ({ok:true,value});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve=r; }); return {promise,resolve}; };
const descriptor = {schemaVersion:1,id:'configured-local',label:'Local fixture',signInKind:'local_harness',
  refreshKind:'none',usageKind:'none',maxConcurrentJobs:null,nativeUnits:[],
  models:[{id:'m',label:'M',efforts:[],defaultEffort:null,enabled:true,rank:0,pareto:null}],
  destinations:[{origin:'http://127.0.0.1:43123',pathPrefixes:['/run'],methods:['POST']}]};
const request = () => ({method:'POST',url:'http://127.0.0.1:43123/run',headers:{},body:{kind:'empty',dispose:async()=>{}}});

async function fixture(t, proxy, adapterOverride, authorityOverride) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pi-journal-'));
  const store=createAccountStore({directory});
  let flow=0;
  const adapter=adapterOverride ?? {descriptor,
    beginSignIn:async()=>ok({flowId:'flow-'+(++flow),state:'complete',presentation:{kind:'local'}}),
    finishSignIn:async({flowId})=>ok({subjectId:flowId,secret:null,expiresAtMs:null}),
    cancelSignIn:async()=>{}, authorizeRequest:async({request})=>ok(request),
    classifyReplay:()=> 'never'};
  const broker=createAccountBroker({store,providers:{getProvider:()=>ok(adapter)},proxy,
    authority:authorityOverride ?? {verify:async()=>ok({expiresAtMs:Date.now()+60000,fence:4})}});
  t.after(async()=>{ await broker.close(); fs.rmSync(directory,{recursive:true,force:true}); });
  const enrolled=await broker.enroll({providerId:descriptor.id,label:'A',signal:new AbortController().signal});
  const account=await broker.complete({flowId:enrolled.value.flowId,signal:new AbortController().signal});
  assert.equal(account.ok,true);
  await enableFixtureModel(store,account.value.id,'m');
  // Actual store hydration, not an in-memory substitute for credentialless enrollment.
  assert.equal(createAccountStore({directory}).get(account.value.id).secret,null);
  const issue=async accountId=> {
    const issued=await broker.issueJobKey({selection:{providerId:descriptor.id,accountId,modelId:'m',effortId:null},
      jobId:'job',attemptId:'attempt',leaseProof:{schemaVersion:1,signedEnvelope:'synthetic'}});
    assert.equal(issued.ok,true); return issued.value;
  };
  return {store,broker,account:account.value,issue};
}

test('private operation IDs reconcile two revoked pending dispatches separately', async t=>{
  const entered=deferred(), pending=[], receipts=[];
  const proxy={
    async dispatch(input) {
      const wait=deferred(); pending.push({input,wait});
      if(pending.length===2) entered.resolve();
      await wait.promise;
      receipts.push({operationId:input.binding.operationId,streamId:'actual-'+pending.indexOf(pending.find(p=>p.input===input)),ceasedAtMs:Date.now()});
      return {ok:false,error:{code:'job_key_revoked'}};
    },
    async revokeStreams() { return {aborted:receipts.map(r=>r.streamId),
      unconfirmed:pending.filter(p=>!receipts.some(r=>r.operationId===p.input.binding?.operationId)).map((_,i)=>'pending-'+i),
      reconciled:structuredClone(receipts)}; }
  };
  const {store,broker,account,issue}=await fixture(t,proxy);
  const key=await issue(account.id);
  const first=broker.proxy.dispatch({key:key.key,request:request(),signal:new AbortController().signal});
  const second=broker.proxy.dispatch({key:key.key,request:request(),signal:new AbortController().signal});
  t.after(()=>{ for(const p of pending)p.wait.resolve(); });
  await entered.promise;
  const ids=Object.keys(store.get(account.id).dispatchOperations);
  assert.equal(ids.length,2);
  assert.deepEqual(new Set(pending.map(p=>p.input.binding?.operationId)),new Set(ids));
  assert.notEqual(pending[0].input.binding.operationId,pending[1].input.binding.operationId);
  await broker.revokeJobKey(key.keyId);
  pending[0].wait.resolve(); assert.equal((await first).ok,false);
  await broker.revokeJobKey(key.keyId);
  const remaining=Object.keys(store.get(account.id).dispatchOperations);
  assert.deepEqual(remaining,[pending[1].input.binding.operationId]);
  assert.equal((await broker.remove(account.id)).error.code,'account_removal_pending');
  pending[1].wait.resolve(); assert.equal((await second).ok,false);
  await broker.revokeJobKey(key.keyId);
  assert.deepEqual(Object.keys(store.get(account.id).dispatchOperations),[]);
  await broker.revokeJobKey(key.keyId); // immutable tombstone replay
  assert.equal((await broker.remove(account.id)).ok,true);
});

test('pi transport keeps pending debt and stops late handles without success', async()=>{
  const {createPiTransport}=await import('../../lib/v1/providers/pi.mjs');
  const wait=deferred(), entered=deferred(); let stops=0;
  const binding={operationId:'op',keyId:'key',selection:{accountId:'a',providerId:'p',modelId:'m',effortId:null},
    jobId:'j',attemptId:'attempt',generation:0,fence:1};
  const transport=createPiTransport({invoke:async input=>{
    assert.equal(Object.hasOwn(input,'key'),false); entered.resolve(); await wait.promise;
    return ok({streamId:'actual',response:new Response('unused'),
      stop:async()=>{stops++;return {kind:'ceased',ceasedAtMs:1};}});
  }});
  const result=transport.dispatch({key:'do-not-forward',request:request(),binding,signal:new AbortController().signal});
  await entered.promise;
  assert.deepEqual((await transport.revokeStreams({keyId:'key',reason:'stop'})).aborted,[]);
  wait.resolve(); assert.equal((await result).ok,false);
  const receipt=await transport.revokeStreams({keyId:'key',reason:'stop'});
  assert.deepEqual(receipt,{aborted:['actual'],unconfirmed:[],reconciled:[{operationId:'op',streamId:'actual',ceasedAtMs:1}]});
  assert.deepEqual(await transport.revokeStreams({keyId:'other',reason:'stop'}),{aborted:[],unconfirmed:[],reconciled:[]});
  assert.deepEqual(await transport.revokeStreams({keyId:'key',reason:'stop'}),receipt);
  assert.equal(stops,1);
});

test('unknown or throwing stop never becomes positive cessation', async()=>{
  const {createPiTransport}=await import('../../lib/v1/providers/pi.mjs');
  for(const stop of [async()=>({kind:'unconfirmed'}),async()=>{throw Error('unknown');}]) {
    const transport=createPiTransport({invoke:async()=>ok({streamId:'s',response:new Response(null),stop})});
    const result=await transport.dispatch({request:request(),signal:new AbortController().signal,
      binding:{operationId:'o',keyId:'k',selection:{accountId:'a',providerId:'p',modelId:'m',effortId:null},
        jobId:'j',attemptId:'a',generation:0,fence:1}});
    assert.equal(result.ok,true);
    const receipt=await transport.revokeStreams({keyId:'k',reason:'stop'});
    assert.deepEqual(receipt.aborted,[]); assert.deepEqual(receipt.reconciled,[]);
    assert.deepEqual(receipt.unconfirmed,['o']);
  }
});

test('configured local provider enrolls a null credential through actual store', async t=>{
  const {createPiProvider}=await import('../../lib/v1/providers/pi.mjs');
  const adapter=createPiProvider({descriptor,identity:'configured-subject',
    createRun:()=>ok({schemaVersion:1,command:'fixture-only',args:[],env:{},proxy:{},receipt:{},enforcement:{}})});
  const {account,broker,issue}=await fixture(t,{dispatch:async()=>{throw Error('not called');},
    revokeStreams:async()=>({aborted:[],unconfirmed:[]})},adapter);
  assert.equal(account.authState,'signed_in');
  const key=await issue(account.id);
  let disposed=0; const req=request(); req.url='https://outside.invalid/run'; req.body.dispose=async()=>{disposed++;};
  assert.equal((await broker.proxy.dispatch({key:key.key,request:req,signal:new AbortController().signal})).error.code,'destination_denied');
  assert.equal(disposed,1);
});

test('broker rejects foreign, duplicate, conflicting and future reconciliation without clearing debt', async t=>{
  let captured, receipt={aborted:[],unconfirmed:[],reconciled:[]};
  const proxy={dispatch:async input=>{captured=input.binding;return {ok:false,error:{code:'uncertain'}};},
    revokeStreams:async()=>structuredClone(receipt)};
  const {store,broker,account,issue}=await fixture(t,proxy);
  const key=await issue(account.id);
  assert.equal((await broker.proxy.dispatch({key:key.key,request:request(),signal:new AbortController().signal})).ok,false);
  const item={operationId:captured.operationId,streamId:'actual',ceasedAtMs:1};
  for(const items of [[{...item,operationId:'foreign'}],[item,item],[{...item,ceasedAtMs:Date.now()+1000000}]]) {
    receipt={aborted:['actual'],unconfirmed:[],reconciled:items};
    await broker.revokeJobKey(key.keyId);
    assert.equal(Object.keys(store.get(account.id).dispatchOperations).length,1);
    assert.equal(store.get(account.id).guestKeys[key.keyId].confirmed,false);
  }
  await store.transaction(state=>{state.records[account.id].dispatchOperations[item.operationId].upstreamId='different';});
  receipt={aborted:['actual'],unconfirmed:[],reconciled:[item]};
  await broker.revokeJobKey(key.keyId);
  assert.equal(Object.keys(store.get(account.id).dispatchOperations).length,1);
  await store.transaction(state=>{state.records[account.id].dispatchOperations[item.operationId].upstreamId=null;});
  // Failure at publication must not be mistaken for a persisted stop receipt.
  const original=store.transaction;
  store.transaction=async()=>{throw Error('synthetic persistence failure');};
  await assert.rejects(()=>broker.proxy.revokeStreams({keyId:key.keyId,reason:'stop',accountId:account.id}));
  store.transaction=original;
  assert.equal(Object.keys(store.get(account.id).dispatchOperations).length,1);
  await broker.revokeJobKey(key.keyId);
  assert.equal(Object.keys(store.get(account.id).dispatchOperations).length,0);
});

test('two actual enrolled accounts keep stream stop ownership isolated', async t=>{
  const {createPiTransport}=await import('../../lib/v1/providers/pi.mjs');
  const stops=[], handles=[];
  const transport=createPiTransport({invoke:async({binding})=>{
    handles.push(binding);
    return ok({streamId:'s-'+binding.keyId,response:new Response(new ReadableStream({pull(){}})),
      stop:async()=>{stops.push(binding.keyId);return {kind:'ceased',ceasedAtMs:1};}});
  }});
  const {store,broker,account,issue}=await fixture(t,transport);
  const flow=await broker.enroll({providerId:descriptor.id,label:'B',signal:new AbortController().signal});
  const second=await broker.complete({flowId:flow.value.flowId,signal:new AbortController().signal});
  assert.equal(second.ok,true);
  await enableFixtureModel(store,second.value.id,'m');
  const a=await issue(account.id), b=await issue(second.value.id);
  const ra=await broker.proxy.dispatch({key:a.key,request:request(),signal:new AbortController().signal});
  const rb=await broker.proxy.dispatch({key:b.key,request:request(),signal:new AbortController().signal});
  assert.equal(ra.ok,true); assert.equal(rb.ok,true);
  await broker.revokeJobKey(a.keyId);
  assert.deepEqual(stops,[a.keyId]);
  assert.equal(Object.keys(store.get(second.value.id).dispatchOperations).length,1);
  assert.equal(store.get(second.value.id).guestKeys[b.keyId].revoked,false);
  await ra.value.response.body.cancel().catch(()=>{});
  await rb.value.response.body.cancel().catch(()=>{});
  await broker.revokeJobKey(b.keyId);
});

test('guest binding hints and revoked keys cannot invoke local effects', async t=>{
  let calls=0;
  const proxy={dispatch:async()=>{calls++;throw Error('not permitted');},
    revokeStreams:async()=>({aborted:[],unconfirmed:[]})};
  const {broker,account,issue}=await fixture(t,proxy);
  const key=await issue(account.id);
  for(const [header,value] of [['x-faravan-account-id','foreign'],['x-faravan-job-id','wrong'],['x-faravan-attempt-id','wrong']]) {
    const req=request(); req.headers={[header]:value};
    assert.equal((await broker.proxy.dispatch({key:key.key,request:req,signal:new AbortController().signal})).ok,false);
  }
  const denied=request(); denied.url='https://outside.invalid/run';
  assert.equal((await broker.proxy.dispatch({key:key.key,request:denied,signal:new AbortController().signal})).ok,false);
  await broker.revokeJobKey(key.keyId);
  assert.equal((await broker.proxy.dispatch({key:key.key,request:request(),signal:new AbortController().signal})).ok,false);
  assert.equal(calls,0);
});

test('generation change after adapter authorization blocks final dispatch', async t=>{
  const authorized=deferred(), resume=deferred(); let flow=0,calls=0;
  const adapter={descriptor,beginSignIn:async()=>ok({flowId:'f'+(++flow),state:'complete',presentation:{kind:'local'}}),
    finishSignIn:async()=>ok({subjectId:'subject',secret:null,expiresAtMs:null}),cancelSignIn:async()=>{},
    authorizeRequest:async({request})=>{authorized.resolve();await resume.promise;return ok(request);},
    classifyReplay:()=> 'never'};
  const {store,broker,account,issue}=await fixture(t,{dispatch:async()=>{calls++;throw Error('late effect');},
    revokeStreams:async()=>({aborted:[],unconfirmed:[]})},adapter);
  const key=await issue(account.id);
  const pending=broker.proxy.dispatch({key:key.key,request:request(),signal:new AbortController().signal});
  await authorized.promise;
  await store.compareAndSwap(account.id,0,{generation:1});
  resume.resolve(); assert.equal((await pending).ok,false);
  assert.equal(calls,0);
});

test('expired authority after key issuance denies invocation and disposes once', async t=>{
  let expired=false,calls=0,disposed=0;
  const authority={verify:async()=>ok({expiresAtMs:expired?0:Date.now()+60000,fence:4})};
  const {broker,account,issue}=await fixture(t,{dispatch:async()=>{calls++;throw Error('unexpected');},
    revokeStreams:async()=>({aborted:[],unconfirmed:[]})},undefined,authority);
  const key=await issue(account.id); expired=true;
  const req=request(); req.body={kind:'one_shot',stream:new ReadableStream({start(c){c.close();}}),dispose:async()=>{disposed++;}};
  assert.equal((await broker.proxy.dispatch({key:key.key,request:req,signal:new AbortController().signal})).ok,false);
  assert.equal((await broker.proxy.dispatch({key:key.key,request:req,signal:new AbortController().signal})).error.code,'body_already_consumed');
  assert.equal(calls,0); assert.equal(disposed,1);
});

test('broker supplies trusted copied binding, ignoring a guest top-level spoof', async t=>{
  let seen;
  const {store,broker,account,issue}=await fixture(t,{dispatch:async input=>{
    seen=input.binding; input.binding.selection.accountId='mutated-in-transport';
    return {ok:false,error:{code:'uncertain'}};
  },revokeStreams:async()=>({aborted:[],unconfirmed:['unknown']})});
  const key=await issue(account.id);
  await broker.proxy.dispatch({key:key.key,request:request(),signal:new AbortController().signal,
    binding:{operationId:'guest',keyId:'guest',generation:999,fence:999}});
  assert.equal(seen.keyId,key.keyId); assert.notEqual(seen.operationId,'guest');
  assert.equal(seen.generation,0); assert.equal(seen.fence,4);
  assert.equal(store.get(account.id).dispatchOperations[seen.operationId].binding.selection.accountId,account.id);
});

test('EOF is not a cessation receipt; explicit legacy acknowledgement still works', async t=>{
  const {store,broker,account,issue}=await fixture(t,{dispatch:async()=>ok({streamId:'actual',response:new Response('done')}),
    revokeStreams:async()=>({aborted:['actual'],unconfirmed:[]})});
  const key=await issue(account.id);
  const result=await broker.proxy.dispatch({key:key.key,request:request(),signal:new AbortController().signal});
  assert.equal(await result.value.response.text(),'done');
  assert.equal(Object.keys(store.get(account.id).dispatchOperations).length,1);
  await broker.revokeJobKey(key.keyId);
  assert.equal(Object.keys(store.get(account.id).dispatchOperations).length,0);
});

test('malformed private binding does not call invoke', async()=>{
  const {createPiTransport}=await import('../../lib/v1/providers/pi.mjs');
  let calls=0; const transport=createPiTransport({invoke:async()=>{calls++;throw Error('unexpected');}});
  for(const binding of [undefined,{}, {operationId:'o',keyId:'k',generation:-1,fence:0}])
    assert.equal((await transport.dispatch({request:request(),signal:new AbortController().signal,binding})).ok,false);
  assert.equal(calls,0);
});

test('real broker plus pi transport resolves each same-key late handle independently', async t=>{
  const {createPiTransport}=await import('../../lib/v1/providers/pi.mjs');
  const entered=deferred(), calls=[], stops=[];
  const transport=createPiTransport({invoke:async({binding})=>{
    const wait=deferred(); calls.push({binding,wait});
    if(calls.length===2)entered.resolve();
    await wait.promise;
    return ok({streamId:'actual-'+binding.operationId,response:new Response(null),
      stop:async()=>{stops.push(binding.operationId);return {kind:'ceased',ceasedAtMs:1};}});
  }});
  const {store,broker,account,issue}=await fixture(t,transport);
  const key=await issue(account.id);
  const requests=[0,1].map(()=>broker.proxy.dispatch({key:key.key,request:request(),signal:new AbortController().signal}));
  t.after(async()=>{calls.forEach(c=>c.wait.resolve());await Promise.allSettled(requests);});
  await entered.promise;
  await broker.revokeJobKey(key.keyId);
  calls[0].wait.resolve(); assert.equal((await requests[0]).ok,false);
  await broker.revokeJobKey(key.keyId);
  assert.deepEqual(Object.keys(store.get(account.id).dispatchOperations),[calls[1].binding.operationId]);
  assert.equal((await broker.remove(account.id)).error.code,'account_removal_pending');
  calls[1].wait.resolve(); assert.equal((await requests[1]).ok,false);
  await broker.revokeJobKey(key.keyId);
  assert.deepEqual(stops,calls.map(c=>c.binding.operationId));
  assert.equal((await broker.remove(account.id)).ok,true);
});
