import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {jobStatusContract} from '../lib/v1/status-contract.mjs';
import {createLender} from '../lib/v1/lender.mjs';
import {declineCodeFor, reserveRecheckNeeded} from '../lib/v1/lender-pace50.mjs';
import {createLendingPool} from '../lib/v1/lending-pool.mjs';
import {lenderFixture,until,deferred} from './helpers/v1-lender-fixture.mjs';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
function launch(t,f,approve,clock=f.clock){const c=new AbortController();const lender=createLender({client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock,approve,onEvent:e=>f.events.push(e)});const loop=lender.start(c.signal);f.stop=async()=>{c.abort();await loop;};return lender;}
function offers(f){let claimed=false;f.client.capabilities=async()=>({capabilities:['offers_v1']});f.client.listOffers=async function*(){if(!claimed)yield {job_digest:f.jobDigest,job:f.job,state:'queued',published_at:'2026-10-09T12:00:00Z',current_attempt:null};};f.client.claimJob=async(_digest,ad,opts)=>{claimed=true;return f.client.claimNext(ad,{...opts,waitSeconds:0});};}
// Judge r12 R12-3: a daily limit raised while an idle lender waits for offers admits the held offer at once. The offer
// wait is a coordinator long poll (30 s) that a local change never ends, and a poll that returns without a fit used to
// start a second one: the offer took 58 s to appear.
test('raising the daily limit admits the held offer without waiting out the offer poll',async t=>{
 const f=await lenderFixture(t,{offers:true});
 f.policy.dailyMinutes=1;   // 60 s: the 120-second job does not fit yet
 let claimed=false,polls=0;
 f.client.capabilities=async()=>({capabilities:['offers_v1']});
 f.client.claimJob=async(_digest,ad,opts)=>{claimed=true;return f.client.claimNext(ad,{...opts,waitSeconds:0});};
 // Like the coordinator: a poll for a revision nothing has moved past waits out its window, or ends when the caller leaves.
 f.client.listOffers=async function*(options={}){
   polls++;
   if(polls>1)await new Promise((resolve,reject)=>{
     const timer=setTimeout(resolve,(options.waitSeconds??0)*1000);
     options.signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(options.signal.reason??new DOMException('Read cancelled','AbortError'));},{once:true});
   });
   if(!claimed)yield {job_digest:f.jobDigest,job:f.job,state:'queued',published_at:'2026-10-09T12:00:00Z',current_attempt:null};
 };
 const c=new AbortController(),pool=createLendingPool({createLender,storage:f.policy.storage,policy:f.policy,adapters:f.adapters,client:f.client,backend:f.backend,clock:{now:f.clock.now},
  approve:async()=>true,onEvent:e=>f.events.push(e)});
 const loop=pool.start(c.signal);f.stop=async()=>{c.abort();await loop;};
 await until(()=>polls>=2,'lender waiting for offers');
 f.policy.dailyMinutes=60;
 pool.reconfigure();
 await until(()=>claimed,'held offer claimed after the limit rose',5000);
});

test('a kept automatic acceptance resumes once under a pooled one-job rule',async t=>{
 const f=await lenderFixture(t,{offers:true,policy:{mode:'auto'}});offers(f);
 f.policy.quota=()=>({provider:'codex',remaining:100,observedAt:f.clock.now()});
 f.policy.standingRules=[{id:'one',circle:f.job.payload.circle,people:[f.job.payload.author],agents:['codex'],maxWallSeconds:300,dailyJobs:1,weeklyJobs:10,dailyMinutes:60,weeklyMinutes:600,expiresAt:f.clock.now()+86400000}];
 const report=f.backend.lenderCapabilities(),advertisement={harnesses:['codex'],models:['example-model'],capabilities:[],egress:report.egress,enforced_limits:report.enforced_limits,max_limits:report.max_limits};
 const acceptedAt=f.clock.now(),intent={jobDigest:f.jobDigest,advertisement,leaseSeconds:120,idempotencyKey:'kept-auto',acceptedAt,ruleId:'one'};
 await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,accounts:{'codex:0':{day:'2026-10-09',jobs:0,milliseconds:0,pending:null,acceptedClaim:{intent,claim:{job:f.job,job_digest:f.jobDigest,acceptedHarness:'codex',automatic:true}}}},
  ruleUsage:[{id:'one',jobDigest:f.jobDigest,acceptedAt,at:acceptedAt,ms:f.job.payload.requirements.limits.wall_seconds*1000}],hiddenOffers:[]});
 const c=new AbortController(),pool=createLendingPool({createLender,storage:f.policy.storage,policy:f.policy,adapters:f.adapters,client:f.client,backend:f.backend,clock:f.clock,approve:()=>assert.fail('kept acceptance does not ask again'),onEvent:e=>f.events.push(e)});
 const loop=pool.start(c.signal);f.stop=async()=>{c.abort();await loop;};
 await Promise.race([loop.then(()=>assert.fail('pool stopped before the accepted job ran')),until(()=>f.events.some(e=>e.status==='finished'),'kept automatic result')]);
 assert.equal(f.calls.filter(([kind])=>kind==='run').length,1);
 assert.equal(f.saved().ruleUsage.length,1);
});
test('automatic replay rechecks other accounts rule use added while the claim was awaited',async t=>{
 const f=await lenderFixture(t,{offers:true,policy:{mode:'auto'}});offers(f);
 f.policy.quota=()=>({provider:'codex',remaining:100,observedAt:f.clock.now()});
 f.policy.standingRules=[{id:'one',circle:f.job.payload.circle,people:[f.job.payload.author],agents:['codex'],maxWallSeconds:300,dailyJobs:1,weeklyJobs:10,dailyMinutes:60,weeklyMinutes:600,expiresAt:f.clock.now()+86400000}];
 const report=f.backend.lenderCapabilities(),advertisement={harnesses:['codex'],models:['example-model'],capabilities:[],egress:report.egress,enforced_limits:report.enforced_limits,max_limits:report.max_limits};
 const acceptedAt=f.clock.now(),intent={jobDigest:f.jobDigest,advertisement,leaseSeconds:120,idempotencyKey:'kept-recheck',acceptedAt,ruleId:'one'};
 await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,acceptedClaim:{intent,claim:{job:f.job,job_digest:f.jobDigest,acceptedHarness:'codex',automatic:true}},
  ruleUsage:[{id:'one',jobDigest:f.jobDigest,acceptedAt,at:acceptedAt,ms:120000}],hiddenOffers:[]});
 let sharedChanged=false;const get=f.policy.storage.get,claim=f.client.claimJob;
 f.policy.storage.get=async()=>{const row=await get();return sharedChanged?{...row,ruleUsage:[...(row.ruleUsage??[]),{id:'one',jobDigest:'other-account-job',acceptedAt:acceptedAt+1,at:acceptedAt,ms:120000}]}:row;};
 f.client.claimJob=async(...args)=>{const result=await claim(...args);sharedChanged=true;return result;};
 launch(t,f,()=>assert.fail('automatic replay must revalidate its rule'));
 await until(()=>f.count('/release')===1||f.calls.some(([kind])=>kind==='run'),'replayed acceptance decision');
 assert.equal(f.calls.filter(([kind])=>kind==='run').length,0);
 assert.equal(f.count('/release'),1);
});
test('manual offer holds no lease or source, hide never releases server work',async t=>{const f=await lenderFixture(t,{offers:true});offers(f);const answer=deferred();let card;launch(t,f,input=>{card=input;return answer.promise;});await until(()=>card,'offer');assert.equal(f.count('/jobs/claim-next'),0);assert.equal(card.offer,true);assert.equal(card.expiresAt,Date.parse(f.job.payload.expires_at));assert.equal(f.calls.length,0);answer.resolve(false);await until(()=>f.saved()?.hiddenOffers?.length,'local hide');assert.equal(f.count('/release'),0);assert.equal(f.count('/jobs/claim-next'),0);});
test('Pause during a legacy held review releases its attempt and never starts it',async t=>{
 const f=await lenderFixture(t,{offers:true});f.client.capabilities=async()=>({capabilities:[]});
 f.client.listJobs=async function*(){for(let n=1;n<=2001;n++)yield {job_digest:n===1?f.jobDigest:'sha256:'+String(n).padStart(64,'0'),job:f.job,state:'queued'};};
 const answer=deferred();let card;const lender=launch(t,f,input=>{card=input;return answer.promise;});
 await until(()=>card,'legacy held review');assert.notEqual(card.offer,true);
 lender.pause();answer.resolve(false);
 await until(()=>f.count('/release')===1,'legacy attempt released');
 assert.equal(f.calls.filter(([kind])=>kind==='run').length,0);
 assert.equal(Boolean(f.saved()?.declinePending),false,'the release decision is durably settled');
});
test('Run it claims once and prepares without a second question',async t=>{const f=await lenderFixture(t,{offers:true});offers(f);let asks=0;launch(t,f,async()=>{asks++;return true;});await until(()=>f.events.some(e=>e.status==='finished'),'completion');assert.equal(asks,1);assert.equal(f.count('/jobs/claim-next'),1);assert.ok(f.events.some(e=>e.status==='preparing'));assert.equal(f.calls.filter(([c])=>c==='run').length,1);});
test('a lost race reports Taken by someone else without preparing source',async t=>{const f=await lenderFixture(t,{offers:true});offers(f);f.client.claimJob=async()=>{throw Object.assign(new Error('conflict'),{code:'conflict',status:409});};launch(t,f,async()=>true);await until(()=>f.events.some(e=>e.reason==='conflict'),'lost race');assert.match(f.events.find(e=>e.reason==='conflict').label,/Taken by someone else/);assert.equal(f.calls.length,0);});

