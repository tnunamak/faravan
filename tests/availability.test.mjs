import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {lenderDayKey} from '../lib/v1/lender.mjs';
import {createLender} from '../lib/v1/lender.mjs';
import {createLendingPool} from '../lib/v1/lending-pool.mjs';
import {createAccountExecution} from '../lib/v1/account-execution.mjs';
import {createAccountBroker} from '../lib/v1/account-broker.mjs';
import {createAccountStore} from '../lib/v1/accounts.mjs';
import {createAccountsApi} from '../lib/v1/accounts-http.mjs';
import {createHostProviderRegistry} from '../lib/v1/providers/host-registry.mjs';
import {LENDING_REASONS,giveBackCode} from '../lib/v1/lending-reasons.mjs';
import {syntheticProvider} from './helpers/synthetic-run-account.mjs';
import {lenderFixture,until} from './helpers/v1-lender-fixture.mjs';

// Production pool, lender, account store/broker, accounting and launch path. Only the circle host,
// provider, sandbox backend and clock are synthetic. No decision or execution method is replaced.
async function world(t,configure=async()=>{},options={}){
 const f=await lenderFixture(t,{requeueReleased:true,mutateJob:job=>{job.expires_at=new Date(Date.parse(job.created_at)+3*86400000).toISOString().replace('.000Z','Z');}});
 const store=createAccountStore({directory:join(f.root,'accounts')});
 const providers=createHostProviderRegistry({configurations:[syntheticProvider],proxyOrigin:()=> 'https://controlled.invalid',nativeDrivers:{},clock:f.clock.now});
 const broker=createAccountBroker({store,providers,clock:f.clock.now,proxy:{dispatch:async()=>({ok:false,error:{code:'not_used'}})},
  authority:{verify:async()=>({ok:true,value:{expiresAtMs:f.clock.now()+300000,fence:1}})}});
 const account={id:'fixture-account',providerId:'codex',label:'Synthetic',authState:'signed_in',enabled:true,generation:0,
  subjectId:'synthetic',expiresAtMs:null,modelOrder:['example-model'],modelPreferences:{'example-model':{enabled:true,effortIds:null}},secret:{key:'SYNTHETIC_KEY'}};
 await store.transaction(s=>{s.records[account.id]=account;});
 const settings={enabled:true,revision:1,strategy:'automatic',strategyParams:{},protectionPosition:'balanced'};
 const execution=createAccountExecution({directory:join(f.root,'launch'),store,providers,broker,settings:async()=>settings,clock:f.clock.now});
 const accounts=createAccountsApi({store,providers});
 const claimed=[],claimNext=f.client.claimNext.bind(f.client);
 // Fake-clock deadline checks cannot wait on the host's real-time long poll.
 f.client.claimNext=async(...args)=>{const at=f.clock.now(),claim=await claimNext(args[0],{...args[1],waitSeconds:0});if(claim)claimed.push({at,claim,advertisement:structuredClone(args[0])});return claim;};
 f.client.accountLease=async()=>({proof:{schemaVersion:1,signedEnvelope:'synthetic-lease'}});
 const prepare=f.backend.prepare.bind(f.backend);
 f.backend.prepareAccountRun=async spec=>Object.assign(await prepare(spec),{job_id:spec.job_id,_cleanupId:'synthetic-incarnation'});
 f.backend.inspect=async h=>({job_id:h.job_id,status:'exited'});
 f.backend.destroy=async h=>({removed:true,scratch_removed:true,storage_removed:true,policy_removed:true,job_id:h.job_id,sandbox_id:h.sandbox_id});
 const controller=new AbortController();
 let facts={runtime:{canStart:true},waits:[]};
 f.policy.observeLending=()=>facts;
 await configure({f,store,settings,setFacts:value=>{facts=value;}});
 const pool=createLendingPool({createLender:options.createLender??createLender,accounts:()=>options.poolAccounts??[{key:'codex',provider:'codex',enabled:true}],storage:f.policy.storage,policy:f.policy,adapters:f.adapters,client:f.client,backend:f.backend,
  runAccounts:()=>accounts.advertise(),accountExecution:execution,clock:f.clock,approve:options.approve??(async()=>true),onEvent:e=>f.events.push(e)});
 const run=pool.start(controller.signal);run.catch(()=>{});
 f.stop=async()=>{controller.abort();await run;};
 t.after(async()=>{await f.stop();await execution.close();await broker.close();});
 return {...f,store,pool,settings,claimed,setFacts:value=>{facts=value;},execution};
}

