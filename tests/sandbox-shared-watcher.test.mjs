import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const api=await import('../lib/v1/sandbox-shared-watcher.mjs').catch(()=>({}));
const name='wf-0123456789abcdef';
const row=()=>({_cleanupId:'12345678-1234-1234-1234-123456789012',sandbox_id:name,sbx_home:'/fixture/home',owner_scope:'owner',create:'dispatched',compute_created:false});
const complete=names=>({code:0,stdout:JSON.stringify(names.map(name=>({name}))),stderr:''});
// First red: stale handles must be fenced at dispatch, before invoking launch.
test('adoption fences stale handle exec before watcher acknowledgment or agent launch',async()=>{
  assert.equal(typeof api.adoptSandboxWatch,'function');
  const saved=row();let launched=0,ack=false;const events=[];
  const result=await api.adoptSandboxWatch({status:'watching',row:saved},{
    fence:r=>{saved.exec_fenced=true;events.push('fence');},
    persist:r=>{Object.assign(saved,r);events.push('durable');},
    acknowledge:async r=>{assert.throws(()=>api.assertWatchExecAllowed(saved));ack=true;events.push('ack');return {watch_generation:r.watch_generation,challenge:r.watch_challenge,binary:'/fixture/sbx'};},
  });
  assert.equal(result.admission_released,true);assert.equal(saved.compute_stopped,false);
  assert.throws(()=>{api.assertWatchExecAllowed(saved);launched++;});assert.equal(launched,0);
  // Design "Release rule: no guard hand-off": nothing retires a guard after the acknowledgment.
  assert.deepEqual(events,['fence','durable','ack','durable']);
});
for(const boundary of ['fence','persist','acknowledge'])test(`failure at ${boundary} never releases admission`,async()=>{
  const saved=row();const hooks={fence:()=>{},persist:r=>Object.assign(saved,r),acknowledge:async r=>({watch_generation:r.watch_generation,challenge:r.watch_challenge,binary:'/fixture/sbx'}),};
  hooks[boundary]=()=>{throw Error(boundary);};
  const result=await api.adoptSandboxWatch({status:'watching',row:saved},hooks);
  assert.equal(result.admission_released,false);assert.equal(result.status,'failed');
});
test('foreign or own cleanup locks are left untouched; later rows still adopt after failure',async()=>{
  let calls=0;const hooks={fence:()=>{calls++;},persist:()=>{},acknowledge:async r=>({watch_generation:r.watch_generation,challenge:r.watch_challenge,binary:'/fixture/sbx'})};
  for(const status of ['in_progress','foreign_locked'])assert.equal((await api.adoptSandboxWatch({status,row:row()},hooks)).status,status);
  assert.equal(calls,0);
  const failed=await api.adoptSandboxWatch({status:'watching',row:row()},{...hooks,persist:()=>{throw Error('disk');}});
  const later=await api.adoptSandboxWatch({status:'watching',row:{...row(),sandbox_id:'wf-1111111111111111'}},hooks);
  assert.equal(failed.admission_released,false);assert.equal(later.admission_released,true);
});
test('a mismatched acknowledgment holds admission',async()=>{
  for(const bad of ['generation']){
    const result=await api.adoptSandboxWatch({status:'watching',row:row()},{fence:()=>{},persist:()=>{},
      acknowledge:async r=>({watch_generation:bad==='generation'?'wrong':r.watch_generation,challenge:r.watch_challenge,binary:'/fixture/sbx'})});
    assert.equal(result.admission_released,false);
  }
});
test('idempotent replay preserves generation and debts without listing or absence aging',async()=>{
  let saved=row();const generations=[];
  const hooks={fence:()=>{},persist:r=>{saved=r;},acknowledge:async r=>{generations.push(r.watch_generation);return {watch_generation:r.watch_generation,challenge:r.watch_challenge,binary:'/fixture/sbx'};}};
  await api.adoptSandboxWatch({status:'watching',row:saved},hooks);
  await api.adoptSandboxWatch({status:'watching',row:JSON.parse(JSON.stringify(saved))},hooks);
  assert.equal(generations[0],generations[1]);assert.equal(saved.compute_stopped,false);
  assert.equal(saved.scratch_removed,undefined);assert.equal(saved.policy_removed,undefined);
});
for(const n of [44,500])test(`${n} names use one listing per tick, four removals, no unchanged writes`,async()=>{
  const names=Array.from({length:n},(_,i)=>({name:'wf-'+i.toString(16).padStart(16,'0')}));
  let lists=0,writes=0,active=0,max=0,removals=0;
  const poll=api.createWatchPoller({read:()=>({names}),publish:()=>writes++,now:()=>0,
    run:async args=>{if(args[0]==='ls'){lists++;return complete(names.map(x=>x.name));}active++;max=Math.max(max,active);await Promise.resolve();active--;removals++;return {code:0};}});
  await poll.tick();await poll.drain();const initial=writes;await poll.tick();await poll.drain();assert.equal(lists,2);assert.equal(removals,n*2);assert.equal(max,4);assert.equal(writes,initial);
});
test('endless 503 backs off to 60s; restart retains names and removes late appearance',async()=>{
  const manifest={names:[{name}]};let failed=true,removes=0;const state=[];
  const make=()=>api.createWatchPoller({read:()=>JSON.parse(JSON.stringify(manifest)),publish:s=>state.push(s),now:()=>0,
    run:async args=>{if(args[0]==='ls')return failed?{code:503,stdout:''}:complete([name]);removes++;return {code:0};}});
  const poll=make();const delays=[];for(let i=0;i<10;i++)delays.push(await poll.tick());
  assert.equal(Math.max(...delays),60000);assert.equal(state.at(-1).message,'watching 1 names until listing works');
  failed=false;const resumed=make();await resumed.tick();await resumed.drain();assert.equal(removes,1);assert.equal(manifest.names.length,1);
});
for(const flaw of [{truncated:true},{timedOut:true},{killed:true},{errorCode:'EPIPE'},{stderr:'warning'},{code:1}])test(`partial or noisy inventory is unknown ${JSON.stringify(flaw)}`,()=>{
  assert.equal(api.completeWatchInventory({...complete([]),...flaw}),null);
});
test('overlapping ticks share one in-flight listing',async()=>{
  let release,calls=0;const gate=new Promise(r=>release=r);
  const poll=api.createWatchPoller({read:()=>({names:[]}),publish:()=>{},run:async()=>{calls++;await gate;return complete([]);}});
  const a=poll.tick(),b=poll.tick();release();await Promise.all([a,b]);assert.equal(calls,1);
});

