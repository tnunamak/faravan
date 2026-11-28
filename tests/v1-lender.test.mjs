import {decideLending} from '../lib/v1/lending-decision.mjs';
import {lendingReasonCode,lendingReasonText,giveBackCode} from '../lib/v1/lending-reasons.mjs';
import './helpers/no-browser.mjs';
import {currentAdvertisement} from './helpers/current-job-advertisement.mjs';
import {fakeSandboxDeadlines} from './helpers/sandbox-receipt-fixture.mjs';
import { agentDisplayName } from '../lib/v1/lending-wait.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn,spawnSync } from 'node:child_process';
import { mkdtempSync,readFileSync,rmSync,symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { createLender, QUOTA_PROVIDERS, lenderDayKey, requesterCounterKey, validateRequesterLimits, RUN_FLAGS } from '../lib/v1/lender.mjs';
import { lenderFixture, deferred, until } from './helpers/v1-lender-fixture.mjs';
import { createProgressReporter, stepsFromLine } from '../lib/v1/progress.mjs';
import * as p from '../lib/protocol/index.mjs';
import {DockerSbxBackend} from '../lib/docker-backend.mjs';
import {withCleanCredentialScope} from './helpers/sbx-clean-scope.mjs';
import { realLenderFixture } from './helpers/v1-real-lender-fixture.mjs';
import {createLendingLedger} from '../lib/v1/lending-ledger.mjs';
import {resolveHarness} from '../lib/executor.mjs';
import {CODEX_HARNESS,CODEX_LENDING_HARNESS,CLAUDE_CODE_SUBSCRIPTION_HARNESS,CLAUDE_CODE_SUBSCRIPTION_LENDING_HARNESS} from '../lib/harnesses.mjs';

for(const [harness,ownerSpec,lendingSpec] of [
  ['codex',CODEX_HARNESS,CODEX_LENDING_HARNESS],
  ['claude-code-subscription',CLAUDE_CODE_SUBSCRIPTION_HARNESS,CLAUDE_CODE_SUBSCRIPTION_LENDING_HARNESS],
])test('borrowed '+harness+' job uses the ready Docker proxy adapter',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{harness});
  f.adapters[0]={...f.adapters[0],spec:ownerSpec,ownerSpec,lendingSpec,ownerSignedIn:true,proxySignedIn:true,enabled:true};
  let admitted;
  const admit=f.backend.admitJob.bind(f.backend);
  f.backend.admitJob=spec=>{admitted=spec;return admit(spec);};
  launch(f);await finish(f);
  const claim=f.requests.find(r=>r.route==='/jobs/claim-next');
  assert.deepEqual(claim.body.advertisement.harnesses,[harness]);
  assert.equal(admitted.execution_scope,'borrowed');
  assert.equal(admitted.auth_strategy,'docker-native-oauth');
  assert.equal(lendingSpec.credential_in_guest,false);
  assert.deepEqual(admitted.inputs,[]);
  assert.equal(runs(f),1);
});

for(const [harness,ownerSpec,lendingSpec] of [
  ['codex',CODEX_HARNESS,CODEX_LENDING_HARNESS],
  ['claude-code-subscription',CLAUDE_CODE_SUBSCRIPTION_HARNESS,CLAUDE_CODE_SUBSCRIPTION_LENDING_HARNESS],
]) test('owner '+harness+' job uses the ready proxy spec and copies no native generation',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{harness,authorIndex:1});
  f.policy.ownKeyId=f.job.payload.author;
  f.adapters[0]={...f.adapters[0],spec:ownerSpec,ownerSpec,lendingSpec,ownerSignedIn:true,
    proxySignedIn:true,proxySecretPresent:true,enabled:true};
  let admitted;
  const admit=f.backend.admitJob.bind(f.backend);
  f.backend.admitJob=spec=>{admitted=spec;return admit(spec);};
  launch(f);
  await finish(f);
  assert.equal(admitted.execution_scope,'owner');
  assert.equal(admitted.auth_strategy,'docker-native-oauth');
  assert.deepEqual(admitted.inputs,[]);
  assert.equal(lendingSpec.credential_in_guest,false);
});

for(const [harness,ownerSpec,lendingSpec] of [
  ['codex',CODEX_HARNESS,CODEX_LENDING_HARNESS],
  ['claude-code-subscription',CLAUDE_CODE_SUBSCRIPTION_HARNESS,CLAUDE_CODE_SUBSCRIPTION_LENDING_HARNESS],
]) test('owner '+harness+' job selects the proxy spec from a live provider secret row',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{harness,authorIndex:1});
  f.policy.ownKeyId=f.job.payload.author;
  const record={...f.adapters[0],spec:ownerSpec,ownerSpec,lendingSpec,ownerSignedIn:true,
    proxySecretPresent:true,enabled:true};
  f.adapters=job=>[{...record,proxySignedIn:job?false:true}];
  let admitted;
  const admit=f.backend.admitJob.bind(f.backend);
  f.backend.admitJob=spec=>{admitted=spec;return admit(spec);};
  launch(f);await finish(f);
  assert.equal(admitted.execution_scope,'owner');
  assert.equal(admitted.auth_strategy,'docker-native-oauth');
  assert.equal(admitted.auth_strategy==='provider-file-generation',false);
  assert.deepEqual(admitted.inputs,[]);
});

for(const [harness,ownerSpec,lendingSpec] of [
  ['codex',CODEX_HARNESS,CODEX_LENDING_HARNESS],
  ['claude-code-subscription',CLAUDE_CODE_SUBSCRIPTION_HARNESS,CLAUDE_CODE_SUBSCRIPTION_LENDING_HARNESS],
]) test('owner '+harness+' job ignores stale proxy readiness when the live provider secret is absent',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{harness,authorIndex:1});
  f.policy.ownKeyId=f.job.payload.author;
  f.adapters[0]={...f.adapters[0],spec:ownerSpec,ownerSpec,lendingSpec,ownerSignedIn:true,
    proxySignedIn:true,proxySecretPresent:false,enabled:true};
  let admitted;
  const admit=f.backend.admitJob.bind(f.backend);
  f.backend.admitJob=spec=>{admitted=spec;return admit(spec);};
  launch(f);await finish(f);
  assert.equal(admitted.execution_scope,'owner');
  assert.equal(admitted.auth_strategy,'provider-file-generation');
});

test('native sign-in alone never advertises a split subscription adapter',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{harness:'codex'});
  f.adapters[0]={...f.adapters[0],spec:CODEX_HARNESS,ownerSpec:CODEX_HARNESS,lendingSpec:CODEX_LENDING_HARNESS,
    ownerSignedIn:true,proxySignedIn:false,enabled:true};
  f.runOptions.runAccounts=()=>[];f.runOptions.accountExecution.configuredAccounts=()=>[];
  launch(f);
  await until(()=>f.events.some(e=>e.reason==='cannot_run_here'),'native-only lending refusal');
  await f.stop();
  assert.equal(f.count('/jobs/claim-next'),0);
  assert.equal(f.calls.some(([kind])=>kind==='prepare'),false);
});

for(const harness of ['codex','claude-code-subscription'])test('native '+harness+' never advertises or starts on a storage-capable lender',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{harness});
  f.adapters[0].spec=resolveHarness(harness);
  assert.ok((await f.backend.lenderCapabilities()).enforced_limits.includes('disk_bytes'));
  launch(f);
  await until(()=>f.events.some(e=>e.reason==='cannot_run_here'),'native lending refusal');
  await f.stop();
  assert.equal(f.count('/jobs/claim-next'),0);
  assert.equal(f.calls.length,0,'no sandbox preparation or credential copy');
});

test('native adapter does not hide a lendable proxy adapter',{timeout:60000},async t=>{
  const f=await lenderFixture(t);
  f.adapters.unshift({...f.adapters[0],spec:resolveHarness('claude-code-subscription')});
  let spec;const admit=f.backend.admitJob.bind(f.backend);
  f.backend.admitJob=job=>{spec=job;return admit(job);};
  launch(f);await finish(f);
  const claim=f.requests.find(r=>r.route==='/jobs/claim-next');
  assert.deepEqual(claim.body.advertisement.harnesses,['codex']);
  assert.equal(spec.execution_scope,'borrowed');
  assert.equal(spec.auth_strategy,'docker-native-oauth');
});

test('restart retains but never re-advertises an uncertain native claim',{timeout:60000},async t=>{
  const pending={advertisement:{harnesses:['claude-code-subscription'],models:[]},idempotencyKey:'old-native-intent'};
  const original=structuredClone(pending);
  const f=await lenderFixture(t,{saved:{day:'2026-10-09',jobs:0,milliseconds:0,claimPending:pending}});
  f.adapters.unshift({...f.adapters[0],spec:resolveHarness('claude-code-subscription')});
  launch(f);await until(()=>f.events.some(e=>e.reason==='cannot_run_here'),'old native claim held');
  await f.stop();
  assert.equal(f.count('/jobs/claim-next'),0);
  assert.deepEqual(pending,original,'loading must not mutate the stored input');
  assert.deepEqual(f.saved().claimPending,{...original,state:'created-unsent'});
});

test('restart replays an uncertain claim made through the ready Docker proxy',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{harness:'codex'});
  const report=await f.backend.lenderCapabilities();
  const advertisement={harnesses:['codex'],models:[],capabilities:[],egress:report.egress,enforced_limits:report.enforced_limits,max_limits:report.max_limits};
  await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,
    claimPending:{advertisement,exclude:[],leaseSeconds:120,idempotencyKey:'proxy-intent'}});
  f.adapters[0]={...f.adapters[0],spec:CODEX_HARNESS,ownerSpec:CODEX_HARNESS,lendingSpec:CODEX_LENDING_HARNESS,
    ownerSignedIn:true,proxySignedIn:true,proxySecretPresent:true,enabled:true};
  launch(f);
  await until(()=>f.count('/jobs/claim-next')>0||f.events.some(e=>e.reason==='cannot_run_here'),'replay or refusal');
  await f.stop();
  assert.equal(f.events.some(e=>e.reason==='cannot_run_here'),false);
  const claim=f.requests.find(r=>r.route==='/jobs/claim-next');
  assert.equal(claim.req.headers['idempotency-key'],'proxy-intent');
});

test('real HTTP queue matches preferred disk against a four-limit lender',{timeout:60000},async t=>{
  const f=await realLenderFixture(t,{mutateJob:job=>{job.requirements.limit_modes={disk_bytes:'preferred'};},
    executionEvidence:{enforced_limits:['cpu','memory','wall','output'],unenforced:['storage']}});
  const report=f.backend.lenderCapabilities();
  f.backend.lenderCapabilities=()=>({...report,
    enforced_limits:report.enforced_limits.filter(k=>k!=='disk_bytes'),
    max_limits:{...report.max_limits,disk_bytes:1048576}});
  launch(f);await finish(f);
  assert.equal((await f.owner.getJob(f.jobDigest)).state,'result-accepted');
  assert.equal(runs(f),1);
  // Disk is watched on the host, never enforced: the receipt must not claim it.
  const receipt=f.result?.payload?.receipt??(await f.owner.getJob(f.jobDigest)).result?.receipt;
  if(receipt){assert.equal(receipt.enforced_limits.includes('storage'),false);assert.ok(receipt.unenforced.includes('storage'));}
});

test('H2 real HTTP definitive completion rejection is recorded and the lender claims fresh work',{timeout:60000},async t=>{
  const f=await realLenderFixture(t),first=f.jobDigest,second=await f.submit();
  let rejectedDigest;
  const complete=f.client.completeAttempt.bind(f.client);let calls=0;
  f.client.completeAttempt=async(...args)=>{
    calls++;
    if(calls===1){rejectedDigest=args[0].job_digest;await f.owner.cancelJob(rejectedDigest);}
    return complete(...args);
  };
  launch(f);
  await until(()=>f.events.some(e=>e.status==='finished'),'second job finishes');
  await f.stop();
  assert.equal((await f.owner.getJob(rejectedDigest)).state,'cancelled');
  assert.equal((await f.owner.getJob(rejectedDigest===first?second:first)).state,'result-accepted');
  assert.equal(calls,2,'a definitive rejection is never replayed');
  assert.equal(f.saved().resultPending,null);
  assert.equal(f.saved().lastResultOutcome.code,'job_terminal');
  // The borrower cancelled, so the rejected delivery is a stop, never a failure (spec/tla/README.md, Stop: FinishedNeverFailed).
  assert.ok(f.events.some(e=>e.status==='stopped'&&e.reason==='job_ended'));
  assert.ok(!f.events.some(e=>e.status==='failed'&&e.reason==='job_ended'));
});

test('H3 real HTTP expired committed claim replay is released and replaced with a fresh key',{timeout:60000},async t=>{
  const f=await realLenderFixture(t);
  const advertisement=(await f.backend.lenderCapabilities());
  const ad=currentAdvertisement({harnesses:['codex'],models:['example-model'],capabilities:[],egress:advertisement.egress,
    enforced_limits:advertisement.enforced_limits,max_limits:advertisement.max_limits},f.runOptions.runAccounts());
  const key='expired-committed-claim';
  const claimed=await f.client.claimNext(ad,{leaseSeconds:30,waitSeconds:30,idempotencyKey:key});
  assert.ok(claimed);
  await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,
    claimPending:{advertisement:ad,leaseSeconds:30,idempotencyKey:key}});
  f.clock.advance(31000);
  launch(f);
  await until(()=>f.events.some(e=>e.status==='failed'),'expired replay reported');
  assert.equal(f.events.find(e=>e.status==='failed').reason,'execution_failed');
  const replay=f.realRequests.filter(r=>r.url.endsWith('/jobs/claim-next')&&r.key===key);
  assert.equal(replay.length,2,'lender retries the committed key once before abandoning it');
  assert.equal(replay[0].bodyDigest,replay[1].bodyDigest,'idempotent replay preserves the complete request body');
  await until(()=>f.saved().claimPending===null||f.saved().claimPending?.idempotencyKey!==key,'stale key abandoned');
  f.clock.advance(1000);
  await until(()=>f.realRequests.some(r=>r.url.endsWith('/jobs/claim-next')&&r.key!==key),'fresh claim key');
  await f.stop();
  assert.ok(f.realRequests.some(r=>r.url.endsWith('/release')),'rejected committed attempt released');
});

test('M8 restart retains the reservation until cessation is verified and then reconciles',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{saved:{day:'2026-10-09',jobs:1,milliseconds:120000,
    pending:{attemptId:'old-attempt',reservedMs:120000}}});
  let verified=false,calls=0;
  f.backend.reconcilePending=async pending=>{calls++;return {attemptId:pending.attemptId,removed:verified};};
  launch(f);
  await until(()=>f.events.some(e=>e.reason==='cleanup_pending'),'unverified restart remains closed');
  assert.equal(f.count('/jobs/claim-next'),0);assert.equal(f.saved().pending.attemptId,'old-attempt');
  verified=true;f.clock.advance(1000);
  await until(()=>f.saved().pending===null,'verified restart clears old reservation');
  await finish(f);
  assert.ok(calls>=2);assert.equal(f.saved().jobs,2,'unknown previous execution keeps its reserved job count');
  assert.ok(f.saved().milliseconds>=120000,'unknown prior runtime stays conservatively charged');
});

// Launch fence: an authorized start that was never observed may still be running after its lease ends.
async function fencedLaunch(f) {
  const report=await f.backend.lenderCapabilities();
  const ad=currentAdvertisement({harnesses:['codex'],models:['example-model'],capabilities:[],egress:report.egress,
    enforced_limits:report.enforced_limits,max_limits:report.max_limits},f.runOptions.runAccounts());
  const {attempt}=await f.client.claimNext(ad,{leaseSeconds:30});
  await f.client.startAttempt(attempt);
  return {ad,attempt};
}
async function assertHeld(f,ad,attempt) {
  const view=await f.owner.getJob(f.jobDigest);
  assert.equal(view.state,'claimed','the unobserved launch is fenced, not requeued');
  assert.equal(view.current_attempt.attempt_id,attempt.attempt_id);
  assert.equal(await f.clientFor(3).claimNext(ad,{leaseSeconds:30,waitSeconds:0}),null,'no second lender can start it');
}
async function assertReleasedByProof(f,attempt) {
  const view=await f.owner.getJob(f.jobDigest);
  if(view.current_attempt.attempt_id===attempt.attempt_id) {
    assert.equal(view.state,'queued');assert.equal(view.current_attempt.compute_stopped,true);
  } else assert.notEqual(view.state,'failed','the job ran again only after the proof');
  assert.ok(f.realRequests.some(r=>r.url.endsWith('/attempts/'+attempt.attempt_id+'/stopped')));
}

test('launch fence: restart stop recovery against a fenced attempt reaches its stop report and frees the job',{timeout:60000},async t=>{
  const f=await realLenderFixture(t,{members:true});
  const {ad,attempt}=await fencedLaunch(f);
  await f.policy.storage.set({day:'2026-10-09',jobs:1,milliseconds:120000,pending:{...f.backend.sandboxOwnership(),attemptId:attempt.attempt_id,attempt,
    reservedMs:120000,executionStartRequested:true,stopReason:'stopped_by_lender',stopReleaseKey:'fence-release',
    stopReportKey:'fence-report',stoppedAt:new Date(f.clock.now()).toISOString().replace(/\.\d{3}Z$/,'Z'),
    cessationVerified:{sbx_home:f.backend.sandboxOwnership().sbx_home,attemptId:attempt.attempt_id,jobDigest:f.jobDigest,generation:attempt.generation}}});
  f.clock.advance(31000);
  await assertHeld(f,ad,attempt);
  launch(f);
  await until(()=>f.saved().pending===null,'stop recovery completes against the fence');
  await f.stop();
  await assertReleasedByProof(f,attempt);
});

test('launch fence: a fenced attempt survives a lender restart and is freed only by cleanup proof',{timeout:60000},async t=>{
  const f=await realLenderFixture(t,{members:true});
  const {ad,attempt}=await fencedLaunch(f);
  await f.policy.storage.set({day:'2026-10-09',jobs:1,milliseconds:120000,pending:{attemptId:attempt.attempt_id,attempt,
    reservedMs:120000,executionStartRequested:true,charged:true}});
  let removed=false;
  f.backend.reconcilePending=async pending=>({attemptId:pending.attemptId,removed});
  f.clock.advance(31000);
  launch(f);
  await until(()=>f.events.some(e=>e.reason==='cleanup_pending'),'unproven cleanup stays closed');
  await f.stop();
  await assertHeld(f,ad,attempt);
  assert.equal(f.realRequests.some(r=>r.url.endsWith('/stopped')),false);
  removed=true;f.clock.advance(1000);
  launch(f);
  await until(()=>f.realRequests.some(r=>r.url.endsWith('/attempts/'+attempt.attempt_id+'/stopped'))&&
    f.saved().stoppedPending===null&&f.saved().declinePending===null,'proof is reported after restart');
  await f.stop();
  await assertReleasedByProof(f,attempt);
});

