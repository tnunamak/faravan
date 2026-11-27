import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes, randomUUID} from 'node:crypto';
import {createSandboxCleanupJournal} from '../lib/sandbox-cleanup-journal.mjs';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import {DockerSbxBackend} from '../lib/docker-backend.mjs';
import {createLendingPool} from '../lib/v1/lending-pool.mjs';
import {api,waitFor} from './helpers/v1-app-fixture.mjs';

// The journal and the backend are real. Only the sbx daemon is absent: no test here creates a sandbox.
function fixture(t,{fences=40,home='/sbx/home-a'}={}) {
  const root=fs.mkdtempSync(join(tmpdir(),'d16-scan-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const directory=join(root,'journal');fs.mkdirSync(directory);
  const state={home,homeCalls:0,homeThrows:false,ownerCalls:0,ownerThrows:false};
  const journal=createSandboxCleanupJournal({directory,scratchRoot:()=>join(root,'scratch'),
    ownerScope:()=>{state.ownerCalls++;if(state.ownerThrows)throw new Error('owner unreadable');return sandboxOwnerScope();},
    home:()=>{state.homeCalls++;if(state.homeThrows)throw new Error('home unreadable');return state.home;},destroy:async()=>{}});
  const writeFence=(extra={})=>{
    const name='wf-'+randomBytes(8).toString('hex');
    fs.writeFileSync(join(directory,name+'.scope.reserved'),JSON.stringify({id:randomUUID(),sandbox_id:name,sbx_home:state.home,
      owner_scope:sandboxOwnerScope(),retired_name:true,cleanup_pending:false,compute_may_run:false,account_slot:0,...extra}));
    return name;
  };
  for(let i=0;i<fences;i++)writeFence();
  return {root,directory,journal,state,writeFence};
}

test('one scan reads the sbx home once, however many retired fences exist',t=>{
  const f=fixture(t,{fences:60});
  f.writeFence({cleanup_pending:true,compute_may_run:true,account_key:'a',account_slot:1});
  f.state.homeCalls=0;
  const rows=f.journal.obligations();
  assert.equal(rows.length,1,'only the pending fence is a debt');
  assert.equal(f.state.homeCalls,1,'home is read once per scan, not once per reservation file');
  assert.equal(rows[0].account_key,'a');
});

test('an unreadable sbx home gives no rows, as before; the next call reads it fresh',t=>{
  const f=fixture(t,{fences:3});
  f.writeFence({cleanup_pending:true,compute_may_run:true});
  f.state.homeThrows=true;
  assert.deepEqual(f.journal.obligations(),[]);
  f.state.homeThrows=false;
  assert.equal(f.journal.obligations().length,1);
});

test('a changed sbx home between two calls is used by the second call',t=>{
  const f=fixture(t,{fences:2});
  f.writeFence({cleanup_pending:true,compute_may_run:true});
  assert.equal(f.journal.obligations().length,1);
  f.state.home='/sbx/home-b';
  assert.equal(f.journal.obligations().length,0,'a fence for another home is not this home\'s debt');
});

function backendWith(rowsSource,{localFailure=false}={}) {
  const backend=Object.create(DockerSbxBackend.prototype);
  backend.cleanupJournal={obligations:()=>{rowsSource.calls++;return rowsSource.rows();}};
  backend._localCleanupFailure=localFailure;
  return backend;
}
const debt=extra=>({id:'x',account_key:'a',account_slot:0,compute_may_run:true,...extra});

test('inside withCleanupSnapshot every hold answers from one reading; outside it reads fresh',()=>{
  const source={calls:0,current:[debt()],rows(){return this.current;}};
  source.rows=source.rows.bind(source);
  const backend=backendWith(source);
  const inside=backend.withCleanupSnapshot(()=>{
    const first=backend.cleanupSlotHold('a'),other=backend.cleanupSlotHold('b'),unknown=backend.unknownCleanupDebts(['a']);
    source.current=[];// another process clears the debt mid-call
    return [first,other,unknown,backend.cleanupSlotHold('a')];
  });
  assert.deepEqual(inside,['cessation_unverified',null,0,'cessation_unverified']);
  assert.equal(source.calls,1,'one journal scan for the whole call');
  assert.equal(backend.cleanupSlotHold('a'),null,'a call after the snapshot reads fresh and sees the cleared debt');
  source.current=[debt({account_key:'b'})];
  assert.equal(backend.cleanupSlotHold('b'),'cessation_unverified','a debt added after the snapshot is seen by the next call');
});

test('the snapshot is cleared when fn throws, and it does not nest',()=>{
  const source={calls:0,current:[debt()],rows(){return this.current;}};source.rows=source.rows.bind(source);
  const backend=backendWith(source);
  assert.throws(()=>backend.withCleanupSnapshot(()=>{throw new Error('boom');}),/boom/);
  source.current=[];
  assert.equal(backend.cleanupSlotHold('a'),null);
  assert.throws(()=>backend.withCleanupSnapshot(()=>backend.withCleanupSnapshot(()=>1)),/nest/);
  assert.equal(backend.cleanupSlotHold('a'),null,'a failed nested call leaves no stale snapshot');
});

test('a stopped row whose answer changes between two admits calls is seen by the second call',()=>{
  const source={calls:0,current:[debt({compute_may_run:false})],rows(){return this.current;}};source.rows=source.rows.bind(source);
  const backend=backendWith(source);
  assert.equal(backend.withCleanupSnapshot(()=>backend.cleanupSlotHold('a')),null);
  source.current=[debt({compute_may_run:true})];
  assert.equal(backend.withCleanupSnapshot(()=>backend.cleanupSlotHold('a')),'cessation_unverified');
});

// A pool of two account workers whose admits runs the real child hold, over a backend that counts journal scans.
async function withPool(t,{rows=[],admitsFor}={}) {
  const source={calls:0,current:rows,rows(){this.calls++;return this.current;}};
  const backend=Object.create(DockerSbxBackend.prototype);
  backend.cleanupJournal={obligations:()=>source.rows()};backend._localCleanupFailure=false;
  const workers=[];let disk={jobs:0,milliseconds:0,accounts:{}};
  const controller=new AbortController();
  const pool=createLendingPool({backend,storage:{get:async()=>disk,set:async v=>{disk=v;},acquire:async()=>()=>{}},capacity:2,
    policy:{enabled:true,dailyJobs:null,dailyMinutes:null},adapters:[{spec:{harness_id:'claude-code-subscription'}},{spec:{harness_id:'codex'}}],
    createLender:opts=>{const index=workers.length;const worker={start:signal=>new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true})),
      getState:()=>({status:'idle',reason:null,current:null}),admits:job=>admitsFor?admitsFor(index,opts,job):opts.policy.hold(job),cessation:()=>({proven:true})};workers.push(worker);return worker;}});
  const running=pool.start(controller.signal);t.after(async()=>{controller.abort();await running;});
  while(workers.length<2)await new Promise(resolve=>setImmediate(resolve));
  return {pool,source,workers,backend};
}