import {createSandboxCleanupJournal} from '../lib/sandbox-cleanup-journal.mjs';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import {acquireProcessLockSync} from '../lib/v1/lock.mjs';
import {durableWrite} from '../lib/durable-write.mjs';
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'shared-watch-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const directory=path.join(root,'journal'),scratch=path.join(root,'scratch');fs.mkdirSync(directory);fs.mkdirSync(scratch);
  const saved={...row(),version:2,owner_scope:sandboxOwnerScope(),sbx_home:root,job_id:'job',scratch_dir:path.join(scratch,'wf-job-'+name+'-12345678-1234-1234-1234-123456789012'),data_cleanup:'pending',policy_cleanup:'pending'};
  // A row with a guard is never handed to the watcher (design "Release rule: no guard hand-off"), so this one has none.
  const file=path.join(directory,saved._cleanupId+'.json');fs.writeFileSync(file,JSON.stringify(saved));
  const journal=createSandboxCleanupJournal({directory,scratchRoot:()=>scratch,home:()=>root,destroy:()=>{throw Error('No inventory allowed');}});
  return {root,directory,file,saved,journal,result:{id:saved._cleanupId,name,status:'watching'}};
}
test('real journal adoption fences stale authority but retains cleanup authority and debt',async t=>{
  const f=fixture(t);let launches=0;
  const result=await f.journal.adoptWatch(f.result,{cancel:async()=>true},{acknowledge:async r=>{
    assert.throws(()=>{f.journal.assertExecAllowed(f.saved);launches++;});
    assert.equal(f.journal.authority(f.saved).compute_stopped,false);
    return {watch_generation:r.watch_generation,challenge:r.watch_challenge,binary:'/fixture/sbx'};}});
  assert.equal(result.admission_released,true);assert.equal(launches,0);
  const persisted=JSON.parse(fs.readFileSync(f.file));assert.equal(persisted.data_cleanup,'pending');assert.equal(persisted.policy_cleanup,'pending');
  assert.equal(f.journal.jobsStopped(['job']),false);
});
test('real name lock prevents adoption and record mutation',async t=>{
  const f=fixture(t),before=fs.readFileSync(f.file,'utf8');
  const release=acquireProcessLockSync(path.join(f.directory,name+'.scope'));
  const result=await f.journal.adoptWatch(f.result,{cancel:()=>{throw Error('must not retire');}},{acknowledge:()=>{throw Error('must not acknowledge');}});
  assert.equal(result.admission_released,false);assert.equal(fs.readFileSync(f.file,'utf8'),before);release();
});
test('every durable-write barrier failure prevents acknowledgment and retirement',async t=>{
  const f=fixture(t);
  // File, containing directory, and all ancestors are barriers, including after rename.
  for(let failAt=1;failAt<=5;failAt++){
    let at=0,acked=0;const file=path.join(f.root,'durable','row.json');
    const sync=()=>{if(++at===failAt)throw Error('fsync failure');};
    const io={openSync:(...a)=>fs.openSync(...a),closeSync:fd=>fs.closeSync(fd),writeAllSync:(fd,b)=>fs.writeFileSync(fd,b),
      fsyncSync:sync,fsyncDirectory:sync,renameSync:(...a)=>fs.renameSync(...a),unlinkSync:file=>fs.unlinkSync(file)};
    const result=await api.adoptSandboxWatch({status:'watching',row:row()},{fence:()=>{},persist:r=>durableWrite(file,JSON.stringify(r),{io}),acknowledge:async r=>{acked++;return {watch_generation:r.watch_generation,challenge:r.watch_challenge,binary:'/fixture/sbx'};}});
    if(at>=failAt){assert.equal(result.admission_released,false);assert.equal(acked,0);}
  }
});