// Mixed versions: the .38 preview lender (source 3cce5cc4) tolerates only stale_attempt, job_expired, job_terminal and
// lease_expired when its owner-stop release is refused. Run that exact lender against this coordinator.
const OLD_LENDER_COMMIT='3cce5cc4a637f8f7399a5d9c747129c1d0dcb6a0';
async function oldCreateLender(t) {
  const root=fileURLToPath(new URL('..',import.meta.url));
  if(spawnSync('git',['-C',root,'cat-file','-e',OLD_LENDER_COMMIT+'^{commit}']).status!==0)return null;
  const dir=mkdtempSync(join(tmpdir(),'old-lender-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const archive=spawnSync('git',['-C',root,'archive','--format=tar',OLD_LENDER_COMMIT,'lib','docs/protocol','package.json'],{maxBuffer:1<<30});
  assert.equal(archive.status,0);
  assert.equal(spawnSync('tar',['-x','-C',dir],{input:archive.stdout}).status,0);
  symlinkSync(join(root,'node_modules'),join(dir,'node_modules'));
  return (await import(pathToFileURL(join(dir,'lib/v1/lender.mjs')).href)).createLender;
}

test('launch fence: an old lender stop recovery settles against a fenced attempt instead of looping',{timeout:60000},async t=>{
  const createOldLender=await oldCreateLender(t);
  if(!createOldLender){t.skip('old lender commit '+OLD_LENDER_COMMIT.slice(0,8)+' is not in this checkout');return;}
  const f=await realLenderFixture(t,{members:true});
  const {ad,attempt}=await fencedLaunch(f);
  await f.policy.storage.set({day:'2026-10-09',jobs:1,milliseconds:120000,pending:{attemptId:attempt.attempt_id,attempt,
    reservedMs:120000,executionStartRequested:true,stopReason:'stopped_by_lender',stopReleaseKey:'old-release',
    stopReportKey:'old-report',stoppedAt:new Date(f.clock.now()).toISOString().replace(/\.\d{3}Z$/,'Z'),
    cessationVerified:{sbx_home:f.backend.sandboxOwnership().sbx_home,attemptId:attempt.attempt_id,jobDigest:f.jobDigest,generation:attempt.generation}}});
  f.clock.advance(31000);
  await assertHeld(f,ad,attempt);
  const controller=new AbortController();
  const running=Promise.resolve(createOldLender({client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,
    clock:f.clock,approve:async()=>true,onEvent:event=>{f.events.push(event);}}).start(controller.signal)).catch(()=>{});
  t.after(async()=>{controller.abort();await running;});
  await until(()=>f.saved().pending===null,'old lender stop recovery completes',15000);
  controller.abort();await running;
  await assertReleasedByProof(f,attempt);
});

for(const scenario of ['write_rejected','removal_unverified','graceful'])test('owner Stop keeps physical ownership after graceful journal '+scenario,{timeout:60000},async t=>{
  const f=await lenderFixture(t,{hold:true}), removal=deferred();
  const write=f.policy.storage.set,cancel=f.backend.cancel,destroy=f.backend.destroy,prepare=f.backend.prepare;
  const candidate=f.policy.lendingRuntime.candidate,recordCleanup=candidate.recordCleanup;
  let handle,context,initial,receipt;
  const cleanupSeen=[],stoppedReports=[];
  const accounting=value=>({jobs:value.jobs,milliseconds:value.milliseconds,requesters:value.requesters,ruleUsage:value.ruleUsage});
  const identity=pending=>({attemptId:pending.attemptId,attempt:pending.attempt,jobId:pending.jobId,
    sandboxId:pending.sandboxId,scratchDir:pending.scratchDir,sbx_runtime:pending.sbx_runtime,reservedMs:pending.reservedMs});
  f.backend.prepare=async function(...args){assert.equal(this,f.backend);context=args[1].preparationContext;handle=await prepare.apply(this,args);return handle;};
  const bound=actual=>{
    assert.equal(actual,handle);assert.equal(actual.sandbox_id,initial.pending.sandboxId);
    assert.equal(context.attemptId,initial.pending.attemptId);assert.equal(context.jobId,initial.pending.jobId);
    assert.equal(context.generation,initial.pending.attempt.generation);
  };

  const failure=Object.assign(new Error('synthetic graceful journal rejection'),{code:'EIO'});
  let rejected=false,gracefulCalls=0,cancels=0,destroys=0,runEnded=false;
  const assertOneOwnedStop=(reports=stoppedReports)=>{
    assert.equal(reports.length,1,'exactly one stopped report after owned removal');
    assert.ok(reports[0].route.endsWith('/attempts/'+initial.pending.attemptId+'/stopped'));
    assert.equal(reports[0].generation,initial.pending.attempt.generation);
    assert.equal(reports[0].receipt,receipt);
    assert.equal(receipt.removed,true);

    for(const suffix of ['/complete','/fail'])assert.equal(f.count(suffix),0,suffix);
    const releases=f.requests.filter(row=>row.route.endsWith('/release'));
    assert.equal(releases.length,1,'verified Stop releases the exact attempt once');
    assert.ok(releases[0].route.endsWith('/attempts/'+initial.pending.attemptId+'/release'));
    assert.equal(JSON.parse(releases[0].body.reason).code,'stopped_by_lender');
  };
  f.override=async({route})=>{
    if(scenario==='write_rejected'&&route.endsWith('/stopped')){
      stoppedReports.push({route,generation:f.saved().pending?.attempt.generation,receipt});
    }
    if(route.endsWith('/complete')||route.endsWith('/stopped')){
      assert.ok(route.includes('/attempts/'+initial.pending.attemptId+'/'));
      assert.equal(f.saved().pending.attempt.generation,initial.pending.attempt.generation);
      assert.equal(receipt?.removed,true);assert.equal(destroys,1);
    }
    return false;
  };
  f.policy.storage.set=async value=>{
    if(scenario!=='graceful'&&!rejected&&value.pending?.gracefulStopReason==='owner'){
      rejected=true;throw failure;
    }
    return write(value);
  };
  f.backend.requestStop=async function(actual,why){
    assert.equal(this,f.backend);bound(actual);assert.equal(why,'owner');
    gracefulCalls++;return {delivered:true};
  };
  f.backend.cancel=async function(...args){assert.equal(this,f.backend);bound(args[0]);cancels++;return cancel.apply(this,args);};
  f.backend.destroy=async function(...args){
    assert.equal(this,f.backend);bound(args[0]);destroys++;await removal.promise;
    receipt=scenario==='removal_unverified'?{removed:false}:await destroy.apply(this,args);
    return receipt;
  };
  const start=f.backend.start;
  f.backend.start=async function(...args){
    try{return await start.apply(this,args);}
    finally{if(f.calls.some(([kind])=>kind==='run'))runEnded=true;}
  };
  const lender=launch(f);
  try {
    await until(()=>runs(f)===1&&f.events.some(e=>e.status==='running'),'actual agent running');
    initial=structuredClone(f.saved());
    const attemptId=f.attempt().attempt_id;
    assert.equal(initial.pending.attemptId,attemptId);assert.equal(initial.pending.attempt.job_digest,f.jobDigest);
    assert.equal(initial.pending.attempt.generation,f.attempt().generation);bound(handle);
    if(scenario==='graceful'){
      await lender.stopCurrentJob(attemptId);
      assert.equal(gracefulCalls,1);assert.equal(cancels,0);
      assert.equal(runEnded,false,'graceful delivery does not force an abort');
      f.execution.resolve();
      await until(()=>destroys===1,'graceful cleanup reaches the actual handle');
      assert.equal(f.count('/complete'),0);assert.equal(f.count('/stopped'),0);
      assert.equal(lender.cessation().proven,false);
      removal.resolve();await finish(f);
      assert.equal(cancels,0);assert.equal(destroys,1);assert.equal(receipt.removed,true);
      assert.equal(f.count('/complete'),1);
    } else {
      await assert.rejects(lender.stopCurrentJob(attemptId),e=>e===failure);
      await until(()=>cancels===1&&destroys===1&&runEnded,'fallback cancels actual running backend');
      assert.equal(gracefulCalls,0,'failed journal is not delivered Stop');
      assert.equal(lender.snapshot.stopping,true,'in-memory Stop is not reset');
      assert.equal(lender.cessation().proven,false);
      assert.equal(f.count('/stopped'),0,'no success before backend proof');
      assert.equal(f.count('/release'),0,'no release before backend proof');
      assert.equal(f.count('/complete'),0);
      await lender.stopCurrentJob(attemptId);
      assert.equal(cancels,1,'repeat Stop does not duplicate cancellation');
      removal.resolve();
      if(scenario==='removal_unverified'){
        await until(()=>f.events.some(e=>e.reason==='cleanup_pending'),'cleanup failure surfaced');
        await f.stop();
        assert.deepEqual(identity(f.saved().pending),identity(initial.pending));
        assert.deepEqual(accounting(f.saved()),accounting(initial),'unverified removal cannot refund held accounting');
        for(const key of ['agentStartDenied','cessationVerified','timeAdjustmentApplied','actualUse'])
          assert.equal(f.saved().pending[key],undefined);
        assert.equal(f.count('/release'),0);assert.equal(f.count('/fail'),0);
        assert.equal(lender.cessation().proven,false);assert.equal(f.count('/stopped'),0);
      } else {
        await until(()=>f.saved().pending===null,'proven cleanup drains ownership');
        assert.throws(()=>assertOneOwnedStop([]),/exactly one stopped report/);
        assertOneOwnedStop();
        await f.stop();
        assertOneOwnedStop();
      }
      assert.equal(f.count('/complete'),0);assert.equal(destroys,1);
      assert.equal(runs(f),1,'no provider work restarts after Stop');
      assert.equal(rejected,true,'the precise graceful-owner write failed once');
    }
  } finally {
    removal.resolve();f.execution.resolve();await f.stop();
  }
});

for(const delivered of [true,false])test('owner Stop preserves actual collected output during deferred retention: '+delivered,{timeout:60000},async t=>{
  const f=await lenderFixture(t,{hold:true}),retention=deferred(),removal=deferred();
  const prepare=f.backend.prepare,collect=f.backend.collectDeclaredOutputs,destroy=f.backend.destroy,write=f.policy.storage.set;
  const candidate=f.policy.lendingRuntime.candidate,recordCleanup=candidate.recordCleanup;
  let handle,context,initial,held,receipt,collectedBytes,retentionEntered=false,retentionSaved=false;
  let destroys=0,cancels=0,retentionWrites=0;
  const stops=[],cleanups=[];
  const identity=pending=>({attemptId:pending.attemptId,attempt:pending.attempt,jobId:pending.jobId,
    sandboxId:pending.sandboxId,scratchDir:pending.scratchDir,sbx_runtime:pending.sbx_runtime,reservedMs:pending.reservedMs});
  const accounting=value=>({jobs:value.jobs,milliseconds:value.milliseconds,requesters:value.requesters,ruleUsage:value.ruleUsage});
  f.backend.prepare=async function(...args){
    assert.equal(this,f.backend);context=args[1].preparationContext;handle=await prepare.apply(this,args);return handle;
  };
  const bound=actual=>{
    assert.equal(actual,handle);assert.equal(actual.sandbox_id,initial.pending.sandboxId);
    assert.equal(context.attemptId,initial.pending.attemptId);assert.equal(context.jobId,initial.pending.jobId);
    assert.equal(context.generation,initial.pending.attempt.generation);
  };
  f.backend.collectDeclaredOutputs=async function(...args){
    assert.equal(this,f.backend);bound(args[0]);
    const files=await collect.apply(this,args);
    collectedBytes=files.map(file=>Buffer.from(file.bytes_content));
    return files;
  };
  f.policy.storage.set=async value=>{
    if(!retentionEntered&&value.outputPending?.result){
      retentionEntered=true;retentionWrites++;held=structuredClone(value.outputPending);
      await retention.promise;await write(value);retentionSaved=true;return;
    }
    return write(value);
  };
  f.backend.requestStop=async function(actual,why){
    assert.equal(this,f.backend);bound(actual);assert.equal(why,'owner');
    stops.push({actual,retentionSaved});return {delivered};
  };
  f.backend.cancel=async function(actual){
    assert.equal(this,f.backend);bound(actual);cancels++;assert.fail('held output must not be force-cancelled');
  };
  f.backend.destroy=async function(...args){
    assert.equal(this,f.backend);bound(args[0]);assert.equal(retentionSaved,true);
    destroys++;await removal.promise;receipt=await destroy.apply(this,args);return receipt;
  };

  f.override=async({route})=>{
    if(route.endsWith('/complete')||route.endsWith('/stopped')){
      assert.ok(route.includes('/attempts/'+initial.pending.attemptId+'/'));
      assert.equal(retentionSaved,true);assert.equal(receipt?.removed,true);
      assert.equal(destroys,1);
    }
    return false;
  };
  const lender=launch(f);
  try {
    await until(()=>runs(f)===1&&f.events.some(e=>e.status==='running'),'actual agent running');
    initial=structuredClone(f.saved());const attemptId=initial.pending.attemptId;
    assert.equal(attemptId,f.attempt().attempt_id);assert.equal(initial.pending.attempt.job_digest,f.jobDigest);
    assert.equal(initial.pending.attempt.generation,f.attempt().generation);bound(handle);
    f.execution.resolve();await until(()=>retentionEntered,'actual collected output retention is deferred');
    assert.ok(handle._outputHandoff instanceof Promise,'real executor owns the output handoff');
    assert.equal(held.claim.attempt.attempt_id,attemptId);assert.equal(held.claim.job_digest,f.jobDigest);
    assert.equal(held.claim.attempt.generation,initial.pending.attempt.generation);
    assert.ok(collectedBytes.length>0);assert.ok(collectedBytes.every(bytes=>bytes.length>0));
    assert.deepEqual(held.result.collected.map(file=>Buffer.from(file.bytes_content,'base64')),collectedBytes);
    // Finished output is not a current stoppable job. The public API rejects even
    // though its held-output branch asks the backend to stop remaining provider work.
    await assert.rejects(lender.stopCurrentJob(attemptId),error=>error.code==='no_current_job');
    assert.equal(stops.length,1);assert.equal(stops[0].retentionSaved,false);
    assert.equal(retentionSaved,false);assert.equal(destroys,0);assert.equal(cancels,0);
    assert.equal(f.saved().outputPending??null,null);
    assert.deepEqual(identity(f.saved().pending),identity(initial.pending));
    assert.deepEqual(accounting(f.saved()),accounting(initial));
    assert.equal(lender.cessation().proven,false);assert.equal(f.count('/stopped'),0);assert.equal(f.count('/complete'),0);
    assert.equal(runs(f),1);
    retention.resolve();await until(()=>destroys===1,'retained output reaches cleanup');
    assert.deepEqual(f.saved().outputPending.result.collected,held.result.collected);
    assert.equal(f.count('/complete'),0);assert.equal(f.count('/stopped'),0);
    assert.equal(lender.cessation().proven,false,'entering destroy is not removal proof');
    removal.resolve();await finish(f);
    assert.equal(retentionWrites,1);assert.equal(destroys,1);assert.equal(cancels,0);assert.equal(runs(f),1);
    assert.equal(receipt.removed,true);
    assert.equal(f.count('/complete'),1);assert.equal(f.count('/stopped'),1);
    assert.equal(f.count('/fail'),0);assert.equal(f.count('/release'),0);
    assert.equal(f.result.payload.attempt_id,attemptId);assert.equal(f.result.payload.job_digest,f.jobDigest);
    assert.deepEqual(f.artifacts.get(f.result.payload.candidate.digest),collectedBytes[0]);
    assert.equal(f.saved().outputPending,null);assert.equal(f.saved().pending,null);
    assert.equal(stops.length,delivered?1:3,'undelivered Stop retries only at the two retained-output handoffs');
    assert.ok(stops.slice(1).every(stop=>stop.retentionSaved));
  } finally {
    retention.resolve();removal.resolve();f.execution.resolve();await f.stop();
  }
});

function launch(f, options={}) {
  const controller=new AbortController();
  const lender=createLender({...f.runOptions,client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,
    clock:options.clock??f.clock,approve:options.approve??(async()=>true),
    onDiagnostic:options.onDiagnostic,
    onEvent:event=>{f.events.push(event);return options.onEvent?.(event);}});
  const running=lender.start(controller.signal);
  // Capture failures immediately; assertions below still surface non-abort failures on shutdown.
  let failure; const settled=Promise.resolve(running).catch(error=>{failure=error;});
  f.stop=async()=>{controller.abort();let timer;
    try{await Promise.race([settled,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Lender shutdown timed out')),2000);})]);}
    finally{clearTimeout(timer);}
    if(failure&&failure.name!=='AbortError'&&failure.code!=='aborted')throw failure;};
  return lender;
}
for (const boundary of ['before_handle', 'prepared_save', 'cancel_failed', 'destroy_failed', 'success']) test('prepared handle has abort ownership during journal save: '+boundary,{timeout:60000},async t=>{
  const f=await lenderFixture(t), prepared=deferred(), saveGate=deferred();
  let prepareEntered=false, saveEntered=false, saveReleased=false, cancels=0, destroys=0, dispatches=0, stopping;
  const prepare=f.backend.prepare, cancel=f.backend.cancel, destroy=f.backend.destroy, start=f.backend.start;
  const write=f.policy.storage.set;
  f.backend.prepare=async function(...args){
    assert.equal(this,f.backend);
    const handle=await prepare.apply(this,args);
    prepareEntered=true;
    if(boundary==='before_handle')await prepared.promise;
    return handle;
  };
  f.backend.cancel=async function(...args){assert.equal(this,f.backend);cancels++;if(boundary==='cancel_failed')throw new Error('synthetic cancel failure');return cancel.apply(this,args);};
  f.backend.destroy=async function(...args){assert.equal(this,f.backend);destroys++;if(boundary==='destroy_failed')throw new Error('synthetic destroy failure');return destroy.apply(this,args);};
  f.backend.start=async function(...args){assert.equal(this,f.backend);dispatches++;return start.apply(this,args);};
  f.policy.storage.set=async value=>{
    if(!saveEntered&&value.pending?.sandboxId==='synthetic-only'){
      saveEntered=true;await saveGate.promise;saveReleased=true;
    }
    return write(value);
  };
  const lender=launch(f);
  try {
    await until(()=>prepareEntered,'actual prepare returned its handle');
    if(boundary==='before_handle'){
      stopping=f.stop();stopping.catch(()=>{});
      prepared.resolve();
    }
    await until(()=>saveEntered,'prepared-handle journal write held');
    if(boundary!=='before_handle'&&boundary!=='success'){stopping=f.stop();stopping.catch(()=>{});}
    if(boundary!=='success'){
      await until(()=>cancels===1,'physical cancellation before journal acknowledgment',1000);
      assert.equal(saveReleased,false);
      assert.equal(dispatches,0);
      assert.equal(f.count('/start'),0);
      assert.equal(lender.cessation().proven,false,'a cancel is not a removal receipt');
      saveGate.resolve();
      await stopping;
      assert.equal(cancels,1,'temporary owner cancels only once');
      assert.equal(destroys,1,'cancel failure cannot skip independently owned removal');
      assert.equal(dispatches,0,'resolving storage cannot launch late work');
      assert.equal(f.count('/start'),0);
      if(boundary==='destroy_failed'){
        assert.ok(f.saved().pending,'failed cleanup retains recovery ownership');
        assert.equal(lender.cessation().proven,false);
        assert.equal(f.count('/stopped'),0,'failed cleanup is not proof of cessation');
      } else assert.equal(f.saved().pending,null,'verified removal drains pending ownership');
    } else {
      assert.equal(cancels,0);
      saveGate.resolve();
      await finish(f);
      assert.equal(runs(f),1);
      assert.equal(cancels,0,'ordinary executor owns the successful lifetime');
      assert.equal(destroys,1);
    }
  } finally {
    prepared.resolve();saveGate.resolve();
    await (stopping??f.stop());
  }
});


for(const scenario of [
  'save_rejected','save_frozen','save_nonextensible','save_unknown','save_destroy_throws',
  'abort_removed','abort_unknown','abort_destroy_throws','abort_late_save_rejection','abort_owner_stop',
]) test('pre-output cleanup preserves initiating failure and independent removal: '+scenario,{timeout:60000},async t=>{
  const f=await lenderFixture(t),saveGate=deferred(),cancelGate=deferred();
  const prepare=f.backend.prepare,write=f.policy.storage.set;
  const candidate=f.policy.lendingRuntime.candidate,recordCleanup=candidate.recordCleanup;
  const diagnostics=[],cleanups=[];
  let handle,context,prepareSignal,draft,before,saveEntered=false,saveReleased=false;
  let cancels=0,destroys=0,cancelSettled=false,stopping,ownerStop,recordFailures=0;
  const abort=scenario.startsWith('abort_');
  const unknown=scenario.endsWith('unknown'),destroyThrows=scenario.endsWith('destroy_throws');
  let primary=Object.assign(new Error('initiating prepared identity save failed'),{code:'prepare_save_failed'});
  if(scenario==='save_frozen'||scenario==='abort_late_save_rejection')Object.freeze(primary);
  if(scenario==='save_nonextensible')Object.preventExtensions(primary);
  const receipt=Object.freeze({removed:!unknown,scratch_removed:!unknown});
  f.backend.prepare=async function(...args){
    assert.equal(this,f.backend);context=args[1].preparationContext;prepareSignal=args[1].signal;
    handle=await prepare.apply(this,args);return handle;
  };
  const bound=actual=>{
    assert.equal(actual,handle);
    assert.equal(actual.sandbox_id,draft.pending.sandboxId);
    assert.equal(actual.scratch_dir,draft.pending.scratchDir);
    assert.equal(context.attemptId,draft.pending.attemptId);
    assert.equal(context.jobId,draft.pending.jobId);
    assert.equal(context.generation,draft.pending.attempt.generation);
  };
  f.backend.cancel=async function(actual){
    assert.equal(this,f.backend);bound(actual);cancels++;
    await cancelGate.promise;cancelSettled=true;
    throw Object.assign(new Error('secondary cancel failure'),{code:'cancel_failed'});
  };
  f.backend.destroy=async function(actual){
    assert.equal(this,f.backend);bound(actual);destroys++;
    assert.equal(cancelSettled,true,'join the single cancellation before independent removal');
    assert.equal(saveReleased,true,'removal waits for the save boundary to settle');
    if(destroyThrows)throw Object.assign(new Error('secondary destroy failure'),{code:'destroy_failed'});
    return receipt;
  };

  f.policy.storage.set=async value=>{
    if(!saveEntered&&value.pending?.sandboxId==='synthetic-only'){
      saveEntered=true;draft=structuredClone(value);before=structuredClone(f.saved());
      await saveGate.promise;saveReleased=true;
      if(!abort||scenario==='abort_late_save_rejection')throw primary;
    }
    return write(value);
  };
  const lender=launch(f,{onDiagnostic:event=>diagnostics.push(event)});
  try {
    await until(()=>saveEntered,'actual prepared-handle journal is held');
    assert.equal(f.calls.filter(([name])=>name==='prepare').length,1);
    assert.equal(f.count('/start'),0);
    if(abort){
      if(scenario==='abort_owner_stop'){
        ownerStop=lender.stopCurrentJob(draft.pending.attemptId);ownerStop.catch(()=>{});
      }
      stopping=f.stop();stopping.catch(()=>{});
      await until(()=>cancels===1,'actual abort invokes temporary cancellation owner');
      assert.equal(prepareSignal.aborted,true);
      assert.equal(saveReleased,false);assert.equal(destroys,0);
      assert.equal(lender.cessation().proven,false);
    }
    saveGate.resolve();
    await until(()=>cancels===1,'save/abort failure starts exactly one cancel');
    assert.equal(destroys,0,'unsettled cancellation is joined, not retried');
    cancelGate.resolve();
    const expectedCode=abort&&scenario!=='abort_late_save_rejection'?'cancelled':'prepare_save_failed';
    await until(()=>diagnostics.some(event=>event.code===expectedCode),'original initiating error remains visible');
    if(stopping){await stopping;await ownerStop;}
    else {await until(()=>lender.snapshot.current===null,'failed preparation finalized');await f.stop();}
    assert.equal(cancels,1);assert.equal(destroys,1);
    assert.equal(f.count('/start'),0);
    assert.equal(f.count('/complete'),0);
    assert.equal(f.calls.some(([name])=>['clone','run','pack','collect'].includes(name)),false);
    // The lender may poll again for other offers before stop; every later poll must exclude the failed job.
    const claims=f.requests.filter(r=>r.route==='/jobs/claim-next');
    assert.equal(claims.filter(r=>!r.body?.exclude?.includes(f.jobDigest)).length,1,'failure cannot create a second execution claim');
    assert.equal(claims[0].body?.exclude?.includes(f.jobDigest)??false,false,'the first poll took the job');
    assert.equal(diagnostics.some(event=>['cancel_failed','destroy_failed'].includes(event.code)),false);
    if(unknown||destroyThrows||scenario==='record_rejected'){
      assert.ok(f.saved().pending,'unverified removal or rejected durable proof retains recovery');
      assert.equal(f.saved().pending.attemptId,before.pending.attemptId);
      assert.equal(f.saved().pending.jobId,before.pending.jobId);
      assert.equal(f.saved().pending.reservedMs,before.pending.reservedMs);
      assert.equal(f.saved().milliseconds,before.milliseconds,'no refund without durable removal proof');
      if(unknown||destroyThrows){
        assert.equal(lender.cessation().proven,false);
        assert.equal(f.count('/stopped'),0);
      } else assert.ok(recordFailures>=2,'finalization retries proof and retains its durability rejection');
    } else {
      assert.equal(f.saved().pending,null);
    }
    if(scenario==='save_frozen'||scenario==='save_nonextensible'||scenario==='abort_late_save_rejection')
      assert.equal(Object.hasOwn(primary,'cleanupReceipt'),false,'nonextensible primary is not rewritten');
  } finally {
    saveGate.resolve();cancelGate.resolve();
    await (stopping??f.stop());
  }
});



const countNamedClaimPosts = requests => requests.filter(({route,req}) =>
  req.method === 'POST' && /^\/jobs\/[^/]+\/claim$/.test(route)).length;

test('prepared reopen counts synthetic named claim attempts independently of proof', () => {
  const requests = [
    {route:'/jobs/fixture-job/claim',req:{method:'POST'}},
    {route:'/jobs/fixture-job/claim',req:{method:'GET'}},
    {route:'/jobs/claim-next',req:{method:'POST'}},
    {route:'/jobs/fixture-job/release',req:{method:'POST'}},
  ];
  assert.equal(countNamedClaimPosts(requests),1);
});

for(const mode of ['mutable','frozen','nonextensible','persistent','scratch_removed','not_removed','destroy_rejects_without_receipt'])
test('pre-output scratch transfer owns recovery through journal refusal: '+mode,{timeout:60000},async t=>{
  const f=await lenderFixture(t),retryGate=deferred();
  const prepare=f.backend.prepare,write=f.policy.storage.set,candidate=f.policy.lendingRuntime.candidate;
  const record=candidate.recordCleanup,settle=candidate.settle;
  const diagnostics=[],cleanups=[],settlements=[];
  const primary=Object.assign(new Error('original prepared save diagnostic'),{code:'prepare_save_failed'});
  if(mode==='frozen')Object.freeze(primary);
  if(mode==='nonextensible')Object.preventExtensions(primary);
  const receipt=mode==='destroy_rejects_without_receipt'?null:
    Object.freeze({removed:mode!=='not_removed',scratch_removed:mode==='scratch_removed'});
  let handle,draft,before,saveFailed=false,transfers=0,acknowledged=false,cancels=0,destroys=0;
  f.backend.prepare=async function(...args){
    assert.equal(this,f.backend);handle=await prepare.apply(this,args);
    if(!receipt)handle._cleanupId='fixture-prepared-incarnation';
    handle.privateSentinel='never persist the handle';return handle;
  };
  f.backend.cancel=async function(actual){assert.equal(this,f.backend);assert.equal(actual,handle);cancels++;};
  f.backend.destroy=async function(actual){assert.equal(this,f.backend);assert.equal(actual,handle);destroys++;if(!receipt)throw new Error('synthetic missing cleanup receipt');return receipt;};


  f.policy.storage.set=async value=>{
    if(!saveFailed&&value.pending?.sandboxId==='synthetic-only'){
      saveFailed=true;draft=structuredClone(value);before=structuredClone(f.saved());throw primary;
    }
    if(value.scratchPending?.some(row=>row.attemptId===draft?.pending.attemptId)&&!acknowledged){
      transfers++;
      if(transfers===1||mode==='persistent')throw new Error('scratch journal refused');
      await retryGate.promise;
      const row=value.scratchPending.find(row=>row.attemptId===draft.pending.attemptId);
      assert.equal(row.scratchDir,handle.scratch_dir);assert.equal(row.sandboxId,handle.sandbox_id);
      assert.equal(row.attemptId,draft.pending.attemptId);assert.equal(row.jobId,draft.pending.jobId);
      assert.deepEqual(row.attempt,draft.pending.attempt);
      assert.equal(JSON.stringify(value).includes('never persist the handle'),false);
      await write(value);acknowledged=true;return;
    }
    if(saveFailed&&receipt?.scratch_removed!==true&&!acknowledged){
      assert.ok(value.pending,'an unrelated successful save must retain original recovery');
      assert.equal(value.pending.attemptId,before.pending.attemptId);
      assert.equal(value.milliseconds,before.milliseconds,'no refund before scratch transfer');
    }
    return write(value);
  };
  const lender=launch(f,{onDiagnostic:event=>diagnostics.push(event)});
  try{
    if(receipt&&mode!=='persistent'&&mode!=='scratch_removed'){
      await until(()=>transfers>=2,'supported persistence-only retry');
      assert.ok(f.saved().pending);assert.equal(f.saved().pending.attemptId,before.pending.attemptId);
      assert.equal(f.saved().milliseconds,before.milliseconds);

      assert.equal(cancels,1);assert.equal(destroys,1);assert.equal(acknowledged,false);
      retryGate.resolve();
    }
    await until(()=>diagnostics.some(e=>e.code==='prepare_save_failed'&&e.message===primary.message),'primary diagnostic survives');
    await until(()=>lender.snapshot.current===null,'finalization completed');await f.stop();
    assert.equal(cancels,1);assert.equal(destroys,1);
    assert.equal(f.count('/start'),0);assert.equal(f.count('/complete'),0);assert.equal(f.count('/stopped'),0);
    assert.equal(f.calls.some(([name])=>['clone','run','pack','collect'].includes(name)),false);
    assert.equal(diagnostics.some(e=>e.message==='scratch journal refused'),false);
    if(!receipt){
      assert.equal(transfers,0,'no scratch-only transfer without returned evidence');
      const pending=f.saved().pending;
      assert.equal(pending?.attemptId,before.pending.attemptId);
      assert.equal(pending.sandboxId,handle.sandbox_id);
      assert.equal(pending.scratchDir,handle.scratch_dir);
      assert.equal(pending.sbx_runtime,handle.sbx_runtime??null);
      assert.equal(pending.sandboxIncarnation,handle._cleanupId);
      assert.equal(f.saved().milliseconds,before.milliseconds);

      assert.equal(JSON.stringify(f.saved()).includes('never persist the handle'),false);
      assert.equal(diagnostics.some(e=>e.message==='synthetic missing cleanup receipt'),false);
    }else if(mode==='persistent'){
      assert.ok(transfers>=2);assert.ok(f.saved().pending);
      assert.equal(f.saved().pending.attemptId,before.pending.attemptId);
      assert.equal(f.saved().pending.scratchDir,handle.scratch_dir);
      assert.equal(f.saved().milliseconds,before.milliseconds);

      assert.equal(acknowledged,false);
    }else if(mode==='scratch_removed'){
      assert.equal(transfers,0);assert.equal(f.saved().scratchPending?.length??0,0);
      assert.equal(f.saved().pending,null);
    }else{
      assert.equal(acknowledged,true);
      const row=f.saved().scratchPending.find(row=>row.attemptId===draft.pending.attemptId);
      assert.equal(row.scratchDir,handle.scratch_dir);assert.equal(row.attempt.generation,draft.pending.attempt.generation);
      if(mode==='not_removed'){assert.ok(f.saved().pending);}
      else assert.equal(f.saved().pending,null);
      if(mode==='mutable'){
        // Restart from a serialized copy of the acknowledged journal, not the refused write or launch handle.
        const seed=JSON.parse(JSON.stringify(f.saved()));
        const target=seed.scratchPending.find(saved=>saved.attemptId===row.attemptId);
        assert.deepEqual(target,row);
        const sibling=structuredClone(target);
        sibling.attemptId='unrelated-synthetic-attempt';
        sibling.attempt.attempt_id=sibling.attemptId;
        sibling.scratchDir=target.scratchDir+'.unrelated-fixture';
        const recoveryClock=1234,priorSettlements=settlements.length,priorCleanups=cleanups.length;
        const admissionCalls=()=>({namedClaims:countNamedClaimPosts(f.requests),legacyClaims:f.count('/jobs/claim-next'),
          starts:f.count('/start'),backendExecutions:f.calls.filter(([kind])=>kind==='run').length});
        const beforeRestart=admissionCalls(),recoveryClaimCalls=[];
        for(const name of ['claimNext','claimJob']){
          const send=f.client[name].bind(f.client);
          f.client[name]=(...args)=>{recoveryClaimCalls.push(name);return send(...args);};
        }
        await write({...seed,scratchPending:[target,sibling]});
        f.policy.enabled=false;f.policy.recoveryOnly=true;f.policy.pollMs=recoveryClock;
        let proof='wrong',recoveryReads=0;
        f.backend.reconcilePending=async saved=>{
          if(saved.attemptId===sibling.attemptId){assert.deepEqual(saved,sibling);return undefined;}
          assert.deepEqual(saved,target,'restart receives the exact acknowledged row');
          recoveryReads++;
          if(proof==='wrong')return {attemptId:sibling.attemptId,removed:true,scratch_removed:true};
          if(proof==='missing')return {attemptId:target.attemptId,removed:true};
          return {attemptId:target.attemptId,removed:true,scratch_removed:true};
        };
        launch(f);
        const assertRetained=()=>assert.deepEqual(f.saved().scratchPending,[target,sibling]);
        await until(()=>recoveryReads===1&&f.clock.pending().includes(recoveryClock),'wrong-attempt proof completed');
        assertRetained();
        proof='missing';f.clock.advance(recoveryClock);
        await until(()=>recoveryReads===2&&f.clock.pending().includes(recoveryClock),'missing scratch-removal proof completed');
        assertRetained();
        proof='exact';f.clock.advance(recoveryClock);
        await until(()=>f.saved().scratchPending?.length===1,'exact proof cleared only its row');
        await f.stop();
        assert.deepEqual((await f.policy.storage.get()).scratchPending,[sibling]);
        const reopenedRows=[],workCallsBefore=f.calls.length;
        f.backend.reconcilePending=async saved=>{
          reopenedRows.push(saved);
          return undefined;
        };
        launch(f);
        await until(()=>reopenedRows.length>0&&f.clock.pending().includes(recoveryClock),'reopened recovery pass completed');
        await f.stop();
        assert.deepEqual(reopenedRows,[sibling],'restart from persisted storage never reconciles the retired row');
        const persisted=await f.policy.storage.get();
        assert.deepEqual(persisted.scratchPending,[sibling]);
        assert.equal(f.calls.slice(workCallsBefore).some(([name])=>['admit','clone','run','pack','collect'].includes(name)),false);
        assert.equal(persisted.milliseconds,seed.milliseconds,'no second accounting credit');
        assert.equal(persisted.jobs,seed.jobs);
        assert.deepEqual(persisted.requesters,seed.requesters);

        assert.equal(cancels,1);assert.equal(destroys,1);
        assert.deepEqual(recoveryClaimCalls,[],'recovery invokes no new claim transport');
        assert.deepEqual([countNamedClaimPosts(f.requests),f.count('/start'),f.calls.filter(([kind])=>kind==='run').length],
          [beforeRestart.namedClaims,beforeRestart.starts,beforeRestart.backendExecutions],'recovery does not start or execute work');
        assert.ok(f.requests.filter(r=>r.route==='/jobs/claim-next').slice(beforeRestart.legacyClaims).every(r=>r.body.exclude?.includes(f.jobDigest)),'any late pre-restart poll excludes this job');
      }
    }
  }finally{retryGate.resolve();await f.stop();}
});
test('a rejected prepared destroy keeps the exact pending recovery identity', {timeout:60000}, async t => {
  const f=await lenderFixture(t), prepare=f.backend.prepare, write=f.policy.storage.set;
  const candidate=f.policy.lendingRuntime.candidate, settle=candidate.settle;
  const saveRecovery=deferred();
  let handle, original, cancels=0, destroys=0, settlements=0, removed=false;
  let recoveryWritePending=false;
  const diagnostics=[], recoveryReads=[];
  f.backend.prepare=async(...args)=>{
    handle=await prepare.apply(f.backend,args);
    handle.privateSentinel='private prepared handle';
    return handle;
  };
  f.backend.cancel=async owned=>{assert.equal(owned,handle);cancels++;};
  f.backend.destroy=async owned=>{assert.equal(owned,handle);destroys++;throw new Error('synthetic destroy rejection');};
  f.backend.reconcilePending=async pending=>{
    recoveryReads.push(pending);
    return {attemptId:pending.attemptId,removed,scratch_removed:removed};
  };
  f.policy.storage.set=async value=>{
    if(!original&&value.pending?.sandboxId===handle?.sandbox_id&&handle){
      original=structuredClone(f.saved());
      throw Object.assign(new Error('synthetic prepared identity save refusal'),{code:'prepare_save_failed'});
    }
    if(original&&!recoveryWritePending&&value.pending?.sandboxId===handle.sandbox_id){
      recoveryWritePending=true;
      await saveRecovery.promise;
    }
    await write(value);
  };

  const lender=launch(f,{onDiagnostic:event=>diagnostics.push(event)});
  try {
    await until(()=>recoveryWritePending,'exact recovery identity write began');
    assert.deepEqual(f.saved().pending,original.pending);
    assert.equal(f.saved().milliseconds,original.milliseconds);

    assert.equal(f.count('/start'),0);
    assert.equal(f.count('/stopped'),0);
    saveRecovery.resolve();
    await until(()=>diagnostics.some(event=>event.code==='prepare_save_failed'),'original prepared save refusal');
    await until(()=>lender.snapshot.current===null,'unverified cleanup finalization');
    const saved=f.saved();
    assert.equal(saved.pending?.attemptId,original.pending.attemptId);
    assert.equal(saved.pending?.scratchDir,handle.scratch_dir);
    assert.equal(saved.pending?.sandboxId,handle.sandbox_id);
    assert.equal(saved.milliseconds,original.milliseconds);
    assert.equal(JSON.stringify(saved).includes('private prepared handle'),false);

    assert.equal(f.count('/start'),0);
    assert.equal(f.count('/stopped'),0);
    await f.stop();
    f.policy.enabled=false;
    f.policy.recoveryOnly=true;
    f.policy.pollMs=1234;
    recoveryReads.length=0;
    const admissionCalls=()=>[f.count('/claim'),f.count('/jobs/claim-next'),f.count('/start'),
      f.calls.filter(([kind])=>kind==='run').length];
    const beforeRestart=admissionCalls();
    const recoveryWritesStart=f.saves.length-1;
    launch(f);
    await until(()=>recoveryReads.length===1&&f.clock.pending().includes(1234),'reopened lender waits after unverified removal');
    assert.deepEqual(recoveryReads[0],saved.pending);
    assert.deepEqual((await f.policy.storage.get()).pending,saved.pending);
    assert.equal(f.saved().milliseconds,original.milliseconds);

    assert.deepEqual(admissionCalls(),beforeRestart);

    removed=true;
    f.clock.advance(1234);
    await until(()=>f.saved().pending===null,'verified removal releases the original pending reservation');
    await f.stop();
    assert.equal(recoveryReads.length,2);
    assert.deepEqual(recoveryReads[1],saved.pending);
    const persisted=await f.policy.storage.get();
    assert.equal(persisted.lastRecovery.attemptId,saved.pending.attemptId);
    assert.equal(persisted.lastRecovery.removed,true);
    const writes=f.saves.slice(recoveryWritesStart);
    assert.equal(writes.filter((row,index)=>row.pending===null&&writes[index-1]?.pending?.attemptId===saved.pending.attemptId).length,1,
      'the original pending reservation is cleared once');
    assert.deepEqual(admissionCalls(),beforeRestart);
  } finally {saveRecovery.resolve();await f.stop();}
});
const runs=f=>f.calls.filter(([kind])=>kind==='run').length;
for(const harness of ['codex','claude-code-subscription','claude-code-api-key'])test('lender quotes model and effort command words for '+harness,{timeout:60000},async t=>{
  const f=await lenderFixture(t,{harness});
  const account=f.runOptions.runAccounts()[0];
  f.runOptions.runAccounts=()=>[{...account,models:[{id:'provider/model:mini',enabled:true,efforts:[{id:'low'}],defaultEffort:'low'}]}];
  let entrypoint;const admit=f.backend.admitJob.bind(f.backend);
  f.backend.admitJob=async spec=>{entrypoint=spec.entrypoint;return admit(spec);};
  launch(f);await finish(f);
  const words=harness==='codex'?"'-m' 'provider/model:mini' '-c' 'model_reasoning_effort=low'":
    "'--model' 'provider/model:mini' '--effort' 'low'";
  assert.ok(entrypoint.startsWith(f.adapters[0].spec.entrypoint+' '+words+' '),entrypoint);
  assert.equal(runs(f),1);
});

for(const [name,models,required,expected] of [
  ['first saved account model',['gpt-6-sol'],null,'gpt-6-sol'],
  ['saved order without borrower restriction',['cheap-model','example-model'],null,'cheap-model'],
  ['borrower permits one offered model',['example-model'],['unsupported','example-model'],'example-model'],
  ['first compatible saved model wins',['example-model','other'],['example-model','other'],'example-model'],
])test('lender model precedence: '+name,{timeout:60000},async t=>{
  const f=await lenderFixture(t,{mutateJob:job=>{job.runRequest={schemaVersion:1,models:required?required.map(modelId=>({providerId:'codex',modelId})):'any',effortId:null};}});
  const account=f.runOptions.runAccounts()[0];
  f.runOptions.runAccounts=()=>[{...account,models:models.map(id=>({id,enabled:true,efforts:[],defaultEffort:null}))}];
  let entrypoint;
  f.backend.admitJob=async spec=>{entrypoint=spec.entrypoint;return {ok:false,code:'policy_unenforceable'};};
  launch(f);await until(()=>f.count('/release')===1,'captured command release');await f.stop();
  assert.ok(entrypoint.includes("'-m' '"+expected+"'"),entrypoint);noExecution(f);
});

test('lender does not claim a request whose model no account offers',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{mutateJob:job=>{job.runRequest={schemaVersion:1,models:[{providerId:'codex',modelId:'unavailable-model'}],effortId:null};}});
  f.backend.admitJob=()=>assert.fail('an unavailable model must not be admitted');
  launch(f,{approve:()=>assert.fail('an unavailable model must not prompt')});
  await until(()=>f.count('/jobs/claim-next')===1,'filtered claim');await f.stop();noExecution(f);
  assert.equal(f.count('/release'),0,'the incompatible job was never claimed');
});

test('lender rechecks offered account models after approval',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{mutateJob:job=>{job.runRequest={schemaVersion:1,models:[{providerId:'codex',modelId:'example-model'}],effortId:null};}});
  const account=f.runOptions.runAccounts()[0];let models=account.models;
  f.runOptions.runAccounts=()=>[{...account,models}];
  launch(f,{approve:()=>{models=[{id:'other',enabled:true,efforts:[],defaultEffort:null}];return true;}});
  await until(()=>f.count('/release')===1,'changed account model release');await f.stop();noExecution(f);
  assert.equal(JSON.parse(f.requests.find(r=>r.route.endsWith('/release')).body.reason).code,'readiness_changed');
});

test('adapter flags omit defaults and unsupported effort',()=>{
  for(const id of ['codex','claude-code-subscription','claude-code-api-key','gemini','opencode']) {
    assert.deepEqual(RUN_FLAGS[id]({model:null,effort:null}),[]);
    if(['gemini','opencode'].includes(id))assert.deepEqual(RUN_FLAGS[id]({model:'provider/model',effort:'high'}),['-m','provider/model']);
  }
  assert.equal(RUN_FLAGS['gh-cli'],undefined);
  assert.equal(RUN_FLAGS['unknown'],undefined);
  assert.equal(RUN_FLAGS['toString'],undefined);
});
const completed=f=>f.events.some(e=>e.label?.startsWith('Finished.'));
async function finish(f) {await until(()=>completed(f),'finished UX event');await f.stop();}
function noExecution(f) {assert.equal(runs(f),0);assert.equal(f.calls.some(([kind])=>kind==='prepare'),false);assert.equal(f.count('/start'),0);assert.equal(f.count('/complete'),0);}

test('older coordinator without observed-start still runs the agent',{timeout:60000},async t=>{
  let ran=false;
  const f=await lenderFixture(t,{agent:async()=>{ran=true;}});
  f.client.observeExecutionStart=async()=>null;
  launch(f);await finish(f);
  assert.equal(ran,true);
  assert.equal(runs(f),1);
  assert.ok(f.saved().observationPending.some(row=>row.disposition==='unsupported'));
  assert.equal(f.events.some(event=>event.code==='execution_observation_failed'),false);
});

test('observed-start 404 for an attempt the coordinator no longer knows fails the launch and never runs the agent',{timeout:60000},async t=>{
  let ran=false,observedStart=false;
  const f=await lenderFixture(t,{agent:async()=>{ran=true;}}),attemptId=f.attempt().attempt_id,diagnostics=[];
  // A resource 404: observed-start answers not_found, and so does the attempt GET because the attempt is gone.
  f.override=async({req,res,route})=>{
    if(route.endsWith('/observed-start')){observedStart=true;f.problem(res,'not_found',404);return true;}
    if(observedStart&&req.method==='GET'&&route==='/attempts/'+attemptId){f.problem(res,'not_found',404);return true;}
    return false;
  };
  launch(f,{onDiagnostic:entry=>diagnostics.push(entry)});
  await until(()=>f.events.some(e=>e.status==='failed')||completed(f),'launch settled');await f.stop();
  assert.equal(ran,false,'the agent must not run for an attempt the coordinator no longer knows');
  assert.equal(f.events.some(e=>e.status==='running'),false,'the launch is never reported as running');
  assert.equal(f.count('/complete'),0);
  assert.equal(f.count('/release'),0,'the attempt is failed, not released');
  assert.equal(JSON.parse(f.requests.find(r=>r.route.endsWith('/fail')).body.reason).code,'execution_observation_failed');
  assert.equal(f.events.find(e=>e.status==='failed').reason,'execution_failed');
  assert.equal(f.saved().observationPending[0].disposition,'rejected');
  assert.ok(diagnostics.some(entry=>entry.phase==='execution_observation'));
});

test('observed-start 404 with the attempt still known is probed, and the agent runs through the real client',{timeout:60000},async t=>{
  let ran=false;
  const f=await lenderFixture(t,{agent:async()=>{ran=true;}});
  f.override=async({res,route})=>{if(!route.endsWith('/observed-start'))return false;f.problem(res,'not_found',404);return true;};
  launch(f);await finish(f);
  const sent=f.requests.map(r=>r.req.method+' '+r.route),attempt='/attempts/'+f.attempt().attempt_id,observed=sent.indexOf('POST '+attempt+'/observed-start');
  assert.ok(observed>=0&&sent.slice(observed+1).includes('GET '+attempt),'the attempt is probed after the 404');
  assert.equal(ran,true);
  assert.equal(runs(f),1);
  assert.ok(f.saved().observationPending.some(row=>row.disposition==='unsupported'));
});

test('observed-start 404 with a failing attempt probe stays pending, and the agent does not run',{timeout:60000},async t=>{
  let ran=false,observedStart=false,probes=0;
  const f=await lenderFixture(t,{agent:async()=>{ran=true;}}),attemptId=f.attempt().attempt_id;
  f.override=async({req,res,route})=>{
    if(route.endsWith('/observed-start')){observedStart=true;f.problem(res,'not_found',404);return true;}
    if(observedStart&&req.method==='GET'&&route==='/attempts/'+attemptId){probes++;f.problem(res,'unavailable',503);return true;}
    return false;
  };
  launch(f);await until(()=>probes>0||completed(f),'attempt probe reached');
  // A 503 probe is transient: the observation is retried, and it is never settled as unsupported.
  assert.equal(ran,false,'the agent cannot run while the attempt probe is failing');
  assert.equal(f.saved().observationPending[0].disposition,undefined);
  await f.stop();
});

test('agent waits until the coordinator records the launch observation',{timeout:60000},async t=>{
  let release,entered=false,ran=false;
  const held=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const f=await lenderFixture(t,{agent:async()=>{ran=true;}}),observe=f.client.observeExecutionStart.bind(f.client);
  f.client.observeExecutionStart=async(...args)=>{entered=true;await held;return observe(...args);};
  launch(f);await until(()=>entered,'observation request');
  assert.equal(ran,false,'the agent cannot run while the coordinator has no observation');
  release();await finish(f);assert.equal(ran,true);
});

test('a transient launch observation rejection is retried without rerunning the agent',{timeout:60000},async t=>{
  const f=await lenderFixture(t),observe=f.client.observeExecutionStart.bind(f.client);let attempts=0;
  f.client.observeExecutionStart=async(...args)=>{
    attempts++;
    if(attempts===1)throw Object.assign(new Error('temporary coordinator outage'),{code:'network_error'});
    return observe(...args);
  };
  launch(f);await until(()=>attempts===1,'first launch observation');f.clock.advance(250);
  await until(()=>attempts===2,'launch observation retried');
  await finish(f);
  assert.equal(attempts,2);
  assert.equal(runs(f),1,'evidence retry does not invoke the agent again');
  assert.ok(f.requests.some(r=>r.route.endsWith('/observed-start')));
});

test('launch observation survives abort and is retried after restart',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{hold:true});
  const observe=f.client.observeExecutionStart.bind(f.client);let offline=true;
  f.client.observeExecutionStart=async(...args)=>{
    if(offline)throw Object.assign(new Error('offline'),{code:'network_error'});
    return observe(...args);
  };
  launch(f);
  await until(()=>f.saved()?.observationPending?.length===1,'durable launch observation',3000);
  const intent=structuredClone(f.saved().observationPending[0]);
  await f.stop();
  offline=false;
  launch(f);
  await until(()=>f.requests.some(r=>r.route.endsWith('/observed-start')),'restart resends observation');
  await until(()=>f.saved().observationPending?.length===0,'acknowledged observation cleared');
  assert.equal(intent.attempt.attempt_id,f.requests.find(r=>r.route.endsWith('/observed-start')).route.split('/')[2]);
  assert.equal(runs(f),1,'recovery does not launch again');
  await f.stop();
});

