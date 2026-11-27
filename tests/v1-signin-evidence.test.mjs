import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { observeAgentEvidence } from '../lib/v1/app.mjs';
import { HARNESS_ADAPTERS } from '../lib/harnesses/index.mjs';
import { legacyProxyHarness } from './helpers/legacy-proxy-harness.mjs';
import { appFixture, api, waitFor } from './helpers/v1-app-fixture.mjs';

test('evidence retains its age through unknown checks and requires two definite sign-outs', () => {
  const good=observeAgentEvidence({}, {installed:true,signedIn:true}, 'sandbox', 1000);
  let value=good;
  for(const signedIn of [null,undefined]) {
    value=observeAgentEvidence(value,{signedIn},'sandbox-store',2000);
    assert.equal(value.signedIn,true);
    assert.deepEqual(value.evidence,good.evidence);
    assert.equal(value.signOutCount,0);
  }
  value=observeAgentEvidence(value,{signedIn:false},'sandbox-store',3000);
  assert.equal(value.signedIn,true);
  value=observeAgentEvidence(value,{signedIn:null},'sandbox-store',4000);
  assert.equal(value.signedIn,true);
  value=observeAgentEvidence(value,{signedIn:false},'sandbox-store',5000);
  assert.equal(value.signedIn,false);
  const job=observeAgentEvidence(value,{installed:true,signedIn:true},'sandbox',6000);
  assert.equal(job.signedIn,true);
  assert.equal(job.signOutCount,0);
  assert.equal(observeAgentEvidence(job,{signedIn:false},'job',7000).signedIn,false);
});

for(const answer of [true, null, false, 'timeout']) test('31-minute evidence runs one bounded fast probe before lending: '+answer,{timeout:30000},async t=>{
  let time=Date.now(),fast=0,full=0,armed=false;
  const f=await appFixture(t),{lender,circle}=await f.connect({
    adapters:HARNESS_ADAPTERS.filter(a=>a.spec.harness_id==='codex').map(a=>({...a,lendingSpec:undefined,spec:legacyProxyHarness('codex')})),clock:{now:()=>time},
    signInProbeTimeoutMs:10,
    signInProbe:async id=>{assert.equal(id,'codex');
      // The explicit check below reads the stored sign-in too (and a missing one ends it early); this test is about the claim-time probe.
      if(!armed)return {signedIn:null,source:'unavailable'};
      fast++;
      if(answer==='timeout')return new Promise(()=>{});
      return {signedIn:answer,source:'sandbox-store'};},
    identityProbe:async()=>{full++;return {providers:[{harness_id:'codex',installed:true,signedIn:full===1?true:null}]};},
  });
  time-=31*60000;
  await api(lender.app,'/api/agents/refresh',{method:'POST',body:{}});
  const before=(await api(lender.app,'/api/agents'))[0].evidence;
  armed=true;
  time+=31*60000; // advancing only the app clock keeps signed coordinator traffic at real time
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  assert.equal(fast,0,'GET and agent selection do not probe');
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{idleOnly:false}});
  const started=await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id},status:answer===false?409:200});
  if(answer===false)assert.equal(started.code,'agent_not_ready');
  else assert.equal(started.enabled,true);
  // A stored sign-in that reads as gone ends the background check without a sandbox; any other answer runs the full check.
  await waitFor(()=>answer===false?fast>=2:full>=2,'retained background full check');
  const rows=await api(lender.app,'/api/agents');
  assert.equal(rows[0].signedIn,answer!==false,'confirmed missing credentials clear sign-in; age or timeout does not');
  if(answer!==true&&answer!==false)assert.deepEqual(rows[0].evidence.find(x=>x.fact==='signed_in'),before.find(x=>x.fact==='signed_in'));
  assert.equal(fast,2,'one claim-time probe shared by startup and claim polling, and the background check reads the stored sign-in once');
  assert.equal(lender.backend.calls.some(([kind])=>kind==='run'||kind==='prepare'),false);
});

