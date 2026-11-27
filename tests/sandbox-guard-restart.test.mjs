import './helpers/no-browser.mjs';
// Missing guards use startup registration on later recovery passes (docs/design/SANDBOX-CLEANUP-RECOVERY.md,
// "Release rule: restore guards at startup and on later passes"). Liveness checks status binding and process start identity;
// the lifetime lock excludes duplicate supervisors.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createWatchPoller} from '../lib/v1/sandbox-shared-watcher.mjs';
import {watchProofStore} from '../lib/v1/sandbox-watch-proofs.mjs';
import {setTimeout as sleep} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {createSandboxCleanupJournal} from '../lib/sandbox-cleanup-journal.mjs';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import {createSandboxDeadlineManager,deadlineSupervisorPayload,sandboxDeadlineClock,deadlineProcessStartSync,listDeadlineGuardProcesses} from '../lib/sandbox-deadline.mjs';
import {acquireProcessLockSync,processLockOwners} from '../lib/v1/lock.mjs';
import {appFixture,syntheticBackend,waitFor} from './helpers/v1-app-fixture.mjs';

const enabled=process.platform==='linux';
const T={skip:!enabled,timeout:40000};
const NAMES=['wf-0123456789abcdef','wf-fedcba9876543210','wf-00000000000000aa'];
async function until(check,message,{timeout=10000}={}) {
  const deadline=Date.now()+timeout;
  for(;;){const result=await check();if(result)return result;if(Date.now()>=deadline)assert.fail(message);await sleep(25);}
}
function fixture(t) {
  const home=fs.mkdtempSync(path.join(os.homedir(),'.tmp','sandbox-guard-restart-')),present=path.join(home,'present'),directory=path.join(home,'records'),scratch=path.join(home,'scratch'),log=path.join(home,'commands.jsonl');
  for(const dir of [present,directory,scratch])fs.mkdirSync(dir);
  const binary=path.join(home,'fake-sandbox.mjs');
  fs.writeFileSync(binary,`#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';
const home=${JSON.stringify(home)},args=process.argv.slice(2),present=path.join(home,'present');
if(process.env.HOME!==home)throw Error('Fake CLI escaped temporary HOME');
fs.appendFileSync(path.join(home,'commands.jsonl'),JSON.stringify({pid:process.pid,parent:process.ppid,args})+'\\n');
if(args.length===2&&args[0]==='ls'&&args[1]==='--json')console.log(JSON.stringify(fs.readdirSync(present).map(name=>({name}))));
else if(args.length===3&&args[0]==='rm'&&args[1]==='--force'&&/^wf-[a-f0-9]{16}$/.test(args[2]))fs.rmSync(path.join(present,args[2]),{force:true});
else throw Error('Unexpected fake CLI command');\n`,{mode:0o700});
  const children=[],commands=[],cleanupBefore=[];
  const launch=(command,args,options)=>{
    const child=spawn(command,args,{...options,stdio:['ignore','ignore','pipe','ipc']});
    const item={child,exited:false,exit:new Promise(resolve=>child.once('exit',()=>{item.exited=true;resolve();}))};
    child.stderr.on('data',()=>{});children.push(item);commands.push(child.pid);return child;
  };
  const manager=()=>createSandboxDeadlineManager({binary,platform:'hermetic-guard',directory,spawnGuard:launch,readyTimeoutMs:3000,
    run:()=>{throw Error('Host service-manager command is forbidden');}});
  const journal=()=>createSandboxCleanupJournal({directory,scratchRoot:()=>scratch,home:()=>home,destroy:async()=>({removed:false,watching:true}),retryWatchDebts:async()=>({policy_revoked:false})});
  // `shape`: 'unseen' is a create that may still materialize (the sandbox was never observed); 'created' is a sandbox that exists.
  const row=(name,{seconds=3600,shape='unseen'}={})=>{
    const clock=sandboxDeadlineClock(),id=randomUUID();
    return {version:2,_cleanupId:id,owner_scope:sandboxOwnerScope(),sbx_home:home,job_id:'job-'+id.slice(0,8),sandbox_id:name,
      scratch_dir:path.join(scratch,'wf-job-'+name+'-'+randomUUID()),create:'dispatched',compute_created:shape==='created',create_settled:shape==='created',compute_stopped:false,
      data_cleanup:'pending',policy_cleanup:'pending',deadline_at:clock.wall+seconds*1000,deadline_clock:{version:1,boot_id:clock.boot_id,boot_at:clock.boot_ms+seconds*1000}};
  };
  const file=r=>path.join(directory,r._cleanupId+'.json');
  const save=r=>fs.writeFileSync(file(r),JSON.stringify(r));
  const saved=r=>JSON.parse(fs.readFileSync(file(r),'utf8'));
  const lock=r=>deadlineSupervisorPayload(r,binary,directory,'guard').statusPath+'.lock';
  const holders=r=>processLockOwners(lock(r));
  const live=()=>children.filter(item=>!item.exited);
  const clean=async()=>{for(const cleanup of cleanupBefore)await cleanup();for(const item of live())item.child.kill('SIGKILL');await Promise.all(children.map(item=>item.exit));fs.rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:50});};
  t.after(clean);
  return {home,present,directory,binary,manager,journal,row,save,saved,holders,live,children,launch,cleanupBefore,commands:()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[]};
}
const noWatcher={acknowledge:async()=>assert.fail('a row with a deadline is never handed off')};
const pass=(f,manager)=>f.journal().recoverDeadlines(manager,{watcher:noWatcher});