test('accepted named claim survives a restart before preparation without asking again',async t=>{
 const {realLenderFixture}=await import('./helpers/v1-real-lender-fixture.mjs');
 const f=await realLenderFixture(t,{offers:true});
 const report=f.backend.lenderCapabilities(),advertisement={harnesses:['codex'],models:['example-model'],capabilities:[],egress:report.egress,enforced_limits:report.enforced_limits,max_limits:report.max_limits};
 const intent={jobDigest:f.jobDigest,advertisement,leaseSeconds:120,idempotencyKey:'durable-offer-accept',acceptedAt:f.clock.now()};
 const claim=await f.client.claimJob(f.jobDigest,advertisement,{leaseSeconds:120,idempotencyKey:intent.idempotencyKey});
 await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,claimedPending:claim.attempt,acceptedClaim:{intent,claim:{...claim,acceptedHarness:'codex',automatic:false}}});
 launch(t,f,()=>assert.fail('durable acceptance must not ask again'));
 await until(()=>f.events.some(e=>e.status==='finished'),'resumed accepted work');
 assert.equal(f.calls.filter(([kind])=>kind==='run').length,1);
 assert.equal((await f.owner.getJob(f.jobDigest)).state,'result-accepted');
});

test('standing rule auto-accepts the eligible offer; a new person still needs review',async t=>{
 for(const inScope of [true,false]){
  const f=await lenderFixture(t,{offers:true,harness:'claude-code-subscription'});offers(f);let asks=0;
  f.policy.standingRules=[{id:'scope',circle:f.job.payload.circle,people:[inScope?f.job.payload.author:'someone-else'],agents:['claude-code-subscription'],maxWallSeconds:120,dailyJobs:2,weeklyJobs:10,dailyMinutes:30,weeklyMinutes:60,expiresAt:f.clock.now()+86400000}];
  launch(t,f,()=>{asks++;return true;});await until(()=>f.events.some(e=>e.status==='finished'),'rule result');assert.equal(asks,inScope?0:1);
 }
});

test('preparation watchdog prevents a late boot from starting the agent',async t=>{
 const f=await lenderFixture(t,{offers:true,policy:{preparationTimeoutMs:2000}});offers(f);const boot=deferred();let preparing=false;
 const original=f.backend.prepare;f.backend.prepare=async(...args)=>{preparing=true;await boot.promise;return original(...args);};
 f.backend.cancel=async()=>({compute_stopped:true});
 launch(t,f,async()=>true,{now:f.clock.now});const stop=f.stop;f.stop=async()=>{boot.resolve();await stop();};
 await until(()=>preparing,'boot pending');await until(()=>f.events.some(e=>e.reason==='preparation_timeout'),'watchdog fired');
 boot.resolve();await until(()=>f.saved()?.pending===null,'late sandbox cleaned');
 assert.equal(f.calls.filter(([kind])=>kind==='run').length,0);assert.equal(f.count('/start'),0);assert.ok(f.calls.some(([kind])=>kind==='destroy'));
 assert.ok(f.events.some(e=>e.status==='preparation-failed'&&e.label.includes('try it again')));
});

test('eligible jobs are offered together without reserving either while people decide',async t=>{
 const f=await lenderFixture(t,{offers:true});offers(f);const second='sha256:'+'e'.repeat(64);
 f.client.listOffers=async function*(){for(const digest of [f.jobDigest,second])yield {job_digest:digest,job:f.job,state:'queued',published_at:'2026-10-09T12:00:00Z'};};
 const cards=[];launch(t,f,input=>{cards.push(input);return new Promise(()=>{});});
 await until(()=>cards.length===2,'both eligible offers');assert.equal(f.count('/jobs/claim-next'),0);assert.equal(f.calls.length,0);
});

test('scoped rule counts separate jobs even when the wall clock never advances',async t=>{
 const {realLenderFixture}=await import('./helpers/v1-real-lender-fixture.mjs');
 const f=await realLenderFixture(t,{offers:true,harness:'claude-code-subscription'});await f.submit();await f.submit();
 f.policy.standingRules=[{id:'two-only',circle:f.job.payload.circle,people:[f.job.payload.author],agents:['claude-code-subscription'],maxWallSeconds:120,dailyJobs:2,weeklyJobs:2,dailyMinutes:30,weeklyMinutes:60,expiresAt:f.clock.now()+86400000}];
 let asks=0;launch(t,f,()=>{asks++;return new Promise(()=>{});});await until(()=>asks===1,'third job needs review after two automatic accepts');
 assert.equal(f.calls.filter(([kind])=>kind==='run').length,2);assert.equal(f.saved().ruleUsage.length,2);
 assert.equal(new Set(f.saved().ruleUsage.map(e=>e.jobDigest)).size,2);
});

test('an uncertain named claim keeps the acceptance pending until its exact replay is acknowledged',async t=>{
 const f=await lenderFixture(t,{offers:true});offers(f);const retry=deferred(),claim=f.client.claimJob;let calls=0,outcome;
 f.client.claimJob=async(...args)=>{if(++calls===1)throw Object.assign(new Error('offline'),{code:'network_error'});await retry.promise;return claim(...args);};
 launch(t,f,input=>{input.claimResult.then(value=>{outcome=value;});return true;});
 const stop=f.stop;f.stop=async()=>{retry.resolve();await stop();};
 await until(()=>f.events.some(e=>e.reason==='network_error'),'uncertain claim recorded');assert.equal(outcome,undefined,'a retryable claim failure is not an expired or rejected offer');
 f.clock.advance(1000);await until(()=>calls===2,'durable named claim replay');
 assert.equal(f.calls.length,0,'source and sandbox wait for the claim acknowledgement');
 retry.resolve();await until(()=>f.events.some(e=>e.status==='finished'),'replayed claim finishes');assert.equal(outcome.accepted,true);
});

test('automatic mode records each standing-rule acceptance once',async t=>{
 const {realLenderFixture}=await import('./helpers/v1-real-lender-fixture.mjs');
 const f=await realLenderFixture(t,{offers:true,harness:'claude-code-subscription'});await f.submit();await f.submit();f.policy.mode='auto';
 f.policy.standingRules=[{id:'three-auto',circle:f.job.payload.circle,people:[f.job.payload.author],agents:['claude-code-subscription'],maxWallSeconds:120,dailyJobs:3,weeklyJobs:3,dailyMinutes:30,weeklyMinutes:60,expiresAt:f.clock.now()+86400000}];
 let asks=0;launch(t,f,()=>{asks++;return new Promise(()=>{});});await until(()=>asks>0||f.calls.filter(([kind])=>kind==='run').length===3,'automatic jobs settle');
 assert.equal(asks,0);assert.equal(f.calls.filter(([kind])=>kind==='run').length,3);assert.equal(f.saved().ruleUsage.length,3);
 assert.equal(new Set(f.saved().ruleUsage.map(e=>e.jobDigest)).size,3);
});

test('auto offer discovery defers a model-less conversion hold to the signed job gate', {timeout:90000}, async t=>{
 const f=await lenderFixture(t,{offers:true,harness:'claude-code-subscription',run:{model:'claude-haiku-5-5'},policy:{mode:'auto'}});offers(f);
 const candidate=f.policy.lendingRuntime.candidate,gateCalls=[];let claims=0;
 candidate.gate=async args=>{gateCalls.push({jobId:args.jobId,model:args.model,automatic:args.automatic});
  return args.job?null:'conversion_unknown';};
 const claim=f.client.claimJob.bind(f.client);f.client.claimJob=async(...args)=>{claims++;return claim(...args);};
 launch(t,f,()=>assert.fail('the matching standing rule must not ask for approval'));
 await until(()=>claims===1,'matching, model-priced offer passed its job-specific gate',1500).catch(()=>
  assert.fail(JSON.stringify({gateCalls,events:f.events.map(e=>({status:e.status,reason:e.reason})),requests:f.requests.map(r=>r.route)})));
 assert.ok(gateCalls.every(call=>call.jobId!==null),
  'auto offer discovery must not run the model-less preflight');
 assert.ok(gateCalls.some(call=>call.jobId===f.jobDigest&&call.model==='claude-haiku-5-5'),
  'screening must pass the signed job and selected model to the candidate');
 await f.stop();
});

for(const heldReason of ['model_not_lendable','conversion_unknown','identity_unknown','funding_unknown','owner_reserve'])
 test('auto offer discovery keeps a job-specific '+heldReason+' refusal held',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{offers:true,harness:'claude-code-subscription',run:{model:'claude-haiku-5-5'},policy:{mode:'auto'}});offers(f);
  const candidate=f.policy.lendingRuntime.candidate,gateCalls=[];let claims=0;
  candidate.gate=async args=>{gateCalls.push({jobId:args.jobId,model:args.model});return args.job?heldReason:'conversion_unknown';};
  f.client.claimJob=async()=>{claims++;assert.fail('a refused job must not be claimed');};
  const lender=launch(t,f,()=>assert.fail('a matching standing rule must not ask for approval'));
  await until(()=>gateCalls.some(call=>call.jobId===f.jobDigest),'the real signed job reached the job-specific gate',1500);
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(claims,0);assert.ok(gateCalls.some(call=>call.model==='claude-haiku-5-5'));
  assert.equal(lender.getState().heldOffers.find(row=>row.id===f.jobDigest)?.reason,heldReason);
  await f.stop();
  assert.deepEqual(lender.getState().heldOffers,[]);
 });

test('a past reserve recheck is due at the next offer decision', () => {
 const now=100;
 assert.equal(reserveRecheckNeeded(90, 110, now), true);
 assert.equal(reserveRecheckNeeded(105, 110, now), false);
 assert.equal(reserveRecheckNeeded(120, 110, now), true);
 assert.equal(reserveRecheckNeeded(90, 99, now), false);
 assert.equal(reserveRecheckNeeded(null, 110, now), false);
});

