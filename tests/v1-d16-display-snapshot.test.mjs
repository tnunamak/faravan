import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes, randomUUID} from 'node:crypto';
import {createSandboxCleanupJournal} from '../lib/sandbox-cleanup-journal.mjs';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import {DockerSbxBackend, CLEANUP_DISPLAY_MAX_AGE_MS, CLEANUP_DISPLAY_UNCHANGED_MAX_AGE_MS} from '../lib/docker-backend.mjs';
import {api, appFixture} from './helpers/v1-app-fixture.mjs';

// Display reads (home, status, readiness) may reuse a cleanup status up to 15 s old. Admission, claims, reservations and
// the reaper never do. The journal and backend are real; only the sbx daemon is absent.
function fixture(t,{fences=30}={}) {
  const root=fs.mkdtempSync(join(tmpdir(),'d16-display-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const directory=join(root,'journal');fs.mkdirSync(directory);
  const home='/sbx/home-a';
  const journal=createSandboxCleanupJournal({directory,scratchRoot:()=>join(root,'scratch'),ownerScope:()=>sandboxOwnerScope(),home:()=>home,destroy:async()=>{}});
  const writeFence=(extra={})=>{
    const name='wf-'+randomBytes(8).toString('hex');
    fs.writeFileSync(join(directory,name+'.scope.reserved'),JSON.stringify({id:randomUUID(),sandbox_id:name,sbx_home:home,
      owner_scope:sandboxOwnerScope(),retired_name:true,cleanup_pending:false,compute_may_run:false,account_slot:0,...extra}));
    return name;
  };
  for(let i=0;i<fences;i++)writeFence();
  const counter={scans:0};
  const real=journal.obligations;
  journal.obligations=(...args)=>{counter.scans++;return real(...args);};
  const backend=Object.create(DockerSbxBackend.prototype);
  backend.cleanupJournal=journal;backend._localCleanupFailure=false;
  const clock={now:1_000_000};
  backend._cleanupDisplayNow=()=>clock.now;
  return {backend,journal,writeFence,counter,clock,root};
}

test('three display reads inside 15 s scan the journal once; an unchanged journal is not rescanned until the long ceiling',t=>{
  const f=fixture(t);
  for(let i=0;i<3;i++)f.backend.cleanupStatusForDisplay();
  assert.equal(f.counter.scans,1);
  const first=f.backend.cleanupStatusForDisplay();
  for(let i=0;i<10;i++){f.clock.now+=CLEANUP_DISPLAY_MAX_AGE_MS;assert.deepEqual(f.backend.cleanupStatusForDisplay(),first);}
  assert.equal(f.counter.scans,1,'ten idle refreshes with no journal change: no extra scan');
  f.clock.now=1_000_000+CLEANUP_DISPLAY_UNCHANGED_MAX_AGE_MS;
  f.backend.cleanupStatusForDisplay();
  assert.equal(f.counter.scans,2,'at the ceiling: one fresh scan');
});

test('a row appended to an idle journal shows within one 15 s refresh',t=>{
  const f=fixture(t,{fences:2});
  const before=f.backend.cleanupStatusForDisplay().records;
  for(let i=0;i<3;i++){f.clock.now+=CLEANUP_DISPLAY_MAX_AGE_MS;f.backend.cleanupStatusForDisplay();}
  assert.equal(f.counter.scans,1);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30);
  fs.writeFileSync(join(f.root,'journal',randomUUID()+'.json'),'{}');
  f.clock.now+=CLEANUP_DISPLAY_MAX_AGE_MS;
  assert.equal(f.backend.cleanupStatusForDisplay().records,before+1);
  assert.equal(f.counter.scans,2);
});

test('a caller cannot change the shared display snapshot',t=>{
  const f=fixture(t);f.writeFence({cleanup_pending:true,compute_may_run:true,account_key:'a'});
  const first=f.backend.cleanupStatusForDisplay();
  first.items.length=0;first.state='tampered';
  const second=f.backend.cleanupStatusForDisplay();
  assert.equal(second.items.length,1);
  assert.notEqual(second.state,'tampered');
});

test('an admission hold sees a new fence at once while the display snapshot is still fresh',t=>{
  const f=fixture(t);
  assert.equal(f.backend.cleanupStatusForDisplay().items.length,0);
  assert.equal(f.backend.cleanupSlotHold('a',{slot:0}),null);
  assert.equal(f.backend.unknownCleanupDebts(['a']),0);
  f.writeFence({cleanup_pending:true,compute_may_run:true,account_key:'a',account_slot:0});
  f.clock.now+=1000;
  assert.equal(f.backend.cleanupStatusForDisplay().items.length,0,'the display still shows the older reading');
  assert.equal(f.backend.cleanupSlotHold('a',{slot:0}),'cessation_unverified','the hold reads the journal fresh');
  f.writeFence({cleanup_pending:true,compute_may_run:true,account_key:null});
  assert.equal(f.backend.unknownCleanupDebts(['a']),1,'unknown-debt count reads the journal fresh');
  let held;
  f.backend.withCleanupSnapshot(()=>{held=f.backend.cleanupSlotHold('a',{slot:0});});
  assert.equal(held,'cessation_unverified','an admits pass takes its own fresh snapshot');
});

test('a fresh cleanupStatus reading refreshes the display snapshot',t=>{
  const f=fixture(t);
  f.backend.cleanupStatusForDisplay();
  f.writeFence({cleanup_pending:true,compute_may_run:true,account_key:'a'});
  f.backend.cleanupStatus();
  assert.equal(f.backend.cleanupStatusForDisplay().items.length,1);
});

test('structural: only display code reads the display snapshot; policy, reaper and admission code cannot reach it',()=>{
  const lib=join(import.meta.dirname,'..','lib');
  const files=[];const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true}))e.isDirectory()?walk(join(d,e.name)):/\.m?js$/.test(e.name)&&files.push(join(d,e.name));};
  walk(lib);
  const users=files.filter(file=>/cleanupStatusForDisplay|cleanupDisplayField|cleanupSummaryForDisplay|_cleanupDisplay(Reading)?\b/.test(fs.readFileSync(file,'utf8'))).map(file=>file.slice(lib.length+1)).sort();
  assert.deepEqual(users,['docker-backend.mjs','v1/app.mjs','v1/deadline-recovery-gate.mjs']);
  const backend=fs.readFileSync(join(lib,'docker-backend.mjs'),'utf8');
  const inside=(backend.match(/_cleanupDisplay\b/g)??[]).length;
  assert.ok(inside>0);
  for(const name of ['_cleanupView','cleanupSlotHold','unknownCleanupDebts','withCleanupSnapshot']) {
    const body=backend.slice(backend.indexOf('  '+name+'('),backend.indexOf('\n  }\n',backend.indexOf('  '+name+'(')));
    assert.ok(body.length>20&&!/_cleanupDisplay|cleanupStatusForDisplay|cleanupDisplayField|cleanupSummaryForDisplay/.test(body),name+' never reads the display snapshot');
  }
});