for(const phase of ['crash','crash-ack'])test('process death '+phase+' replays the fsynced observation',{timeout:30000},()=>{
  const root=mkdtempSync(join(tmpdir(),'faravan-observation-crash-'));
  const file=join(root,'counters.json'),receipt=join(root,'receipt.json');
  const helper=fileURLToPath(new URL('./helpers/v1-observation-crash-process.mjs',import.meta.url));
  const crashed=spawnSync(process.execPath,[helper,phase,file,receipt],{encoding:'utf8',timeout:10000});
  assert.equal(crashed.signal,'SIGKILL',crashed.stderr);
  const intent=JSON.parse(readFileSync(file,'utf8')).observationPending[0];
  const recovered=spawnSync(process.execPath,[helper,'recover',file,receipt],{encoding:'utf8',timeout:10000});
  assert.equal(recovered.status,0,recovered.stderr);
  const sent=JSON.parse(readFileSync(receipt,'utf8'));
  assert.deepEqual(sent,{attempt:intent.attempt,observedAt:intent.observedAt,idempotencyKey:intent.idempotencyKey});
  assert.equal(JSON.parse(readFileSync(file,'utf8')).observationPending.length,0);
});

test('lost observation acknowledgement replays the same time and key after restart',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{hold:true}),observe=f.client.observeExecutionStart.bind(f.client),calls=[];
  let drop=true;
  f.client.observeExecutionStart=async(attempt,opts)=>{
    calls.push({attempt:attempt.attempt_id,key:opts.idempotencyKey,at:opts.observedAt});
    const result=await observe(attempt,opts);
    if(drop)throw Object.assign(new Error('ack lost'),{code:'network_error'});
    return result;
  };
  launch(f);
  await until(()=>calls.length===1&&f.saved()?.observationPending?.length===1,'lost acknowledgement retained',3000);
  await f.stop();drop=false;launch(f);
  await until(()=>calls.length>=2&&f.saved()?.observationPending?.length===0,'acknowledgement replayed');
  assert.deepEqual(calls[1],calls[0]);
  assert.equal(runs(f),1);
  await f.stop();
});

test('failed observation journal clear retains the acknowledged intent for restart',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{hold:true}),set=f.policy.storage.set.bind(f.policy.storage);let failClear=true;
  f.policy.storage.set=async next=>{
    if(failClear&&f.saved()?.observationPending?.length===1&&next.observationPending?.length===0){
      failClear=false;throw new Error('clear failed');
    }
    return set(next);
  };
  launch(f);
  await until(()=>!failClear,'journal clear failed',5000);
  assert.equal(f.saved().observationPending.length,1);
  await f.stop();launch(f);
  await until(()=>f.saved()?.observationPending?.length===0,'journal cleared after restart');
  assert.equal(runs(f),1);
  await f.stop();
});

test('a never-settling observation request does not strand the durable journal',{timeout:15000},async t=>{
  const f=await lenderFixture(t,{hold:true}),observe=f.client.observeExecutionStart.bind(f.client);let calls=0;
  f.client.observeExecutionStart=(...args)=>++calls===1?new Promise(()=>{}):observe(...args);
  launch(f);
  await until(()=>calls===1&&f.saved()?.observationPending?.length===1,'first request hangs');
  await until(()=>calls>=2,'hung request retried',6000);
  await until(()=>f.saved()?.observationPending?.length===0,'retry acknowledged');
  await f.stop();
});

test('observation-only recovery does not replay a saved claim or admit work',{timeout:60000},async t=>{
  const f=await lenderFixture(t),attempt=f.attempt();
  const intent={attempt,observedAt:'2026-10-09T12:02:00Z',idempotencyKey:'observation-only'};
  await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,
    claimPending:{advertisement:{},leaseSeconds:120,idempotencyKey:'held-claim'},observationPending:[intent]});
  f.policy.recoveryOnly=true;f.policy.enabled=false;
  f.client.observeExecutionStart=async()=>({execution_observed_at:intent.observedAt});
  launch(f);
  await until(()=>f.saved()?.observationPending?.length===0,'observation-only delivery');
  f.clock.advance(5000);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.count('/jobs/claim-next'),0);assert.equal(f.count('/start'),0);assert.equal(f.count('/renew'),0);
  assert.equal(f.calls.some(([kind])=>['prepare','admit','run'].includes(kind)),false);
  assert.equal(f.saved().claimPending.idempotencyKey,'held-claim');
  await f.stop();
});

test('a rejected observation remains durable while later observations progress, including after restart',{timeout:15000},async t=>{
  const f=await lenderFixture(t),attempt=f.attempt(),diagnostics=[],sent=[];
  const first={attempt,observedAt:'2026-10-09T12:02:00Z',idempotencyKey:'rejected-first'};
  const second={attempt:{...attempt,attempt_id:'aaaaaaaa-aaaa-4aaa-8aaa-000000000002'},observedAt:first.observedAt,idempotencyKey:'accepted-second'};
  await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,observationPending:[first,second]});
  f.policy.recoveryOnly=true;f.policy.enabled=false;f.policy.observationCircle=f.job.payload.circle;
  f.client.observeExecutionStart=async(_attempt,opts)=>{
    sent.push(opts.idempotencyKey);
    if(opts.idempotencyKey===first.idempotencyKey)throw Object.assign(new Error('forbidden'),{code:'forbidden',status:403});
    return {execution_observed_at:opts.observedAt};
  };
  try {
    launch(f,{onDiagnostic:entry=>diagnostics.push(entry)});
    await until(()=>f.saved()?.observationPending?.length===1&&f.saved().observationPending[0].disposition==='rejected',
      'rejection persisted and later observation accepted',3000);
    assert.deepEqual(sent,['rejected-first','accepted-second']);
    assert.equal(f.saved().observationPending[0].rejection.code,'forbidden');
    assert.equal(f.saved().observationPending[0].rejection.circle,f.job.payload.circle);
    assert.deepEqual(f.saved().observationPending[0].attempt,first.attempt);
    assert.equal(f.saved().observationPending[0].observedAt,first.observedAt);
    assert.equal(diagnostics.filter(entry=>entry.phase==='execution_observation').length,1);
    await f.stop();launch(f,{onDiagnostic:entry=>diagnostics.push(entry)});
    await until(()=>f.clock.pending().includes(1000),'restarted recovery idle');
    f.clock.advance(3000);await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(sent,['rejected-first','accepted-second']);
    assert.equal(f.saved().observationPending[0].rejection.code,'forbidden');
    assert.equal(diagnostics.filter(entry=>entry.phase==='execution_observation').length,1);
  } finally {await f.stop();}
});

test('a transient observation failure preserves order until the first row succeeds',{timeout:15000},async t=>{
  const f=await lenderFixture(t),attempt=f.attempt(),sent=[];let firstCalls=0;
  const rows=['transient-first','later-second'].map(idempotencyKey=>({attempt,observedAt:'2026-10-09T12:02:00Z',idempotencyKey}));
  await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,observationPending:rows});
  f.policy.recoveryOnly=true;f.policy.enabled=false;
  f.client.observeExecutionStart=async(_attempt,opts)=>{
    sent.push(opts.idempotencyKey);
    if(opts.idempotencyKey==='transient-first'&&firstCalls++===0)throw Object.assign(new Error('offline'),{code:'network_error'});
    return {execution_observed_at:opts.observedAt};
  };
  try {
    launch(f);await until(()=>sent.length===1,'first transient attempt');
    assert.deepEqual(sent,['transient-first']);
    f.clock.advance(250);
    await until(()=>f.saved()?.observationPending?.length===0,'both observations accepted',3000);
    assert.deepEqual(sent,['transient-first','transient-first','later-second']);
  } finally {await f.stop();}
});

test('restart after persisting a rejection resumes at the next observation',{timeout:15000},async t=>{
  const f=await lenderFixture(t),attempt=f.attempt(),sent=[],diagnostics=[],persisted=deferred(),release=deferred();
  const rows=['rejected-first','accepted-second'].map(idempotencyKey=>({attempt,observedAt:'2026-10-09T12:02:00Z',idempotencyKey}));
  await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,observationPending:rows});
  const set=f.policy.storage.set.bind(f.policy.storage);let hold=true;
  f.policy.storage.set=async next=>{
    await set(next);
    if(hold&&next.observationPending?.[0]?.disposition==='rejected'){
      hold=false;persisted.resolve();await release.promise;
    }
  };
  f.policy.recoveryOnly=true;f.policy.enabled=false;
  f.client.observeExecutionStart=async(_attempt,opts)=>{
    sent.push(opts.idempotencyKey);
    if(opts.idempotencyKey==='rejected-first')throw Object.assign(new Error('forbidden'),{code:'forbidden',status:403});
    return {execution_observed_at:opts.observedAt};
  };
  try {
    launch(f,{onDiagnostic:entry=>diagnostics.push(entry)});await persisted.promise;
    assert.deepEqual(sent,['rejected-first']);await f.stop();release.resolve();
    await new Promise(resolve=>setImmediate(resolve));
    launch(f,{onDiagnostic:entry=>diagnostics.push(entry)});
    await until(()=>f.saved()?.observationPending?.length===1&&sent.includes('accepted-second'),'later observation delivered',3000);
    assert.deepEqual(sent,['rejected-first','accepted-second']);
    assert.equal(f.saved().observationPending[0].rejection.code,'forbidden');
    assert.equal(diagnostics.length,1);
  } finally {release.resolve();await f.stop();}
});

test('a failed rejection write retains the pending row and does not deliver the next one',{timeout:15000},async t=>{
  const f=await lenderFixture(t),attempt=f.attempt(),sent=[],diagnostics=[];
  const rows=['rejected-first','accepted-second'].map(idempotencyKey=>({attempt,observedAt:'2026-10-09T12:02:00Z',idempotencyKey}));
  await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,observationPending:rows});
  const set=f.policy.storage.set.bind(f.policy.storage);let failed=false;
  f.policy.storage.set=async next=>{
    if(!failed&&next.observationPending?.[0]?.disposition==='rejected'){failed=true;throw new Error('storage failed');}
    return set(next);
  };
  f.policy.recoveryOnly=true;f.policy.enabled=false;
  f.client.observeExecutionStart=async(_attempt,opts)=>{
    sent.push(opts.idempotencyKey);
    if(opts.idempotencyKey==='rejected-first')throw Object.assign(new Error('forbidden'),{code:'forbidden',status:403});
    return {execution_observed_at:opts.observedAt};
  };
  try {
    launch(f,{onDiagnostic:entry=>diagnostics.push(entry)});
    await until(()=>failed,'rejection write failed');
    assert.deepEqual(sent,['rejected-first']);assert.equal(f.saved().observationPending[0].disposition,undefined);
    assert.equal(diagnostics.length,0);
    await until(()=>f.clock.pending().includes(1000),'recovery poll scheduled');f.clock.advance(1000);
    await until(()=>f.saved()?.observationPending?.length===1&&f.saved().observationPending[0].disposition==='rejected',
      'rejection persisted after retry',3000);
    assert.deepEqual(sent,['rejected-first','rejected-first','accepted-second']);
    assert.equal(diagnostics.length,1);
  } finally {await f.stop();}
});

test('a rejection marker without a recorded reason remains pending',{timeout:15000},async t=>{
  const f=await lenderFixture(t),attempt=f.attempt();let calls=0;
  const row={attempt,observedAt:'2026-10-09T12:02:00Z',idempotencyKey:'incomplete-rejection',disposition:'rejected'};
  await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,observationPending:[row]});
  f.policy.recoveryOnly=true;f.policy.enabled=false;
  f.client.observeExecutionStart=async()=>{calls++;return {execution_observed_at:row.observedAt};};
  try {
    launch(f);await until(()=>f.saved()?.observationPending?.length===0,'incomplete rejection retried',3000);
    assert.equal(calls,1);
  } finally {await f.stop();}
});

test('an invalid local observation response cannot erase or reject evidence',{timeout:15000},async t=>{
  const f=await lenderFixture(t),attempt=f.attempt(),diagnostics=[];
  const row={attempt,observedAt:'2026-10-09T12:02:00Z',idempotencyKey:'invalid-response'};
  await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,observationPending:[row]});
  f.policy.recoveryOnly=true;f.policy.enabled=false;f.client.observeExecutionStart=async()=>undefined;
  try {
    launch(f,{onDiagnostic:entry=>diagnostics.push(entry)});
    await until(()=>diagnostics.length===1,'invalid response diagnostic');
    assert.deepEqual(f.saved().observationPending,[row]);
  } finally {await f.stop();}
});

for(const [label,reply] of [['a bare tag',()=>({observation:'superseded'})],
  ['another attempt',attempt=>({...attempt,attempt_id:'00000000-0000-4000-8000-000000000000',compute_stopped:true,observation:'superseded'})],
  ['a running attempt',attempt=>({...attempt,compute_stopped:false,observation:'superseded'})],
  ['an observation time',attempt=>({...attempt,compute_stopped:true,execution_observed_at:'2026-10-09T12:02:00Z',observation:'superseded'})]])
test('a malformed local superseded reply with '+label+' cannot settle observation evidence',{timeout:15000},async t=>{
  const f=await lenderFixture(t),attempt=f.attempt(),diagnostics=[];
  const row={attempt,observedAt:'2026-10-09T12:02:00Z',idempotencyKey:'bad-superseded'};
  await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,observationPending:[row]});
  f.policy.recoveryOnly=true;f.policy.enabled=false;f.client.observeExecutionStart=async()=>reply(attempt);
  try {
    launch(f,{onDiagnostic:entry=>diagnostics.push(entry)});
    await until(()=>diagnostics.length===1,'malformed superseded diagnostic');
    assert.deepEqual(f.saved().observationPending,[row]);
  } finally {await f.stop();}
});

