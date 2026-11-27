import {join} from 'node:path';
import {tmpdir} from 'node:os';
import '../helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {createHostProviderRegistry} from '../../lib/v1/providers/host-registry.mjs';
import {createAccountStore} from '../../lib/v1/accounts.mjs';
import {createAccountBroker} from '../../lib/v1/account-broker.mjs';
import {appFixture,api} from '../helpers/v1-app-fixture.mjs';

function nativeEffects(){
 let time=1000000,rotations=0,logins=0;const calls=[];
 const drivers=Object.fromEntries(['claude','codex'].map(id=>[id,{
  getModels:()=>[{id:'native-model',name:'Native',reasoning:true}],auth:{oauth:{
   async login(interaction){logins++;interaction.notify({type:'auth_url',url:'https://controlled.invalid/'+id});
    const answer=await interaction.prompt({type:'manual_code',message:'Owned login'});
    return {type:'oauth',access:'NATIVE_ACCESS_'+answer,refresh:'NATIVE_REFRESH_'+answer,expires:time+600000,accountId:'subject-'+answer};
   },
   async refresh(credential){rotations++;return {...credential,access:credential.access+'_ROTATED',refresh:credential.refresh+'_ROTATED',expires:time+600000};},
  }},
 }]));
 const send=async(url,options)=>{calls.push({url,headers:options.headers});
  if(url.endsWith('/profile'))return Response.json({account:{uuid:'subject-'+options.headers.authorization.replace('Bearer NATIVE_ACCESS_','').replaceAll('_ROTATED','')}});
  if(url.endsWith('/usage')&&url.includes('anthropic'))return Response.json({extra_usage:{is_enabled:false},seven_day:{utilization:12,resets_at:new Date(time+86400000).toISOString()}});
  if(url.endsWith('/usage'))return Response.json({plan_type:'pro',rate_limit:{allowed:true,limit_reached:false,
    secondary_window:{limit_window_seconds:604800,used_percent:14,reset_at:Math.floor((time+86400000)/1000)}}});
  assert.fail('unexpected native effect '+url);
 };
 return {drivers,send,calls,now:()=>time,advance:ms=>{time+=ms;},rotations:()=>rotations,logins:()=>logins};
}
test('actual app default construction enrolls independent host subscription subjects using injected OAuth effects',async t=>{
 const effects=nativeEffects(),f=await appFixture(t);
 const {app}=await f.start('native',{accountNativeDrivers:effects.drivers,accountTransportFetch:effects.send,clock:{now:effects.now}});
 const before=await api(app,'/api/accounts');assert.deepEqual(before.providers.map(p=>p.id).sort(),['claude','codex']);
 assert.equal(effects.logins(),0,'loading defaults neither signs in nor discovers CLI credentials');
 const accounts=[];
 for(const [id,answer] of [['codex','one'],['codex','two'],['claude','three']]){
  const flow=await api(app,'/api/accounts',{method:'POST',body:{providerId:id,label:answer,operationId:'enroll-'+answer}});
  assert.equal(flow.value.presentation.kind,'browser');
  const result=await api(app,'/api/accounts/flows/'+flow.value.flowId+'/complete',{method:'POST',body:{answer}});
  assert.equal(result.ok,true);accounts.push(result.value);
 }
 assert.equal(new Set(accounts.map(a=>a.id)).size,3);
 const listed=await api(app,'/api/accounts');assert.equal(listed.accounts.length,3);
 assert.doesNotMatch(JSON.stringify(listed),/NATIVE_ACCESS|NATIVE_REFRESH|subject-/);
 assert.equal(effects.logins(),3);
});
for(const id of ['claude','codex'])test('native '+id+' refresh, usage normalization and cancellation use the real broker/store',async t=>{
 const e=nativeEffects(),directory=await mkdtemp(join(tmpdir(),'faravan-native-auth-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const providers=createHostProviderRegistry({proxyOrigin:()=> 'https://broker.invalid',nativeDrivers:e.drivers,fetch:e.send,clock:e.now});
 const store=createAccountStore({directory}),broker=createAccountBroker({store,providers,clock:e.now});t.after(()=>broker.close());
 const enroll=async answer=>{const flow=await broker.enroll({providerId:id,label:answer});return broker.complete({flowId:flow.value.flowId,answer});};
 const account=(await enroll('one')).value;assert.ok(account.id);const initialGeneration=store.get(account.id).generation;
 assert.equal((await enroll('one')).error.code,'account_exists');
 const snapshot=await broker.getAccountUsage(account.id).requestRead({reason:'admission'});
 assert.equal(snapshot.reading.accountId,account.id);assert.equal(snapshot.reading.coverage.kind,'unknown');
 assert.equal(snapshot.reading.postingUncertaintyMs,null);assert.ok(snapshot.reading.windows.length>0);
 assert.equal(e.calls.filter(call=>call.url.endsWith('/usage')).length,1);
 await broker.getAccountUsage(account.id).requestRead({reason:'status'});assert.equal(e.calls.filter(call=>call.url.endsWith('/usage')).length,1);
 e.advance(550000);
 const values=await Promise.all(Array.from({length:20},()=>broker.withAuth(account.id,auth=>({generation:auth.generation,subject:auth.secret.subjectId}))));
 assert.ok(values.every(v=>v.ok&&v.value.subject===store.get(account.id).subjectId));assert.equal(e.rotations(),1);
 assert.equal(store.get(account.id).generation,initialGeneration+1);
 const flow=await broker.enroll({providerId:id,label:'cancelled'});assert.equal((await broker.cancelSignIn(flow.value.flowId)).ok,true);
 assert.equal((await broker.list()).length,1);
});

for(const id of ['claude','codex'])test('native '+id+' maps exact model/effort through a guest key and host-only authorization',async()=>{
 const e=nativeEffects(),registry=createHostProviderRegistry({proxyOrigin:()=> 'https://broker.invalid',nativeDrivers:e.drivers,fetch:e.send,clock:e.now});
 const adapter=registry.getProvider(id).value;
 const selection={accountId:'owned',providerId:id,modelId:'native-model',effortId:'high'};
 const amount={unit:'window_micro_points',byResource:[{id:'seven_day',instance:'w',amount:100}]};
 const receipt={schemaVersion:1,accountId:'owned',jobId:'j',attemptId:'t',policyVersion:'v',quotedLedgerRevision:0,settingsRevision:1,
  evaluatedAtMs:e.now(),amount,mode:'observed'};
 const enforcement={amount,wallLimitMs:60000,stopOnBudget:true,metering:'estimated',limitations:[]};
 const run=adapter.makeRun({selection,jobKey:'GUEST_KEY',job:{selection,promptText:'owned prompt'},receipt,enforcement});
 assert.equal(run.ok,true,JSON.stringify(run));assert.deepEqual(run.value.receipt,receipt);
 assert.equal(Object.values(run.value.env).includes('GUEST_KEY'),true);assert.doesNotMatch(JSON.stringify(run),/NATIVE_ACCESS|NATIVE_REFRESH/);
 assert.ok(run.value.args.includes('native-model'));
 assert.ok(run.value.args.includes(id==='codex'?'model_reasoning_effort=high':'high'));
 assert.equal(adapter.makeRun({selection:{...selection,modelId:'not-offered'},jobKey:'GUEST_KEY',job:{selection},receipt,enforcement}).ok,false);
 const auth={accountId:'owned',providerId:id,generation:3,secret:{subjectId:'subject-one',credential:{type:'oauth',access:'NATIVE_ACCESS_one',refresh:'NATIVE_REFRESH_one',expires:e.now()+600000}}};
 const request={method:'POST',url:id==='codex'?'https://chatgpt.com/backend-api/codex/responses':'https://api.anthropic.com/v1/messages',headers:{authorization:'guest',cookie:'guest-cookie'},body:{kind:'empty'}};
 assert.equal((await adapter.authorizeRequest({auth,request})).ok,false,'unknown funding cannot authorize a native subscription call');
 const usage=await adapter.readUsage({auth,signal:new AbortController().signal});assert.equal(usage.kind,'reading');
 const authorized=await adapter.authorizeRequest({auth,request});assert.equal(authorized.ok,true);
 assert.equal(authorized.value.headers.authorization,'Bearer NATIVE_ACCESS_one');assert.equal(authorized.value.headers.cookie,undefined);
 assert.equal((await adapter.authorizeRequest({auth,request:{...request,url:'https://foreign.invalid/v1/messages'}})).ok,false);
});

test('native subscription authorization retains unknown funding and refuses explicit paid/exhausted evidence',async()=>{
 const e=nativeEffects();
 for(const id of ['claude','codex']){
  const registry=createHostProviderRegistry({proxyOrigin:()=> 'https://broker.invalid',nativeDrivers:e.drivers,clock:e.now,
   fetch:async()=>Response.json(id==='codex'?{plan_type:'pro',rate_limit:{allowed:false,limit_reached:false,
    secondary_window:{limit_window_seconds:604800,used_percent:100,reset_at:100000}}}:
    {extra_usage:{is_enabled:true},seven_day:{utilization:90,resets_at:'2026-11-17T00:00:00Z'}})});
  const adapter=registry.getProvider(id).value,auth={accountId:'owned',providerId:id,generation:4,
   secret:{subjectId:'subject',credential:{access:'SENTINEL_ACCESS',refresh:'SENTINEL_REFRESH',expires:2000000}}};
  await adapter.readUsage({auth,signal:new AbortController().signal});
  assert.notEqual(adapter.requiredEvidence({accountId:'owned',generation:4}).funding.subscription_only,'proven');
  const request={method:'POST',url:id==='codex'?'https://chatgpt.com/backend-api/codex/responses':'https://api.anthropic.com/v1/messages',headers:{},body:{kind:'empty'}};
  assert.equal((await adapter.authorizeRequest({auth,request})).ok,false);
  assert.equal(adapter.requiredEvidence({accountId:'other',generation:4}).funding.subscription_only,'unknown');
  assert.equal(adapter.requiredEvidence({accountId:'owned',generation:5}).funding.subscription_only,'unknown');
 }
});

test('Claude refresh authenticates the refreshed credential subject before replacement',async t=>{
 const e=nativeEffects();let changed=false;
 const providers=createHostProviderRegistry({proxyOrigin:()=> 'https://broker.invalid',nativeDrivers:e.drivers,clock:e.now,
  fetch:(url,options)=>changed&&url.endsWith('/profile')?Promise.resolve(Response.json({account:{uuid:'foreign-subject'}})):e.send(url,options)});
 const directory=await mkdtemp(join(tmpdir(),'faravan-native-auth-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const store=createAccountStore({directory}),broker=createAccountBroker({store,providers,clock:e.now});t.after(()=>broker.close());
 const flow=await broker.enroll({providerId:'claude',label:'owned'});
 const account=(await broker.complete({flowId:flow.value.flowId,answer:'one'})).value,before=store.get(account.id);
 changed=true;e.advance(550000);
 const refreshed=await broker.withAuth(account.id,()=>assert.fail('foreign refreshed subject must not reach the effect'));
 assert.equal(refreshed.ok,false);assert.equal(store.get(account.id).subjectId,before.subjectId);
 assert.equal(store.get(account.id).generation,before.generation);
});
