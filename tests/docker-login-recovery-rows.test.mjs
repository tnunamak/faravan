import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createSandboxCleanupJournal} from '../lib/sandbox-cleanup-journal.mjs';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import {sandboxDeadlineUnit} from '../lib/sandbox-deadline.mjs';
import {acquireProcessLockSync} from '../lib/v1/lock.mjs';
import {createDockerSignInState} from '../lib/v1/docker-signin-state.mjs';
import {deadlineRecoveryHold as recoveryHoldFor,deadlineRecoveryError} from '../lib/sandbox-remediation.mjs';

// Real journal, real locks and durable sign-in state; exact backend gate and
// recovery entrypoint. Availability is covered separately; this seam isolates
// journal ownership. Only disposable workspace create/cleanup is a fake.
const source=fs.readFileSync(new URL('../lib/docker-backend.mjs',import.meta.url),'utf8');
function method(start,end,deps,values){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return Function(...deps,'return ({'+source.slice(a,b)+'})')(...values);}
const policyError=(code,message,details)=>Object.assign(Error(message),{code,...details});
for(const kind of ['record','name','malformed'])test('explicit sign-in entrypoint clears durably despite an unrelated '+kind+' row',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'docker-recovery-row-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const directory=path.join(root,'journal'),scratch=path.join(root,'scratch');fs.mkdirSync(directory);fs.mkdirSync(scratch);
  const id=randomUUID(),name='wf-1234567890abcdef',file=path.join(directory,id+'.json');
  const row={version:2,_cleanupId:id,owner_scope:sandboxOwnerScope(),sbx_home:root,job_id:'unrelated',sandbox_id:name,
    scratch_dir:path.join(scratch,'wf-job-'+name+'-'+randomUUID()),create:'dispatched',compute_created:false,create_settled:false,
    absent_since:0,compute_stopped:false,data_cleanup:'pending',policy_cleanup:'removed',deadline_at:1000,deadline_clock:{version:1,boot_id:'fixture',boot_at:1000}};
  fs.writeFileSync(file,kind==='malformed'?'not-json':JSON.stringify(row));const before=fs.readFileSync(file);
  let destroys=0;const journal=createSandboxCleanupJournal({directory,scratchRoot:()=>scratch,home:()=>root,destroy:async()=>{destroys++;throw Error('the unrelated row must not be acted on');}});
  const release=kind==='malformed'?()=>{}:acquireProcessLockSync(kind==='record'?file+'.lock':path.join(directory,name+'.scope'));
  const clock=()=>({wall:10000,boot_id:'fixture',boot_ms:10000});
  const manager={active:async()=>false,register:async row=>({kind:'systemd',unit:sandboxDeadlineUnit(row),binary:'/fake/sbx'})};
  const state=createDockerSignInState({home:root,sbxHome:root});state.refuse();
  const backend={...method('  recoverSandboxDeadlines(','  deadlineTargetDebt(',
      ['sbxHome','daemonJobContext','deadlineRecoveryContext','recoveryHoldFor','deadlineRecoveryError'],
      [()=>root,new AsyncLocalStorage(),new AsyncLocalStorage(),recoveryHoldFor,deadlineRecoveryError]),
    ...method('  recoverSignIn({','  _applySignInRefusal(',['policyError','SIGN_IN_RECOVERY_MS'],[policyError,60000]),
    _cleanupListingReady:async()=>{},
    _legacyDaemonOptions:{platformName:process.platform},cleanupJournal:journal,sandboxDeadlines:manager,deadlineClock:clock,_rowHomeMatches:()=>true,
    deadlineTimers:{setTimeout,clearTimeout},signInRefused:()=>state.read()!==null};
  let creates=0;
  backend.testWorkspace=async()=>{await backend.recoverSandboxDeadlines();creates++;state.clear(state.read().epoch);return {ok:true};};
  try {
    assert.equal((await backend.recoverSignIn())?.ok,true,'unrelated row must not become a global check failure');
    assert.equal(creates,1);assert.equal(destroys,0);assert.deepEqual(fs.readFileSync(file),before);
    assert.equal(createDockerSignInState({home:root,sbxHome:root}).read(),null,'the clear survives reconstruction');
    assert.equal(backend._deadlineRecoveryReport.rows.find(item=>item.id===id).status,kind==='malformed'?'failed':'in_progress');
  } finally {release();}
});

// Cleanup isolation rule: an unknown journal failure cannot stop unrelated checks.
test('journal-wide failure does not prevent an explicit sign-in check',async()=>{
  const backend={...method('  recoverSandboxDeadlines(','  deadlineTargetDebt(',
      ['sbxHome','daemonJobContext','deadlineRecoveryContext','recoveryHoldFor','deadlineRecoveryError'],
      [()=>'/fake',new AsyncLocalStorage(),new AsyncLocalStorage(),recoveryHoldFor,deadlineRecoveryError]),
    ...method('  recoverSignIn({','  _applySignInRefusal(',['policyError','SIGN_IN_RECOVERY_MS'],[policyError,60000]),
    _cleanupListingReady:async()=>{},
    _legacyDaemonOptions:{platformName:process.platform},cleanupJournal:{recoverDeadlines:async()=>{throw Error('journal unavailable');}},
    sandboxDeadlines:{},deadlineTimers:{setTimeout,clearTimeout},signInRefused:()=>true};
  let creates=0;backend.testWorkspace=async()=>{await backend.recoverSandboxDeadlines();creates++;return {ok:true};};
  assert.equal((await backend.recoverSignIn())?.ok,true);assert.equal(creates,1);
});
