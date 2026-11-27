import {enableFixtureModel} from './helpers/account-model-fixture.mjs';
import {tempDir} from './helpers/temp-dir.mjs';
import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import * as protocol from '../lib/protocol/index.mjs';
import {signLease,verifyLease} from '../lib/v1/account-authority.mjs';

const selection={providerId:'codex',accountId:'a',modelId:'m',effortId:'medium'};
const binding={circle:'circle',holder:'holder',jobId:'job',attemptId:'attempt',selection,
  fence:1,membershipEpoch:1,expiresAtMs:2000};
test('signed coordinator authority binds the exact account, model, effort, attempt and current fence',()=>{
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const proof=signLease(binding,privateKey);
  assert.equal(verifyLease(proof,publicKey,binding,1000).ok,true);
  for(const changes of [{jobId:'other'},{attemptId:'other'},{fence:2},{membershipEpoch:2},
    {selection:{...selection,accountId:'b'}},{selection:{...selection,providerId:'claude'}},
    {selection:{...selection,modelId:'other'}},{selection:{...selection,effortId:'high'}}])
    assert.equal(verifyLease(proof,publicKey,{...binding,...changes},1000).ok,false,JSON.stringify(changes));
  assert.equal(verifyLease(proof,publicKey,binding,2000).ok,false);
  const altered=JSON.parse(proof.signedEnvelope);altered.payload.expiresAtMs=9000;
  assert.equal(verifyLease({...proof,signedEnvelope:JSON.stringify(altered)},publicKey,binding,1000).ok,false);
  assert.equal(verifyLease(proof,generateKeyPairSync('ed25519').publicKey,binding,1000).ok,false);
});

