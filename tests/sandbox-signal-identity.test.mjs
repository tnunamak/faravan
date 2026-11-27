import './helpers/no-browser.mjs';
// Child teardown uses live handles. The build-replacement release rule also
// permits signaling a verified old guard after payload and final identity checks.
// The saved-PID check is a snapshot, not an atomic process handle.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {signalRecordedApp} from '../lib/v1/uninstall.mjs';

const T={timeout:30000};
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
function tmp(t) {
  const dir=fs.mkdtempSync(path.join(os.homedir(),'.tmp','noh3-signal-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;
}
// A process this test starts; the test is the only one that ever ends it.
async function sleeper(t,source='setInterval(()=>{},1000);process.send("ready");') {
  const child=spawn(process.execPath,['-e',source],{stdio:['ignore','ignore','ignore','ipc']});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGKILL');await done;}});
  await once(child,'message');return child;
}

test('S1: the saved app PID is not signalled when no app lock shows that process running (a stale PID now names an unrelated process)',T,async t=>{
  const home=tmp(t),unrelated=await sleeper(t);
  fs.mkdirSync(path.join(home,'v1'));
  // app.json still names the PID, but nothing holds the app lock: the app is gone and the number belongs to someone else.
  const signalled=signalRecordedApp(home,unrelated.pid);
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(signalled,false);
  assert.equal(alive(unrelated.pid),true,'the unrelated process was not signalled');
  assert.equal(unrelated.exitCode,null);assert.equal(unrelated.signalCode,null);
});

test('S2: the saved app PID is signalled while the app lock shows that process holding it',T,async t=>{
  const home=tmp(t);fs.mkdirSync(path.join(home,'v1'));
  const lock=new URL('../lib/v1/lock.mjs',import.meta.url).href;
  const app=await sleeper(t,`import(${JSON.stringify(lock)}).then(({acquireProcessLockSync})=>{acquireProcessLockSync(${JSON.stringify(path.join(home,'v1','app.lock'))});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);process.send('ready');});`);
  const exited=once(app,'exit');
  assert.equal(signalRecordedApp(home,app.pid),true);
  await exited;
  assert.equal(app.exitCode===0||app.signalCode==='SIGTERM',true);
});

test('S3: an injected stop (the tests\' seam) is used as given',()=>{
  const calls=[];
  assert.equal(signalRecordedApp('/nowhere',424242,{kill:(pid,signal)=>calls.push(pid+':'+signal)}),true);
  assert.deepEqual(calls,['424242:SIGTERM']);
});

test('S4: a ChildProcess handle signals nothing once the process has been reaped, and is already released when the exit is observed',T,async()=>{
  const child=spawn(process.execPath,['-e','']);
  let atExit;
  child.once('exit',()=>{atExit={result:child.kill('SIGKILL'),exitCode:child.exitCode,signalCode:child.signalCode};});
  await once(child,'close');
  assert.deepEqual(atExit,{result:false,exitCode:0,signalCode:null},'kill() through the handle is a no-op from the first moment the exit is visible');
  assert.equal(child.kill('SIGKILL'),false);
});

// Every place that signals a number, not a handle, was read and has a reason. A new one fails here until it is read too.
const SITES={
  'lib/auth-flow.mjs':[2,'group of a detached child, signalled while its pipes are open and by a cancel only before close'],
  'lib/faravan-guard.mjs':[1,'inside the sandbox guest, not on the lender\'s machine'],
  'lib/provider-generation-auth.mjs':[1,'group of the sign-in CLI; nothing is signalled after it is reaped'],
  'lib/github-auth.mjs':[1,'group of a child it started; its timer ends with the child'],
  'lib/sandbox-deadline.mjs':[1,'verified different-build guard replacement: bound payload, publisher identity and final synchronous PID check'],
  'lib/docker-backend.mjs':[1,'default for waitForProcessExit, which only sends signal 0'],
  'lib/v1/coordinator-owner.mjs':[1,'signal-0 probe'],
  'lib/v1/host.mjs':[1,'a PID saved by an earlier run, checked against the process start identity in the same synchronous step'],
  'lib/v1/lock.mjs':[3,'signal-0 probes'],
  'lib/v1/macos-update-helper.mjs':[2,'signal-0 probes'],
  'lib/v1/uninstall.mjs':[1,'a saved app PID, signalled only while the app\'s own lock shows that process running (signalRecordedApp)'],
  'lib/v1/keep-awake.mjs':[1,'private group of the helper it started; it waits for every member to leave'],
  'lib/v1/credential-probe-guest.mjs':[1,'the parent, signalled only while the parent PID is still this process\'s parent'],
  'lib/v1/sandbox-shared-watcher.mjs':[1,'retiring a watcher of another build: signalled only while it holds the lock and its published process start still matches, checked again synchronously just before the signal'],
  'lib/v1/preview-lock.mjs':[1,'signal-0 probe'],
  'lib/v1/command-path.mjs':[1,'group of a login shell it started, bounded to 15 s and ended with the child'],
};
function sites(root) {
  const found={};
  const walk=dir=>{
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      const full=path.join(dir,entry.name);
      if(entry.isDirectory()){if(entry.name!=='node_modules'&&entry.name!=='test-artifacts')walk(full);continue;}
      if(!/\.(mjs|js)$/.test(entry.name)||/\.test\./.test(entry.name))continue;
      const count=fs.readFileSync(full,'utf8').split('\n').filter(line=>/\bprocess\.kill\b/.test(line)&&!/^\s*(\/\/|\*)/.test(line)&&!/process\.kill\(.*,\s*0\s*\)/.test(line)).length;
      if(count)found[path.relative(root,full)]=count;
    }
  };
  for(const dir of ['lib','bin','coordinator'])if(fs.existsSync(path.join(root,dir)))walk(path.join(root,dir));
  return found;
}
test('S5: the places that signal a number are exactly the ones read and justified',T,()=>{
  const root=path.resolve(import.meta.dirname,'..');
  assert.deepEqual(sites(root),Object.fromEntries(Object.entries(SITES).map(([file,[count]])=>[file,count])));
});
