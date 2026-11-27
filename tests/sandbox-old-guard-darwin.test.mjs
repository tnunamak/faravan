import './helpers/no-browser.mjs';
// Real-process check of the old-guard scan on macOS: a guard from an older version, found through the real /bin/ps and told apart
// by the start identity ps reports. Everything the guard can reach is a throwaway directory and a stub program; no real sandbox
// home, sbx daemon or app data is involved. FARAVAN_OLD_GUARD_FILE names the older supervisor file to run; without it, the copy
// of commit 6a311240e6456866dfde2af1b1429a730855fca7 under tests/fixtures/old-guard is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {randomUUID,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createSandboxDeadlineManager,deadlineProcessIdentity,deadlineSupervisorPayload,sandboxDeadlineClock} from '../lib/sandbox-deadline.mjs';

const skip=process.platform==='darwin'?false:'macOS only: this test reads real /bin/ps process identity, which Linux does not use';
const FIXTURE=fileURLToPath(new URL('./fixtures/old-guard/sandbox-deadline-supervisor.mjs',import.meta.url));
const oldGuardFile=process.env.FARAVAN_OLD_GUARD_FILE||FIXTURE;
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
async function until(check,message,timeout=15000) {
  const deadline=Date.now()+timeout;
  for(;;){const result=await check();if(result)return result;if(Date.now()>=deadline)assert.fail(message);await sleep(50);}
}

// One throwaway store: a record, a stub sandbox program, and one guard process started from the older file.
async function oldGuard(t) {
  assert.equal(path.basename(oldGuardFile),'sandbox-deadline-supervisor.mjs','the older guard file keeps the program name the scan looks for');
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'old-guard-')));
  const started=[],exits=[];
  t.after(async()=>{
    // Every process this test started, through its own child handle, even when an assertion failed. A handle whose process has
    // exited is skipped: its PID was reaped and may now name another process, which this test never started.
    for(const child of started)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    await Promise.race([Promise.all(exits),sleep(5000)]);
    fs.rmSync(root,{recursive:true,force:true});
  });
  const home=path.join(root,'sbx-home'),directory=path.join(root,'records'),binary=path.join(root,'stub-sbx');
  fs.mkdirSync(home);fs.mkdirSync(directory);
  fs.writeFileSync(binary,'#!/bin/sh\ncase "$1" in ls) echo "[]";; rm) exit 0;; *) exit 1;; esac\n',{mode:0o700});
  const clock=sandboxDeadlineClock(),id=randomUUID(),sandbox_id='wf-'+randomBytes(8).toString('hex');
  // The deadline is an hour away: the guard only waits and never reaches the stub.
  const row={_cleanupId:id,sandbox_id,sbx_home:home,owner_scope:'old-guard-test',create:'dispatched',compute_created:false,compute_stopped:false,
    deadline_at:clock.wall+3600_000,deadline_clock:{version:1,boot_id:clock.boot_id,boot_at:clock.boot_ms+3600_000}};
  const payload={...deadlineSupervisorPayload(row,binary,directory,'guard')};
  fs.writeFileSync(payload.recordPath,JSON.stringify(row));
  const child=spawn(process.execPath,[oldGuardFile,JSON.stringify(payload)],{detached:true,stdio:['ignore','ignore','ignore','ipc'],env:{HOME:home}});
  started.push(child);
  const exited=new Promise(resolve=>child.once('exit',resolve));
  exits.push(exited);
  await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('exit',()=>reject(Error('The older guard exited before it was ready.')));});
  const status=await until(()=>{try{return JSON.parse(fs.readFileSync(payload.statusPath,'utf8'));}catch{return null;}},'The older guard published no status.');
  assert.equal(status.pid,child.pid);
  const identity=await deadlineProcessIdentity(child.pid);
  assert.equal(typeof identity,'string','ps reports the guard\'s start identity');
  assert.equal(status.start,identity,'the status names the identity ps reports');
  const manager=(extra={})=>createSandboxDeadlineManager({binary,directory,...extra});
  return {row,payload,child,exited,identity,status,directory,manager,started};
}

test('macOS: an older guard that no record owns is adopted and left running, matched by its exact PID and start identity',{skip,timeout:60000},async t=>{
  const g=await oldGuard(t);
  const report=await g.manager().reconcileGuards({directory:g.directory,rowFor:()=>null});
  assert.equal(report.unknown,undefined,'the process list was readable');
  assert.deepEqual(report.adopted,[{id:g.row._cleanupId,pid:g.child.pid}]);
  assert.deepEqual(report.blocked,[]);
  await sleep(500);
  assert.equal(alive(g.child.pid),true,'an adopted guard is never signalled');
});

test('macOS: the older guard that is the record\'s own is adopted and keeps running',{skip,timeout:60000},async t=>{
  const g=await oldGuard(t);
  const own={...g.row,deadline_enforcer:{kind:'guard',pid:g.child.pid,start:g.identity,binary:g.payload.binary}};
  const report=await g.manager().reconcileGuards({directory:g.directory,rowFor:id=>id===g.row._cleanupId?own:null});
  assert.deepEqual(report.adopted,[{id:g.row._cleanupId,pid:g.child.pid}]);
  await sleep(500);
  assert.equal(alive(g.child.pid),true,'an adopted guard is left running');
});

test('macOS: a guard whose status names a different start identity is left alone and blocks the hand-off',{skip,timeout:60000},async t=>{
  const g=await oldGuard(t);
  // The status file names this PID with another start time: the same PID, but not the process the file vouches for.
  fs.writeFileSync(g.payload.statusPath,JSON.stringify({...g.status,start:'Mon Jan  1 00:00:00 2001 another process'}));
  const report=await g.manager().reconcileGuards({directory:g.directory,rowFor:()=>null});
  assert.deepEqual(report.blocked,[{id:g.row._cleanupId,pid:g.child.pid}]);
  await sleep(500);
  assert.equal(alive(g.child.pid),true,'no signal goes to a process whose identity the status does not name');
});
