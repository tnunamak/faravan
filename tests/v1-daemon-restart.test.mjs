import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api,syntheticBackend} from './helpers/v1-app-fixture.mjs';
import {workspaceFailure} from '../lib/docker-backend.mjs';

test('shared daemon restart is an explicit confirmed app action, followed by readiness', {timeout:60000}, async t=>{
  const f=await appFixture(t),backend=syntheticBackend(f.root);let restarted=false,calls=[];
  const base=backend.protectionSummary.bind(backend);
  backend.protectionSummary=async(...args)=>{const report=await base(...args);report.preflight.checks=report.preflight.checks.filter(c=>c.name!=='sbx_daemon');report.preflight.checks.push({name:'sbx_daemon',ok:restarted,cause:'daemon_restart_required',automatic:false,detail:'Docker Sandboxes needs to restart.',fix:'Restart Docker Sandboxes'});return report;};
  backend.recoverHealth=async options=>{calls.push(options);if(options?.confirmedRestart)restarted=true;return {recovered:restarted};};
  const {app}=await f.start('owner',{backend});
  await api(app,'/api/readiness?refresh=true');
  assert.equal(calls.length,0,'a shared restart must not run on a readiness GET');
  await api(app,'/api/setup/restart-sandbox',{method:'POST',body:{},status:400});
  assert.equal(calls.length,0);
  const result=await api(app,'/api/setup/restart-sandbox',{method:'POST',body:{confirmed:true}});
  assert.equal(calls.length,1);
  assert.equal(calls[0].confirmedRestart,true);
  assert.equal(result.checks.find(c=>c.name==='sbx_daemon').ok,true);
});

test('an explicit readiness check reports the test workspace refusal without raw diagnostics',{timeout:60000},async t=>{
  const f=await appFixture(t),backend=syntheticBackend(f.root);
  const base=backend.protectionSummary.bind(backend);
  backend.protectionSummary=async(...args)=>{
    const report=await base(...args);
    report.preflight.checks=report.preflight.checks.filter(check=>check.name!=='docker_login');
    report.preflight.checks.push({name:'docker_login',ok:true,signinVerified:false});
    return report;
  };
  const failure=workspaceFailure({code:'wall_timeout',message:'private workspace diagnostic'});
  backend.confirmSignIn=async()=>failure;
  const {app}=await f.start('owner',{backend});
  await api(app,'/api/readiness?refresh=true');
  const report=await api(app,'/api/readiness?refresh=true');
  assert.deepEqual(report.workspaceCheck,{ok:false,label:failure.detail,remedy:'Choose Check again.'});
  assert.doesNotMatch(JSON.stringify(report),/private workspace diagnostic/);
  const passive=await api(app,'/api/readiness');
  assert.equal(passive.workspaceCheck,undefined);
});

test('a Docker sign-in writer counts as busy for both recovery paths',{timeout:60000},async t=>{
  const f=await appFixture(t),backend=syntheticBackend(f.root);let needed=false,finish;const busy=[];
  const base=backend.protectionSummary.bind(backend);
  backend.protectionSummary=async(...args)=>{
    const report=await base(...args);
    if(needed){report.preflight.checks=report.preflight.checks.filter(c=>c.name!=='sbx_daemon');report.preflight.checks.push({name:'sbx_daemon',ok:false,cause:'daemon_restart_required',automatic:true,detail:'Update needs a restart.'});}
    return report;
  };
  const hold=sandboxServiceUnavailableHold(sbxUpdateOutput,{rowCount:3});
  backend.deadlineRecoveryHold=()=>needed?hold:null;
  backend.ensureSandboxAdmission=async()=>{if(needed)throw deadlineRecoveryError(hold);};
  backend.recoverHealth=async options=>{busy.push(options.jobRunning());return {recovered:false,preflight:{checks:[{name:'sbx_daemon',ok:false,cause:'daemon_restart_required',automatic:true,detail:'Faravan restarts Docker Sandboxes when the current job finishes.'}]}};};
  const handle={url:'https://login.example.test/device',code:'ABCD-1234',waitForCompletion:()=>new Promise(resolve=>{finish=resolve;}),cancel(){finish?.({status:'failed'});}};
  const {app}=await f.start('owner',{backend,signin:{startDocker:async()=>handle}});
  const signin=await api(app,'/api/signin/docker',{method:'POST',body:{}});needed=true;
  await api(app,'/api/readiness?refresh=true');
  assert.equal(busy.at(-1),true);
  const waiting=await api(app,'/api/readiness');
  assert.match(waiting.checks.find(c=>c.name==='sbx_daemon').label,/current job finishes/);
  assert.equal(waiting.checks.find(c=>c.name==='sbx_daemon').remedy,'');
  await api(app,'/api/setup/restart-sandbox',{method:'POST',body:{confirmed:true}});
  assert.ok(busy.every(value=>value===true));
  await api(app,'/api/signin/'+signin.flowId+'/cancel',{method:'POST',body:{}});
});

