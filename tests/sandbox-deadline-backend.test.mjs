import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileSbx,receiptBackend,receiptJob,writeCreateReceipt} from './helpers/sandbox-receipt-fixture.mjs';
import {_internal} from '../lib/docker-backend.mjs';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import {acquireProcessLockSync} from '../lib/v1/lock.mjs';
import {sandboxDeadlineUnit,sandboxDeadlineClock} from '../lib/sandbox-deadline.mjs';

const deadlineFields=at=>{const clock=sandboxDeadlineClock();return {deadline_at:at,
  deadline_clock:{version:1,boot_id:clock.boot_id,boot_at:clock.boot_ms+at-clock.wall}};};

function fixture(t,options={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'deadline-backend-'));
  const previousScratch=process.env.FARAVAN_SCRATCH_ROOT;
  process.env.FARAVAN_SCRATCH_ROOT=path.join(root,'scratch');
  fs.mkdirSync(process.env.FARAVAN_SCRATCH_ROOT);
  const sbx=fileSbx(root),events=[],armed=new Set();
  const deadlines={register:async row=>{events.push('register');armed.add(row._cleanupId);return {kind:'systemd',unit:sandboxDeadlineUnit(row),binary:'/fake/sbx'};},
    active:async row=>armed.has(row._cleanupId),activeSync:row=>armed.has(row._cleanupId),cancel:async row=>{events.push('cancel');armed.delete(row._cleanupId);return true;},...options};
  const register=deadlines.register;
  deadlines.register=async row=>{const saved=await register(row);armed.add(row._cleanupId);return saved;};
  const backend=receiptBackend(root,sbx,{sandboxDeadlines:deadlines});
  const run=backend.runSbx;
  backend.runSbx=async(args,opts)=>{events.push(args[0]);return run(args,opts);};
  t.after(()=>{
    if(previousScratch===undefined)delete process.env.FARAVAN_SCRATCH_ROOT;else process.env.FARAVAN_SCRATCH_ROOT=previousScratch;
    fs.rmSync(root,{recursive:true,force:true});
  });
  return {root,sbx,backend,events,deadlines};
}

test('durable deadline precedes create; independent registration precedes every exec',async t=>{
  const {backend,events,root}=fixture(t),opened=new Map(),synced=[];
  const open=fs.openSync,sync=fs.fsyncSync;
  t.mock.method(fs,'openSync',(...args)=>{const fd=open(...args);opened.set(fd,String(args[0]));return fd;});
  t.mock.method(fs,'fsyncSync',fd=>{synced.push(opened.get(fd));return sync(fd);});
  const run=backend.runSbx;
  backend.runSbx=async(args,opts)=>{
    if(['create','run'].includes(args[0])) {
      const name=args[args.indexOf('--name')+1];
      const row=backend.cleanupJournal.authority({job_id:'job-receipt-1',sandbox_id:name});
      assert.ok(row.deadline_at>=Date.now()+119_000,'deadline plus grace is durable before create');
      assert.ok(row.deadline_at<=Date.now()+3_600_000+120_000);
      const directory=path.join(root,'profile','v1','sandbox-cleanup');
      assert.ok(synced.includes(path.join(directory,row._cleanupId+'.json')),'deadline file is fsynced before create');
      assert.ok(synced.includes(directory),'deadline directory is fsynced before create');
    }
    return run(args,opts);
  };
  const handle=await backend.prepare(receiptJob());
  try {
    assert.ok(events.indexOf('register')<events.indexOf('create'));
    assert.ok(events.indexOf('register')<events.indexOf('exec'));
    assert.equal(backend.cleanupJournal.authority(handle).deadline_enforcer.kind,'systemd');
  }finally{await backend.destroy(handle);}
});

test('reservation time is deducted before preparation and inherited by check sandboxes',async t=>{
  const {backend}=fixture(t);
  const before=Date.now();
  const handle=await backend.prepare(receiptJob(),{wallRemainingMs:()=>90_000});
  try {
    assert.ok(handle.deadline_at>=before+210_000);
    assert.ok(handle.deadline_at<=Date.now()+210_000);
    const check=await backend.prepareCheck(handle,{remainingMs:45_000});
    try{assert.ok(check.deadline_at<handle.deadline_at);}finally{await backend.destroy(check);}
  }finally{await backend.destroy(handle);}
});