test('a pool admits pass scans the cleanup journal once for two account children',async t=>{
  const {pool,source}=await withPool(t);
  source.calls=0;
  assert.equal(pool.admits(),null);
  assert.equal(source.calls,1,'two children, four holds, one scan');
});

test('a pass with unknown-account debts still scans once',async t=>{
  const {pool,source}=await withPool(t,{rows:[debt({account_key:null,id:'x1'}),debt({account_key:null,id:'x2'})]});
  source.calls=0;
  pool.admits();
  assert.equal(source.calls,1,'debts are read once however many holds ask');
});

test('a child that answers with a promise makes the pass throw, even when another child answers null; the snapshot is cleared',async t=>{
  const {pool,source,backend}=await withPool(t,{admitsFor:(index,opts,job)=>index===0?null:Promise.resolve(null)});
  assert.throws(()=>pool.admits(),/synchronously/);
  assert.equal(backend._cleanupSnapshot??null,null,'the snapshot is cleared');
  source.current=[debt({account_key:null,id:'fresh-1'}),debt({account_key:null,id:'fresh-2'})];
  assert.ok(backend.unknownCleanupDebts(['a','b'])>0,'a later real query reads the rows as they are now');
  source.current=[];
  assert.equal(backend.unknownCleanupDebts(['a','b']),0,'and again');
});