test('a terminal rejection of the first launch observation is recorded locally and not retried',{timeout:60000},async t=>{
  let ran=false;const f=await lenderFixture(t,{agent:async()=>{ran=true;}}),diagnostics=[];
  f.client.observeExecutionStart=async()=>{throw Object.assign(new Error('job is already terminal'),{code:'job_terminal',status:409});};
  launch(f,{onDiagnostic:entry=>diagnostics.push(entry)});
  await until(()=>diagnostics.some(entry=>entry.phase==='execution_observation'),'terminal observation rejection recorded');
  await until(()=>f.calls.some(([kind])=>kind==='destroy'),'rejected launch cleaned up');await f.stop();
  assert.equal(diagnostics.filter(entry=>entry.phase==='execution_observation').length,1);
  assert.equal(ran,false,'rejected launch evidence cannot release the agent');
});

test('I2c over real HTTP: a superseded stale observation does not block the next job on that lender',{timeout:60000},async t=>{
  // The I2c ordering on the real store: A1 starts and its observation is held. A1 releases and reports /stopped, A2 (lender 3)
  // claims and starts, then A1's observation arrives. The store answers it as superseded; the lender settles it and runs a later job.
  const f=await realLenderFixture(t,{members:true}),diagnostics=[],observed=[];
  const capabilities=await f.backend.lenderCapabilities();
  const ad=currentAdvertisement({harnesses:['codex'],models:['example-model'],capabilities:[],egress:capabilities.egress,
    enforced_limits:capabilities.enforced_limits,max_limits:capabilities.max_limits},f.runOptions.runAccounts());
  const a1=(await f.client.claimNext(ad,{leaseSeconds:120,waitSeconds:0})).attempt;
  await f.client.startAttempt(a1,{idempotencyKey:'a1-start'});
  const held={attempt:a1,observedAt:new Date(f.clock.now()).toISOString().replace('.000Z','Z'),idempotencyKey:'a1-observation'};
  await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,observationPending:[held]});
  await f.client.release(a1,p.canonicalize({code:'restart_interrupted'}),{idempotencyKey:'a1-release'});
  await f.client.stopped(a1,{idempotencyKey:'a1-stopped'});
  await f.clientFor(3).heartbeat({seq:0,intent:{state:'ready'},execution:{state:'idle'},blockers:[],agents:[],capabilities:['run_request_v1'],accounts:f.runOptions.runAccounts()});
  const a2=(await f.clientFor(3).claimNext(ad,{leaseSeconds:120,waitSeconds:0})).attempt;
  await f.clientFor(3).startAttempt(a2,{idempotencyKey:'a2-start'});
  const later=await f.submit();
  const observe=f.client.observeExecutionStart.bind(f.client);
  f.client.observeExecutionStart=async(attempt,opts)=>{const result=await observe(attempt,opts);observed.push({key:opts.idempotencyKey,result});return result;};
  launch(f,{onDiagnostic:entry=>diagnostics.push(entry)});
  await until(()=>f.events.some(e=>e.status==='finished'||e.status==='failed'),'later job settled',30000);
  await f.stop();
  assert.equal(diagnostics.some(entry=>entry.code==='execution_observation_failed'),false);
  assert.equal((await f.owner.getJob(later)).state,'result-accepted');
  assert.equal(runs(f),1,'the later job runs its agent once');
  const stale=observed.find(entry=>entry.key==='a1-observation');
  assert.equal(stale?.result?.observation,'superseded','the store says the stale observation was superseded');
  assert.ok(stale.result.execution_observed_at==null,'no observation time is invented for a superseded try');
  assert.deepEqual(f.saved().observationPending.map(row=>row.disposition),['superseded']);
});

for (const [name, callback] of [
  ['return',()=>{}],['resolve',()=>Promise.resolve()],['throw',()=>{throw new Error('diagnostic');}],
  ['reject',()=>Promise.reject(new Error('diagnostic'))],['never settle',()=>new Promise(()=>{})],
]) test('diagnostic callback cannot block failure cleanup: '+name,{timeout:60000},async t=>{
  const f=await lenderFixture(t);
  f.backend.prepare=async()=>{throw Object.assign(new Error('failed'),{cleanup_receipt:{removed:true}});};
  launch(f,{onDiagnostic:callback});
  await until(()=>f.count('/release')===1,'failed preparation released');
  await f.stop();
  assert.equal(runs(f),0);
});

for (const [status,kind] of [['contribution','reject'],['contribution','never'],['transcript','reject'],['transcript','never']])
  test('advisory '+status+' '+kind+' does not prevent completion',{timeout:60000},async t=>{
    const f=await lenderFixture(t);
    launch(f,{onEvent:event=>event.status!==status?undefined:kind==='reject'?Promise.reject(new Error('observer')):new Promise(()=>{})});
    await until(()=>completed(f),'job completes despite advisory callback',5000);
    await f.stop();
    assert.equal(runs(f),1);
  });

test('v1 lender refunds prepare failure before a sandbox exists to prior global and requester usage',{timeout:60000},async t=>{
  const f=await lenderFixture(t),key=requesterCounterKey(f.job.payload.circle,f.job.payload.author);
  const before={day:'2026-10-09',jobs:1,milliseconds:60000,pending:null,
    requesters:{[key]:{jobs:1,milliseconds:15000}}};
  await f.policy.storage.set(before);
  let approvals=0;
  f.backend.prepare=async()=>{f.calls.push(['prepare']);f.clock.advance(3000);throw new Error('Synthetic prepare failure');};
  launch(f,{approve:async()=>{approvals++;return true;}});
  await until(()=>f.count('/release')===1&&f.saved().claimedPending===null,'prepare failure settled');
  await f.stop();
  assert.equal(approvals,1);assert.ok(f.events.some(e=>e.status==='preparing'));
  assert.equal(f.events.some(e=>e.status==='running'),false,'preparation is not execution');
  assert.equal(runs(f),0);assert.equal(f.count('/start'),0);assert.equal(f.count('/complete'),0);
  assert.equal(f.saved().jobs,before.jobs);assert.equal(f.saved().milliseconds,before.milliseconds);
  assert.deepEqual(f.saved().requesters,before.requesters);assert.equal(f.saved().pending,null);
});

test('v1 lender keeps the reservation when a failed prepare cannot prove its sandbox was removed',{timeout:60000},async t=>{
  const f=await lenderFixture(t);
  f.backend.prepare=async()=>{f.calls.push(['prepare']);
    throw Object.assign(new Error('Synthetic boot failure'),{cleanup_receipt:{removed:false,scratch_removed:false}});};
  launch(f,{approve:async()=>true});
  await until(()=>f.events.some(e=>e.reason==='cleanup_pending')||f.count('/release')===1,'prepare failure settled');
  await f.stop();
  assert.equal(f.count('/start'),0);
  assert.equal(f.saved().jobs,1);assert.ok(f.saved().milliseconds>0);assert.ok(f.saved().pending);
});

for(const missingId of [false,true])test('v1 lender retains reservation after prepare when removal is unproven, missing ID='+missingId,{timeout:60000},async t=>{
  const f=await lenderFixture(t),prepare=f.backend.prepare.bind(f.backend);
  f.backend.prepare=async(...args)=>{
    const handle=await prepare(...args);
    if(missingId)delete handle.sandbox_id;
    return handle;
  };
  const set=f.policy.storage.set.bind(f.policy.storage);
  f.policy.storage.set=async value=>{
    if(Object.hasOwn(value.pending??{},'sandboxId'))throw new Error('Synthetic recovery identity persistence failure');
    return set(value);
  };
  f.backend.destroy=async()=>{f.calls.push(['destroy']);return {removed:false};};
  launch(f);
  await until(()=>f.events.some(e=>e.reason==='cleanup_pending'),'unproven removal retains pending work');
  await f.stop();
  assert.ok(f.calls.some(([kind])=>kind==='prepare'));assert.ok(f.calls.some(([kind])=>kind==='destroy'));
  assert.equal(runs(f),0);assert.equal(f.count('/start'),0);assert.equal(f.count('/complete'),0);
  assert.equal(f.saved().jobs,1);assert.equal(f.saved().milliseconds,120000);
  assert.deepEqual(requesterUsage(f),{jobs:1,milliseconds:120000});assert.ok(f.saved().pending);
});

test('v1 lender ask-each-time approves, reuses execution and signs candidate, transcript and measured receipt',{timeout:60000},async t=>{
  const f=await lenderFixture(t);
  f.adapters[0].run={...f.adapters[0].run,model:'example-model'};
  const summaries=[];
  launch(f,{approve:async summary=>{summaries.push(summary);return true;}});
  await finish(f);
  assert.equal(summaries.length,1);
  assert.equal(runs(f),1);assert.equal(f.count('/complete'),1);
  assert.ok(f.calls.some(([kind])=>kind==='clone'));assert.ok(f.calls.some(([kind])=>kind==='pack'));
  assert.ok(f.calls.some(([kind])=>kind==='destroy'));
  const receipt=f.result.payload.receipt;
  assert.deepEqual(receipt.egress_evidence,f.evidence);
  assert.deepEqual(receipt.enforced_limits,['cpu','memory','wall','output','storage']);assert.deepEqual(receipt.unenforced,[]);
  assert.equal(receipt.usage.input_tokens,13);assert.equal(receipt.usage.output_tokens,5);
  assert.equal(receipt.model,'example-model','the synthetic account transport observed this selected model');
  assert.ok(f.artifacts.has(f.result.payload.candidate.digest));assert.ok(f.artifacts.has(f.result.payload.transcript.digest));
  assert.ok(f.saves.length>0,'daily counters must be persisted');
  const advertised=f.requests.find(r=>r.route==='/jobs/claim-next').body.advertisement;
  assert.deepEqual(advertised.harnesses,['codex']);assert.deepEqual(advertised.models,['example-model']);
  assert.ok(f.events.some(e=>e.label?.startsWith('Running with ')));
  assert.ok(f.events.some(e=>e.label==='Sending the result…'));
});

test('v1 lender declining approval releases the local attempt without running or cancelling the job',{timeout:60000},async t=>{
  const f=await lenderFixture(t);launch(f,{approve:async()=>false});
  await until(()=>f.count('/release')===1,'denial release');await f.stop();noExecution(f);
  assert.equal(f.requests.some(r=>r.route.includes('/jobs/')&&r.route.endsWith('/cancel')),false);
  assert.equal(JSON.parse(f.requests.find(r=>r.route.endsWith('/release')).body.reason).code,'approval_pending');
});

test('legacy declined hold is acknowledged as released and cannot be claimed again by that lender',{timeout:60000},async t=>{
  const f=await realLenderFixture(t),release=f.client.release.bind(f.client),claimNext=f.client.claimNext.bind(f.client);
  let released,ad;
  f.client.claimNext=async(advertisement,...args)=>{ad=advertisement;return claimNext(advertisement,...args);};
  f.client.release=async(attempt,reason,options)=>{
    const ack=await release(attempt,reason,options);released={reason,ack};return ack;
  };
  launch(f,{approve:async()=>({declined:true})});
  await until(()=>released,'legacy decline release acknowledged');await f.stop();
  assert.equal(JSON.parse(released.reason).code,'approval_pending');
  assert.ok(f.realRequests.some(row=>row.url.endsWith('/release')));
  const job=await f.owner.getJob(f.jobDigest);
  assert.equal(job.state,'queued');assert.equal(job.attempts_started,0);
  assert.ok(ad,'the real claim advertisement was captured');
  assert.ok(f.saved().hiddenOffers.some(row=>row.jobDigest===f.jobDigest&&row.permanent),'this computer remembers the owner skip');
  const otherClient=f.clientFor(0);
  await otherClient.heartbeat({boot:'other-computer',seq:0,intent:{state:'ready'},execution:{state:'idle'},blockers:[],agents:[],capabilities:['run_request_v1'],accounts:ad.accounts});
  const other=await otherClient.claimJob(f.jobDigest,ad);
  assert.equal(other.job_digest,f.jobDigest,'another computer can still claim the unstarted job');
  assert.equal(runs(f),0);
});
test('v1 lender gives the review card its own deadline and closes the card when that wait ends',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{policy:{approvalTimeoutMs:30000}});let seen;
  launch(f,{approve:input=>{seen=input;return new Promise(()=>{});}});
  await until(()=>seen,'approval request');
  assert.equal(seen.expiresAt,f.clock.now()+30000,'one deadline shared with the card');
  assert.equal(seen.signal.aborted,false);
  f.clock.advance(30001);
  await until(()=>f.count('/release')===1,'timed-out release');
  assert.equal(seen.signal.aborted,true,'the card is told to close when the lender stops waiting');
  await f.stop();noExecution(f);
});
test('v1 lender approval timeout releases; a late yes cannot start execution',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{policy:{approvalTimeoutMs:30000}}), approval=deferred();let asked=false;
  launch(f,{approve:()=>{asked=true;return approval.promise;}});
  await until(()=>asked,'approval request');f.clock.advance(30001);
  await until(()=>f.count('/release')===1,'timed-out release');approval.resolve(true);
  await new Promise(r=>setImmediate(r));await f.stop();noExecution(f);
  assert.equal(JSON.parse(f.requests.find(r=>r.route.endsWith('/release')).body.reason).code,'approval_pending');
});
test('v1 lender ask mode reaches approval for a harness without a quota provider',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{harness:'claude-code-api-key'}),approval=deferred();let asked=false;
  launch(f,{approve:()=>{asked=true;return approval.promise;}});
  await until(()=>asked||f.events.some(event=>event.reason==='conditions_unavailable'),'unmetered ask reaches approval or is held');
  assert.equal(asked,true,'ask mode must reach explicit approval without a metered quota provider');
  await f.stop();
});
test('v1 lender quota providers map both metered subscription agents',()=>{
  assert.deepEqual(QUOTA_PROVIDERS,{'claude-code-subscription':'claude',codex:'codex'});
  assert.equal(Object.isFrozen(QUOTA_PROVIDERS),true);
});
test('v1 lender auto-accept within matching fresh quota and configured limits runs without prompting',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{harness:'claude-code-subscription',policy:{mode:'auto'}});
  launch(f,{approve:async()=>assert.fail('auto mode must not prompt')});await finish(f);assert.equal(runs(f),1);
  assert.deepEqual(f.requests.find(r=>r.route==='/jobs/claim-next').body.advertisement.harnesses,['claude-code-subscription']);
});

for(const [name,harness,reading] of [
  ['stale matching reading','claude-code-subscription',{provider:'claude',remaining:10,observedAt:0}],
  ['low Claude reading for Codex','codex',{provider:'claude',remaining:10,observedAt:Date.parse('2026-10-09T12:02:00Z')}],
])test('v1 lender ask mode allows '+name+' after approval',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{harness,policy:{quota:()=>reading}});let approvals=0;
  launch(f,{approve:async()=>{approvals++;return true;}});await finish(f);
  assert.equal(approvals,1);assert.equal(runs(f),1);assert.equal(f.count('/release'),0);
});



for(const [name,policy,reason] of [
  ['daily job limit',{dailyJobs:1},'daily_limit'],
  ['daily minute limit',{dailyMinutes:1},'daily_limit'],
  ['active user under idle-only',{idleOnly:true,userActive:()=>true,quota:()=>assert.fail('idle check must precede quota read')},'user_active']
])test('v1 lender auto mode does not claim for '+name,{timeout:60000},async t=>{
  const saved={day:'2026-10-09',jobs:name==='daily job limit'?1:0,
    milliseconds:name==='daily minute limit'?60000:0,pending:null};
  const f=await lenderFixture(t,{harness:'claude-code-subscription',policy:{mode:'auto',...policy},saved});
  launch(f,{approve:async()=>assert.fail('automatic rejection must not prompt')});
  await until(()=>f.events.some(event=>event.reason===lendingReasonCode(reason)),name+' preclaim gate');
  await until(()=>f.clock.pending().includes(1000),'policy retry scheduled');
  const events=f.events.length;f.clock.advance(1000);
  await until(()=>f.events.slice(events).some(event=>event.reason===lendingReasonCode(reason)),'policy retry remains gated');
  await f.stop();noExecution(f);
  assert.equal(f.count('/jobs/claim-next'),0);assert.equal(f.count('/release'),0);
  assert.deepEqual(f.saved(),saved,'denied work must not consume durable daily counters');
});
test('v1 lender insufficient remaining minutes for a claimed job releases before execution',{timeout:60000},async t=>{
  // Claim within budget, then reduce it during review to exercise the job-specific recheck.
  const f=await lenderFixture(t);
  launch(f,{approve:async()=>{f.policy.dailyMinutes=1;return true;}});
  await until(()=>f.count('/release')===1,'job-specific minute limit release');await f.stop();noExecution(f);
  assert.equal(f.count('/jobs/claim-next'),1);
  assert.equal(JSON.parse(f.requests.find(r=>r.route.endsWith('/release')).body.reason).code,'daily_limit');
  assert.equal(f.saved().jobs,0);assert.equal(f.saved().milliseconds,0);
});
test('founder #4: a job this computer signed is not charged to the friends\' daily caps',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{policy:{requesterLimits:[]}});
  f.policy.ownKeyId=f.job.payload.author;
  launch(f);await finish(f);
  assert.equal(runs(f),1);
  assert.equal(f.saved().jobs,0,'own job does not count toward Jobs a day');
  assert.equal(f.saved().milliseconds,0,'own job does not count toward Minutes a day');
  assert.deepEqual(f.saved().requesters??{},{},'own job does not use a requester cap');
});
test('v1 lender unknown quota still permits explicitly approved ask-each-time work',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{harness:'claude-code-subscription',policy:{quota:()=>null}});launch(f);await finish(f);assert.equal(runs(f),1);
});
for(const code of ['policy_unenforceable','limits_unenforceable'])test('v1 lender admission '+code+' releases without prepare or run',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{admission:{ok:false,code,reason:'Synthetic enforced requirement unavailable',unenforced:['cpu']}});
  launch(f);await until(()=>f.count('/release')===1,code+' release');await f.stop();noExecution(f);
  const released=JSON.parse(f.requests.find(r=>r.route.endsWith('/release')).body.reason);
  assert.equal(released.code,'cannot_run_here');
  assert.equal(released.until,Math.min(Date.parse(f.job.payload.expires_at),f.clock.now()+120000));
});

test('v1 lender renews well inside the 120-second lease and stops renewal after successful finish',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{hold:true});launch(f);await until(()=>runs(f)===1,'fake backend entered');
  const baseline=f.count('/renew');assert.equal(baseline,1,'pre-execution authority renewal');
  f.clock.advance(29999);await new Promise(r=>setImmediate(r));assert.equal(f.count('/renew'),baseline);
  f.clock.advance(1);await until(()=>f.count('/renew')===baseline+1,'first renewal');
  assert.equal(f.requests.filter(r=>r.route.endsWith('/renew'))[baseline].at-Date.parse('2026-10-09T12:02:00Z'),30000);
  await until(()=>f.clock.pending().some(ms=>ms===30000),'next renewal scheduled');
  f.clock.advance(30000);await until(()=>f.count('/renew')===baseline+2,'second renewal');
  f.execution.resolve();await finish(f);
  const count=f.count('/renew');f.clock.advance(300000);await new Promise(r=>setImmediate(r));assert.equal(f.count('/renew'),count);
});
for(const code of ['job_cancelled','attempt_fenced'])test('v1 lender '+code+' renewal aborts fake work and reports cessation without completing',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{hold:true});
  launch(f);await until(()=>runs(f)===1,'fake backend entered');
  f.override=({route,res})=>{if(route.endsWith('/renew')){f.problem(res,code);return true;}return false;};
  f.clock.advance(30000);
  await until(()=>f.count('/stopped')===1,'cessation acknowledgement');
  assert.equal(f.calls.filter(([kind])=>kind==='cancel').length,1);
  assert.ok(f.calls.some(([kind])=>kind==='destroy'));
  assert.equal(f.count('/complete'),0);assert.equal(f.calls.some(([kind])=>kind==='collect'),false);
  assert.ok(f.events.some(e=>e.status==='stopping'&&e.reason===lendingReasonCode(code)));
  await until(()=>f.events.some(e=>e.status==='stopped'&&e.reason===lendingReasonCode(code)),'stopped event');
  const renews=f.count('/renew');f.clock.advance(60000);await new Promise(r=>setImmediate(r));await f.stop();
  assert.equal(f.count('/renew'),renews);
  // This proves control flow against a fake backend, not a real sandbox kill.
});
test('v1 lender completion ACK loss retries the identical signed result and idempotency key',{timeout:60000},async t=>{
  const f=await lenderFixture(t);f.dropCompleteAck=true;launch(f);await finish(f);
  const sent=f.requests.filter(r=>r.route.endsWith('/complete'));assert.equal(sent.length,2);
  assert.deepEqual(sent[0].bytes,sent[1].bytes);
  assert.equal(sent[0].req.headers['idempotency-key'],sent[1].req.headers['idempotency-key']);
  assert.notEqual(sent[0].proof.payload.nonce,sent[1].proof.payload.nonce);
  assert.equal(runs(f),1);
  assert.equal(f.events.filter(e=>e.contribution?.kind==='delivered').length,1);
});
test('v1 lender pause permits current work to finish and makes no additional claims',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{hold:true});const lender=launch(f);
  await f.entered.promise;lender.pause();const claims=f.count('/jobs/claim-next');
  assert.ok(f.events.some(e=>e.label==='Lending will pause after this job.'));
  f.execution.resolve();await until(()=>completed(f),'current work finishes while paused');
  f.clock.advance(60000);await new Promise(r=>setImmediate(r));
  assert.equal(f.count('/jobs/claim-next'),claims);assert.equal(f.calls.some(([kind])=>kind==='cancel'),false);
  assert.ok(f.events.some(e=>e.status==='waiting_for_sandbox'&&e.reason==='lending_off'));
  await f.stop();
});
test('v1 lender resume while a job runs restores the running state, not the pause label',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{hold:true});const lender=launch(f);
  await f.entered.promise;const running=lender.getState();
  lender.pause();assert.equal(lender.getState().status,'paused');
  lender.resume();
  const resumed=lender.getState();
  assert.equal(resumed.paused,false,'resume clears the paused flag');
  assert.equal(resumed.status,running.status,'resume returns to the status the running job had');
  assert.equal(resumed.label,running.label,'resume restores the label the running job had');
  assert.notEqual(resumed.label,'Lending will pause after this job.');
  assert.deepEqual([f.events.at(-1).status,f.events.at(-1).label],[resumed.status,resumed.label],'the last event the app saw matches getState');
  f.execution.resolve();await f.stop();
});
test('v1 lender pause during approval wins against a concurrent yes',{timeout:60000},async t=>{
  const f=await lenderFixture(t),approval=deferred();let asked=false;
  const lender=launch(f,{approve:()=>{asked=true;return approval.promise;}});
  await until(()=>asked,'approval callback');lender.pause();approval.resolve(true);
  await until(()=>f.count('/release')===1,'paused approval release');await f.stop();noExecution(f);
});
test('v1 lender does not advertise an adapter whose sign-in is missing',{timeout:60000},async t=>{
  const f=await lenderFixture(t);
  f.adapters[0].run={...f.adapters[0].run,model:'example-model'};
  f.adapters.push({...f.adapters[0],signedIn:false,spec:{...f.adapters[0].spec,harness_id:'unsigned-adapter'},models:['unavailable-model']});
  launch(f);await finish(f);
  const advertised=f.requests.find(r=>r.route==='/jobs/claim-next').body.advertisement;
  assert.deepEqual(advertised.harnesses,['codex']);assert.deepEqual(advertised.models,['example-model']);
});

test('v1 lender rechecks agent sign-in after approval before preparing a sandbox',{timeout:60000},async t=>{
  const f=await lenderFixture(t);let signedOut=false;
  f.runOptions.accountExecution.availability=async()=>({decision:signedOut?{kind:'hold',code:'account_signed_out',nextAction:{id:'sign_in',label:'Sign in to this account',target:{}}}:{kind:'lend'},accountIds:['fixture-account']});
  launch(f,{approve:async()=>{signedOut=true;return true;}});
  await until(()=>f.count('/release')===1,'changed policy release');await f.stop();noExecution(f);
});
test('v1 lender durable daily count prevents automatic execution after restart',{timeout:60000},async t=>{
  const saved={day:'2026-10-09',jobs:1,milliseconds:60000,pending:null};
  const f=await lenderFixture(t,{saved,policy:{mode:'auto',dailyJobs:1}});
  launch(f);await until(()=>f.events.some(event=>event.reason==='daily_limit'),'persisted preclaim daily limit');
  await f.stop();noExecution(f);
  assert.equal(f.count('/jobs/claim-next'),0);assert.equal(f.count('/release'),0);
  assert.deepEqual(f.saved(),saved);
});
test('v1 lender claims nothing outside its lending hours (S6.1)',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{policy:{mode:'auto'}});
  const day=new Date(f.clock.now()).getUTCDay();
  f.policy.schedule={days:[(day+3)%7],from:'09:00',to:'10:00',weekends_all_day:false};
  launch(f);await until(()=>f.events.some(event=>event.reason==='outside_hours'),'outside hours');
  await f.stop();noExecution(f);
  assert.equal(f.count('/jobs/claim-next'),0);
});
test('v1 lender missing usage stays null rather than invented zeroes',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{stdout:'{"type":"turn.completed"}\n'});
  launch(f);await finish(f);
  assert.equal(f.result.payload.receipt.model,'example-model');
  assert.ok(Object.values(f.result.payload.receipt.usage).every(value=>value===null));
});
test('v1 lender backend deadline failure cleans up and fails instead of completing',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{runError:Object.assign(new Error('Synthetic wall deadline'),{code:'wall_deadline'})});
  launch(f);await until(()=>f.count('/fail')===1,'deadline failure');await f.stop();
  assert.equal(runs(f),1);assert.ok(f.calls.some(([kind])=>kind==='destroy'));
  assert.equal(f.count('/complete'),0);
  assert.ok(f.events.some(e=>e.status==='failed'&&e.reason==='execution_failed'&&e.label===lendingReasonText('execution_failed')));
});
test('v1 lender reports a signed-out agent, tells the borrower nothing and announces the harness only',{timeout:60000},async t=>{
  const stdout='{"type":"error","message":"Reconnecting... 1/5 (unexpected status 401 Unauthorized: Could not parse your authentication token. Please try signing in again., url: https://chatgpt.com/backend-api/codex/responses)"}\n{"type":"turn.failed"}\n';
  const f=await lenderFixture(t,{runError:Object.assign(new Error('sbx exec failed: PRIVATE_PROVIDER_TEXT'),{stdout,stderr:'',exitCode:1})});
  launch(f);await until(()=>f.count('/fail')===1,'signed-out failure');await f.stop();
  const failed=f.events.find(e=>e.status==='failed');
  assert.equal(failed.reason,'account_signed_out');
  assert.equal(failed.label,lendingReasonText('account_signed_out'));
  const signal=f.events.find(e=>e.status==='agent-signed-out');
  assert.deepEqual(signal,{status:'agent-signed-out',harness:f.adapters[0].spec.harness_id});
  assert.ok(!JSON.stringify(f.events).includes('PRIVATE_PROVIDER_TEXT'));
  const reasons=f.requests.filter(r=>r.route.endsWith('/fail')).map(r=>JSON.stringify(r.body));
  assert.equal(reasons.length,1);
  assert.ok(!reasons[0].includes('signed_out'),'the coordinator only receives the generic failure');
});
test('v1 lender keeps the generic failure for a failed run that is not an auth failure',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{runError:Object.assign(new Error('sbx exec failed'),{stdout:'3 tests failed\n',stderr:'',exitCode:1})});
  launch(f);await until(()=>f.count('/fail')===1,'ordinary failure');await f.stop();
  assert.ok(!f.events.some(e=>e.status==='agent-signed-out'||e.reason==='account_signed_out'));
  assert.ok(f.events.some(e=>e.status==='failed'&&e.reason==='execution_failed'&&e.label===lendingReasonText('execution_failed')));
});
test('v1 lender records a fresh random ref with each local diagnostic (S3.1b)',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{runError:Object.assign(new Error('sbx exec failed'),{stdout:'3 tests failed\n',stderr:'',exitCode:1})});
  const entries=[];
  launch(f,{onDiagnostic:entry=>entries.push(entry)});await until(()=>f.count('/fail')===1,'ordinary failure');await f.stop();
  assert.equal(entries.length,1);
  assert.match(entries[0].ref,/^[A-Z2-7]{6}$/);
});
test('v1 lender in-flight fenced renewal wins over concurrently finished execution',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{hold:true}),renewal=deferred();let renewEntered=false;
  launch(f);await until(()=>runs(f)===1,'fake backend entered');
  f.override=async({route,res})=>{
    if(!route.endsWith('/renew'))return false;
    renewEntered=true;await renewal.promise;f.problem(res,'attempt_fenced');return true;
  };
  f.clock.advance(30000);
  await until(()=>renewEntered,'renewal in flight');f.execution.resolve();
  await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
  const earlyCompletions=f.count('/complete');
  renewal.resolve();await until(()=>f.count('/stopped')===1,'fenced completion cessation');
  assert.equal(earlyCompletions,0,'completion must wait for in-flight authority check');
  await f.stop();assert.equal(f.count('/complete'),0);
});