import {appFixture,api,syntheticBackend,waitFor} from './helpers/v1-app-fixture.mjs';
const providerConfiguration={
  descriptor:{schemaVersion:1,id:'codex',label:'Configured key service',signInKind:'api_key',refreshKind:'none',
    usageKind:'job_local',maxConcurrentJobs:1,nativeUnits:[{id:'tokens',scale:1}],
    models:[{id:'example-model',label:'Example',enabled:true,rank:0,pareto:null,
      efforts:[{id:'high',label:'High'}],defaultEffort:'high'}],
    destinations:[{origin:'https://controlled.invalid',pathPrefixes:['/v1'],methods:['POST']}]},
  identityUrl:'https://controlled.invalid/me',identitySubjectField:'subject',command:'codex',args:['exec'],modelFlag:'-m',effortFlag:'--effort',keyEnv:'JOB_KEY',baseUrlEnv:'BASE_URL',
};
async function enroll(app,key,operationId){
  const flow=await api(app,'/api/accounts',{method:'POST',body:{providerId:'codex',label:operationId,operationId}});
  const account=(await api(app,'/api/accounts/flows/'+flow.value.flowId+'/complete',{method:'POST',body:{answer:key}})).value;
  const {revision}=await api(app,'/api/accounts');
  const settings=await api(app,'/api/accounts/'+account.id+'/settings',{method:'POST',
    body:{expectedRevision:revision,modelPreference:{modelId:'example-model',enabled:true,effortIds:null}}});
  assert.equal(settings.ok,true,JSON.stringify(settings));
  return account;
}
test('configured app enrollment produces accounts used by signed coordinator, lender, broker, provider run and result',{timeout:150000},async t=>{
  const f=await appFixture(t);const upstream=[];let lenderApp;
  const backend=syntheticBackend(f.root);
  backend.prepareAccountRun=async(spec)=>{
    const h=await backend.prepare(spec);h.job_id=spec.job_id;h.sandbox_id='controlled-'+randomUUID();h._cleanupId=randomUUID();return h;
  };
  backend.inspect=async h=>({job_id:h.job_id,status:'exited'});
  const originalStart=backend.start.bind(backend);
  backend.start=async(h,opts)=>{
    assert.doesNotMatch(h._entrypoint,/CONTROLLED_SECRET_/);
    if(h._entrypoint.startsWith('env ')){
      const key=/JOB_KEY=([^']+)/.exec(h._entrypoint)[1];
      const base=/BASE_URL=([^']+)/.exec(h._entrypoint)[1];
      const response=await fetch(base+'/responses',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},
        body:JSON.stringify({model:'example-model',effort:'high'})});
      assert.equal(response.status,200,await response.text());
      h._entrypoint='completed-controlled-provider';
    }
    return originalStart(h,opts);
  };
  const connected=await f.realConnect({lenderOptions:{backend,accountProviderConfigurations:[providerConfiguration],
    accountTransportFetch:async(url,options)=>{if(options.method==='GET')return Response.json({subject:options.headers.authorization==='Bearer CONTROLLED_SECRET_A'?'subject-a':'subject-b'});upstream.push({url,headers:options.headers,body:JSON.parse(options.body)});
      return Response.json({id:'resp_controlled_'+upstream.length,object:'response',status:'completed',model:'example-model'});}}});
  const {owner,lender,circle,realHeartbeats}=connected;lenderApp=lender.app;
  const a=await enroll(lender.app,'CONTROLLED_SECRET_A','enroll-a');
  const b=await enroll(lender.app,'CONTROLLED_SECRET_B','enroll-b');
  assert.notEqual(a.id,b.id);
  assert.doesNotMatch(JSON.stringify(await api(lender.app,'/api/accounts')),/CONTROLLED_SECRET/);
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const client=await owner.app.device.client(circle.id);
  const advertisedAfter = (start, expected) => waitFor(() => {
    const beat = realHeartbeats.slice(start).filter(row => row.device === lender.app.device.keyId).at(-1)?.body;
    if (!beat) return false;
    const ids = (beat.accounts ?? []).map(item => item.accountId);
    assert.equal(beat.capabilities.includes('run_request_v1'), ids.length > 0);
    return ids.length === expected.length && expected.every(id => ids.includes(id));
  }, 'fresh advertised accounts ' + expected.length, 30000);
  const setEnabled = async (account, enabled) => {
    const {revision} = await api(lender.app, '/api/accounts');
    const changed = await api(lender.app, '/api/accounts/' + account.id + '/settings', {
      method: 'POST', body: {expectedRevision: revision, enabled},
    });
    assert.equal(changed.ok, true, JSON.stringify(changed));
  };
  const submit = index => api(owner.app, '/api/jobs', {method: 'POST', body: {
    circle: circle.id, prompt: 'Controlled account execution ' + index,
    git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40), harness: 'codex',
    runRequest: {schemaVersion: 1, models: [{providerId: 'codex', modelId: 'example-model'}], effortId: 'high'},
  }});

  await advertisedAfter(0, [a.id, b.id]);
  await setEnabled(a, false);
  const beforeDisable = realHeartbeats.length;
  await setEnabled(b, false);
  await advertisedAfter(beforeDisable, []);

  const queued = await submit(0);
  const beforeEnable = await client.getJob(queued.jobDigest);
  assert.equal(beforeEnable.job_digest, queued.jobDigest);
  assert.equal(beforeEnable.state, 'queued');
  assert.deepEqual(await api(lender.app, '/api/approvals'), []);
  assert.equal(backend.calls.filter(([kind]) => kind === 'run').length, 0);
  const beforeWake = realHeartbeats.length;
  await setEnabled(a, true);
  await advertisedAfter(beforeWake, [a.id]);

  for(const [index,account] of [a,b].entries()){
    if(index){await setEnabled(b, true);const settings=await api(lender.app,'/api/accounts');
      await api(lender.app,'/api/accounts/'+b.id+'/settings',{method:'POST',body:{expectedRevision:settings.revision,accountOrder:[b.id,a.id]}});}
    const order=index?[b.id,a.id]:[a.id,b.id];
    // Claim-time honesty (design 1119 item 3): an account whose consumed estimate would not lend is not
    // advertised at all, so after the first job its account may legitimately drop from the list. The order
    // proof is the first advertised account.
    await waitFor(()=>{const rows=realHeartbeats.filter(row=>row.device===lender.app.device.keyId);
      const accounts=rows.at(-1)?.body.accounts?.map(item=>item.accountId)??[];
      return accounts[0]===order[0];},'published account order',30000);
    const submitted = index ? await submit(index) : queued;
    const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))
      .find(row=>row.jobDigest===submitted.jobDigest),'account approval for the same signed job',30000);
    await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
    const view=await waitFor(async()=>{const v=await client.getJob(submitted.jobDigest);return v.state==='result-accepted'?v:null;},'account-bound signed result',20000).catch(async error=>{
      console.error('LENDING LOG',JSON.stringify(await api(lender.app,'/api/lending/log')));
      console.error('VIEW',JSON.stringify(await client.getJob(submitted.jobDigest)));throw error;});
    const result=await client.fetchResult(submitted.jobDigest,{includeMetadata:true,attempt:view.current_attempt});
    assert.deepEqual(result.receipt.selection,{providerId:'codex',accountId:account.id,modelId:'example-model',effortId:'high'});
    assert.equal(upstream.length,index+1);assert.equal(upstream[index].headers.authorization,'Bearer CONTROLLED_SECRET_'+(index?'B':'A'));
    assert.equal(backend.calls.filter(([kind])=>kind==='run').length,index+1);
  }
  assert.equal(backend.calls.filter(([kind])=>kind==='run').length,2);
  assert.ok(backend.calls.filter(([kind])=>kind==='prepare').every(([,spec])=>spec.resources.wall_seconds===60));
  await api(lenderApp,'/api/lending/off',{method:'POST',body:{}});
});