test('the plain-init route grants initialization consent without reset consent',{timeout:60000},async t=>{
  const f=await appFixture(t),backend=syntheticBackend(f.root),calls=[];
  backend.recoverHealth=async options=>{calls.push(options);return {recovered:false};};
  const {app}=await f.start('owner',{backend});
  await api(app,'/api/setup/initialize-policy',{method:'POST',body:{},status:400});
  await api(app,'/api/setup/initialize-policy',{method:'POST',body:{confirmed:true}});
  assert.equal(calls.at(-1).confirmedInit,true);
  assert.equal(calls.at(-1).confirmedPolicy,undefined);
});

import {sandboxServiceUnavailableHold,deadlineRecoveryError} from '../lib/sandbox-remediation.mjs';
import {sbxUpdateOutput} from './helpers/sbx-update-output.mjs';

for(const automatic of [true,false])test(`update listing hold permits readiness recovery (automatic=${automatic})`,{timeout:60000},async t=>{
  const f=await appFixture(t),backend=syntheticBackend(f.root);
  let restarted=false,calls=0,admissions=0;
  const hold=sandboxServiceUnavailableHold(sbxUpdateOutput,{rowCount:3});
  backend.deadlineRecoveryHold=()=>restarted?null:hold;
  backend.ensureSandboxAdmission=async()=>{admissions++;if(!restarted)throw deadlineRecoveryError(hold);};
  backend.recoverSandboxDeadlines=async()=>{if(!restarted)throw deadlineRecoveryError(hold);return true;};
  const base=backend.protectionSummary.bind(backend);
  backend.protectionSummary=async(...args)=>{
    const report=await base(...args);
    if(!restarted)report.preflight.checks=[{name:'sbx_daemon',ok:false,cause:'daemon_restart_required',automatic,detail:'Docker Sandboxes needs to restart to finish its update.',fix:automatic?'':'Restart Docker Sandboxes'}];
    return report;
  };
  backend.recoverHealth=async()=>{calls++;restarted=true;return {recovered:true,restarted:true};};
  const {app}=await f.start('update-listing-hold',{backend,cleanupRecheckMs:60000});
  const report=await api(app,'/api/readiness?refresh=true');
  assert.doesNotMatch(JSON.stringify(report),/Open Docker Desktop/);
  if(automatic){assert.equal(report.ready,true);assert.ok(calls>0);assert.ok(admissions>=2,'listing admission must be rechecked after restart');}
  else {assert.equal(calls,0);assert.equal(report.checks.find(c=>c.name==='sbx_daemon').cause,'daemon_restart_required');
    const cached=await api(app,'/api/readiness');assert.equal(cached.checks.find(c=>c.name==='sbx_daemon').automatic,false);}
});

test('a restart cannot clear cleanup debt when the fresh listing still fails',{timeout:60000},async t=>{
  const f=await appFixture(t),backend=syntheticBackend(f.root);
  const update=sandboxServiceUnavailableHold(sbxUpdateOutput,{rowCount:3});
  const unavailable=sandboxServiceUnavailableHold({stderr:'503 Service Unavailable'},{rowCount:3});
  let restarted=false,admissions=0;
  backend.deadlineRecoveryHold=()=>restarted?unavailable:update;
  backend.ensureSandboxAdmission=async()=>{admissions++;throw deadlineRecoveryError(restarted?unavailable:update);};
  backend.recoverSandboxDeadlines=async()=>{throw deadlineRecoveryError(restarted?unavailable:update);};
  const base=backend.protectionSummary.bind(backend);
  backend.protectionSummary=async(...args)=>{
    const report=await base(...args);
    if(!restarted)report.preflight.checks=[{name:'sbx_daemon',ok:false,cause:'daemon_restart_required',automatic:true,detail:'Docker Sandboxes needs to restart to finish its update.'}];
    return report;
  };
  backend.recoverHealth=async()=>{restarted=true;return {recovered:true,restarted:true};};
  const {app}=await f.start('update-cleanup-still-held',{backend,cleanupRecheckMs:60000});
  // Startup may already have completed the restart. Both paths must retain the fresh refusal.
  const response=await fetch(app.origin+'/api/readiness?refresh=true',{headers:{'x-faravan-session-token':app.token}});
  const report=await response.json();
  assert.ok([200,409].includes(response.status));
  assert.equal(report.ready===true,false);
  assert.equal(report.recovery_hold.row_count,3);
  assert.equal(report.recovery_hold.error_code,'sbx_daemon_unavailable');
  assert.ok(admissions>=2,'restarted service must be listed again');
});

