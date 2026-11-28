import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DockerSbxBackend,SBX_RUN_OPTIONS} from '../lib/docker-backend.mjs';
import {RUN_REQUEST_CAPABILITY} from '../lib/v1/versions.mjs';
import {createLender} from '../lib/v1/lender.mjs';
import {lenderFixture,until} from './helpers/v1-lender-fixture.mjs';
import {claimCensus} from './helpers/claim-census.mjs';

const ok=stdout=>({code:0,stdout:stdout??'',stderr:''});
test('all claim sends obey the state and fresh-send boundary census',{timeout:540000},claimCensus);
async function withObservedDaemon(t,{offers=true,killOnOffers=true}={}) {
  const f=await lenderFixture(t,{offers});
  const host={up:true},calls=[];
  const native=new DockerSbxBackend({monotonic:f.clock.now,storage:{available:async()=>true}});
  native._hostDiskCheck=async()=>({name:'host_disk',ok:true});
  const options={platformName:'linux',runCommand:async(command,args)=>{
    calls.push([command,...args]);
    if(args[0]==='version')return ok('sbx version v0.51.0');
    if(args[0]==='diagnose')return host.up?ok('Daemon healthy\nDocker authentication healthy'):{code:1,stderr:'daemon connection refused'};
    if(args.join(' ')==='ls -q')return host.up?ok():{code:1,stderr:'daemon connection refused'};
    if(args.join(' ')==='run --help')return ok(SBX_RUN_OPTIONS.join('\n'));
    if(args[0]==='policy')return ok('Policy rules');
    if(command==='dpkg-query')return ok('docker-sbx\tinstalled\t0.51.0\ndocker-ce\tinstalled\t28.0.0\ncontainerd.io\tinstalled\t2.1.0\n');
    if(command==='docker')return ok('28.0.0');
    if(command==='containerd')return ok('containerd github.com/containerd/containerd v2.1.0');
    return ok();
  }};
  const report=f.backend.lenderCapabilities();
  assert.equal((await native.lenderCapabilities(options)).available,true);
  f.backend.lenderCapabilities=async context=>{
    const current=await native.lenderCapabilities({...options,...context});
    return {...report,available:current.available,preflight:current.preflight};
  };
  assert.equal((await f.backend.lenderCapabilities({cached:true,observation:true,idle:true})).available,true);
  const stopDaemon=()=>{host.up=false;f.clock.advance(30000);};
  const controller=new AbortController();
  const claim=f.client.claimNext;
  f.client.claimNext=async(...args)=>{await claim(...args);controller.abort();return null;};
  f.client.claimJob=(_digest,advertisement,context)=>f.client.claimNext(advertisement,{...context,waitSeconds:0});
  if(offers){
    f.client.capabilities=async()=>({capabilities:['offers_v1',RUN_REQUEST_CAPABILITY]});
    f.client.listOffers=async function*(){if(killOnOffers)stopDaemon();yield {job_digest:f.jobDigest,job:f.job,state:'queued',published_at:'2026-10-09T12:00:00Z',current_attempt:null};};
  }
  const start=(hooks={})=>{
    const lender=createLender({...f.runOptions,client:f.client,backend:f.backend,policy:f.policy,adapters:f.adapters,clock:f.clock,approve:async()=>true,onEvent:event=>f.events.push(event),...hooks});
    const loop=lender.start(controller.signal);
    f.stop=async()=>{controller.abort();await loop;};
    return loop;
  };
  const advertisement={accounts:f.runOptions.runAccounts(),harnesses:['codex'],models:['example-model'],capabilities:[RUN_REQUEST_CAPABILITY],egress:report.egress,enforced_limits:report.enforced_limits,max_limits:report.max_limits};
  const recoverDaemon=async()=>{host.up=true;await native.lenderCapabilities(options);f.clock.advance(60000);};
  return {...f,start,stopDaemon,recoverDaemon,advertisement,calls,controller};
}

test('an offer selected after the observed daemon dies sends no new claim',async t=>{
  const f=await withObservedDaemon(t);const loop=f.start();
  await until(()=>f.count('/jobs/claim-next')>0||f.events.some(event=>event.reason==='sandbox_check_pending'),'claim or fresh refusal');
  f.controller.abort();await loop;
  assert.equal(f.count('/jobs/claim-next'),0);
  assert.equal(f.saved().claimPending.state,'created-unsent');
});