for(const stop of [false,true])test(stop?'Stop reaches a running signed account job':
  'first signed Auto account job launches with cold_pace without review',{timeout:90000},async t=>{
  const f=await appFixture(t),backend=syntheticBackend(f.root,{hold:stop});
  t.after(()=>backend.release());
  let brokerResponses=0;
  backend.prepareAccountRun=async spec=>{
    const h=await backend.prepare(spec);
    h.job_id=spec.job_id;h.sandbox_id='cold-'+randomUUID();h._cleanupId=randomUUID();return h;
  };
  backend.inspect=async h=>({job_id:h.job_id,status:'exited'});
  const originalStart=backend.start.bind(backend);
  backend.start=async(h,opts)=>{
    if(h._entrypoint.startsWith('env ')){
      const key=/JOB_KEY=([^']+)/.exec(h._entrypoint)?.[1];
      const base=/BASE_URL=([^']+)/.exec(h._entrypoint)?.[1];
      assert.ok(key&&base,'production broker binding is present');
      const response=await fetch(base+'/responses',{method:'POST',
        headers:{authorization:'Bearer '+key,'content-type':'application/json'},
        body:JSON.stringify({model:'example-model',effort:'high'})});
      assert.equal(response.status,200);
      assert.equal((await response.json()).id,'cold-response');
      brokerResponses++;
      h._entrypoint='completed-controlled-provider';
    }
    return originalStart(h,opts);
  };
  let upstreamCalls=0;
  const {owner,lender,circle,realHeartbeats}=await f.realConnect({lenderOptions:{
    backend,accountProviderConfigurations:[providerConfiguration],
    accountTransportFetch:async(_url,options)=>{
      if(options.method==='GET')return Response.json({subject:'cold-first-account'});
      upstreamCalls++;
      assert.deepEqual(JSON.parse(options.body),{model:'example-model',effort:'high'});
      return Response.json({id:'cold-response',object:'response',status:'completed',model:'example-model'});
    },
  }});
  const account=await enroll(lender.app,'SYNTHETIC_COLD_ACCOUNT','cold-enroll');
  const journalPath=join(lender.home,'v1','account-launch','lending.json');
  const readJournal=()=>{
    try{return JSON.parse(readFileSync(journalPath,'utf8'));}
    catch(error){if(error.code==='ENOENT')return {accounts:{},launches:{}};throw error;}
  };
  // Fresh fixture, job-local provider, no usage injection, no previous attempt.
  assert.deepEqual(Object.keys(readJournal().launches),[]);
  assert.equal(backend.calls.filter(([kind])=>kind==='run').length,0);
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  const mode=await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'auto'}});
  assert.ok(mode.standingRules.some(rule=>rule.circle===circle.id),'audited standing rule covers this circle');
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  await waitFor(()=>realHeartbeats.filter(row=>row.device===lender.app.device.keyId)
    .at(-1)?.body.accounts?.some(row=>row.accountId===account.id),'published cold account',30000);
  assert.deepEqual(await api(lender.app,'/api/approvals'),[]);
  const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:{
    circle:circle.id,prompt:'First automatic signed account job',
    git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),harness:'codex',
    runRequest:{schemaVersion:1,models:[{providerId:'codex',modelId:'example-model'}],effortId:'high'},
  }});
  const client=await owner.app.device.client(circle.id);
  if(stop){
    await waitFor(()=>backend.calls.some(([kind])=>kind==='run'),'signed account running',30000);
    const [attemptId]=Object.keys(readJournal().launches);
    assert.ok(attemptId);
    const result=await api(lender.app,'/api/lending/stop',{method:'POST',body:{attemptId,confirmed:true}});
    assert.equal(result.intent,'off');
    await waitFor(()=>backend.calls.some(([kind])=>kind==='cancel'),'cancellation of the signed account sandbox',20000);
    assert.equal(backend.calls.filter(([kind])=>kind==='run').length,1);
    return;
  }
  const view=await waitFor(async()=>{
    assert.deepEqual(await api(lender.app,'/api/approvals'),[],'Auto must never require per-job review');
    const current=await client.getJob(submitted.jobDigest);
    return current.state==='result-accepted'?current:null;
  },'cold first signed result without approval',30000);
  const result=await client.fetchResult(submitted.jobDigest,{includeMetadata:true,attempt:view.current_attempt});
  assert.deepEqual(result.receipt.selection,{providerId:'codex',accountId:account.id,modelId:'example-model',effortId:'high'});
  const journal=readJournal(),launch=journal.launches[view.current_attempt.attempt_id];
  assert.ok(launch,'accepted attempt has its own durable launch receipt');
  assert.equal(launch.receipt.mode,'cold_pace');
  assert.equal(launch.receipt.jobId,submitted.jobDigest);
  assert.equal(launch.receipt.accountId,account.id);
  assert.equal(Object.keys(journal.launches).length,1);
  assert.equal(backend.calls.filter(([kind])=>kind==='run').length,1);
  assert.equal(upstreamCalls,1);assert.equal(brokerResponses,1);
  assert.deepEqual(await api(lender.app,'/api/approvals'),[]);
  await api(lender.app,'/api/lending/off',{method:'POST',body:{}});
});
import {createAccountStore} from '../lib/v1/accounts.mjs';
import {createAccountBroker} from '../lib/v1/account-broker.mjs';
import {createHostProviderRegistry} from '../lib/v1/providers/host-registry.mjs';
import {createAccountsApi} from '../lib/v1/accounts-http.mjs';
import {createAccountTransport} from '../lib/v1/account-transport.mjs';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';