test('v1 lender completion retry after exhausted transport retries preserves the original signed result',{timeout:60000},async t=>{
  const f=await lenderFixture(t);
  f.override=({route,req})=>{
    if(route.endsWith('/complete')&&f.count('/complete')<=2){req.socket.destroy();return true;}
    return false;
  };
  launch(f);
  await finish(f);
  const sent=f.requests.filter(r=>r.route.endsWith('/complete'));
  assert.equal(sent.length,3);assert.equal(runs(f),1);
  for(const item of sent.slice(1)){
    assert.deepEqual(item.bytes,sent[0].bytes);
    assert.equal(item.req.headers['idempotency-key'],sent[0].req.headers['idempotency-key']);
  }
});
test('v1 lender disabled lending after approval cannot enter execution',{timeout:60000},async t=>{
  const f=await lenderFixture(t);
  launch(f,{approve:async()=>{f.policy.enabled=false;return true;}});
  await until(()=>f.count('/release')===1,'disabled policy release');await f.stop();noExecution(f);
});

test('v1 lender refuses to sign a receipt when execution evidence is missing',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{executionEvidence:{}});
  launch(f);await until(()=>f.count('/fail')===1,'missing evidence failure');await f.stop();
  assert.equal(runs(f),1);assert.equal(f.count('/complete'),0);
});

test('v1 lender whole-tree output never advertises patch-output support',{timeout:60000},async t=>{
  const f=await lenderFixture(t);f.adapters[0].capabilities=['patch-output'];
  launch(f);await finish(f);
  const advertised=f.requests.find(r=>r.route==='/jobs/claim-next').body.advertisement;
  assert.equal(advertised.capabilities.includes('patch-output'),false);
  assert.equal(advertised.capabilities.includes('working_directory_v1'),true);
  assert.equal(advertised.capabilities.includes('results_v1'),true);
  assert.equal(advertised.capabilities.includes('source_manifest_v1'),true);
  assert.equal(advertised.capabilities.includes('parent_link_v1'),true);
  assert.deepEqual(f.result.payload.receipt.capabilities_applied,['run_request_v1']);
});


test('v1 lender waits for start acknowledgement after materializing source and before backend execution',{timeout:60000},async t=>{
  const f=await lenderFixture(t), acknowledgement=deferred();let startEntered=false;
  f.override=async({route})=>{
    if(!route.endsWith('/start'))return false;
    assert.ok(f.calls.some(([kind])=>kind==='clone'),'source must be materialized before start');
    assert.equal(runs(f),0);
    assert.equal(f.saved().jobs,1,'reserve the durable daily count before requesting execution');
    assert.ok(f.saved().pending.startIdempotencyKey);
    startEntered=true;await acknowledgement.promise;return false;
  };
  const original=f.backend.start.bind(f.backend);
  f.backend.start=async(handle,options)=>{
    if(handle._sourcePreparation)return original(handle,options);
    assert.ok(f.attempt().execution_started_at,'no backend entrypoint before acknowledged start');
    assert.equal(f.count('/start'),1,'packing must not start another execution attempt');
    return original(handle,options);
  };
  launch(f);await until(()=>startEntered,'start request awaiting acknowledgement');
  assert.equal(runs(f),0);assert.equal(f.count('/complete'),0);
  acknowledgement.resolve();await finish(f);
  assert.equal(runs(f),1);assert.equal(f.count('/start'),1);
  assert.equal(f.saved().jobs,1);assert.equal(f.saved().pending,null);
});

test('v1 lender does not report running when an acknowledged backend start is delayed then rejected',{timeout:60000},async t=>{
  const f=await lenderFixture(t),entered=deferred(),rejectStart=deferred();
  const start=f.backend.start.bind(f.backend);
  f.backend.start=async(handle,options)=>{
    if(handle._sourcePreparation)return start(handle,options);
    entered.resolve();await rejectStart.promise;throw new Error('Synthetic backend start rejection');
  };
  launch(f);await entered.promise;
  assert.ok(f.attempt().execution_started_at,'the durable start-request fence remains recorded');
  assert.equal(f.events.some(e=>e.status==='running'),false,'the start request is not observed execution');
  rejectStart.resolve();
  await until(()=>f.events.some(e=>e.status==='failed'),'backend start rejection settled');
  await f.stop();
  assert.equal(f.events.some(e=>e.status==='running'),false,'a rejected start never reports running');
  assert.equal(f.events.some(e=>e.status==='running'),false,'the rejected backend start never records local observed-start evidence');
});


test('M8 separate processes cannot spend the same daily budget twice',{timeout:60000},async t=>{
  const f=await lenderFixture(t),file=join(f.root,'shared-counters.json');
  const run=()=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('./helpers/v1-budget-process.mjs',import.meta.url)),file],
      {stdio:['ignore','pipe','pipe']});
    let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);
    child.on('error',reject);child.on('close',code=>code===0?resolve(out):reject(new Error(err)));
  });
  const outcomes=await Promise.all([run(),run()]);
  const reserved=outcomes.filter(x=>x==='reserved').length;
  assert.ok(reserved<=1,'concurrent processes never reserve the daily allowance twice: '+outcomes.join(', '));
  // Acquisition is nonblocking: simultaneous bakery registrations may both back off.
  // Once those processes exit, one fresh contender must still reserve the unspent allowance.
  if(reserved===0)assert.equal(await run(),'reserved');
  const {createLenderCounterStorage}=await import('../lib/v1/lender.mjs');
  const storage=createLenderCounterStorage(file),release=await storage.acquire();
  try {assert.equal((await storage.get()).jobs,1);assert.equal((await storage.get()).milliseconds,60000);}
  finally {await release();}
  assert.equal(await run(),'limited','a fresh process reloads the durable daily cap');
});

test('M8 absent or mismatched recovery evidence keeps execution fail closed',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{saved:{day:'2026-10-09',jobs:1,milliseconds:120000,
    pending:{attemptId:'orphan-attempt',reservedMs:120000}}});
  launch(f);
  await until(()=>f.events.some(e=>e.reason==='cleanup_pending'),'no recovery implementation fails closed');
  assert.equal(f.count('/jobs/claim-next'),0);
  f.backend.reconcilePending=async()=>({removed:true,attemptId:'different-attempt'});
  f.clock.advance(1000);await new Promise(r=>setImmediate(r));
  assert.equal(f.saved().pending.attemptId,'orphan-attempt');
  await f.stop();assert.equal(f.count('/jobs/claim-next'),0);
});

test('M8 restart retries a saved completion with the same payload and key without re-execution',{timeout:60000},async t=>{
  const f=await lenderFixture(t);
  f.override=({route,req})=>{if(route.endsWith('/complete')){req.socket.destroy();return true;}return false;};
  launch(f);
  await until(()=>f.events.some(e=>e.reason==='circle_unreachable'),'uncertain completion saved');
  await f.stop();
  const pending=structuredClone(f.saved().resultPending);
  assert.ok(pending);
  f.override=null;launch(f);await finish(f);
  assert.equal(runs(f),1);
  const requests=f.requests.filter(r=>r.route.endsWith('/complete'));
  assert.ok(requests.every(r=>r.req.headers['idempotency-key']===pending.idempotencyKey));
  assert.deepEqual(requests.at(-1).body.payload,pending.payload);
  assert.equal(f.saved().resultPending,null);
});
test('H2 non-problem HTTP 403 still clears a definitively rejected saved result',{timeout:60000},async t=>{
  const f=await lenderFixture(t);
  f.override=({route,res})=>{
    if(!route.endsWith('/complete'))return false;
    res.writeHead(403,{'content-type':'application/json'});res.end('invalid JSON');return true;
  };
  launch(f);
  await until(()=>f.events.some(e=>e.reason==='result_delivery_failed'),'generic HTTP rejection surfaced');
  await until(()=>f.saved().resultPending===null,'generic rejected completion cleared');
  await f.stop();
  assert.equal(f.saved().lastResultOutcome.status,403);assert.equal(f.count('/complete'),1);
});

for(const status of [400,401,403,404,409,422])test('H2 non-retryable HTTP '+status+' clears the saved result',{timeout:60000},async t=>{
  const f=await lenderFixture(t);
  f.override=({route,res})=>{if(route.endsWith('/complete')){f.problem(res,'definitive_rejection',status);return true;}return false;};
  launch(f);
  await until(()=>f.events.some(e=>e.reason==='result_delivery_failed'),'completion rejection surfaced');
  await until(()=>f.saved().resultPending===null,'completion intent cleared');
  await f.stop();
  assert.equal(f.saved().lastResultOutcome.status,status);assert.equal(f.count('/complete'),1);
});
for(const status of [429,500,503])test('H2 HTTP '+status+' retains the saved result for retry',{timeout:60000},async t=>{
  const f=await lenderFixture(t);
  f.override=({route,res})=>{if(route.endsWith('/complete')){f.problem(res,'temporary_failure',status);return true;}return false;};
  launch(f);await until(()=>f.events.some(e=>e.reason==='circle_unreachable'),'temporary completion failure');
  await f.stop();assert.ok(f.saved().resultPending);assert.equal(f.saved().lastResultOutcome,undefined);
});

for(const proof of ['valid','missing','mismatched'])test('M8 crash-before-finally recovery with '+proof+' durable cleanup proof',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{hold:true});
  f.override=({route,req})=>{if(route.endsWith('/complete')){req.socket.destroy();return true;}return false;};
  launch(f);
  await until(()=>f.events.some(e=>e.status==='running'),'the run starts');
  f.clock.advance(60000);
  f.execution.resolve();
  await until(()=>f.events.some(e=>e.reason==='circle_unreachable'),'result intent durably saved');
  await f.stop();
  const snapshot=structuredClone(f.saves.find(value=>value.resultPending&&value.pending));
  assert.ok(snapshot?.pending.cessationVerified,'cleanup proof is atomic with result intent');
  assert.equal(snapshot.pending.cessationVerified.attemptId,snapshot.resultPending.attempt.attempt_id);
  if(proof==='missing')delete snapshot.pending.cessationVerified;
  if(proof==='mismatched')snapshot.pending.cessationVerified.generation++;
  await f.policy.storage.set(snapshot);
  const claims=f.count('/jobs/claim-next'),releases=f.count('/release');
  f.override=null;launch(f);
  await until(()=>completed(f),'saved result recovered without re-execution');
  if(proof==='valid') {
    await until(()=>f.count('/jobs/claim-next')>claims,'durable cleanup proof resumes claiming');
    assert.equal(f.saved().pending,null);
    assert.equal(f.saved().claimedPending,null);
    assert.equal(f.saved().jobs,snapshot.jobs);
    assert.equal(snapshot.pending.actualUse.ms,60000,'the durable cleanup record carries measured run time');
    assert.equal(f.saved().milliseconds,snapshot.milliseconds-(snapshot.pending.reservedMs-snapshot.pending.actualUse.ms),
      'restart preserves the measured time charge');
    assert.equal(f.count('/release'),releases,'completed attempt is not released again');
  } else {
    await until(()=>f.events.some(e=>e.reason==='cleanup_pending'),'missing proof remains fail closed');
    assert.equal(f.count('/jobs/claim-next'),claims);
    assert.equal(f.saved().pending.attemptId,snapshot.pending.attemptId);
  }
  await f.stop();assert.equal(runs(f),1);
});

test('v1 lender runs a preferred disk request and its receipt never claims storage is enforced',{timeout:60000},async t=>{
  // The fake backend reports what the real docker-sbx backend reports: four enforced limits, storage unenforced.
  const real={enforced_limits:['cpu','memory','wall','output'],unenforced:['storage','processes','network_bytes']};
  const f=await lenderFixture(t,{mutateJob:job=>{job.requirements.limit_modes={disk_bytes:'preferred'};job.requirements.limits.disk_bytes++;},
    admission:{ok:true,...real},executionEvidence:{egress_evidence:{'api.example.test':'allowed'},...real}});
  const report=f.backend.lenderCapabilities();
  f.backend.lenderCapabilities=()=>({...report,enforced_limits:report.enforced_limits.filter(k=>k!=='disk_bytes')});
  launch(f);await finish(f);
  const receipt=f.result.payload.receipt;
  assert.equal(receipt.enforced_limits.includes('storage'),false);
  assert.ok(receipt.unenforced.includes('storage'));
  const advertisement=f.requests.find(r=>r.route==='/jobs/claim-next').body.advertisement;
  assert.equal(advertisement.enforced_limits.includes('disk_bytes'),false,'the lender never advertises a disk ceiling');
});
test('v1 lender receipt records that GitHub was reachable only for the clone (review 3)',{timeout:30000},async t=>{
  for(const scope of ['clone_only','whole_run',undefined]) {
    const f=await lenderFixture(t,{onClone:handle=>{if(scope){handle._execution.network_scope=scope;handle._execution.network_kit={hosts:['github.com'],wider:['**.github.com']};}}});
    launch(f);await finish(f);
    const receipt=f.result.payload.receipt;
    assert.equal(receipt.network_scope,scope,'the receipt carries what the backend proved, and nothing it did not');
    assert.deepEqual([receipt.kit_hosts,receipt.kit_wider_hosts],scope?[['github.com'],['**.github.com']]:[undefined,undefined],'the kit hosts ride along');
    assert.equal(receipt.verified_commit,f.job.payload.source.commit);
  }
});
test('v1 lender refuses legacy required disk when backend only enforces four limits',{timeout:60000},async t=>{
  const f=await lenderFixture(t),report=f.backend.lenderCapabilities();
  f.backend.lenderCapabilities=()=>({...report,enforced_limits:report.enforced_limits.filter(k=>k!=='disk_bytes')});
  launch(f);
  // The non-filtering fake server returns an incompatible claim. Client
  // validation rejects it, and cleanup follows the deterministic retry wait.
  await until(()=>f.saved()?.lastClaimOutcome?.code==='requirements_unsupported','required disk rejected');
  await until(()=>f.clock.pending().includes(1000),'rejected-claim retry scheduled');
  assert.equal(f.saved().declinePending.rejectedClaim,true);
  f.clock.advance(1000);
  await until(()=>f.count('/release')===1,'required disk cleanup');
  await until(()=>!f.saved().declinePending,'cleanup durably settled');
  await f.stop();noExecution(f);
  assert.equal(f.saved().jobs,0);assert.equal(f.saved().milliseconds,0);
  assert.equal(f.saved().pending,null);
  assert.equal(f.count('/release'),1);
});
test('real HTTP queue does not claim legacy required disk for a four-limit lender',{timeout:60000},async t=>{
  const f=await realLenderFixture(t),report=f.backend.lenderCapabilities();
  const ad=currentAdvertisement({harnesses:['codex'],models:['example-model'],capabilities:[],egress:report.egress,
    enforced_limits:report.enforced_limits.filter(k=>k!=='disk_bytes'),max_limits:report.max_limits},f.runOptions.runAccounts());
  assert.equal(await f.client.claimNext(ad,{waitSeconds:0}),null);
  const view=await f.owner.getJob(f.jobDigest);
  assert.equal(view.state,'queued');assert.equal(view.current_attempt,null);
  assert.equal(view.attempts_started,0);noExecution(f);
});
for(const verifiedCommit of [false,'f'.repeat(40)])test('v1 lender rejects absent or mismatched verified Git HEAD '+verifiedCommit,{timeout:60000},async t=>{
  const f=await lenderFixture(t,{verifiedCommit});
  launch(f);await until(()=>f.count('/fail')===1,'Git evidence failure');await f.stop();
  assert.equal(f.count('/complete'),0);
  assert.ok(f.events.some(e=>e.reason==='execution_failed'));
});

for(const pauseFirst of [false,true])test(pauseFirst?'Pause leaves the running attempt alone until explicit Stop':'stop-current-job aborts fake work but reports cessation only after confirmed removal',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{hold:true}),removal=deferred();
  const action=new AsyncLocalStorage(),stopEvents=[];
  f.backend.destroy=async()=>{f.calls.push(['destroy']);return removal.promise;};
  const lender=launch(f,{onEvent:event=>{
    if(event.status==='stopping'&&event.reason==='stopped_by_lender')stopEvents.push({attempt:event.current,action:action.getStore()});
  }});
  try {
    await f.entered.promise;
    const id=lender.getState().current;
    assert.equal(f.saved().pending.attemptId,id);
    if(pauseFirst){
      const pending=structuredClone(f.saved().pending);
      action.run('pause',()=>lender.pause());
      assert.equal(lender.getState().current,id);
      assert.deepEqual(f.saved().pending,pending);
      assert.deepEqual(stopEvents,[]);
      assert.equal(f.count('/stop-request'),0);
    }
    await assert.rejects(lender.stopCurrentJob('different-attempt'),{code:'no_current_job'});
    assert.equal(f.calls.some(([kind])=>kind==='cancel'),false);
    assert.deepEqual(stopEvents,[]);
    const stopping=action.run('stop',()=>lender.stopCurrentJob(id));
    assert.ok(stopEvents.some(event=>event.attempt===id&&event.action==='stop'),'explicit Stop initiates stopping for the owned attempt before its reply');
    await stopping;
    await until(()=>f.calls.some(([kind])=>kind==='destroy'),'removal requested');
    assert.equal(f.calls.filter(([kind])=>kind==='cancel').length,1);
    assert.equal(f.count('/release'),0);
    assert.equal(f.count('/stopped'),0);
    assert.equal(f.count('/complete'),0);
    assert.equal(lender.getState().paused,pauseFirst,'Stop preserves the lender pause setting');
    assert.equal(f.saved().pending.stopReason,'stopped_by_lender');
    assert.equal(f.saved().pending.cessationVerified,undefined);
    assert.equal(lender.cessation().proven,false,'an acknowledged stop is not proof that the sandbox is gone');
    assert.throws(()=>lender.resume(),{code:'lending_recovery_required'});
    removal.resolve({removed:true});
    await until(()=>f.count('/stopped')===1&&!f.saved().pending,'confirmed stop');
    assert.equal(lender.cessation().proven,true);
    assert.equal(JSON.parse(f.requests.find(r=>r.route.endsWith('/release')).body.reason).code,'stopped_by_lender');
    const completed=f.events.find(e=>e.status==='stopped'&&e.reason==='stopped_by_lender');
    assert.deepEqual(completed?.stopCompletion,{attemptId:id,jobDigest:f.jobDigest,generation:f.attempt().generation});
    assert.equal(lender.getState().stopCompletion,undefined,'completion is an event, not a reusable status field');
    const claims=f.count('/jobs/claim-next');
    if(pauseFirst){
      f.clock.advance(60000);await new Promise(resolve=>setImmediate(resolve));
      assert.equal(f.count('/jobs/claim-next'),claims);
    }else{
      // The idle poll timer may be armed after the first advance, so keep advancing until the claim lands.
      await until(()=>{f.clock.advance(1000);return f.count('/jobs/claim-next')>claims;},'claim-next after a proven Stop');
    }
    assert.equal(stopEvents.some(event=>event.action==='pause'),false);
    assert.equal(lender.getState().paused,pauseFirst,'cessation proof preserves the lender pause setting');
  } finally {removal.resolve({removed:true});await f.stop();}
});

test('unverified stop survives restart and keeps its reason until backend removal proof',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{hold:true});
  f.backend.destroy=async()=>{f.calls.push(['destroy']);return {removed:false};};
  let proved=false;
  f.backend.reconcilePending=async pending=>({removed:proved,attemptId:pending.attemptId});
  let lender=launch(f);
  await f.entered.promise;
  await lender.stopCurrentJob(lender.getState().current);
  await until(()=>f.events.some(e=>e.reason==='cleanup_pending'),'unverified cessation');
  assert.equal(f.count('/stopped'),0);assert.equal(f.count('/release'),0);
  const pending=structuredClone(f.saved().pending);
  assert.equal(pending.stopReason,'stopped_by_lender');
  assert.equal(pending.cessationVerified,undefined);
  assert.deepEqual(requesterUsage(f),{jobs:1,milliseconds:120000});
  await f.stop();
  lender=launch(f);
  await until(()=>f.clock.pending().includes(1000),'restart recovery waiting');
  assert.equal(f.count('/stopped'),0);assert.equal(f.count('/release'),0);
  proved=true;f.clock.advance(1000);
  await until(()=>f.count('/stopped')===1&&!f.saved().pending,'recovered stop');
  assert.deepEqual(requesterUsage(f),{jobs:1,milliseconds:120000});
  assert.equal(f.saved().milliseconds,120000,'uncertain runtime stays fully reserved after restart');
  assert.equal(f.events.filter(e=>e.contribution?.kind==='stopped').length,1);
  assert.equal(f.events.filter(e=>e.contribution?.kind==='runtime').length,0,'uncertain runtime is never manufactured');
  const released=f.requests.find(r=>r.route.endsWith('/release'));
  assert.equal(JSON.parse(released.body.reason).code,'stopped_by_lender');
  assert.equal(released.req.headers['idempotency-key'],pending.stopReleaseKey);
  assert.equal(lender.getState().paused,false,'restart recovery preserves lending intent without pausing the lender');
  assert.equal(f.count('/complete'),0);
  await f.stop();
});

test('stop report transport failure retains removal proof and exact retry intents',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{hold:true});
  let unavailable=true;
  f.override=({route,res})=>{
    if(unavailable&&route.endsWith('/stopped')){f.problem(res,'unavailable',503);return true;}
    return false;
  };
  const lender=launch(f);
  await until(()=>runs(f)===1,'running fake sandbox');
  await lender.stopCurrentJob(lender.getState().current);
  await until(()=>f.events.some(e=>e.reason==='cleanup_pending'),'pending report');
  assert.equal(f.saved().pending.cessationVerified.attemptId,f.attempt().attempt_id);
  assert.ok(f.events.some(e=>e.contribution?.kind==='stopped'),'confirmed local stop is visible before its report is acknowledged');
  const pending=structuredClone(f.saved().pending);
  unavailable=false;
  await until(()=>f.clock.pending().includes(1000),'report retry delay');
  f.clock.advance(1000);
  await until(()=>!f.saved().pending,'acknowledged retried stop');
  const reports=f.requests.filter(r=>r.route.endsWith('/stopped'));
  assert.ok(reports.length>=2);
  assert.ok(reports.every(r=>r.req.headers['idempotency-key']===pending.stopReportKey));
  assert.ok(reports.every(r=>r.body.stopped_at===pending.stoppedAt));
  assert.equal(lender.getState().paused,false,'retrying a Stop report does not pause the lender');
  await f.stop();
});

test('stop-current-job cannot contradict a result already committing',{timeout:60000},async t=>{
  const f=await lenderFixture(t),commit=deferred();
  const complete=f.client.completeAttempt.bind(f.client);let committing=false;
  f.client.completeAttempt=async(...args)=>{committing=true;await commit.promise;return complete(...args);};
  const lender=launch(f);
  try {
    await until(()=>committing,'result commit boundary');
    await assert.rejects(lender.stopCurrentJob(lender.getState().current),{code:'no_current_job'});
    assert.equal(f.count('/release'),0);assert.equal(f.count('/stopped'),0);
    commit.resolve();await finish(f);
    assert.equal(f.count('/complete'),1);
  } finally {commit.resolve();await f.stop();}
});

for(const terminal of ['cancelled','expired'])test('real queue accepts cessation after '+terminal+' during delayed removal',{timeout:15000},async t=>{
  const f=await realLenderFixture(t,{hold:true}),removal=deferred();
  f.backend.destroy=async()=>{f.calls.push(['destroy']);return removal.promise;};
  const lender=launch(f);
  try {
    await until(()=>runs(f)===1,'real-queue fake sandbox run');
    await lender.stopCurrentJob(lender.getState().current);
    await until(()=>f.calls.some(([kind])=>kind==='destroy'),'delayed sandbox removal');
    if(terminal==='cancelled')await f.owner.cancelJob(f.jobDigest);
    else f.clock.advance(120001);
    const terminalView=await f.owner.getJob(f.jobDigest);
    assert.equal(terminalView.current_attempt.state,terminal);
    assert.equal(terminalView.current_attempt.compute_stopped,false);
    assert.equal(f.realRequests.some(r=>r.url.endsWith('/stopped')),false);
    removal.resolve({removed:true});
    await until(()=>!f.saved().pending,'terminal attempt cessation acknowledged');
    const stopped=await f.owner.getJob(f.jobDigest);
    assert.equal(stopped.current_attempt.compute_stopped,true);
    assert.ok(f.realRequests.some(r=>r.url.endsWith('/release')));
    assert.ok(f.realRequests.some(r=>r.url.endsWith('/stopped')));
    assert.equal(f.realRequests.some(r=>r.url.endsWith('/complete')),false);
    assert.equal(lender.getState().paused,false,'a terminal job cessation does not pause the lender');
  } finally {removal.resolve({removed:true});await f.stop();}
});

const requesterCap = (f,limits={}) => ({circle:f.job.payload.circle,keyId:f.job.payload.author,...limits});
const requesterUsage = f => f.saved().requesters?.[requesterCounterKey(f.job.payload.circle,f.job.payload.author)];

test('requester caps reject malformed policy without changing the uncapped default',()=>{
  assert.deepEqual(validateRequesterLimits(),[]);
  for(const value of [{},[{}],[{circle:'c',keyId:'short'}],
    [{circle:'c',keyId:'sha256:'+'a'.repeat(64),dailyJobs:-1}],
    [{circle:'c',keyId:'sha256:'+'a'.repeat(64),dailyMinutes:0.5}]])
    assert.throws(()=>validateRequesterLimits(value),{code:'invalid_policy'});
});

test('one exact requester is released before review while another key can still borrow',{timeout:60000},async t=>{
  const blocked=await lenderFixture(t);
  blocked.policy.requesterLimits=[requesterCap(blocked,{dailyJobs:0})];
  launch(blocked,{approve:()=>assert.fail('a blocked requester must not see review')});
  await until(()=>blocked.count('/release')===1,'requester release');await blocked.stop();
  noExecution(blocked);
  assert.equal(JSON.parse(blocked.requests.find(r=>r.route.endsWith('/release')).body.reason).code,'requester_limit');
  assert.equal(blocked.saved().jobs,0);
  assert.equal(blocked.saved().lastRequesterLimit.keyId,blocked.job.payload.author);

  const other=await lenderFixture(t,{authorIndex:1,saved:blocked.saved(),
    policy:{requesterLimits:blocked.policy.requesterLimits}});
  assert.notEqual(other.job.payload.author,blocked.job.payload.author);
  launch(other);await finish(other);
  assert.equal(other.saved().declineUntil,0,'another requester is not subject to a device-wide backoff');
  assert.equal(runs(other),1);assert.equal(requesterUsage(other).jobs,1);
});

test('a cap for the same key in another circle cannot block first borrowing',{timeout:60000},async t=>{
  const f=await lenderFixture(t);
  f.policy.requesterLimits=[{...requesterCap(f,{dailyJobs:0,dailyMinutes:0}),circle:'another-circle'}];
  launch(f);await finish(f);assert.equal(runs(f),1);assert.equal(requesterUsage(f).jobs,1);
  assert.equal(f.saved().requesters[requesterCounterKey('another-circle',f.job.payload.author)],undefined);
});

