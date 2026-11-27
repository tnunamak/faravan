import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {appFixture,syntheticBackend,api,waitFor} from './helpers/v1-app-fixture.mjs';
import {fileSbx,receiptBackend,receiptJob,writeCreateReceipt} from './helpers/sandbox-receipt-fixture.mjs';
import {readSbxOwner} from '../lib/sbx-daemon-owner.mjs';
import {validSandboxDeadline,sandboxDeadlineUnit} from '../lib/sandbox-deadline.mjs';
import {CESSATION_FIX} from '../lib/sandbox-remediation.mjs';
import {createLendingProbe} from '../lib/v1/lending-probe.mjs';

// HOST MUST RUN: the app graph imports the hard-excluded credentials module.
// No real executor, daemon, guard, service manager or provider is used. The
// real journal/backend/gate use fileSbx with an explicitly fake deadline manager.
test('one malformed deadline among twelve stays visible while eleven recover and new admission/probe proceed',async t=>{
  const f=await appFixture(t),name='partial-deadline-startup',home=await f.home(name),directory=join(home,'v1','sandbox-cleanup');
  const previousScratch=process.env.FARAVAN_SCRATCH_ROOT;
  process.env.FARAVAN_SCRATCH_ROOT=join(f.root,'partial-scratch');
  fs.mkdirSync(process.env.FARAVAN_SCRATCH_ROOT,{recursive:true});
  t.after(()=>{if(previousScratch===undefined)delete process.env.FARAVAN_SCRATCH_ROOT;else process.env.FARAVAN_SCRATCH_ROOT=previousScratch;});
  assert.ok(readSbxOwner(),'the no-browser fixture must provide a valid owner file');
  const sbx=fileSbx(join(f.root,'partial-empty-inventory')),at=1_000_000;
  const clock=()=>({wall:at,boot_id:'fake-boot',boot_ms:at});
  const external={active:async()=>true,activeSync:()=>true,
    register:async row=>({kind:'systemd',unit:sandboxDeadlineUnit(row),binary:'/fake/sbx'}),cancel:async()=>true};
  const compute=receiptBackend(f.root,sbx,{home,cleanupDirectory:directory,deadlineClock:clock,now:()=>at,sandboxDeadlines:external});
  const owner=compute.sandboxOwnership();let malformedFile,malformedBytes;
  for(let i=0;i<12;i++){
    const id=await writeCreateReceipt(directory,{jobId:'partial-old-'+i,name:'wf-'+i.toString(16).padStart(16,'0'),
      ownerScope:owner.owner_scope,home:owner.sbx_home,scratchRoot:process.env.FARAVAN_SCRATCH_ROOT,created:false,settled:false});
    const file=join(directory,id+'.json'),row=JSON.parse(fs.readFileSync(file,'utf8'));
    Object.assign(row,{deadline_at:at-1000,deadline_clock:{version:1,boot_id:'fake-boot',boot_at:at-1000},
      deadline_enforcer:{kind:'guard',binary:'/fake/sbx',pid:900000+i,start:'fake-process-start'},data_cleanup:'pending',policy_cleanup:'pending'});
    assert.equal(validSandboxDeadline(row),true);
    if(i===0)row.deadline_clock={version:1,boot_id:'fake-boot',boot_at:'malformed'};
    fs.writeFileSync(file,JSON.stringify(row));
    if(i===0){malformedFile=file;malformedBytes=fs.readFileSync(file);}
  }
  const backend=syntheticBackend(f.root);
  backend.sandboxOwnership=()=>owner;backend.recoverSandboxDeadlines=options=>compute.recoverSandboxDeadlines(options);
  backend.cleanupStatus=options=>compute.cleanupStatus(options);backend.deadlineRecoveryHold=()=>compute.deadlineRecoveryHold();
  const {app}=await f.start(name,{backend});
  const status=await api(app,'/api/status');
  assert.equal(status.blockers.some(row=>row.kind==='cessation_unverified'),false);
  assert.equal(status.deadline_recovery.complete,false);assert.equal(status.deadline_recovery.debt_count,1);
  assert.equal(status.deadline_recovery.debt[0].reason,'unsafe_record');
  assert.equal(status.deadline_recovery.rows.filter(row=>row.protected).length,11);
  assert.deepEqual(fs.readFileSync(malformedFile),malformedBytes);
  await compute.admitJob(receiptJob());
  // A usage reading is a host read: it neither needs nor starts a sandbox, so unrelated cleanup debt cannot affect it.
  let starts=0;
  const runner=async()=>({host_read:true,stdout:JSON.stringify({faravan_probe:1,status:200,body:{rate_limit:{allowed:true,limit_reached:false,
    primary_window:{used_percent:20,limit_window_seconds:604800,reset_at:2000000},secondary_window:null}}})});
  const probe=createLendingProbe({runGuest:runner,now:()=>at});
  assert.equal((await probe.probe('codex')).ok,true);assert.equal(starts,0,'a reading starts no sandbox');await probe.close();
  assert.deepEqual(fs.readFileSync(malformedFile),malformedBytes);
});