test('GET /api/home scans the cleanup journal at most once, and not at all while a display snapshot is under 15 s old',{timeout:120000},async t=>{
  const f=await appFixture(t),{lender}=await f.connect();
  const backend=lender.backend,scans={n:0};
  const row=[];
  backend.cleanupJournal={status:()=>({state:'clear',data_cleanup_pending:0,compute_cleanup_pending:0}),obligations:()=>{scans.n++;return row;}};
  backend._localCleanupFailure=false;
  const clock={now:5_000_000};
  backend._cleanupDisplayNow=()=>clock.now;
  backend._cleanupDisplay=null;
  for(const name of ['cleanupStatus','cleanupStatusForDisplay','_cleanupDisplayReading'])backend[name]=DockerSbxBackend.prototype[name];
  await api(lender.app,'/api/home');
  assert.ok(scans.n<=1,'one /api/home makes at most one scan, saw '+scans.n);
  const after=scans.n;
  for(let i=0;i<5;i++){await api(lender.app,'/api/home');await api(lender.app,'/api/status');}
  assert.equal(scans.n,after,'reads inside 15 s do not scan');
  clock.now+=CLEANUP_DISPLAY_MAX_AGE_MS;
  await api(lender.app,'/api/home');
  assert.equal(scans.n,after+1,'the first read after expiry makes exactly one scan');
});

// A write made by this process invalidates the display snapshot at once; a write by another process keeps the 15 s bound.
function registerHandle(f) {
  const id='wf-'+randomBytes(8).toString('hex'),scratchRoot=join(f.root,'scratch');
  const scratch=join(scratchRoot,'wf-job-'+id+'-x');fs.mkdirSync(scratch,{recursive:true,mode:0o700});
  const handle={sandbox_id:id,job_id:'job-1',scratch_dir:scratch};
  f.journal.register(handle);
  return handle;
}