test('workspace timeout survives confirmed restart until fresh workspace evidence passes',{timeout:60000},async t=>{
  const f=await appFixture(t),backend=syntheticBackend(f.root);
  const recoveries=[];
  const timeout=workspaceFailure({code:'wall_timeout',message:'The workspace probe stopped.'});
  let workspacePassed=false,workspaceUnknown=false,observations=0;
  const base=backend.protectionSummary.bind(backend);
  backend.protectionSummary=async(...args)=>{
    const report=await base(...args);
    observations++;
    report.preflight.checks=report.preflight.checks.filter(check=>check.name!=='test_workspace');
    report.preflight.checks.push({
      name:'test_workspace',
      ...(workspacePassed?{ok:true,detail:'Sandbox job runner confirmed.',fix:'',cause:'timeout'}:timeout),
      ...(workspaceUnknown?{unknown:true}:{}),
    });
    report.preflight.ok=workspacePassed;
    report.sandbox_ready=workspacePassed;
    report.satisfied=workspacePassed;
    return report;
  };
  // Only test-owned state is touched. Restart success deliberately does not
  // manufacture successful workspace evidence.
  backend.recoverHealth=async options=>{
    recoveries.push(options);
    return {recovered:options?.confirmedRestart===true,restarted:options?.confirmedRestart===true};
  };
  const {app}=await f.start('workspace-timeout-recovery',{backend});
  const assertHeld=report=>{
    assert.equal(report.ready,false,'the failed workspace observation keeps the readiness hold');
    for(const name of ['sbx_daemon','docker_login']){
      assert.equal(report.checks.find(check=>check.name===name)?.ok,true,name+' already passed');
    }
    const workspace=report.checks.find(check=>check.name==='test_workspace');
    assert.ok(workspace,'workspace evidence is retained in the HTTP response');
    assert.equal(workspace.ok,false);
    assert.equal(workspace.cause,'timeout');
    assert.equal(workspace.label,'The test workspace took too long to start.');
    assert.equal(workspace.remedy,'Choose Check again.','a timed-out workspace with a healthy daemon offers the existing readiness retry, not a restart');
    assert.equal(Object.hasOwn(workspace,'diagnostics'),false);
    assert.equal(JSON.stringify(report).includes('The workspace probe stopped.'),false,'raw diagnostics stay private');
  };
  const before=await api(app,'/api/readiness?refresh=true');
  assertHeld(before);
  assert.equal(recoveries.length,0,'startup and readiness reads cannot authorize shared restart');
  await api(app,'/api/setup/restart-sandbox',{method:'POST',body:{},status:400});
  assert.equal(recoveries.length,0,'an unconfirmed request performs no restart effect');
  const observedBeforeRestart=observations;
  const restarted=await api(app,'/api/setup/restart-sandbox',{method:'POST',body:{confirmed:true}});
  assert.equal(recoveries.length,1,'one explicit confirmation invokes one recovery');
  assert.equal(recoveries[0].confirmedRestart,true);
  assert.ok(observations>observedBeforeRestart,'restart obtains new workspace evidence');
  assertHeld(restarted);
  assertHeld(await api(app,'/api/readiness'));
  assertHeld(await api(app,'/api/readiness?refresh=true'));
  assert.equal(recoveries.length,1,'a still-failed workspace is not automatic restart consent');
  const observedBeforeSuccess=observations;
  workspacePassed=true;
  const ready=await api(app,'/api/readiness?refresh=true');
  assert.ok(observations>observedBeforeSuccess);
  assert.equal(ready.checks.find(check=>check.name==='test_workspace')?.ok,true);
  assert.equal(Object.hasOwn(ready.checks.find(check=>check.name==='test_workspace'),'cause'),false,'passed checks do not retain timeout');
  assert.equal(ready.ready,true,'only successful new workspace evidence clears the hold');
  assert.equal(recoveries.length,1,'fresh evidence does not require another shared restart');
  workspacePassed=false;workspaceUnknown=true;
  const unknown=await api(app,'/api/readiness?refresh=true');
  const unknownWorkspace=unknown.checks.find(check=>check.name==='test_workspace');
  assert.equal(unknown.ready,false);
  assert.equal(unknownWorkspace.unknown,true,'unknown remains unknown');
  assert.equal(Object.hasOwn(unknownWorkspace,'cause'),false,'unknown evidence does not claim a fixed failure');
  assert.equal(Object.hasOwn(unknownWorkspace,'diagnostics'),false);
  assert.equal(recoveries.length,1);
});

test('a timed-out test workspace tells the doctor reader to run it again or choose Check again, not to restart',()=>{
  const failure=workspaceFailure({code:'wall_timeout',message:'Sandbox wall-clock deadline exceeded.'});
  assert.equal(failure.cause,'timeout');
  assert.match(failure.fix,/Check again/);
  assert.doesNotMatch(failure.fix,/Restart/);
  assert.match(workspaceFailure({code:'daemon_restart_required'}).fix,/restart/i,'a trusted daemon update keeps its restart wording');
});