test('real pool starts the first offered account job',{timeout:60000},async t=>{
 const f=await world(t);
 await until(()=>f.calls.some(c=>c[0]==='run')||f.events.some(e=>['declined','failed','waiting_for_sandbox'].includes(e.status)),'first decision');
 assert.ok(f.calls.some(c=>c[0]==='run'),JSON.stringify(f.events.map(e=>[e.status,e.reason,e.label])));
 assert.equal(f.requests.filter(r=>r.route==='/jobs/claim-next').length,1);
});


const variants=['fresh','stale','cold','missing','identity_missing','reading_in_flight','cleanup_pending','listing_timeout',
 'circle_unreachable','outside_hours','daily_limit','requester_limit','approval_pending','app_updating',
 'lending_off','sandbox_cannot_start','account_signed_out','provider_limit_reached'];
const confirmed=new Set(['lending_off','sandbox_cannot_start','account_signed_out','provider_limit_reached']);
export const availabilityReasonCensus=new Set();

test('300 seeded mixes run through the real pool, re-decide at deadlines, and start their first job',{timeout:600000,concurrency:4},async t=>{
 let seed=0x54c0dd;
 const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
 const cases=Array.from({length:300},(_,i)=>({i,variant:variants[i%variants.length],age:random(30000),identityMissing:random(2)===0}));
 await Promise.all(cases.map(({i,variant,age,identityMissing})=>t.test('mix '+i+' '+variant,async t=>{
  let due,clear=()=>{};
  const f=await world(t,async({f,store,settings,setFacts})=>{
   due=f.clock.now()+120000;
   if(['fresh','stale','cold','missing','identity_missing','reading_in_flight'].includes(variant)){
    await store.transaction(s=>{
     const account=s.records['fixture-account'];
     if(identityMissing||variant==='identity_missing')delete account.subjectId;
     if(['fresh','stale'].includes(variant))account.usage={reading:{schemaVersion:1,accountId:account.id,observationId:'seed-'+i,sequence:i+1,
      observedAtMs:f.clock.now()-(variant==='stale'?age:0),windows:[{id:'seven_day',instance:'seed',capacityMicro:100000000,usedHiMicro:0,usedLoMicro:0,resetsAtMs:due+86400000,maxOwnerRateMicroPerMs:0}],coverage:{kind:'unknown'}},
      state:'ready',jobReadings:[],windowHistory:[],nextReadAtMs:null,limitResetAtMs:null};
     if(variant==='reading_in_flight')account.usage={reading:null,state:'reading',jobReadings:[],windowHistory:[],nextReadAtMs:due,limitResetAtMs:null};
    });
   }else if(['outside_hours','daily_limit','requester_limit'].includes(variant)){
    if(variant==='outside_hours'){
     f.policy.schedule={from:'12:05',to:'13:00',days:[0,1,2,3,4,5,6],weekends_all_day:false};f.policy.timeZone='UTC';due=f.clock.now()+180000;
     clear=()=>{f.policy.schedule=null;};
    }else{
     const day=lenderDayKey(f.clock.now(),f.policy.timeZone);
     const row={day,jobs:variant==='daily_limit'?1:0,milliseconds:0,pending:null,requesters:{}};
     if(variant==='daily_limit'){f.policy.dailyJobs=1;clear=()=>{f.policy.dailyJobs=10;};}
     else{f.policy.requesterLimits=[{circle:f.job.payload.circle,keyId:f.job.payload.author,dailyJobs:1,dailyMinutes:null}];
      row.requesters[JSON.stringify([f.job.payload.circle,f.job.payload.author])]={jobs:1,milliseconds:0};clear=()=>{f.policy.requesterLimits=[];setFacts({runtime:{canStart:true},waits:[]});};}
     await f.policy.storage.set({...row,accounts:{'codex:0':row}});
     let at=Math.floor(f.clock.now()/60000)*60000+60000;
     while(lenderDayKey(at,f.policy.timeZone)===day)at+=60000;due=at;
     if(variant==='requester_limit')setFacts({runtime:{canStart:true},waits:[{reason:'requester_limit',nextEvaluationAtMs:due}]});
    }
   }else if(confirmed.has(variant)){
    if(variant==='lending_off'){f.policy.enabled=false;clear=()=>{f.policy.enabled=true;};}
    if(variant==='sandbox_cannot_start'){setFacts({runtime:{canStart:false},waits:[]});clear=()=>setFacts({runtime:{canStart:true},waits:[]});}
    if(variant==='account_signed_out')await store.transaction(s=>{s.records['fixture-account'].authState='signed_out';});
    if(variant==='provider_limit_reached')await store.transaction(s=>{s.records['fixture-account'].usage={reading:null,jobReadings:[],windowHistory:[],state:'limit',limitResetAtMs:due,nextReadAtMs:due};});
   }else{
    const reason=variant==='listing_timeout'?'sandbox_check_pending':variant;
    setFacts({runtime:{canStart:true},waits:[{reason,nextEvaluationAtMs:due}]});
    clear=()=>setFacts({runtime:{canStart:true},waits:[]});
   }
  });
  const soft=!['fresh','stale','cold','missing','identity_missing','reading_in_flight'].includes(variant);
  if(soft){
   await until(()=>f.events.some(e=>e.reason),'initial hold or wait');
   const event=f.events.find(e=>e.reason);availabilityReasonCensus.add(event.reason);
   assert.ok(Object.hasOwn(LENDING_REASONS,event.reason),JSON.stringify(event));
   assert.equal(f.requests.filter(r=>r.route==='/jobs/claim-next').length,0,'blocked facts do not claim');
   if(!confirmed.has(variant))assert.ok(Number.isSafeInteger(event.until)&&event.until>f.clock.now(),'a wait has a future time');
   clear();
   await f.store.transaction(s=>{s.records['fixture-account'].authState='signed_in';delete s.records['fixture-account'].usage;});
   f.clock.advance(due-f.clock.now());
  }
  await until(()=>f.calls.some(c=>c[0]==='run')||f.events.some(e=>e.status==='declined'),'first offered job starts');
  assert.ok(f.calls.some(c=>c[0]==='run'),JSON.stringify(f.events.map(e=>[e.status,e.reason])));
  assert.equal(f.requests.filter(r=>r.route==='/jobs/claim-next').length,1,'first claim starts');
  for(const event of f.events)if(event.reason){availabilityReasonCensus.add(event.reason);assert.ok(Object.hasOwn(LENDING_REASONS,event.reason),event.reason);}
 })));
 assert.ok(availabilityReasonCensus.size>=12,'census covers the varied decisions');
});


