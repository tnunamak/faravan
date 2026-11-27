import './helpers/no-browser.mjs';
// Hermetic component lifecycle tests: real Node children, local fake CLI, fresh HOME.
// This file deliberately does not import the backend, journal, or credentials graph.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {adoptSandboxWatch,createSharedSandboxWatcher,sharedWatchBound} from '../lib/v1/sandbox-shared-watcher.mjs';
import {createSandboxDeadlineManager,deadlineProcessStart,deadlineSupervisorPayload,sandboxDeadlineClock} from '../lib/sandbox-deadline.mjs';
import {acquireProcessLockSync,processLockOwners} from '../lib/v1/lock.mjs';
import {durableWrite} from '../lib/durable-write.mjs';

const enabled=process.platform==='linux';
const first='wf-0123456789abcdef',second='wf-fedcba9876543210';
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
async function until(check,message,{timeout=8000}={}) {
  const deadline=Date.now()+timeout;
  for(;;){const result=await check();if(result)return result;if(Date.now()>=deadline)assert.fail(message);await sleep(25);}
}
// Acknowledgment proves progress at that instant. The next bounded action takes a new
// ownership epoch with zero progress until its proof write finishes; wait for that action.
const untilBound=row=>until(()=>sharedWatchBound(row),'Watcher did not make progress on '+row.sandbox_id);
function fixture(t,{blockInventory=false,transientLockConflict=false}={}) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'watch-child-'));
  const present=path.join(home,'present'),directory=path.join(home,'records'),log=path.join(home,'commands.jsonl');
  fs.mkdirSync(present);fs.mkdirSync(directory);
  const binary=path.join(home,'fake-sandbox.mjs');
  fs.writeFileSync(binary,`#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';
const home=${JSON.stringify(home)},args=process.argv.slice(2),present=path.join(home,'present');
if(process.env.HOME!==home)throw Error('Fake CLI escaped temporary HOME');
fs.appendFileSync(path.join(home,'commands.jsonl'),JSON.stringify({pid:process.pid,parent:process.ppid,args,home:process.env.HOME})+'\\n');
if(args[0]==='ls'&&${blockInventory})while(!fs.existsSync(path.join(home,'release-inventory')))await new Promise(r=>setTimeout(r,10));\nif(args.length===2&&args[0]==='ls'&&args[1]==='--json')console.log(JSON.stringify(fs.readdirSync(present).map(name=>({name}))));
else if(args.length===3&&args[0]==='rm'&&args[1]==='--force'&&/^wf-[a-f0-9]{16}$/.test(args[2]))fs.rmSync(path.join(present,args[2]),{force:true});
else throw Error('Unexpected fake CLI command');\n`,{mode:0o700});
  // Inject one transient admission conflict per real child, before it publishes status.
  const entry=path.join(home,'watcher-entry.mjs');
  if(transientLockConflict)fs.writeFileSync(entry,`import fs from 'node:fs';
const original=fs.lstatSync;let conflict=true;
fs.lstatSync=(file,...args)=>{if(conflict&&file===${JSON.stringify(path.join(home,'.faravan-shared-watch/watcher.lock'))}){conflict=false;throw Object.assign(Error('Injected admission contention'),{code:'lock_busy'});}return original(file,...args);};
const {startSharedSandboxWatcher}=await import(process.argv[2]);
try{await startSharedSandboxWatcher(JSON.parse(process.argv[3]));}catch{process.exitCode=1;}
`);
  const children=[];
  const launch=(command,args,options)=>{
    assert.equal(command,process.execPath);
    assert.deepEqual(options.env,{HOME:home});
    const child=spawn(command,transientLockConflict?[entry,...args]:args,{...options,stdio:options.stdio==='ignore'?['ignore','ignore','pipe']:['ignore','ignore','pipe','ipc']});
    const item={child,stderr:'',exited:false,exit:new Promise(resolve=>child.once('exit',(code,signal)=>{item.exited=true;item.code=code;item.signal=signal;resolve();}))};
    child.stderr.on('data',data=>item.stderr+=data);children.push(item);return child;
  };
  const watcher=()=>createSharedSandboxWatcher({home,owner:'lifecycle-owner',binary,spawnWatcher:launch});
  // Explicit non-Linux manager branch selects the detached guard without probing a service manager.
  const guard=(extra={})=>createSandboxDeadlineManager({binary,platform:'hermetic-guard',directory,spawnGuard:launch,readyTimeoutMs:2000,
    run:()=>{throw Error('Host service-manager command is forbidden');},...extra});
  const row=(name=first)=>{
    const clock=sandboxDeadlineClock();
    return {_cleanupId:randomUUID(),sandbox_id:name,sbx_home:home,owner_scope:'lifecycle-owner',create:'dispatched',compute_created:false,compute_stopped:false,
      deadline_at:clock.wall+60_000,deadline_clock:{version:1,boot_id:clock.boot_id,boot_at:clock.boot_ms+60_000}};
  };
  const adopted=source=>({...source,exec_fenced:true,watch_state:'watch_adopted',watch_generation:randomUUID(),watch_challenge:randomUUID(),watch_ack:null});
  const record=source=>path.join(directory,source._cleanupId+'.json');
  const persist=source=>durableWrite(record(source),JSON.stringify(source));
  const commands=()=>{try{return fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}catch{return [];}};
  const locations={manifest:path.join(home,'.faravan-shared-watch/names.json'),status:path.join(home,'.faravan-shared-watch/status.json'),lock:path.join(home,'.faravan-shared-watch/watcher.lock')};
  const liveChildren=()=>children.filter(item=>!item.exited);
  t.after(async()=>{
    for(const item of liveChildren())item.child.kill('SIGTERM');
    await until(()=>liveChildren().length===0,'Fixture children failed to terminate',{timeout:4000}).catch(async error=>{
      for(const item of liveChildren())item.child.kill('SIGKILL');await Promise.all(children.map(item=>item.exit));throw error;
    });
    fs.rmSync(home,{recursive:true,force:true});
  });
  return {home,present,directory,binary,children,watcher,guard,row,adopted,record,persist,commands,...locations,liveChildren};
}
function saveAck(f,row,ack) {
  row.watch_ack={challenge:ack.challenge,binary:ack.binary};f.persist(row);return row;
}

