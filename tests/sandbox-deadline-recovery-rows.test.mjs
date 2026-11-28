import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {AsyncLocalStorage} from 'node:async_hooks';
import {deadlineRecoveryHold as recoveryHoldFor,deadlineRecoveryError} from '../lib/sandbox-remediation.mjs';
import {createDeadlineRecoveryGate} from '../lib/v1/deadline-recovery-gate.mjs';
import {createSandboxCleanupJournal} from '../lib/sandbox-cleanup-journal.mjs';
import {acquireProcessLockSync,processLockOwners} from '../lib/v1/lock.mjs';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import {createSandboxDeadlineManager,deadlineSupervisorPayload,deadlineBinding,sandboxDeadlineUnit,sandboxDeadlineRemaining,SANDBOX_GUARD_BUILD_ID} from '../lib/sandbox-deadline.mjs';

const clock=()=>({wall:10000,boot_id:'fixture',boot_ms:10000});
const watch={removed:false,watching:true,scratch_removed:false,policy_removed:true};
function fixture(t,{count=2,destroy}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-rows-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const directory=path.join(root,'journal'),scratch=path.join(root,'scratch');
  fs.mkdirSync(directory,{mode:0o700});fs.mkdirSync(scratch);
  const rows=Array.from({length:count},(_,i)=>{
    const id=randomUUID(),name='wf-'+i.toString(16).padStart(16,'0');
    // Same durable receipt shape as writeCreateReceipt(), without importing the backend graph.
    const row={version:2,_cleanupId:id,owner_scope:sandboxOwnerScope(),sbx_home:root,job_id:'job-'+i,sandbox_id:name,
      scratch_dir:path.join(scratch,'wf-job-'+name+'-'+randomUUID()),create:'dispatched',compute_created:false,create_settled:false,
      absent_since:0,compute_stopped:false,data_cleanup:'pending',policy_cleanup:'removed',deadline_at:1000,deadline_clock:{version:1,boot_id:'fixture',boot_at:1000}};
    fs.writeFileSync(path.join(directory,id+'.json'),JSON.stringify(row));return row;
  });
  const calls=[],armed=new Set(),registers=[];
  // The existing fakeSandboxDeadlines armed-set contract, without its backend import.
  const manager={active:async row=>armed.has(row._cleanupId),activeSync:row=>armed.has(row._cleanupId),register:async row=>{registers.push(row._cleanupId);armed.add(row._cleanupId);return {kind:'systemd',unit:sandboxDeadlineUnit(row),binary:'/fake/sbx'};}};
  const journal=createSandboxCleanupJournal({directory,scratchRoot:()=>scratch,home:()=>root,destroy:async row=>{calls.push(row._cleanupId);return destroy?destroy(row):watch;}});
  const file=row=>path.join(directory,row._cleanupId+'.json');
  return {root,directory,rows,calls,armed,manager,registers,journal,file,recover:()=>journal.recoverDeadlines(manager,{clock})};
}
const resultRow=(report,row)=>report.rows.find(item=>item.id===row._cleanupId);
for(const kind of ['record','name'])test('own '+kind+' lock is deferred unchanged, without waiting, while siblings recover',async t=>{
  const f=fixture(t),row=f.rows[0],file=f.file(row),before=fs.readFileSync(file);
  const lock=kind==='record'?file+'.lock':path.join(f.directory,row.sandbox_id+'.scope');
  const release=acquireProcessLockSync(lock);
  try {
    const report=await f.recover();
    assert.equal(resultRow(report,row).status,'in_progress');
    assert.equal(resultRow(report,f.rows[1]).status,'watching');
    assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(f.calls,[f.rows[1]._cleanupId]);
    assert.equal(processLockOwners(lock).length,1,'recovery does not release the owner');
  }finally{release();}
});