test('a reserve-held Auto offer requests a bounded reread using its signed expiry',async t=>{
 const f=await lenderFixture(t,{offers:true,harness:'claude-code-subscription',run:{model:'claude-haiku-5-5'},policy:{mode:'auto'}});offers(f);
 let screened;
 f.policy.lendingRuntime.candidate.gate=async args=>{if(args.job)screened=args;return 'owner_reserve';};
 f.client.claimJob=async()=>assert.fail('a refused offer must not claim');
 launch(t,f,()=>assert.fail('an Automatic offer must not ask'));
 await until(()=>screened,'signed offer screened at arrival',1500);
 assert.equal(screened.offerDeadline,Date.parse(f.job.payload.expires_at));
 await f.stop();
});

test('auto legacy claim without an offer reader still honors model-less conversion refusal',{timeout:60000},async t=>{
 const f=await lenderFixture(t,{offers:false,harness:'claude-code-subscription',run:{model:'claude-haiku-5-5'},policy:{mode:'auto'}});
 const candidate=f.policy.lendingRuntime.candidate,gateCalls=[];let claims=0;
 candidate.gate=async args=>{gateCalls.push({jobId:args.jobId,model:args.model});return 'conversion_unknown';};
 f.client.claimNext=async()=>{claims++;assert.fail('legacy claim path must remain held without model-specific preflight');};
 launch(t,f,()=>assert.fail('auto legacy hold must not ask for approval'));
 await until(()=>f.events.some(e=>e.status==='paused'&&e.reason==='conversion_unknown'),'legacy model-less refusal',1500);
 assert.equal(claims,0);assert.ok(gateCalls.some(call=>call.jobId===null&&call.model==='claude-haiku-5-5'));
 await f.stop();
});

test('simultaneous accepts of different local cards settle both claim outcomes',async t=>{
 const f=await lenderFixture(t,{offers:true});offers(f);const second='sha256:'+'e'.repeat(64),answers=deferred(),cards=[],outcomes=new Map();
 let listed=false;f.client.listOffers=async function*(){if(listed)return;listed=true;for(const digest of [f.jobDigest,second])yield {job_digest:digest,job:f.job,state:'queued',published_at:'2026-10-09T12:00:00Z'};};
 launch(t,f,input=>{cards.push(input);input.claimResult.then(result=>outcomes.set(input.jobDigest,result));if(cards.length===2)answers.resolve(true);return answers.promise;});
 await until(()=>f.events.some(e=>e.status==='finished'),'one chosen job finishes');
 assert.equal(cards.length,2);assert.equal(outcomes.size,2,'the unselected accept must not hang');
 assert.equal([...outcomes.values()].filter(result=>result.accepted).length,1);
 assert.equal(outcomes.get(second).code,'inbox_closed');
});

test('replayed acceptance cannot switch to a different selected agent',async t=>{
 const {legacyProxyHarness}=await import('./helpers/legacy-proxy-harness.mjs');
 const f=await lenderFixture(t,{offers:true,mutateJob:job=>{delete job.requirements.harness;}});offers(f);
 const report=f.backend.lenderCapabilities();
 const advertisement={harnesses:['codex'],models:['example-model'],capabilities:[],egress:report.egress,enforced_limits:report.enforced_limits,max_limits:report.max_limits};
 await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,claimPending:{jobDigest:f.jobDigest,advertisement,leaseSeconds:120,idempotencyKey:'accepted-with-codex',acceptedAt:f.clock.now(),ruleId:null}});
 f.adapters[0].spec=legacyProxyHarness('claude-code-subscription');
 launch(t,f,()=>assert.fail('the accepted agent cannot be silently widened'));
 await until(()=>f.events.some(e=>e.status==='finished'||e.status==='declined'),'accepted-agent replay outcome');
 assert.equal(f.calls.filter(([kind])=>kind==='run').length,0);assert.ok(f.events.some(e=>e.reason==='readiness_changed'));
});

test('accepted work resumes without another question after its unstarted lease expired during a crash',async t=>{
 const {realLenderFixture}=await import('./helpers/v1-real-lender-fixture.mjs');
 const f=await realLenderFixture(t,{offers:true});const report=f.backend.lenderCapabilities();
 const advertisement={harnesses:['codex'],models:['example-model'],capabilities:[],egress:report.egress,enforced_limits:report.enforced_limits,max_limits:report.max_limits};
 const intent={jobDigest:f.jobDigest,advertisement,leaseSeconds:120,idempotencyKey:'accepted-before-long-crash',acceptedAt:f.clock.now()};
 const claim=await f.client.claimJob(f.jobDigest,advertisement,{leaseSeconds:120,idempotencyKey:intent.idempotencyKey});
 await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,claimedPending:claim.attempt,acceptedClaim:{intent,claim:{...claim,acceptedHarness:'codex',automatic:false}}});f.clock.advance(121000);
 let asks=0;launch(t,f,()=>{asks++;return new Promise(()=>{});});
 await until(()=>asks>0||f.events.some(e=>e.status==='finished')||f.events.some(e=>e.reason==='lease_expired'),'expired acceptance replay outcome');
 assert.equal(asks,0);assert.ok(!f.events.some(e=>e.reason==='lease_expired'),'the expired execution lease must not discard durable consent');
 await until(()=>f.events.some(e=>e.status==='finished'),'accepted work reclaimed');assert.equal((await f.owner.getJob(f.jobDigest)).state,'result-accepted');
});

for(const action of ['pause','off'])test(action+' during preparation prevents the agent start and retains consent for resume',async t=>{
 const {realLenderFixture}=await import('./helpers/v1-real-lender-fixture.mjs');
 const f=await realLenderFixture(t,{offers:true});const boot=deferred(),prepare=f.backend.prepare;let preparing=false,asks=0;
 f.backend.cancel=async()=>({compute_stopped:true});
 f.backend.prepare=async(...args)=>{preparing=true;await boot.promise;return prepare(...args);};
 const lender=launch(t,f,()=>{asks++;return true;});const stop=f.stop;f.stop=async()=>{boot.resolve();await stop();};
 await until(()=>preparing,'preparation pending');if(action==='off')f.policy.enabled=false;lender.pause();boot.resolve();
 await until(()=>f.calls.some(([kind])=>kind==='destroy')&&f.saved()?.pending===null,'paused preparation cleanup');
 assert.equal(f.realRequests.filter(row=>row.url.endsWith('/start')).length,0);assert.equal(f.calls.filter(([kind])=>kind==='run').length,0);assert.ok(f.saved().acceptedClaim,'accepted work remains durable');
 assert.ok(!f.saved().hiddenOffers?.some(row=>row.jobDigest===f.jobDigest));
 f.policy.enabled=true;lender.resume();await until(()=>f.events.some(e=>e.status==='finished'),'accepted work resumes');
 assert.equal(asks,1);assert.equal(f.calls.filter(([kind])=>kind==='run').length,1);
});

test('pause while the start acknowledgement is delayed never launches the agent or reruns uncertain execution',async t=>{
 const {realLenderFixture}=await import('./helpers/v1-real-lender-fixture.mjs');
 const f=await realLenderFixture(t,{offers:true});const acknowledged=deferred(),release=deferred(),start=f.client.startAttempt;
 f.backend.cancel=async()=>({compute_stopped:true});
 f.client.startAttempt=async(...args)=>{const marked=await start(...args);acknowledged.resolve();await release.promise;return marked;};
 const lender=launch(t,f,async()=>true);const stop=f.stop;f.stop=async()=>{release.resolve();await stop();};
 await acknowledged.promise;lender.pause();release.resolve();
 await until(()=>f.calls.some(([kind])=>kind==='destroy')&&f.saved()?.pending===null,'paused acknowledged start cleanup');
 assert.equal(f.calls.filter(([kind])=>kind==='run').length,0);assert.ok(!f.events.some(e=>e.status==='running'));
 assert.equal(f.realRequests.filter(row=>row.url.endsWith('/observed-start')).length,0,'Pause in the acknowledgement gap leaves no backend-start evidence');
 assert.equal(f.saved().acceptedClaim,null,'an acknowledged execution start is never automatically rerun');
});

test('a rejected backend start keeps only the durable request fence and never notifies running',async t=>{
 const f=await realLenderFixture(t,{offers:true}),entered=deferred(),rejectStart=deferred(),start=f.backend.start.bind(f.backend);
 f.backend.start=async(handle,options)=>{
  if(handle._sourcePreparation)return start(handle,options);
  entered.resolve();await rejectStart.promise;throw new Error('Synthetic backend start rejection');
 };
 launch(t,f,async()=>true);await entered.promise;
 const acknowledged=await f.client.getJob(f.jobDigest);
 assert.equal(typeof acknowledged.current_attempt.execution_started_at,'string');
 assert.equal(acknowledged.current_attempt.execution_observed_at??null,null);
 assert.ok(!f.events.some(e=>e.status==='running'));
 rejectStart.resolve();await until(()=>f.events.some(e=>e.status==='failed'),'backend start rejection settled');
 await f.stop();
 assert.equal(f.realRequests.filter(row=>row.url.endsWith('/observed-start')).length,0);
 assert.ok(!f.events.some(e=>e.status==='running'));
});

test('pause closes unclaimed previews without hiding them, and resume offers them again',async t=>{
 const f=await lenderFixture(t,{offers:true});offers(f);const cards=[];
 const lender=launch(t,f,input=>{cards.push(input);return new Promise(()=>{});});
 await until(()=>cards.length===1,'open offer');lender.pause();assert.equal(cards[0].signal.aborted,true,'Pause closes the unclaimed preview');
 assert.ok(!f.saved()?.hiddenOffers?.length);assert.equal(f.count('/jobs/claim-next'),0);
 await until(()=>f.clock.pending().includes(1000),'paused discovery loop');lender.resume();await until(()=>cards.length===2,'offer returns on resume');assert.ok(!f.saved()?.hiddenOffers?.length);
});

