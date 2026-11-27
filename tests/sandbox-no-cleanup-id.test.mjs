import './helpers/no-browser.mjs';
import {superviseBound} from './helpers/supervise-bound.mjs';
// A cleanup record with no `_cleanupId` can never be handed off. The deadline guard relies on that: it takes the record's owner
// handle only for a record that carries a cleanup id (or cannot be read), so for a record without one the guard is the only
// actor that may remove the bound name. These tests drive every path that can hand off, adopt, acknowledge, observe as owner or
// remove a name with records of every shape that has no cleanup id, and show that none of them acts. They also show that a
// fenced guard never waits without a bound and ends on SIGTERM while it holds the owner handle.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {createSandboxCleanupJournal} from '../lib/sandbox-cleanup-journal.mjs';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import {adoptSandboxWatch,createSharedSandboxWatcher,createWatchPoller,sharedWatchServing,sharedWatchBound,watcherActedOnRecord} from '../lib/v1/sandbox-shared-watcher.mjs';
import {watchProofStore,watchProofDirectory} from '../lib/v1/sandbox-watch-proofs.mjs';
import {acquireRecordOwner,ownershipStatus,readOwnership} from '../lib/v1/sandbox-record-owner.mjs';
import {createSandboxDeadlineManager,deadlineBinding,deadlineSupervisorPayload,sandboxDeadlineClock} from '../lib/sandbox-deadline.mjs';
import {superviseSandboxDeadline,takeRecordFence,DEADLINE_RETRY_MAX_MS} from '../lib/sandbox-deadline-supervisor.mjs';
import {DockerSbxBackend} from '../lib/docker-backend.mjs';

// These records carry their own shapes; the guard row is the one that names the deadline, so each reading is bound to that row. The
// shape under test (create id, incarnation, owner) stays the record's own.
const superviseOnTarget=(target,options)=>superviseBound(superviseSandboxDeadline,target,{...options,
  readRecord:()=>({...options.readRecord(),sandbox_id:target.sandbox_id,sbx_home:target.sbx_home,deadline_at:target.deadline_at,deadline_clock:target.deadline_clock})});


const NAME='wf-0123456789abcdef';
const OWNER=sandboxOwnerScope();
const linux=process.platform==='linux';
const tree=t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wf-no-id-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const records=path.join(root,'records'),scratch=path.join(root,'scratch');
  fs.mkdirSync(records);fs.mkdirSync(scratch);
  return {root,records,scratch};
};
const scratchDir=(f,name=NAME)=>path.join(f.scratch,'wf-job-'+name+'-'+randomUUID());
const clock=sandboxDeadlineClock();
const deadline={deadline_at:clock.wall+60_000,deadline_clock:{version:1,boot_id:clock.boot_id,boot_at:clock.boot_ms+60_000}};

// Every shape of a record that has no `_cleanupId`: the write-ahead record the scratch code saves in the same directory
// (sandbox-scratch.mjs), a current row without its id, and an older version 1 row without owner scope.
function shapes(f) {
  const base=(extra={})=>({sbx_home:f.root,job_id:'job-no-id',sandbox_id:NAME,scratch_dir:scratchDir(f),create:'dispatched',compute_created:false,
    create_settled:false,compute_stopped:false,data_cleanup:'pending',policy_cleanup:'pending',...deadline,...extra});
  return {
    scratch_write_ahead:{v:1,sandboxId:NAME,parent:f.scratch,scratch:scratchDir(f),ownerPid:process.pid,owner_scope:OWNER,sbx_home:f.root},
    current_row_without_id:base({version:2,owner_scope:OWNER}),
    older_row_without_id:base({version:1}),
    adopted_row_without_id:base({version:2,owner_scope:OWNER,exec_fenced:true,watch_state:'watch_adopted',watch_generation:randomUUID(),
      watch_challenge:'challenge',watch_ack:{challenge:'challenge',binary:'/fixture/sbx'}}),
  };
}
// The one shape that names a create without a cleanup id: the incarnation a hand-off saves. Proof store and guard both bind it.
const carried=f=>({version:2,owner_scope:OWNER,sbx_home:f.root,job_id:'job-no-id',sandbox_id:NAME,scratch_dir:scratchDir(f),create:'dispatched',compute_created:false,
  create_settled:false,compute_stopped:false,...deadline,create_incarnation:randomUUID(),watch_generation:randomUUID()});