test('a durable acceptance cannot create a claim from an idle observation after daemon death',async t=>{
  const f=await withObservedDaemon(t);
  const intent={jobDigest:f.jobDigest,advertisement:f.advertisement,leaseSeconds:120,idempotencyKey:'accepted-before-outage',state:'created-unsent',acceptedAt:f.clock.now(),ruleId:null};
  await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,acceptedClaim:{intent,claim:{job:f.job,job_digest:f.jobDigest,acceptedHarness:'codex',automatic:false}}});
  f.stopDaemon();const loop=f.start();
  await until(()=>f.count('/jobs/claim-next')>0||f.events.some(event=>event.reason==='sandbox_check_pending'),'accepted claim or fresh refusal');
  f.controller.abort();await loop;
  assert.equal(f.count('/jobs/claim-next'),0);
  assert.equal(f.saved().claimPending.state,'created-unsent','accepted work remains parked without sending');
  assert.equal(f.saved().claimPending.idempotencyKey,intent.idempotencyKey);
});

test('a new account claim checks the backend after idle discovery',async t=>{
  const f=await withObservedDaemon(t,{offers:false});
  f.runOptions.accountExecution.availability=async()=>{f.stopDaemon();return {decision:{kind:'lend'},accountIds:f.runOptions.runAccounts().map(a=>a.accountId)};};
  const loop=f.start();
  await until(()=>f.count('/jobs/claim-next')>0||f.events.some(event=>event.reason==='sandbox_check_pending'),'legacy claim or fresh refusal');
  f.controller.abort();await loop;
  assert.equal(f.count('/jobs/claim-next'),0);
});

for(const state of [undefined,'sent-uncertain'])test(`an unproven restored ${state?'marked':'legacy'} claim waits for fresh admission and retains its exact request`,async t=>{
  const f=await withObservedDaemon(t,{offers:false});
  const intent={advertisement:f.advertisement,exclude:[],leaseSeconds:120,idempotencyKey:'uncertain-before-outage',...(state?{state}:{})};
  await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,claimPending:intent});
  f.stopDaemon();const loop=f.start();
  await until(()=>f.events.some(event=>event.reason==='sandbox_check_pending'),'restored claim waits');
  assert.equal(f.count('/jobs/claim-next'),0);
  await f.recoverDaemon();f.clock.advance(1000);await loop;
  assert.equal(f.count('/jobs/claim-next'),1);
  const request=f.requests.find(row=>row.route==='/jobs/claim-next');
  assert.equal(request.req.headers['idempotency-key'],intent.idempotencyKey);
  assert.deepEqual(request.body.advertisement,intent.advertisement);
});

test('the claim check follows the awaited automatic acceptance audit',async t=>{
  const f=await withObservedDaemon(t,{killOnOffers:false});
  f.policy.mode='auto';
  f.policy.quota=()=>({provider:'codex',remaining:100,observedAt:f.clock.now()});
  f.policy.standingRules=[{id:'automatic',circle:f.job.payload.circle,people:[f.job.payload.author],agents:['codex'],maxWallSeconds:300,dailyJobs:10,weeklyJobs:70,dailyMinutes:60,weeklyMinutes:420,expiresAt:f.clock.now()+86400000}];
  let unapplied;
  const loop=f.start({onDecision:async()=>{f.stopDaemon();},onDecisionNotApplied:async entry=>{unapplied=entry;}});
  await until(()=>f.count('/jobs/claim-next')>0||f.events.some(event=>event.reason==='sandbox_check_pending'),'audit completes before claim refusal');
  f.controller.abort();await loop;
  assert.equal(f.count('/jobs/claim-next'),0);
  assert.equal(unapplied,undefined,'the acceptance is retained while admission waits');
  assert.equal(f.saved().claimPending.state,'created-unsent');
});

test('a kept acceptance uses background cooldown while the daemon remains down',async t=>{
  const f=await withObservedDaemon(t);
  const intent={jobDigest:f.jobDigest,advertisement:f.advertisement,leaseSeconds:120,idempotencyKey:'waiting-through-outage',state:'created-unsent',acceptedAt:f.clock.now(),ruleId:null};
  await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,acceptedClaim:{intent,claim:{job:f.job,job_digest:f.jobDigest,acceptedHarness:'codex',automatic:false}}});
  f.stopDaemon();const loop=f.start();
  await until(()=>f.events.some(event=>event.reason==='sandbox_check_pending'),'first failed admission');
  const diagnoses=f.calls.filter(row=>row[1]==='diagnose').length;
  for(let second=0;second<30;second++){
    f.clock.advance(1000);await new Promise(resolve=>setImmediate(resolve));
  }
  f.controller.abort();await loop;
  assert.equal(f.count('/jobs/claim-next'),0);
  assert.equal(f.calls.filter(row=>row[1]==='diagnose').length,diagnoses,'a waiting acceptance must not run full probes every second');
});