for(const kind of ['jobs','minutes'])test('the tighter '+kind+' cap wins in either direction',{timeout:60000},async t=>{
  const perKey=await lenderFixture(t);
  const row=requesterCap(perKey,kind==='jobs'?{dailyJobs:1}:{dailyMinutes:2});
  perKey.policy.requesterLimits=[row];
  await perKey.policy.storage.set({day:'2026-10-09',jobs:1,milliseconds:60000,pending:null,
    requesters:{[requesterCounterKey(row.circle,row.keyId)]:{jobs:1,milliseconds:60000}}});
  launch(perKey,{approve:()=>assert.fail('per-key cap must precede approval')});
  await until(()=>perKey.count('/release')===1,'tighter requester cap');await perKey.stop();noExecution(perKey);
  assert.equal(JSON.parse(perKey.requests.find(r=>r.route.endsWith('/release')).body.reason).code,'requester_limit');

  const global=await lenderFixture(t,{policy:kind==='jobs'?{dailyJobs:1}:{dailyMinutes:1},
    saved:{day:'2026-10-09',jobs:1,milliseconds:60000,pending:null}});
  global.policy.requesterLimits=[requesterCap(global,{dailyJobs:10,dailyMinutes:60})];
  launch(global);
  await until(()=>global.events.some(e=>e.reason==='daily_limit'),'tighter global cap');await global.stop();noExecution(global);
  assert.equal(global.count('/jobs/claim-next'),0);
});

test('requester reservation is atomic with global usage and measured runtime reconciles once',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{hold:true});
  f.policy.requesterLimits=[requesterCap(f,{dailyJobs:1,dailyMinutes:2})];
  f.dropCompleteAck=true;
  launch(f);await until(()=>runs(f)===1,'reserved requester running');
  assert.deepEqual(requesterUsage(f),{jobs:1,milliseconds:120000});
  assert.equal(f.saved().jobs,1);assert.equal(f.saved().milliseconds,120000);
  assert.deepEqual(f.saved().pending.requester,{circle:f.job.payload.circle,keyId:f.job.payload.author});
  f.clock.advance(15000);f.execution.resolve();await finish(f);
  assert.deepEqual(requesterUsage(f),{jobs:1,milliseconds:15000});
  assert.equal(f.saved().milliseconds,15000);assert.equal(f.count('/complete'),2);
  for(const saved of f.saves)if(saved.requesters) {
    const used=saved.requesters[requesterCounterKey(f.job.payload.circle,f.job.payload.author)];
    assert.equal(saved.jobs,used.jobs);assert.equal(saved.milliseconds,used.milliseconds);
  }
  const restarted=await lenderFixture(t,{saved:f.saved(),policy:{requesterLimits:f.policy.requesterLimits}});
  launch(restarted,{approve:()=>assert.fail('restart must retain the requester count')});
  await until(()=>restarted.count('/release')===1,'restart requester gate');await restarted.stop();noExecution(restarted);
  assert.deepEqual(requesterUsage(restarted),{jobs:1,milliseconds:15000});
});

test('a changed cap is rechecked after review without starting the requester job',{timeout:60000},async t=>{
  const f=await lenderFixture(t);
  launch(f,{approve:async()=>{f.policy.requesterLimits=[requesterCap(f,{dailyMinutes:1})];return true;}});
  await until(()=>f.count('/release')===1,'updated cap release');await f.stop();noExecution(f);
  assert.equal(JSON.parse(f.requests.find(r=>r.route.endsWith('/release')).body.reason).code,'requester_limit');
});

test('requester and global counters roll over together in the configured local day',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{policy:{timeZone:'Pacific/Kiritimati'}});
  const cap=requesterCap(f,{dailyJobs:1,dailyMinutes:2}),key=requesterCounterKey(cap.circle,cap.keyId);
  f.policy.requesterLimits=[cap];
  await f.policy.storage.set({day:'2026-10-09',jobs:10,milliseconds:3600000,pending:null,
    requesters:{[key]:{jobs:10,milliseconds:3600000}}});
  launch(f);await finish(f);
  assert.equal(f.saved().day,'2026-10-10');assert.equal(f.saved().jobs,1);
  assert.equal(requesterUsage(f).jobs,1);assert.equal(f.saved().milliseconds,requesterUsage(f).milliseconds);
});


test('lender defaults its day and counter budget to the host IANA zone', async t => {
  const f=await lenderFixture(t,{policy:{enabled:false}});
  f.clock.advance(Date.parse('2026-10-10T04:59:59Z')-f.clock.now());
  const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const day=lenderDayKey(f.clock.now(),zone);
  assert.equal(lenderDayKey(f.clock.now()),day);
  await f.policy.storage.set({day,jobs:2,milliseconds:90000,pending:null});
  const lender=launch(f);
  await until(()=>f.clock.pending().includes(1000),'paused local budget loaded');
  assert.equal(lender.getState().counters.day,day);
  assert.equal(lender.getState().counters.jobs,2);
  assert.equal(lender.getState().counters.milliseconds,90000);
  await f.stop();
});

test('Chicago midnight resets jobs, minutes and requester budgets together', async t => {
  const f=await lenderFixture(t,{policy:{enabled:false,timeZone:'America/Chicago'}});
  f.clock.advance(Date.parse('2026-10-10T04:59:59Z')-f.clock.now());
  const key=requesterCounterKey(f.job.payload.circle,f.job.payload.author);
  const usage={jobs:2,milliseconds:90000};
  await f.policy.storage.set({day:'2026-10-09',...usage,pending:null,requesters:{[key]:usage}});
  const lender=launch(f);
  await until(()=>f.clock.pending().includes(1000),'pre-midnight budget loaded');
  assert.equal(lender.getState().counters.day,'2026-10-09');
  assert.equal(lender.getState().counters.jobs,2);
  assert.equal(lender.getState().counters.milliseconds,90000);
  assert.deepEqual(lender.getState().counters.requesters[key],usage);
  f.clock.advance(1000);
  await until(()=>lender.getState().counters.day==='2026-10-10','Chicago midnight rollover');
  assert.equal(lender.getState().counters.jobs,0);
  assert.equal(lender.getState().counters.milliseconds,0);
  assert.deepEqual(lender.getState().counters.requesters,{});
  await f.stop();
});

test('pending work holds both previous-day budgets until verified removal, then rolls over',{timeout:60000},async t=>{
  const f=await lenderFixture(t),key=requesterCounterKey(f.job.payload.circle,f.job.payload.author);
  await f.policy.storage.set({day:'2026-10-08',jobs:1,milliseconds:120000,
    requesters:{[key]:{jobs:1,milliseconds:120000}},pending:{attemptId:'old-requester',reservedMs:120000,
      requester:{circle:f.job.payload.circle,keyId:f.job.payload.author}}});
  let removed=false;
  f.backend.reconcilePending=async pending=>({attemptId:pending.attemptId,removed});
  launch(f);await until(()=>f.events.some(e=>e.reason==='cleanup_pending'),'held previous day');
  assert.equal(f.saved().day,'2026-10-08');assert.deepEqual(requesterUsage(f),{jobs:1,milliseconds:120000});
  await until(()=>f.clock.pending().includes(1000),'recovery poll');
  removed=true;f.clock.advance(1000);await finish(f);
  assert.equal(f.saved().day,'2026-10-09');assert.equal(f.saved().jobs,1);assert.equal(requesterUsage(f).jobs,1);
});

test('lender emits bounded local attribution without adding it to signed completion', {timeout:60000},async t=>{
  const f=await lenderFixture(t);
  launch(f);await finish(f);
  const observations=f.events.filter(e=>e.status==='contribution').map(e=>e.contribution);
  for(const kind of ['reviewed','accepted','run','runtime','delivered'])
    assert.equal(observations.filter(e=>e.kind===kind).length,1,kind);
  for(const event of observations) {
    assert.equal(event.circle,f.result.payload.circle);
    assert.equal(event.jobDigest,f.result.payload.job_digest);
    assert.equal(event.attemptId,f.result.payload.attempt_id);
    assert.match(event.keyId,/^sha256:[0-9a-f]{64}$/);
  }
  const run=observations.find(e=>e.kind==='run');
  assert.equal(run.title,'Synthetic task: write a greeting. No external execution.');
  assert.equal(run.agent,'codex');
  assert.equal(observations.find(e=>e.kind==='accepted').title,run.title);
  assert.equal(observations.find(e=>e.kind==='accepted').agent,run.agent);
  for(const event of observations.filter(e=>!['accepted','run'].includes(e.kind))) {
    assert.equal(Object.hasOwn(event,'title'),false);
    assert.equal(Object.hasOwn(event,'agent'),false);
  }
  assert.ok(observations.find(e=>e.kind==='runtime').milliseconds>=0);
  assert.equal(JSON.stringify(f.result.payload).includes('contribution'),false);
  assert.equal(JSON.stringify(f.result.payload).includes(run.title),false);
  assert.equal(Object.hasOwn(f.result.payload,'title'),false);
  assert.equal(Object.hasOwn(f.result.payload,'agent'),false);
});
test('declined and timed out reviews remain distinct local observations', {timeout:60000},async t=>{
  for(const [approval,kind] of [[false,'skipped'],[{timedOut:true},'timedOut']]) {
    const f=await lenderFixture(t);
    launch(f,{approve:async()=>approval});
    await until(()=>f.events.some(e=>e.contribution?.kind===kind),'local decision recorded');
    await f.stop();noExecution(f);
    assert.equal(f.events.filter(e=>e.contribution?.kind==='reviewed').length,1);
    assert.equal(f.events.some(e=>e.contribution?.kind==='accepted'),false);
  }
});

test('v1 lender runs a production-shaped adapter spec that has install but no image (live 2026-10-18)',{timeout:60000},async t=>{
  const f=await lenderFixture(t);
  const {image,...raw}=f.adapters[0].spec;
  assert.ok(raw.install,'fixture harness has an install image');
  f.adapters[0].spec=raw; // HARNESS_ADAPTERS specs carry install, not image
  launch(f);
  await finish(f);
  assert.equal(runs(f),1,'job admitted and run instead of declined as execution_failed');
});

test('legacy review hold ends locally before the signed Job expiry while renewing its preparation lease',{timeout:60000},async t=>{
  const f=await lenderFixture(t);delete f.policy.legacyHoldMs;
  let seen;const approval=deferred();
  launch(f,{approve:input=>{seen=input;return approval.promise;}});
  await until(()=>seen,'legacy review');assert.equal(seen.expiresAt,f.clock.now()+60000);
  assert.ok(seen.expiresAt<Date.parse(f.job.payload.expires_at),'the card deadline is a shorter local review hold');
  f.clock.advance(30000);await until(()=>f.count('/renew')===1,'renewal');
  f.clock.advance(29000);assert.equal(seen.signal.aborted,false);assert.equal(f.count('/release'),0);
  f.clock.advance(1000);await until(()=>f.count('/release')===1,'legacy hold ends');
  assert.equal(seen.signal.aborted,true);assert.equal(f.attempt().state,'released');
  assert.ok(Date.parse(f.job.payload.expires_at)>f.clock.now(),'the signed Job remains unexpired for other lenders');
  await until(()=>f.events.some(event=>event.reason==='approval_pending'),'local review timeout status');
  assert.equal(f.events.some(event=>event.reason==='job_expired'),false,'the lender does not expire the globally runnable Job');
  approval.resolve(true);await f.stop();noExecution(f);
});

test('unavailable sandbox waits with lending enabled and remains distinct from a user pause',{timeout:60000},async t=>{
  const f=await lenderFixture(t);
  const capabilities=f.backend.lenderCapabilities.bind(f.backend);
  f.backend.lenderCapabilities=async()=>({...await capabilities(),available:false});
  const lender=launch(f);
  await until(()=>lender.getState().status==='waiting_for_sandbox','sandbox waiting state');
  const waiting=lender.getState();
  assert.equal(waiting.paused,false);
  assert.equal(waiting.reason,'sandbox_check_pending');
  assert.equal(waiting.label,lendingReasonText('sandbox_check_pending',{until:waiting.until}));
  noExecution(f);assert.equal(f.count('/jobs/claim-next'),0);
  lender.pause();
  assert.equal(lender.getState().paused,true);
  assert.equal(lender.getState().status,'paused');
  lender.resume();
  await until(()=>lender.getState().status==='waiting_for_sandbox','resumed sandbox waiting state');
  assert.equal(lender.getState().paused,false);
  await f.stop();
});

test('idle polls ask for a cached sandbox readiness; the recheck before a job always probes fresh', {timeout:60000}, async t=>{
  const f=await lenderFixture(t),lenderCapabilities=f.backend.lenderCapabilities.bind(f.backend),asked=[];
  f.backend.lenderCapabilities=async(...args)=>{asked.push(args[0]?.cached===true?'cached':'fresh');return lenderCapabilities();};
  launch(f);await finish(f);
  assert.equal(asked.includes('cached'),true);
  assert.equal(asked.includes('fresh'),true);
  assert.equal(runs(f),1);
});

test('S5.5 receipt carries observed allowed and denied hosts', {timeout:60000}, async t=>{
  const {parseObservedEgress}=await import('../lib/docker-backend.mjs');
  const egress_evidence=parseObservedEgress({code:0,stdout:JSON.stringify({
    allowed:[{sandbox_id:'run',host:'api.example.test:443',proxy_type:'forward',count:1}],
    blocked:[{sandbox_id:'run',host:'blocked.example.test:80',proxy_type:'transparent',count:1}]
  })},'run');
  const f=await lenderFixture(t,{executionEvidence:{egress_evidence,
    enforced_limits:['cpu','memory','wall','output','storage'],unenforced:[]}});
  launch(f);await finish(f);
  assert.deepEqual(f.result.payload.receipt.egress_evidence,
    {'api.example.test':'allowed','blocked.example.test':'denied'});
});

test('S5.5 missing observations never become a claim of no network use', {timeout:60000}, async t=>{
  const f=await lenderFixture(t,{executionEvidence:{egress_evidence:null,
    enforced_limits:['cpu','memory','wall','output','storage'],unenforced:[]}});
  launch(f);await finish(f);
  // Unreadable observations are marked unknown, never an empty "reached nothing".
  assert.deepEqual(f.result.payload.receipt.egress_evidence,{'*':'unknown'});
});

const toolLine=(name,input)=>JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name,input}]}});

test('progress steps are coarse: no file contents, no command lines, no secret-file or absolute paths',()=>{
  const SECRET='SYNTHETIC_TOKEN_abc123';
  assert.deepEqual(stepsFromLine(toolLine('Edit',{file_path:'src/app.js',old_string:SECRET,new_string:SECRET})),['Editing src/app.js']);
  assert.deepEqual(stepsFromLine(toolLine('Read',{file_path:'.env.production'})),['Reading a file']);
  assert.deepEqual(stepsFromLine(toolLine('Read',{file_path:'config/id_rsa'})),['Reading a file']);
  assert.deepEqual(stepsFromLine(toolLine('Write',{file_path:'/home/alice/notes.txt',content:SECRET})),['Writing a file']);
  assert.deepEqual(stepsFromLine(toolLine('Edit',{file_path:'a b;rm -rf.js'})),['Editing a file']);
  assert.deepEqual(stepsFromLine(toolLine('Bash',{command:'curl -H "Authorization: '+SECRET+'" https://x.test'})),['Running a command']);
  assert.deepEqual(stepsFromLine(toolLine('Grep',{pattern:SECRET})),['Searching the code']);
  assert.deepEqual(stepsFromLine(toolLine('SomethingNew',{x:SECRET})),[]);
  assert.deepEqual(stepsFromLine(JSON.stringify({type:'item.started',item:{type:'command_execution',command:SECRET}})),['Running a command']);
  assert.deepEqual(stepsFromLine(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:SECRET}})),[]);
  assert.deepEqual(stepsFromLine('not json '+SECRET),[]);
  for(const step of stepsFromLine(toolLine('Edit',{file_path:'x/'+'y'.repeat(70)+'.js'})))assert.ok([...step].length<=120);
});

test('progress reporter sends at most one step per 15 s and 40 per run, and never throws',async()=>{
  let clock=0;const sent=[];
  const reporter=createProgressReporter({now:()=>clock,send:async x=>{sent.push(x);if(sent.length===2)throw new Error('network');}});
  reporter.feed(toolLine('Read',{file_path:'a.js'})+'\n'+toolLine('Edit',{file_path:'b.js'})+'\n');await reporter.settled();
  assert.deepEqual(sent.map(x=>x.step),['Reading a.js'],'second step inside 15 s is dropped');
  clock=14999;reporter.feed(toolLine('Edit',{file_path:'b.js'})+'\n');await reporter.settled();assert.equal(sent.length,1);
  clock=15000;reporter.feed(toolLine('Edit',{file_path:'b.js'})+'\n');await reporter.settled();assert.equal(sent.length,2,'a failed send is swallowed');
  clock=30000;reporter.feed(toolLine('Edit',{file_path:'b.js'})+'\n');await reporter.settled();assert.equal(sent.length,2,'an unchanged step is not repeated');
  // A chunk split across reads is joined; a partial last line waits.
  clock=45000;const line=toolLine('Write',{file_path:'c.js'});reporter.feed(line.slice(0,20));await reporter.settled();assert.equal(sent.length,2);
  reporter.feed(line.slice(20)+'\n');await reporter.settled();assert.equal(sent.at(-1).step,'Writing c.js');
  // Cap: 39 steps, then the closing entry is the 40th.
  const capped=[];const r2=createProgressReporter({now:()=>clock,send:x=>{capped.push(x);}});
  for(let n=0;n<100;n++){clock+=15000;r2.feed(toolLine('Read',{file_path:'f'+n+'.js'})+'\n');}
  await r2.finish('done','Finished');assert.equal(capped.length,40);assert.equal(capped.at(-1).kind,'done');
  await r2.finish('done','again');assert.equal(capped.length,40);
});

test('progress reporter stages wait for the interval, share the cap, and are skipped once the run is closed (P8b)',async()=>{
  let clock=0;const sent=[],sleeps=[];let wake;
  const reporter=createProgressReporter({now:()=>clock,send:async x=>{sent.push(x);},sleep:ms=>{sleeps.push(ms);return new Promise(r=>{wake=r;});}});
  reporter.stage('preparing',0);await reporter.settled();
  assert.deepEqual(sent,[{stage:'preparing',elapsed_s:0}],'the first stage is sent at once');
  clock=3000;reporter.feed(toolLine('Read',{file_path:'a.js'})+'\n');await reporter.settled();
  assert.equal(sent.length,1,'a step inside the interval after a stage is dropped');
  const agent=reporter.stage('agent',3);await new Promise(r=>setImmediate(r));
  assert.deepEqual(sleeps,[12000],'the stage waits out the rest of the 15 s interval');assert.equal(sent.length,1);
  clock=15000;wake();await agent;
  assert.deepEqual(sent.at(-1),{stage:'agent',elapsed_s:3});
  reporter.stage('sending',20);await new Promise(r=>setImmediate(r));
  await reporter.finish('done','Finished');
  assert.deepEqual(sent.map(x=>x.stage??x.kind),['preparing','agent','done'],'a stage still waiting is dropped when the run closes');
  for(const bad of [-1,1.5,NaN,'3'])assert.equal(sent.length,3,String(bad)),reporter.stage('agent',bad);
  // The cap is shared with steps: 39 non-final entries, then the closing entry.
  const capped=[];const r2=createProgressReporter({now:()=>clock,send:x=>{capped.push(x);},sleep:async()=>{}});
  for(let n=0;n<100;n++){clock+=15000;if(n%2)r2.stage('agent',n);else r2.feed(toolLine('Read',{file_path:'f'+n+'.js'})+'\n');}
  await r2.finish('done','Finished');assert.equal(capped.length,40);assert.equal(capped.at(-1).kind,'done');
});

test('v1 lender reports preparing, agent and sending with monotonic elapsed seconds (P8b)',{timeout:60000},async t=>{
  const f=await lenderFixture(t);
  const start=f.backend.start;
  f.backend.start=async(...args)=>{f.clock.advance(16000);return start(...args);}; // the agent stage is queued before start
  const override=f.override;
  f.override=async record=>{if(record.route.startsWith('/artifacts/')&&record.req.method==='POST')f.clock.advance(16000);return override?override(record):false;};
  launch(f);await finish(f);
  const stages=f.requests.filter(r=>r.route.endsWith('/progress')).map(r=>r.body).filter(b=>b?.stage);
  assert.deepEqual(stages.map(b=>b.stage),['preparing','agent','sending']);
  assert.ok(stages.every(b=>Object.keys(b).sort().join()==='attempt,elapsed_s,stage'));
  assert.ok(stages.every((b,i)=>Number.isSafeInteger(b.elapsed_s)&&b.elapsed_s>=0&&(i===0||b.elapsed_s>=stages[i-1].elapsed_s)));
  assert.equal(stages[0].elapsed_s,0);
  assert.equal(stages.some(b=>['checks','screenshots'].includes(b.stage)),false,'phases that do not exist are not reported');
});

test('a host that does not advertise progress_v1 never receives a progress post (P22)',{timeout:60000},async t=>{
  for(const [label,hostCapabilities,expected] of [['an older host',['run_request_v1'],false],['a current host',undefined,true]]) {
    const f=await lenderFixture(t,{hostCapabilities});
    launch(f);await finish(f);
    assert.equal(f.requests.some(r=>r.route.endsWith('/progress')),expected,label);
  }
});

test('real HTTP lender sends coarse progress; the borrower reads it and the transcript content never appears',{timeout:60000},async t=>{
  const SECRET='SYNTHETIC_TOKEN_abc123';
  const f=await realLenderFixture(t,{stdout:[toolLine('Edit',{file_path:'.env.local',old_string:SECRET,new_string:SECRET}),
    toolLine('Bash',{command:'echo '+SECRET}),'{"type":"turn.completed","usage":{"input_tokens":13,"output_tokens":5}}'].join('\n')+'\n'});
  launch(f);await finish(f);
  await until(async()=>(await f.owner.fetchProgress(f.jobDigest)).entries.some(e=>e.kind==='done'),'closing entry');
  const page=await f.owner.fetchProgress(f.jobDigest);
  // The stage entry for preparing goes first and starts the interval, so the step fed right after is dropped (the fake clock does not move).
  assert.deepEqual(page.entries.map(e=>[e.seq,e.stage??e.kind,e.step??e.elapsed_s]),[[1,'preparing',0],[2,'done','Finished']]);
  assert.doesNotMatch(JSON.stringify(page),new RegExp(SECRET+'|env'));
  assert.deepEqual((await f.client.fetchProgress(f.jobDigest)).entries,page.entries,'the lender reads its own steps too');
});


test('local display title ends at short CR and Unicode lines before private prompt content', {timeout:60000}, async t=>{
  for(const separator of ['\r','\u2028','\u2029']) {
    const prompt=Buffer.from('Short title'+separator+'PRIVATE second line');
    const promptRef={digest:p.digestBytes(prompt),bytes:prompt.length,media_type:'text/plain'};
    const f=await lenderFixture(t,{mutateJob:job=>{job.prompt=promptRef;}});
    f.artifacts.set(promptRef.digest,prompt);
    launch(f);await finish(f);
    for(const event of f.events.filter(e=>e.status==='contribution').map(e=>e.contribution)) {
      if(['accepted','run'].includes(event.kind))assert.equal(event.title,'Short title');
      assert.equal(JSON.stringify(event).includes('PRIVATE'),false);
    }
  }
});

// Judge r10 R3: two stopped jobs that ran about a minute each were charged their whole 20-minute limits, so the lender
// read "Ready" with 18 minutes left while every job needed 20. A stop with proven cessation charges the time it ran.
test('a job the lender stopped is charged the time it ran, not its whole limit',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{hold:true});
  const lender=launch(f);
  try {
    await f.entered.promise;
    assert.equal(f.saved().milliseconds,120000,'the whole limit is reserved while it runs');
    f.clock.advance(30000);
    await lender.stopCurrentJob(lender.getState().current);
    await until(()=>f.count('/stopped')===1&&!f.saved().pending,'confirmed stop');
    assert.equal(f.saved().jobs,1);
    assert.ok(f.saved().milliseconds>=30000&&f.saved().milliseconds<=31000,'charged '+f.saved().milliseconds+' ms for a 30 s run');
  } finally {await f.stop();}
});

test('a follow-up job is titled by its new request line, not the context header', {timeout:60000}, async t=>{
  const {continuationPrompt,buildHandoff}=await import('../lib/v1/continuation.mjs');
  const prompt=Buffer.from(continuationPrompt(buildHandoff({prompt:'Parse the CSV',transcript:'',knownValues:[]}),'Also handle quoted fields that contain commas.'));
  const promptRef={digest:p.digestBytes(prompt),bytes:prompt.length,media_type:'text/plain'};
  const f=await lenderFixture(t,{mutateJob:job=>{job.prompt=promptRef;}});
  f.artifacts.set(promptRef.digest,prompt);
  launch(f);await finish(f);
  const titles=f.events.filter(e=>e.status==='contribution').map(e=>e.contribution).filter(e=>['accepted','run'].includes(e.kind)).map(e=>e.title);
  assert.ok(titles.length>0);
  for(const title of titles)assert.equal(title,'Also handle quoted fields that contain commas.');
});

// O-A (r11): admissibility is this account's own latest observation. A late, older observation never overwrites a newer
// one; a known change makes the account unknown until it is observed again; an old observation is not proof of ready.
function arriving(f) {
  return {author:'faravan-readiness-probe',circle:f.job.payload.circle,requirements:structuredClone(f.job.payload.requirements),
    expires_at:new Date(f.clock.now()+86400000).toISOString()};
}
test('O-A: a late older observation never overwrites a newer one; a refresh is unknown until observed again', async t => {
  const f=await lenderFixture(t,{policy:{pollMs:36000000}});
  const usable=f.backend.lenderCapabilities,observations=[];
  f.backend.lenderCapabilities=()=>new Promise(resolve=>{observations.push(resolve);});
  f.client.claimNext=(_advertisement,{signal})=>new Promise((_,reject)=>signal?.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})),{once:true}));
  const lender=launch(f),probe=arriving(f);
  await until(()=>observations.length>=1,'the loop observes its account');
  assert.equal(lender.admits(probe),'lender_starting','nothing observed yet: unknown is not proof of ready');
  const refreshed=lender.refreshAdmission();
  await until(()=>observations.length>=2,'the refresh observes again');
  observations[1](usable());
  await refreshed;
  assert.equal(lender.admits(probe),null,'the newer usable observation is the answer');
  observations[0]({...usable(),available:false});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(lender.admits(probe),null,'the late older unusable observation cannot overwrite it');
  const changed=lender.refreshAdmission();
  assert.equal(lender.admits(probe),'lender_starting','a known change is unknown until observed again');
  await until(()=>observations.length>=3,'the change is observed');
  observations[2]({...usable(),available:false});
  await changed;
  assert.equal(lender.admits(probe),'sandbox_check_pending','the account is refused once observed unusable');
});
test('O-A: an observation older than the freshness bound is unknown, not proof of ready', async t => {
  const f=await lenderFixture(t,{policy:{pollMs:36000000}});
  f.client.claimNext=(_advertisement,{signal})=>new Promise((_,reject)=>signal?.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})),{once:true}));
  const lender=launch(f),probe=arriving(f);
  await until(()=>lender.admits(probe)===null,'the account is observed usable');
  f.clock.advance(60001);
  assert.equal(lender.admits(probe),'lender_starting','an observation older than the bound must be proven again');
  await lender.refreshAdmission();
  assert.equal(lender.admits(probe),null,'re-proven usable');
});