// The files a record can live in: named by sandbox (where the scratch code writes it), or by a UUID (where the journal looks).
const places=(f,record)=>{
  const named=path.join(f.records,NAME+'.json'),uuid=path.join(f.records,randomUUID()+'.json');
  for(const file of [named,uuid])fs.writeFileSync(file,JSON.stringify(record));
  return [named,uuid];
};
const bytesOf=files=>Object.fromEntries(files.map(file=>[file,fs.readFileSync(file,'utf8')]));
const noOwnership=f=>{
  const directory=watchProofDirectory(f.root);
  assert.deepEqual(fs.existsSync(directory)?fs.readdirSync(directory).filter(name=>/^(own-|act-|names|proofs|status)/.test(name)):[],[],
    'no record ownership, proof or manifest was created');
};

for(const label of Object.keys(shapes({root:'/x',records:'/x',scratch:'/x'}))) {
  test(`${label}: the journal never recovers, reaps, resolves or hands off a record with no cleanup id`,async t=>{
    const f=tree(t),row=shapes(f)[label],files=places(f,row),before=bytesOf(files);
    const calls=[];
    const spy=name=>async(...args)=>{calls.push(name);return name==='reconcileGuards'?{blocked:[],adopted:[]}:name==='observed'?false:true;};
    const manager={active:spy('active'),register:spy('register'),observed:spy('observed'),reconcileGuards:spy('reconcileGuards')};
    const watcher={acknowledge:spy('acknowledge')};
    const journal=createSandboxCleanupJournal({directory:f.records,scratchRoot:()=>f.scratch,home:()=>f.root,
      destroy:async()=>{calls.push('destroy');return {removed:false};},
      resolveAdopted:async()=>{calls.push('resolveAdopted');return {};},retryWatchDebts:async()=>{calls.push('retryWatchDebts');return {policy_revoked:false};}});
    const recovered=await journal.recoverDeadlines(manager,{watcher,clock:()=>clock});
    assert.equal(recovered.rows.some(item=>['watching','protected','resolved'].includes(item.status)),false,'no record was recovered, protected or watched');
    await journal.reap();
    await journal.resolveJobs(['job-no-id']);
    journal.jobsStopped(['job-no-id']);
    journal.status();
    for(const result of [{status:'watching',row},{status:'failed',row,name:NAME},{status:'watching',id:path.basename(files[1],'.json'),name:NAME}]) {
      const outcome=await journal.adoptWatch(result,manager,watcher);
      assert.equal(outcome.admission_released,false,'no hand-off was made');
    }
    assert.deepEqual(calls.filter(name=>name!=='reconcileGuards'),[],'no guard, enforcer, watcher or removal call touched the record');
    assert.deepEqual(bytesOf(files),before,'the record is byte for byte as it was');
    noOwnership(f);
  });

  test(`${label}: the watcher side never adopts, acknowledges, observes or owns a record with no cleanup id`,async t=>{
    const f=tree(t),row=shapes(f)[label];
    // The hand-off itself.
    const steps=[];
    const outcome=await adoptSandboxWatch({status:'watching',row},{fence:()=>steps.push('fence'),persist:()=>steps.push('persist'),
      acknowledge:async()=>{steps.push('acknowledge');return {};},retire:async()=>{steps.push('retire');return true;}});
    assert.deepEqual(steps,[]);assert.equal(outcome.admission_released??false,false);
    // The acknowledgment by the shared watcher, with a launcher that must never run.
    let launched=0;
    const watcher=createSharedSandboxWatcher({home:f.root,owner:OWNER,binary:'/fixture/sbx',readyMs:200,pause:async()=>{},spawnWatcher:()=>{launched++;throw Error('launched');}});
    await assert.rejects(watcher.acknowledge({...row,watch_state:'watch_adopted'}),/binding changed|unavailable/);
    assert.equal(launched,0);
    // What serves, holds or is bound to the record.
    assert.equal(sharedWatchServing({...row,watch_state:'watch_adopted'}),null);
    assert.equal(await sharedWatchBound({...row,watch_state:'watch_adopted'}),false);
    assert.equal(watcherActedOnRecord({...row,watch_state:'watch_adopted'}),false);
    // The proof store: no binding, so no owner, no sighting, no receipt, no proof.
    const store=watchProofStore({home:f.root,owner:OWNER});
    assert.equal(store.matching(row),null);assert.equal(store.mayRemove(row),false);assert.equal(store.gone(row),null);
    assert.throws(()=>store.own(row,{role:'app'}),/binding is invalid/);
    await assert.rejects(store.observe(row,true,{listedAt:1}),/binding is invalid/);
    await assert.rejects(store.receipt(row,1),/binding is invalid/);
    // The poller, handed an item built from the record as far as the record can name one.
    const commands=[];
    const item={name:NAME,create_incarnation:row._cleanupId??row.create_incarnation,watch_generation:row.watch_generation,state:'watch_adopted'};
    const poller=createWatchPoller({read:()=>({names:[item]}),publish:()=>{},proofs:store,
      run:async args=>{commands.push(args);return {code:0,stdout:JSON.stringify([{name:NAME}]),stderr:''};}});
    await poller.tick();await poller.drain();poller.stop();await poller.drain();
    assert.deepEqual(commands.filter(args=>args[0]==='rm'),[],'the poller never removes a name it cannot bind');
    noOwnership(f);
  });

  test(`${label}: the app backend never removes, observes or owns the name of a record with no cleanup id`,async t=>{
    const f=tree(t),row=shapes(f)[label];places(f,row);
    const commands=[];
    const journal=createSandboxCleanupJournal({directory:f.records,scratchRoot:()=>f.scratch,home:()=>f.root,destroy:async()=>({removed:false})});
    const backend=Object.assign(Object.create(DockerSbxBackend.prototype),{
      _rowHomeMatches:()=>true,_watchInventoryCurrent:()=>false,_now:()=>1_000_000,sandboxDeadlines:{observed:()=>false,cancel:async()=>false},cleanupJournal:journal,
      _rowRun:async(_row,args)=>{commands.push(args);return {code:0,stdout:'[]',stderr:''};}});
    const handle={sandbox_id:NAME,job_id:'job-no-id',sbx_home:f.root,owner_scope:OWNER};
    const proof=await backend._resolveCompute(handle).catch(error=>({error}));
    assert.equal(proof.removed,false);
    const adopted=await backend._resolveAdoptedWatch({...row,watch_state:'watch_adopted'}).catch(error=>({error}));
    assert.equal(adopted.removed??false,false);
    assert.deepEqual(commands.filter(args=>args[0]==='rm'),[],'no removal');
    assert.deepEqual(commands.filter(args=>args[0]==='ls'),[],'no listing as the record\'s owner');
    noOwnership(f);
  });

  test(`${label}: the guard alone removes the bound name, without taking an owner handle`,async t=>{
    const f=tree(t),row=shapes(f)[label];
    const commands=[],states=[];
    const target={sandbox_id:NAME,sbx_home:f.root,binary:'/fixture/sbx',deadline_at:1,deadline_clock:{version:1,boot_id:'boot',boot_ms:1}};
    // The guard's own record carries the shape under test; only its create state differs from the journal row's.
    const saved={...row,create:'dispatched',create_settled:true};
    await superviseOnTarget(target,{clock:()=>({wall:5,boot_id:'boot',boot_ms:5}),readRecord:()=>saved,publish:state=>states.push(state),
      run:async args=>{commands.push(args);return {code:0,stdout:'[]',stderr:''};}});
    assert.deepEqual(commands.filter(args=>args[0]==='rm'),[['rm','--force',NAME]]);
    assert.equal(states.at(-1).state,'removed');
    noOwnership(f);
  });
}