test('post-claim reason census gives back without another claim in the same window',{timeout:120000,concurrency:4},async t=>{
 await Promise.all(['readiness_changed','standing_rule_changed','policy_unenforceable','limits_unenforceable','cleanup_pending',
  'preparation_timeout','cannot_run_here','requirements_unsupported'].map(code=>t.test(code,async t=>{
  let refused=true;
  const f=await world(t,async({f})=>{const admit=f.backend.admitJob.bind(f.backend);f.backend.admitJob=(...args)=>refused?{ok:false,code}:admit(...args);});
  await until(()=>f.requests.some(r=>r.route.endsWith('/release')),'post-claim give-back');
  const reason=JSON.parse(f.requests.find(r=>r.route.endsWith('/release')).body.reason);
  assert.equal(reason.code,giveBackCode(code));assert.ok(Object.hasOwn(LENDING_REASONS,reason.code));
  assert.ok(Number.isSafeInteger(reason.until)&&reason.until>f.clock.now());
  const promisedUntil=reason.until; // Immutable give-back history, independent of the live declined row.
  // Allow the released attempt's local bookkeeping and next idle poll to complete before moving time.
  await until(()=>f.events.some(e=>e.status==='declined'),'give-back completed');
  f.pool.reconfigure();
  await until(()=>f.requests.filter(r=>r.route==='/jobs/claim-next').length>=2,'released job excluded');
  assert.equal(f.requests.filter(r=>r.route==='/jobs/claim-next'&&!r.body.exclude?.includes(f.jobDigest)).length,1);
  assert.equal(f.calls.filter(c=>c[0]==='run').length,0);
  const polls=f.requests.filter(r=>r.route==='/jobs/claim-next').length;
  f.clock.advance(promisedUntil-f.clock.now()-1);f.pool.reconfigure();
  await until(()=>{f.pool.reconfigure();return f.requests.filter(r=>r.route==='/jobs/claim-next').length>polls;},'idle pass just before the promised time');
  assert.equal(f.claimed.length,1,'unchanged readiness cannot reclaim before the give-back promise');
  refused=false;f.clock.advance(1);f.pool.reconfigure();
  await until(()=>{f.pool.reconfigure();return f.calls.some(c=>c[0]==='run');},'deadline re-decides and starts');
  assert.equal(f.requests.filter(r=>r.route==='/jobs/claim-next'&&!r.body.exclude?.includes(f.jobDigest)).length,2);
  assert.ok(f.claimed[1].at>=promisedUntil,'the reclaim respects the promised time, even if its live row was cleared');
 })));
});