test('claim A -> select same-provider B -> dispatch is fenced; revoked attempt, key and membership cannot spend',{timeout:60000},async t=>{
  const f=await realLenderFixture(t,{offers:true,mutateJob:job=>{
    delete job.requirements.model;job.requirements.capabilities.push('run_request_v1');
    job.runRequest={schemaVersion:1,models:[{providerId:'codex',modelId:'example-model'}],effortId:'high'};
  }});
  const directory=await tempDir('account-authority-test-');t.after(()=>rm(directory,{recursive:true,force:true}));
  const providers=createHostProviderRegistry({configurations:[providerConfiguration],proxyOrigin:()=> 'http://127.0.0.1',fetch:async(_url,options)=>Response.json({subject:options.headers.authorization==='Bearer CONTROLLED_A'?'subject-a':'subject-b'})});
  const store=createAccountStore({directory});let effects=0;
  const broker=createAccountBroker({store,providers,clock:f.clock.now,authority:{verify:input=>f.client.verifyAccountLease(input)},
    proxy:createAccountTransport({fetch:async()=>{effects++;return new Response('{}');}})});
  t.after(()=>broker.close());const producer=createAccountsApi({broker,store,providers});
  async function add(key){const flow=await producer.handle({method:'POST',parts:['api','accounts'],input:{providerId:'codex',label:key,operationId:key}});
    const account=(await producer.handle({method:'POST',parts:['api','accounts','flows',flow.body.value.flowId,'complete'],input:{answer:key}})).body.value;
    await enableFixtureModel(store,account.id,'example-model');return account;}
  const a=await add('CONTROLLED_A'),b=await add('CONTROLLED_B'),accounts=producer.advertise();
  const requirements=f.job.payload.requirements;
  const advertisement={harnesses:['codex'],models:['example-model'],capabilities:requirements.capabilities,
    egress:[requirements.egress],enforced_limits:Object.keys(requirements.limits),max_limits:requirements.limits,accounts};
  await f.client.heartbeat({boot:'account-authority',seq:0,intent:{state:'ready'},execution:{state:'idle'},blockers:[],
    agents:[],capabilities:['run_request_v1'],accounts});
  const claim=await f.client.claimJob(f.jobDigest,advertisement);
  const selected=claim.attempt.selection;assert.equal(selected.accountId,a.id);
  const {proof}=await f.client.accountLease(claim.attempt,selected);
  const issue=changes=>broker.issueJobKey({selection:selected,jobId:f.jobDigest,attemptId:claim.attempt.attempt_id,leaseProof:proof,...changes});
  for(const selection of [{...selected,accountId:b.id},{...selected,providerId:'claude'},
    {...selected,modelId:'other'},{...selected,effortId:'low'}])
    assert.equal((await issue({selection})).ok,false,JSON.stringify(selection));
  assert.equal((await issue({jobId:'sha256:'+'f'.repeat(64)})).ok,false);
  assert.equal((await issue({attemptId:'00000000-0000-4000-8000-000000000000'})).ok,false);
  assert.equal(effects,0);
  const key=await issue({});assert.equal(key.ok,true,JSON.stringify(key));
  const request=(over={})=>({method:'POST',url:'https://controlled.invalid/v1/responses',headers:{},
    body:{kind:'replayable',open:()=>new Blob([JSON.stringify({model:'example-model',effort:'high'})]).stream(),dispose:async()=>{}},...over});
  assert.equal((await broker.proxy.dispatch({key:key.value.key,request:request({headers:{'x-faravan-account-id':b.id}})})).ok,false);
  assert.equal(effects,0);
  const healthy=await broker.proxy.dispatch({key:key.value.key,request:request()});assert.equal(healthy.ok,true,JSON.stringify(healthy));
  await healthy.value.response.text();assert.equal(effects,1);
  const wrongBody=request({body:{kind:'replayable',open:()=>new Blob(['{"model":"other","effort":"high"}']).stream(),dispose:async()=>{}}});
  assert.equal((await broker.proxy.dispatch({key:key.value.key,request:wrongBody})).ok,false);assert.equal(effects,1);
  await broker.revokeJobKey(key.value.keyId);
  assert.equal((await broker.proxy.dispatch({key:key.value.key,request:request()})).ok,false);
  const second=await issue({});assert.equal(second.ok,true);
  await f.client.release(claim.attempt);
  assert.equal((await broker.proxy.dispatch({key:second.value.key,request:request()})).ok,false);
  assert.equal((await issue({})).ok,false);assert.equal(effects,1);
  await broker.revokeJobKey(second.value.keyId);
  const successor=await f.client.claimJob(f.jobDigest,advertisement);
  assert.ok(successor.attempt.generation>claim.attempt.generation);
  const latest=await f.client.accountLease(successor.attempt,selected);
  const nextKey=await broker.issueJobKey({selection:selected,jobId:f.jobDigest,attemptId:successor.attempt.attempt_id,leaseProof:latest.proof});
  assert.equal(nextKey.ok,true);
  assert.equal((await broker.renewJobKey({keyId:second.value.keyId,leaseProof:latest.proof})).ok,false);
  const roster=await f.owner.refreshRoster();
  const golden=JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json',import.meta.url)));
  const root=protocol.privateKeyFromSeed(Buffer.from(golden.keys[2].seed_hex,'hex'));
  await f.owner.publishRoster(protocol.signEnvelope('roster',{...roster.payload,epoch:roster.payload.epoch+1,
    members:roster.payload.members.filter(m=>m.key_id!==successor.attempt.holder)},root));
  assert.equal((await broker.proxy.dispatch({key:nextKey.value.key,request:request()})).ok,false);
  assert.equal(effects,1);
  f.clock.advance(121000);
  assert.equal((await broker.proxy.dispatch({key:nextKey.value.key,request:request()})).error.code,'job_key_expired');
  assert.equal(effects,1);
});


