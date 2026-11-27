import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {hostname,tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {acquireProcessLock,acquireProcessLockSync} from '../lib/v1/lock.mjs';

const identityReader=()=> '/Date(3000)/';
const win32={platform:'win32',identityReader};

async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'faravan-lock-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return {directory,lock:join(directory,'owner.lock'),owners:join(directory,'owner.lock.owners-v1')};
}

function forbidSymlinks(t) {
  const original=fs.symlinkSync;
  fs.symlinkSync=()=>{const error=new Error('symlinks require privilege');error.code='EPERM';throw error;};
  t.after(()=>{fs.symlinkSync=original;});
}

function writeWindowsOwner(f,start,pid=process.pid) {
  const token='00000000-0000-0000-0000-000000000001';
  const owner={version:1,host:hostname(),namespace:null,pid,boot:null,start,token};
  fs.mkdirSync(f.owners,{recursive:true});
  fs.writeFileSync(join(f.owners,token+'.choosing'),JSON.stringify(owner));
  fs.writeFileSync(join(f.owners,token+'.ticket'),JSON.stringify({...owner,ticket:'1'}));
}

function child(t,script,...args) {
  const process=spawn(globalThis.process.execPath,['--input-type=module','-e',script,...args],
    {stdio:['ignore','pipe','pipe']});
  let stderr='';process.stderr.on('data',chunk=>stderr+=chunk);
  const ended=new Promise(resolve=>process.once('exit',(code,signal)=>resolve({code,signal,stderr})));
  const ready=new Promise((resolve,reject)=>{
    let output='';
    process.stdout.on('data',chunk=>{output+=chunk;if(output.includes('ready\n'))resolve();});
    ended.then(result=>reject(new Error('Lock child exited before ready: '+JSON.stringify(result))));
  });
  t.after(async()=>{if(process.exitCode===null&&process.signalCode===null)process.kill('SIGKILL');await ended;});
  return {process,ready,ended};
}

test('win32 owner records acquire, release, and preserve live-owner contention without symlinks',async t=>{
  forbidSymlinks(t);
  const f=await fixture(t);
  const release=acquireProcessLockSync(f.lock,win32);
  const entries=fs.readdirSync(f.owners).sort();
  assert.equal(entries.length,2);
  assert.deepEqual(entries.map(name=>name.split('.').at(-1)),['choosing','ticket']);
  for(const name of entries) {
    assert.equal(fs.lstatSync(join(f.owners,name)).isFile(),true);
    assert.doesNotThrow(()=>JSON.parse(fs.readFileSync(join(f.owners,name),'utf8')));
  }
  assert.throws(()=>acquireProcessLockSync(f.lock,win32),{code:'lock_busy'});
  release();release();
  assert.deepEqual(fs.readdirSync(f.owners),[]);

  const asyncRelease=await acquireProcessLock(f.lock,{timeoutMs:0,...win32});
  await assert.rejects(acquireProcessLock(f.lock,{timeoutMs:0,...win32}),{code:'lock_busy'});
  asyncRelease();
  assert.deepEqual(fs.readdirSync(f.owners),[]);
});

test('win32 records block a live owner and recover an observed dead owner without proc boot identity',async t=>{
  forbidSymlinks(t);
  const f=await fixture(t);
  const module=new URL('../lib/v1/lock.mjs',import.meta.url).href;
  const script=`
    import fs from 'node:fs';
    fs.symlinkSync=()=>{const error=new Error('symlinks require privilege');error.code='EPERM';throw error;};
    const {acquireProcessLockSync}=await import(process.argv[1]);
    acquireProcessLockSync(process.argv[2],{platform:'win32',identityReader:()=> '/Date(3000)/'});
    console.log('ready');setInterval(()=>{},1000);
  `;
  const holder=child(t,script,module,f.lock);
  await holder.ready;
  const registration=fs.readdirSync(f.owners).find(name=>name.endsWith('.choosing'));
  const value=JSON.parse(fs.readFileSync(join(f.owners,registration),'utf8'));
  assert.equal(value.boot,null,'the win32 path emits boot:null records');
  assert.equal(value.namespace,null);
  assert.equal(value.start,'/Date(3000)/','the win32 path records the injected process creation identity');
  for (const name of fs.readdirSync(f.owners).filter(name=>name.endsWith('.ticket'))) {
    assert.equal(JSON.parse(fs.readFileSync(join(f.owners,name),'utf8')).boot,null);
  }

  const originalRead=fs.readFileSync;
  fs.readFileSync=function(file,...args) {
    if (String(file)==='/proc/sys/kernel/random/boot_id') {
      const error=new Error('boot identity unavailable');error.code='ENOENT';throw error;
    }
    return originalRead.call(this,file,...args);
  };
  t.after(()=>{fs.readFileSync=originalRead;});
  assert.throws(()=>acquireProcessLockSync(f.lock,win32),{code:'lock_busy'},'a live child is never reclaimed');
  holder.process.kill('SIGKILL');
  const exited=await holder.ended;
  assert.equal(exited.signal,'SIGKILL','the owner child exit was observed before recovery');

  const release=acquireProcessLockSync(f.lock,win32);
  release();
  assert.deepEqual(fs.readdirSync(f.owners),[]);
});

