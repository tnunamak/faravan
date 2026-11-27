import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {spawnSync} from 'node:child_process';
import {acquireCredentialMutation, spawnCredentialWriter, withCredentialPreparation} from '../lib/sandbox-credentials.mjs';
import {writerIdentity, writerGroupGone} from '../lib/v1/lock.mjs';

test('escaped writer must not write synthetic credential state after preparation opens', async t => {
  const home = await mkdtemp(join(tmpdir(), 'review-r3-escape-'));
  const marker = join(home, 'synthetic-write');
  const detached = join(home, 'detached.mjs');
  const leader = join(home, 'leader.mjs');
  await writeFile(detached, `import fs from 'node:fs';
const timer=setTimeout(()=>process.exit(2),10000);
process.on('SIGUSR2',()=>{fs.writeFileSync(${JSON.stringify(marker)},'synthetic only');clearTimeout(timer);process.exit(0);});
process.send('ready'); process.disconnect();
`);
  await writeFile(leader, `import {spawn} from 'node:child_process';
const child=spawn(process.execPath,[${JSON.stringify(detached)}],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
child.once('message',()=>{console.log(child.pid);process.exit(0);});
`);
  const release = await acquireCredentialMutation(home);
  const child = await spawnCredentialWriter(home, process.execPath, [leader]);
  const exit = once(child, 'exit');
  const [output] = await once(child.stdout, 'data');
  const escapedPid = Number(output.toString().trim());
  t.after(()=>{try{process.kill(escapedPid,'SIGKILL');}catch{}});
  await exit;
  await release();
  let admitted = false;
  let refusal;
  try { await withCredentialPreparation(home,async()=>{admitted=true;}); } catch(error) { refusal=error.code; }
  const written = new Promise((resolve,reject)=>{
    const watcher=fs.watch(home,(_event,name)=>{if(name==='synthetic-write'){watcher.close();clearTimeout(timer);resolve();}});
    const timer=setTimeout(()=>{watcher.close();reject(new Error('synthetic writer did not finish'));},5000);
  });
  process.kill(escapedPid,'SIGUSR2');
  await written;
  assert.equal(await readFile(marker,'utf8'),'synthetic only');
  t.diagnostic(JSON.stringify({admitted,refusal:refusal??null,syntheticWriteAfterPreparation:true,escapedPid}));
  assert.equal(admitted,false,'escaped writer was still alive when the fence opened');
  await assert.rejects(withCredentialPreparation(home,async()=>{}, {isolatedSources:true}),{code:'credential_writer_unresolved'});
});

test('a fork during the proc snapshot must keep an in-group writer fenced', async t => {
  const home=await mkdtemp(join(tmpdir(),'review-r3-proc-race-'));
  const marker=join(home,'descendant-pid');
  const leader=join(home,'leader.mjs');
  await writeFile(leader,`import {spawn} from 'node:child_process'; import fs from 'node:fs';
process.on('SIGUSR1',()=>{const child=spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));process.exit(0);});
console.log('ready');setTimeout(()=>{},10000);
`);
  const release=await acquireCredentialMutation(home);
  const child=await spawnCredentialWriter(home,process.execPath,[leader]);
  await once(child.stdout,'data');
  const identity=writerIdentity(child.pid);
  await release();
  const original=fs.readdirSync;
  t.after(()=>{fs.readdirSync=original;try{process.kill(-child.pid,'SIGKILL');}catch{}});
  let sameGroup;
  fs.readdirSync=function(directory,...args){
    const entries=original.call(this,directory,...args);
    if(directory==='/proc'){
      fs.readdirSync=original;
      process.kill(child.pid,'SIGUSR1');
      const wait=spawnSync(process.execPath,['-e',`const fs=require('node:fs');const file=${JSON.stringify(marker)};const done=()=>{if(fs.existsSync(file)){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);process.exit(0);}};fs.watch(${JSON.stringify(home)},done);done();setTimeout(()=>process.exit(2),5000);`]);
      assert.equal(wait.status,0,'fork handshake completed');
      const descendant=Number(fs.readFileSync(marker,'utf8'));
      const stat=fs.readFileSync('/proc/'+descendant+'/stat','utf8');
      sameGroup=stat.slice(stat.lastIndexOf(') ')+2).trim().split(/\s+/)[2]===String(child.pid);
      assert.equal(sameGroup,true,'descendant stays in the original process group');
    }
    return entries;
  };
  assert.equal(writerGroupGone(identity),false,'a final group probe must catch the fork');
  let admitted=false;
  let refusal;
  try{await withCredentialPreparation(home,async()=>{admitted=true;});}catch(error){refusal=error.code;}
  process.kill(-child.pid,0);
  t.diagnostic(JSON.stringify({admitted,refusal:refusal??null,sameGroup,groupStillExists:true}));
  assert.equal(admitted,false,'proc snapshot missed a live in-group descendant');
  await assert.rejects(withCredentialPreparation(home,async()=>{}, {isolatedSources:true}),{code:'credential_writer_unresolved'});
});

test('sandbox preparation waits for a sign-in that holds the credential lock, within a bound', async () => {
  const {acquireProcessLock}=await import('../lib/v1/lock.mjs');
  const home=await mkdtemp(join(tmpdir(),'wf-prep-wait-'));
  const held=await acquireProcessLock(join(home,'credential-changes.lock'),{timeoutMs:0});
  await assert.rejects(withCredentialPreparation(home,async()=>{}, {isolatedSources:true,lockWaitMs:300,lockPollMs:50}),
    {code:'credential_scope_unenforceable',condition:'preparation_lock_unavailable'});
  const released=setTimeout(()=>held(),400);
  let admitted=false;
  await withCredentialPreparation(home,async()=>{admitted=true;},{isolatedSources:true,lockWaitMs:5000,lockPollMs:50});
  clearTimeout(released);
  assert.equal(admitted,true);
});