// The test Mac 11-01: every account read "Check protected workspace setup" while the cause was an agent.
// The wait label follows the reason; only a sandbox reason keeps the workspace line.
const availabilityForEvidence=(f,evidence)=>async({conditions={}}={})=>{
  const at=f.clock.now(),id='fixture-account';
  const decision=decideLending({schemaVersion:1,nowMs:at,account:{id,providerId:'codex',enabled:evidence.enabled!==false,authState:evidence.signedIn===false?'signed_out':'signed_in'},
    usage:{accountId:id,state:'unavailable',reading:null},ledger:{accountId:id,resources:[]},history:{accountId:id,rows:[]},job:null,
    policy:{enabled:f.policy.enabled,revision:1,strategy:'automatic',strategyParams:{},protectionPosition:'balanced'},
    eligibility:{evaluatedAtMs:at,settingsRevision:1,enabledNow:conditions.enabledNow!==false},runtime:conditions.runtime??{canStart:true},conditions});
  return {decision,accountIds:decision.kind==='lend'?[id]:[]};
};
const WAIT_LABEL = [
  ['signed out',{signedIn:false},null,'account_signed_out'],
  ['not lent',{enabled:false,chosen:false},null,'lending_off'],
  ['sandbox down',{}, {available:false},'sandbox_check_pending'],
];
for (const [name,evidence,report,reason] of WAIT_LABEL) {
  test(`the wait label follows its reason: ${name}`, async t => {
    const f = await lenderFixture(t, {policy: {pollMs: 36000000}});
    const usable = f.backend.lenderCapabilities;
    Object.assign(f.adapters[0], evidence);
    f.runOptions.accountExecution.availability=availabilityForEvidence(f,evidence);
    if (report) f.backend.lenderCapabilities = () => ({...usable(), ...report});
    const lender = launch(f);
    await until(() => lender.getState().status === 'waiting_for_sandbox', 'the account waits');
    const state = lender.getState();
    assert.equal(state.reason, reason);
    assert.equal(state.label,lendingReasonText(reason,{until:state.until}));
    if(reason!=='sandbox_check_pending') assert.doesNotMatch(state.label, /protected workspace/);
  });
}
test('a pool headline and admission never stand on an agent the owner did not choose', async () => {
  const {createLendingPool} = await import('../lib/v1/lending-pool.mjs');
  const child = (reason) => ({start: () => new Promise(() => {}), getState: () => ({status: 'waiting_for_sandbox', reason, label: reason, current: null}),
    admits: () => reason, reconfigure() {}, pause() {}, resume() {}, cessation: () => ({proven: true})});
  const order = ['gemini', 'claude', 'codex'], reasons={gemini:'lending_off',claude:'account_signed_out',codex:'lending_off'};
  let next = 0;
  const pool = createLendingPool({storage: {get: async () => null, set: async () => {}}, capacity: 3, maxResources: {cpu: 8, memoryBytes: 64 * 1024 ** 3},
    policy: {enabled: true}, adapters: order.map(id => ({spec: {harness_id: id}})),
    createLender: () => child(reasons[order[next++]])});
  pool.start();
  await until(() => pool.getState().accountStates?.length === 3, 'three accounts');
  assert.equal(pool.getState().reason,'account_signed_out');
  assert.equal(pool.admits({requirements:{limits:{}}}),'account_signed_out');
});

// O-A (r11): an account that cannot take a job says why, from its own evidence. Only a sandbox failure says workspace.
const WHY = [
  ['signed out', {signedIn:false}, null, 'account_signed_out'],
  ['not lent', {enabled:false}, null, 'lending_off'],
  ['sandbox down',{}, {available:false},'sandbox_check_pending'],
  ['usable', {}, null, null],
];
for (const [name, evidence, report, expected] of WHY) {
  test(`O-A reason follows the evidence: ${name}`, async t => {
    const f = await lenderFixture(t, {policy: {pollMs: 36000000}});
    const usable = f.backend.lenderCapabilities;
    f.client.claimNext = (_advertisement, {signal}) => new Promise((_, reject) => signal?.addEventListener('abort',
      () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})), {once: true}));
    Object.assign(f.adapters[0], evidence);
    f.runOptions.accountExecution.availability=availabilityForEvidence(f,evidence);
    if (report) f.backend.lenderCapabilities = () => ({...usable(), ...report});
    const lender = launch(f), probe = arriving(f);
    await until(() => (expected === null ? lender.admits(probe) === null : lender.getState().status === 'waiting_for_sandbox'), 'the account is observed');
    assert.equal(lender.admits(probe), expected);
    if (expected !== null) assert.equal(lender.getState().reason, lendingReasonCode(expected), 'the loop reports the same reason it admits with');
  });
}

test('a decline intent is never saved for a run whose start was requested',{timeout:60000},async t=>{
  // Declines are pre-launch by construction: recoverDecline may clear one on a fenced view without removal proof.
  const f=await lenderFixture(t);
  launch(f);await finish(f);
  assert.ok(f.saves.some(row=>row.pending?.executionStartRequested===true),'the run requested its start');
  for(const row of f.saves)assert.ok(!(row.declinePending&&row.pending?.executionStartRequested===true),'declinePending saved after launch');
});

test('a restarted lender removes the orphaned run sandbox before its first claim',{timeout:60000},async t=>{
  // A run from before the restart may have left an escaped process in its sandbox. Recovery must remove it first.
  const f=await lenderFixture(t,{saved:{day:'2026-10-09',jobs:1,milliseconds:120000,
    pending:{attemptId:'old-attempt',reservedMs:120000}}});
  let sandboxAlive=true;const order=[];
  f.backend.reconcilePending=async pending=>{order.push('remove-orphan');sandboxAlive=false;return {attemptId:pending.attemptId,removed:true};};
  const claimed=(claim)=>(...args)=>{order.push(sandboxAlive?'claim-before-removal':'claim');return claim(...args);};
  f.client.claimNext=claimed(f.client.claimNext.bind(f.client));
  f.client.claimJob=claimed(f.client.claimJob.bind(f.client));
  launch(f);
  await finish(f);
  assert.equal(order[0],'remove-orphan','removal is the first recovery step');
  assert.ok(!order.includes('claim-before-removal'),'no claim while the orphaned sandbox may be alive');
  assert.ok(order.includes('claim'),'the lender claims new work after the removal');
});

for(const savedCase of ['deleted counters','pending null','corrupt cessation proof'])
test('owned-orphan barrier precedes claims with '+savedCase,{timeout:60000},async t=>{
  const f=await lenderFixture(t);
  const attempt={attempt_id:'old-attempt',job_digest:f.jobDigest,generation:1};
  if(savedCase==='deleted counters')await f.policy.storage.set(null);
  else await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,
    pending:savedCase==='pending null'?null:{attemptId:attempt.attempt_id,attempt,reservedMs:0,
      executionStartRequested:true,cessationVerified:{sbx_home:f.backend.sandboxOwnership().sbx_home,attemptId:attempt.attempt_id,jobDigest:attempt.job_digest,generation:1}}});
  let alive=true,barriers=0;const order=[];
  f.backend.reconcileOwnedSandboxes=async()=>{barriers++;order.push('barrier');alive=false;return {removed:true,foreign:[]};};
  f.backend.reconcilePending=async pending=>({removed:true,attemptId:pending.attemptId});
  // Recovery transport is irrelevant to the local ownership barrier.
  f.client.release=async()=>({});f.client.stopped=async()=>({});
  for(const key of ['claimNext','claimJob'])if(typeof f.client[key]==='function') {
    const claim=f.client[key].bind(f.client);
    f.client[key]=(...args)=>{order.push(alive?'unsafe-claim':'claim');return claim(...args);};
  }
  launch(f);await finish(f);
  assert.equal(barriers,1);assert.equal(order[0],'barrier');
  assert.ok(order.includes('claim'));assert.ok(!order.includes('unsafe-claim'));
});

for(const journal of ['missing','empty'])test('signed-out sandbox with '+journal+' ownership journal shows readiness and resumes', {timeout:15000}, async t=>{
  const f=await lenderFixture(t,{harness:'claude-code-subscription',policy:{mode:'auto'}});
  const root=mkdtempSync(join(tmpdir(),'faravan-empty-ownership-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const cleanupDirectory=journal==='missing'?join(root,'journal'):root;
  let signedIn=false;
  const owned=new DockerSbxBackend({sandboxDeadlines:fakeSandboxDeadlines(),cleanupDirectory,runCommand:async()=>signedIn
    ?{code:0,stdout:'[]'}:{code:1,stdout:'',stderr:'not signed in'}});
  for(const key of ['beginLendingSession','reconcileOwnedSandboxes','isOwnedSandboxProofCurrent','isOwnedSandboxAdmissionCurrent'])
    f.backend[key]=owned[key].bind(owned);
  const ready=f.backend.lenderCapabilities;
  f.backend.lenderCapabilities=()=>signedIn?ready():{available:false,reason:'docker_signed_out'};
  const adapters=[...f.adapters];
  const lender=launch(f);
  await until(()=>f.clock.pending().length>0,'startup reaches a wait');
  assert.equal(lender.getState().reason,'sandbox_cannot_start');
  assert.equal(f.policy.enabled,true);
  assert.equal(f.count('/jobs/claim-next'),0);
  assert.equal(runs(f),0);
  signedIn=true;f.runOptions.accountExecution.availability=availabilityForEvidence(f,{enabled:false});f.clock.advance(3000);
  await until(()=>lender.getState().reason==='lending_off','an account must be chosen next');
  await until(()=>f.clock.pending().includes(1000),'readiness retry is scheduled');
  f.runOptions.accountExecution.availability=availabilityForEvidence(f,{});f.clock.advance(3000);
  await finish(f);
  assert.equal(runs(f),1,'new work runs after readiness returns');
  assert.ok(!f.events.some(e=>e.reason==='cleanup_pending'));
});

test('owned-orphan failed inventory blocks claims until a successful retry',{timeout:60000},async t=>{
  const f=await lenderFixture(t);let available=false,calls=0;
  f.backend.reconcileOwnedSandboxes=async()=>{calls++;return {removed:available,foreign:[]};};
  launch(f);
  await until(()=>f.events.some(e=>e.reason==='cleanup_pending'),'startup barrier holds');
  assert.equal(f.count('/jobs/claim-next'),0);assert.equal(runs(f),0);
  await until(()=>f.clock.pending().includes(3000),'barrier backoff');
  available=true;f.clock.advance(3000);await finish(f);assert.ok(calls>=2);
});

test('owned-orphan foreign diagnostic is once per sandbox across startup retries',{timeout:60000},async t=>{
  const f=await lenderFixture(t),diagnostics=[];let available=false;
  f.backend.reconcileOwnedSandboxes=async()=>({removed:available,foreign:['wf-0123456789abcdef']});
  launch(f,{onDiagnostic:event=>diagnostics.push(event)});
  await until(()=>f.clock.pending().includes(3000),'first barrier backoff');
  f.clock.advance(3000);await until(()=>f.clock.pending().includes(3000),'second barrier backoff');
  assert.equal(diagnostics.filter(e=>e.code==='cessation_unverified').length,1);
  available=true;f.clock.advance(3000);await finish(f);
});

test('owned-orphan lender rejects a cached proof invalidated before its await continuation',{timeout:60000},async t=>{
  const f=await lenderFixture(t),old={removed:true,foreign:[]},cached=Promise.resolve(old);
  let first=true,current=old;
  f.backend.reconcileOwnedSandboxes=()=>{
    if(first){first=false;queueMicrotask(()=>{current=null;});return cached;}
    return Promise.resolve(current);
  };
  f.backend.isOwnedSandboxProofCurrent=proof=>proof===current;
  launch(f);
  await until(()=>f.clock.pending().includes(3000)||f.count('/jobs/claim-next')>0,'proof consumed');
  assert.equal(f.count('/jobs/claim-next'),0,'lender must validate at consumption as well as settlement');
  assert.equal(runs(f),0);
  current={removed:true,foreign:[]};f.clock.advance(3000);
  await finish(f);
});

test('owned-orphan mixed-session restart with deleted counters waits for fresh absence and preserves live B',{timeout:60000},async t=>{
  const a=await lenderFixture(t,{hold:true,mutateJob:job=>{job.source.commit='a'.repeat(40);}});
  const b=await lenderFixture(t,{hold:true,mutateJob:job=>{job.source.commit='b'.repeat(40);}});
  assert.notEqual(a.policy.storage,b.policy.storage);
  const root=mkdtempSync(join(tmpdir(),'faravan-mixed-session-'));
  const live=new Set(),commands=[],pairs=new Map();
  let removeA=false,failList=false,aName,bName;
  const owned=new DockerSbxBackend({sandboxDeadlines:fakeSandboxDeadlines(),cleanupDirectory:join(root,'journal'),
    runCommand:withCleanCredentialScope(async args=>{
      commands.push(args);
      if(args[0]==='ls')return failList?{code:1,stdout:''}:{code:0,stdout:JSON.stringify([...live].map(name=>({name})))};
      if(['run','create'].includes(args[0])&&args.includes('--name'))live.add(args[args.indexOf('--name')+1]);
      if(args[0]==='rm'&&(args.at(-1)!==aName||removeA))live.delete(args.at(-1));
      return {code:0,stdout:args[0]==='policy'?'{"rules":[]}':''};
    })});
  owned._configureEgress=async()=>{};
  const originals=new Map([[a,a.backend],[b,b.backend]]);
  // Keep the fixture's fake execution/transport, but use the real Docker
  // prepare, journal, destroy and shared-session barrier for compute ownership.
  const shared=new Proxy(a.backend,{get(target,name){
    if(['beginLendingSession','reconcileOwnedSandboxes','isOwnedSandboxProofCurrent','isOwnedSandboxAdmissionCurrent'].includes(name))return owned[name]?.bind(owned);
    if(name==='prepare')return async(spec,...args)=>{
      const fixture=a.saved()?.pending?.jobId===spec.job_id?a:b;
      assert.equal(fixture.saved()?.pending?.jobId,spec.job_id);
      const handle=await originals.get(fixture).prepare(spec,...args);
      const tracked=await owned.prepare({job_id:spec.job_id,image:'wf-faravan-guest@sha256:0000000000000000000000000000000000000000000000000000000000000000',entrypoint:'true',
        execution_scope:'owner',
        resources:{cpu:1,memory_mib:512,storage_mib:512,wall_seconds:60,output_bytes:1024,network_bytes:1024,max_processes:16},
        inputs:[],output_manifest:[],egress:'internet',provider_hosts:['**.openai.com']});
      pairs.set(handle,{fixture,tracked});
      if(fixture===a)aName=tracked.sandbox_id;else bName=tracked.sandbox_id;
      return handle;
    };
    if(name==='destroy')return async(handle,...args)=>{
      const pair=pairs.get(handle);
      const receipt=await originals.get(pair?.fixture??a).destroy(handle,...args);
      return pair?{...receipt,...await owned.destroy(pair.tracked)}:receipt;
    };
    const value=Reflect.get(target,name,target);
    if(typeof value!=='function')return value;
    return (...args)=>{
      const backend=originals.get(pairs.get(args[0])?.fixture??a);
      return backend[name](...args);
    };
  }});
  a.backend=shared;b.backend=shared;
  t.after(async()=>{
    failList=false;removeA=true;
    await a.stop?.();await b.stop?.();
    for(const {tracked} of pairs.values())await owned.destroy(tracked);
    rmSync(root,{recursive:true,force:true});
  });
  launch(a);await until(()=>runs(a)===1&&aName,'A starts compute');
  launch(b);await until(()=>runs(b)===1&&bName,'B starts compute');
  assert.equal(owned._lenderSessions,2);
  assert.ok(live.has(aName)&&live.has(bName));
  await a.stop();
  assert.equal(owned._lenderSessions,1,'B remains alive after A aborts');
  assert.ok(live.has(aName),'failed cleanup leaves A compute alive');
  await a.policy.storage.set(null);
  const claim=a.client.claimNext.bind(a.client);
  const restartedClaims=[];
  a.client.claimNext=(...args)=>{restartedClaims.push({aAlive:live.has(aName),listed:commands.some(cmd=>cmd[0]==='ls')});return claim(...args);};
  if(typeof a.client.claimJob==='function'){
    const claimJob=a.client.claimJob.bind(a.client);
    a.client.claimJob=(...args)=>{restartedClaims.push({aAlive:live.has(aName),listed:commands.some(cmd=>cmd[0]==='ls')});return claimJob(...args);};
  }
  commands.length=0;failList=true;
  launch(a);
  await until(()=>a.clock.pending().includes(3000)||restartedClaims.length>0,'restart reaches barrier or unsafe claim');
  assert.equal(owned._lenderSessions,2);
  // "An unresolved old sandbox row blocks only its own name" (docs/design/SANDBOX-CLEANUP-RECOVERY.md, Per-target admission): the
  // restarted lender may take new work under a fresh name, but nothing is created under A's old name while that row stays.
  const reusesA=()=>commands.some(cmd=>['run','create'].includes(cmd[0])&&cmd.includes('--name')&&cmd[cmd.indexOf('--name')+1]===aName);
  assert.equal(reusesA(),false,'deleted counters cannot reuse pre-orphan success');
  failList=false;a.clock.advance(3000);
  await until(()=>commands.some(cmd=>cmd[0]==='rm'&&cmd.at(-1)===aName)||restartedClaims.length>0,'fresh inventory attempts A removal');
  assert.equal(reusesA(),false,'successful rm command is not fresh absence');
  assert.ok(live.has(aName)&&live.has(bName));
  assert.ok(!commands.some(cmd=>cmd[0]==='rm'&&cmd.at(-1)===bName),'B is never removed by A recovery');
  // The old row is retried by the app's cleanup pass, not by a lender wait: removal follows a fresh listing, and an rm that
  // leaves the sandbox listed proves nothing.
  // The availability rule adds a separate read flight. A fresh-name claim
  // is not completion of that flight; wait before requesting this explicit pass.
  await Promise.allSettled([owned._ownedStartupRecovery,owned._deadlineRecovery]);
  commands.length=0;await owned.reapCleanup();
  assert.ok(commands.some(cmd=>cmd[0]==='rm'&&cmd.at(-1)===aName),'the pass removes A by name after a fresh listing');
  assert.ok(live.has(aName),'a removal that leaves A listed is not fresh absence');
  removeA=true;await owned.reapCleanup();
  assert.equal(live.has(aName),false,'A is gone before its name is free again');assert.equal(reusesA(),false,'A\'s old name is never reused');
  // The restarted lender itself makes progress: it claims work again. (A claim under a fresh name may come before A is gone.)
  await until(()=>{if(!restartedClaims.length&&a.clock.pending().includes(3000))a.clock.advance(3000);return restartedClaims.length>0;},'the restarted lender claims work after recovery');
  assert.equal(reusesA(),false,'A\'s old name is still not reused by the claim');
  assert.ok(live.has(bName),'B remains live after A resumes claiming');
  assert.ok(!commands.some(cmd=>cmd[0]==='rm'&&cmd.at(-1)===bName));
});

test('six short jobs reduce their standing-rule reservations to actual time', {timeout:120000}, async t => {
  let history=[];
  for(let i=0;i<6;i++) {
    const f=await lenderFixture(t,{hold:true,mutateJob:job=>{job.requirements.limits.wall_seconds=600;}});
    // Seed this fixture's known job identity before the loop loads its state.
    // This isolates completion accounting from automatic rule matching.
    f.policy.maxWallSeconds=600;f.policy.dailyMinutes=60;
    await f.policy.storage.set({day:'2026-10-09',jobs:i,milliseconds:i*60000,pending:null,
      ruleUsage:[...history,{id:'one-hour',attemptId:f.attempt().attempt_id,
        at:f.clock.now(),ms:600000},{id:'other-rule',attemptId:'other-job',at:f.clock.now(),ms:9000}]});
    launch(f);await until(()=>runs(f)===1,'short job starts');
    f.clock.advance(60000);f.execution.resolve();await finish(f);
    history=f.saved().ruleUsage.filter(row=>row.id==='one-hour').map((row,index)=>({...row,attemptId:'completed-'+index}));
    assert.equal(history.length,i+1);
    assert.equal(history.reduce((sum,row)=>sum+row.ms,0),(i+1)*60000);
    assert.equal(f.saved().ruleUsage.find(row=>row.id==='other-rule').ms,9000);
  }
  assert.equal(3600000-history.reduce((sum,row)=>sum+row.ms,0),3240000,
    'six one-minute jobs leave 54 minutes, not zero');
});



test('cleanup proof charges measured time while an unresolved quota hold remains owned', {timeout:15000}, async t=>{
  const f=await lenderFixture(t),attempt=f.attempt();
  const pending={attemptId:attempt.attempt_id,attempt,reservedMs:120000,prepare_contract:'create-only',executionStartRequested:true,
    actualUse:{attemptId:attempt.attempt_id,ms:60000},candidateSettlement:{provider:'claude',model:'claude-haiku-5-5',
      execution:{stdout:''},prepared:true,reason:'restart_interrupted'},
    ...f.backend.sandboxOwnership(),
    cessationVerified:{sbx_home:f.backend.sandboxOwnership().sbx_home,attemptId:attempt.attempt_id,jobDigest:attempt.job_digest,generation:attempt.generation}};
  await f.policy.storage.set({day:'2026-10-09',jobs:1,milliseconds:120000,pending,claimedPending:attempt});
  f.policy.recoveryOnly=true;f.policy.enabled=false;

  launch(f);
  await until(()=>f.saved().pending===null,'durable held outcome is recorded');

  assert.equal(f.saved().jobs,1,'cleanup does not refund a completed job');
  assert.equal(f.saved().milliseconds,60000,'the lender charges the measured run time');
  await f.stop();
});

test('a recovered unstarted rule grant reserves the new job identity and preserves prior positive use', {timeout:60000}, async t=>{
  const f=await lenderFixture(t),attempt=f.attempt(),acceptedAt=f.clock.now();
  const intent={ruleId:'retry-rule',jobDigest:f.jobDigest,acceptedAt,idempotencyKey:'old-grant'};
  const row={id:intent.ruleId,jobDigest:intent.jobDigest,acceptedAt,at:acceptedAt,
    attemptId:attempt.attempt_id,ms:120000};
  await f.policy.storage.set({day:'2026-10-09',jobs:1,milliseconds:120000,ruleUsage:[row],
    acceptedClaim:{intent,claim:{job:f.job,job_digest:f.jobDigest,acceptedHarness:'codex',automatic:true}},pending:{attemptId:attempt.attempt_id,attempt,reservedMs:120000,
      prepare_contract:'create-only',executionStartRequested:false,ruleGrant:intent}});
  f.policy.enabled=false;f.policy.recoveryOnly=true;
  f.backend.reconcilePending=async pending=>({removed:true,attemptId:pending.attemptId});
  launch(f);await until(()=>f.saved().pending===null,'unstarted recovery');await f.stop();
  const recovered=f.saved();
  assert.equal(recovered.ruleUsage[0].ms,0);
  assert.equal(recovered.ruleUsage[0].finished,true);
  const {reserveStandingRuleTime}=await import('../lib/v1/lender.mjs');
  const next=await lenderFixture(t,{hold:true});
  const newId=next.attempt().attempt_id+'-new';
  const reserved=reserveStandingRuleTime(recovered.ruleUsage,recovered.acceptedClaim.intent,newId,120000,next.clock.now());
  assert.equal(reserved.length,1,'one resumed grant, not a second historical job');
  assert.equal(reserved[0].attemptId,newId);
  assert.equal(reserved[0].ms,120000);
  assert.equal(reserved[0].finished,false);
  assert.deepEqual(reserveStandingRuleTime(reserved,intent,newId,120000,next.clock.now()),reserved,
    'replayed acceptance does not reserve twice');
  const spent={...row,attemptId:'completed-positive',ms:60000,finished:true};
  const distinct=reserveStandingRuleTime([spent],intent,newId,120000,next.clock.now());
  assert.equal(distinct.length,2);
  assert.equal(distinct[0].ms,60000,'do not erase prior charged work');
  assert.equal(distinct[1].ms,120000);
});


test('restart refunds only an explicit durable fresh-admission denial after cleanup', {timeout:60000}, async t => {
  for (const denied of [undefined, true]) {
    const f = await lenderFixture(t, {saved:{day:'2026-10-09',jobs:1,milliseconds:120000,
      pending:{attemptId:'not-dispatched',reservedMs:120000,prepare_contract:'create-only',executionStartRequested:true,
        ...(denied === true ? {agentStartDenied:true} : {})}}});
    f.client.claimNext = async () => null;
    let removed = false;
    f.backend.reconcilePending = async pending => ({attemptId:pending.attemptId,removed});
    launch(f);
    await until(() => f.events.some(event => event.reason === 'cleanup_pending'), 'cleanup is still required');
    assert.equal(f.saved().jobs, 1);
    assert.equal(f.saved().milliseconds, 120000);
    removed = true;
    f.clock.advance(1000);
    await until(() => f.saved().pending === null, 'cleanup recorded');
    await f.stop();
    assert.equal(f.saved().jobs, denied === true ? 0 : 1);
    assert.equal(f.saved().milliseconds, denied === true ? 0 : 120000);
  }
});

test('denied dispatch plus Stop refunds once across stop-report failure and restart', {timeout:60000}, async t => {
  for (const remaining of [120000, 0]) {
    const f = await realLenderFixture(t, {members:true});
    const {attempt} = await fencedLaunch(f);
    const key = requesterCounterKey(f.job.payload.circle, f.job.payload.author);
    await f.policy.storage.set({day:'2026-10-09',jobs:3,milliseconds:500000+remaining,
      requesters:{[key]:{jobs:3,milliseconds:500000+remaining}},
      pending:{attemptId:attempt.attempt_id,attempt,reservedMs:remaining,prepare_contract:'create-only',
        requester:{circle:f.job.payload.circle,keyId:f.job.payload.author},
        executionStartRequested:true,agentStartDenied:true,stopReason:'stopped_by_lender',
        stopReleaseKey:'denied-stop-release',stopReportKey:'denied-stop-report'}});
    let removed = false, reportFails = true;
    f.backend.reconcilePending = async pending => ({attemptId:pending.attemptId,removed});
    const stopped = f.client.stopped.bind(f.client);
    f.client.stopped = (...args) => reportFails
      ? Promise.reject(Object.assign(new Error('offline'), {code:'network_error'})) : stopped(...args);
    f.client.claimNext = async () => null;
    launch(f);
    await until(() => f.events.some(event => event.reason === 'cleanup_pending'), 'cleanup required');
    assert.equal(f.saved().jobs, 3);
    removed = true; f.clock.advance(1000);
    await until(() => f.events.some(event => event.reason === 'cleanup_pending') && f.saved().pending?.agentStartDeniedRefunded === true, 'report remains pending after the refund');
    await f.stop();
    assert.equal(f.saved().jobs, 2);
    assert.equal(f.saved().milliseconds, 500000);
    assert.deepEqual(f.saved().requesters[key], {jobs:2,milliseconds:500000});
    assert.equal(f.saved().pending.agentStartDeniedRefunded, true);
    reportFails = false;
    launch(f);
    await until(() => f.saved().pending === null, 'restart completes stop report');
    await f.stop();
    assert.equal(f.saved().jobs, 2, 'restart must not refund the job twice');
    assert.equal(f.saved().milliseconds, 500000);
    assert.deepEqual(f.saved().requesters[key], {jobs:2,milliseconds:500000});
  }
});



// Money review of 2a2b2dc2, P2a: a Stop while the final admission is pending must still record that no agent ran.


// Money review of 2a2b2dc2, P2b: a denied start must not use up a standing rule.


for (const ran of [false, undefined]) test('a standing-rule row counts only when its agent ran: ran='+ran, {timeout:60000}, async t => {
  const f = await lenderFixture(t, {harness:'claude-code-subscription', policy:{mode:'auto'}});
  f.policy.standingRules = f.policy.standingRules.map(rule => ({...rule, dailyJobs:1}));
  const id = f.policy.standingRules[0].id;
  await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,
    ruleUsage:[{id,attemptId:'earlier',at:f.clock.now(),ms:0,finished:true,...(ran === false ? {ran:false} : {})}]});
  let asked = 0;
  launch(f, {approve:async () => { asked++; return false; }});
  if (ran === false) await until(() => runs(f) === 1, 'the rule still admits one job');
  else await until(() => asked > 0, 'a used rule falls back to asking');
  await f.stop();
  assert.equal(runs(f), ran === false ? 1 : 0);
});