// The transport owns body consumption, but only the broker may authorize the
// actual send. Every scenario holds the last guest chunk after admission.
for(const change of ['none','expiry','release','membership','key','generation','disabled','signed-out','abort']){
  test('held guest body rechecks current authority before send: '+change,{timeout:60000},async t=>{
    const f=await realLenderFixture(t,{offers:true,mutateJob:job=>{
      delete job.requirements.model;job.requirements.capabilities.push('run_request_v1');
      job.runRequest={schemaVersion:1,models:[{providerId:'codex',modelId:'example-model'}],effortId:'high'};
    }});
    const directory=await mkdtemp('/tmp/held-account-authority-');
    t.after(()=>rm(directory,{recursive:true,force:true}));
    const providers=createHostProviderRegistry({configurations:[providerConfiguration],proxyOrigin:()=> 'http://127.0.0.1',
      fetch:async()=>Response.json({subject:'held-subject'})});
    const store=createAccountStore({directory});let effects=0,disposals=0;
    const broker=createAccountBroker({store,providers,clock:f.clock.now,
      authority:{verify:input=>f.client.verifyAccountLease(input)},
      proxy:createAccountTransport({fetch:async()=>{effects++;return Response.json({ok:true});}})});
    t.after(()=>broker.close());
    const producer=createAccountsApi({broker,store,providers});
    const flow=await producer.handle({method:'POST',parts:['api','accounts'],
      input:{providerId:'codex',label:'held',operationId:'held-enroll'}});
    const enrolled=await producer.handle({method:'POST',parts:['api','accounts','flows',flow.body.value.flowId,'complete'],
      input:{answer:'SYNTHETIC_HELD_KEY'}});
    assert.equal(enrolled.body.ok,true);const account=enrolled.body.value;
    await enableFixtureModel(store,account.id,'example-model');
    const accounts=producer.advertise(),requirements=f.job.payload.requirements;
    const advertisement={harnesses:['codex'],models:['example-model'],capabilities:requirements.capabilities,
      egress:[requirements.egress],enforced_limits:Object.keys(requirements.limits),max_limits:requirements.limits,accounts};
    await f.client.heartbeat({boot:'held-authority',seq:0,intent:{state:'ready'},execution:{state:'idle'},blockers:[],
      agents:[],capabilities:['run_request_v1'],accounts});
    const claim=await f.client.claimJob(f.jobDigest,advertisement),selected=claim.attempt.selection;
    const {proof}=await f.client.accountLease(claim.attempt,selected);
    const issued=await broker.issueJobKey({selection:selected,jobId:f.jobDigest,attemptId:claim.attempt.attempt_id,leaseProof:proof});
    assert.equal(issued.ok,true,JSON.stringify(issued));
    let release,entered;const held=new Promise(resolve=>{release=resolve;}),atBody=new Promise(resolve=>{entered=resolve;});
    t.after(()=>release());
    let pulls=0;
    const body={kind:'one_shot',stream:new ReadableStream({async pull(controller){
      if(pulls++===0){controller.enqueue(new TextEncoder().encode('{"model":"example-model",'));return;}
      entered();await held;controller.enqueue(new TextEncoder().encode('"effort":"high"}'));controller.close();
    }}),dispose:async()=>{disposals++;}};
    const controller=new AbortController();
    const request={method:'POST',url:'https://controlled.invalid/v1/responses',headers:{},body};
    const running=broker.proxy.dispatch({key:issued.value.key,request,signal:controller.signal});
    await atBody;
    const before=store.get(account.id),operations=Object.entries(before.dispatchOperations??{});
    assert.equal(operations.length,1,'the original journal exists before body completion');
    const [operationId,operation]=operations[0];
    assert.equal(operation.upstreamId,null);assert.equal(effects,0);
    if(change==='expiry')f.clock.advance(issued.value.expiresAtMs-f.clock.now()+1);
    if(change==='release')await f.client.release(claim.attempt);
    if(change==='membership'){
      const roster=await f.owner.refreshRoster();
      const golden=JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json',import.meta.url)));
      const root=protocol.privateKeyFromSeed(Buffer.from(golden.keys[2].seed_hex,'hex'));
      await f.owner.publishRoster(protocol.signEnvelope('roster',{...roster.payload,epoch:roster.payload.epoch+1,
        members:roster.payload.members.filter(m=>m.key_id!==claim.attempt.holder)},root));
    }
    if(change==='key')await broker.revokeJobKey(issued.value.keyId);
    if(['generation','disabled','signed-out'].includes(change))await store.transaction(state=>{
      const record=state.records[account.id];
      if(change==='generation')record.generation++;
      if(change==='disabled')record.enabled=false;
      if(change==='signed-out')record.authState='signed_out';
    });
    if(change==='abort')controller.abort();
    release();const result=await running;
    if(change==='none'){assert.equal(result.ok,true,JSON.stringify(result));await result.value.response.text();assert.equal(effects,1);}
    else {assert.equal(result.ok,false,change);assert.equal(effects,0,change+' must never send');
      assert.equal(typeof result.error.code,'string');
      assert.notEqual(result.error.code,'auth_temporarily_unavailable','authority refusals must not be flattened');}
    assert.equal(disposals,1,'one-shot body disposed exactly once');
    const debt=store.get(account.id).dispatchOperations[operationId];
    assert.ok(debt,'no error may erase the original operation uncertainty');
    assert.deepEqual(debt.binding,operation.binding);
    if(change!=='none')assert.equal(debt.upstreamId,null);
    const replay=await broker.proxy.dispatch({key:issued.value.key,request});
    assert.equal(replay.error.code,'body_already_consumed');
    assert.equal(effects,change==='none'?1:0);assert.equal(disposals,1);
  });
}