for(const shape of ['unseen','created'])test('R1 ('+shape+'): a pending row whose guard process dies has a new guard holding the lifetime lock after one pass',T,async t=>{
  const f=fixture(t),manager=f.manager(),row=f.row(NAMES[0],{shape});
  f.save(row);row.deadline_enforcer=await manager.register(row);f.save(row);
  const first=f.children.find(item=>item.child.pid===row.deadline_enforcer.pid);
  assert.equal(f.holders(row)[0]?.pid,first.child.pid,'the guard holds its lifetime lock');
  first.child.kill('SIGKILL');await first.exit;
  assert.deepEqual(f.holders(row),[],'the crash released the lifetime lock');
  const report=await pass(f,manager);
  assert.equal(report.rows.find(item=>item.id===row._cleanupId).protected,true);
  const owners=f.holders(row);
  assert.equal(owners.length,1,'one guard holds the lifetime lock after the pass');
  assert.notEqual(owners[0].pid,first.child.pid);
  assert.equal(f.saved(row).deadline_enforcer.pid,owners[0].pid,'the row names the new guard');
});

for(const shape of ['unseen','created'])test('R2 ('+shape+'): two passes and a startup recovery racing on one row start exactly one guard',T,async t=>{
  const f=fixture(t),row=f.row(NAMES[0],{shape});f.save(row);
  // Three recoveries at once, each with its own journal and manager, as startup and two loop passes would run them.
  const reports=await Promise.all([pass(f,f.manager()),pass(f,f.manager()),pass(f,f.manager())]);
  assert.equal(reports.length,3);
  await until(()=>f.holders(row).length>0,'a guard holds the lifetime lock');
  assert.equal(f.children.length,f.children.filter(item=>!item.exited).length+f.children.filter(item=>item.exited).length);
  await sleep(300);
  assert.equal(f.holders(row).length,1,'one guard holds the lifetime lock');
  assert.equal(f.live().length,1,'exactly one guard process is running for the row');
  assert.equal(f.saved(row).deadline_enforcer.pid,f.holders(row)[0].pid);
});

test('R3: a pass registers one guard per pending row and counts no row twice, up to the cap',T,async t=>{
  const f=fixture(t),manager=f.manager(),rows=Array.from({length:16},(_,i)=>f.row('wf-'+i.toString(16).padStart(16,'0')));
  for(const row of rows)f.save(row);
  const journal=f.journal();
  await journal.recoverDeadlines(manager,{watcher:noWatcher});
  assert.equal(f.live().length,16,'one guard per row');
  assert.equal(journal.retainedGuards(),16);
  await journal.recoverDeadlines(manager,{watcher:noWatcher});await journal.recoverDeadlines(manager,{watcher:noWatcher});
  assert.equal(f.live().length,16,'later passes start no further guard');
  assert.equal(f.children.length,16);
  assert.equal(journal.retainedGuards(),16,'a row is counted once');
  assert.equal(journal.backlogHold(),null,'cleanup isolation rule: row counts never stop the whole lender');
});

for(const shape of ['unseen','created'])test('R4 ('+shape+'): a guard restarted by a pass removes a sandbox that appears after the crash, by its deadline',T,async t=>{
  const f=fixture(t),manager=f.manager(),row=f.row(NAMES[0],{seconds:4,shape});
  f.save(row);row.deadline_enforcer=await manager.register(row);f.save(row);
  const first=f.children.find(item=>item.child.pid===row.deadline_enforcer.pid);
  first.child.kill('SIGKILL');await first.exit;
  await pass(f,manager);
  assert.equal(f.holders(row).length,1);
  fs.writeFileSync(path.join(f.present,NAMES[0]),'late sandbox');
  await until(()=>!fs.existsSync(path.join(f.present,NAMES[0])),'the restarted guard removed the late sandbox',{timeout:15000});
  assert.ok(f.commands().some(command=>command.args.join(' ')==='rm --force '+NAMES[0]));
});