// Money review of dd65446d, P2: one failed write of the denial marker must not turn a job that never ran into a charged run.


for (const stamped of [false, true]) for (const denied of [false, true, 'measured-zero']) for (const stopped of [false, true])
  test(`recovery preserves local charges without prepare provenance: stamp=${stamped}, denied=${denied}, stopped=${stopped}`, {timeout:60000}, async t => {
    const f = await lenderFixture(t), attempt = f.attempt();
    const key = requesterCounterKey(f.job.payload.circle, f.job.payload.author);
    const intent = {ruleId:'recovery-rule',jobDigest:f.jobDigest,acceptedAt:f.clock.now()};
    const row = {id:intent.ruleId,jobDigest:f.jobDigest,acceptedAt:intent.acceptedAt,
      attemptId:attempt.attempt_id,ms:120000};
    await f.policy.storage.set({day:'2026-10-09',jobs:3,milliseconds:620000,
      requesters:{[key]:{jobs:3,milliseconds:620000}},ruleUsage:[row],
      pending:{attemptId:attempt.attempt_id,attempt,reservedMs:120000,ruleGrant:intent,
        requester:{circle:f.job.payload.circle,keyId:f.job.payload.author},
        executionStartRequested:denied!==false,actualUse:{attemptId:attempt.attempt_id,ms:0},
        ...(denied===true?{agentStartDenied:true}:{}),...(stamped?{prepare_contract:'create-only'}:{}),
        ...(stopped?{stopReason:'stopped_by_lender',stopReleaseKey:'recovery-release',stopReportKey:'recovery-report'}:{})}});
    f.policy.enabled=false;f.policy.recoveryOnly=true;
    f.client.claimNext=async()=>null;
    f.backend.reconcilePending=async pending=>({attemptId:pending.attemptId,removed:true});
    launch(f);await until(()=>f.saved().pending===null,'recovery completes');await f.stop();
    const jobs=stamped&&denied!=='measured-zero'?2:3;
    assert.deepEqual({jobs:f.saved().jobs,milliseconds:f.saved().milliseconds,
      requester:f.saved().requesters[key],ruleMs:f.saved().ruleUsage[0].ms,ran:f.saved().ruleUsage[0].ran},
      {jobs,milliseconds:stamped?500000:620000,requester:{jobs,milliseconds:stamped?500000:620000},
        ruleMs:stamped?0:120000,ran:stamped&&denied!=='measured-zero'?false:undefined});
  });

for (const stamped of [false,true]) test(`ledger compatibility retains unstamped quota charges: stamp=${stamped}`, {timeout:60000}, async t=>{
  const f=await lenderFixture(t),attempt=f.attempt();
  const ledger=createLendingLedger({file:join(f.root,'compatibility-ledger.json'),now:f.clock.now});
  ledger.recordReadings('claude',[{window_id:'seven_day',window_minutes:10080,used_pct:10,
    resets_at:f.clock.now()+86400000,observed_at:f.clock.now(),state:'open',source:'probe'}]);
  assert.equal(ledger.reserve({account:'claude',job_digest:f.jobDigest,attempt_id:attempt.attempt_id,
    budget_units:20,unit:'claude_usd',plan:'max20'}).ok,true);
  const outcome=ledger.reconcileAttempt(attempt.attempt_id,{started:stamped?false:undefined});
  assert.equal(outcome.released===true,stamped);
  assert.equal(outcome.entries.length,stamped?0:1);
  if(!stamped)assert.equal(outcome.entries[0].lent_pts,1,'the legacy ledger charges the full reservation');
});


for(const source of ['backend','adapters'])test('discovery '+source+' fault waits and retries without restarting',async t=>{
  const f=await lenderFixture(t);let fault=true;
  if(source==='backend'){
    const original=f.backend.lenderCapabilities.bind(f.backend);
    f.backend.lenderCapabilities=async(...args)=>{
      if(fault)throw Object.assign(new Error('synthetic unavailable'),{code:'network_error'});
      return original(...args);
    };
  }else{
    const records=f.adapters;
    f.adapters=async()=>{if(fault)throw new Error('synthetic provider read');return records;};
  }
  const lender=launch(f);t.after(()=>f.stop());
  await until(()=>f.events.some(e=>e.reason==='sandbox_check_pending'),'discovery wait');
  assert.notEqual(lender.admits(f.job.payload),'lender_stopped');
  assert.equal(f.count('/jobs/claim-next'),0);assert.equal(runs(f),0);
  await until(()=>f.clock.pending().includes(1000),'retry tick');
  fault=false;f.clock.advance(1000);
  await finish(f);assert.equal(runs(f),1);
});

for(const stage of ['rollover','claim'])test('counter write '+stage+' fault waits before claim and recovers',async t=>{
  const f=await lenderFixture(t,{saved:stage==='rollover'
    ?{day:'2026-10-08',jobs:2,milliseconds:5000,pending:null}
    :{day:'2026-10-09',jobs:0,milliseconds:0,pending:null}});
  const original=f.policy.storage.set.bind(f.policy.storage);let fault=true;
  f.policy.storage.set=async next=>{
    if(fault&&(stage==='rollover'?next.day==='2026-10-09':Boolean(next.claimPending)))
      throw Object.assign(new Error('synthetic full disk'),{code:'ENOSPC'});
    return original(next);
  };
  const lender=launch(f);t.after(()=>f.stop());
  await until(()=>f.events.some(e=>e.reason==='sandbox_cannot_start'),'counter write wait');
  assert.notEqual(lender.admits(f.job.payload),'lender_stopped');
  assert.equal(f.count('/jobs/claim-next'),0);assert.equal(runs(f),0);
  if(stage==='rollover'){assert.equal(f.saved().jobs,2);assert.equal(f.saved().day,'2026-10-08');}
  else assert.equal(Boolean(f.saved().claimPending),false);
  await until(()=>f.clock.pending().includes(1000),'storage retry tick');
  fault=false;f.clock.advance(1000);
  await finish(f);assert.equal(runs(f),1);
});

for(const faultKind of ['read','corrupt'])test('invalid counter store '+faultKind+' holds without fresh counters then recovers',async t=>{
  const valid={day:'2026-10-09',jobs:2,milliseconds:5000,pending:null};
  const corrupt={...valid,requesters:[]};
  const f=await lenderFixture(t,{saved:faultKind==='corrupt'?corrupt:valid,
    policy:{dailyJobs:10,dailyMinutes:60}});
  const original=f.policy.storage.get.bind(f.policy.storage);let fault=true;
  f.policy.storage.get=async()=>{
    if(fault&&faultKind==='read')throw new Error('synthetic store offline');
    return original();
  };
  const lender=launch(f);t.after(()=>f.stop());
  await until(()=>f.events.some(e=>e.reason==='local_state_unreadable'),'invalid counters wait');
  for(let tick=0;tick<2;tick++){
    assert.equal(lender.getState().counters,null,'invalid state never becomes a fresh budget');
    assert.notEqual(lender.admits(f.job.payload),'lender_stopped');
    assert.deepEqual(f.saved(),faultKind==='corrupt'?corrupt:valid);
    assert.equal(f.count('/jobs/claim-next'),0);assert.equal(runs(f),0);
    await until(()=>f.clock.pending().includes(1000),'invalid counter retry');
    f.clock.advance(1000);
  }
  await until(()=>f.clock.pending().includes(1000),'final invalid counter wait');
  fault=false;
  if(faultKind==='corrupt')await f.policy.storage.set(valid); // External repair retains usage.
  f.clock.advance(1000);
  await finish(f);assert.equal(runs(f),1);
  assert.equal(f.saved().jobs,3,'prior usage was not reset');
});

for(const day of ['',null,17,{},'xx','2026-2-09','2026-02-30','2025-02-29','2026-13-01','2026-00-01','2026-10-00','2026-10-09T00:00:00Z']) {
  test('malformed counter day holds unchanged and day-only repair resumes: '+JSON.stringify(day),async t=>{
    const f=await lenderFixture(t);
    const key=requesterCounterKey(f.job.payload.circle,f.job.payload.author);
    const prior={day,jobs:7,milliseconds:90000,pending:null,
      requesters:{[key]:{jobs:3,milliseconds:40000}}};
    await f.policy.storage.set(prior);const writes=f.saves.length;
    f.backend.lenderCapabilities=async()=>({available:false});
    const lender=launch(f);
    for(let tick=0;tick<3;tick++){
      await until(()=>f.clock.pending().includes(1000),'invalid day retry');
      assert.ok(f.events.some(e=>e.reason==='local_state_unreadable'));
      assert.equal(lender.getState().counters,null);
      assert.deepEqual(f.saved(),prior);assert.equal(f.saves.length,writes);
      assert.equal(f.count('/jobs/claim-next'),0);assert.equal(runs(f),0);
      assert.equal(f.calls.some(([kind])=>kind==='prepare'),false);
      if(tick<2)f.clock.advance(1000);
    }
    const repaired={...prior,day:'2026-10-09'};
    await f.policy.storage.set(repaired);f.clock.advance(1000);
    await until(()=>f.events.some(e=>e.reason==='sandbox_check_pending'),'day-only repair admitted to discovery');
    await f.stop();
    assert.deepEqual(f.saved(),repaired);assert.deepEqual(lender.getState().counters,repaired);
    assert.equal(f.saves.length,writes+1,'only external repair wrote');
  });
}

for(const owned of [
  {jobs:7,milliseconds:90000,pending:null},
  {jobs:0,milliseconds:0,pending:null,claimPending:{state:'unknown-future',opaque:'retain'}},
  {jobs:0,milliseconds:0,pending:{attemptId:'owned'},acceptedClaim:{opaque:'retain'}},
  {jobs:0,milliseconds:0,pending:null,observationPending:[{idempotencyKey:'owned'}]},
])for(const malformed of [false,true])test('unidentified owned counter window is retained: '+JSON.stringify(owned)+' malformed='+malformed,async t=>{
  const prior={...owned,...(malformed?{day:'xx'}:{})};
  const f=await lenderFixture(t,{saved:prior});const lender=launch(f);
  for(let tick=0;tick<3;tick++){
    await until(()=>f.clock.pending().includes(1000),'owned invalid-day hold');
    assert.ok(f.events.some(e=>e.reason==='local_state_unreadable'));
    assert.equal(lender.getState().counters,null);assert.deepEqual(f.saved(),prior);
    assert.equal(f.saves.length,0);assert.equal(f.count('/jobs/claim-next'),0);assert.equal(runs(f),0);
    assert.equal(f.calls.some(([kind])=>kind==='prepare'),false);
    if(tick<2)f.clock.advance(1000);
  }
  await f.stop();
});

for(const day of ['2026-10-09','2026-10-08','2024-02-29'])test('valid calendar counter window retains current usage or rolls prior day: '+day,async t=>{
  const f=await lenderFixture(t);const key=requesterCounterKey(f.job.payload.circle,f.job.payload.author);
  const prior={day,jobs:7,milliseconds:90000,pending:null,requesters:{[key]:{jobs:3,milliseconds:40000}}};
  await f.policy.storage.set(prior);const writes=f.saves.length;
  f.backend.lenderCapabilities=async()=>({available:false});
  const lender=launch(f);await until(()=>f.events.some(e=>e.reason==='sandbox_check_pending'),'valid day discovery');await f.stop();
  const expected=day==='2026-10-09'?prior:{...prior,day:'2026-10-09',jobs:0,milliseconds:0,requesters:{},lastRequesterLimit:null};
  assert.deepEqual(f.saved(),expected);assert.deepEqual(lender.getState().counters,expected);
  assert.equal(f.saves.length,writes+(day==='2026-10-09'?0:1));
});

test('null counter store remains a fresh current-day budget',async t=>{
  const f=await lenderFixture(t,{saved:null});f.backend.lenderCapabilities=async()=>({available:false});
  const lender=launch(f);await until(()=>f.events.some(e=>e.reason==='sandbox_check_pending'),'fresh discovery');await f.stop();
  assert.deepEqual(lender.getState().counters,{day:'2026-10-09',jobs:0,milliseconds:0,pending:null});
  assert.equal(f.saves.length,0);
});

test('actual pool dayless shared-only child seed gains day without losing shared lists',async t=>{
  const {createLendingPool}=await import('../lib/v1/lending-pool.mjs');
  const f=await lenderFixture(t), children=[];
  const shared={hiddenOffers:[{jobDigest:'sha256:'+'a'.repeat(64),expiresAt:f.clock.now()+60000}],
    ruleUsage:[{id:'other-rule',attemptId:'other-attempt',at:f.clock.now(),ms:5000,finished:true}]};
  let disk={jobs:0,milliseconds:0,pending:null,accounts:{},...structuredClone(shared)};
  const storage={get:async()=>structuredClone(disk),set:async next=>{disk=structuredClone(next);}};
  const pool=createLendingPool({storage,clock:f.clock,policy:{dailyJobs:10,dailyMinutes:60,timeZone:'UTC'},
    adapters:f.adapters,createLender:options=>{children.push(options);return {start:async()=>{},getState:()=>({})};}});
  await pool.start();assert.equal(children.length,1);
  const childStore=children[0].policy.storage;
  assert.deepEqual(await childStore.get(),{jobs:0,milliseconds:0,pending:null,...shared,jobConsents:[]});
  f.policy.storage=childStore;f.backend.lenderCapabilities=async()=>({available:false});
  const lender=launch(f);await until(()=>f.events.some(e=>e.reason==='sandbox_check_pending'),'fresh pool child discovery');await f.stop();
  assert.deepEqual(await childStore.get(),{day:'2026-10-09',jobs:0,milliseconds:0,pending:null,...shared,jobConsents:[]});
  assert.deepEqual(disk.hiddenOffers,shared.hiddenOffers);assert.deepEqual(disk.ruleUsage,shared.ruleUsage);
  assert.deepEqual(lender.getState().counters,{day:'2026-10-09',jobs:0,milliseconds:0,pending:null,...shared,jobConsents:[]});
  assert.equal(f.count('/jobs/claim-next'),0);assert.equal(runs(f),0);
});

for(const recovery of ['day-only repair','wall catches up','legacy journal'])test('future counters hold before writes: '+recovery,async t=>{
  const f=await lenderFixture(t,{policy:{timeZone:'UTC'}});
  const key=requesterCounterKey(f.job.payload.circle,f.job.payload.author);
  const prior={day:'2026-10-10',jobs:7,milliseconds:90000,pending:null,
    requesters:{[key]:{jobs:3,milliseconds:40000}},
    ...(recovery==='legacy journal'?{claimPending:{idempotencyKey:'retain-legacy'}}:{})};
  await f.policy.storage.set(prior);const writes=f.saves.length, bytes=JSON.stringify(f.saved());
  const timerNow=f.clock.now;let offset=0, discoveries=0, reconciliations=0;
  f.backend.reconcileOwnedSandboxes=async()=>{reconciliations++;return {removed:true};};
  f.clock.now=()=>timerNow()+offset;
  f.backend.lenderCapabilities=async()=>{discoveries++;return {available:false};};
  let lender=launch(f);
  await until(()=>f.clock.pending().includes(1000),'initial future-day hold');
  for(let tick=0;tick<3;tick++){
    const waits=f.events.filter(e=>e.reason==='local_state_unreadable').length;
    f.clock.advance(1000);
    await until(()=>f.events.filter(e=>e.reason==='local_state_unreadable').length>waits&&
      f.clock.pending().includes(1000),'future-day retry '+tick);
    assert.deepEqual(lender.getState().counters,prior);
    assert.equal(reconciliations,1);
    assert.equal(lender.admits(f.job.payload),'invalid_counter_store');
    assert.equal(JSON.stringify(f.saved()),bytes);assert.equal(f.saves.length,writes);
    assert.equal(discoveries,0);assert.equal(f.count('/jobs/claim-next'),0);
    assert.equal(runs(f),0);assert.equal(f.calls.some(([kind])=>kind==='prepare'),false);
  }
  if(recovery==='legacy journal'){await f.stop();return;}
  const expected=recovery==='day-only repair'?{...prior,day:'2026-10-09'}:prior;
  if(recovery==='day-only repair') {
    await f.policy.storage.set(expected);
    f.clock.advance(1000);
    await until(()=>f.clock.pending().includes(1000),'cached future counters remain held until restart');
    assert.equal(discoveries,0);assert.deepEqual(lender.getState().counters,prior);
    await f.stop();lender=launch(f);
  }
  else offset=86400000; // Change wall time only; do not drain a day of scheduled timers.
  f.clock.advance(1000);
  await until(()=>discoveries>0,'future-day hold resumes discovery');
  await f.stop();
  assert.deepEqual(f.saved(),expected);assert.deepEqual(lender.getState().counters,expected);
  assert.equal(f.saves.length,writes+(recovery==='day-only repair'?1:0));
  assert.equal(f.count('/jobs/claim-next'),0);assert.equal(runs(f),0);
});

test('cached current counters hold unchanged after backwards wall correction',async t=>{
  const f=await lenderFixture(t,{policy:{timeZone:'UTC'}});
  const key=requesterCounterKey(f.job.payload.circle,f.job.payload.author);
  const prior={day:'2026-10-09',jobs:7,milliseconds:90000,pending:null,
    requesters:{[key]:{jobs:3,milliseconds:40000}}};
  await f.policy.storage.set(prior);const writes=f.saves.length,bytes=JSON.stringify(f.saved());
  const timerNow=f.clock.now;let offset=0,discoveries=0;
  f.clock.now=()=>timerNow()+offset;
  f.backend.lenderCapabilities=async()=>{discoveries++;return {available:false};};
  const lender=launch(f);
  await until(()=>discoveries>0&&f.clock.pending().includes(1000),'current budget loaded');
  assert.deepEqual(lender.getState().counters,prior);
  const before=discoveries;offset=-86400000;
  for(let tick=0;tick<3;tick++){
    const waits=f.events.filter(e=>e.reason==='local_state_unreadable').length;
    f.clock.advance(1000);
    await until(()=>f.events.filter(e=>e.reason==='local_state_unreadable').length>waits&&
      f.clock.pending().includes(1000),'cached future-day retry '+tick);
    assert.deepEqual(lender.getState().counters,prior);
    assert.equal(JSON.stringify(f.saved()),bytes);assert.equal(f.saves.length,writes);
    assert.equal(discoveries,before);assert.equal(f.count('/jobs/claim-next'),0);
    assert.equal(runs(f),0);assert.equal(f.calls.some(([kind])=>kind==='prepare'),false);
  }
  offset=0;f.clock.advance(1000);
  await until(()=>discoveries>before,'cached budget resumes when wall catches up');
  await f.stop();
  assert.deepEqual(f.saved(),prior);assert.deepEqual(lender.getState().counters,prior);
  assert.equal(f.saves.length,writes);
});

for(const phase of ['OUTPUT','RESULT'])test('future-day '+phase+' recovery uses authentic journals before fresh admission',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{hold:true,policy:{timeZone:'UTC'}});
  const mediaByDigest=new Map();
  let interceptComplete=true,correctMedia=false;
  f.override=({route,req,res})=>{
    if(route.startsWith('/artifacts/')) {
      const digest='sha256:'+route.split('/')[2];
      if(req.method==='PUT')mediaByDigest.set(digest,req.headers['faravan-media-type']);
      if(req.method==='GET'&&mediaByDigest.has(digest)&&f.artifacts.has(digest)) {
        const bytes=f.artifacts.get(digest);
        res.writeHead(200,{'content-type':'application/octet-stream','content-length':bytes.length,
          ...(correctMedia?{'faravan-media-type':mediaByDigest.get(digest)}:{})});
        res.end(bytes);return true;
      }
    }
    if(route==='/jobs/'+f.jobDigest.slice('sha256:'.length)) {
      f.json(res,{job_digest:f.jobDigest,job:f.job,state:'claimed',attempts_started:1,
        current_attempt:f.attempt(),result_digest:null});
      return true;
    }
    if(route.endsWith('/complete')&&interceptComplete){req.socket.destroy();return true;}
    return false;
  };
  const requester=requesterCounterKey(f.job.payload.circle,f.job.payload.author);
  const hidden={jobDigest:'sha256:'+'b'.repeat(64),expiresAt:f.clock.now()+86400000};
  const exclusion={jobDigest:'sha256:'+'c'.repeat(64),expiresAt:f.clock.now()+86400000};
  await f.policy.storage.set({day:'2026-10-09',jobs:2,milliseconds:30000,pending:null,
    requesters:{[requester]:{jobs:2,milliseconds:30000}},hiddenOffers:[hidden],declined:[exclusion]});
  launch(f);
  await until(()=>f.events.some(event=>event.status==='running'),'initial authentic '+phase+' execution');
  f.clock.advance(6000);f.execution.resolve();
  await until(()=>f.events.some(event=>event.reason==='circle_unreachable'),'initial signed completion interception');
  await f.stop();
  const originalResult=structuredClone(f.saved().resultPending);
  assert.ok(originalResult?.payload);
  const snapshot=structuredClone(phase==='RESULT'
    ? f.saves.find(value=>value.resultPending&&value.pending)
    : f.saves.findLast(value=>value.outputPending&&value.pending&&!value.resultPending));
  assert.ok(snapshot?.outputPending&&snapshot.pending,'authentic '+phase+' journal exists');
  assert.equal(snapshot.pending.actualUse.ms,6000);
  assert.ok(mediaByDigest.size>=2,'actual lifecycle PUTs retained artifact media types');
  assert.equal(runs(f),1);
  await f.policy.storage.set(snapshot);
  const before=structuredClone(snapshot);
  const claims=f.count('/jobs/claim-next'),prepares=f.calls.filter(([kind])=>kind==='prepare').length;
  const completes=f.count('/complete'),starts=f.count('/start'),eventStart=f.events.length;
  const stages=[];
  let cleanupAllowed=phase==='RESULT',reconciliations=0,discoveries=0,finishes=0;
  f.backend.reconcileOwnedSandboxes=async()=>{reconciliations++;stages.push('owned');return {removed:true};};
  const destroy=f.backend.destroy.bind(f.backend);
  f.backend.reconcilePending=async pending=>{
    assert.equal(pending.attemptId,snapshot.pending.attemptId);
    stages.push('cleanup');
    if(!cleanupAllowed)return {removed:false,attemptId:pending.attemptId};
    const actual=await destroy({sandbox_id:pending.sandbox_id,sbx_home:pending.sbx_home});
    return {...actual,attemptId:pending.attemptId,sbx_home:pending.sbx_home};
  };
  const candidate=f.policy.lendingRuntime.candidate,finishCandidate=candidate.finish.bind(candidate);

  f.backend.lenderCapabilities=async()=>{discoveries++;return {available:false};};
  const proofNow=f.clock.now;let wallOffset=-86400000;
  // HTTP proofs stay on the fixture's original clock; only lender wall time moves.
  const recoveryClock={...f.clock,now:()=>proofNow()+wallOffset,monotonic:proofNow};
  interceptComplete=false;
  const lender=launch(f,{clock:recoveryClock});
  const noFresh=()=>{
    assert.equal(reconciliations,1);assert.equal(discoveries,0);
    assert.equal(f.count('/jobs/claim-next'),claims);assert.equal(f.count('/start'),starts);
    assert.equal(f.calls.filter(([kind])=>kind==='prepare').length,prepares);
    assert.equal(runs(f),1);assert.equal(lender.admits(f.job.payload),'invalid_counter_store');
    assert.deepEqual(f.saved().hiddenOffers,before.hiddenOffers);
    assert.deepEqual(f.saved().declined,before.declined);
    assert.equal(f.saved().day,before.day);
  };
  const observe=(predicate,label,allowed=[])=>until(()=>{
    assert.deepEqual(f.errors,[],label+' fixture errors');
    const unexpected=f.events.slice(eventStart).find(event=>event.reason&&
      !['local_state_unreadable','cleanup_pending',...allowed.map(code=>lendingReasonCode(code))].includes(event.reason));
    assert.equal(unexpected,undefined,label+': '+JSON.stringify(unexpected));
    return predicate();
  },label);
  if(phase==='OUTPUT') {
    await observe(()=>stages.includes('cleanup')&&f.clock.pending().includes(1000),'unknown cessation blocks output');
    assert.deepEqual(f.saved().pending,before.pending);
    assert.deepEqual(f.saved().outputPending,before.outputPending);
    assert.equal(f.saved().jobs,before.jobs);assert.equal(f.saved().milliseconds,before.milliseconds);
    assert.deepEqual(f.saved().requesters,before.requesters);
    assert.equal(f.count('/complete'),completes);noFresh();
    cleanupAllowed=true;f.clock.advance(1000);
    await observe(()=>f.events.slice(eventStart).some(event=>event.reason==='execution_failed')&&
      f.clock.pending().includes(1000),'missing cached-artifact media header',['artifact_mismatch']);
    assert.equal(f.saved().pending,null,'actual owned synthetic destroy proved cessation');
    assert.deepEqual(f.saved().outputPending,before.outputPending);
    assert.equal(f.saved().resultPending,undefined);
    assert.equal(f.count('/complete'),completes);
    const charged=structuredClone({jobs:f.saved().jobs,milliseconds:f.saved().milliseconds,requesters:f.saved().requesters});
    assert.equal(charged.jobs,before.jobs);
    assert.equal(charged.milliseconds,before.milliseconds-(before.pending.reservedMs-6000));
    noFresh();
    // Repair only the missing metadata; retain actual bytes and every real client validator.
    correctMedia=true;
    const expectedStart=f.events.length;
    f.clock.advance(1000);
    await until(()=>{
      assert.deepEqual(f.errors,[]);
      const bad=f.events.slice(expectedStart).find(event=>event.reason&&event.reason!=='invalid_counter_store');
      assert.equal(bad,undefined,'header-only repair unexpected phase: '+JSON.stringify(bad));
      return f.events.slice(expectedStart).some(event=>event.label?.startsWith('Finished.'));
    },'header-only repair completes signed OUTPUT recovery');
    assert.deepEqual({jobs:f.saved().jobs,milliseconds:f.saved().milliseconds,requesters:f.saved().requesters},charged);

  } else {
    await observe(()=>f.events.slice(eventStart).some(event=>event.label?.startsWith('Finished.')),
      'future RESULT exact replay');
    const replay=f.requests.filter(request=>request.route.endsWith('/complete')).at(-1);
    assert.equal(replay.req.headers['idempotency-key'],originalResult.idempotencyKey);
    assert.deepEqual(replay.body.payload,originalResult.payload);
    assert.equal(f.saved().jobs,before.jobs);
    assert.equal(f.saved().milliseconds,before.milliseconds-(before.pending.reservedMs-6000));
  }
  await until(()=>f.events.slice(eventStart).some(event=>event.reason==='local_state_unreadable')&&
    f.clock.pending().includes(1000),'delivery finished but future admission stays held');
  noFresh();
  assert.equal(f.count('/complete'),completes+1,'exactly one recovered signed completion');
  assert.equal(f.saved().outputPending,null);assert.equal(f.saved().resultPending,null);
  assert.ok(f.result,'fixture verified the signed result and returned its real completion ACK');
  assert.deepEqual(f.result.payload.candidate,originalResult.payload.candidate);
  assert.deepEqual(f.result.payload.transcript,originalResult.payload.transcript);
  for(const ref of [originalResult.payload.candidate,originalResult.payload.transcript]) {
    const retained=f.artifacts.get(ref.digest);
    assert.ok(retained instanceof Uint8Array);
    assert.equal(p.digestBytes(retained),ref.digest);assert.equal(retained.length,ref.bytes);
    assert.equal(mediaByDigest.get(ref.digest),ref.media_type);
  }
  assert.equal(stages[0],'owned');
  wallOffset=0;f.clock.advance(1000);
  await until(()=>discoveries>0,'wall catch-up resumes discovery without draining a day of timers');
  await f.stop();
  assert.equal(runs(f),1);assert.equal(f.count('/jobs/claim-next'),claims);
  assert.equal(f.saved().day,before.day);
});
