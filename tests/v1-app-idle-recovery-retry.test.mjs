import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,syntheticBackend} from './helpers/v1-app-fixture.mjs';

// HOST MUST RUN: the real app graph with fake executors only.
// The 15 s cleanup tick reads backend.cleanupDisplayIdle() once. An idle reading skips the whole tick: no reap pass and no
// deadline-recovery retry, because the retry scans the journal directory and /proc. A non-idle reading still retries.
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function ticks(t,idle) {
  const f=await appFixture(t),backend=syntheticBackend(f.root);let recoveries=0,reaps=0,idleReads=0;
  backend.recoverSandboxDeadlines=async()=>{recoveries++;return true;};
  backend.reapCleanup=async()=>{reaps++;};
  backend.cleanupDisplayIdle=()=>{idleReads++;return idle;};
  await f.start('idle-retry',{backend,cleanupRecheckMs:20});
  const atStartup=recoveries;
  await sleep(400);
  return {atStartup,recoveries,reaps,idleReads};
}

test('an idle tick does not run the deadline-recovery retry',{timeout:30000},async t=>{
  const {atStartup,recoveries,reaps,idleReads}=await ticks(t,true);
  assert.ok(idleReads>=5,'the tick ran several times: '+idleReads);
  assert.equal(reaps,0,'an idle reading skips the reap pass');
  assert.equal(recoveries,atStartup,'no retry after startup while idle');
});

test('a tick that is not idle still runs the deadline-recovery retry',{timeout:30000},async t=>{
  const {atStartup,recoveries,reaps}=await ticks(t,false);
  assert.ok(reaps>=5,'reap passes keep running: '+reaps);
  assert.ok(recoveries>=atStartup+5,'retry runs every tick: '+recoveries+' vs startup '+atStartup);
});

test('a cached idle cleanup display cannot strand a global service hold',{timeout:30000},async t=>{
  const f=await appFixture(t),backend=syntheticBackend(f.root);
  let admits=0,release=false,held=null;
  backend.cleanupDisplayIdle=()=>true;
  backend.reapCleanup=async()=>{};
  backend.ensureSandboxAdmission=async()=>{
    admits++;
    if(release){held=null;return true;}
    held={error_code:'sbx_daemon_unavailable',cause_code:'deadline_recovery_failed',message:'Sandbox service is unavailable.',fix:{human:'Retrying.'}};
    throw Object.assign(new Error(held.message),{code:held.error_code,recovery_hold:held});
  };
  backend.deadlineRecoveryHold=()=>held;
  await f.start('held-retry',{backend,cleanupRecheckMs:20});
  assert.ok(held);
  release=true;
  await sleep(250);
  assert.ok(admits>1);
  assert.equal(held,null);
});