// Old-guard reconciliation. The record's own guard is left running whatever shape the record has; nothing is written.
test('old-guard reconcile never signals the own guard of a record with no cleanup id and writes nothing',async t=>{
  for(const label of Object.keys(shapes(tree(t)))) {
    const f=tree(t),row=shapes(f)[label];
    if(!row.sandbox_id||!row.deadline_at)continue;
    const files=places(f,row),before=bytesOf(files);
    const kills=[],payload=deadlineSupervisorPayload({...row,sandbox_id:NAME},'/fixture/sbx',f.records,'guard');
    for(const mode of ['enforcer','binding']) {
      const identity='start-'+mode,pid=424200;
      const own={...row,sandbox_id:NAME,...(mode==='enforcer'?{deadline_enforcer:{kind:'guard',pid,start:identity,binary:'/fixture/sbx'}}:{})};
      const manager=createSandboxDeadlineManager({binary:'/fixture/sbx',platform:'darwin',directory:f.records,processStart:async()=>identity,processStartSync:()=>identity,
        listProcesses:async()=>[{pid,payload}],kill:(...args)=>kills.push(args),
        stateReader:()=>({binding:deadlineBinding(payload),pid,start:identity,state:'armed'})});
      const report=await manager.reconcileGuards({directory:f.records,rowFor:id=>id===NAME?own:null});
      assert.deepEqual(kills,[],`${label}/${mode}: the guard is not signalled`);
    }
    assert.deepEqual(bytesOf(files),before);
    noOwnership(f);
  }
});