async function foreignLock(t,lock) {
  const module=new URL('../lib/v1/lock.mjs',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`import {acquireProcessLockSync} from ${JSON.stringify(module)}; const release=acquireProcessLockSync(process.argv[1]); process.send('held'); process.once('message',()=>{release();process.disconnect();});`,lock],{stdio:['ignore','pipe','pipe','ipc']});
  let error='';child.stderr.on('data',data=>{error+=data;});
  await Promise.race([once(child,'message'),once(child,'exit').then(([code])=>{throw Error('lock child exited '+code+': '+error);})]);
  const close=async()=>{if(child.exitCode!==null)return;const done=once(child,'exit');child.send('release');await done;};
  close.pid=child.pid;t.after(close);return close;
}
for(const kind of ['record','name'])test('different live process '+kind+' lock fails closed only for its row',async t=>{
  const f=fixture(t),row=f.rows[0],file=f.file(row),before=fs.readFileSync(file);
  const lock=kind==='record'?file+'.lock':path.join(f.directory,row.sandbox_id+'.scope');
  const close=await foreignLock(t,lock);
  try {
    const report=await f.recover();
    assert.equal(resultRow(report,row).status,'foreign_locked');
    assert.equal(resultRow(report,f.rows[1]).status,'watching');
    assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(f.calls,[f.rows[1]._cleanupId]);
    assert.notEqual(processLockOwners(lock)[0].pid,process.pid);
  }finally{await close();}
});

test('one malformed record among twelve does not poison the eleven good resolutions',async t=>{
  const f=fixture(t,{count:12}),bad=f.rows[0];fs.writeFileSync(f.file(bad),'not-json');
  const report=await f.recover();
  assert.equal(resultRow(report,bad).status,'failed');assert.equal(report.complete,false);
  assert.equal(report.rows.filter(row=>row.status==='watching').length,11);
  assert.deepEqual(new Set(f.calls),new Set(f.rows.slice(1).map(row=>row._cleanupId)));
  assert.equal(fs.readFileSync(f.file(bad),'utf8'),'not-json');
  for(const row of f.rows.slice(1)){const saved=JSON.parse(fs.readFileSync(f.file(row)));assert.equal(saved.compute_stopped,false);assert.equal(saved.compute_created,false);}
});

test('destroy failure is named and does not prevent eleven sibling recoveries',async t=>{
  const f=fixture(t,{count:12,destroy:async row=>row.job_id==='job-0'?{removed:false}:watch});
  const report=await f.recover();assert.equal(resultRow(report,f.rows[0]).status,'failed');
  assert.equal(resultRow(report,f.rows[0]).name,f.rows[0].sandbox_id);
  assert.equal(report.rows.filter(row=>row.status==='watching').length,11);assert.equal(f.calls.length,12);
});

test('unknown legacy lock is foreign, remains intact, and does not stop its sibling',async t=>{
  const f=fixture(t),row=f.rows[0],lock=f.file(row)+'.lock';fs.writeFileSync(lock,'unknown');
  const report=await f.recover();assert.equal(resultRow(report,row).status,'foreign_locked');
  assert.equal(resultRow(report,f.rows[1]).status,'watching');assert.equal(fs.readFileSync(lock,'utf8'),'unknown');
});