test('real concurrent launcher clients keep one live child and acknowledge both names', {skip:!enabled,timeout:30000},async t=>{
  const f=fixture(t),a=f.watcher(),b=f.watcher(),one=f.adopted(f.row()),two=f.adopted(f.row(second));
  f.persist(one);f.persist(two);
  const [ackOne,ackTwo]=await Promise.all([a.acknowledge(one),b.acknowledge(two)]);
  saveAck(f,one,ackOne);saveAck(f,two,ackTwo);
  await until(()=>f.liveChildren().length===1,'Competing watcher child did not exit');
  const state=read(f.status),holders=processLockOwners(f.lock);
  assert.notEqual(state.pid,process.pid);assert.equal(holders.length,1);assert.equal(holders[0].pid,state.pid);
  assert.equal(await deadlineProcessStart(state.pid),state.start);
  await untilBound(one);await untilBound(two);
  assert.deepEqual(read(f.manifest).names.map(row=>row.name).sort(),[first,second].sort());
  const replay={...one,watch_challenge:randomUUID(),watch_ack:null};f.persist(replay);
  saveAck(f,replay,await b.acknowledge(replay));
  await until(()=>f.liveChildren().length===1,'Replay contention left more than one live watcher');
  assert.equal(read(f.status).pid,state.pid);assert.equal(await sharedWatchBound(one),false,'A prior challenge cannot authorize retirement');
  await untilBound(replay);
  await until(()=>f.commands().some(command=>command.args[0]==='ls'),'Real fake CLI was not executed');
  assert.ok(f.commands().every(command=>command.home===f.home));
});