test('a signed-out proxy still gets the stale native owner fast check before claim', {timeout:30000}, async t => {
  let time=Date.now(),fast=0,full=0,armed=false;
  const native=HARNESS_ADAPTERS.find(a=>a.spec.harness_id==='codex');
  const f=await appFixture(t),{lender,circle}=await f.connect({
    adapters:[{...native,installed:true,signedIn:true}],
    clock:{now:()=>time},identityCacheMs:1000,
    lendingSignInProbe:async()=>({signedIn:false}),
    lendingIdentityProbe:async()=>({providers:[{harness_id:'codex',installed:true,signedIn:false}]}),
    signInProbe:async()=>{
      if(!armed)return {signedIn:null,source:'unavailable'};
      fast++;
      return {signedIn:false,source:'sandbox-store'};
    },
    identityProbe:async()=>{full++;return {providers:[{harness_id:'codex',installed:true,signedIn:true}]};},
  });
  const [refreshed]=await api(lender.app,'/api/agents/refresh',{method:'POST',body:{agents:['codex']}});
  assert.equal(refreshed.ownerSignedIn,true);
  assert.equal(refreshed.proxySignedIn,false);

  armed=true;time+=1001;
  const denied=await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id},status:409});
  assert.equal(denied.code,'agent_not_ready');
  assert.equal(fast,1,'the stale native owner sign-in gets one bounded pre-claim probe');
  assert.equal(full,1,'the pre-claim probe does not start another native sandbox check');
});

test('lending-on refreshes expired proxy readiness before accepting it',{timeout:90000},async t=>{
  const native=HARNESS_ADAPTERS.find(a=>a.spec.harness_id==='codex');
  let time=Date.now(),proxyReady=true,proxyChecks=0;
  const f=await appFixture(t),{lender,circle}=await f.connect({
    adapters:[{...native,installed:true,signedIn:false}],clock:{now:()=>time},lendingIdentityCacheMs:1000,
    lendingSignInProbe:async()=>({signedIn:null,secretPresent:true}),
    lendingIdentityProbe:async()=>{proxyChecks++;return {providers:[{harness_id:'codex',installed:true,signedIn:proxyReady}]};},
  });
  const rows=await waitFor(async()=>{
    const value=await api(lender.app,'/api/agents');
    return typeof value[0]?.proxySignedIn==='boolean'?value:null;
  },'initial proxy readiness');
  assert.equal(rows[0].proxySignedIn,true);
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  proxyReady=false;time+=1001;
  const denied=await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id},status:409});
  assert.equal(denied.code,'agent_not_ready');
  assert.ok(proxyChecks>=2,'lending-on performs a new identity check after the cache TTL');
  assert.equal((await api(lender.app,'/api/lending')).enabled,false);
});

test('an unreadable sign-in store is "can\'t read", never "sign in again" on the lender row',{timeout:90000},async t=>{
  const native=HARNESS_ADAPTERS.find(a=>a.spec.harness_id==='codex');
  const f=await appFixture(t),{lender}=await f.connect({
    adapters:[{...native,installed:true,signedIn:false}],
    lendingSignInProbe:async()=>({signedIn:null,secretPresent:null,source:'sandbox-store',reason:'credential_store_unreadable'}),
    lendingIdentityProbe:async()=>({providers:[{harness_id:'codex',installed:true,signedIn:null}]}),
  });
  const [row]=await waitFor(async()=>{
    const value=await api(lender.app,'/api/agents');
    return value[0]?.signInReason==='credential_store_unreadable'?value:null;
  },'unreadable sign-in store row');
  assert.equal(row.signInState,"Can't read sign-in store");
  assert.equal(row.remedy,"Faravan can't read the sandbox sign-in store right now.");
  assert.notEqual(row.signInReason,'credential_missing');
  assert.ok(!/sign in again/i.test(row.remedy),row.remedy);
  assert.notEqual(row.signedIn,false,'an unreadable store is not a sign-out');
});