import {EventEmitter} from 'node:events';
test('singleton acknowledges new and concurrent names while inventory is hung, with fresh replay challenge',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'watch-process-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const controller=new AbortController();let unblock,started=0,work;
  const blocked=new Promise(r=>unblock=r);
  const manager=api.createSharedSandboxWatcher({home:root,owner:'owner',binary:'/fixture/sbx',readyMs:2000,
    spawnWatcher:(_bin,argv)=>{started++;const child=new EventEmitter();child.unref=()=>{};
      work=api.startSharedSandboxWatcher({...JSON.parse(argv[1]),signal:controller.signal,refreshMs:5,runCommand:async()=>{await blocked;return {code:503};}});
      work.then(()=>child.emit('exit'),e=>child.emit('error',e));return child;}});
  const one={...row(),sbx_home:root,watch_state:'watch_adopted',watch_generation:'one'};
  const two={...one,sandbox_id:'wf-1111111111111111',_cleanupId:'22222222-2222-2222-2222-222222222222',watch_generation:'two'};
  try {
    const firstAck=await manager.acknowledge(one);assert.equal(firstAck.watch_generation,'one');
    const adopted={...one,exec_fenced:true,watch_challenge:firstAck.challenge,watch_ack:{challenge:firstAck.challenge,binary:firstAck.binary}};
    assert.equal(await api.sharedWatchBound({...adopted,watch_ack:null}),false);
    assert.equal(await api.sharedWatchBound({...adopted,watch_ack:{...adopted.watch_ack,binary:'/wrong/sbx'}}),false);
    assert.equal(await api.sharedWatchBound(adopted),true);
    // The guard's exit on a durable hand-off is gone (design "Release rule: no guard hand-off"): a guard stays its row's deadline remover.
    const initial=JSON.parse(fs.readFileSync(path.join(root,'.faravan-shared-watch/names.json'))).names[0].challenge;
    const results=await Promise.all([manager.acknowledge(one),manager.acknowledge(two)]);
    assert.deepEqual(results.map(r=>r.watch_generation),['one','two']);assert.equal(started,1);
    const manifest=JSON.parse(fs.readFileSync(path.join(root,'.faravan-shared-watch/names.json')));
    assert.notEqual(manifest.names.find(r=>r.name===name).challenge,initial);
    assert.equal(manifest.names.length,2);assert.equal(await api.sharedWatchBound(adopted),false,'old retirement token cannot follow a newer adoption challenge');
  }finally{controller.abort();unblock();await work;}
});
test('a live unrelated PID and stale status cannot acknowledge missing singleton',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'watch-no-process-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const directory=path.join(root,'.faravan-shared-watch');fs.mkdirSync(directory);
  let now=0;const manager=api.createSharedSandboxWatcher({home:root,owner:'owner',binary:'/fixture/sbx',readyMs:2,now:()=>now,pause:async()=>{now++;},
    spawnWatcher:()=>{const e=new EventEmitter();e.unref=()=>{};return e;}});
  fs.writeFileSync(path.join(directory,'status.json'),JSON.stringify({home:root,owner:'owner',binary:'/fixture/sbx',pid:process.pid,start:'live',generation:'stale'}));
  await assert.rejects(manager.acknowledge({...row(),sbx_home:root,watch_state:'watch_adopted',watch_generation:'one'}),/unavailable/);
});