test('SIGKILL leaves stale status unusable; new client restarts singleton and removes a late name', {skip:!enabled,timeout:20000},async t=>{
  const f=fixture(t),manager=f.watcher(),row=f.adopted(f.row());f.persist(row);
  saveAck(f,row,await manager.acknowledge(row));
  await until(()=>f.commands().some(command=>command.args[0]==='ls'),'Initial empty inventory did not finish');
  const before=read(f.status),old=f.children.find(item=>item.child.pid===before.pid);
  old.child.kill('SIGKILL');await old.exit;
  assert.equal(read(f.status).ready,true,'A hard death deliberately retains the stale ready record');
  assert.equal(await sharedWatchBound(row),false,'Dead process identity cannot authorize guard retirement');
  assert.equal(await deadlineProcessStart(before.pid),null);
  const restarted=f.watcher(),replay={...row,watch_challenge:randomUUID(),watch_ack:null};f.persist(replay);
  saveAck(f,replay,await restarted.acknowledge(replay));
  const after=read(f.status);assert.notEqual(after.pid,before.pid);assert.notEqual(after.start,before.start);
  await untilBound(replay);assert.equal(processLockOwners(f.lock).length,1);
  await until(()=>f.commands().some(command=>command.parent===after.pid&&command.args[0]==='ls'),'Restarted child did not inventory while name was absent');
  // Appearance is after restart and an empty listing, not pre-seeded for its first poll.
  fs.writeFileSync(path.join(f.present,first),'late fake sandbox');
  await until(()=>!fs.existsSync(path.join(f.present,first)),'Restarted singleton did not remove late sandbox',{timeout:8000});
  assert.ok(f.commands().some(command=>command.parent===after.pid&&command.args.join(' ')==='rm --force '+first));
  assert.equal(read(f.manifest).names.length,1,'Successful removal does not erase persistent watch debt');
  assert.equal(read(f.record(replay)).compute_stopped,false,'Polling/removal is not cessation proof');
});


test('the original client restarts when its child dies immediately before replay acknowledgment', {skip:!enabled,timeout:12000},async t=>{
  const f=fixture(t),manager=f.watcher(),row=f.adopted(f.row());f.persist(row);
  saveAck(f,row,await manager.acknowledge(row));
  const before=read(f.status),old=f.children.find(item=>item.child.pid===before.pid);
  const replay={...row,watch_challenge:randomUUID(),watch_ack:null};f.persist(replay);
  // No event-loop yield: pending still points at the dying child when replay starts.
  old.child.kill('SIGKILL');
  saveAck(f,replay,await manager.acknowledge(replay));
  await old.exit;
  assert.notEqual(read(f.status).pid,before.pid);await untilBound(replay);
  assert.equal(processLockOwners(f.lock).length,1);
});

test('real independent guard stays alive before and after the watcher acknowledges, and never reports a hand-off', {skip:!enabled,timeout:18000},async t=>{
  const f=fixture(t),row=f.row(),manager=f.guard();f.persist(row);
  row.deadline_enforcer=await manager.register(row);f.persist(row);
  const guard=f.children.find(item=>item.child.pid===row.deadline_enforcer.pid),adopted=f.adopted(row);
  f.persist(adopted);const watcher=f.watcher(),ack=await watcher.acknowledge(adopted);
  // The watcher has durably acknowledged membership, but the cleanup record has not.
  assert.equal(await sharedWatchBound(adopted),false);
  await sleep(1200);assert.equal(guard.exited,false,'Guard ended before acknowledgment was durable in its record');
  assert.equal(await deadlineProcessStart(guard.child.pid),row.deadline_enforcer.start);
  const invalid={...adopted,watch_ack:{challenge:'wrong-challenge',binary:ack.binary}};f.persist(invalid);
  await sleep(1200);assert.equal(guard.exited,false,'A mismatched durable token must not end a guard');
  saveAck(f,adopted,ack);
  await untilBound(adopted);
  await sleep(1200);assert.equal(guard.exited,false,'A serving watcher is not a reason for a guard to end');
  assert.equal(await deadlineProcessStart(guard.child.pid),row.deadline_enforcer.start);
  const payload=deadlineSupervisorPayload(adopted,f.binary,f.directory,'guard');
  assert.notEqual(read(payload.statusPath).state,'watch_adopted','the guard never reports a hand-off');
  assert.equal(f.commands().filter(command=>command.parent===guard.child.pid).length,0,'Unexpired guard must not invoke fake inventory/removal');
});