test('preparation waits consume the original local and external wall budget',async t=>{
  const {backend}=fixture(t);let time=0,timerDelay;
  backend.monotonic=()=>time;
  backend.deadlineTimers={setTimeout:(_fn,ms)=>{timerDelay=ms;return {unref(){}};},clearTimeout:()=>{}};
  backend.deadlineClock=()=>({wall:10_000+time,boot_id:'boot-one',boot_ms:time});
  backend._healthRecovery=Promise.resolve().then(()=>{time=20_000;});
  const handle=await backend.prepare({...receiptJob(),resources:{...receiptJob().resources,wall_seconds:60}});
  try {
    assert.equal(handle._deadline.endsAt,60_000);
    assert.equal(handle.deadline_at,190_000);
    assert.deepEqual(handle.deadline_clock,{version:1,boot_id:'boot-one',boot_at:180_000});
    assert.equal(timerDelay,40_000);
  }finally{await backend.destroy(handle);}
});

test('failed registration dispatches no create or exec',async t=>{
  const {backend,sbx,events}=fixture(t,{register:async()=>{throw Error('fixture registration failure');}});
  await assert.rejects(backend.prepare(receiptJob()),{code:'sandbox_start_failed',retryable:true});
  assert.equal(events.includes('exec'),false);
  assert.deepEqual(sbx.read(),[]);
  assert.equal(events.includes('run'),false);
  assert.equal(events.includes('create'),false);
});

test('guard PID and process start are in the journal before readiness exec',async t=>{
  const {backend}=fixture(t,{register:async()=>({kind:'guard',pid:12345,start:'boot:100',binary:'/fake/sbx'})});
  const run=backend.runSbx;
  backend.runSbx=async(args,options)=>{
    if(args[0]==='exec') {
      const row=backend.cleanupJournal.authority({job_id:'job-receipt-1',sandbox_id:args[1]});
      assert.deepEqual(row.deadline_enforcer,{kind:'guard',pid:12345,start:'boot:100',binary:'/fake/sbx'});
    }
    return run(args,options);
  };
  const handle=await backend.prepare(receiptJob());await backend.destroy(handle);
});

test('verified normal removal clears the deadline and never signals the guard',async t=>{
  const {backend,events}=fixture(t,{cancel:async()=>{events.push('cancel-failed');throw Error('unavailable');}});
  const handle=await backend.prepare(receiptJob());
  // Keep a data-cleanup row so clearing the deadline is observable too.
  backend.removeScratch=async()=>{};
  assert.equal((await backend.destroy(handle)).removed,true);
  assert.equal(events.includes('cancel-failed'),false,'the app does not cancel the guard');
  const row=backend.cleanupJournal.authority(handle);
  assert.equal(row.deadline_at,undefined);
  assert.equal(row.deadline_enforcer,undefined);
});

test('explicit recovery removes overdue compute and restores future enforcement',async t=>{
  const {backend,root,sbx,events}=fixture(t);
  const directory=path.join(root,'profile','v1','sandbox-cleanup');
  for(const [name,deadline] of [['wf-1111111111111111',Date.now()-1],['wf-2222222222222222',Date.now()+60_000]]) {
    const id=await writeCreateReceipt(directory,{jobId:name,name,ownerScope:sandboxOwnerScope(),home:_internal.sbxHome(),scratchRoot:_internal.scratchRoot()});
    const file=path.join(directory,id+'.json'),row=JSON.parse(fs.readFileSync(file));
    fs.writeFileSync(file,JSON.stringify({...row,...deadlineFields(deadline)}));
    await sbx.run(['create','--name',name]);
  }
  await backend.recoverSandboxDeadlines();
  const handle=await backend.prepare(receiptJob());
  try {
    assert.equal(sbx.read().includes('wf-1111111111111111'),false);
    assert.ok(sbx.read().includes('wf-2222222222222222'));
    assert.ok(events.indexOf('rm')<events.indexOf('create'));
    assert.equal(events.filter(event=>event==='register').length,2);
  }finally{await backend.destroy(handle);await backend.reapCleanup();}
});