// The invariant behind the guard's exception, stated once: the proof store (and so the watcher, the journal and the app) binds a
// record if and only if it names a create (a cleanup id, or the incarnation a hand-off saves), and the guard takes the owner handle
// for exactly those records. The expectation is written out per shape, so a failure shows a behaviour that differs, not a helper.
const NAMES_A_CREATE={scratch_write_ahead:false,current_row_without_id:false,older_row_without_id:false,adopted_row_without_id:false,
  carried_incarnation:true,with_cleanup_id:true};
test('a record can be bound by the proof store exactly when it names a create, and the guard fences exactly those',async t=>{
  const f=tree(t),all={...shapes(f),carried_incarnation:carried(f),with_cleanup_id:{...carried(f),_cleanupId:randomUUID(),create_incarnation:undefined}};
  assert.deepEqual(Object.keys(all).sort(),Object.keys(NAMES_A_CREATE).sort(),'every shape has an expectation');
  for(const [label,row] of Object.entries(all)) {
    const named=NAMES_A_CREATE[label];
    const bindable={...row,watch_generation:randomUUID()},store=watchProofStore({home:f.root,owner:OWNER});
    let tenure=null;try{tenure=store.own(bindable,{role:'app'});}catch{/* No binding. */}
    tenure?.release();
    assert.equal(tenure!==null,named,`${label}: the proof store binds the record exactly when it names a create`);
    const target={sandbox_id:NAME,sbx_home:f.root,binary:'/fixture/sbx',deadline_at:1,deadline_clock:{version:1,boot_id:'boot',boot_ms:1}};
    const taken=[];
    await superviseOnTarget(target,{clock:()=>({wall:5,boot_id:'boot',boot_ms:5}),readRecord:()=>({...row,sandbox_id:NAME,create_settled:true}),publish:()=>{},
      fence:record=>{taken.push(record);return {assertCurrent(){},release(){}};},run:async()=>({code:0,stdout:'[]',stderr:''})});
    assert.equal(taken.length===1,named,`${label}: the guard fences exactly the records that can be bound`);
  }
  fs.rmSync(watchProofDirectory(f.root),{recursive:true,force:true});
});