test('win32 reclaims a boot:null record when a live PID has a different creation identity',async t=>{
  const f=await fixture(t);
  writeWindowsOwner(f,'/Date(1000)/');
  const release=acquireProcessLockSync(f.lock,{platform:'win32',identityReader:()=> '/Date(2000)/'});
  release();
  assert.deepEqual(fs.readdirSync(f.owners),[]);
});

test('win32 keeps a boot:null record busy when a live PID has the same creation identity',async t=>{
  const f=await fixture(t);
  writeWindowsOwner(f,'/Date(1000)/');
  assert.throws(()=>acquireProcessLockSync(f.lock,{platform:'win32',identityReader:()=> '/Date(1000)/'}),{code:'lock_busy'});
  assert.equal(fs.readdirSync(f.owners).length,2);
});

test('win32 keeps a boot:null record busy when its live PID identity is unreadable',async t=>{
  const f=await fixture(t);
  writeWindowsOwner(f,'/Date(1000)/');
  assert.throws(()=>acquireProcessLockSync(f.lock,{platform:'win32',identityReader:()=> null}),
    error=>error.code==='lock_identity_unavailable');
  assert.equal(fs.readdirSync(f.owners).length,2);
});

test('win32 reads this process identity once across acquisitions and skips other PIDs when there are no owners',async t=>{
  const f=await fixture(t);
  const calls=[];
  const readIdentity=pid=>{calls.push(pid);return '/Date(3000)/';};
  const options={platform:'win32',identityReader:readIdentity};
  const first=acquireProcessLockSync(f.lock,options);
  first();
  const second=acquireProcessLockSync(f.lock,options);
  second();
  assert.deepEqual(calls,[process.pid]);
});

test('win32 acquisition refuses an unreadable own identity before publishing',async t=>{
  const f=await fixture(t);
  assert.throws(()=>acquireProcessLockSync(f.lock,{platform:'win32',identityReader:()=>{throw new Error('unavailable');}}),{code:'lock_identity_unavailable'});
  assert.deepEqual(fs.readdirSync(f.owners),[]);
});

test('win32 retries an unreadable identity on later acquisitions',async t=>{
  const f=await fixture(t);
  let calls=0;
  const options={platform:'win32',identityReader:()=>{calls++;throw new Error('powershell blocked');}};
  assert.throws(()=>acquireProcessLockSync(f.lock,options),{code:'lock_identity_unavailable'});
  assert.throws(()=>acquireProcessLockSync(f.lock,options),{code:'lock_identity_unavailable'});
  assert.equal(calls,6);
});

test('unknown published records still block admission and remain untouched',async t=>{
  const f=await fixture(t);
  fs.mkdirSync(f.owners,{recursive:true});
  const record=join(f.owners,'00000000-0000-0000-0000-000000000001.choosing');
  fs.writeFileSync(record,'unknown',{flag:'wx'});
  assert.throws(()=>acquireProcessLockSync(f.lock,win32),{code:'lock_busy'});
  assert.equal(fs.readFileSync(record,'utf8'),'unknown');
});