test('replacing a confirmed expired claim requires fresh backend health',async t=>{
  const f=await withObservedDaemon(t,{offers:false});
  const intent={jobDigest:f.jobDigest,advertisement:f.advertisement,leaseSeconds:120,idempotencyKey:'expired-before-outage',acceptedAt:f.clock.now(),ruleId:null};
  await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,claimPending:intent});
  const attempt={...f.attempt(),execution_started_at:null};
  const keys=[];
  f.client.claimJob=async(_digest,_advertisement,context)=>{
    keys.push(context.idempotencyKey);
    if(context.idempotencyKey===intent.idempotencyKey){f.stopDaemon();throw Object.assign(new Error('expired'),{code:'lease_expired',status:409,committedAttempt:attempt});}
    f.controller.abort();return null;
  };
  f.client.getJob=async()=>({state:'queued',current_attempt:attempt});
  const loop=f.start();
  await until(()=>keys.some(key=>key!==intent.idempotencyKey)||f.events.some(event=>event.reason==='sandbox_check_pending'),'replacement claim or fresh refusal');
  f.controller.abort();await loop;
  assert.deepEqual(keys,[intent.idempotencyKey],'only the original committed request can be replayed during the outage');
  assert.ok(['created-unsent','expired-unstarted'].includes(f.saved().claimPending.state));
});



test('a replacement saved before daemon death cannot make its first claim send',async t=>{
  const f=await withObservedDaemon(t,{offers:false});
  const intent={jobDigest:f.jobDigest,advertisement:f.advertisement,leaseSeconds:120,idempotencyKey:'confirmed-expired',acceptedAt:f.clock.now(),ruleId:null,sent:true};
  await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,claimPending:intent});
  const attempt={...f.attempt(),execution_started_at:null},keys=[];
  let replacement;
  const set=f.policy.storage.set;
  f.policy.storage.set=async value=>{
    await set(value);
    if(!replacement&&value.claimPending?.idempotencyKey&&value.claimPending.idempotencyKey!==intent.idempotencyKey){
      replacement=value.claimPending.idempotencyKey;f.stopDaemon();f.clock.advance(60000);
    }
  };
  f.client.claimJob=async(_digest,_advertisement,context)=>{
    keys.push(context.idempotencyKey);
    if(context.idempotencyKey===intent.idempotencyKey)throw Object.assign(new Error('expired'),{code:'lease_expired',status:409,committedAttempt:attempt});
    f.controller.abort();return null;
  };
  f.client.getJob=async()=>({state:'queued',current_attempt:attempt});
  const loop=f.start();
  await until(()=>replacement&&(keys.includes(replacement)||f.events.some(event=>event.reason==='sandbox_check_pending')),'replacement send or fresh refusal');
  f.controller.abort();await loop;
  assert.deepEqual(keys,[intent.idempotencyKey],'a new key is not an uncertain replay');
  assert.equal(f.saved().claimPending.state,'created-unsent');
});

test('a daemon failure during the transmission journal write prevents the first send',async t=>{
  const f=await withObservedDaemon(t,{killOnOffers:false});
  const set=f.policy.storage.set;let stopped=false;
  f.policy.storage.set=async value=>{
    await set(value);
    if(!stopped&&value.claimPending?.state==='sent-uncertain'){stopped=true;f.stopDaemon();}
  };
  const loop=f.start();
  await until(()=>f.count('/jobs/claim-next')>0||stopped&&f.events.some(event=>event.reason==='sandbox_check_pending'),'first-send check after durable transmission marker');
  f.controller.abort();await loop;
  assert.equal(f.count('/jobs/claim-next'),0);
  assert.equal(f.saved().claimPending.state,'created-unsent','a known unsent intent remains parked as unsent');
});