test('a record that names its create only by incarnation is fenced: a held record is refused and a free one is removed under the guard handle',async t=>{
  const f=tree(t),row=carried(f);
  const target={sandbox_id:NAME,sbx_home:f.root,binary:'/fixture/sbx',deadline_at:1,deadline_clock:{version:1,boot_id:'boot',boot_ms:1}};
  const saved={...row,create_settled:true};
  const held=takeRecordFence(target,saved);
  const commands=[],states=[],stop=Error('one round is enough');
  await assert.rejects(superviseOnTarget(target,{clock:()=>({wall:5,boot_id:'boot',boot_ms:5}),readRecord:()=>saved,publish:state=>states.push(state),
    pause:async()=>{throw stop;},run:async args=>{commands.push(args);return {code:0,stdout:'[]',stderr:''};}}),error=>error===stop);
  held.release();
  assert.deepEqual(commands.filter(args=>args[0]==='rm'),[],'a held record is not removed');
  assert.equal(states.some(state=>state.reason==='record_held'),true);
  await superviseOnTarget(target,{clock:()=>({wall:5,boot_id:'boot',boot_ms:5}),readRecord:()=>saved,publish:()=>{},
    run:async args=>{commands.push(args);return {code:0,stdout:'[]',stderr:''};}});
  assert.deepEqual(commands.filter(args=>args[0]==='rm'),[['rm','--force',NAME]]);
  const owned=readOwnership(watchProofDirectory(f.root),NAME);
  assert.equal(owned.role,'guard');assert.equal(owned.create_incarnation,saved.create_incarnation);
});

// A fenced guard never waits without a bound.
test('a fenced guard never waits for the record and a rejected wait ends it',async t=>{
  const f=tree(t),id=randomUUID();
  const target={sandbox_id:NAME,sbx_home:f.root,binary:'/fixture/sbx',deadline_at:1,deadline_clock:{version:1,boot_id:'boot',boot_ms:1}};
  const record={version:2,_cleanupId:id,sandbox_id:NAME,sbx_home:f.root,owner_scope:OWNER,create:'dispatched',create_settled:true};
  // Another actor holds the record. The guard is told at once, removes nothing and waits only its backoff delay.
  const held=takeRecordFence(target,record);
  const commands=[],states=[],delays=[];
  const cap=Error('more than a few retries without end'),stop=Error('guard stopped');
  const started=Date.now();
  try {
    await assert.rejects(superviseOnTarget(target,{clock:()=>({wall:5,boot_id:'boot',boot_ms:5}),readRecord:()=>record,publish:state=>states.push(state),
      run:async args=>{commands.push(args);return {code:0,stdout:'[]',stderr:''};},
      // The first wait rejects once, as a stop request does. A guard that swallows it would go on to retry, so a second wait is a failure.
      pause:async ms=>{delays.push(ms);if(delays.length===1)throw stop;throw cap;}}),error=>error===stop);
  }finally{held.release();}
  assert.ok(Date.now()-started<5000,'no wait on the held record');
  assert.deepEqual(commands.filter(args=>args[0]==='rm'),[],'a held record is not removed');
  assert.equal(states.some(state=>state.reason==='record_held'),true);
  assert.equal(delays.length,1);
  assert.ok(delays.every(ms=>Number.isFinite(ms)&&ms>0&&ms<=DEADLINE_RETRY_MAX_MS),'every wait is bounded');
});