test('an adopted name gets a guard only through recovery, and never a second one while the first runs', {skip:!enabled,timeout:15000},async t=>{
  const f=fixture(t),row=f.adopted(f.row());f.persist(row);
  const watcher=f.watcher();saveAck(f,row,await watcher.acknowledge(row));
  const before=f.children.length;
  // Design "Release rule: every pending row has a guard at startup": launch is refused, recovery restores removal.
  await assert.rejects(f.guard().register(row),/reserved for cleanup/);
  assert.equal(f.children.length,before,'a launch registration never starts a guard for an adopted name');
  const first=await f.guard().register(row,{recovery:true});
  assert.equal(f.children.length,before+1,'recovery starts the missing guard');
  const again=await f.guard().register(row,{recovery:true});
  assert.equal(again.pid,first.pid,'a guard that runs is returned, never replaced');
  assert.equal(f.children.length,before+1,'the lifetime lock on the status path stops a second guard');
  const watch=f.children.find(item=>item.child.pid===read(f.status).pid);watch.child.kill('SIGKILL');await watch.exit;
  const afterKill=f.children.length;
  assert.equal((await f.guard().register(row,{recovery:true})).pid,first.pid,'a dead singleton does not change who guards the row');
  assert.equal(f.children.length,afterKill);
});


test('public status only reports validated singleton health and never echoes saved status text', {skip:!enabled,timeout:15000},async t=>{
  const f=fixture(t),manager=f.watcher(),row=f.adopted(f.row());
  assert.deepEqual(manager.status(),{healthy:false,count:null,listing_failed:true,message:'Shared cleanup watcher is unavailable.'});
  f.persist(row);saveAck(f,row,await manager.acknowledge(row));
  await until(()=>f.commands().some(command=>command.args[0]==='ls'),'Fake CLI did not run');
  const live=read(f.status),child=f.children.find(item=>item.child.pid===live.pid);
  const healthy=manager.status();assert.equal(healthy.healthy,true);assert.equal(healthy.count,1);
  assert.deepEqual(Object.keys(healthy).sort(),['count','healthy','listing_failed','message']);
  // Freeze the real watcher only during deterministic read-only tamper cases.
  child.child.kill('SIGSTOP');
  await until(()=>fs.readFileSync('/proc/'+child.child.pid+'/stat','utf8').split(') ').at(-1).startsWith('T '),'Watcher did not stop for status tampering');
  try {
    for(const change of [{home:'/foreign/home'},{owner:'foreign-owner'},{binary:'/foreign/cli'},
      {generation:'old-generation'},{pid:process.pid},{start:'wrong-start'},{ready:false}]) {
      durableWrite(f.status,JSON.stringify({...live,...change,message:'PRIVATE RAW STATUS MUST NOT LEAK'}));
      const status=manager.status();assert.equal(status.healthy,false,JSON.stringify(change));assert.equal(status.count,1);
      assert.equal(status.message.includes('PRIVATE'),false);
    }
    durableWrite(f.status,JSON.stringify({...live,listing_failed:true,message:'PRIVATE RAW STATUS MUST NOT LEAK'}));
    assert.deepEqual(manager.status(),{healthy:true,count:1,listing_failed:true,message:'watching 1 names until listing works'});
    durableWrite(f.status,JSON.stringify(live));
  }finally{child.child.kill('SIGCONT');}
  child.child.kill('SIGKILL');await child.exit;
  assert.deepEqual(manager.status(),{healthy:false,count:1,listing_failed:true,message:'watching 1 names until watcher is available'});
  durableWrite(f.manifest,JSON.stringify({...read(f.manifest),owner:'foreign-owner'}));
  assert.deepEqual(manager.status(),{healthy:false,count:null,listing_failed:true,message:'Shared cleanup watcher is unavailable.'});
});