test('a future unproven create keeps its own target blocked while unrelated lending proceeds',async t=>{
  const {backend,root,sbx,events}=fixture(t);
  const name='wf-3333333333333333',directory=path.join(root,'profile','v1','sandbox-cleanup');
  const id=await writeCreateReceipt(directory,{jobId:name,name,ownerScope:sandboxOwnerScope(),home:_internal.sbxHome(),scratchRoot:_internal.scratchRoot(),created:false});
  const file=path.join(directory,id+'.json');
  fs.writeFileSync(file,JSON.stringify({...JSON.parse(fs.readFileSync(file)),...deadlineFields(Date.now()+60_000)}));
  await sbx.run(['create','--name',name]);
  const run=backend.runSbx;
  backend.runSbx=async(args,options)=>args[0]==='rm'?{code:1,stdout:'',stderr:'fixture removal refused'}:run(args,options);
  const proof=await backend.reconcileOwnedSandboxes();assert.equal(proof.removed,false);assert.equal(proof.admission_allowed,true);
  const before=fs.readFileSync(file);events.length=0;
  await assert.rejects(backend.admitJob(receiptJob({sandbox_id:name})),{code:'cessation_unverified',recovery_scope:'target'});
  assert.deepEqual(sbx.read(),[name]);assert.deepEqual(fs.readFileSync(file),before);
  for(const action of ['create','run','register','rm'])assert.equal(events.includes(action),false);
  assert.equal(backend.deadlineRecoveryHold(),null);
  assert.equal((await backend.admitJob(receiptJob())).ok,true);
});

// Owner contract: docs/design/SANDBOX-CLEANUP-RECOVERY.md,
// "Hand-off to the shared watcher". Admission is never cessation proof.
for(const overdue of [false,true])test('watched inert create keeps its own guard while a create client may still be live; overdue='+overdue,async t=>{
  const {backend,root,events,deadlines}=fixture(t);
  backend._createClientAbsent=async()=>false;
  const name='wf-5555555555555555',directory=path.join(root,'profile','v1','sandbox-cleanup');
  const id=await writeCreateReceipt(directory,{jobId:name,name,ownerScope:sandboxOwnerScope(),home:_internal.sbxHome(),
    scratchRoot:_internal.scratchRoot(),created:false,settled:false});
  const file=path.join(directory,id+'.json');
  const initial={...JSON.parse(fs.readFileSync(file)),...deadlineFields(Date.now()+(overdue?-1:3_600_000))};
  initial.deadline_enforcer=await deadlines.register(initial);
  fs.writeFileSync(file,JSON.stringify(initial));
  let now=Date.now();backend._now=()=>now;
  let asked=0;
  backend._sharedSandboxWatcher().acknowledge=async()=>{asked++;throw Error('A record that has a guard is never offered to the watcher.');};
  const debt=()=>{
    assert.ok(fs.existsSync(file),'unproven create-client absence retains the cleanup record');
    const row=backend.cleanupJournal.authority({job_id:name,sandbox_id:name});
    assert.equal(row.create_settled,false);assert.equal(row.compute_stopped,false);
    assert.notEqual(row.data_cleanup,'removed');assert.notEqual(row.policy_cleanup,'removed');
    assert.equal(events.includes('exec'),false);assert.equal(events.includes('rm'),false);
    return row;
  };
  // Daemon absence alone cannot settle a create whose client may still run.
  // These passes retain the original guard instead of handing off its duty.
  for(let pass=0;pass<3;pass++) {
    assert.equal((await backend.reconcileOwnedSandboxes()).removed,false,'a guard is not proof that compute stopped');
    const row=debt();
    assert.equal(await deadlines.active(row),true,'the guard stays in charge');
    assert.equal(events.includes('cancel'),false,'the app never cancels the guard');
    assert.equal(asked,0,'the watcher is never asked');
    for(const key of ['watch_state','watch_ack','watch_challenge','exec_fenced'])assert.equal(row[key],undefined,key+' is not written');
    now+=60_000;
  }
});