test('2001-job old host uses claim-next and clearly labels its 60-second review hold',async t=>{
 const f=await lenderFixture(t,{offers:true,policy:{legacyHoldMs:60000}});let card;
 f.client.capabilities=async()=>({capabilities:[]});
 f.client.listJobs=async function*(){for(let n=1;n<=2001;n++)yield {job_digest:'sha256:'+String(n).padStart(64,'0'),job:f.job,state:'queued'};};
 launch(t,f,input=>{card=input;return new Promise(()=>{});});await until(()=>card,'legacy held review');
 assert.equal(f.count('/jobs/claim-next'),1);assert.notEqual(card.offer,true);assert.equal(card.expiresAt,f.clock.now()+60000);
 assert.ok(f.events.some(e=>e.status==='legacy-hold'&&/host.*old.*offers/i.test(e.label)));
 f.clock.advance(60000);await until(()=>f.count('/release')===1,'legacy hold timeout releases');assert.equal(f.calls.filter(([kind])=>kind==='run').length,0);
});

test('bare automatic mode without a standing grant still asks before execution',async t=>{
 const f=await lenderFixture(t,{offers:true,policy:{mode:'auto',standingRules:[]}});offers(f);let asks=0;
 launch(t,f,()=>{asks++;return true;});await until(()=>f.events.some(e=>e.status==='finished'),'explicitly approved legacy-auto job');
 assert.equal(asks,1);assert.equal(f.saved().ruleUsage?.length??0,0);
});

test('Stop revocation survives a preparation save queued while the stop write is delayed',async t=>{
 const {realLenderFixture}=await import('./helpers/v1-real-lender-fixture.mjs');
 const f=await realLenderFixture(t,{offers:true}),boot=deferred(),write=deferred(),entered=deferred(),prepare=f.backend.prepare,set=f.policy.storage.set;let preparing=false,held=false;
 f.backend.cancel=async()=>({compute_stopped:true});f.backend.prepare=async(...args)=>{preparing=true;await boot.promise;return prepare(...args);};
 f.policy.storage.set=async value=>{if(!held&&value.pending?.stopReason==='stopped_by_lender'){held=true;entered.resolve();await write.promise;}return set(value);};
 const lender=launch(t,f,async()=>true);const stop=f.stop;f.stop=async()=>{boot.resolve();write.resolve();await stop();};
 await until(()=>preparing,'prepare pending');const stopping=lender.stopCurrentJob(lender.getState().current);await entered.promise;
 boot.resolve();await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));write.resolve();await stopping;
 await until(()=>f.calls.some(([kind])=>kind==='destroy')&&f.saved()?.pending===null,'stopped preparation cleaned');
 const revoked=f.saves.findIndex(row=>row.pending?.stopReason==='stopped_by_lender'&&row.acceptedClaim===null);assert.ok(revoked>=0);
 for(const row of f.saves.slice(revoked)){assert.equal(row.acceptedClaim,null,'a stale queued save must never restore consent');assert.equal(row.claimedPending,null);assert.ok(row.hiddenOffers?.some(item=>item.jobDigest===f.jobDigest),'the stop tombstone must survive every queued write');}
});

test('Stop recovery removes a stale restored acceptance before cleanup and keeps the stopped offer hidden',async t=>{
 const {realLenderFixture}=await import('./helpers/v1-real-lender-fixture.mjs');
 const f=await realLenderFixture(t,{offers:true}),report=f.backend.lenderCapabilities();
 const advertisement={harnesses:['codex'],models:['example-model'],capabilities:[],egress:report.egress,enforced_limits:report.enforced_limits,max_limits:report.max_limits};
 const intent={jobDigest:f.jobDigest,advertisement,leaseSeconds:120,idempotencyKey:'stale-stopped-acceptance',acceptedAt:f.clock.now()};
 const claim=await f.client.claimJob(f.jobDigest,advertisement,{leaseSeconds:120,idempotencyKey:intent.idempotencyKey});
 await f.policy.storage.set({day:'2026-10-09',jobs:1,milliseconds:120000,acceptedClaim:{intent,claim},hiddenOffers:[],pending:{...f.backend.sandboxOwnership(),attemptId:claim.attempt.attempt_id,attempt:claim.attempt,reservedMs:120000,executionStartRequested:false,stopReason:'stopped_by_lender',stopReleaseKey:'stopped-release',stopReportKey:'stopped-report',cessationVerified:{sbx_home:f.backend.sandboxOwnership().sbx_home,attemptId:claim.attempt.attempt_id,jobDigest:f.jobDigest,generation:claim.attempt.generation}}});
 launch(t,f,()=>assert.fail('stopped work must not ask or run again'));await until(()=>f.saved()?.lastRecovery?.attemptId===claim.attempt.attempt_id,'stop recovery');
 assert.equal(f.saved().acceptedClaim,null);assert.ok(f.saved().hiddenOffers.some(item=>item.jobDigest===f.jobDigest));assert.equal(f.calls.filter(([kind])=>kind==='run').length,0);
});

test('a standing rule removed while the idle check awaits does not accept automatically',async t=>{
 const f=await lenderFixture(t,{offers:true,harness:'claude-code-subscription'});offers(f);
 f.policy.standingRules=[{id:'scope',circle:f.job.payload.circle,people:[f.job.payload.author],agents:['claude-code-subscription'],maxWallSeconds:120,dailyJobs:2,weeklyJobs:10,dailyMinutes:30,weeklyMinutes:60,expiresAt:f.clock.now()+86400000}];
 const idle=deferred();let checks=0;
 f.policy.idleOnly=true;f.policy.userActive=async()=>{checks++;await idle.promise;return false;};
 let asks=0;launch(t,f,()=>{asks++;return new Promise(()=>{});});
 await until(()=>checks>0,'idle check pending');
 f.policy.standingRules=[];idle.resolve();
 await until(()=>{f.clock.advance?.(1000);return asks===1;},'the offer falls back to a person');
 assert.equal(f.calls.filter(([kind])=>kind==='run').length,0);assert.equal(f.count('/start'),0);
});

test('replayed automatic claim resolves its lease but a revoked rule cannot start work',async t=>{
 const f=await lenderFixture(t,{offers:true,policy:{mode:'ask',standingRules:[]}});offers(f);
 f.policy.quota=()=>({provider:'codex',remaining:100,observedAt:f.clock.now()});
 const report=f.backend.lenderCapabilities(),advertisement={harnesses:['codex'],models:['example-model'],capabilities:[],egress:report.egress,enforced_limits:report.enforced_limits,max_limits:report.max_limits};
 await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,claimPending:{jobDigest:f.jobDigest,advertisement,leaseSeconds:120,idempotencyKey:'uncertain-rule-claim',acceptedAt:f.clock.now(),ruleId:'revoked'}});
 launch(t,f,()=>assert.fail('resolve the uncertain claim, then release it without fetching source or starting'));
 await until(()=>f.count('/release')>0||f.calls.some(([kind])=>kind==='run'),'recovered claim resolved');
 assert.equal(f.calls.filter(([kind])=>kind==='run').length,0);assert.equal(f.count('/release'),1);
});

// The continuous candidate removed the old ten-minute surplus confirmation. Objective holds now come from candidate.gate.
function fakeCandidate(gate,reserve=async()=>({ok:false,reason:'test_stop'})) {
 return {gate,reserve,registry:{bind(){},unbind(){}},
  async admitStart(){return {ok:true,reason:null};},
  async started(){return {applied:true};},async recordCleanup(){return {applied:true};},
  async finish(){return {metered:{model:null}};},async settle(){return {applied:true};}};
}

test('a standing-rule offer that arrives while a manual card is open is claimed without waiting for that card',async t=>{
 const f=await lenderFixture(t,{offers:true,harness:'claude-code-subscription'});
 const member='sha256:'+'f'.repeat(64),offerOf=(digest,author)=>({job_digest:digest,job:{...f.job,payload:{...f.job.payload,author}},state:'queued',published_at:'2026-10-09T12:00:00Z'});
 const manual=offerOf(f.jobDigest,f.job.payload.author),standing=offerOf('sha256:'+'e'.repeat(64),member);
 f.policy.standingRules=[{id:'member',circle:f.job.payload.circle,people:[member],agents:['claude-code-subscription'],maxWallSeconds:120,dailyJobs:2,weeklyJobs:10,dailyMinutes:30,weeklyMinutes:60,expiresAt:f.clock.now()+86400000}];
 let open=[manual];
 f.client.capabilities=async()=>({capabilities:['offers_v1']});
 f.client.listOffers=async function*(){yield* open;};
 f.policy.lendingRuntime={candidate:fakeCandidate(async()=>null)};
 const cards=[],claims=[];
 f.client.claimJob=async digest=>{claims.push(digest);throw Object.assign(new Error('claim stopped by test'),{code:'test_stopped',status:409,claimRejected:true});};
 launch(t,f,input=>{cards.push(input.jobDigest);return new Promise(()=>{});});
 await until(()=>cards.length===1,'manual card for the original offer');
 open=[manual,standing];
 // The card stays open. Each poll interval the lender screens the open offers again, so the standing-rule offer is claimed on the first poll that sees it.
 for(let poll=0;poll<5&&!claims.length;poll++){f.clock.advance(1000);await new Promise(r=>setTimeout(r,20));}
 assert.deepEqual(claims,[standing.job_digest],'the standing-rule offer waited behind the manual card');
 assert.deepEqual(cards,[manual.job_digest]);
});

