import './helpers/no-browser.mjs';
import {superviseBound} from './helpers/supervise-bound.mjs';
// One owner per cleanup record. Each case models two or three processes with independent store instances: A is the earlier
// owner, B the later one, and C a fresh process that starts after A or B released or died. Real child processes run the guard,
// the watcher and the lock holders on Linux; the macOS identity checks use a mocked `ps` identity.
// A missing piece of the contract fails an explicit assertion, never an import.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import * as watcherModule from '../lib/v1/sandbox-shared-watcher.mjs';
import * as supervisorModule from '../lib/sandbox-deadline-supervisor.mjs';
import {createWatchPoller,createSharedSandboxWatcher} from '../lib/v1/sandbox-shared-watcher.mjs';
import {watchProofStore} from '../lib/v1/sandbox-watch-proofs.mjs';
import * as deadlineModule from '../lib/sandbox-deadline.mjs';
import {createSandboxDeadlineManager,deadlineProcessStart,sandboxDeadlineClock} from '../lib/sandbox-deadline.mjs';
import {createSandboxCleanupJournal} from '../lib/sandbox-cleanup-journal.mjs';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import {acquireProcessLockSync} from '../lib/v1/lock.mjs';
import {durableWrite} from '../lib/durable-write.mjs';

const ownerModule=await import('../lib/v1/sandbox-record-owner.mjs').catch(()=>({}));
const need=(value,what)=>{assert.ok(value,'missing contract: '+what);return value;};
const enabled=process.platform==='linux';
const NAME='wf-0123456789abcdef',OTHER='wf-fedcba9876543210';
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
async function until(check,message,{timeout=8000}={}) {
  const deadline=Date.now()+timeout;
  for(;;){const result=await check();if(result)return result;if(Date.now()>=deadline)assert.fail(message);await sleep(25);}
}

// ---- Record ownership in the proof store: independent store instances stand for independent processes. ----
function proofRoot(t) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'wf-owner-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const owner='owner-test',row={_cleanupId:randomUUID(),sandbox_id:NAME,sbx_home:home,owner_scope:owner,watch_generation:randomUUID()};
  const directory=path.join(home,'.faravan-shared-watch');
  return {home,row,directory,proofFile:path.join(directory,'proofs.json'),store:()=>watchProofStore({home,owner})};
}
const take=(store,row,role)=>need(store.own,'record ownership in the proof store (store.own)')(row,{role});

test('case 1: a late listing from an earlier owner writes nothing and cannot mark the record gone',async t=>{
  const f=proofRoot(t),A=f.store(),B=f.store(),C=f.store();
  const a=take(A,f.row,'watcher');
  a.beginListing();
  const listedByA=await A.stamp();
  // A's tenure ends while its listing is still out. B takes the record at a higher epoch and saw the name present.
  a.release();
  const b=take(B,f.row,'watcher');
  assert.ok(b.epoch>a.epoch,'the epoch rises with every owner');
  const endB=b.beginListing();
  assert.throws(()=>b.beginListing(),{code:'listing_in_flight'},'one listing at a time in a tenure');
  await B.observe(f.row,true,{listedAt:await B.stamp(),tenure:b});
  endB();
  const before=fs.readFileSync(f.proofFile,'utf8');
  // A's late, empty result arrives now. It must neither write a field nor close the record.
  await assert.rejects(A.observe(f.row,false,{listedAt:listedByA,tenure:a}),{code:'owner_lost'});
  await assert.rejects(A.receipt(f.row,Date.now(),{tenure:a}),{code:'owner_lost'});
  assert.equal(fs.readFileSync(f.proofFile,'utf8'),before,'no field changed');
  assert.equal(A.gone(f.row),null);
  b.release();
  // C starts after B: it reads the epoch and the evidence that were saved, not a process-local count.
  const c=take(C,f.row,'app');
  assert.equal(c.epoch,b.epoch+1);
  assert.equal(C.matching(f.row).seen_present,true);
  c.release();
});

test('case 3: a live holder that makes no progress is reported stalled and nobody takes the record from it',async t=>{
  const f=proofRoot(t),clock={at:Date.UTC(2026,10,8)};
  const acquire=need(ownerModule.acquireRecordOwner,'acquireRecordOwner');
  const stalled=need(ownerModule.ownershipStatus,'ownershipStatus');
  const binding={create_incarnation:f.row._cleanupId,watch_generation:f.row.watch_generation};
  const held=acquire({directory:f.directory,name:NAME,role:'watcher',binding,now:()=>clock.at});
  held.mark();
  assert.equal(stalled(f.directory,NAME,{now:clock.at}).stalled,false);
  // The wall clock jumps far ahead. The holder is still alive, so it is stalled, and it keeps the record.
  clock.at+=ownerModule.STALL_MS+60000;
  const status=stalled(f.directory,NAME,{now:clock.at});
  assert.equal(status.held,true);assert.equal(status.stalled,true,'status reports the stalled record');
  assert.throws(()=>acquire({directory:f.directory,name:NAME,role:'app',binding,now:()=>clock.at}),{code:'lock_busy'},'no clock jump takes a live holder\'s record');
  assert.throws(()=>take(f.store(),f.row,'app'),{code:'lock_busy'});
  // The holder resumes under the same epoch: it qualifies again.
  held.mark();
  const resumed=stalled(f.directory,NAME,{now:clock.at});
  assert.equal(resumed.stalled,false);assert.equal(resumed.epoch,held.epoch);
  held.release();
  assert.equal(stalled(f.directory,NAME,{now:clock.at}).held,false);
});