async function recoverAfterStagingCrash(t, f, writeMode) {
  const module=new URL('../lib/v1/lock.mjs',import.meta.url).href;
  const publisher=`
    import fs from 'node:fs';
    fs.symlinkSync=()=>{const error=new Error('symlinks require privilege');error.code='EPERM';throw error;};
    const originalWrite=fs.writeFileSync;let stopped=false;
    fs.writeFileSync=(file,data,...args)=>{
      if (!stopped && typeof file==='number') {
        stopped=true;
        if (process.argv[3]==='partial') originalWrite(file,Buffer.from(data).subarray(0,3),...args);
        console.log('ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
      }
      return originalWrite(file,data,...args);
    };
    const {acquireProcessLockSync}=await import(process.argv[1]);
    acquireProcessLockSync(process.argv[2],{platform:'win32',identityReader:()=> '/Date(3000)/'});
    throw new Error('publication did not stop at the injected write');
  `;
  const interrupted=child(t,publisher,module,f.lock,writeMode);
  await interrupted.ready;
  interrupted.process.kill('SIGKILL');
  const killed=await interrupted.ended;
  assert.equal(killed.signal,'SIGKILL');
  assert.ok(fs.readdirSync(f.owners).some(name=>name.endsWith('.staging')),'the abandoned staging file remains for recovery to ignore');

  const recovery=`
    const {acquireProcessLockSync}=await import(process.argv[1]);
    const release=acquireProcessLockSync(process.argv[2],{platform:'win32',identityReader:()=> '/Date(3000)/'});
    release();console.log('ready');
  `;
  const successor=child(t,recovery,module,f.lock);
  await successor.ready;
  const result=await successor.ended;
  assert.equal(result.code,0,result.stderr);
}

test('a new process recovers when a publisher dies after staging-file creation before writing',async t=>{
  forbidSymlinks(t);
  const f=await fixture(t);
  await recoverAfterStagingCrash(t,f,'before');
});

test('a new process recovers when a publisher dies during a partial staging write',async t=>{
  forbidSymlinks(t);
  const f=await fixture(t);
  await recoverAfterStagingCrash(t,f,'partial');
});

test('win32 owner records recover a killed owner and serialize concurrent processes',async t=>{
  const f=await fixture(t);
  const module=new URL('../lib/v1/lock.mjs',import.meta.url).href;
  const blocker=`
    import fs from 'node:fs';
    fs.symlinkSync=()=>{const error=new Error('symlinks require privilege');error.code='EPERM';throw error;};
    const {acquireProcessLockSync}=await import(process.argv[1]);
    acquireProcessLockSync(process.argv[2],{platform:'win32',identityReader:()=> '/Date(3000)/'});
    console.log('ready');setInterval(()=>{},1000);
  `;
  const holder=child(t,blocker,module,f.lock);
  await holder.ready;
  holder.process.kill('SIGKILL');
  await holder.ended;
  const recovery=acquireProcessLockSync(f.lock,win32);
  recovery();

  const contender=`
    import fs from 'node:fs';
    import {setTimeout as sleep} from 'node:timers/promises';
    fs.symlinkSync=()=>{const error=new Error('symlinks require privilege');error.code='EPERM';throw error;};
    const {acquireProcessLock}=await import(process.argv[1]);
    console.log('ready');
    for(let n=0;n<8;n++) {
      const release=await acquireProcessLock(process.argv[2],{timeoutMs:10000,pollMs:2,platform:'win32',identityReader:()=> '/Date(3000)/'});
      const fd=fs.openSync(process.argv[3],'wx');
      try {await sleep(3);}finally {fs.closeSync(fd);fs.unlinkSync(process.argv[3]);release();}
    }
  `;
  const children=Array.from({length:6},()=>child(t,contender,module,f.lock,join(f.directory,'critical')));
  await Promise.all(children.map(c=>c.ready));
  for(const result of await Promise.all(children.map(c=>c.ended)))assert.equal(result.code,0,result.stderr);
  assert.deepEqual(fs.readdirSync(f.owners),[]);
});