// HOST MUST RUN: these enter the real app graph, but every executor remains fake.
for (const mode of ['false','missing_owner','asleep']) test(mode+' recovery keeps status available and records only fixed diagnostics',async t=>{
  const f=await appFixture(t),backend=syntheticBackend(f.root);let recovered=false,calls=0,probeCalls=0;
  const original=Object.assign(new Error(mode==='asleep'?'the host is not fully awake /private/SECRET':'/private/SECRET owner missing'),
    {code:mode==='missing_owner'?'daemon_owner_repair_required':'untrusted_SECRET',stderr:mode==='asleep'?'the host is not fully awake /private/SECRET':''});
  backend.recoverSandboxDeadlines=async()=>{calls++;if(recovered)return true;if(mode==='false')return false;throw original;};
  backend.cleanupStatus=()=>({compute_cleanup_pending:44});
  backend.reapCleanup=async()=>{};
  const {app,home}=await f.start('deadline-'+mode,{backend,platform:'darwin',cleanupRecheckMs:20,
    lendingProbeRunner:async()=>{probeCalls++;throw Error('held probe must not be invoked');}});
  const status=await api(app,'/api/status'),hold=status.blockers.find(b=>b.kind==='cessation_unverified');
  // Cleanup isolation rule: only service failure and unproven daemon ownership are global.
  if(mode!=='missing_owner'){
    assert.equal(hold,undefined);assert.equal(status.deadline_recovery.state,'clear');
    assert.doesNotMatch(JSON.stringify(status.deadline_recovery),/SECRET|private/);return;
  }
  assert.ok(hold);assert.equal(hold.row_count,44);assert.deepEqual(hold.fix,CESSATION_FIX);
  assert.equal(hold.error_code,mode==='false'?'recovery_incomplete':mode==='asleep'?'host_not_awake':'daemon_owner_repair_required');
  assert.doesNotMatch(JSON.stringify(hold),/SECRET|private/);
  if(mode==='asleep')assert.match(hold.message,/^Your Mac is asleep \(lid closed\)\. Open it to lend\./);
  await waitFor(()=>{try{return fs.readFileSync(join(home,'v1','lending-errors.jsonl'),'utf8').includes('cessation_unverified');}catch{return false;}},'safe recovery diagnostic');
  const logged=fs.readFileSync(join(home,'v1','lending-errors.jsonl'),'utf8');
  assert.doesNotMatch(logged,/SECRET|private/);assert.match(logged,/44/);
  assert.equal(probeCalls,0);
  recovered=true;
  // No explicit Check again: the next cleanup cycle retries and clears the hold.
  const deadline=Date.now()+5000;let cleared=false;
  while(Date.now()<deadline){
    if(!(await api(app,'/api/status')).blockers.some(b=>b.kind==='cessation_unverified')){cleared=true;break;}
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(cleared,true,'background recovery clears hold');
  assert.ok(calls>=2);
});

test('healthy recovery starts and leaves no deadline recovery blocker',async t=>{
  const f=await appFixture(t),backend=syntheticBackend(f.root);let calls=0;
  backend.recoverSandboxDeadlines=async()=>{calls++;return true;};
  const {app}=await f.start('deadline-healthy',{backend});
  assert.ok(calls>=1);assert.equal((await api(app,'/api/status')).blockers.some(b=>b.kind==='cessation_unverified'),false);
});