test('case 4a: the watcher poller removes a listed name only after the row\'s own create receipt',async t=>{
  const f=proofRoot(t),store=f.store(),item={name:NAME,create_incarnation:f.row._cleanupId,watch_generation:f.row.watch_generation,state:'watch_adopted'};
  const calls=[];
  const run=async args=>{calls.push(args);return args[0]==='ls'?{code:0,stdout:JSON.stringify([{name:NAME}])}:{code:0,stdout:''};};
  const poller=createWatchPoller({read:()=>({names:[item]}),publish:()=>{},proofs:store,run});
  await poller.tick();await poller.drain();
  assert.deepEqual(calls.filter(args=>args[0]==='rm'),[],'a listed name without a create receipt is only reported');
  poller.stop();await poller.drain();
  // With the receipt the same listing authorizes exactly one removal of the bound name.
  const tenure=take(store,f.row,'app');await store.receipt(f.row,Date.now()-1000,{tenure});tenure.release();
  const second=createWatchPoller({read:()=>({names:[item]}),publish:()=>{},proofs:f.store(),run});
  await second.tick();await second.drain();second.stop();await second.drain();
  assert.deepEqual(calls.filter(args=>args[0]==='rm'),[['rm','--force',NAME]]);
});

test('case 4b: the receipt reaches the proof store before the manifest names the record, at every crash point',{skip:!enabled,timeout:20000},async t=>{
  const f=fixture(t),row=f.adopted({...f.row(),absent_since:Date.UTC(2026,10,8)});
  f.persist(row);
  const store=watchProofStore({home:f.home,owner:'lifecycle-owner'}),manager=f.watcher({readyMs:600});
  const rename=fs.renameSync,names=()=>(read(f.manifest)?.names??[]).map(item=>item.name);
  let checked=0;
  // The invariant at every crash point: any name the manifest holds has its receipt already.
  const everyNameHasItsReceipt=()=>{for(const name of names()){assert.ok(store.mayRemove({...row,sandbox_id:name}),'a manifest name always has its receipt');checked++;}};
  // One failed rename at each durable write of the transfer in turn: the record's ownership, the receipt, and the manifest.
  for(const [point,pattern] of [['the record ownership',/own-.*\.json$/],['the receipt',/proofs\.json$/],['the manifest',/names\.json$/]]) {
    let injected=false;
    fs.renameSync=(from,to)=>{if(!injected&&pattern.test(String(to))){injected=true;throw Error('injected crash at '+point);}return rename(from,to);};
    try {await assert.rejects(manager.acknowledge(row),new RegExp('crash at '+point));}
    finally {fs.renameSync=rename;}
    assert.equal(injected,true,'the crash was injected at '+point);
    assert.equal(fs.existsSync(f.manifest),false,'the old state at '+point+': no manifest');
    everyNameHasItsReceipt();
  }
  // Retry: the whole transfer lands. The manifest names the record and the proof store already holds the receipt.
  const ack=await manager.acknowledge(row);
  assert.deepEqual(names(),[NAME]);assert.equal(store.mayRemove(row),true);assert.equal(store.matching(row).seen_absent_at,row.absent_since);
  assert.equal(ack.challenge,row.watch_challenge);
  everyNameHasItsReceipt();assert.ok(checked>=1,'the receipt check ran against a manifest that names the record');
  // The transfer is complete when the watcher's last action on the record is at an epoch of its own and made progress. It holds
  // the record only while it acts (design "Release rule: the watcher holds a record per action"), so nothing is held between.
  const owned=need(ownerModule.ownershipStatus,'ownershipStatus')(path.join(f.home,'.faravan-shared-watch'),NAME);
  assert.equal(owned.role,'watcher');assert.equal(owned.held,false);assert.ok(owned.progress>=1);
});

test('case 4c: the deadline guard removes only the name bound to its row, even after a failed listing, and writes no proof',async t=>{
  const f=proofRoot(t),recordFile=path.join(f.home,f.row._cleanupId+'.json');
  const saved={...f.row,sandbox_id:NAME,create:'dispatched',create_settled:true};
  fs.writeFileSync(recordFile,JSON.stringify(saved));
  const bytes=fs.readFileSync(recordFile,'utf8');
  const row={sandbox_id:NAME,sbx_home:f.home,binary:'/fixture/sbx',deadline_at:1,deadline_clock:{version:1,boot_id:'boot',boot_at:1}};
  const calls=[],states=[],end=Error('one round is enough');
  await assert.rejects(superviseBound(supervisorModule.superviseSandboxDeadline,row,{clock:()=>({wall:5,boot_id:'boot',boot_ms:5}),readRecord:()=>saved,
    publish:state=>states.push(state),pause:async()=>{throw end;},run:async args=>{calls.push(args);return {code:1,stdout:'',stderr:'listing failed'};}}),error=>error===end);
  assert.deepEqual(calls.filter(args=>args[0]==='rm'),[['rm','--force',NAME]],'the bound name is removed although the listing failed');
  assert.equal(states.some(state=>state.state==='removed'),false,'no removal without a listing is reported as closed');
  assert.equal(fs.existsSync(f.proofFile),false,'the guard writes no proof');
  assert.equal(fs.readFileSync(recordFile,'utf8'),bytes,'the record is not marked gone, ceased or closed');
  assert.ok(calls.every(args=>args[0]==='ls'||args.at(-1)===NAME),'no other name is touched');
});