test('a function that returns a promise makes withCleanupSnapshot throw, and the snapshot is cleared',()=>{
  const backend=backendWith({calls:0,rows:()=>[]});
  assert.throws(()=>backend.withCleanupSnapshot(()=>Promise.resolve(1)),/synchronous/);
  assert.equal(backend._cleanupSnapshot??null,null);
  assert.equal(backend.withCleanupSnapshot(()=>2),2);
});

// Counts lenderAdmission answers. The pool asks its cleanup snapshot exactly once per admission answer that gets past its
// paused and stopped gates, so wrapping withCleanupSnapshot counts the app's calls to lenderAdmission one for one.
const countAdmissions=lender=>{
  const counter={asks:0};
  lender.backend.withCleanupSnapshot=work=>{counter.asks++;return work();};
  lender.backend.cleanupSlotHold=()=>null;
  lender.backend.unknownCleanupDebts=()=>0;
  return counter;
};
const asksPerStatusRead=async(counter,app,reads=3)=>{
  const counts=[];
  for(let i=0;i<reads;i++){counter.asks=0;await api(app,'/api/status');counts.push(counter.asks);}
  return counts;
};

test('through the real app state build: no admission question while lending is off, exactly one per state build while it is on',{timeout:120000},async t=>{
  const {appFixture}=await import('./helpers/v1-app-fixture.mjs');
  const f=await appFixture(t),{lender,circle}=await f.connect();
  const counter=countAdmissions(lender);
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  counter.asks=0;
  for(let i=0;i<3;i++){await api(lender.app,'/api/home');await api(lender.app,'/api/status');}
  assert.equal(counter.asks,0,'before lending is on, no state build asks the pool for an admission answer');
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  // The state build that reads the first ready answer can land a moment after the call returns.
  await waitFor(async()=>{await api(lender.app,'/api/status');return counter.asks>0;},'a state build asks the pool');
  await new Promise(r=>setTimeout(r,500));
  assert.deepEqual(await asksPerStatusRead(counter,lender.app),[1,1,1],'a ready state build asks once, however many segments use the answer');
  await api(lender.app,'/api/lending/off',{method:'POST',body:{}});
  counter.asks=0;
  for(let i=0;i<3;i++){await api(lender.app,'/api/home');await api(lender.app,'/api/status');}
  assert.equal(counter.asks,0,'with lending off again, no state build asks the pool for an admission answer');
});

test('with a job running and its cleanup not yet proven, a state build still asks the pool exactly once',{timeout:120000},async t=>{
  // A running job leaves a pending attempt with no cessation proof, so the cessation segment asks too.
  // The three segments (cessation, readiness, the stopping blocker) share one answer per state build.
  const {appFixture}=await import('./helpers/v1-app-fixture.mjs');
  const f=await appFixture(t,{hold:true}),{owner,lender,circle}=await f.connect();
  const counter=countAdmissions(lender);
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false,lendingPolicy:{providerConsent:{claude:true,codex:true}}}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Synthetic task.',harness:'codex'}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'review card');
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await waitFor(async()=>(await api(lender.app,'/api/lending')).current,'the lender holds the accepted job');
  await new Promise(r=>setTimeout(r,800));
  assert.deepEqual(await asksPerStatusRead(counter,lender.app),[1,1,1]);
});

// The guard "intent off means no admission question" was deliberately not added to the state build. With enabled=true and
// intent off, the state build asks once (the cessation segment reads the answer while the lender is enabled). That state
// cannot be built through the public API here: a start normalizes enabled to false, and Off clears it when the job stops.
// The pool-level and cessation cases above pin the current call counts instead; do not add a guard to make a count go down.

test('the owner scope is read once per scan, however many fences exist; a throw gives no rows; the next call reads it fresh',t=>{
  const f=fixture(t,{fences:50});
  f.writeFence({cleanup_pending:true,compute_may_run:true,account_key:'a'});
  f.state.ownerCalls=0;
  assert.equal(f.journal.obligations().length,1);
  assert.equal(f.state.ownerCalls,1,'one read for 51 reservation files');
  f.state.ownerThrows=true;
  assert.deepEqual(f.journal.obligations(),[]);
  f.state.ownerThrows=false;
  assert.equal(f.journal.obligations().length,1);
});