test('live matching guard holding deadline.lock is protection, not foreign cleanup contention',async t=>{
  let sawGuardBinding=false;
  const f=fixture(t,{count:1,destroy:async row=>{sawGuardBinding=row.deadline_enforcer?.kind==='guard';return watch;}}),row=f.rows[0];
  const close=await foreignLock(t,f.file(row)+'.deadline.lock');
  const payload=deadlineSupervisorPayload(row,'/fake/sbx',f.directory,'guard');
  const state={build_id:SANDBOX_GUARD_BUILD_ID,state:'armed',pid:close.pid,start:'matching-guard',binding:deadlineBinding(payload)};
  const manager=createSandboxDeadlineManager({binary:'/fake/sbx',directory:f.directory,platform:'linux',clock,
    run:async()=>({code:1,stdout:'',stderr:''}),stateReader:()=>state,processStart:async pid=>pid===state.pid?state.start:null,
    spawnGuard:()=>assert.fail('must not spawn or replace the already proven guard')});
  try {
    const report=await f.journal.recoverDeadlines(manager,{clock});
    assert.equal(resultRow(report,row).status,'watching');assert.equal(resultRow(report,row).protected,true);
    assert.equal(sawGuardBinding,true,'destroy must see the guard binding before consulting observed()');
    assert.equal(processLockOwners(f.file(row)+'.deadline.lock').length,1);
    const saved=JSON.parse(fs.readFileSync(f.file(row)));assert.equal(saved.compute_stopped,false);
    assert.equal(saved.deadline_enforcer.kind,'guard');assert.equal(await manager.active(saved,{recovery:true}),true);
    state.observed=true;assert.equal(manager.observed(saved),true,'future materialization proof uses the preserved guard binding');
  }finally{await close();}
});

test('an unbound deadline lock is foreign and never adopted',async t=>{
  const f=fixture(t,{count:2}),row=f.rows[0],lock=f.file(row)+'.deadline.lock';
  const release=acquireProcessLockSync(lock);
  try {const report=await f.recover();assert.equal(resultRow(report,row).status,'foreign_locked');assert.equal(resultRow(report,f.rows[1]).status,'watching');assert.equal(f.registers.includes(row._cleanupId),false);}
  finally{release();}
});

// Execute only this exact production method with injected dependencies. This is
// gate contract coverage, not a replacement for the host's full backend/app run.
function recoveryGate(journal,home='/fake-home') {
  const source=fs.readFileSync(new URL('../lib/docker-backend.mjs',import.meta.url),'utf8');
  const start=source.indexOf('  deadlineRecoveryHold() {'),end=source.indexOf('  async inspectCleanupRemediation',start);
  assert.ok(start>0&&end>start);
  const admitStart=source.indexOf('  async admitJob(job,{version,accountBroker=false}={}) {'),admitEnd=source.indexOf('  async prepareSignIn(',admitStart);
  assert.ok(admitStart>0&&admitEnd>admitStart,'the production admitJob method is found');
  const statusStart=source.indexOf('  cleanupStatus(options)'),statusEnd=source.indexOf('  _invalidateOwnedStartupRecovery()',statusStart);
  const methods=Function('sbxHome','daemonJobContext','deadlineRecoveryContext','recoveryHoldFor','deadlineRecoveryError','policyError','borrowedCredentialMechanismAllowed','admitDockerJob','sandboxDeadlineRemaining',
    'return new class {'+source.slice(start,end)+source.slice(admitStart,admitEnd)+source.slice(statusStart,statusEnd)+'}')(
    ()=>home,new AsyncLocalStorage(),new AsyncLocalStorage(),recoveryHoldFor,deadlineRecoveryError,(code,message,details)=>Object.assign(Error(message),{code,...details}),()=>true,()=>({ok:true}),sandboxDeadlineRemaining);
  // Transport availability is covered separately; this seam assumes it succeeds.
  return Object.assign(methods,{_cleanupListingReady:async()=>{},cleanupJournal:journal,sandboxDeadlines:{},deadlineClock:clock,_legacyDaemonOptions:{platformName:'linux'},_rowHomeMatches:()=>true});
}

test('startup and probe gate calls return partial reports and retry rather than caching them',async()=>{
  let calls=0;const report={complete:false,rows:[{id:'bad',name:'wf-0000000000000000',status:'failed'},...Array.from({length:11},(_,i)=>({id:String(i),status:'watching',protected:true}))]};
  const backend=recoveryGate({recoverDeadlines:async()=>{calls++;return report;}});
  for(const purpose of ['startup','probe'])assert.equal(await backend.recoverSandboxDeadlines(),report,purpose+' receives the set instead of sandbox_start_failed');
  assert.equal(calls,2,'a partial result cannot become permanent success');
});