// The guard's check and its removal are not one step unless the removal is fenced by the record owner.
const GUARD_CLOCK=()=>({wall:5,boot_id:'boot',boot_ms:5});
const guardRow=f=>({sandbox_id:NAME,sbx_home:f.home,binary:'/fixture/sbx',deadline_at:1,deadline_clock:{version:1,boot_id:'boot',boot_at:1}});

// The watcher as this process: its manifest entry, status, process lock and record tenure. What the guard may leave a record for.
function servingWatcher(f,row) {
  const directory=path.join(f.home,'.faravan-shared-watch'),generation=randomUUID();
  fs.mkdirSync(directory,{recursive:true});
  const releaseLock=acquireProcessLockSync(path.join(directory,'watcher.lock'));
  const tenure=take(f.store(),row,'watcher');tenure.mark();
  fs.writeFileSync(path.join(directory,'names.json'),JSON.stringify({version:1,home:f.home,owner:'owner-test',generation,
    names:[{name:row.sandbox_id,create_incarnation:row._cleanupId,watch_generation:row.watch_generation,state:'watch_adopted',challenge:row.watch_challenge}]}));
  fs.writeFileSync(path.join(directory,'status.json'),JSON.stringify({ready:true,pid:process.pid,start:deadlineModule.deadlineProcessStartSync(process.pid),
    home:f.home,owner:'owner-test',generation,binary:'/fixture/sbx',count:1}));
  return {tenure,release:()=>{tenure.release();releaseLock();}};
}

test('case 4d: a watcher that takes the record after the guard\'s last check is never raced by the guard\'s removal, and the guard does not leave',async t=>{
  const f=proofRoot(t),recordFile=path.join(f.home,f.row._cleanupId+'.json');
  // A create that was never settled and has no compute yet: the shape a record has when it is eligible for hand-off.
  const saved={...f.row,create:'dispatched',compute_created:false,create_settled:false,compute_stopped:false};
  fs.writeFileSync(recordFile,JSON.stringify(saved));
  const calls=[],states=[];let watcher=null,handedOffBytes=null;
  const handOff=()=>{
    if(watcher)return; // The barrier runs on every round; the hand-off happens once.
    // The real order of the hand-off: the row says watch_adopted, the watcher takes the record and makes progress, then the
    // acknowledgment is saved in the row.
    const adopted={...saved,watch_generation:randomUUID(),exec_fenced:true,watch_state:'watch_adopted',watch_challenge:randomUUID(),watch_ack:null};
    fs.writeFileSync(recordFile,JSON.stringify(adopted));
    watcher=servingWatcher(f,adopted);
    fs.writeFileSync(recordFile,JSON.stringify({...adopted,watch_ack:{challenge:adopted.watch_challenge,binary:'/fixture/sbx'}}));
    handedOffBytes=fs.readFileSync(recordFile,'utf8');
  };
  // The guard keeps its duty: it retries while the watcher holds the record, so the rounds are bounded here.
  const end=Error('enough rounds');let pauses=0;
  const outcome=superviseBound(supervisorModule.superviseSandboxDeadline,guardRow(f),{clock:GUARD_CLOCK,readRecord:()=>read(recordFile),publish:state=>states.push(state),
    pause:async()=>{if(++pauses>=3)throw end;},beforeRemove:handOff,run:async args=>{calls.push(args);return {code:0,stdout:JSON.stringify([{name:NAME}]),stderr:''};}});
  try {
    await assert.rejects(outcome,error=>error===end);
    assert.ok(watcher,'the watcher took the record at the barrier');
    assert.ok(handedOffBytes,'the barrier ran and saved the hand-off');
    assert.deepEqual(calls.filter(args=>args[0]==='rm'),[],'the guard does not remove a name the watcher holds');
    assert.equal(states.some(state=>state.state==='watch_adopted'),false,'the guard never reports a hand-off and does not end for a serving watcher');
    assert.equal(fs.readFileSync(recordFile,'utf8'),handedOffBytes,'the guard writes nothing to the record');
    assert.equal(fs.existsSync(f.proofFile),false,'the guard writes no proof');
    const owned=need(ownerModule.ownershipStatus,'ownershipStatus')(f.directory,NAME);
    assert.equal(owned.role,'watcher');assert.equal(owned.epoch,watcher.tenure.epoch,'the watcher is still the owner at its own epoch');assert.equal(owned.held,true);
  }finally{watcher?.release();}
});