for(const finding of ['device','account'])test('a '+finding+' finding is shared at the right scope and sibling approval survives',{timeout:60000},async t=>{
 const workers=[],bKey='codex:00000000-0000-4000-8000-000000000002';let approvals=0,blocked=false,cached,invalidated=0,readinessChangedSince=false;
 const f=await world(t,async({f,store})=>{
  await store.transaction(s=>{const sibling={...structuredClone(s.records['fixture-account']),id:'sibling-account',secret:{key:'SYNTHETIC_SIBLING_KEY'}};delete sibling.secretRef;delete sibling.secretRefs;s.records['sibling-account']=sibling;});
  const capabilities=f.backend.lenderCapabilities.bind(f.backend),admit=f.backend.admitJob.bind(f.backend);
  f.backend.lenderCapabilities=()=>cached??=(blocked?{...capabilities(),available:false,reason:'host_disk_low'}:capabilities());
  f.backend.invalidateLendingCapabilities=()=>{cached=null;invalidated++;};
  let first=true;
  f.backend.admitJob=async(...args)=>{
   if(first){first=false;
    if(finding==='device'){blocked=true;return {ok:false,code:'host_disk_low'};}
    await store.transaction(s=>{s.records['fixture-account'].usage={reading:null,jobReadings:[],windowHistory:[],state:'limit',limitResetAtMs:f.clock.now()+120000,nextReadAtMs:f.clock.now()+120000};});
   }
   return admit(...args);
  };
 },{poolAccounts:[{key:'codex',provider:'codex',enabled:true},{key:bKey,provider:'codex',enabled:true}],
  createLender:options=>{const worker=createLender(options);workers.push(worker);if(workers.length===2)worker.pause();return worker;},
  approve:async()=>{approvals++;return true;}});
 await until(()=>f.requests.some(r=>r.route.endsWith('/release'))&&f.events.some(e=>e.status==='declined'),'A gives back');
 const released=JSON.parse(f.requests.find(r=>r.route.endsWith('/release')).body.reason),at=f.clock.now();
 const promisedUntil=released.until,firstWorker=f.events.find(e=>e.current===f.claimed[0].claim.attempt.attempt_id)?.account;
 assert.ok(firstWorker,'the original worker is recorded independently of its cooldown row');
 assert.ok(released.until>at);assert.ok(invalidated>0);
 assert.equal(f.requests.filter(r=>r.route==='/jobs/claim-next'&&!r.body.exclude?.includes(f.jobDigest)).length,1);
 workers[1].resume();workers[1].reconfigure();
 if(finding==='device'){
  await until(()=>f.events.some(e=>e.account===bKey+'#0'&&e.reason==='sandbox_cannot_start'),'B sees the shared device finding');
  const claims=f.requests.filter(r=>r.route==='/jobs/claim-next').length;
  f.clock.advance(1000);f.pool.reconfigure();
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(f.requests.filter(r=>r.route==='/jobs/claim-next').length,claims,'neither sibling claims any job while the device fact holds');
  assert.equal(f.calls.filter(c=>c[0]==='run').length,0);
  blocked=false;readinessChangedSince=true;f.backend.invalidateLendingCapabilities();f.pool.reconfigure();
 }
 await until(()=>{f.pool.reconfigure();return f.calls.some(c=>c[0]==='run');},'usable sibling starts');
 assert.ok(f.clock.now()<released.until,'B starts before A’s per-job not-before');
 assert.equal(approvals,1,'the job approval belongs to this computer');
 assert.equal(f.claimed.length,2,'only A and B took the job');
 const secondWorker=f.events.find(e=>e.current===f.claimed[1].claim.attempt.attempt_id)?.account;
 assert.ok(secondWorker,'the reclaiming worker is recorded');
 assert.ok(secondWorker!==firstWorker||f.claimed[1].at>=promisedUntil||readinessChangedSince,
  'the same worker needs the promised time or an observed readiness change since give-back');
 if(finding==='account'){
  assert.ok(f.events.some(e=>e.account===bKey+'#0'&&e.current===f.claimed[1].claim.attempt.attempt_id),'B owns the second claim');
  const claim=f.requests.filter(r=>r.route==='/jobs/claim-next'&&!r.body.exclude?.includes(f.jobDigest)).at(-1);
  assert.deepEqual(claim.body.advertisement.accounts.map(a=>a.accountId),['sibling-account']);
 }
});