test('darwin boot-time drift with an unchanged start preserves a live lock',async t=>{
  const f=await fixture(t);
  const options={platform:'darwin',posixIdentityReader:()=>({boot:'darwin:1000',start:'100'}),processKill:()=>{}};
  const release=acquireProcessLockSync(f.lock,options);
  const before=fs.readdirSync(f.owners).sort();
  // Own identity is cached per reader, so a second reader observes the drifted boot.
  const drifted={...options,posixIdentityReader:()=>({boot:'darwin:999',start:'100'})};
  assert.throws(()=>acquireProcessLockSync(f.lock,drifted),error=>error.code==='lock_busy'&&error.reason==='lock_stale');
  assert.deepEqual(fs.readdirSync(f.owners).sort(),before);
  release();
});

test('an initially unreadable own identity is retried on a later acquisition',async t=>{
  const f=await fixture(t);
  let available=false;
  const options={platform:'win32',identityReader:()=>available?'/Date(3000)/':null};
  assert.throws(()=>acquireProcessLockSync(f.lock,options),{code:'lock_identity_unavailable'});
  available=true;
  const release=acquireProcessLockSync(f.lock,options);
  const record=JSON.parse(fs.readFileSync(join(f.owners,fs.readdirSync(f.owners).find(n=>n.endsWith('.ticket'))),'utf8'));
  assert.equal(record.start,'/Date(3000)/');
  release();
});

test('darwin refuses an unproven own identity and permits a later valid acquisition',async t=>{
  const f=await fixture(t);
  let available=false;
  const options={platform:'darwin',posixIdentityReader:()=>{
    if(!available)throw new Error('identity temporarily unavailable');
    return {boot:'darwin:1000',start:'100'};
  },processKill:()=>{}};
  assert.throws(()=>acquireProcessLockSync(f.lock,options),{code:'lock_identity_unavailable'});
  assert.deepEqual(fs.readdirSync(f.owners),[]);
  available=true;
  const release=acquireProcessLockSync(f.lock,options);
  const record=JSON.parse(fs.readlinkSync(join(f.owners,fs.readdirSync(f.owners).find(n=>n.endsWith('.ticket')))));
  assert.equal(record.boot,'darwin:1000');
  assert.equal(record.start,'100');
  release();
});

for (const platform of ['linux','darwin']) test(platform+' reuses only this process start identity across locks and live contention', async t => {
  const f = await fixture(t);
  const calls = [];
  const reader = (pid, platform) => {calls.push([pid, platform]); return {boot:'darwin:123',start:'456'};};
  const options = {platform,posixIdentityReader:reader};
  const release = await acquireProcessLock(f.lock, options);
  await assert.rejects(acquireProcessLock(f.lock, {...options,timeoutMs:0}), {code:'lock_busy'});
  release();
  const next = await acquireProcessLock(f.lock, options); next();
  assert.deepEqual(calls, [[process.pid,platform]], 'same-process lock polling must not repeatedly spawn sysctl and ps');
});


test('an unreadable own POSIX identity is retried without publishing an unknown owner', async t => {
  const f=await fixture(t);let reads=0;
  const posixIdentityReader=()=>{reads++;throw Error('process probe unavailable');};
  const options={platform:'darwin',posixIdentityReader};
  assert.throws(()=>acquireProcessLockSync(f.lock,options),{code:'lock_identity_unavailable'});
  assert.equal(reads,3,'failed identity probes are bounded');
  assert.deepEqual(fs.readdirSync(f.owners),[]);
});

for(const platform of ['linux','darwin'])test(platform+' retries a failed own identity before later independent contention',{timeout:10000},async t=>{
  const f=await fixture(t);let reads=0;
  const reader=()=>{if(++reads===1)throw Error('temporary identity timeout');return {boot:'boot-1',start:'123'};};
  const options={platform,posixIdentityReader:reader};
  const a=await acquireProcessLock(f.lock,options);a();assert.equal(reads,2);
  const b=await acquireProcessLock(f.lock,options);
  assert.equal(reads,2,'only the successful identity remains cached');
  const records=fs.readdirSync(f.owners).map(name=>JSON.parse(fs.readlinkSync(join(f.owners,name))));
  assert.ok(records.every(record=>record.boot==='boot-1'));
  let acquired=false;const c=acquireProcessLock(f.lock,{...options,timeoutMs:3000,pollMs:2}).then(release=>{acquired=true;return release;});
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(acquired,false);
  b();(await c)();assert.equal(reads,2,'successful identity remains cached');
});