test('case 4e: a hand-off that starts while the guard removes or lists afterwards is told at once and never hangs; both finish',async t=>{
  const f=proofRoot(t),recordFile=path.join(f.home,f.row._cleanupId+'.json');
  const saved={...f.row,create:'dispatched',compute_created:false,compute_stopped:false,absent_since:7};
  fs.writeFileSync(recordFile,JSON.stringify(saved));
  const calls=[];let present=true;
  const barrier=()=>{let open,reached;const started=new Promise(resolve=>reached=resolve),gate=new Promise(resolve=>open=resolve);return {started,gate,open,reached};};
  const removal=barrier(),followUp=barrier();
  const guard=superviseBound(supervisorModule.superviseSandboxDeadline,guardRow(f),{clock:GUARD_CLOCK,readRecord:()=>read(recordFile),publish:()=>{},pause:async()=>{},
    run:async args=>{
      calls.push(args);
      if(args[0]==='rm'){removal.reached();await removal.gate;present=false;return {code:0,stdout:'',stderr:''};}
      // The listing after the removal is the second step the guard holds the record across.
      if(args[0]==='ls'&&!present){followUp.reached();await followUp.gate;}
      return {code:0,stdout:JSON.stringify(present?[{name:NAME}]:[]),stderr:''};
    }});
  t.after(()=>{removal.open();followUp.open();});
  // The hand-off saves the row's create receipt under the record's lock. While the guard removes and while it lists afterwards, it
  // must answer in bounded time (an error is a valid answer: the hand-off retries), never wait for the guard.
  const adopted={...saved,exec_fenced:true,watch_state:'watch_adopted',watch_challenge:randomUUID(),watch_ack:null};
  const refused=async()=>{
    const watcher=watcherModule.createSharedSandboxWatcher({home:f.home,owner:'owner-test',binary:'/fixture/sbx',readyMs:300,spawnWatcher:()=>({on(){},unref(){}})});
    return Promise.race([watcher.acknowledge(adopted).then(()=>'answered',error=>error.code??'answered'),sleep(4000).then(()=>'hung')]);
  };
  await Promise.race([removal.started,sleep(5000).then(()=>assert.fail('the guard never reached its removal'))]);
  let answered=await refused();
  assert.notEqual(answered,'hung','the hand-off does not wait for the guard');
  assert.equal(answered,'lock_busy','the hand-off is refused at once while the guard removes');
  removal.open();
  await Promise.race([followUp.started,sleep(5000).then(()=>assert.fail('the guard never reached its follow-up listing'))]);
  answered=await refused();
  assert.equal(answered,'lock_busy','the hand-off is refused at once while the guard lists after its removal');
  followUp.open();
  await Promise.race([guard,sleep(5000).then(()=>assert.fail('the guard did not finish'))]);
  assert.deepEqual(calls.map(args=>args[0]),['ls','rm','ls'],'one listing, one removal, one follow-up listing');
  const later=take(f.store(),saved,'app');later.release();
});

test('case 4f: a row that changed before the guard fenced it is not removed, is retried, and the record is free while the guard waits',async t=>{
  const f=proofRoot(t),recordFile=path.join(f.home,f.row._cleanupId+'.json');
  const saved={...f.row,create:'dispatched',create_settled:true};
  fs.writeFileSync(recordFile,JSON.stringify(saved));
  const calls=[],states=[],taken=[],ended=Error('guard stopped by the test');let pauses=0,waiting,resume,deleted=false;
  const inPause=new Promise(resolve=>waiting=resolve),gate=new Promise(resolve=>resume=resolve);
  t.after(()=>resume());
  const guard=superviseBound(supervisorModule.superviseSandboxDeadline,guardRow(f),{clock:GUARD_CLOCK,readRecord:()=>JSON.parse(fs.readFileSync(recordFile,'utf8')),publish:state=>states.push(state),
    // Another create of this name took over the record between the guard's check and its fence.
    beforeRemove:()=>{if(!pauses)fs.writeFileSync(recordFile,JSON.stringify({...saved,_cleanupId:randomUUID()}));},
    fence:record=>{const handle=supervisorModule.takeRecordFence(guardRow(f),record);taken.push(handle);return handle;},
    // The backoff is a wait that ends normally, not by an error.
    pause:()=>{pauses++;waiting();if(deleted)throw ended;return gate;},run:async args=>{calls.push(args);return {code:0,stdout:'[]',stderr:''};}});
  await Promise.race([inPause,sleep(5000).then(()=>assert.fail('the guard never reached its backoff'))]);
  assert.deepEqual(calls.filter(args=>args[0]==='rm'),[],'a row that is no longer the guard\'s own is not removed');
  assert.ok(states.some(state=>state.state==='failed'&&state.reason==='record_changed'),'the guard reports a fixed state and retries');
  assert.ok(taken.length>=1);
  // While the guard waits out its backoff, another actor takes the record at once: the guard does not hold it across the wait.
  const later=take(f.store(),saved,'app');later.release();
  assert.ok(later.epoch>taken[0].epoch,'the guard released the record');
  // The wait ends normally. Frozen change (no ENOENT removal receipt): a vanished record is not proof of removal, so the guard keeps
  // its duty and reports the record unreadable until a gone proof exists.
  fs.rmSync(recordFile);deleted=true;resume();
  await assert.rejects(Promise.race([guard,sleep(5000).then(()=>assert.fail('the guard did not retry'))]),error=>error===ended);
  assert.equal(states.some(state=>state.state==='removed'),false);
  assert.equal(states.at(-1).reason,'record_unreadable');
});