test('R5: the app\'s own cleanup loop restarts a crashed guard with no app restart and no other trigger',T,async t=>{
  const f=fixture(t),manager=f.manager(),row=f.row(NAMES[0]);
  // A guard can publish before registration returns and recovery saves its descriptor.
  const register=manager.register.bind(manager);
  manager.register=async(...args)=>{const saved=await register(...args);await sleep(150);return saved;};
  f.save(row);row.deadline_enforcer=await manager.register(row);f.save(row);
  const first=f.children.find(item=>item.child.pid===row.deadline_enforcer.pid);
  // The real app and its real cleanup timer; recovery is the real journal pass over the real guards.
  const app=await appFixture(t),backend=syntheticBackend(app.root);let passes=0;
  backend.recoverSandboxDeadlines=async()=>{passes++;return f.journal().recoverDeadlines(manager,{watcher:noWatcher});};
  backend.reapCleanup=async()=>{};
  await app.start('guard-restart-loop',{backend,cleanupRecheckMs:100});
  await waitFor(()=>passes>=1,'the startup pass ran',10000);
  assert.equal(f.holders(row)[0]?.pid,first.child.pid,'the startup pass keeps the live guard');
  const before=passes;
  first.child.kill('SIGKILL');await first.exit;
  const next=await waitFor(()=>f.holders(row)[0]?.pid!==first.child.pid&&f.holders(row)[0],'a new guard holds the lifetime lock',10000);
  assert.ok(passes>before,'a loop pass, not startup, started it');
  await waitFor(()=>f.saved(row).deadline_enforcer.pid===next.pid,'the recovery pass saved its replacement guard',10000);
  assert.equal(f.saved(row).deadline_enforcer.pid,next.pid);
  assert.equal(f.live().length,1);
});

test('R2b: two registrations of one row at the same moment, from two processes\' managers, leave exactly one guard holding the lifetime lock',T,async t=>{
  const f=fixture(t),row=f.row(NAMES[0]);f.save(row);
  // Bypasses the record lock that serializes recovery (protect() in the journal), so the lifetime lock alone decides. The
  // loser's guard may exit before the winner has published its identity; that caller then gets a retryable error, never a guard.
  const results=await Promise.allSettled([f.manager().register(row,{recovery:true}),f.manager().register(row,{recovery:true})]);
  const won=results.filter(item=>item.status==='fulfilled').map(item=>item.value);
  assert.ok(won.length>=1,'at least one caller is told the guard that holds the lock');
  assert.equal(new Set(won.map(item=>item.pid)).size,1,'every caller that succeeds is told the same guard');
  await sleep(300);
  assert.equal(f.live().length,1,'the lock stopped the second guard process');
  assert.equal(f.holders(row).length,1);
  assert.equal(f.holders(row)[0].pid,won[0].pid);
});

test('R6: a dead guard\'s number now held by an unrelated live process does not count as a live guard, and that process is left alone',T,async t=>{
  const f=fixture(t),manager=f.manager(),row=f.row(NAMES[0]);
  f.save(row);row.deadline_enforcer=await manager.register(row);f.save(row);
  const first=f.children.find(item=>item.child.pid===row.deadline_enforcer.pid);
  const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  t.after(()=>{if(unrelated.exitCode===null&&unrelated.signalCode===null)unrelated.kill('SIGKILL');});
  first.child.kill('SIGKILL');await first.exit;
  // The status file keeps the dead guard's start identity but names the unrelated process's PID, as a recycled PID would.
  const status=deadlineSupervisorPayload(row,f.binary,f.directory,'guard').statusPath;
  fs.writeFileSync(status,JSON.stringify({...JSON.parse(fs.readFileSync(status,'utf8')),pid:unrelated.pid}));
  await pass(f,manager);
  assert.equal(f.holders(row).length,1);
  assert.notEqual(f.holders(row)[0].pid,unrelated.pid);
  assert.equal(unrelated.exitCode,null);assert.equal(unrelated.signalCode,null,'the unrelated process was never signalled');
});

