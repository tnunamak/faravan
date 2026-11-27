import './helpers/no-browser.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {createLendingPool,parseChildId} from '../lib/v1/lending-pool.mjs';
import {openLendingAccounts} from '../lib/v1/lending-account-boot.mjs';
import {createAccountRegistry} from '../lib/v1/lending-accounts.mjs';
import {accountKey} from '../lib/v1/lending-account-key.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
function fixture(policy={}){let disk=null;const children=[];const storage={get:async()=>structuredClone(disk),set:async x=>{disk=structuredClone(x)},acquire:async()=>()=>{}};
 const factory=options=>{const s={options,state:{status:'idle',current:null,counters:null},start:async()=>{},pause(){},resume(){},cessation:()=>({proven:true}),getState(){return this.state},stopCurrentJob:async()=>{}};children.push(s);return s;};
 const pool=createLendingPool({storage,policy:{dailyJobs:3,dailyMinutes:60,timeZone:'UTC',...policy},createLender:factory,adapters:[{spec:{harness_id:'claude-code-subscription'}},{spec:{harness_id:'codex'}}],capacity:2});return {pool,children,disk:()=>disk};}
test('two account workers receive distinct adapters and one shared capacity gate',async()=>{
 const f=fixture();await f.pool.start();assert.equal(f.children.length,2);
 assert.deepEqual(f.children.map(c=>c.options.adapters[0].spec.harness_id),['claude-code-subscription','codex']);
 assert.equal(f.pool.getState().accountStates.length,2);
});
test('an already-running all-disabled pool admits one account after registry enable and reconfigure',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'lending-pool-wake-'));
 const controller=new AbortController();
 let running;
 try {
  const accounts=openLendingAccounts({directory,settings:()=>({})});
  const registry=accounts.registry();
  const chosen=registry.add({provider:'codex',label:'Synthetic chosen'});
  const sibling=registry.add({provider:'codex',label:'Synthetic sibling'});
  const job={author:'synthetic-requester'}, workers=[];
  let acquires=0,releases=0,finished=false,disk=null;
  const pool=createLendingPool({
   policy:{enabled:true,lendingPolicy:{accountSlots:1,machineSlots:1}},
   storage:{get:async()=>structuredClone(disk),set:async value=>{disk=structuredClone(value);},
    acquire:async()=>{acquires++;return ()=>{releases++;};}},
   accounts:()=>accounts.listForPool(),capacity:1,adapters:[{spec:{harness_id:'codex'}}],
   createLender:options=>{
    const row={key:options.accountKey,slot:options.accountSlot,starts:0};workers.push(row);
    return {start:signal=>{row.starts++;return new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));},
     getState:()=>({status:'idle'}),admits:offer=>options.policy.hold(offer,{})};
   },
  });
  assert.deepEqual(accounts.list().map(a=>a.enabled),[false,false]);
  running=pool.start(controller.signal);
  running.then(()=>{finished=true;},()=>{finished=true;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(finished,false,'all-disabled pool stays alive');
  assert.equal(acquires,1);assert.equal(releases,0);
  assert.equal(workers.length,0);
  assert.deepEqual(pool.getState().accountStates,[]);
  assert.equal(pool.admits(job),'lender_starting');

  assert.equal(registry.setEnabled(chosen.id,true).enabled,true);
  assert.equal(accounts.get(sibling.id).enabled,false);
  await pool.refreshAdmission();
  assert.equal(workers.length,0,'refreshAdmission only revisits existing workers');
  pool.reconfigure();
  const chosenKey=accounts.get(chosen.id).key;
  assert.deepEqual(workers,[{key:chosenKey,slot:0,starts:1}]);
  assert.equal(pool.admits(job),null);
  assert.equal(pool.getState().accountStates.length,1);
  pool.reconfigure();
  assert.equal(workers.length,1);
  assert.equal(pool.start(controller.signal),running,'reconfigure did not replace the loop');
  assert.equal(acquires,1);assert.equal(releases,0);
 }finally{
  controller.abort();
  try{await running;}finally{await rm(directory,{recursive:true,force:true});}
 }
});
test('a worker added during pool startup keeps the counter lock through abort and shutdown',{timeout:5000},async t=>{
 const controller=new AbortController(), finishWorker=Promise.withResolvers();
 const events=[], workers=[];
 let enabled=false, siblingEnabled=false;
 const wake=()=>{enabled=true;pool.reconfigure();};
 // Replay the fourth microtask after adapter discovery, as the empty startup drain would return.
 const scheduleWake=turns=>queueMicrotask(turns===1?wake:()=>scheduleWake(turns-1));
 const pool=createLendingPool({
  storage:{get:async()=>({accounts:{},ruleUsage:[],hiddenOffers:[]}),set:async()=>{},
   acquire:async()=>{events.push('lock acquired');return ()=>{events.push('lock released');};}},
  policy:{enabled:true,lendingPolicy:{accountSlots:1,machineSlots:2}},
  adapters:()=>{scheduleWake(4);return [{spec:{harness_id:'codex'}},{spec:{harness_id:'claude-code-subscription'}}];},
  accounts:()=>[{provider:'codex',key:'codex',enabled},{provider:'claude',key:'claude',enabled:siblingEnabled}],
  createLender:({accountKey})=>({
   getState:()=>({status:'idle',current:null}),
   async start(signal){
    workers.push(accountKey);
    events.push(accountKey+' started');
    if(!signal.aborted)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    events.push(accountKey+' saw abort');
    await finishWorker.promise;
    events.push(accountKey+' finished');
   },
  }),
 });
 t.after(()=>t.diagnostic(JSON.stringify({events,workers})));
 const running=pool.start(controller.signal);
 try {
  await new Promise(setImmediate);
  assert.deepEqual(workers,['codex']);
  assert.deepEqual(events,['lock acquired','codex started'],'the startup reconfigure keeps the original lock');
  controller.abort();
  siblingEnabled=true;
  pool.reconfigure();
  await new Promise(setImmediate);
  assert.deepEqual(workers,['codex'],'shutdown rejects new workers');
  assert.deepEqual(events,['lock acquired','codex started','codex saw abort'],'cleanup is still holding the lock');
 } finally {
  controller.abort();
  finishWorker.resolve();
  await running;
 }
 assert.deepEqual(events,['lock acquired','codex started','codex saw abort','codex finished','lock released']);
});
test('a durably disabled policy reports paused, including recovery before workers start',()=>{
 const pool=createLendingPool({policy:{enabled:false},storage:{},createLender:()=>{},adapters:[]});
 assert.equal(pool.getState().paused,true);
});
test('concurrent reservations serialize and cannot overspend global daily caps',async()=>{
 const f=fixture();await f.pool.start();const [a,b]=f.children.map(c=>c.options.policy.storage);
 await Promise.all([a.set({day:'2026-10-20',jobs:1,milliseconds:1200000,pending:{attemptId:'a'}}),b.set({day:'2026-10-20',jobs:1,milliseconds:1200000,pending:{attemptId:'b'}})]);
 assert.equal(f.disk().jobs,2);assert.equal(f.disk().milliseconds,2400000);
 await assert.rejects(b.set({day:'2026-10-20',jobs:2,milliseconds:3000000,pending:{attemptId:'c'}}),/daily_limit/);
 assert.equal(f.disk().milliseconds,2400000);
});
test('null daily caps allow pool reservations and admission after heavy daily use',async()=>{
 const f=fixture({dailyJobs:null,dailyMinutes:null});await f.pool.start();
 const store=f.children[0].options.policy.storage;
 await store.set({day:'2026-10-20',jobs:7,milliseconds:8*60*60*1000,pending:{attemptId:'uncapped'}});
 assert.equal(f.children[0].options.policy.hold({author:'friend'}),null);
 assert.equal(f.disk().jobs,7);
});
test('reconciliation returns unused wall reservation without dropping other account journal',async()=>{
 const f=fixture();await f.pool.start();const [a,b]=f.children.map(c=>c.options.policy.storage);
 await a.set({day:'2026-10-20',jobs:1,milliseconds:1200000,pending:{attemptId:'a'}});
 await b.set({day:'2026-10-20',jobs:1,milliseconds:1200000,pending:{attemptId:'b'}});
 await a.set({day:'2026-10-20',jobs:1,milliseconds:60000,pending:null});assert.equal(f.disk().milliseconds,1260000);assert.equal(f.disk().pending.attemptId,'b');
});
for(const first of ['cleanup','write'])test('a worker failure keeps the lock until both barriers finish: '+first,{timeout:5000},async()=>{
 let releases=0,cleaned=false,written=false,armWrite=false,index=0,writeTask;
 const writeEntered=Promise.withResolvers(),abortSeen=Promise.withResolvers();
 const cleanupGate=Promise.withResolvers(),writeGate=Promise.withResolvers(),cleanupDone=Promise.withResolvers();
 const original=new Error('worker_failure');
 const storage={get:async()=>null,set:async()=>{
   if(!armWrite)return;
   writeEntered.resolve();await writeGate.promise;written=true;
 },acquire:async()=>()=>{releases++;assert.ok(cleaned&&written,'release requires cleanup and durable write');}};
 const pool=createLendingPool({storage,policy:{dailyJobs:3,dailyMinutes:60},capacity:2,
  adapters:[{spec:{harness_id:'claude-code-subscription'}},{spec:{harness_id:'codex'}}],
  createLender:options=>({getState:()=>({}),start:async signal=>{
   if(index++===0){await writeEntered.promise;throw original;}
   const aborted=new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
   armWrite=true;
   writeTask=options.policy.storage.set({day:'2026-10-20',jobs:0,milliseconds:0});
   void writeTask.catch(writeEntered.reject);
   await aborted;abortSeen.resolve(signal.reason);
   await cleanupGate.promise;cleaned=true;cleanupDone.resolve();
  }})});
 const result=pool.start().then(()=>null,error=>error);
 try{
   assert.equal(await abortSeen.promise,original);
   assert.equal(releases,0);
   if(first==='cleanup'){cleanupGate.resolve();await cleanupDone.promise;}
   else {writeGate.resolve();await writeTask;}
   // Drain promise reactions without sleeping on a wall-clock deadline.
   await new Promise(setImmediate);
   assert.equal(releases,0,'one resolved barrier cannot release the lock');
 }finally{cleanupGate.resolve();writeGate.resolve();}
 assert.equal(await result,original);
 assert.equal(releases,1);
});
test('offer-accepted reaches the app with its own status, job, attempt, requester and account, even while another account runs',async()=>{
 const events=[];let disk=null;const children=[];
 const storage={get:async()=>structuredClone(disk),set:async x=>{disk=structuredClone(x)},acquire:async()=>()=>{}};
 const pool=createLendingPool({storage,policy:{dailyJobs:3,dailyMinutes:60},capacity:2,onEvent:e=>events.push(e),
  adapters:[{spec:{harness_id:'claude-code-subscription'}},{spec:{harness_id:'codex'}}],
  createLender:options=>{const s={options,start:async()=>{},getState:()=>s.state,state:{status:'running',current:'att-claude',currentRequester:'ana',jobDigest:'sha256:claude-job',requester:'ana',agent:'claude'}};children.push(s);return s;}});
 await pool.start();
 children[1].state={status:'idle',current:null};
 children[1].options.onEvent({status:'offer-accepted',jobDigest:'sha256:codex-job',attemptId:'att-codex',requester:'sam',current:null});
 const accepted=events.find(e=>e.status==='offer-accepted');
 assert.ok(accepted,'the accepted event is not renamed to the running account\'s status');
 assert.deepEqual({jobDigest:accepted.jobDigest,attemptId:accepted.attemptId,requester:accepted.requester,account:accepted.account},
  {jobDigest:'sha256:codex-job',attemptId:'att-codex',requester:'sam',account:'codex:0'});
 children[0].options.onEvent({status:'running',current:'att-claude'});
 assert.equal(events.at(-1).account,'claude:0','aggregated events say which account they came from');
});
function shared(initial=null,rules=[]){let disk=structuredClone(initial);const children=[];let time=Date.parse('2026-10-20T12:00:00Z');
 const storage={get:async()=>structuredClone(disk),set:async x=>{disk=structuredClone(x)},acquire:async()=>()=>{}};
 const pool=createLendingPool({storage,clock:{now:()=>time},policy:{dailyJobs:9,dailyMinutes:600,timeZone:'UTC',standingRules:rules},capacity:2,
  adapters:[{spec:{harness_id:'claude-code-subscription'}},{spec:{harness_id:'codex'}}],
  createLender:options=>{const s={options,start:async()=>{},getState:()=>({})};children.push(s);return s;}});
 return {pool,children,disk:()=>disk,stores:()=>children.map(c=>c.options.policy.storage),advance:ms=>{time+=ms;},now:()=>time};}