// A not-yet-expired monotonic deadline: the guard waits, and removes nothing. `boot_at` is the schema's key for it.
test('case 4g: the guard honours the monotonic deadline of its row: it waits while time remains and removes once it has passed',async t=>{
  const f=proofRoot(t),recordFile=path.join(f.home,f.row._cleanupId+'.json');
  const saved={...f.row,create:'dispatched',create_settled:true};
  fs.writeFileSync(recordFile,JSON.stringify(saved));
  const row=(wall,bootAt)=>({...guardRow(f),deadline_at:wall,deadline_clock:{version:1,boot_id:'boot',boot_at:bootAt}});
  assert.equal(deadlineModule.validSandboxDeadline(row(100000,100000)),true,'the fixture\'s deadline is a valid one');
  const run=async deadline=>{
    const calls=[],stop=Error('one round is enough');
    // The guard either waits (the pause ends the round) or removes and ends.
    try {
      await superviseBound(supervisorModule.superviseSandboxDeadline,deadline,{clock:()=>({wall:5,boot_id:'boot',boot_ms:5}),readRecord:()=>saved,publish:()=>{},
        pause:async()=>{throw stop;},run:async args=>{calls.push(args);return {code:0,stdout:'[]',stderr:''};}});
    }catch(error){if(error!==stop)throw error;}
    return calls;
  };
  assert.deepEqual(await run(row(100000,100000)),[],'time remains on both clocks: the guard only waits');
  // The wall deadline is far away, but the monotonic one has passed (the machine slept): the monotonic bound wins.
  assert.deepEqual((await run(row(100000,5))).filter(args=>args[0]==='rm'),[['rm','--force',NAME]]);
});

test('case 6: only one remover enters a record; a stale remover cannot remove again after transfer',async t=>{
  const f=proofRoot(t),A=f.store(),B=f.store(),item={name:NAME,create_incarnation:f.row._cleanupId,watch_generation:f.row.watch_generation,state:'watch_adopted'};
  const seed=take(A,f.row,'app');await A.receipt(f.row,Date.now()-1000,{tenure:seed});seed.release();
  const removals=[];let holdRm,releaseRm;holdRm=new Promise(resolve=>{releaseRm=resolve;});
  const runB=async args=>{
    if(args[0]==='ls')return {code:0,stdout:JSON.stringify([{name:NAME}])};
    removals.push('B');await holdRm;return {code:0,stdout:''};
  };
  const runA=async args=>{if(args[0]==='rm')removals.push('A');return args[0]==='ls'?{code:0,stdout:JSON.stringify([{name:NAME}])}:{code:0,stdout:''};};
  const pollerB=createWatchPoller({read:()=>({names:[item]}),publish:()=>{},proofs:B,run:runB});
  const first=pollerB.tick();
  await until(()=>removals.length===1,'B never reached its removal');
  // B's removal command is held. A, a separate process, tries the same record: it cannot enter.
  const pollerA=createWatchPoller({read:()=>({names:[item]}),publish:()=>{},proofs:f.store(),run:runA});
  await pollerA.tick();await pollerA.drain();
  assert.deepEqual(removals,['B'],'only the holder runs the removal');
  assert.throws(()=>take(f.store(),f.row,'app'),{code:'lock_busy'});
  releaseRm();await first;await pollerB.drain();
  pollerB.stop();pollerA.stop();await pollerB.drain();await pollerA.drain();
  assert.deepEqual(removals,['B']);
});

test('case 6b: work of a tenure that has ended cannot remove again; a successor repeats only the bound name and proves nothing',async t=>{
  const f=proofRoot(t),A=f.store(),item={name:NAME,create_incarnation:f.row._cleanupId,watch_generation:f.row.watch_generation,state:'watch_adopted'};
  const seed=take(A,f.row,'app');await A.receipt(f.row,Date.now()-1000,{tenure:seed});seed.release();
  const removals=[];let release;const gate=new Promise(resolve=>{release=resolve;});let tenureB;
  const proofsB=f.store(),wrapped={...proofsB,own:(...args)=>{tenureB=proofsB.own(...args);return tenureB;}};
  const listing=async()=>({code:0,stdout:JSON.stringify([{name:NAME}])});
  let lists=0;
  const pollerB=createWatchPoller({read:()=>({names:[item]}),publish:()=>{},proofs:wrapped,
    run:async args=>{if(args[0]==='rm'){removals.push(['B',args]);return {code:0,stdout:''};}if(++lists===2)await gate;return listing();}});
  const first=pollerB.tick();
  await until(()=>lists===2,'B did not reach the listing under its tenure');
  // The record moves to another owner while B waits: its tenure ends.
  tenureB.release();release();
  await first;await pollerB.drain();
  assert.deepEqual(removals,[],'B\'s old work does not remove after the transfer');
  pollerB.stop();await pollerB.drain();
  // The holder died with its command child still running. A successor repeats the idempotent removal of the same name.
  const pollerC=createWatchPoller({read:()=>({names:[item]}),publish:()=>{},proofs:f.store(),
    run:async args=>{if(args[0]==='rm'){removals.push(['C',args]);return {code:0,stdout:''};}return listing();}});
  await pollerC.tick();await pollerC.drain();
  assert.deepEqual(removals,[['C',['rm','--force',NAME]]]);
  assert.equal(f.store().gone(f.row),null,'a successful command is not a gone proof');
  pollerC.stop();await pollerC.drain();
});