// A standing rule that covers the fixture's offer: its author, its harness, a 120 s wall limit. `extra` overrides a limit.
function ruleCoveringOffer(f,extra={}) {
 f.policy.standingRules=[{id:'member',circle:f.job.payload.circle,people:[f.job.payload.author],agents:['claude-code-subscription'],maxWallSeconds:120,dailyJobs:2,weeklyJobs:10,dailyMinutes:30,weeklyMinutes:60,expiresAt:f.clock.now()+86400000,...extra}];
}
// Each step is one idle poll: the lender waits pollMs on the fake clock, then screens the open offers again.
async function polls(f,n) {for(let poll=0;poll<n;poll++){f.clock.advance(1000);await new Promise(r=>setTimeout(r,20));}}

test('a rule-covered offer that the lending window refuses is held without a card, then taken when the window opens',async t=>{
 const f=await lenderFixture(t,{offers:true,harness:'claude-code-subscription'});offers(f);ruleCoveringOffer(f);
 let open=false,asks=0;const taken=[];
 f.policy.lendingRuntime={candidate:fakeCandidate(async()=>open?null:'rate_window',async args=>{taken.push(args);return {ok:false,reason:'test_stop'};})};
 launch(t,f,()=>{asks++;return false;});
 await until(()=>f.clock.pending().includes(1000),'first idle poll');
 await polls(f,3);
 assert.equal(asks,0,'a rule-covered offer became a manual card while the lending window refused it');
 open=true;f.clock.advance(1000);
 await until(()=>taken.length,'held offer taken once the window opens');
 assert.equal(taken[0].automatic,true);assert.equal(asks,0);
});

test('a rule-covered objective hold stays reviewable in ask mode and reserves only after acceptance',async t=>{
 const f=await lenderFixture(t,{offers:true,harness:'claude-code-subscription'});offers(f);ruleCoveringOffer(f);
 const reserveArgs=[],answer=deferred();let card;
 let gateCalls=0;
 f.policy.lendingRuntime={candidate:fakeCandidate(async()=> ++gateCalls<3?'demand_model_unavailable':null,async args=>{
   reserveArgs.push(args);return {ok:false,reason:'demand_model_unavailable',policyReason:'demand_model_unavailable'};
 })};
 launch(t,f,input=>{card=input;return answer.promise;});
 await until(()=>card,'objective-held request review card');
 assert.equal(card.offer,true);
 assert.equal(gateCalls,2,'the offer is screened with its objective hold before review');
 assert.equal(f.count('/jobs/claim-next'),0,'a review card does not claim or reserve the job');
 answer.resolve(true);
 await until(()=>reserveArgs.length,'durable reserve after the owner accepts');
 assert.ok(gateCalls>=3,'the objective gate runs again after acceptance');
 assert.equal(reserveArgs[0].automatic,false,'the review decision stays manual');
 await until(()=>f.events.some(e=>e.status==='declined'&&e.reason==='demand_model_unavailable'),
  'post-acceptance objective refusal to settle');
 assert.equal(reserveArgs.length,1,'the durable reservation is checked once after acceptance');
 assert.equal(f.count('/release'),1,'the refused claim is released');
 assert.equal(f.attempt().state,'released','the claim is terminal before checking the executor');
 assert.equal(f.calls.filter(([kind])=>kind==='run').length,0,'the objective hold still blocks execution');
});

test('a rule-covered offer waits without a card while the owner is at the computer, then is taken when they step away',async t=>{
 const f=await lenderFixture(t,{offers:true,harness:'claude-code-subscription',policy:{idleOnly:true}});offers(f);ruleCoveringOffer(f);
 let busy=true,asks=0;f.policy.userActive=()=>busy;
 f.policy.lendingRuntime={candidate:fakeCandidate(async()=>null,async()=>({ok:true,reservation:{provider:'claude',model:'example-model'},decision:{effort_max:null}}))};
 launch(t,f,()=>{asks++;return false;});
 await until(()=>f.clock.pending().includes(1000),'first idle poll');
 await polls(f,3);
 assert.equal(asks,0,'a rule-covered offer became a manual card while the owner was at the computer');
 busy=false;f.clock.advance(1000);
 await until(()=>f.events.some(e=>e.status==='finished'),'held offer finished once the owner is away');
 assert.equal(asks,0);
});

test('real store fences explicit effort before claiming and accepts only a shared ready tuple',async t=>{
 const cap='model_effort_pairs_v1';
 const f=await realLenderFixture(t,{offers:true,mutateJob:job=>{
   job.expires_at=new Date(Date.parse(job.created_at)+3600000).toISOString().replace('.000Z','Z');
   job.requirements.harness=['codex'];
   job.requirements.model={any_of:['example-model']};
   job.requirements.capabilities=[...new Set([...job.requirements.capabilities,'budget_v1'])];
   job.budget_v1={...(job.budget_v1??{}),max_list_usd:2,effort:'low'};
 }});
 assert.equal(f.job.payload.budget_v1.effort,'low','fixture mutation must precede signing');
 const req=f.job.payload.requirements,report=f.backend.lenderCapabilities();
 const ad={harnesses:['codex'],models:['example-model','other-model'],
   capabilities:[...new Set([...req.capabilities,cap])],egress:report.egress,
   enforced_limits:report.enforced_limits,max_limits:report.max_limits,
   model_efforts:[{harness:'codex',model:'example-model',effort:'low'}]};
 let seq=0,key=0;
 const heartbeat=async (model_efforts,readiness='ready',capabilities=['budget_v1',cap])=>{
   const agent={adapter:'codex',readiness,models:['example-model','other-model'],per_job_max_minutes:2};
   if(model_efforts!==undefined)agent.model_efforts=model_efforts;
   return f.client.heartbeat({boot:'pair-test-1030',seq:seq++,intent:{state:'ready'},
     execution:{state:'idle'},blockers:[],agents:[agent],capabilities});
 };
 const refused=async advertisement=>{
   const before=await f.owner.getJob(f.jobDigest);
   await assert.rejects(f.client.claimJob(f.jobDigest,advertisement,{leaseSeconds:120,idempotencyKey:'pair-refuse-'+key++}),
     error=>error.code==='requirements_unsupported');
   const after=await f.owner.getJob(f.jobDigest);
   assert.equal(after.state,'queued');
   assert.deepEqual(after.current_attempt,before.current_attempt);
   assert.equal(after.attempts_started,before.attempts_started);
 };
 await heartbeat(undefined);
 await refused(ad); // A capability name alone does not configure a pair.
 await heartbeat([{model:'example-model',effort:'high'},{model:'other-model',effort:'low'}]);
 await refused(ad); // No model/effort cross-product.
 await heartbeat([{model:'example-model',effort:'low'}],'checking');
 await refused(ad);
 await heartbeat([{model:'example-model',effort:'low'}]);
 const legacy={...ad};delete legacy.model_efforts;
 await refused(legacy);
 await refused({...ad,model_efforts:[{harness:'codex',model:'example-model',effort:'high'}]});
 await assert.rejects(heartbeat([{model:'example-model',effort:'unknown'}]),error=>error.code==='invalid_request');
 await assert.rejects(heartbeat([{model:'missing',effort:'low'}]),error=>error.code==='invalid_request');
 await assert.rejects(heartbeat([{model:'example-model',effort:'low'}],'ready',['budget_v1']),error=>error.code==='invalid_request');
 await heartbeat([{model:'example-model',effort:'low'}]);
 f.clock.advance(91000);
 await refused(ad); // Stale configured support is not admission evidence.
 await heartbeat([{model:'example-model',effort:'low'}]);
 const claimed=await f.client.claimJob(f.jobDigest,ad,{leaseSeconds:120,idempotencyKey:'pair-accepted'});
 assert.ok(claimed.attempt?.attempt_id);
 assert.equal((await f.owner.getJob(f.jobDigest)).state,'claimed');
 assert.equal(f.calls.filter(([kind])=>kind==='run').length,0,'this regression never starts an agent');
});

test('real store preserves model-only admission when the job omits effort',async t=>{
 const f=await realLenderFixture(t,{offers:true,mutateJob:job=>{
   delete job.budget_v1;
   job.requirements.capabilities=job.requirements.capabilities.filter(c=>c!=='budget_v1');
 }});
 const req=f.job.payload.requirements,report=f.backend.lenderCapabilities();
 const ad={harnesses:['codex'],models:['example-model'],capabilities:[...req.capabilities],
   egress:report.egress,enforced_limits:report.enforced_limits,max_limits:report.max_limits};
 await f.client.heartbeat({boot:'pair-legacy-1030',seq:0,intent:{state:'ready'},execution:{state:'idle'},
   blockers:[],agents:[{adapter:'codex',readiness:'ready',models:['example-model'],per_job_max_minutes:2}],capabilities:[]});
 const claim=await f.client.claimJob(f.jobDigest,ad,{leaseSeconds:120,idempotencyKey:'legacy-pair-omitted'});
 assert.ok(claim.attempt?.attempt_id);
 assert.equal(f.calls.filter(([kind])=>kind==='run').length,0);
});