test('provider identity follows authenticated subject, not rotating key',{timeout:30000},async t=>{
  const directory=await mkdtemp('/tmp/provider-subject-');t.after(()=>rm(directory,{recursive:true,force:true}));
  let mode='valid';
  const providers=createHostProviderRegistry({configurations:[providerConfiguration],proxyOrigin:()=> 'http://127.0.0.1',
    fetch:async(_url,options)=>{
      if(mode==='unavailable')throw Error('synthetic identity unavailable');
      if(mode==='malformed')return Response.json({subject:{nested:'not-an-identity'}});
      if(mode==='missing')return Response.json({});
      if(mode==='oversize')return new Response('x'.repeat(65537));
      if(mode==='empty')return Response.json({subject:''});
      if(mode==='number')return Response.json({subject:123});
      if(mode==='array')return Response.json([{subject:'same-subject'}]);
      if(mode==='long')return Response.json({subject:'x'.repeat(513)});
      if(mode==='space')return Response.json({subject:' same-subject'});
      if(mode==='control')return Response.json({subject:'same'+String.fromCharCode(0)+'subject'});
      if(mode==='echo')return Response.json({subject:options.headers.authorization.replace('Bearer ','')});
      return Response.json({subject:options.headers.authorization==='Bearer KEY_OTHER'?'other-subject':'same-subject'});
    }});
  const store=createAccountStore({directory});
  const broker=createAccountBroker({store,providers,authority:{verify:async()=>{throw Error('unused');}},
    proxy:createAccountTransport({fetch:async()=>{throw Error('no provider effects allowed');}})});
  t.after(()=>broker.close());
  const add=async key=>{const begun=await broker.enroll({providerId:'codex',label:'identity'});
    assert.equal(begun.ok,true);return broker.complete({flowId:begun.value.flowId,answer:key});};
  const first=await add('KEY_ONE');assert.equal(first.ok,true);const id=first.value.id;
  const initial=store.get(id),initialGeneration=initial.generation;
  const replacement=await broker.beginCredentialReplacement({accountId:id,expectedGeneration:initial.generation});
  assert.equal(replacement.ok,true);
  const replaced=await broker.completeCredentialReplacement({flowId:replacement.value.flowId,answer:'KEY_TWO',operationId:'replace-subject'});
  assert.equal(replaced.ok,true,JSON.stringify(replaced));
  assert.equal(replaced.value.id,id);assert.equal(store.get(id).subjectId,'same-subject');
  assert.equal(store.get(id).generation,initialGeneration+1);
  assert.equal(store.get(id).secret.key,'KEY_TWO');
  const duplicate=await add('KEY_THREE');assert.equal(duplicate.error.code,'account_exists');
  const other=await add('KEY_OTHER');assert.equal(other.ok,true);assert.notEqual(other.value.id,id);
  for(mode of ['malformed','missing','oversize','unavailable','empty','number','array','long','space','control','echo']){
    const before=store.read();
    const started=await broker.beginCredentialReplacement({accountId:id,expectedGeneration:store.get(id).generation});
    const refused=await broker.completeCredentialReplacement({flowId:started.value.flowId,answer:'KEY_NEW',operationId:'bad-'+mode});
    assert.equal(refused.ok,false,mode);assert.deepEqual(store.read(),before,mode+' must not mutate accounts');
  }
  for(const field of [undefined,'','nested.subject','__proto__','constructor','prototype']){
    assert.throws(()=>createHostProviderRegistry({configurations:[{...providerConfiguration,identitySubjectField:field}],
      proxyOrigin:()=> 'http://127.0.0.1'}),/invalid_provider_configuration/);
  }
});