// ---- Deadline guard retry delay ----
test('the deadline guard backs off from one second, doubling to a sixty second cap',()=>{
  const delay=need(supervisorModule.deadlineRetryDelay,'deadlineRetryDelay');
  assert.deepEqual([1,2,3,4,5,6,7,8,20].map(delay),[1000,2000,4000,8000,16000,32000,60000,60000,60000]);
});

// ---- Journal: the retry writes only onto a row it still owns ----
const JOURNAL_NAME=NAME;
function journalFixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wf-owner-journal-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const directory=path.join(root,'journal'),scratch=path.join(root,'scratch');fs.mkdirSync(directory);fs.mkdirSync(scratch);
  const id=randomUUID(),row={version:2,_cleanupId:id,owner_scope:sandboxOwnerScope(),sbx_home:root,job_id:'job-owner',sandbox_id:JOURNAL_NAME,
    scratch_dir:path.join(scratch,'wf-job-'+JOURNAL_NAME+'-'+randomUUID()),create:'dispatched',compute_created:false,create_settled:false,compute_stopped:false,
    data_cleanup:'pending',policy_cleanup:'pending',exec_fenced:true,watch_state:'watch_adopted',watch_generation:randomUUID(),watch_challenge:randomUUID()};
  const record=path.join(directory,id+'.json');
  fs.writeFileSync(record,JSON.stringify(row));
  const make=(extra={})=>{
    let journal;
    journal=createSandboxCleanupJournal({directory,scratchRoot:()=>scratch,home:()=>root,destroy:async()=>({removed:false}),
      resolveAdopted:async locked=>{journal.finish(locked,{removed:true,sbx_home:locked.sbx_home,scratch_removed:false,policy_removed:false});return {};},
      retryWatchDebts:async()=>({policy_revoked:false}),...extra});
    return journal;
  };
  return {root,directory,scratch,id,row,record,make,store:()=>watchProofStore({home:root,owner:sandboxOwnerScope()})};
}
async function savedProof(f) {
  const store=f.store();
  await store.observe(f.row,true,{listedAt:await store.stamp()});await store.observe(f.row,false,{listedAt:await store.stamp()});
}

test('case 5: a stale owner\'s debt write cannot recreate a row that a newer owner finished and deleted',async t=>{
  const f=journalFixture(t);await savedProof(f);need(f.store().own,'record ownership in the proof store (store.own)');
  const A=f.store();
  let transferred;
  // A's debt retry is paused. B, in another process, takes the record, finishes it on the saved proof and deletes it.
  const journalA=f.make({retryWatchDebts:async()=>{
    const tenure=take(f.store(),f.row,'watcher');
    transferred=tenure.epoch;
    const journalB=f.make({retryWatchDebts:async()=>({policy_revoked:true}),
      resolveAdopted:async locked=>{journalB.finish(locked,{removed:true,sbx_home:locked.sbx_home,scratch_removed:true,policy_removed:true});return {};}});
    await journalB.reap();
    tenure.release();
    return {policy_revoked:false};
  }});
  await journalA.reap();
  assert.equal(fs.existsSync(f.record),false,'the deleted record is not written back by the stale owner');
  assert.ok(transferred>=1);
  // C, a restart, confirms absence and the saved epoch.
  const journalC=f.make();await journalC.reap();
  assert.equal(fs.existsSync(f.record),false);
  const c=take(A,f.row,'app');assert.ok(c.epoch>transferred,'the epoch is read back from disk');c.release();
});

test('case 5b: a newer hand-off of the name is not overwritten by the stale owner\'s debt write',async t=>{
  const f=journalFixture(t);await savedProof(f);need(f.store().own,'record ownership in the proof store (store.own)');
  const newer={...f.row,watch_generation:randomUUID(),watch_challenge:randomUUID(),watch_ack:{challenge:'newer',binary:'/fixture/watcher'}};
  const journal=f.make({retryWatchDebts:async()=>{
    const tenure=take(f.store(),f.row,'watcher');tenure.release();
    fs.writeFileSync(f.record,JSON.stringify(newer));return {policy_revoked:false};
  }});
  await journal.reap();
  const saved=JSON.parse(fs.readFileSync(f.record,'utf8'));
  assert.equal(saved.watch_challenge,newer.watch_challenge);assert.deepEqual(saved.watch_ack,newer.watch_ack);
  assert.equal(saved.watch_debt_retry,undefined);
});