test('changing the sandbox HOME cannot reuse a prior recovery result',async t=>{
  const {backend,root,sbx,events}=fixture(t);
  await backend.recoverSandboxDeadlines();
  const saved=process.env.FARAVAN_SBX_HOME,home=path.join(root,'other-home');
  process.env.FARAVAN_SBX_HOME=home;
  try {
    const name='wf-4444444444444444',directory=path.join(root,'profile','v1','sandbox-cleanup');
    const id=await writeCreateReceipt(directory,{jobId:name,name,ownerScope:sandboxOwnerScope(),home,scratchRoot:_internal.scratchRoot()});
    const file=path.join(directory,id+'.json');
    fs.writeFileSync(file,JSON.stringify({...JSON.parse(fs.readFileSync(file)),...deadlineFields(Date.now()-1)}));
    await sbx.run(['create','--name',name]);
    await backend.recoverSandboxDeadlines();
    assert.equal((await backend.admitJob(receiptJob())).ok,true);
    assert.deepEqual(sbx.read(),[]);assert.ok(events.includes('rm'));
  }finally{if(saved===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=saved;}
});

const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test('the central command fence refuses guest exec while registration is pending',async t=>{
  const f=fixture(t),entered=gate(),resume=gate();let handle;
  const register=f.backend.cleanupJournal.register,arm=f.deadlines.register;
  t.mock.method(f.backend.cleanupJournal,'register',(h,o)=>{handle=h;return register(h,o);});
  f.deadlines.register=async row=>{entered.resolve();await resume.promise;return arm(row);};
  const preparing=f.backend.prepare(receiptJob());
  try {
    await entered.promise;
    await assert.rejects(f.backend._runJobCommand(handle,['exec',handle.sandbox_id,'--','true']),{code:'sandbox_start_failed'});
    assert.equal(f.events.includes('exec'),false);
  }finally{resume.resolve();const ready=await preparing;await f.backend.destroy(ready);}
});

test('a lost independent action fences later guest commands',async t=>{
  const f=fixture(t),handle=await f.backend.prepare(receiptJob());
  try {
    f.deadlines.active=async()=>false;const before=f.events.filter(event=>event==='exec').length;
    await assert.rejects(f.backend._runJobCommand(handle,['exec',handle.sandbox_id,'--','true']),{code:'sandbox_start_failed'});
    assert.equal(f.events.filter(event=>event==='exec').length,before);
  }finally{await f.backend.destroy(handle);}
});

test('elapsed local budget fences exec even if its callback has not run',async t=>{
  const f=fixture(t);let time=0;
  f.backend.monotonic=()=>time;
  f.backend.deadlineTimers={setTimeout:()=>({unref(){}}),clearTimeout:()=>{}};
  const handle=await f.backend.prepare({...receiptJob(),resources:{...receiptJob().resources,wall_seconds:60}});
  try {
    time=60_000;const before=f.events.filter(event=>event==='exec').length;
    await assert.rejects(f.backend._runJobCommand(handle,['exec',handle.sandbox_id,'--','true']),{code:'wall_timeout'});
    assert.equal(f.events.filter(event=>event==='exec').length,before);
  }finally{await f.backend.destroy(handle);}
});

for(const removalFails of [false,true])test('failed registration persistence keeps protection until proven removal: '+removalFails,async t=>{
  const f=fixture(t),mark=f.backend.cleanupJournal.mark,run=f.backend.runSbx;
  t.mock.method(f.backend.cleanupJournal,'mark',(h,facts)=>{
    if(facts.deadline_enforcer)throw Error('injected registration sync failure');
    return mark(h,facts);
  });
  if(removalFails)f.backend.runSbx=async(args,options)=>args[0]==='rm'?{code:1,stdout:'',stderr:'unavailable'}:run(args,options);
  await assert.rejects(f.backend.prepare(receiptJob()),{code:'sandbox_start_failed'});
  assert.equal(f.events.includes('create'),false,'failed publication never reaches create');
  assert.equal(f.events.includes('run'),false);
  assert.equal(f.events.includes('cancel'),false,'the app never cancels a guard: it ends itself');
});

for(const corrupt of ['clock','action'])test('malformed '+corrupt+' is target debt and startup resolves without destructive authority',async t=>{
  const f=fixture(t),name='wf-5555555555555555',directory=path.join(f.root,'profile/v1/sandbox-cleanup');
  const id=await writeCreateReceipt(directory,{jobId:'old',name,ownerScope:sandboxOwnerScope(),home:_internal.sbxHome(),scratchRoot:_internal.scratchRoot()});
  const file=path.join(directory,id+'.json'),row={...JSON.parse(fs.readFileSync(file)),...deadlineFields(Date.now()+60_000)};
  if(corrupt==='clock')row.deadline_clock={version:20,boot_id:'boot',boot_at:1000};
  else row.deadline_enforcer={kind:'other',unit:'unrelated'};
  fs.writeFileSync(file,JSON.stringify(row));await f.sbx.run(['create','--name',name]);
  const before=fs.readFileSync(file);
  await assert.rejects(f.backend.admitJob(receiptJob({sandbox_id:name})),{code:'cessation_unverified',recovery_scope:'target'});
  const proof=await f.backend.reconcileOwnedSandboxes();assert.equal(proof.removed,false);assert.equal(proof.admission_allowed,true);
  assert.equal(f.backend.deadlineRecoveryHold(),null);assert.equal((await f.backend.admitJob(receiptJob())).ok,true);
  assert.deepEqual(f.sbx.read(),[name]);assert.deepEqual(fs.readFileSync(file),before);
  for(const action of ['create','run','register','rm'])assert.equal(f.events.includes(action),false);
  assert.equal(f.backend.cleanupStatus().deadline_recovery.debt.find(row=>row.id===id).reason,'unsafe_record');
});

test('recovery expires an old future wall deadline after a changed boot',async t=>{
  const f=fixture(t),name='wf-6666666666666666',directory=path.join(f.root,'profile/v1/sandbox-cleanup');
  const id=await writeCreateReceipt(directory,{jobId:'old',name,ownerScope:sandboxOwnerScope(),home:_internal.sbxHome(),scratchRoot:_internal.scratchRoot()});
  const file=path.join(directory,id+'.json'),row={...JSON.parse(fs.readFileSync(file)),...deadlineFields(Date.now()+60_000)};
  row.deadline_clock.boot_id='previous-boot';fs.writeFileSync(file,JSON.stringify(row));await f.sbx.run(['create','--name',name]);
  await f.backend.recoverSandboxDeadlines();
  await f.backend.admitJob(receiptJob());
  assert.deepEqual(f.sbx.read(),[]);assert.equal(f.events.includes('register'),false);
});

test('forty overdue rows recover while unrelated admission and create continue',{timeout:120000},async t=>{
  const f=fixture(t),directory=path.join(f.root,'profile/v1/sandbox-cleanup'),names=[];
  const past=Date.now()-60_000;
  for(let i=1;i<=40;i++) {
    const name='wf-'+i.toString(16).padStart(16,'0');names.push(name);
    const id=await writeCreateReceipt(directory,{jobId:name,name,ownerScope:sandboxOwnerScope(),home:_internal.sbxHome(),scratchRoot:_internal.scratchRoot()});
    const file=path.join(directory,id+'.json');fs.writeFileSync(file,JSON.stringify({...JSON.parse(fs.readFileSync(file)),...deadlineFields(past+i)}));
    await f.sbx.run(['create','--name',name]);
  }
  const entered=gate(),resume=gate(),run=f.backend.runSbx;
  f.backend.runSbx=async(args,options)=>{if(args[0]==='rm'&&args.at(-1)===names.at(-1)){entered.resolve();await resume.promise;}return run(args,options);};
  const recovery=f.backend.recoverSandboxDeadlines();let handle;
  try {
    await entered.promise;
    assert.equal((await f.backend.admitJob(receiptJob())).ok,true);
    handle=await f.backend.prepare(receiptJob());
    assert.equal(f.events.includes('create'),true);assert.equal(f.events.includes('exec'),true);
    assert.notEqual(handle.sandbox_id,names.at(-1));assert.ok(f.sbx.read().includes(names.at(-1)),'the old removal is still pending');
  }finally{resume.resolve();}
  await recovery;
  try{assert.ok(names.every(name=>!f.sbx.read().includes(name)));}finally{await f.backend.destroy(handle);}
});

test('external compute removal does not wait for output handoff or record locks',async t=>{
  const f=fixture(t),handle=await f.backend.prepare(receiptJob()),resume=gate();
  handle._outputHandoff=resume.promise;
  const destroying=f.backend.destroy(handle);
  try {
    await Promise.resolve();assert.ok(f.backend.cleanupJournal.authority(handle).deadline_enforcer);
    assert.equal(f.events.includes('cancel'),false);
    await f.sbx.run(['rm','--force',handle.sandbox_id]);
    assert.deepEqual(f.sbx.read(),[]);assert.equal(f.backend.cleanupJournal.recorded(handle.sandbox_id),true);
  }finally{resume.resolve(true);}
  assert.equal((await destroying).removed,true);assert.equal(f.events.includes('cancel'),false);
});

test('shared-deadline siblings have separate actions and independent removal',async t=>{
  const f=fixture(t),first=await f.backend.prepare(receiptJob());let second;
  try {
    second=await f.backend.prepare(receiptJob({job_id:'sibling'}),first._deadline);
    const a=f.backend.cleanupJournal.authority(first),b=f.backend.cleanupJournal.authority(second);
    assert.notEqual(a.deadline_enforcer.unit,b.deadline_enforcer.unit);
    assert.ok(second.deadline_at<=first.deadline_at);
    await Promise.all([f.backend.destroy(first),f.backend.destroy(first)]);
    assert.ok(await f.deadlines.active(f.backend.cleanupJournal.authority(second)));
    await f.backend._runJobCommand(second,['exec',second.sandbox_id,'--','true']);
  }finally{await f.backend.destroy(first);if(second)await f.backend.destroy(second);}
});

test('a future existing action stays enforced without becoming a cessation proof',async t=>{
  const f=fixture(t,{active:async()=>true}),name='wf-7777777777777777',directory=path.join(f.root,'profile/v1/sandbox-cleanup');
  const id=await writeCreateReceipt(directory,{jobId:'old',name,ownerScope:sandboxOwnerScope(),home:_internal.sbxHome(),scratchRoot:_internal.scratchRoot()});
  const file=path.join(directory,id+'.json'),row={...JSON.parse(fs.readFileSync(file)),...deadlineFields(Date.now()+60_000)};
  row.deadline_enforcer={kind:'systemd',unit:sandboxDeadlineUnit(row),binary:'/fake/sbx'};
  fs.writeFileSync(file,JSON.stringify(row));await f.sbx.run(['create','--name',name]);
  const recovery=await f.backend.recoverSandboxDeadlines();assert.equal(recovery.complete,true);
  assert.equal(recovery.rows.find(row=>row.id===id)?.status,'protected');await f.backend.recoverSandboxDeadlines();
  assert.deepEqual(f.sbx.read(),[name]);assert.equal(f.events.includes('register'),false);
  const proof=await f.backend.reconcileOwnedSandboxes();
  assert.equal(proof.removed,true);assert.deepEqual(f.sbx.read(),[]);
});

test('concurrent recovery, external fire and cleanup retain the row until final proof',async t=>{
  const f=fixture(t),name='wf-8888888888888888',directory=path.join(f.root,'profile/v1/sandbox-cleanup');
  const id=await writeCreateReceipt(directory,{jobId:'old',name,ownerScope:sandboxOwnerScope(),home:_internal.sbxHome(),scratchRoot:_internal.scratchRoot()});
  const file=path.join(directory,id+'.json');fs.writeFileSync(file,JSON.stringify({...JSON.parse(fs.readFileSync(file)),...deadlineFields(Date.now()+60_000)}));
  await f.sbx.run(['create','--name',name]);
  const entered=gate(),resume=gate(),register=f.deadlines.register;
  f.deadlines.register=async row=>{entered.resolve();await resume.promise;return register(row);};
  const first=f.backend.recoverSandboxDeadlines(),second=f.backend.recoverSandboxDeadlines();assert.equal(first,second);
  const pending={jobId:'old',attemptId:'cleanup',attempt:{attempt_id:'cleanup'},...f.backend.sandboxOwnership()};
  try {
    await entered.promise;
    assert.equal((await f.backend.reconcilePending(pending)).removed,false);
    await f.sbx.run(['rm','--force',name]);assert.equal(fs.existsSync(file),true);
  }finally{resume.resolve();}
  await first;assert.equal(f.events.filter(event=>event==='register').length,1);
  assert.equal((await f.backend.reconcilePending(pending)).removed,true);assert.equal(fs.existsSync(file),false);
});

// Full backend graph coverage. The bounded builder runs journal/gate coverage
// separately; the host must run these existing-fake integration checks.
for(const kind of ['record','name'])test('own overdue '+kind+' lock does not block an unrelated backend preparation',async t=>{
  const f=fixture(t),name='wf-9999999999999999',directory=path.join(f.root,'profile','v1','sandbox-cleanup');
  const id=await writeCreateReceipt(directory,{jobId:'old-watching',name,ownerScope:sandboxOwnerScope(),home:_internal.sbxHome(),
    scratchRoot:_internal.scratchRoot(),created:false,settled:false});
  const file=path.join(directory,id+'.json');
  fs.writeFileSync(file,JSON.stringify({...JSON.parse(fs.readFileSync(file)),absent_since:Date.now()-6*3600_000,...deadlineFields(Date.now()-1)}));
  const before=fs.readFileSync(file),release=acquireProcessLockSync(kind==='record'?file+'.lock':path.join(directory,name+'.scope'));
  let handle;
  try {
    const report=await f.backend.recoverSandboxDeadlines();assert.equal(report.rows.find(row=>row.id===id)?.status,'in_progress');
    handle=await f.backend.prepare(receiptJob({job_id:'unrelated-probe'}));
    assert.ok(handle);assert.notEqual(handle.sandbox_id,name);assert.deepEqual(fs.readFileSync(file),before);
  }finally{if(handle)await f.backend.destroy(handle);release();}
});