test('malformed row name cannot be used to inspect an outside lock path',async t=>{
  const f=fixture(t);fs.writeFileSync(f.file,JSON.stringify({...f.saved,sandbox_id:'../outside'}));
  const result=await f.journal.adoptWatch({...f.result,name:'../outside'},{cancel:()=>{throw Error('must not retire');}},{});
  assert.equal(result.status,'failed');assert.equal(result.admission_released,false);
});

test('a blocked four-removal batch does not delay the next inventory',async()=>{
  const names=Array.from({length:44},(_,i)=>'wf-'+i.toString(16).padStart(16,'0'));
  let lists=0,active=0,max=0,release;const blocked=new Promise(r=>release=r);
  const poll=api.createWatchPoller({read:()=>({names:names.map(name=>({name}))}),publish:()=>{},run:async args=>{
    if(args[0]==='ls'){lists++;return complete(names);}active++;max=Math.max(max,active);await blocked;active--;return {code:0};}});
  await poll.tick();await poll.tick();assert.equal(lists,2);assert.equal(active,4);assert.equal(max,4);
  poll.stop();release();await poll.drain();
});
test('stopping singleton cannot acknowledge a new adoption while old commands drain',{timeout:10000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'watch-stopping-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const controller=new AbortController();let release,work,inventoryStarted,now=0;const blocked=new Promise(r=>release=r);
  const started=new Promise(r=>inventoryStarted=r);
  // Start the readiness clock only after the watcher has claimed the first record and entered its blocked command.
  // Real filesystem startup can exceed 120 ms; the stopping watcher must still exhaust the same readiness budget.
  const manager=api.createSharedSandboxWatcher({home:root,owner:'owner',binary:'/fixture/sbx',readyMs:120,now:()=>now,
    pause:async ms=>{await started;now+=ms;},
    spawnWatcher:(_bin,argv)=>{const child=new EventEmitter();child.unref=()=>{};
      work=api.startSharedSandboxWatcher({...JSON.parse(argv[1]),signal:controller.signal,refreshMs:5,runCommand:async()=>{inventoryStarted();await blocked;return {code:503};}});
      work.then(()=>child.emit('exit'),e=>child.emit('error',e));return child;}});
  const first={...row(),sbx_home:root,watch_state:'watch_adopted',watch_generation:'one'};
  try {await manager.acknowledge(first);controller.abort();
    await assert.rejects(manager.acknowledge({...first,sandbox_id:'wf-2222222222222222',_cleanupId:'22222222-2222-2222-2222-222222222222',watch_generation:'two'}),/unavailable/);
    assert.equal(manager.status().healthy,false);
  }finally{controller.abort();release();await work;}
});

// Review follow-up: the absent receipt the cleanup row already holds must reach the proof store before the old guard retires.
import {watchProofStore} from '../lib/v1/sandbox-watch-proofs.mjs';
test('hand-off carries the row\'s recorded absent receipt, so a name that appears late is removed',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'shared-watch-receipt-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const adopted={...row(),sbx_home:home,owner_scope:'receipt-owner',exec_fenced:true,watch_state:'watch_adopted',watch_generation:'generation-1',
    create_incarnation:row()._cleanupId,watch_challenge:'challenge-1',watch_ack:null,compute_stopped:false,absent_since:123};
  const watcher=api.createSharedSandboxWatcher({home,owner:'receipt-owner',binary:'/fixture/sbx',readyMs:1,pause:async()=>{},
    spawnWatcher:()=>({on(){},unref(){}})});
  await assert.rejects(watcher.acknowledge(adopted),/unavailable/);
  const proofs=watchProofStore({home,owner:'receipt-owner'});
  assert.equal(proofs.mayRemove(adopted),true,'the row\'s own earlier empty listing is the create receipt');
  // The first listing the watcher takes shows the name: it is removed, not left as a name with no receipt.
  let removals=0;
  const item={name,create_incarnation:adopted._cleanupId,watch_generation:'generation-1',state:'watch_adopted'};
  const poll=api.createWatchPoller({read:()=>({names:[item]}),publish:()=>{},proofs,
    run:async args=>{if(args[0]==='ls')return complete([name]);removals++;return {code:0};}});
  await poll.tick();await poll.drain();poll.stop();
  assert.equal(removals,1);
  // Another row's receipt is never inferred: a different name, or a row without a recorded receipt, gets none.
  const noReceipt={...adopted,_cleanupId:'87654321-4321-4321-4321-210987654321',create_incarnation:'87654321-4321-4321-4321-210987654321',
    sandbox_id:'wf-1111111111111111',watch_generation:'generation-2',absent_since:undefined};
  await assert.rejects(watcher.acknowledge(noReceipt),/unavailable/);
  assert.equal(proofs.mayRemove(noReceipt),false);
});