test('phased: a local register and finish show on the next display read, an outside write waits for the bound',t=>{
  const f=fixture(t,{fences:2});
  assert.equal(f.backend.cleanupStatusForDisplay().records,0);
  f.clock.now+=1000;
  fs.writeFileSync(join(f.root,'journal',randomUUID()+'.json'),'{}');
  assert.equal(f.backend.cleanupStatusForDisplay().records,0,'another process wrote: the bounded snapshot may still be shown');
  f.clock.now+=CLEANUP_DISPLAY_MAX_AGE_MS;
  f.backend.cleanupStatusForDisplay();
  const handle=registerHandle(f);
  f.clock.now+=1000;
  const after=f.backend.cleanupStatusForDisplay();
  assert.ok(after.records>=2,'this process registered a row: the very next display read sees it');
  const before=f.counter.scans;
  f.backend.cleanupStatusForDisplay();
  assert.equal(f.counter.scans,before,'with no further write the snapshot is reused');
  f.journal.finish(handle,{removed:true,scratch_removed:true,policy_removed:true,sbx_home:'/sbx/home-a'});
  f.clock.now+=1000;
  assert.ok(f.backend.cleanupStatusForDisplay().records<after.records,'a finished cleanup no longer shows as pending');
});

test('phased: the idle reaper never skips for a debt this process just wrote',t=>{
  const f=fixture(t,{fences:2});
  f.clock.now+=0;
  assert.equal(f.backend.cleanupDisplayIdle(),true,'clear at t=0');
  f.clock.now+=14000;
  assert.equal(f.backend.cleanupDisplayIdle(),true,'still clear at t=14 s from the snapshot');
  registerHandle(f);
  f.clock.now+=1000;
  assert.equal(f.backend.cleanupDisplayIdle(),false,'the t=15 s timer sees the local write instead of skipping');
});

test('home caps 3,000 cleanup debts and reuses the projected summary until a local write', {timeout:120000}, async t=>{
  const f=await appFixture(t),{lender}=await f.connect(),backend=lender.backend;
  let generation=0,scans=0;
  const rows=Array.from({length:3000},(_,i)=>({id:'debt-'+String(i).padStart(4,'0'),name:null,reason:'deferred',compute_may_run:false}));
  backend.cleanupJournal={status:()=>({state:'pending',data_cleanup_pending:rows.length,compute_cleanup_pending:0}),
    obligations:()=>{scans++;return rows;},writeGeneration:()=>generation};
  backend._localCleanupFailure=false;backend._cleanupDisplay=null;backend._cleanupDisplayNow=()=>5_000_000;
  for(const name of ['cleanupStatus','cleanupStatusForDisplay','cleanupSummaryForDisplay','cleanupDisplayField','_cleanupDisplayReading'])backend[name]=DockerSbxBackend.prototype[name];
  const first=(await api(lender.app,'/api/home')).cleanup;
  assert.equal(first.items.length,50);
  assert.equal(first.total_items,3000);assert.equal(first.truncated,true);
  assert.equal(first.data_cleanup_pending,3000);
  assert.equal(first.items[0].id,'debt-0000');
  const held=backend._cleanupDisplay,projected=held.summary,items=held.status.items;
  let itemReads=0;
  Object.defineProperty(held.status,'items',{configurable:true,get(){itemReads++;return items;}});
  const second=(await api(lender.app,'/api/home')).cleanup;
  assert.deepEqual(second,first);assert.equal(scans,1);
  assert.equal(itemReads,0,'cached home summary never rereads all raw items');
  assert.strictEqual(backend._cleanupDisplay.summary,projected);
  second.items.length=0;
  assert.equal((await api(lender.app,'/api/home')).cleanup.items.length,50,'caller cannot mutate the cache');
  rows.push({id:'debt-3000',name:null,reason:'deferred',compute_may_run:false});generation++;
  const changed=(await api(lender.app,'/api/home')).cleanup;
  assert.equal(changed.total_items,3001);assert.equal(changed.data_cleanup_pending,3001);
  assert.equal(changed.items.length,50);assert.equal(changed.truncated,true);assert.equal(scans,2);
});