// A Mac whose native Codex owner credential is missing, while the proxy (the lending path) is unknown: the row must not ask
// for a sign-in or call the credential missing.
test('a missing native owner credential does not read as sign-in needed when the lending proxy is unknown',{timeout:90000},async t=>{
  const native=HARNESS_ADAPTERS.find(a=>a.spec.harness_id==='codex');
  const f=await appFixture(t),{lender}=await f.connect({
    adapters:[{...native,installed:true,signedIn:false}],
    signInProbe:async()=>({signedIn:false,source:'provider-generation'}),
    lendingSignInProbe:async()=>({signedIn:null,secretPresent:true,source:'sandbox-store'}),
    lendingIdentityProbe:async()=>({providers:[{harness_id:'codex',installed:true,signedIn:null}]}),
  });
  const [row]=await waitFor(async()=>{
    const value=await api(lender.app,'/api/agents');
    return value[0]?.ownerSignedIn===false&&value[0]?.proxySignedIn===null?value:null;
  },'owner missing and proxy unknown');
  assert.notEqual(row.signInReason,'credential_missing');
  assert.ok(['Checking',"Can't check"].includes(row.signInState),row.signInState);
  assert.equal(row.signInReason,'proxy_unconfirmed');
  assert.ok(!/sign in/i.test(row.remedy),row.remedy);
  assert.notEqual(row.signedIn,true);
});

test('a working lending proxy is signed in and lendable even when the native owner credential is missing',{timeout:90000},async t=>{
  const native=HARNESS_ADAPTERS.find(a=>a.spec.harness_id==='codex');
  const f=await appFixture(t),{lender}=await f.connect({
    adapters:[{...native,installed:true,signedIn:false}],
    signInProbe:async()=>({signedIn:false,source:'provider-generation'}),
    lendingSignInProbe:async()=>({signedIn:null,secretPresent:true,source:'sandbox-store'}),
    lendingIdentityProbe:async()=>({providers:[{harness_id:'codex',installed:true,signedIn:true}]}),
  });
  const [row]=await waitFor(async()=>{
    const value=await api(lender.app,'/api/agents');
    return value[0]?.proxySignedIn===true?value:null;
  },'proxy signed in');
  assert.equal(row.signedIn,true);
  assert.equal(row.signInState,'Signed in');
  assert.equal(row.canChoose,true);
  assert.equal(row.signInReason,undefined);
});