test('an unsent journal stays parked on the observation cooldown during an outage',async t=>{
  const f=await withObservedDaemon(t,{offers:false});
  const intent={advertisement:f.advertisement,leaseSeconds:120,idempotencyKey:'never-sent',state:'created-unsent'};
  await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,claimPending:intent});
  f.stopDaemon();const loop=f.start();
  await until(()=>f.events.some(event=>event.reason==='sandbox_check_pending'),'unsent request refused');
  const diagnoses=f.calls.filter(row=>row[1]==='diagnose').length;
  for(let second=0;second<30;second++){f.clock.advance(1000);await new Promise(resolve=>setImmediate(resolve));}
  f.controller.abort();await loop;
  assert.equal(f.count('/jobs/claim-next'),0);
  assert.equal(f.saved().claimPending.state,'created-unsent');
  assert.equal(f.calls.filter(row=>row[1]==='diagnose').length,diagnoses);
});

test('a first send that becomes uncertain replays unchanged without another full check',async t=>{
  const f=await withObservedDaemon(t,{killOnOffers:false});
  const requests=[];let diagnoses;
  f.client.claimJob=async(digest,advertisement,context)=>{
    requests.push({digest,advertisement:structuredClone(advertisement),key:context.idempotencyKey,leaseSeconds:context.leaseSeconds});
    if(requests.length===1){
      assert.equal(f.saved().claimPending.state,'sent-uncertain');
      diagnoses=f.calls.filter(row=>row[1]==='diagnose').length;
      f.stopDaemon();throw Object.assign(new Error('reply lost'),{code:'unavailable',status:503});
    }
    f.controller.abort();return null;
  };
  const loop=f.start();
  await until(()=>f.events.some(event=>event.status==='accepting'&&event.reason==='circle_unreachable'),'first send has an uncertain answer');
  f.clock.advance(1000);await loop;
  assert.equal(requests.length,2);
  assert.deepEqual(requests[1],requests[0]);
  assert.equal(f.calls.filter(row=>row[1]==='diagnose').length,diagnoses);
});

test('cancelling a failed first-send check leaves the durable intent created-unsent',async t=>{
  const f=await withObservedDaemon(t,{killOnOffers:false});
  const read=f.backend.lenderCapabilities;let entered,finish;
  const started=new Promise(resolve=>{entered=resolve;});
  const blocked=new Promise(resolve=>{finish=resolve;});
  f.backend.lenderCapabilities=async options=>{
    if(!options){entered();await blocked;throw new Error('cancelled probe');}
    return read(options);
  };
  const loop=f.start();await started;
  f.controller.abort();finish();await loop;
  assert.equal(f.count('/jobs/claim-next'),0);
  assert.equal(f.saved().claimPending.state,'created-unsent');
});

test('Off during the pre-send checkpoint parks an unsent intent without a claim',async t=>{
  const f=await withObservedDaemon(t,{killOnOffers:false});
  const set=f.policy.storage.set;let off=false;
  f.policy.storage.set=async value=>{
    await set(value);
    if(!off&&value.claimPending?.state==='sent-uncertain'){off=true;f.policy.enabled=false;}
  };
  const loop=f.start();
  await until(()=>f.count('/jobs/claim-next')>0||off&&f.events.some(event=>event.status==='paused'),'Off or claim');
  f.controller.abort();await loop;
  assert.equal(f.count('/jobs/claim-next'),0);
  assert.equal(f.saved().claimPending.state,'created-unsent');
});

test('an accepted claim is not vetoed by an allowance observation that changed before the claim; the post-claim check decides',async t=>{
  const f=await withObservedDaemon(t,{killOnOffers:false});
  const intent={jobDigest:f.jobDigest,advertisement:f.advertisement,leaseSeconds:120,idempotencyKey:'soft-allowance-changed',state:'created-unsent',acceptedAt:f.clock.now(),ruleId:null};
  await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,acceptedClaim:{intent,claim:{job:f.job,job_digest:f.jobDigest,acceptedHarness:'codex',automatic:false}}});
  // The soft observation is fine when the acceptance was made and reads low again before the claim is sent.
  f.policy.quota=()=>({provider:'codex',remaining:0,observedAt:f.clock.now()});
  const loop=f.start();
  await until(()=>f.count('/jobs/claim-next')>0||f.events.some(event=>event.reason==='no_spare'),'claim sent or allowance veto');
  f.controller.abort();await loop;
  assert.equal(f.count('/jobs/claim-next'),1,'the acceptance reaches the claim; execution-time admission still checks the allowance');
});
