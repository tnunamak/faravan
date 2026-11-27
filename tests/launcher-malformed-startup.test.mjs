import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createSandboxDeadlineManager,deadlineSupervisorPayload,deadlineBinding} from '../lib/sandbox-deadline.mjs';

const privateMarker='MALFORMED_STARTUP_PRIVATE';
const clock=()=>({wall:1_000_000,boot_id:'malformed-startup-test',boot_ms:1_000_000});

// These reader checks use the production parser and do not launch a guard,
// service manager, sandbox or app. The startup cases below need the full app
// graph and are imported only inside their tests, so the reader checks can run
// independently with --test-name-pattern='^malformed deadline status'.
for(const corruption of ['invalid JSON','invalid shape'])test('malformed deadline status '+corruption+' never proves protection',async t=>{
  const directory=fs.mkdtempSync(join(tmpdir(),'deadline-state-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const row={_cleanupId:randomUUID(),sandbox_id:'wf-0123456789abcdef',sbx_home:directory,
    deadline_at:2_000_000,deadline_clock:{version:1,boot_id:clock().boot_id,boot_at:2_000_000},
    deadline_enforcer:{kind:'guard',binary:process.execPath,pid:999999,start:'test-start'}};
  const payload=deadlineSupervisorPayload(row,process.execPath,directory,'guard');
  const contents=corruption==='invalid JSON'?'{"private":"'+privateMarker+'","broken":':JSON.stringify({
    binding:deadlineBinding(payload),state:'armed',observed:true,pid:'not-a-pid',start:privateMarker});
  fs.writeFileSync(payload.statusPath,contents);
  const manager=createSandboxDeadlineManager({binary:process.execPath,platform:'darwin',directory,clock});
  assert.equal(await manager.active(row,{recovery:true}),false);
  assert.equal(manager.activeSync(row),false);
  assert.equal(manager.observed(row),false);
  assert.equal(fs.readFileSync(payload.statusPath,'utf8'),contents,'inspection must preserve the untrusted state');
});

// HOST MUST RUN the three startup cases: appFixture imports the real startApp
// graph. No production imports are stubbed or source-transformed. The existing
// fileSbx fixture handles every sandbox command; only the external guard launch
// seam is made unavailable to model failure to reconstruct lost protection.
// SANDBOX-CLEANUP-RECOVERY.md: Set-aside records and Per-target admission.
// A bad row stays visible and byte-unchanged without holding unrelated lending.
for(const corruption of ['cleanup JSON','deadline fields','deadline status'])test('startup with malformed '+corruption+' serves status and keeps only its own cleanup debt',async t=>{
  const {appFixture,syntheticBackend,api}=await import('./helpers/v1-app-fixture.mjs');
  const {fileSbx,receiptBackend,receiptJob,writeCreateReceipt}=await import('./helpers/sandbox-receipt-fixture.mjs');
  const f=await appFixture(t),name='malformed-'+corruption.replaceAll(' ','-'),home=await f.home(name);
  const directory=join(home,'v1','sandbox-cleanup'),scratchRoot=join(f.root,name+'-scratch');
  const previousScratch=process.env.FARAVAN_SCRATCH_ROOT;
  process.env.FARAVAN_SCRATCH_ROOT=scratchRoot;fs.mkdirSync(scratchRoot,{recursive:true});
  t.after(()=>{if(previousScratch===undefined)delete process.env.FARAVAN_SCRATCH_ROOT;else process.env.FARAVAN_SCRATCH_ROOT=previousScratch;});
  let guardLaunches=0;
  const deadlines=createSandboxDeadlineManager({binary:'/fake/sbx',platform:'darwin',directory,clock,
    spawnGuard:()=>{guardLaunches++;throw Object.assign(Error(privateMarker+' guard unavailable'),{code:'EIO'});}});
  const sbx=fileSbx(join(f.root,name+'-inventory'));
  const compute=receiptBackend(f.root,sbx,{home,cleanupDirectory:directory,deadlineClock:clock,now:()=>clock().wall,
    sandboxDeadlines:deadlines,legacyDaemonOptions:{platformName:'darwin',inspectDaemons:async()=>[]}});
  const owner=compute.sandboxOwnership();
  const id=await writeCreateReceipt(directory,{jobId:'malformed-startup-job',name:'wf-0123456789abcdef',
    ownerScope:owner.owner_scope,home:owner.sbx_home,scratchRoot});
  const recordFile=join(directory,id+'.json'),row=JSON.parse(fs.readFileSync(recordFile,'utf8'));
  Object.assign(row,{deadline_at:2_000_000,deadline_clock:{version:1,boot_id:clock().boot_id,boot_at:2_000_000},
    deadline_enforcer:{kind:'guard',binary:'/fake/sbx',pid:999999,start:'test-start'}});
  let corruptFile=recordFile,contents;
  if(corruption==='cleanup JSON')contents='{"private":"'+privateMarker+'","broken":';
  else {
    if(corruption==='deadline fields')row.deadline_at=privateMarker;
    fs.writeFileSync(recordFile,JSON.stringify(row));
    if(corruption==='deadline status') {
      corruptFile=deadlineSupervisorPayload(row,'/fake/sbx',directory,'guard').statusPath;
      contents='{"private":"'+privateMarker+'","broken":';
    }else contents=JSON.stringify(row);
  }
  fs.writeFileSync(corruptFile,contents);
  if(corruption==='deadline status')assert.equal(await deadlines.active(row,{recovery:true}),false);
  const backend=syntheticBackend(f.root);
  backend.sandboxOwnership=()=>owner;
  backend.recoverSandboxDeadlines=options=>compute.recoverSandboxDeadlines(options);
  backend.cleanupStatus=options=>compute.cleanupStatus(options);
  backend.deadlineRecoveryHold=()=>compute.deadlineRecoveryHold?.()??null;
  const {app}=await f.start(name,{backend,freshLending:'automatic',platform:'darwin',
    lendingProbeRunner:async()=>({ok:false,reason:'test_unavailable'})});
  // Let the backend finish one bounded pass; app startup itself must not wait for it.
  await compute.recoverSandboxDeadlines();
  const checkDebt=async()=>{
    const status=await api(app,'/api/status');
    assert.equal(status.blockers.some(blocker=>blocker.kind==='cessation_unverified'),false,
      'one malformed record must not become a global lending hold');
    // SANDBOX-CLEANUP-RECOVERY.md, Whole-recovery failure: a partial report
    // is a completed pass, so inspect the exposed hold rather than optional admission.
    assert.equal(status.deadline_recovery.recovery_hold,undefined);
    const debt=status.deadline_recovery.debt.find(item=>item.id===id);
    assert.ok(debt,'the unresolved record must remain visible');
    assert.equal(debt.status,'failed');
    assert.equal(debt.name,corruption==='cleanup JSON'?undefined:row.sandbox_id);
    const unreadable=corruption==='deadline status'?0:1;
    assert.equal(status.deadline_recovery.unreadable_records,unreadable);
    if(unreadable)assert.equal(status.deadline_recovery.unreadable_message,'1 cleanup record could not be read');
    assert.doesNotMatch(JSON.stringify(status.deadline_recovery),new RegExp(privateMarker));
    assert.doesNotMatch(JSON.stringify(status.deadline_recovery),/SyntaxError|Unexpected token|Unexpected end|guard unavailable/);
    return debt;
  };
  await checkDebt();
  // Check again must remain responsive, retain the same debt and expose no raw error.
  await api(app,'/api/readiness?refresh=true');
  await checkDebt();
  assert.equal((await compute.admitJob(receiptJob())).ok,true,'an unrelated new job is not globally held');
  const target=receiptJob({_cleanupId:id,...(corruption==='cleanup JSON'?{}:{sandbox_id:row.sandbox_id})});
  await assert.rejects(compute.admitJob(target),error=>error.code==='cessation_unverified'&&error.recovery_scope==='target');
  await assert.rejects(compute.prepare(target),error=>error.code==='cessation_unverified'&&error.recovery_scope==='target');
  assert.equal(compute.deadlineRecoveryHold(),null);
  assert.deepEqual(sbx.created(),[]);
  assert.equal(fs.readFileSync(corruptFile,'utf8'),contents,'failed recovery must retain the evidence');
  assert.equal(guardLaunches>0,corruption==='deadline status','only valid rows may attempt protection reconstruction');
});