// An unknown proxy must not boot a probe sandbox every 30 seconds: each unknown answer doubles the wait, and the third
// failed automatic check ends automatic checks until the owner presses Check.
test('an unknown lending proxy backs off, stops after three failed automatic checks, keeps one probe in flight, and resets on a definite answer',{timeout:120000},async t=>{
  const native=HARNESS_ADAPTERS.find(a=>a.spec.harness_id==='codex');
  let time=Date.now(),probes=0,inFlight=0,maxInFlight=0,answer=true,gate=null;
  const f=await appFixture(t),{lender,circle}=await f.connect({
    lendingStoreBackedAgents:[],adapters:[{...native,installed:true,signedIn:false}],clock:{now:()=>time},lendingIdentitySignedInCacheMs:1000,
    lendingSignInProbe:async()=>({signedIn:null,secretPresent:true}),
    lendingIdentityProbe:async()=>{probes++;inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);
      try{if(gate)await gate;return {providers:[{harness_id:'codex',installed:true,signedIn:answer}]};}finally{inFlight--;}},
  });
  await waitFor(async()=>{await api(lender.app,'/api/agents');return probes>=1;},'initial proxy probe');
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  await api(lender.app,'/api/lending/pause',{method:'POST',body:{}});
  await waitFor(async()=>{const state=await api(lender.app,'/api/lending');return state.paused===true&&state.current===null;},'paused');
  // A non-forced check: resume runs the claim-time proxy check, which probes only when the cached answer is due.
  const pass=async advanceMs=>{time+=advanceMs;const start=probes;
    await api(lender.app,'/api/lending/resume',{method:'POST',body:{circle:circle.id}});
    await new Promise(r=>setTimeout(r,150));const made=probes-start;
    await api(lender.app,'/api/lending/pause',{method:'POST',body:{}});return made;};
  answer=null;
  assert.equal(await pass(1001),1,'the signed-in answer expires and the unknown answer is probed once');
  const waits=[30000,60000];
  for(const wait of waits){
    assert.equal(await pass(wait-1),0,'no probe before the '+wait/1000+' s back-off ends');
    assert.equal(await pass(1),1,'one probe when the '+wait/1000+' s back-off ends');
  }
  assert.equal(await pass(120000),0,'three failed automatic checks spent the budget: no probe when the 120 s back-off ends');
  assert.equal(await pass(600000),0,'and none later');
  const beforeRefresh=probes;
  await api(lender.app,'/api/agents/refresh',{method:'POST',body:{agents:['codex']}});
  assert.equal(probes-beforeRefresh,1,'the explicit refresh probes the proxy exactly once');
  // One probe in flight: overlapping passes share the pending check.
  gate=new Promise(r=>setTimeout(r,300));
  const start=probes;time+=600001;
  await Promise.all([1,2,3].map(()=>api(lender.app,'/api/lending/resume',{method:'POST',body:{circle:circle.id}}).catch(()=>null)));
  await new Promise(r=>setTimeout(r,600));
  assert.equal(probes-start,1,'overlapping checks start one probe');
  assert.equal(maxInFlight,1,'never more than one probe in flight');
  await api(lender.app,'/api/lending/pause',{method:'POST',body:{}});
  // A definite sign-out resets the back-off to 30 s.
  gate=null;answer=false;
  assert.equal(await pass(600000),1,'the capped unknown answer expires, then the definite answer is probed');
  answer=null;
  assert.equal(await pass(29999),0,'after a definite answer the next unknown waits 30 s again');
  assert.equal(await pass(1),1);
});

test('claim polling refreshes expired proxy readiness before claiming a queued job',{timeout:90000},async t=>{
  const native=HARNESS_ADAPTERS.find(a=>a.spec.harness_id==='codex');
  let time=Date.now(),proxyReady=true,proxyChecks=0;
  const f=await appFixture(t),{owner,lender,circle}=await f.connect({
    adapters:[{...native,installed:true,signedIn:false}],clock:{now:()=>time},lendingIdentityCacheMs:1000,
    lendingSignInProbe:async()=>({signedIn:null,secretPresent:true}),
    lendingIdentityProbe:async()=>{proxyChecks++;return {providers:[{harness_id:'codex',installed:true,signedIn:proxyReady}]};},
  });
  const rows=await waitFor(async()=>{
    const value=await api(lender.app,'/api/agents');
    return typeof value[0]?.proxySignedIn==='boolean'?value:null;
  },'initial proxy readiness');
  assert.equal(rows[0].proxySignedIn,true);
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  await api(lender.app,'/api/lending/pause',{method:'POST',body:{}});
  await waitFor(async()=>{
    const state=await api(lender.app,'/api/lending');
    return state.paused===true&&state.current===null;
  },'lender pause before queueing work');
  const claimsBefore=f.networkTrace.filter(request=>request.device==='lender'&&request.route.endsWith('/jobs/claim-next')).length;
  const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',
    commit:'1'.repeat(40),prompt:'Synthetic stale-proxy claim test.',harness:'codex'}});
  proxyReady=false;time+=1001;
  await api(lender.app,'/api/lending/resume',{method:'POST',body:{circle:circle.id}});
  await waitFor(()=>proxyChecks>=2,'claim-time proxy status refresh');
  await new Promise(resolve=>setTimeout(resolve,100));
  const claimsAfter=f.networkTrace.filter(request=>request.device==='lender'&&request.route.endsWith('/jobs/claim-next')).length;
  assert.equal(claimsAfter,claimsBefore,'the stale proxy pass never reaches the coordinator claim endpoint');
  assert.equal(f.jobs.get(submitted.jobDigest)?.current_attempt,null);
  assert.equal(lender.backend.calls.some(([kind])=>kind==='prepare'||kind==='run'),false);
});
