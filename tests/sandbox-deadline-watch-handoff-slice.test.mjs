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
import {sandboxDeadlineClock,sandboxDeadlineRemaining,sandboxDeadlineUnit} from '../lib/sandbox-deadline.mjs';
import {deadlineRecoveryHold as recoveryHoldFor,deadlineRecoveryError} from '../lib/sandbox-remediation.mjs';

// Execute the exact two host-test bodies against the real journal and exact
// backend recovery/admission/dispatch methods. This is not the full backend
// import graph: no excluded credentials module is imported or substituted.
const backendSource=fs.readFileSync(new URL('../lib/docker-backend.mjs',import.meta.url),'utf8');
const part=(a,b)=>{const i=backendSource.indexOf(a),j=backendSource.indexOf(b,i+a.length);assert.ok(i>=0&&j>i);return backendSource.slice(i,j);};
const methods=part('  deadlineRecoveryHold() {','  async inspectCleanupRemediation')+
 part('  reconcileOwnedSandboxes(','\n  /**')+part('  async assertActive(','  async _runJobCommand(');
let currentHome,currentScratch;
const _internal={sbxHome:()=>currentHome,scratchRoot:()=>currentScratch};
const policyError=(code,message,details)=>Object.assign(Error(message),{code,...details});
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'guard-handoff-slice-'));
 currentHome=root;currentScratch=path.join(root,'scratch');fs.mkdirSync(currentScratch);
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const directory=path.join(root,'profile','v1','sandbox-cleanup'),events=[],armed=new Set();
 const deadlines={register:async row=>{events.push('register');armed.add(row._cleanupId);return {kind:'systemd',unit:sandboxDeadlineUnit(row),binary:'/fake/sbx'};},
 active:async row=>armed.has(row._cleanupId),activeSync:row=>armed.has(row._cleanupId),cancel:async row=>{events.push('cancel');armed.delete(row._cleanupId);return true;}};
 const watcher={acknowledge:async row=>({watch_generation:row.watch_generation,challenge:row.watch_challenge,binary:'/fake/sbx'})};
 const values={sbxHome:()=>root,daemonJobContext:new AsyncLocalStorage(),deadlineRecoveryContext:new AsyncLocalStorage(),recoveryHoldFor,deadlineRecoveryError,
 policyError,sandboxDeadlineRemaining,parseSbxListing:()=>{events.push('inventory');throw Error('This adoption needs no inventory');},hostDiskStop:()=>{throw Error('Unexpected disk path');}};
 const Backend=Function(...Object.keys(values),'return class {'+methods+'}')( ...Object.values(values)),backend=new Backend();
 const journal=createSandboxCleanupJournal({directory,scratchRoot:()=>currentScratch,home:()=>root,destroy:async()=>{events.push('destroy');throw Error('Watched compute cannot be destroyed here');}});
 Object.assign(backend,{cleanupJournal:journal,sandboxDeadlines:deadlines,deadlineClock:sandboxDeadlineClock,monotonic:()=>performance.now(),_diskSentries:new Map(),
 _ownedStartupGeneration:0,_legacyDaemonOptions:{platformName:'linux'},_rowHomeMatches:row=>row.sbx_home===root,
 _sharedSandboxWatcher:()=>watcher,_rowRun:async()=>{events.push('command');throw Error('No sandbox command is allowed');}});
 return {root,backend,events,deadlines};
}
const deadlineFields=at=>{const clock=sandboxDeadlineClock();return {deadline_at:at,deadline_clock:{version:1,boot_id:clock.boot_id,boot_at:clock.boot_ms+at-clock.wall}};};
async function writeCreateReceipt(directory,{jobId,name,ownerScope,home,scratchRoot,created=true,settled=true}){
 const id=randomUUID();fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,id+'.json'),JSON.stringify({version:2,_cleanupId:id,owner_scope:ownerScope,
 sbx_home:home,job_id:jobId,sandbox_id:name,scratch_dir:path.join(scratchRoot,'wf-job-'+name+'-'+randomUUID()),create:'dispatched',compute_created:created,
 create_settled:settled,compute_stopped:false,data_cleanup:'owned',policy_cleanup:'owned'}));return id;
}
const hostSource=fs.readFileSync(new URL('./sandbox-deadline-backend.test.mjs',import.meta.url),'utf8');
const begin=hostSource.indexOf("for(const overdue of [false,true])test('watched inert create"),end=hostSource.indexOf("test('changing the sandbox HOME",begin);
assert.ok(begin>=0&&end>begin);
Function('test','assert','fs','path','fixture','writeCreateReceipt','sandboxOwnerScope','_internal','deadlineFields',hostSource.slice(begin,end))(
 test,assert,fs,path,fixture,writeCreateReceipt,sandboxOwnerScope,_internal,deadlineFields);