test('journal retry: a same hand-off row that became invalid is kept byte for byte, and a link is not followed',async t=>{
  const f=journalFixture(t);await savedProof(f);
  const invalid=JSON.stringify({...f.row,version:999,extra:'kept as found'});
  const journal=f.make({retryWatchDebts:async()=>{fs.writeFileSync(f.record,invalid);return {policy_revoked:false};}});
  await journal.reap();
  assert.equal(fs.readFileSync(f.record,'utf8'),invalid,'an unusable row is not rewritten');
  // A symlink in place of the record: the retry neither follows it nor changes the target.
  const g=journalFixture(t);await savedProof(g);
  const target=path.join(g.root,'target.json'),targetBytes=JSON.stringify(g.row);
  const linked=g.make({retryWatchDebts:async()=>{fs.writeFileSync(target,targetBytes);fs.unlinkSync(g.record);fs.symlinkSync(target,g.record);return {policy_revoked:false};}});
  await linked.reap();
  assert.equal(fs.lstatSync(g.record).isSymbolicLink(),true,'the link stays a link');
  assert.equal(fs.readFileSync(target,'utf8'),targetBytes,'the target is not written');
});

// ---- Real watcher, guard and lock-holder processes (Linux) ----
function fixture(t) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'owner-child-'));
  const present=path.join(home,'present'),directory=path.join(home,'records'),log=path.join(home,'commands.jsonl');
  fs.mkdirSync(present);fs.mkdirSync(directory);
  const binary=path.join(home,'fake-sandbox.mjs');
  fs.writeFileSync(binary,`#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';
const home=${JSON.stringify(home)},args=process.argv.slice(2),present=path.join(home,'present');
if(process.env.HOME!==home)throw Error('Fake CLI escaped temporary HOME');
fs.appendFileSync(path.join(home,'commands.jsonl'),JSON.stringify({pid:process.pid,parent:process.ppid,args})+'\\n');
if(args.length===2&&args[0]==='ls'&&args[1]==='--json')console.log(JSON.stringify(fs.readdirSync(present).map(name=>({name}))));
else if(args.length===3&&args[0]==='rm'&&args[1]==='--force'&&/^wf-[a-f0-9]{16}$/.test(args[2]))fs.rmSync(path.join(present,args[2]),{force:true});
else throw Error('Unexpected fake CLI command');\n`,{mode:0o700});
  const children=[];
  const launch=(command,args,options)=>{
    const child=spawn(command,args,{...options,stdio:options.stdio==='ignore'?['ignore','ignore','pipe']:['ignore','ignore','pipe','ipc']});
    const item={child,exited:false,exit:new Promise(resolve=>child.once('exit',(code,signal)=>{item.exited=true;item.code=code;item.signal=signal;resolve();}))};
    child.stderr.on('data',()=>{});children.push(item);return child;
  };
  const watcher=(extra={})=>createSharedSandboxWatcher({home,owner:'lifecycle-owner',binary,spawnWatcher:launch,readyMs:5000,...extra});
  const guard=(extra={})=>createSandboxDeadlineManager({binary,platform:'hermetic-guard',directory,spawnGuard:launch,readyTimeoutMs:2000,
    // The hermetic platform name selects the detached guard; the process scan is the real Linux scan.
    listProcesses:()=>need(deadlineModule.listDeadlineGuardProcesses,'listDeadlineGuardProcesses')({platform:'linux'}),
    run:()=>{throw Error('Host service-manager command is forbidden');},...extra});
  const row=(name=NAME)=>{
    const clock=sandboxDeadlineClock();
    return {_cleanupId:randomUUID(),sandbox_id:name,sbx_home:home,owner_scope:'lifecycle-owner',create:'dispatched',compute_created:false,compute_stopped:false,
      deadline_at:clock.wall+60_000,deadline_clock:{version:1,boot_id:clock.boot_id,boot_at:clock.boot_ms+60_000}};
  };
  const adopted=source=>({...source,exec_fenced:true,watch_state:'watch_adopted',watch_generation:randomUUID(),watch_challenge:randomUUID(),watch_ack:null});
  const record=source=>path.join(directory,source._cleanupId+'.json');
  const persist=source=>durableWrite(record(source),JSON.stringify(source));
  const liveChildren=()=>children.filter(item=>!item.exited);
  t.after(async()=>{
    for(const item of liveChildren())item.child.kill('SIGTERM');
    await until(()=>liveChildren().length===0,'Fixture children failed to terminate',{timeout:4000}).catch(async()=>{
      for(const item of liveChildren())item.child.kill('SIGKILL');await Promise.all(children.map(item=>item.exit));
    });
    fs.rmSync(home,{recursive:true,force:true});
  });
  return {home,present,directory,binary,children,watcher,guard,row,adopted,record,persist,launch,liveChildren,
    manifest:path.join(home,'.faravan-shared-watch/names.json'),status:path.join(home,'.faravan-shared-watch/status.json')};
}
const saveAck=(f,row,ack)=>{row.watch_ack={challenge:ack.challenge,binary:ack.binary};f.persist(row);return row;};
const childOf=(f,pid)=>f.children.find(item=>item.child.pid===pid);