test('observation-only recovery adopts root-only work without installed adapters',async()=>{
 const intent={idempotencyKey:'observation-key',attempt:{attempt_id:'old'}};
 let disk={day:'2026-10-20',jobs:0,milliseconds:0,observationPending:[intent],accounts:{'codex:0':{jobs:0,milliseconds:0}}};
 const seen=[];
 const storage={get:async()=>structuredClone(disk),set:async value=>{disk=structuredClone(value);},acquire:async()=>()=>{}};
 const pool=createLendingPool({storage,policy:{enabled:false,recoveryOnly:true},adapters:[],
  createLender:options=>({start:async()=>{seen.push(await options.policy.storage.get());},getState:()=>({})})});
 await pool.start();
 assert.ok(seen.some(row=>row?.observationPending?.[0]?.idempotencyKey==='observation-key'));
 assert.equal(disk.observationPending[0].idempotencyKey,'observation-key');
});
test('recovery adopts a root journal absent from saved account summaries',async()=>{
 const pending={attemptId:'legacy-attempt',jobId:'legacy-job',reservedMs:60000};
 const f=shared({jobs:1,milliseconds:60000,pending,accounts:{'codex:0':{jobs:0,milliseconds:0,pending:null}}});
 await f.pool.start();
 const rows=await Promise.all(f.stores().map(store=>store.get()));
 assert.ok(rows.some(row=>row?.pending?.attemptId==='legacy-attempt'));
 assert.deepEqual(f.disk().pending,pending);
});
test('recovery preserves both root-only observations and other root journals',async()=>{
 const pending={attemptId:'legacy-attempt',jobId:'legacy-job',reservedMs:60000};
 const observation={idempotencyKey:'observation-key',attempt:{attempt_id:'old'}};
 const f=shared({jobs:1,milliseconds:60000,pending,observationPending:[observation],accounts:{'codex:0':{jobs:0,milliseconds:0,pending:null}}});
 await f.pool.start();
 const rows=await Promise.all(f.stores().map(store=>store.get()));
 assert.ok(rows.some(row=>row?.pending?.attemptId==='legacy-attempt'&&row?.observationPending?.[0]?.idempotencyKey==='observation-key'));
});
for(const pending of [null,{attemptId:'legacy-attempt',jobId:'legacy-job',reservedMs:60000}])
test('first boot and reopen keep registered slots separate from '+(pending?'legacy recovery':'a blank root'),async t=>{
 const dir=await mkdtemp(join(tmpdir(),'lending-pool-registry-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=join(dir,'accounts.json'),open=()=>createAccountRegistry({file});
 const registry=open();
 const first=registry.add({provider:'claude',label:'First'});
 const disabled=registry.add({provider:'claude',label:'Disabled'});
 const second=registry.add({provider:'claude',label:'Second'});
 registry.setEnabled(first.id,true);registry.setEnabled(second.id,true);
 const expected=[accountKey(first),accountKey(second)];
 assert.notEqual(expected[0],expected[1]);
 let disk={jobs:pending?1:0,milliseconds:pending?60000:0,pending};
 const storage={get:async()=>structuredClone(disk),set:async value=>{disk=structuredClone(value);},acquire:async()=>()=>{}};
 for(const phase of ['first boot','reopen']){
  const rows=[],records=open().list();
  assert.deepEqual(records.map(row=>[row.id,row.enabled]),[[first.id,true],[disabled.id,false],[second.id,true]]);
  const pool=createLendingPool({storage,policy:{lendingPolicy:{accountSlots:1,machineSlots:3}},capacity:3,
   accounts:()=>records,adapters:[{spec:{harness_id:'claude-code-subscription'}}],
   createLender:options=>({
    async start(){rows.push({key:options.accountKey,slot:options.accountSlot,stored:await options.policy.storage.get()});},
    getState:()=>({status:'idle',current:null}),
   })});
  await pool.start();
  // Worker construction order is the provider-local configured order, not completion order.
  const workerKeys=pool.getState().accountStates.map(row=>parseChildId(row.account).accountKey);
  assert.deepEqual(workerKeys,pending?[...expected,'claude']:expected,phase);
  assert.deepEqual(rows.filter(row=>expected.includes(row.key)).map(row=>row.slot),[0,0],phase);
  assert.equal(rows.filter(row=>row.stored?.pending?.attemptId===pending?.attemptId&&row.stored?.pending).length,pending?1:0,phase);
  if(pending)assert.deepEqual(rows.find(row=>row.key==='claude')?.stored?.pending,pending);
  assert.deepEqual(disk.pending,pending);
 }
});

test('hidden offers are one list for the whole computer: on the root, and seen by every account',async()=>{
 const f=shared();await f.pool.start();const [a,b]=f.stores();const until=f.now()+3600000;
 await a.set({...await a.get(),day:'2026-10-20',jobs:0,milliseconds:0,hiddenOffers:[{jobDigest:'x',expiresAt:until}]});
 assert.deepEqual(f.disk().hiddenOffers,[{jobDigest:'x',expiresAt:until}],'the app reads hidden offers from the root');
 const seen=await b.get();assert.deepEqual(seen.hiddenOffers,[{jobDigest:'x',expiresAt:until}],'the other account sees the hide');
 // b wrote from an older read that did not have 'x': a concurrent write never drops another account's hide.
 await b.set({day:'2026-10-20',jobs:0,milliseconds:0,hiddenOffers:[{jobDigest:'y',expiresAt:until}]});
 assert.deepEqual(f.disk().hiddenOffers.map(r=>r.jobDigest).sort(),['x','y']);
 assert.equal(f.disk().accounts['claude:0'].hiddenOffers,undefined,'kept once, on the root');
 f.advance(3600001);await a.set({...await a.get()});assert.deepEqual(f.disk().hiddenOffers,[],'expired hides are dropped');
});
test('an account with no counters of its own reads zero counters beside the shared hides, so its lender can start',async()=>{
 const f=shared();await f.pool.start();const [a,b]=f.stores();
 await a.set({...await a.get(),day:'2026-10-20',jobs:0,milliseconds:0,hiddenOffers:[{jobDigest:'x',expiresAt:f.now()+3600000}]});
 const seen=await b.get();
 assert.ok(Number.isSafeInteger(seen.jobs)&&Number.isSafeInteger(seen.milliseconds),'the lender refuses a read without counters');
 assert.equal(seen.jobs,0);assert.equal(seen.milliseconds,0);assert.equal(seen.pending,null);
 assert.deepEqual(seen.hiddenOffers.map(r=>r.jobDigest),['x']);
});
test('lists that older files kept per account are lifted to the root on start',async()=>{
 const until=Date.parse('2026-10-21T00:00:00Z');
 const f=shared({jobs:0,milliseconds:0,pending:null,accounts:{'claude:0':{day:'2026-10-20',hiddenOffers:[{jobDigest:'old-a',expiresAt:until}],ruleUsage:[{id:'r',jobDigest:'j0',acceptedAt:1,at:Date.parse('2026-10-20T11:00:00Z'),ms:60000}]},
  'codex:0':{day:'2026-10-20',hiddenOffers:[{jobDigest:'old-b',expiresAt:until}]}}});
 await f.pool.start();
 assert.deepEqual(f.disk().hiddenOffers.map(r=>r.jobDigest).sort(),['old-a','old-b']);
 assert.equal(f.disk().ruleUsage.length,1);
});
test('the root reports the newest requester limit any account hit',async()=>{
 const f=shared();await f.pool.start();const [a,b]=f.stores();
 await a.set({day:'2026-10-20',jobs:0,milliseconds:0,lastRequesterLimit:{circle:'c',keyId:'k1',day:'2026-10-20',at:'2026-10-20T11:00:00Z'}});
 await b.set({day:'2026-10-20',jobs:0,milliseconds:0,lastRequesterLimit:{circle:'c',keyId:'k2',day:'2026-10-20',at:'2026-10-20T11:30:00Z'}});
 assert.equal(f.disk().lastRequesterLimit.keyId,'k2');
 await b.set({day:'2026-10-20',jobs:0,milliseconds:0,lastRequesterLimit:null});
 assert.equal(f.disk().lastRequesterLimit.keyId,'k1');
});
test('one standing rule is one budget across accounts: the second account cannot reserve past its cap',async()=>{
 const rule={id:'r',dailyJobs:1,weeklyJobs:5,dailyMinutes:60,weeklyMinutes:600,maxWallSeconds:300};
 const f=shared(null,[rule]);await f.pool.start();const [a,b]=f.stores();
 await a.set({day:'2026-10-20',jobs:0,milliseconds:0,claimPending:{jobDigest:'j1',ruleId:'r',acceptedAt:f.now(),idempotencyKey:'k1'}});
 const view=await b.get();assert.ok(view.ruleUsage.some(e=>e.id==='r'&&e.reserved),'the other account sees the in-flight reservation');
 await assert.rejects(b.set({day:'2026-10-20',jobs:0,milliseconds:0,ruleUsage:view.ruleUsage,claimPending:{jobDigest:'j2',ruleId:'r',acceptedAt:f.now(),idempotencyKey:'k2'}}),{code:'rule_limit'});
 assert.equal(f.disk().accounts['codex:0']?.claimPending??null,null);
 // a's claim lands: the reservation becomes a usage entry, which still fills the rule.
 await a.set({day:'2026-10-20',jobs:0,milliseconds:0,claimPending:null,acceptedClaim:{intent:{jobDigest:'j1'}},ruleUsage:[{id:'r',jobDigest:'j1',acceptedAt:f.now(),at:f.now(),ms:120000}]});
 assert.deepEqual(f.disk().ruleUsage.map(e=>e.jobDigest),['j1']);
 assert.ok(!f.disk().ruleUsage.some(e=>e.reserved),'reservations shown to workers are never stored');
 await assert.rejects(b.set({day:'2026-10-20',jobs:0,milliseconds:0,claimPending:{jobDigest:'j2',ruleId:'r',acceptedAt:f.now(),idempotencyKey:'k2'}}),{code:'rule_limit'});
 // A rule-free claim and the next day are not limited by it.
 await b.set({day:'2026-10-20',jobs:0,milliseconds:0,claimPending:{jobDigest:'j3',ruleId:null,acceptedAt:f.now(),idempotencyKey:'k3'}});
 f.advance(86400000);
 await b.set({day:'2026-10-21',jobs:0,milliseconds:0,claimPending:{jobDigest:'j2',ruleId:'r',acceptedAt:f.now(),idempotencyKey:'k4'}});
});
test('an uncapped standing rule allows reservation and recorded usage across accounts',async()=>{
 const rule={id:'uncapped',dailyJobs:null,weeklyJobs:null,dailyMinutes:null,weeklyMinutes:null,maxWallSeconds:1200};
 const f=shared(null,[rule]);await f.pool.start();const [a,b]=f.stores();
 const intent={jobDigest:'j1',ruleId:'uncapped',acceptedAt:f.now(),wallSeconds:1200};
 await a.set({day:'2026-10-20',jobs:1,milliseconds:8*60*60*1000,claimPending:intent});
 assert.ok((await b.get()).ruleUsage.some(e=>e.id==='uncapped'&&e.reserved));
 await a.set({day:'2026-10-20',jobs:1,milliseconds:8*60*60*1000,claimPending:null,
  ruleUsage:[{id:'uncapped',jobDigest:'j1',acceptedAt:f.now(),at:f.now(),ms:1200000}]});
 assert.deepEqual((await b.get()).ruleUsage.filter(e=>e.id==='uncapped').map(e=>e.jobDigest),['j1']);
});
test('a legacy claim with unknown duration fails closed against an uncapped wall-time rule',async()=>{
 const acceptedAt=Date.parse('2026-10-20T11:00:00Z'),rule={id:'uncapped-wall',dailyJobs:null,weeklyJobs:null,dailyMinutes:60,weeklyMinutes:600,maxWallSeconds:null};
 const initial={jobs:0,milliseconds:0,pending:null,accounts:{'claude:0':{day:'2026-10-20',jobs:0,milliseconds:0,
  claimPending:{ruleId:rule.id,jobDigest:'legacy',acceptedAt,idempotencyKey:'old'}}}};
 const f=shared(initial,[rule]);await f.pool.start();
 const reserved=(await f.stores()[1].get()).ruleUsage.find(row=>row.jobDigest==='legacy');
 assert.equal(reserved.ms,Number.MAX_SAFE_INTEGER,'unknown legacy duration reserves conservatively');
 await assert.rejects(f.stores()[1].set({day:'2026-10-20',jobs:0,milliseconds:0,
  claimPending:{ruleId:rule.id,jobDigest:'next',acceptedAt:acceptedAt+1,idempotencyKey:'new'}}),{code:'rule_limit'});
});
test('a legacy claim-next rule entry is capped the same way before the agent runs',async()=>{
 const rule={id:'r',dailyJobs:1,weeklyJobs:5,dailyMinutes:60,weeklyMinutes:600,maxWallSeconds:300};
 const f=shared(null,[rule]);await f.pool.start();const [a,b]=f.stores();
 await a.set({day:'2026-10-20',jobs:0,milliseconds:0,ruleUsage:[{id:'r',attemptId:'att-a',at:f.now(),ms:120000}]});
 await assert.rejects(b.set({day:'2026-10-20',jobs:0,milliseconds:0,ruleUsage:[{id:'r',attemptId:'att-b',at:f.now(),ms:120000}]}),{code:'rule_limit'});
});

test('replaying a kept acceptance counts one rule use and holds the actual job duration',async()=>{
 const rule={id:'r',dailyJobs:1,weeklyJobs:5,dailyMinutes:20,weeklyMinutes:600,maxWallSeconds:1800};
 const f=shared(null,[rule]);await f.pool.start();const [a,b]=f.stores();
 const intent={ruleId:'r',jobDigest:'j1',acceptedAt:f.now(),wallSeconds:1200};
 const usage=[{id:'r',jobDigest:'j1',acceptedAt:f.now(),at:f.now(),ms:1200000}];
 await a.set({jobs:0,milliseconds:0,ruleUsage:usage,acceptedClaim:{intent}});
 await a.set({jobs:0,milliseconds:0,ruleUsage:usage,claimPending:intent});
 assert.equal((await b.get()).ruleUsage.length,1,'the recorded acceptance replaces its claim reservation');
});

test('a claim reserves its job time instead of the rule maximum',async()=>{
 const rule={id:'r',dailyJobs:5,weeklyJobs:5,dailyMinutes:60,weeklyMinutes:600,maxWallSeconds:1800};
 const f=shared(null,[rule]);await f.pool.start();const [a,b]=f.stores();
 await a.set({jobs:0,milliseconds:0,ruleUsage:[{id:'r',jobDigest:'old',acceptedAt:f.now()-1,at:f.now(),ms:2400000}]});
 await b.set({jobs:0,milliseconds:0,claimPending:{ruleId:'r',jobDigest:'new',acceptedAt:f.now(),wallSeconds:1200}});
 assert.equal((await a.get()).ruleUsage.find(e=>e.reserved).ms,1200000);
});
// Dot review of judge r10's readiness: "ready" must count the machine's CPU and memory as a reservation does, so a
// computer whose running job leaves too little room for the next one does not read as ready.
test('admission counts the machine CPU and memory like a reservation does',async()=>{
 let disk=null;const children=[],hang=new Promise(()=>{});
 const storage={get:async()=>structuredClone(disk),set:async x=>{disk=structuredClone(x)},acquire:async()=>()=>{}};
 const factory=options=>{const s={options,start:()=>hang,pause(){},resume(){},cessation:()=>({proven:true}),getState(){return {status:'idle',current:null,counters:null};},stopCurrentJob:async()=>{},admits:()=>null};children.push(s);return s;};
 const pool=createLendingPool({storage,policy:{dailyJobs:3,dailyMinutes:60,timeZone:'UTC'},createLender:factory,capacity:2,
  maxResources:{cpu:4,memoryBytes:16*1024**3},adapters:[{spec:{harness_id:'claude-code-subscription'}},{spec:{harness_id:'codex'}}]});
 pool.start();
 for(let i=0;i<50&&children.length<2;i++)await new Promise(r=>setImmediate(r));
 const job=cpu=>({author:'someone',requirements:{limits:{wall_seconds:60,cpu,memory_bytes:1024**3}},expires_at:'2999-01-01T00:00:00Z'});
 assert.equal(pool.admits(job(2)),null);
 await children[0].options.policy.storage.set({day:'2026-10-20',jobs:1,milliseconds:60000,pending:{attemptId:'a',resources:{cpu:3,memoryBytes:1024**3}}});
 assert.equal(pool.admits(job(2)),'machine_capacity','3 + 2 CPUs do not fit in 4');
 assert.equal(pool.admits(job(1)),null);
});

// Two account workers read the same 600 s standing-rule hold. A settles it to its 60 s use and saves. B then saves an unrelated
// change from its stale read. B's copy of the hold must not restore the refunded time, now or after a restart.
test('a stale sibling snapshot does not restore a refunded standing-rule hold',async()=>{
 const rule={id:'r',dailyJobs:9,weeklyJobs:9,dailyMinutes:600,weeklyMinutes:600,maxWallSeconds:600};
 const f=shared(null,[rule]);await f.pool.start();const [a,b]=f.stores();
 const hold={id:'r',attemptId:'att-1',jobDigest:'j1',acceptedAt:f.now(),at:f.now(),ms:600000,finished:false};
 await a.set({day:'2026-10-20',jobs:1,milliseconds:600000,ruleUsage:[hold]});
 const aView=await a.get(),bView=await b.get();
 assert.ok(bView.ruleUsage.some(e=>e.attemptId==='att-1'&&e.ms===600000));
 await a.set({day:'2026-10-20',jobs:1,milliseconds:60000,ruleUsage:[{...hold,ms:60000,finished:true}]});
 await b.set({day:'2026-10-20',jobs:0,milliseconds:0,hiddenOffers:[{jobDigest:'x',expiresAt:f.now()+3600000}],ruleUsage:bView.ruleUsage});
 const usage=f.disk().ruleUsage.filter(e=>e.id==='r');
 assert.deepEqual(usage.map(e=>[e.attemptId,e.ms]),[['att-1',60000]],'the refund survives the stale sibling write');
 assert.equal(f.disk().milliseconds,60000,'the daily time keeps the refund');
 assert.equal(aView.ruleUsage.find(e=>e.attemptId==='att-1').ms,600000);
 const restarted=shared(structuredClone(f.disk()),[rule]);await restarted.pool.start();
 assert.deepEqual(restarted.disk().ruleUsage.filter(e=>e.id==='r').map(e=>[e.attemptId,e.ms]),[['att-1',60000]],'the rule stays refunded after a restart');
 assert.equal(restarted.disk().milliseconds,60000);
});

// The converse: a stale write must not drop or shrink a reservation that another worker made or extended after its read.
test('a stale sibling write does not drop or shrink a reservation made after its read',async()=>{
 const rule={id:'r',dailyJobs:9,weeklyJobs:9,dailyMinutes:600,weeklyMinutes:600,maxWallSeconds:600};
 const f=shared(null,[rule]);await f.pool.start();const [a,b]=f.stores();
 await a.set({day:'2026-10-20',jobs:1,milliseconds:300000,ruleUsage:[{id:'r',attemptId:'att-1',jobDigest:'j1',acceptedAt:f.now(),at:f.now(),ms:300000,finished:false}]});
 const bView=await b.get();
 await a.set({day:'2026-10-20',jobs:2,milliseconds:900000,ruleUsage:[{id:'r',attemptId:'att-1',jobDigest:'j1',acceptedAt:f.now(),at:f.now(),ms:600000,finished:false},
  {id:'r',attemptId:'att-2',jobDigest:'j2',acceptedAt:f.now(),at:f.now(),ms:300000,finished:false}]});
 await b.set({day:'2026-10-20',jobs:0,milliseconds:0,hiddenOffers:[{jobDigest:'x',expiresAt:f.now()+3600000}],ruleUsage:bView.ruleUsage});
 assert.deepEqual(f.disk().ruleUsage.filter(e=>e.id==='r').map(e=>[e.attemptId,e.ms]).sort(),[['att-1',600000],['att-2',300000]]);
});
test('a standing-rule row whose agent never ran does not use up the rule in the pool',async()=>{
 const rule={id:'r',dailyJobs:1,weeklyJobs:5,dailyMinutes:60,weeklyMinutes:600,maxWallSeconds:300};
 const f=shared(null,[rule]);await f.pool.start();const [a,b]=f.stores();
 await a.set({day:'2026-10-20',jobs:0,milliseconds:0,ruleUsage:[{id:'r',jobDigest:'j1',acceptedAt:f.now(),at:f.now(),attemptId:'denied',ms:0,finished:true,ran:false}]});
 await b.set({day:'2026-10-20',jobs:0,milliseconds:0,claimPending:{jobDigest:'j2',ruleId:'r',acceptedAt:f.now(),idempotencyKey:'k2'}});
 await assert.rejects(a.set({day:'2026-10-20',jobs:0,milliseconds:0,claimPending:{jobDigest:'j3',ruleId:'r',acceptedAt:f.now(),idempotencyKey:'k3'}}),{code:'rule_limit'},
  'the one real job still fills the rule');
});

test('a running sibling does not hide another account recovery guidance',async()=>{
 const f=fixture();await f.pool.start();
 const command="env HOME='/synthetic' sbx rm --force wf-0123456789abcdef";
 f.children[0].state={status:'running',current:'running-attempt',label:'Running a job'};
 f.children[1].state={status:'stopping',current:null,remediation:[{name:'wf-0123456789abcdef',home:'/synthetic',command}]};
 assert.ok(f.pool.getState().label.includes(command));
});

test('a cleanup remediation without a command is written once in the pool label, top level and per account',async()=>{
 const f=fixture();await f.pool.start();
 const line='Faravan could not finish cleaning up after an earlier job. No new jobs start until it does. Choose Check again.';
 // The account's own label already carries the sentence, as the lender writes it.
 f.children[0].state={status:'stopping',current:null,label:'Stopping…\n'+line,remediation:[{name:'wf-0123456789abcdef',home:'/synthetic',reason:'cleanup_incomplete'}]};
 const state=f.pool.getState();
 assert.equal(state.label.split(line).length-1,1,'top-level label');
 assert.equal(state.accountStates[0].label.split(line).length-1,1,'account label');
});