test('transport refuses a missing broker send authority after validating body',async()=>{
  let sends=0;
  const transport=createAccountTransport({fetch:async()=>{sends++;return Response.json({ok:true});}});
  const result=await transport.dispatch({binding:{keyId:'test-key',selection:{modelId:'example-model',effortId:'high'}},
    request:{method:'POST',url:'https://controlled.invalid/v1/responses',headers:{},
      authorizeSend:send=>send(), // A guest request field is never authority.
      body:{kind:'one_shot',stream:new Blob(['{"model":"example-model","effort":"high"}']).stream()}}});
  assert.equal(result.error.code,'authority_unavailable');assert.equal(sends,0);
});

test('a late final authorization cannot send after caller abort',async()=>{
  let entered,release;const arrived=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;});
  let sends=0;const controller=new AbortController();
  const transport=createAccountTransport({fetch:async()=>{sends++;return Response.json({ok:true});}});
  const pending=transport.dispatch({signal:controller.signal,
    binding:{keyId:'test-key',selection:{modelId:'example-model',effortId:'high'}},
    request:{method:'POST',url:'https://controlled.invalid/v1/responses',headers:{},
      body:{kind:'one_shot',stream:new Blob(['{"model":"example-model","effort":"high"}']).stream()}},
    authorizeSend:async send=>{entered();await held;return {ok:true,value:await send()};}});
  try {
    await arrived;controller.abort();
    assert.equal((await pending).error.code,'request_aborted');
  }finally{release();}
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(sends,0);
});