for(const afterScan of [false,true])test('legacy guard retires during a short current watcher action; recovery '+(afterScan?'on the next scan':'after retirement')+' restores removal',T,async t=>{
  const f=fixture(t),manager=f.manager(),row=f.row(NAMES[0],{seconds:5});
  Object.assign(row,{exec_fenced:true,watch_state:'watch_adopted',watch_generation:randomUUID(),watch_challenge:randomUUID(),create_incarnation:row._cleanupId});
  row.watch_ack={challenge:row.watch_challenge,binary:f.binary};f.save(row);
  const payload=deadlineSupervisorPayload(row,f.binary,f.directory,'guard');
  const oldFile=fileURLToPath(new URL('./fixtures/legacy-deadline/sandbox-deadline-supervisor.mjs',import.meta.url));
  const old=f.launch(process.execPath,[oldFile,JSON.stringify(payload)],{env:{HOME:f.home},stdio:['ignore','ignore','ignore','ipc']});
  await until(()=>f.holders(row)[0]?.pid===old.pid,'historical guard acquired its lifetime lock');
  const oldItem=f.children.find(item=>item.child===old);
  const proofs=watchProofStore({home:f.home,owner:row.owner_scope}),generation=randomUUID();
  fs.mkdirSync(proofs.directory,{recursive:true});
  const releaseWatcher=acquireProcessLockSync(path.join(proofs.directory,'watcher.lock'));f.cleanupBefore.push(releaseWatcher);
  const item={name:row.sandbox_id,create_incarnation:row._cleanupId,watch_generation:row.watch_generation,challenge:row.watch_challenge,state:'watch_adopted'};
  fs.writeFileSync(path.join(proofs.directory,'names.json'),JSON.stringify({version:1,home:f.home,owner:row.owner_scope,generation,names:[item]}));
  fs.writeFileSync(path.join(proofs.directory,'status.json'),JSON.stringify({home:f.home,owner:row.owner_scope,generation,binary:f.binary,ready:true,pid:process.pid,start:deadlineProcessStartSync(process.pid)}));
  assert.equal(proofs.mayRemove(row),false,'no absence receipt authorizes watcher removal');
  let scanned,scannedResolve;scanned=new Promise(resolve=>{scannedResolve=resolve;});
  let actionResolve;const action=new Promise(resolve=>{actionResolve=resolve;});let releaseAction;
  const finishAction=new Promise(resolve=>{releaseAction=resolve;});
  const originalObserve=proofs.observe.bind(proofs);
  proofs.observe=async(...args)=>{
    const result=await originalObserve(...args);args[2].tenure.mark();actionResolve();
    await finishAction;return result;
  };
  const poller=createWatchPoller({read:()=>({names:[item]}),publish:()=>{},proofs,run:async()=>({code:0,stdout:'[]'})});
  f.cleanupBefore.unshift(async()=>{releaseAction();poller.stop();await poller.drain();});
  const startAction=async()=>{
    poller.claim([item]);const tick=poller.tick();await action;
    await until(()=>oldItem.exited,'historical serving predicate retired the guard');
    assert.equal(JSON.parse(fs.readFileSync(payload.statusPath,'utf8')).state,'watch_adopted');
    releaseAction();await tick;await poller.drain();poller.stop();
    assert.deepEqual(f.holders(row),[],'there is a real interval without a guard');
  };
  if(afterScan){
    let scannedOld=false;
    const scanning=createSandboxDeadlineManager({binary:f.binary,platform:'hermetic-guard',directory:f.directory,spawnGuard:f.launch,
      listProcesses:async()=>{const found=await listDeadlineGuardProcesses({platform:'linux'});scannedResolve();return found;},
      processStart:async pid=>{if(pid===old.pid&&!scannedOld){scannedOld=true;const identity=deadlineProcessStartSync(pid);await scanned;await startAction();return identity;}return deadlineProcessStartSync(pid);}});
    row.deadline_enforcer={kind:'guard',pid:old.pid,start:deadlineProcessStartSync(old.pid),binary:f.binary};f.save(row);
    await pass(f,scanning);
    assert.equal(f.holders(row).length,1,'startup replaces the older build in this pass');
    assert.notEqual(f.holders(row)[0].pid,old.pid,'the old build is not retained');
  }else await startAction();
  assert.equal(f.saved(row).watch_ack.challenge,row.watch_challenge,'old acknowledgment is retained');
  await pass(f,manager);
  assert.equal(f.holders(row).length,1,'the next fresh pass installs a current guard');
  assert.notEqual(f.holders(row)[0].pid,old.pid);
  fs.writeFileSync(path.join(f.present,row.sandbox_id),'late sandbox');
  await until(()=>!fs.existsSync(path.join(f.present,row.sandbox_id)),'the current guard removes the late sandbox',{timeout:15000});
  assert.ok(f.commands().some(command=>command.args.join(' ')==='rm --force '+row.sandbox_id));
});