test('configured explicit tuple reaches the executor through the real store',async t=>{
 const f=await realLenderFixture(t,{offers:true,run:{model:null,effort:null,model_efforts:[{model:'other-model',effort:'high'},{model:'example-model',effort:'low'}]},mutateJob:job=>{
   job.expires_at=new Date(Date.parse(job.created_at)+3600000).toISOString().replace('.000Z','Z');
   job.requirements.harness=['codex'];job.requirements.model={any_of:['example-model']};
   job.requirements.capabilities=[...new Set([...job.requirements.capabilities,'budget_v1'])];
   job.budget_v1={max_list_usd:2,effort:'low'};
 }});
 await f.client.heartbeat({boot:'producer-pair-test',seq:0,intent:{state:'ready'},execution:{state:'idle'},blockers:[],
   agents:[{adapter:'codex',readiness:'ready',models:['example-model','other-model'],per_job_max_minutes:2,model_efforts:[{model:'other-model',effort:'high'},{model:'example-model',effort:'low'}]}],
   capabilities:['budget_v1','model_effort_pairs_v1']});
 f.backend.requestStop=async()=>({compute_stopped:true});
 const candidate=f.policy.lendingRuntime.candidate,reserve=candidate.reserve.bind(candidate),reserved=[];
 candidate.reserve=async args=>{reserved.push(args.model);return reserve(args);};
 let entrypoint;const start=f.backend.start;f.backend.start=async (handle,opts)=>{if(handle._entrypoint.includes('model_reasoning_effort='))entrypoint=handle._entrypoint;return start(handle,opts);};
 launch(t,f,async()=>true);
 await until(()=>f.calls.some(([kind])=>kind==='run'),'configured tuple execution',8000);
 assert.match(entrypoint,/example-model/);assert.match(entrypoint,/model_reasoning_effort=low/);assert.deepEqual(reserved,['example-model']);
});

test('lender does not claim explicit effort without its configured negotiated pair',async t=>{
 for(const [name,run,oldHost] of [
  ['wrong effort',{model:null,effort:null,model_efforts:[{model:'example-model',effort:'high'}]},false],
  ['wrong model',{model:null,effort:null,model_efforts:[{model:'other-model',effort:'low'}]},false],
  ['cross pair',{model:null,effort:null,model_efforts:[{model:'example-model',effort:'high'},{model:'other-model',effort:'low'}]},false],
  ['empty',{model:null,effort:null,model_efforts:[]},false],
  ['malformed',{model:null,effort:null,model_efforts:[{model:'example-model',effort:'unknown'}]},false],
  ['unconfigured',{model:null,effort:null},false],
  ['old host',{model:null,effort:null,model_efforts:[{model:'example-model',effort:'low'}]},true],
 ])await t.test(name,async t=>{
  const f=await realLenderFixture(t,{offers:true,run,mutateJob:job=>{
   job.expires_at=new Date(Date.parse(job.created_at)+3600000).toISOString().replace('.000Z','Z');
   job.requirements.harness=['codex'];job.requirements.model={any_of:['example-model']};job.requirements.capabilities=['budget_v1'];
   job.budget_v1={max_list_usd:2,effort:'low'};
  }});
  await f.client.heartbeat({boot:'negative-pairs-test',seq:0,intent:{state:'ready'},execution:{state:'idle'},blockers:[],
   agents:[{adapter:'codex',readiness:'ready',models:['example-model'],per_job_max_minutes:2,model_efforts:[{model:'example-model',effort:'low'}]}],capabilities:['budget_v1','model_effort_pairs_v1']});
  f.backend.requestStop=async()=>({compute_stopped:true});
  if(oldHost)f.client.capabilities=async()=>({capabilities:['offers_v1','budget_v1']});
  let read=false;const list=f.client.listOffers.bind(f.client);
  f.client.listOffers=async function*(opts){for await(const item of list(opts)){yield item;read=true;}};
  launch(t,f,()=>assert.fail('incompatible request must not be reviewed'));
  await until(()=>read,'offer was screened',8000);
  await new Promise(resolve=>setTimeout(resolve,50));
  const view=await f.owner.getJob(f.jobDigest);
  assert.equal(view.attempts_started,0);assert.equal(f.calls.filter(([kind])=>kind==='run').length,0);
 });
});

test('the claim cannot use a different heartbeat tuple from the one selected for execution',async t=>{
 const pairs=[{model:'first-model',effort:'low'},{model:'second-model',effort:'low'}];
 const f=await realLenderFixture(t,{offers:true,run:{model:null,effort:null,model_efforts:pairs},mutateJob:job=>{
  job.expires_at=new Date(Date.parse(job.created_at)+3600000).toISOString().replace('.000Z','Z');
  job.requirements.harness=['codex'];job.requirements.model={any_of:['first-model','second-model']};job.requirements.capabilities=['budget_v1'];
  job.budget_v1={max_list_usd:2,effort:'low'};
 }});
 await f.client.heartbeat({boot:'different-tuple-test',seq:0,intent:{state:'ready'},execution:{state:'idle'},blockers:[],
  agents:[{adapter:'codex',readiness:'ready',models:['first-model','second-model'],per_job_max_minutes:2,model_efforts:[pairs[1]]}],
  capabilities:['budget_v1','model_effort_pairs_v1']});
 f.backend.requestStop=async()=>({compute_stopped:true});launch(t,f,async()=>true);
 await until(()=>f.events.some(e=>e.reason==='requirements_unsupported'),'mismatched heartbeat claim refused',8000);
 assert.equal((await f.owner.getJob(f.jobDigest)).attempts_started,0);
 assert.equal(f.calls.filter(([kind])=>kind==='run').length,0);
});

test('an accepted explicit tuple survives claim replay and reaches the executor',async t=>{
 const pair={model:'example-model',effort:'low'};
 const f=await realLenderFixture(t,{offers:true,run:{model:null,effort:null,model_efforts:[pair]},mutateJob:job=>{
  job.expires_at=new Date(Date.parse(job.created_at)+3600000).toISOString().replace('.000Z','Z');
  job.requirements.harness=['codex'];job.requirements.model={any_of:[pair.model]};job.requirements.capabilities=['budget_v1'];
  job.budget_v1={max_list_usd:2,effort:pair.effort};
 }});
 await f.client.heartbeat({boot:'replay-tuple-test',seq:0,intent:{state:'ready'},execution:{state:'idle'},blockers:[],
  agents:[{adapter:'codex',readiness:'ready',models:[pair.model],per_job_max_minutes:2,model_efforts:[pair]}],capabilities:['budget_v1','model_effort_pairs_v1']});
 const report=f.backend.lenderCapabilities(),advertisement={harnesses:['codex'],models:[pair.model],capabilities:['budget_v1','model_effort_pairs_v1'],
  egress:report.egress,enforced_limits:report.enforced_limits,max_limits:report.max_limits,model_efforts:[{harness:'codex',...pair}]};
 const intent={jobDigest:f.jobDigest,advertisement,leaseSeconds:120,idempotencyKey:'replay-pair',acceptedAt:f.clock.now()};
 const claim=await f.client.claimJob(f.jobDigest,advertisement,{leaseSeconds:120,idempotencyKey:intent.idempotencyKey});
 await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,claimedPending:claim.attempt,acceptedClaim:{intent,claim:{...claim,acceptedHarness:'codex',automatic:false}}});
 f.backend.requestStop=async()=>({compute_stopped:true});let entrypoint;const start=f.backend.start;
 f.backend.start=async(handle,opts)=>{if(handle._entrypoint.includes('model_reasoning_effort='))entrypoint=handle._entrypoint;return start(handle,opts);};
 launch(t,f,()=>assert.fail('accepted replay must not ask again'));
 await until(()=>f.calls.some(([kind])=>kind==='run'),'replayed tuple execution',8000);
 assert.match(entrypoint,/example-model/);assert.match(entrypoint,/model_reasoning_effort=low/);
});

for(const code of ['resources_incomplete','stop_bound_unknown'])for(const offers of [true,false])test(`passing preparation decline returns after readiness recovers: ${code} (offers=${offers})`,async t=>{
 const f=await realLenderFixture(t,{offers});
 // HTTP long polls use real timers; the exclusion boundary uses the fixture clock.
 const listOffers=f.client.listOffers.bind(f.client);
 f.client.listOffers=options=>listOffers({...options,waitSeconds:0});
 const claimNext=f.client.claimNext.bind(f.client);
 f.client.claimNext=(advertisement,options)=>claimNext(advertisement,{...options,waitSeconds:0});
 const prepare=f.backend.prepare;let prepares=0,asks=0;
 f.backend.prepare=async(...args)=>{
  if(++prepares===1)throw Object.assign(new Error('not proven yet'),{code});
  return prepare(...args);
 };
 launch(t,f,()=>{asks++;return true;});
 await until(()=>f.events.some(e=>e.status==='declined'&&e.reason===code),'passing decline');
 await until(()=>!f.saved()?.acceptedClaim&&!f.saved()?.claimedPending&&!f.saved()?.pending,'decline cleanup');
 const waiting=await f.owner.getJob(f.jobDigest);
 assert.equal(waiting.attempts_started,0);
 assert.match(jobStatusContract(waiting).explanation,/ready to try again/);
 const declinedAt=f.clock.now();
 f.clock.advance(299000);await new Promise(r=>setTimeout(r,50));
 assert.equal(prepares,1,'the structural cause cannot reclaim within five minutes');
 assert.equal(f.saved().declined.find(row=>row.jobDigest===f.jobDigest).expiresAt,declinedAt+300000);
 for(let n=0;n<10&&!f.events.some(e=>e.status==='finished');n++){f.clock.advance(1000);await new Promise(r=>setTimeout(r,50));}
 await until(()=>f.events.some(e=>e.status==='finished'),'job reoffered and finished',8000);
 assert.equal(prepares,2);assert.equal(asks,2);
 assert.equal(f.calls.filter(([kind])=>kind==='run').length,1);
 assert.equal((await f.owner.getJob(f.jobDigest)).attempts_started,1);
});

