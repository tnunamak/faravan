import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeadlineRecoveryGate} from '../lib/v1/deadline-recovery-gate.mjs';
import {deadlineRecoveryHold,deadlineRecoveryError,CESSATION_FIX,sandboxServiceUnavailableHold} from '../lib/sandbox-remediation.mjs';

test('throwing startup recovery becomes a safe visible hold and explicit retry clears it',async()=>{
  const original=Object.assign(Error('/private/SECRET'),{code:'daemon_owner_repair_required'});
  let fail=true,calls=0;const changes=[];
  const gate=createDeadlineRecoveryGate({backend:{recoverSandboxDeadlines:async()=>{calls++;if(fail)throw original;return true;},
    cleanupStatus:()=>({compute_cleanup_pending:44})},onChange:hold=>changes.push(hold)});
  assert.equal(await gate.retry(),false);assert.equal(gate.current().row_count,44);
  assert.equal(gate.current().error_code,'daemon_owner_repair_required');
  assert.deepEqual(gate.current().fix,CESSATION_FIX);assert.doesNotMatch(JSON.stringify(changes),/SECRET|private/);
  assert.throws(()=>gate.assertReady(),{code:'cessation_unverified'});
  fail=false;assert.equal(await gate.retry(),true);assert.equal(gate.current(),null);gate.assertReady();
  assert.equal(calls,2);assert.equal(changes.at(-1),null);
});

test('concurrent retries share one flight and false stays local',async()=>{
  let resolve,calls=0;const wait=new Promise(r=>{resolve=r;});
  const gate=createDeadlineRecoveryGate({backend:{recoverSandboxDeadlines:()=>{calls++;return wait;}}});
  const a=gate.retry(),b=gate.retry();assert.equal(a,b);resolve(false);
  assert.equal(await a,false);assert.equal(calls,1);assert.equal(gate.current(),null); // Unknown cleanup failure is local under the isolation rule.
});

test('held cold entry invokes no underlying runner and preserve properties after clear',async()=>{
  let fail=true,cold=0;
  const gate=createDeadlineRecoveryGate({backend:{recoverSandboxDeadlines:async()=>{if(fail)throw Object.assign(Error('owner unknown'),{code:'daemon_owner_repair_required'});return true;}}});
  const runner=async()=>{cold++;return {ok:true};};runner.isQueued=token=>token==='queued';
  const wrapped=gate.wrapProbe(runner);await gate.retry();
  await assert.rejects(wrapped(),{code:'cessation_unverified'});
  assert.equal(cold,0);assert.equal(wrapped.isQueued('queued'),true);
  fail=false;await gate.retry();await wrapped();assert.equal(cold,1);
  // A host guard read makes no sandbox, so the gate does not wrap one: the legacy opener is gone.
  assert.equal('openMeterSession' in wrapped,false);
});

test('a new backend hold during a cold check is captured with its safe cause',async()=>{
  const hold=sandboxServiceUnavailableHold({stderr:'503 Service Unavailable: secret withheld'},{rowCount:13});
  const gate=createDeadlineRecoveryGate({backend:{recoverSandboxDeadlines:async()=>true}});await gate.retry();
  const run=gate.wrapProbe(async()=>{throw deadlineRecoveryError(hold);});
  await assert.rejects(run(),{code:'cessation_unverified'});
  assert.equal(gate.current().cause_code,'deadline_recovery_failed');assert.equal(gate.current().error_code,'sbx_daemon_unavailable');assert.equal(gate.current().row_count,13);
  assert.doesNotMatch(JSON.stringify(gate.current()),/SECRET/);
});

test('aborting a retry does not clear an existing hold',async()=>{
  const controller=new AbortController();
  const gate=createDeadlineRecoveryGate({backend:{recoverSandboxDeadlines:async()=>false},signal:controller.signal});
  await gate.retry();const hold=gate.current();controller.abort();
  await assert.rejects(gate.retry(),{name:'AbortError'});assert.equal(gate.current(),hold);
});