test('case 3b: a live watcher whose record makes no progress is not a replacement, whatever its status file says',{skip:!enabled,timeout:20000},async t=>{
  const f=fixture(t),row=f.adopted(f.row());f.persist(row);
  saveAck(f,row,await f.watcher().acknowledge(row));
  const serving=need(watcherModule.sharedWatchServing,'sharedWatchServing');
  // The child can already be in its next record action when acknowledgement
  // returns. A fresh tenure has no progress until that action finishes.
  await until(()=>serving(row),'the watcher serves while it makes progress',{timeout:5000});
  // The status heartbeat stays fresh and the process stays alive; only the record's progress stops. A clock jump shows it.
  const later=Date.now()+ownerModule.STALL_MS+60000;
  assert.equal(serving(row,{now:later}),null,'a fresh status heartbeat cannot acknowledge the hand-off');
  const owned=need(ownerModule.ownershipStatus,'ownershipStatus')(path.join(f.home,'.faravan-shared-watch'),NAME,{now:later});
  assert.equal(owned.stalled,true);assert.equal(owned.held,false,'the watcher holds the record only while it acts');
  // A stalled watcher is not a replacement, and it holds nothing: the app or a guard takes the record at once (design "Release rule").
  const tenure=take(watchProofStore({home:f.home,owner:'lifecycle-owner'}),row,'app');tenure.release();
});

// ---- Old guards: adopt or retire, on Linux with real children ----
test('an old guard that is the record\'s own is adopted and left running',{skip:!enabled,timeout:20000},async t=>{
  const f=fixture(t),row=f.row();f.persist(row);
  const manager=f.guard();row.deadline_enforcer=await manager.register(row);f.persist(row);
  const guard=childOf(f,row.deadline_enforcer.pid);
  const reconcile=need(manager.reconcileGuards,'reconcileGuards');
  const report=await reconcile.call(manager,{directory:f.directory,rowFor:id=>id===row._cleanupId?row:null});
  assert.deepEqual(report.adopted.map(item=>item.pid),[guard.child.pid]);
  assert.equal(report.retired,undefined);
  await sleep(400);assert.equal(guard.exited,false);
});

test('an old guard of a record this process does not own is adopted by its exact PID and start identity and left running',{skip:!enabled,timeout:20000},async t=>{
  const f=fixture(t),row=f.row();f.persist(row);
  const first=f.guard();row.deadline_enforcer=await first.register(row);
  const guard=childOf(f,row.deadline_enforcer.pid);
  // Another guard process of a different store, started by name the same way, must never be touched.
  const g=fixture(t),other=g.row();g.persist(other);
  const unrelated=await g.guard().register(other),bystander=childOf(g,unrelated.pid);
  const manager=f.guard();
  const report=await need(manager.reconcileGuards,'reconcileGuards').call(manager,{directory:f.directory,rowFor:()=>null});
  assert.deepEqual(report.adopted.map(item=>item.pid),[guard.child.pid]);
  assert.equal(report.retired,undefined,'nothing is retired in this release');
  await sleep(400);assert.equal(guard.exited,false,'the old guard keeps its row');
  assert.equal(bystander.exited,false,'a guard of another store is not matched by name');
});

test('an old guard that cannot be identified is never signalled and blocks the hand-off',{skip:!enabled,timeout:20000},async t=>{
  const f=fixture(t),row=f.row();f.persist(row);
  const kills=[],manager=f.guard({stateReader:()=>({state:'armed',pid:1234567,start:'not-this-process'}),kill:(...args)=>kills.push(args)});
  const enforcer=await f.guard().register(row);
  const guard=childOf(f,enforcer.pid);
  const report=await need(manager.reconcileGuards,'reconcileGuards').call(manager,{directory:f.directory,rowFor:()=>null});
  assert.deepEqual(report.blocked.map(item=>item.pid),[guard.child.pid]);
  assert.deepEqual(kills,[],'no signal without an exact identity');
  assert.equal(guard.exited,false);
});

test('macOS: a stray guard is adopted by the ps identity its status names, and a different identity blocks; neither is signalled',async()=>{
  const directory='/fixture/records',id=randomUUID(),identity='Sat Nov  8 10:00:00 2026 /usr/bin/node sandbox-deadline-supervisor.mjs';
  const payload={sandbox_id:NAME,sbx_home:'/fixture/home',binary:'/fixture/sbx',launchMode:'guard',deadline_at:1,recordPath:directory+'/'+id+'.json',statusPath:directory+'/'+id+'.json.deadline'};
  for(const named of [identity,'Sat Nov  8 09:00:00 2026 another process']) {
    let alive=true;const kills=[];
    const manager=createSandboxDeadlineManager({binary:'/fixture/sbx',platform:'darwin',directory,
      listProcesses:async({platform})=>{assert.equal(platform,'darwin');return [{pid:4242,payload}];},
      processStart:async()=>alive?identity:null,processStartSync:()=>alive?identity:null,
      stateReader:()=>({binding:'x',pid:4242,start:named,state:'armed'}),
      kill:(pid,signal)=>{kills.push([pid,signal]);alive=false;}});
    const report=await need(manager.reconcileGuards,'reconcileGuards').call(manager,{directory,rowFor:()=>null});
    assert.deepEqual(kills,[]);
    if(named===identity)assert.deepEqual(report.adopted.map(item=>item.pid),[4242]);
    else assert.deepEqual(report.blocked.map(item=>item.pid),[4242]);
  }
});