async function heldAcceptedJob(t,{expiresAt}={}) {
 const f=await realLenderFixture(t,{offers:true,run:{model:'example-model'},
  ...(expiresAt?{mutateJob:job=>{job.expires_at=expiresAt;}}:{})});
 const claims=()=>f.realRequests.filter(row=>row.url.endsWith('/claim')).length;
 let held=true,asks=0,reason='adapter_frozen';
 const checks=[],readiness=[],lenderCapabilities=f.backend.lenderCapabilities;
 f.backend.lenderCapabilities=options=>{readiness.push(options?.cached===true);return lenderCapabilities(options);};
 f.policy.lendingRuntime.candidate.gate=async args=>{
  if(args.job&&claims()>0){checks.push(args);return held?declineCodeFor(reason):null;}
  return null;
 };
 launch(t,f,()=>{asks++;return true;});
 await until(()=>f.saves.some(row=>row.acceptedClaim&&!row.claimedPending),'accepted job retained after candidate hold',8000);
 return {f,claims,checks,readiness,asks:()=>asks,clear:()=>{held=false;},refuse:code=>{reason=code;}};
}

test('an accepted job waits through a candidate pause and resumes after it clears',async t=>{
 const {f,claims,checks,readiness,asks,clear}=await heldAcceptedJob(t);
 const before=readiness.length,requests=f.realRequests.length;
 await polls(f,5);
 assert.equal(claims(),1,'the held accepted job must not be claimed again');
 assert.equal(f.realRequests.length,requests,'waiting must not contact the host');
 assert.equal(asks(),1);
 assert.ok(f.saved().acceptedClaim,'candidate holds preserve the accepted job');
 assert.ok(checks.length>=5,'the candidate is checked on the poll ticks');
 assert.ok(checks.every(args=>args.jobId===f.jobDigest&&args.model==='example-model'&&args.automatic===false));
 assert.ok(readiness.slice(before).length>=5);
 assert.ok(readiness.slice(before).every(cached=>cached),'waiting uses cached sandbox readiness');
 clear();f.clock.advance(1000);
 await until(()=>f.events.some(e=>e.status==='finished'),'accepted job finishes after candidate clears',8000);
 assert.equal(claims(),2,'clearing the gate permits one new claim');
 assert.equal(asks(),1,'the person is not asked again');
 assert.equal(f.calls.filter(([kind])=>kind==='run').length,1);
});

test('an accepted job expires while its candidate stays paused without another claim',async t=>{
 const expiresAt='2026-10-09T12:10:00Z';
 const {f,claims}=await heldAcceptedJob(t,{expiresAt});
 await polls(f,3);
 const before=claims();
 f.clock.advance(Date.parse(expiresAt)-f.clock.now());
 await until(()=>f.saved()?.acceptedClaim===null,'expired acceptance cleared',8000);
 assert.equal(claims(),before,'expiry must be checked before another host claim');
 assert.equal(claims(),1,'a candidate hold permits no further claims before expiry');
 assert.ok(f.events.some(e=>e.reason==='job_expired'));
 await polls(f,2);
 assert.equal(claims(),before,'expired accepted work must stay unclaimed');
 assert.equal(f.calls.filter(([kind])=>kind==='run').length,0);
});

test('an accepted job held by a limit that refuses before the expiry check is dropped at expiry',async t=>{
 const expiresAt='2026-10-09T12:10:00Z';
 const {f,claims,clear}=await heldAcceptedJob(t,{expiresAt});
 clear();const hold=f.policy.hold;
 f.policy.hold=(job,...rest)=>job?'sandbox_not_ready':hold?.(job,...rest)??null;
 await polls(f,3);
 assert.equal(claims(),1,'a passing hold waits without a claim');
 assert.ok(f.saved().acceptedClaim,'the acceptance is kept while the hold lasts');
 f.clock.advance(Date.parse(expiresAt)-f.clock.now());
 await until(()=>f.saved()?.acceptedClaim===null,'expired acceptance cleared behind a hold',8000);
 assert.equal(claims(),1);
});

test('an accepted job whose candidate refuses for a lasting reason is claimed once and declined, not held',async t=>{
 const {f,claims,refuse}=await heldAcceptedJob(t);
 await polls(f,2);
 assert.equal(claims(),1);
 refuse('model_not_lendable');f.clock.advance(1000);
 await until(()=>f.saved()?.acceptedClaim===null&&f.saved()?.claimedPending===null&&claims()===2,'lasting refusal declines the accepted job',8000);
 await polls(f,3);
 assert.equal(claims(),2,'a declined job is not claimed again');
 assert.equal(f.calls.filter(([kind])=>kind==='run').length,0);
});

for(const code of ['approval_denied','unknown_refusal'])test(`lasting preparation decline stays excluded: ${code}`,async t=>{
 const f=await realLenderFixture(t,{offers:true});let prepares=0,asks=0;
 f.backend.prepare=async()=>{prepares++;throw Object.assign(new Error(code),{code});};
 launch(t,f,()=>{asks++;return true;});
 await until(()=>f.events.some(e=>e.status==='preparation-failed'),'lasting decline cleanup');
 for(let n=0;n<10;n++){f.clock.advance(1000);await new Promise(r=>setTimeout(r,20));}
 assert.equal(prepares,1);assert.equal(asks,1);
 assert.equal(f.calls.filter(([kind])=>kind==='run').length,0);
});

test('an accepted offer held for unknown identity is released and not claimed again',async t=>{
 const f=await realLenderFixture(t,{offers:true});
 const answer=deferred();let card,asks=0,claims=0,scans=0,returned=0;
 const claim=f.client.claimJob.bind(f.client),list=f.client.listOffers.bind(f.client);
 f.client.claimJob=async(...args)=>{claims++;return claim(...args);};
 f.client.listOffers=async function*(options={}){
  for await(const view of list({...options,waitSeconds:0,since:undefined})){
   if(view.job_digest===f.jobDigest)returned++;
   yield view;
  }
  scans++;
 };
 f.policy.lendingRuntime.candidate.gate=async({job})=>job?'identity_unknown':null;
 launch(t,f,input=>{asks++;card=input;return answer.promise;});
 await until(()=>card,'offer ready for owner approval');
 assert.equal(card.offer,true);assert.equal(claims,0);
 answer.resolve(true);
 await until(()=>f.events.some(e=>e.status==='declined'&&e.reason==='identity_unknown'),
  'accepted job released for unknown identity');
 await until(()=>f.saved()?.hiddenOffers?.some(e=>e.jobDigest===f.jobDigest)&&f.clock.pending().includes(3000),
  'held job excluded before the next scan');
 assert.equal(claims,1);
 assert.ok(f.saved().declined.some(e=>e.jobDigest===f.jobDigest&&e.expiresAt>f.clock.now()));
 const view=await f.owner.getJob(f.jobDigest);
 assert.equal(view.state,'queued');assert.equal(view.current_attempt.state,'released');
 assert.equal(JSON.parse(view.current_attempt.reason).code,'identity_unknown');
 const beforeReturned=returned;
 for(let n=0;n<3;n++){
  const before=scans;
  f.clock.advance(n===0?3001:1000);
  await until(()=>scans>before&&f.clock.pending().includes(1000),'another completed offer scan',5000);
 }
 assert.ok(returned>=beforeReturned+3,'the released job remained visible in the queue');
 assert.equal(claims,1,'a held job must not be claimed again');
 assert.equal(asks,1,'a held job must not prompt again');
 assert.equal(f.calls.filter(([kind])=>kind==='run').length,0);
 await f.stop();
});
test('a failed named claim retains HTTP retry information for the approval card',async t=>{
 const f=await lenderFixture(t,{offers:true});offers(f);let outcome;
 f.client.claimJob=async()=>{throw Object.assign(new Error('offline'),{code:'http_error',status:502,retryable:true,claimRejected:true});};
 launch(t,f,input=>{input.claimResult.then(value=>{outcome=value;});return true;});
 await until(()=>outcome,'claim failure delivered to the approval card');
 assert.equal(outcome.code,'http_error');assert.equal(outcome.status,502);assert.equal(outcome.retryable,true);
 assert.equal(f.calls.length,0,'an unconfirmed claim never starts the sandbox');
});

for(const ownerOnly of [false,true])test(`discovery failures back off and reset after a successful poll (${ownerOnly?'owner':'shared'})`,async t=>{
 const f=await lenderFixture(t,{offers:true});offers(f);
 if(ownerOnly){f.policy.ownKeyId=f.job.payload.author;f.adapters.forEach(a=>{a.spec={...a.spec,auth_strategy:'provider-file-generation'};});}
 let polls=0,succeed=false;
 f.client.listOffers=async function*(){polls++;if(!succeed)throw Object.assign(new Error('offline'),{code:'network_error'});};
 const lender=launch(t,f,async()=>true);
 for(const delay of [1000,2000,4000,8000,16000,30000,30000]){
   await until(()=>f.clock.pending().includes(delay),'failure timer');
   const before=polls;
   f.clock.advance(delay-1);await new Promise(r=>setImmediate(r));assert.equal(polls,before,'no early poll');
   f.clock.advance(1);await until(()=>polls===before+1,'next poll');
 }
 await until(()=>f.clock.pending().includes(30000),'capped timer');
 succeed=true;f.clock.advance(30000);await until(()=>f.clock.pending().includes(1000),'normal idle after success');
 succeed=false;const before=polls;f.clock.advance(1000);await until(()=>polls===before+1&&f.clock.pending().includes(1000),'reset failure timer');
 lender.reconfigure();await until(()=>polls===before+2&&f.clock.pending().includes(2000),'local change wakes the delay');
 await f.stop();assert.deepEqual(f.clock.pending(),[],'abort removes the timer');
 assert.equal(f.calls.length,0);
});