test('adoption requires explicit never-observed compute and an unsettled create',async()=>{
  for(const fields of [{compute_created:true},{compute_created:undefined},{compute_created:null},{create_settled:true}]) {
    const row={_cleanupId:'incarnation',sandbox_id:first,sbx_home:'/fixture/home',owner_scope:'owner',create:'dispatched',compute_created:false,...fields};
    const calls=[];
    const result=await adoptSandboxWatch({status:'watching',row},{fence:()=>calls.push('fence'),persist:()=>calls.push('persist'),
      acknowledge:async next=>(calls.push('acknowledge'),{watch_generation:next.watch_generation,challenge:next.watch_challenge,binary:'/fixture/fake'})});
    assert.deepEqual(calls,[],JSON.stringify(fields));assert.notEqual(result.admission_released,true);
  }
});

// A record counts as served only while the watcher that took it is still serving. A watcher that is stopping
// publishes "not ready" and stays alive with the same identity while it drains, so readiness is read again after the identity wait.
test('a watcher that stopped serving while its identity was being read does not count as serving', {skip:!enabled,timeout:20000},async t=>{
  const f=fixture(t),row=f.adopted(f.row());f.persist(row);
  saveAck(f,row,await f.watcher().acknowledge(row));
  await untilBound(row);
  const state=read(f.status),original=fs.readFileSync;
  let stopped=false;
  fs.readFileSync=(file,...args)=>{
    // The watcher begins to stop right as the identity lookup starts, and it is still the same live process.
    if(!stopped&&String(file)==='/proc/'+state.pid+'/stat'){stopped=true;durableWrite(f.status,JSON.stringify({...state,ready:false}));}
    return original(file,...args);
  };
  try {assert.equal(await sharedWatchBound(row),false,'a watcher that published "not ready" is not serving');}
  finally {fs.readFileSync=original;}
  assert.equal(stopped,true,'the identity lookup ran');
  assert.equal(processLockOwners(f.lock)[0].pid,state.pid,'the watcher process is still alive with the same identity');
});

test('serving waits for a delayed observation after acknowledgment', {skip:!enabled,timeout:15000},async t=>{
  const f=fixture(t,{blockInventory:true}),row=f.adopted(f.row());f.persist(row);
  saveAck(f,row,await f.watcher().acknowledge(row));
  await until(()=>f.commands().some(command=>command.args[0]==='ls'),'Inventory did not start');
  const release=acquireProcessLockSync(path.join(f.home,'.faravan-shared-watch/proofs.lock'));
  let bound;
  try {
    fs.writeFileSync(path.join(f.home,'release-inventory'),'');
    await until(()=>{const saved=read(path.join(f.home,'.faravan-shared-watch/own-'+first+'.json'));return saved?.epoch>=2&&saved.progress===0;},'Observation did not reach proof lock');
    assert.equal(await sharedWatchBound(row),false,'An unfinished action has not made progress yet');
    bound=untilBound(row);
  }finally{release();}
  await bound;
});

test('concurrent launcher children retry a transient admission conflict', {skip:!enabled,timeout:20000},async t=>{
  const f=fixture(t,{transientLockConflict:true}),one=f.adopted(f.row()),two=f.adopted(f.row(second));
  f.persist(one);f.persist(two);
  const [ackOne,ackTwo]=await Promise.all([f.watcher().acknowledge(one),f.watcher().acknowledge(two)]);
  saveAck(f,one,ackOne);saveAck(f,two,ackTwo);
  await until(()=>f.liveChildren().length===1,'Admission retries did not leave one watcher');
  await untilBound(one);await untilBound(two);
  assert.equal(processLockOwners(f.lock).length,1);
  assert.deepEqual(read(f.manifest).names.map(row=>row.name).sort(),[first,second].sort());
});