// Cleanup isolation rule: unreadable recovery stays local; never invent removal proof.
test('journal-wide unreadability retains local debt',async()=>{
  const backend=recoveryGate({recoverDeadlines:async()=>({complete:false,fatal:'journal_unavailable',rows:[]})});
  const report=await backend.recoverSandboxDeadlines();assert.equal(report.complete,false);assert.equal(report.rows[0].status,'failed');assert.equal(backend.deadlineRecoveryHold(),null);
});

test('concurrent recovery shares one flight, not a permanently cached proof',async()=>{
  let resume,calls=0;const gate=new Promise(resolve=>{resume=resolve;});
  const backend=recoveryGate({recoverDeadlines:async()=>{calls++;await gate;return {complete:true,rows:[]};}});
  const first=backend.recoverSandboxDeadlines(),second=backend.recoverSandboxDeadlines();assert.equal(first,second);
  resume();await first;await backend.recoverSandboxDeadlines();assert.equal(calls,2);
});

for(const kind of ['record','name'])test('one live foreign '+kind+' holder among twelve does not reject startup or probe recovery',async t=>{
  const f=fixture(t,{count:12}),bad=f.rows[0],file=f.file(bad),before=fs.readFileSync(file);
  const lock=kind==='record'?file+'.lock':path.join(f.directory,bad.sandbox_id+'.scope');
  const close=await foreignLock(t,lock),backend=recoveryGate(f.journal,f.root);backend.sandboxDeadlines=f.manager;
  try {
    for(const purpose of ['startup','probe']){
      f.calls.length=0;const report=await backend.recoverSandboxDeadlines();
      assert.equal(resultRow(report,bad).status,'foreign_locked',purpose);
      assert.equal(report.rows.filter(row=>row.status==='watching').length,11,purpose);assert.equal(f.calls.length,11,purpose);
      assert.deepEqual(fs.readFileSync(file),before);
    }
  }finally{await close();}
});

test('real same-journal reaper remains in progress without recovery waiting or touching its row',async t=>{
  let enter,resume;const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{resume=resolve;});let busyId;
  const f=fixture(t,{destroy:async row=>{if(!busyId){busyId=row._cleanupId;enter();await gate;}return watch;}});
  const reaping=f.journal.reap();await entered;const row=f.rows.find(row=>row._cleanupId===busyId),before=fs.readFileSync(f.file(row));
  let timer;try {
    const report=await Promise.race([f.recover(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('recovery waited for reaper')),1000);})]);
    assert.equal(resultRow(report,row).status,'in_progress');assert.deepEqual(fs.readFileSync(f.file(row)),before);
    assert.equal(report.rows.filter(row=>row.status==='watching').length,1);
  }finally{clearTimeout(timer);resume();await reaping;}
});

test('recovery keeps the reaper excluded through destroy finish-and-yield',async t=>{
  let enter,resume;const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{resume=resolve;});let destroys=0;
  const f=fixture(t,{count:1,destroy:async row=>{
    if(++destroys===1){f.journal.finish(row,watch);enter();await gate;}
    return watch;
  }});
  const recovering=f.recover();await entered;
  try {await f.journal.reap();assert.equal(destroys,1,'another pass must not acquire a replacement lease while the old resolver is still finishing');}
  finally{resume();await recovering;}
});