test('discovery honors a longer Retry-After and abort cancels the wait',async t=>{
 const f=await lenderFixture(t,{offers:true});offers(f);let polls=0;
 f.client.listOffers=async function*(){polls++;throw Object.assign(new Error('busy'),{code:'rate_limited',retryAfterSeconds:45});};
 launch(t,f,async()=>true);await until(()=>f.clock.pending().includes(45000),'server delay');
 f.clock.advance(44999);await new Promise(r=>setImmediate(r));assert.equal(polls,1);
 await f.stop();f.clock.advance(60000);assert.equal(polls,1);assert.deepEqual(f.clock.pending(),[]);
});

test('uncertain claims back off with identical intent until acknowledgement',async t=>{
 const f=await lenderFixture(t,{offers:true});offers(f);const claim=f.client.claimJob,seen=[];let acknowledge=false;
 f.client.claimJob=async(digest,body,options)=>{
   if(seen.length)assert.equal(f.events.at(-1).status,'accepting','replay keeps the pending acceptance visible');
   seen.push(structuredClone({digest,body,leaseSeconds:options.leaseSeconds,idempotencyKey:options.idempotencyKey}));
   if(!acknowledge)throw Object.assign(new Error('offline'),{code:'network_error'});
   return claim(digest,body,options);
 };
 launch(t,f,async()=>true);
 for(const delay of [1000,2000,4000]){
   await until(()=>f.events.at(-1)?.status==='accepting'&&f.clock.pending().includes(delay),'claim failure timer');
   assert.equal(f.events.at(-1).status,'accepting');assert.equal(f.calls.length,0,'no unacknowledged execution');
   const before=seen.length;f.clock.advance(delay-1);await new Promise(r=>setImmediate(r));assert.equal(seen.length,before);
   f.clock.advance(1);await until(()=>seen.length===before+1,'claim replay');
 }
 await until(()=>f.clock.pending().includes(8000),'next claim delay');
 for(const intent of seen)assert.deepEqual(intent,seen[0]);
 acknowledge=true;f.clock.advance(8000);await until(()=>f.events.some(e=>e.status==='finished'),'acknowledged job finishes');
 assert.deepEqual(seen.at(-1),seen[0]);assert.equal(f.calls.filter(([kind])=>kind==='run').length,1);
});

// An offer that leaves the review without the person's answer stays available: it is not hidden, the error log names
// the cause and the step, and the next offer poll shows the card again. Only a Skip or an expired card hides it.
for(const [label,stage,code,arrange] of [
 ['the prompt read fails','prompt','network_error',f=>{const read=f.client.fetchArtifact;let failed=false;
   f.client.fetchArtifact=async(...a)=>{if(!failed){failed=true;throw Object.assign(new Error('offline'),{code:'network_error'});}return read(...a);};
   return async()=>true;}],
 ['the review throws','approval','internal_error',()=>{let n=0;return async()=>{if(++n===1)throw new Error('review failed');return true;};}],
 ['lending changed before the card was shown','approval','approval_changed',()=>{let n=0;return async()=>++n===1?{withdrawn:true,code:'approval_changed'}:true;}],
])test('an offer comes back when '+label,async t=>{
 const f=await lenderFixture(t,{offers:true});offers(f);const approve=arrange(f),diagnostics=[];let cards=0;
 const c=new AbortController(),lender=createLender({client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock,
  approve:async input=>{cards++;return approve(input);},onEvent:e=>f.events.push(e),onDiagnostic:e=>diagnostics.push(e)});
 const loop=lender.start(c.signal);f.stop=async()=>{c.abort();await loop;};
 // The failed review ends the open-offer loop; the discovery loop's one-second pause then reads the offers again.
 await until(()=>{if(f.clock.pending().includes(1000))f.clock.advance(1000);return f.events.some(e=>e.status==='finished');},'the returned offer runs');
 assert.equal(cards,stage==='prompt'?1:2,'the card is shown again');
 assert.ok(!f.saved()?.hiddenOffers?.some(row=>row.jobDigest===f.jobDigest),'the offer is not hidden');
 const reported=diagnostics.filter(e=>e.job===f.jobDigest&&e.phase==='before_claim');
 assert.deepEqual(reported.map(e=>[e.code,e.details?.stage]),[[code,stage]]);
});

for(const transient of [true,false])test('Skip stays hidden and is saved after '+(transient?'one failed write':'storage recovers'),async t=>{
 const f=await lenderFixture(t,{offers:true});offers(f);
 const set=f.policy.storage.set;let failed=false,recovered=false,scans=0,cards=0;
 f.policy.storage.set=async value=>{
  if(value?.hiddenOffers?.length&&!recovered){failed=true;if(transient)recovered=true;throw new Error('disk full');}
  return set(value);
 };
 const list=f.client.listOffers;
 f.client.listOffers=async function*(...args){scans++;yield* list(...args);};
 launch(t,f,async()=>{cards++;return cards===1?false:true;});
 await until(()=>failed,'hide write failed');
 const before=scans;
 await until(()=>{if(f.clock.pending().includes(1000))f.clock.advance(1000);return scans>=before+3;},'discovery continues while storage fails');
 assert.equal(cards,1);assert.equal(f.count('/jobs/claim-next'),0);
 assert.equal(f.calls.filter(([kind])=>kind==='run').length,0);
 recovered=true;
 await until(()=>{if(f.clock.pending().includes(1000))f.clock.advance(1000);return f.saved()?.hiddenOffers?.some(row=>row.jobDigest===f.jobDigest);},'hide saved after storage recovers');
 assert.equal(cards,1);assert.equal(f.count('/jobs/claim-next'),0);
 assert.equal(f.calls.filter(([kind])=>kind==='run').length,0);
});


for(const retryAfterSeconds of [2147484,Infinity,NaN,-1])test('Retry-After timer is safe: '+retryAfterSeconds,async t=>{
 const f=await lenderFixture(t,{offers:true});offers(f);
 f.client.listOffers=async function*(){throw Object.assign(new Error('busy'),{code:'rate_limited',retryAfterSeconds});};
 launch(t,f,async()=>true);
 const expected=retryAfterSeconds===2147484?2147483647:1000;
 await until(()=>f.clock.pending().includes(expected),'bounded failure delay');
 const delay=f.clock.pending().find(ms=>ms===expected);
 assert.ok(Number.isFinite(delay)&&delay<=2147483647);
 if(retryAfterSeconds===2147484)assert.ok(delay>=30000);
 await f.stop();assert.deepEqual(f.clock.pending(),[]);
});

test('a failed review returns while another offer card stays open',async t=>{
 const f=await lenderFixture(t,{offers:true});offers(f);
 const a={job_digest:f.jobDigest,job:f.job,state:'queued',published_at:'2026-10-09T12:00:00Z'};
 const b={...a,job_digest:'sha256:'+'e'.repeat(64)};
 f.client.listOffers=async function*(){yield a;yield b;};
 let aCards=0,bCards=0,claims=0;
 f.client.claimJob=async()=>{claims++;throw new Error('unexpected claim');};
 launch(t,f,input=>{
  if(input.jobDigest===b.job_digest){bCards++;return new Promise(()=>{});}
  if(++aCards===1)throw new Error('review failed once');
  return new Promise(()=>{});
 });
 await until(()=>aCards===1&&bCards===1&&f.clock.pending().includes(1000),'both cards opened');
 await new Promise(r=>setImmediate(r));assert.equal(aCards,1,'no immediate retry');
 for(let n=0;n<5&&aCards<2;n++)await polls(f,1);
 assert.equal(aCards,2);assert.equal(bCards,1);
 assert.equal(claims,0);assert.equal(f.calls.filter(([kind])=>kind==='run').length,0);
 assert.equal(f.saved()?.hiddenOffers?.length??0,0);
});

// The wall_seconds run clock starts at the protected agent handoff, not at preparation entry. Preparation has its own
// bounds (the preparation watchdog, the signed lease and the sandbox's own preparation cap).
test('the run clock starts at the agent handoff: a slow preparation does not spend the run budget',async t=>{
 const f=await lenderFixture(t,{offers:true,hold:true,mutateJob:job=>{job.requirements.limits.wall_seconds=30;}});offers(f);
 const boot=deferred();let prepareOptions=null;const original=f.backend.prepare;
 f.backend.prepare=async(spec,options)=>{prepareOptions=options;await boot.promise;return original(spec,options);};
 f.backend.cancel=async()=>({compute_stopped:true});f.backend.requestStop=async()=>({compute_stopped:true});
 launch(t,f,async()=>true);const stop=f.stop;f.stop=async()=>{boot.resolve();f.execution.resolve();await stop();};
 await until(()=>prepareOptions,'preparation started');
 assert.equal(prepareOptions.separatePreparationClock,true,'the executor asks for the separate preparation clock');
 const beforeHandoff=prepareOptions.wallRemainingMs();
 assert.ok(beforeHandoff>30_000,'before the handoff the cap is the lease, not the run budget: '+beforeHandoff);
 assert.ok(beforeHandoff<=120_000,'and never more than the lease');
 f.clock.advance(35_000);                       // preparation outlasts wall_seconds (30 s)
 boot.resolve();
 await until(()=>f.calls.some(([kind])=>kind==='run'),'the agent started after the slow preparation');
 assert.equal(f.events.some(e=>e.reason==='wall_timeout'),false,'the run budget was not spent by preparation');
 assert.ok(Math.abs(prepareOptions.wallRemainingMs()-30_000)<=1000,'the run clock is a fresh wall_seconds at the handoff: '+prepareOptions.wallRemainingMs());
 f.clock.advance(29_000);
 await new Promise(resolve=>setTimeout(resolve,50));
 assert.equal(f.events.some(e=>e.reason==='wall_timeout'),false,'still inside the run budget');
 f.clock.advance(2_000);
 await until(()=>f.events.some(e=>e.reason==='wall_timeout'||e.code==='wall_timeout'||e.status==='failed'),'the run budget ends 30 s after the handoff');
});