import {request as httpRequest} from 'node:http';
for(const mutation of ['expiry','release','membership'])test('full app HTTP held incoming body fences '+mutation,{timeout:90000},async t=>{
  const f=await appFixture(t);let current=Date.now(),app,connection,resumeBody,enterBody;
  const entered=new Promise(resolve=>{enterBody=resolve;});
  let upstream=0,status;
  const backend=syntheticBackend(f.root),originalStart=backend.start.bind(backend);
  backend.prepareAccountRun=async spec=>{
    const h=await backend.prepare(spec);h.job_id=spec.job_id;h.sandbox_id='held-'+randomUUID();h._cleanupId=randomUUID();return h;
  };
  backend.inspect=async h=>({job_id:h.job_id,status:'exited'});
  backend.start=async(h,opts)=>{
    if(h._entrypoint.startsWith('env ')){
      const key=/JOB_KEY=([^']+)/.exec(h._entrypoint)[1],base=/BASE_URL=([^']+)/.exec(h._entrypoint)[1];
      const payload=JSON.stringify({model:'example-model',effort:'high'}),half=Math.floor(payload.length/2);
      const observed=req=>{
        if(!req.url.startsWith('/api/account-proxy/'))return;
        app.server.removeListener('request',observed);
        req.once('data',()=>enterBody());
      };
      app.server.on('request',observed);
      const received=new Promise((resolve,reject)=>{
        connection=httpRequest(base+'/responses',{method:'POST',headers:{authorization:'Bearer '+key,
          'content-type':'application/json','content-length':Buffer.byteLength(payload)}},response=>{
          status=response.statusCode;response.resume();response.once('end',resolve);
        });connection.on('error',reject);
        resumeBody=()=>connection.end(payload.slice(half));connection.write(payload.slice(0,half));
      });
      await received;h._entrypoint='blocked-controlled-provider';
    }
    return originalStart(h,opts);
  };
  const {owner,lender,circle}=await f.realConnect({lenderOptions:{backend,clock:{now:()=>current},
    accountProviderConfigurations:[providerConfiguration],accountTransportFetch:async(_url,options)=>{
      if(options.method==='GET')return Response.json({subject:'held-subject'});
      upstream++;return Response.json({object:'response',id:'resp_held',status:'completed',model:'example-model'});
    }}});app=lender.app;
  await enroll(app,'CONTROLLED_HELD_SECRET','held-enroll');
  await api(app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,prompt:'Held incoming body',
    git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),harness:'codex',
    runRequest:{schemaVersion:1,models:[{providerId:'codex',modelId:'example-model'}],effortId:'high'}}});
  const card=await waitFor(async()=>(await api(app,'/api/approvals'))[0],'held-body approval',30000);
  await api(app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  try {
    await Promise.race([entered,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('incoming-body barrier not reached')),30000);timer.unref();})]);
    assert.equal(upstream,0);
    if(mutation==='expiry')current+=6*60*1000;
    else if(mutation==='membership')await owner.app.device.removeMember(circle.id,app.device.keyId);
    else {const client=await app.device.client(circle.id),view=await client.getJob(submitted.jobDigest);await client.release(view.current_attempt);}
  }finally{resumeBody?.();}
  await waitFor(()=>status!==undefined,'held-body HTTP response',10000);
  assert.equal(status,403);assert.equal(upstream,0);
  await api(app,'/api/lending/off',{method:'POST',body:{}});
  connection?.destroy();
});