test('an older direct recovery never erases a newer recovery lease',async t=>{
  let enterFirst,enterSecond,resumeFirst,resumeSecond;
  const firstEntered=new Promise(resolve=>{enterFirst=resolve;}),secondEntered=new Promise(resolve=>{enterSecond=resolve;});
  const firstGate=new Promise(resolve=>{resumeFirst=resolve;}),secondGate=new Promise(resolve=>{resumeSecond=resolve;});let destroys=0,marked=false;
  const f=fixture(t,{count:1,destroy:async row=>{
    if(++destroys===1){f.journal.finish(row,watch);enterFirst();await firstGate;}
    else {enterSecond();await secondGate;marked=f.journal.mark(row,{create_settled:true});}
    return watch;
  }});
  const first=f.recover();await firstEntered;const second=f.recover();await secondEntered;
  try {resumeFirst();assert.equal(resultRow(await first,f.rows[0]).status,'in_progress');}
  finally{resumeSecond();await second;}
  assert.equal(marked,true);assert.equal(JSON.parse(fs.readFileSync(f.file(f.rows[0]))).create_settled,true);
});

test('future observed compute remains protected and is not destroyed during recovery',async t=>{
  const f=fixture(t,{count:1}),row={...f.rows[0],compute_created:true,deadline_at:20000,deadline_clock:{version:1,boot_id:'fixture',boot_at:20000}};
  fs.writeFileSync(f.file(row),JSON.stringify(row));f.armed.add(row._cleanupId);
  const report=await f.recover();assert.equal(report.complete,true);assert.equal(resultRow(report,row).status,'protected');assert.equal(f.calls.length,0);
});

test('verified removal is resolved without manufacturing a watching cessation proof',async t=>{
  const f=fixture(t,{count:2,destroy:async row=>row.job_id==='job-0'?{removed:true,scratch_removed:false,policy_removed:false}:watch});
  const report=await f.recover();assert.equal(resultRow(report,f.rows[0]).status,'resolved');assert.equal(resultRow(report,f.rows[1]).status,'watching');
  assert.equal(JSON.parse(fs.readFileSync(f.file(f.rows[1]))).compute_stopped,false,'a watch is never cessation');
});


test('an incomplete recovery report cannot become a host-wide owned startup proof',async()=>{
  const report={complete:false,rows:[{id:'bad',status:'failed'}]};
  const backend=recoveryGate({recoverDeadlines:async()=>report,reconcileOwned:async()=>({removed:true,watching:1})});
  backend._ownedStartupGeneration=0;
  const source=fs.readFileSync(new URL('../lib/docker-backend.mjs',import.meta.url),'utf8');
  const start=source.indexOf('  reconcileOwnedSandboxes('),end=source.indexOf('\n  /**',start);
  assert.ok(start>0&&end>start);
  backend.reconcileOwnedSandboxes=Function('sbxHome','daemonJobContext','return ({'+source.slice(start,end)+'}).reconcileOwnedSandboxes')(()=>'/fake-home',new AsyncLocalStorage());
  const proof=await backend.reconcileOwnedSandboxes();assert.equal(proof.removed,false);assert.equal(proof.admission_allowed,true);
  report.complete=true;report.rows=[];assert.equal((await backend.reconcileOwnedSandboxes()).removed,true);
});


for(const content of ['not-json','{}'])test('malformed '+content+' among twelve serves debt, admits a new target, and lets a probe proceed',async t=>{
  const f=fixture(t,{count:12}),bad=f.rows[0];fs.writeFileSync(f.file(bad),content);
  const backend=recoveryGate(f.journal,f.root);backend.sandboxDeadlines=f.manager;
  const gate=createDeadlineRecoveryGate({backend});
  assert.equal(await gate.retry(),true);
  const status=backend.cleanupStatus();assert.equal(status.deadline_recovery.complete,false);
  assert.deepEqual(status.deadline_recovery.debt,[{id:bad._cleanupId,status:'failed',reason:'unsafe_record'}]);
  assert.equal(status.deadline_recovery.rows.filter(row=>row.status==='watching').length,11);
  assert.equal(gate.current(),null);
  assert.equal((await backend.admitJob({job_id:'new',execution_scope:'owner'})).ok,true);
  let probes=0;const probe=gate.wrapProbe(async()=>{probes++;return backend.admitJob({job_id:'probe',execution_scope:'owner'});});
  assert.equal((await probe()).ok,true);assert.equal(probes,1);
  assert.equal(fs.readFileSync(f.file(bad),'utf8'),content);
});