test('a fenced guard process holding the owner handle ends promptly on SIGTERM and releases it',{skip:!linux,timeout:30000},async t=>{
  const f=tree(t),home=path.join(f.root,'home'),directory=path.join(f.root,'guard-records'),present=path.join(f.root,'present');
  for(const dir of [home,directory,present])fs.mkdirSync(dir);
  fs.writeFileSync(path.join(present,NAME),'');
  const binary=path.join(f.root,'fake-sbx.mjs');
  // `ls` shows the name; `rm` never ends, so the guard stays inside its removal, holding the owner handle.
  fs.writeFileSync(binary,`#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';\nconst args=process.argv.slice(2);\n`+
    `if(args[0]==='ls')console.log(JSON.stringify(fs.readdirSync(${JSON.stringify(present)}).map(name=>({name}))));\n`+
    `else if(args[0]==='rm'){fs.writeFileSync(${JSON.stringify(path.join(f.root,'rm-started'))},String(process.pid));setInterval(()=>{},1000);}\nelse throw Error('Unexpected fake CLI command');\n`,{mode:0o700});
  const id=randomUUID(),past=Date.now()-60_000;
  const row={_cleanupId:id,sandbox_id:NAME,sbx_home:home,owner_scope:OWNER,create:'dispatched',compute_created:false,compute_stopped:false,create_settled:true,
    deadline_at:past,deadline_clock:{version:1,boot_id:clock.boot_id,boot_at:Math.max(0,clock.boot_ms-60_000)}};
  const payload=deadlineSupervisorPayload(row,binary,directory,'guard');
  fs.writeFileSync(payload.recordPath,JSON.stringify({...row,version:2}));
  const child=spawn(process.execPath,[path.resolve('lib/sandbox-deadline-supervisor.mjs'),JSON.stringify(payload)],{env:{HOME:home,PATH:process.env.PATH},stdio:['ignore','ignore','pipe']});
  const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  // A failed assertion must not leave the guard or its fake removal command running. Only the two processes this test started are
  // killed, each by PID: the guard, and the removal command whose PID it wrote (and whose command line names this fake).
  const rmStarted=path.join(f.root,'rm-started');
  try {
    const waitFor=async(check,message)=>{
      for(const end=Date.now()+10_000;Date.now()<end;){if(await check())return;await sleep(25);}
      assert.fail(message+(stderr?' ('+stderr.trim()+')':''));
    };
    const proofDirectory=watchProofDirectory(home);
    await waitFor(()=>fs.existsSync(path.join(f.root,'rm-started'))&&ownershipStatus(proofDirectory,NAME)?.held===true,'the guard did not reach its removal holding the owner handle');
    const rmPid=Number(fs.readFileSync(rmStarted,'utf8'));
    assert.equal(ownershipStatus(proofDirectory,NAME).role,'guard');
    assert.throws(()=>acquireRecordOwner({directory:proofDirectory,name:NAME,role:'app'}),{code:'lock_busy'},'the held record is refused at once, not waited for');
    const asked=Date.now();
    child.kill('SIGTERM');
    const result=await Promise.race([exited,sleep(5000).then(()=>'timeout')]);
    assert.notEqual(result,'timeout','the guard ended on SIGTERM');
    assert.ok(Date.now()-asked<3000,'the guard ended promptly');
    assert.equal(result.code,0);
    assert.equal(ownershipStatus(proofDirectory,NAME).held,false,'the owner handle is released');
    acquireRecordOwner({directory:proofDirectory,name:NAME,role:'app'}).release();
    await waitFor(()=>{try{process.kill(rmPid,0);return false;}catch(error){return error.code==='ESRCH';}},'the removal command it started is still running');
  }finally{
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    let started=null;try{started=Number(fs.readFileSync(rmStarted,'utf8'));}catch{/* The removal never started. */}
    if(Number.isSafeInteger(started)&&started>1) {
      let command='';try{command=fs.readFileSync('/proc/'+started+'/cmdline','utf8');}catch{/* Already gone. */}
      if(command.includes(binary))try{process.kill(started,'SIGKILL');}catch{/* Already gone. */}
    }
  }
});
