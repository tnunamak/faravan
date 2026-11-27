import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {appFixture,syntheticBackend,api,waitFor} from './helpers/v1-app-fixture.mjs';

// HOST MUST RUN: these enter the real app graph, but every executor remains fake.
// docs/design/SANDBOX-CLEANUP-RECOVERY.md: the app starts and serves status while recovery is pending or held.
const PENDING='Checking for sandboxes left from last time. Lending starts when this finishes.';

// The first pass waits for the test. Later passes (the cleanup cycle) answer `later`.
function slowRecovery(backend,later=()=>true) {
  let release,fail,calls=0;
  const first=new Promise((resolve,reject)=>{release=resolve;fail=reject;});
  backend.recoverSandboxDeadlines=async()=>{calls++;return calls===1?first:later();};
  backend.reapCleanup=async()=>{};
  return {release:()=>release(true),fail:error=>fail(error),calls:()=>calls};
}

// start() must resolve with recovery still pending: a launcher waits only seconds for the app to answer.
// On failure the pass is released first so the test can end instead of waiting for it.
const started=(starting,recovery)=>Promise.race([starting,
  new Promise((_,reject)=>setTimeout(()=>{recovery.release();reject(new Error('start waited for sandbox recovery'));},8000).unref())]);

test('the app serves status and publishes discovery while the first recovery pass is still running',async t=>{
  const f=await appFixture(t),backend=syntheticBackend(f.root),recovery=slowRecovery(backend);let probeCalls=0;
  const {app,home}=await started(f.start('async-recovery',{backend,freshLending:'automatic',cleanupRecheckMs:20,
    lendingProbeRunner:async()=>{probeCalls++;return {ok:false,reason:'test_unavailable'};}}),recovery);
  assert.equal(recovery.calls(),1,'the first pass started');
  const discovery=JSON.parse(fs.readFileSync(join(home,'v1','app.json'),'utf8'));
  assert.equal(discovery.port,Number(new URL(app.origin).port));
  const status=await api(app,'/api/status');
  const hold=status.blockers.find(row=>row.kind==='cessation_unverified');
  assert.ok(hold,'a pending hold is shown');
  assert.equal(hold.message,PENDING);
  assert.equal(status.deadline_recovery.state,'held');
  assert.equal(status.deadline_recovery.recovery_hold.message,PENDING);
  assert.equal(status.deadline_recovery.complete,false);
  assert.doesNotMatch(JSON.stringify(hold),/verdict|receipt|attempt|settled|lease|—/i);
  assert.doesNotMatch(JSON.stringify(hold.fix),/verdict|receipt|attempt|settled|lease|—/i);
  // Admission and probes are fenced until the pass ends, even across several cleanup cycles.
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(probeCalls,0,'no probe runs while recovery is pending');
  assert.equal(backend.calls.filter(call=>call[0]==='admit').length,0,'no job is admitted while recovery is pending');
  assert.equal(recovery.calls(),1,'cleanup cycles join the first pass instead of starting another');
  assert.ok((await api(app,'/api/status')).blockers.some(row=>row.kind==='cessation_unverified'));

  recovery.release();
  await waitFor(async()=>!(await api(app,'/api/status')).blockers.some(row=>row.kind==='cessation_unverified'),'pending hold cleared');
  const after=await api(app,'/api/status');
  assert.equal(after.deadline_recovery.state,'clear');
  assert.equal(after.deadline_recovery.recovery_hold,undefined);
  assert.equal(after.deadline_recovery.complete,true);
});

// Cleanup isolation rule keeps unproven daemon ownership global.
test('a first pass with unproven daemon ownership stays held while startup serves',async t=>{
  const f=await appFixture(t),backend=syntheticBackend(f.root),recovery=slowRecovery(backend,()=>{throw Object.assign(new Error('still down'),{code:'daemon_owner_repair_required'});});
  const {app}=await started(f.start('async-recovery-fails',{backend,platform:'linux',cleanupRecheckMs:3_600_000}),recovery);
  assert.equal((await api(app,'/api/status')).blockers.find(row=>row.kind==='cessation_unverified').message,PENDING);
  recovery.fail(Object.assign(new Error('/private/SECRET inventory'),{code:'daemon_owner_repair_required'}));
  const hold=await waitFor(async()=>(await api(app,'/api/status')).blockers.find(row=>row.kind==='cessation_unverified'
    &&row.message!==PENDING&&row),'whole-recovery hold');
  assert.equal(hold.error_code,'daemon_owner_repair_required');
  assert.match(hold.message,/No new jobs start until recovery succeeds/);
  assert.doesNotMatch(JSON.stringify(hold),/SECRET|private/);
});

// Lending that was on before a restart comes back by itself. Its agent checks and its start are admission.
test('lending that was on waits for the first pass, then resumes by itself',{timeout:120000},async t=>{
  const {appFixture:lifecycle,api:call,waitFor:until}=await import('./helpers/v1-lifecycle-fixture.mjs');
  const {legacyProxyHarness}=await import('./helpers/legacy-proxy-harness.mjs');
  const f=await lifecycle(t);
  const {lender,circle}=await f.connect({});
  await call(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await call(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await call(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await call(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  await until(async()=>(await call(lender.app,'/api/status')).state==='ready','lending ready');
  await lender.app.close();
  const backend=syntheticBackend(f.root),recovery=slowRecovery(backend);let checks=0;
  const restarted=await started(f.start('lender',{backend,adapters:[{spec:legacyProxyHarness('codex')}],
    identityProbe:async()=>{checks++;return {providers:[{harness_id:'codex',installed:true,signedIn:true}]};}}),recovery);
  await new Promise(resolve=>setTimeout(resolve,300));
  const waiting=await call(restarted.app,'/api/status');
  assert.notEqual(waiting.state,'ready');
  assert.equal(waiting.blockers.find(row=>row.kind==='cessation_unverified')?.message,PENDING);
  assert.equal(checks,0,'no agent check runs while the first pass is pending');
  assert.equal(backend.calls.filter(call=>call[0]==='admit').length,0);
  recovery.release();
  await until(async()=>(await call(restarted.app,'/api/status')).state==='ready','lending resumed after the first pass',20000);
  assert.ok(checks>0,'the agents were checked once the pass ended');
});

// Close has a time budget. A recovery pass that never settles must not stop the server and discovery from coming down.
test('closing the app tears down the server and discovery even when the first recovery pass never settles',{timeout:60000},async t=>{
  const f=await appFixture(t),backend=syntheticBackend(f.root),recovery=slowRecovery(backend);
  const {app,home}=await started(f.start('async-recovery-close',{backend,cleanupRecheckMs:3_600_000,shutdownProofMs:300}),recovery);
  t.after(()=>recovery.release());
  const discovery=join(home,'v1','app.json');
  assert.equal(fs.existsSync(discovery),true);
  app.close().catch(()=>{}); // The recovery stays pending: the budget, not the pass, must end the wait.
  // `started` releases the pass after 8 s, so the teardown has to come well before that, from the close budget alone.
  await waitFor(()=>!fs.existsSync(discovery),'discovery removed after the close budget',4000);
  await assert.rejects(fetch(app.origin+'/api/status',{headers:{'x-faravan-session-token':app.token},signal:AbortSignal.timeout(5000)}),
    'the server no longer answers');
});