test('a fresh protected lease remains byte-unchanged and does not block its own dispatch target',async t=>{
  const f=fixture(t,{count:0}),name='wf-1234567890123456';
  const handle={job_id:'fresh',sandbox_id:name,sbx_home:f.root,scratch_dir:path.join(f.root,'scratch','wf-job-'+name+'-'+randomUUID()),
    deadline_at:20000,deadline_clock:{version:1,boot_id:'fixture',boot_at:20000}};
  f.journal.register(handle);const row=f.journal.authority(handle),enforcer=await f.manager.register(row);f.journal.mark(handle,{deadline_enforcer:enforcer});
  const before=fs.readFileSync(f.file(handle)),backend=recoveryGate(f.journal,f.root);backend.sandboxDeadlines=f.manager;
  try {
    const report=await backend.recoverSandboxDeadlines();assert.equal(resultRow(report,handle).status,'in_progress');assert.equal(resultRow(report,handle).protected,true);
    backend.assertDeadlineTargetClear(handle);
    assert.throws(()=>backend.assertDeadlineTargetClear({...handle}),error=>error.recovery_scope==='target','copied target fields cannot adopt the fresh admission lease');
    assert.deepEqual(fs.readFileSync(f.file(handle)),before);
    assert.equal(f.calls.length,0);assert.equal(processLockOwners(f.file(handle)+'.lock').length,1);
  }finally{f.journal.finish(handle,{removed:false});}
});

test('malformed unnamed debt does not reserve every unrelated new physical name',async t=>{
  const f=fixture(t,{count:1});fs.writeFileSync(f.file(f.rows[0]),'not-json');
  const name='wf-1234567890123456',handle={job_id:'fresh',sandbox_id:name,scratch_dir:path.join(f.root,'scratch','wf-job-'+name+'-'+randomUUID()),
    deadline_at:20000,deadline_clock:{version:1,boot_id:'fixture',boot_at:20000}};
  f.journal.register(handle);try{assert.ok(f.journal.authority(handle));assert.equal(fs.readFileSync(f.file(f.rows[0]),'utf8'),'not-json');}
  finally{f.journal.finish(handle,{removed:false});}
});

test('whole-journal enumeration failure stays local and still supplies status',async t=>{
  const f=fixture(t,{count:0});fs.rmdirSync(f.directory);fs.writeFileSync(f.directory,'not a directory');
  const backend=recoveryGate(f.journal,f.root);backend.sandboxDeadlines=f.manager;const gate=createDeadlineRecoveryGate({backend});
  assert.equal(await gate.retry(),true);assert.equal(gate.current(),null);assert.equal(backend.cleanupStatus().state,'unknown');
  assert.equal((await backend.admitJob({execution_scope:'owner'})).ok,true);
});

for(const count of [1,3])test('throwing clock restores removal protection for '+count+' materialized rows',async t=>{
  const f=fixture(t,{count,destroy:async row=>{
    assert.ok(f.armed.has(row._cleanupId),'replacement remover must be registered before recovery removal');
    return {removed:true,sbx_home:row.sbx_home,scratch_removed:true,policy_removed:true};
  }});
  for(const row of f.rows)fs.writeFileSync(f.file(row),JSON.stringify({...row,compute_created:true,create_settled:true}));
  const report=await f.journal.recoverDeadlines(f.manager,{clock:()=>{throw Error('clock unavailable');}});
  assert.equal(report.complete,true);
  assert.equal(report.rows.length,count);
  assert.deepEqual(new Set(f.registers),new Set(f.rows.map(row=>row._cleanupId)));
  assert.deepEqual(new Set(f.calls),new Set(f.rows.map(row=>row._cleanupId)));
  assert.ok(report.rows.every(row=>row.status==='resolved'));
});
