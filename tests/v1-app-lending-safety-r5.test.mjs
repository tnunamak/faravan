import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appFixture, api, waitFor } from './helpers/v1-app-fixture.mjs';
import { HARNESS_ADAPTERS } from '../lib/harnesses/index.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hdr = lender => ({'content-type':'application/json','x-faravan-session-token':lender.app.token});

async function lendableFixture(t, options = {}) {
  const native = HARNESS_ADAPTERS.find(adapter => adapter.spec.harness_id === 'codex');
  const f = await appFixture(t);
  const {lender, circle} = await f.connect({
    adapters:[{...native, installed:true, signedIn:false, models:['m']}],
    lendingSignInProbe:async()=>({signedIn:null, secretPresent:true}),
    lendingIdentityProbe:async()=>({providers:[{harness_id:'codex', installed:true, signedIn:true}]}),
    ...options,
  });
  await waitFor(async()=>{
    const rows=await api(lender.app,'/api/agents');
    return typeof rows[0]?.proxySignedIn==='boolean'&&rows;
  },'proxy sign-in readiness');
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  return {lender,circle};
}

for(const action of ['off','pause'])test(action+' wins when lending-on is waiting for the proxy identity refresh',{timeout:120000},async t=>{
  let time=Date.now(),delay=0;
  const native=HARNESS_ADAPTERS.find(adapter=>adapter.spec.harness_id==='codex');
  const f=await appFixture(t);
  const {lender,circle}=await f.connect({clock:{now:()=>time},lendingIdentityCacheMs:1000,
    adapters:[{...native,installed:true,signedIn:false,models:['m']}],
    lendingSignInProbe:async()=>({signedIn:null,secretPresent:true}),
    lendingIdentityProbe:async()=>{if(delay)await sleep(delay);return {providers:[{harness_id:'codex',installed:true,signedIn:true}]};}});
  await waitFor(async()=>{
    const rows=await api(lender.app,'/api/agents');
    return typeof rows[0]?.proxySignedIn==='boolean';
  },'initial proxy sign-in readiness');
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  time+=5000;delay=4000;
  const on=fetch(lender.app.origin+'/api/lending/on',{method:'POST',headers:hdr(lender),body:JSON.stringify({circle:circle.id})});
  await sleep(1000);
  const safety=await api(lender.app,'/api/lending/'+action,{method:'POST',body:{}});
  const onResponse=await on;
  const after=await api(lender.app,'/api/lending');
  assert.equal(safety.enabled,false);
  assert.equal(onResponse.status,409);
  assert.equal(after.enabled,false);
  assert.notEqual(after.intent,'on');
});

test('a slow lending-on proxy probe does not hold On; lending enables once the late answer arrives',{timeout:120000},async t=>{
  let time=Date.now(),delay=0;
  const {lender,circle}=await lendableFixture(t,{clock:{now:()=>time},lendingIdentityCacheMs:1000,mutationTimeoutMs:6000,
    lendingIdentityProbe:async()=>{if(delay)await sleep(delay);return {providers:[{harness_id:'codex',installed:true,signedIn:true}]};}});
  time+=5000;delay=9000;
  const response=await fetch(lender.app.origin+'/api/lending/on',{method:'POST',headers:hdr(lender),body:JSON.stringify({circle:circle.id})});
  assert.equal(response.status,200);
  assert.equal((await api(lender.app,'/api/lending')).intent,'on');
  await sleep(11000);
  const after=await api(lender.app,'/api/lending');
  assert.equal(after.intent,'on');
  assert.equal(after.enabled,true);
});

test('plain owner sign-in keeps the lending opt-in for that agent',{timeout:120000},async t=>{
  const native=HARNESS_ADAPTERS.find(adapter=>adapter.spec.harness_id==='codex');
  const f=await appFixture(t);
  const {lender}=await f.connect({adapters:[{...native,installed:true,signedIn:false,models:['m']}],
    lendingSignInProbe:async()=>({signedIn:null,secretPresent:true}),
    lendingIdentityProbe:async()=>({providers:[{harness_id:'codex',installed:true,signedIn:true}]}),
    signin:{startProvider:async()=>({status:'complete',cleanup:async()=>{}})}});
  await waitFor(async()=>{
    const rows=await api(lender.app,'/api/agents');
    return typeof rows[0]?.proxySignedIn==='boolean'&&rows;
  },'proxy sign-in readiness');
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  const started=await api(lender.app,'/api/signin/codex',{method:'POST',body:{}});
  await waitFor(async()=>{
    const flow=await api(lender.app,'/api/signin/'+started.flowId);
    return flow.status==='complete';
  },'plain sign-in completion');
  await sleep(1500);
  const [agent]=await api(lender.app,'/api/agents');
  assert.equal(agent.useForLending,true);
});
