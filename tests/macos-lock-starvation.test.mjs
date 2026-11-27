import './helpers/no-browser.mjs';
import {_internal} from '../lib/docker-backend.mjs';
import {legacySandboxNameFor as sandboxNameFor,sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createServer, get} from 'node:http';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir, hostname} from 'node:os';
import {join} from 'node:path';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createSandboxScratch, releaseSandboxScratchRecord} from '../lib/sandbox-scratch.mjs';
import {createSandboxCleanupJournal} from '../lib/sandbox-cleanup-journal.mjs';
import {withCredentialPreparation} from '../lib/sandbox-credentials.mjs';
import {createLendingLedger} from '../lib/v1/lending-ledger.mjs';
import {getHarnessAdapter} from '../lib/harnesses/index.mjs';
import {appFixture,api} from './helpers/v1-app-fixture.mjs';
const claude=getHarnessAdapter('claude-code-subscription'),codex=getHarnessAdapter('codex');
import {acquireProcessLockSync} from '../lib/v1/lock.mjs';

import {configHome} from '../lib/local-state.mjs';
const fixtureAppHome = configHome();
process.env.FARAVAN_HOME = fixtureAppHome;

// Exercise real publication/cleanup/read locks with Darwin's subprocesses doubled.
// No real sbx, model, process probe, installed profile or Mac is used.
test('Darwin workspace publication and lending sweeps do not repeatedly block HTTP and deadlines on process probes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mac-lock-starvation-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const scratchRoot = join(root,'scratch'), journal = join(root,'scratch-journal');
  await mkdir(scratchRoot);
  // Historical empty lock directories are not journal records or live owners.
  for (let i=0;i<992;i++) await mkdir(join(journal+'-locks','wf-'+i.toString(16).padStart(16,'0')+'.owners-v1'),{recursive:true});
  const platform = Object.getOwnPropertyDescriptor(process,'platform');
  const original = childProcess.execFileSync;
  const calls = [];
  const pause = new Int32Array(new SharedArrayBuffer(4));
  childProcess.execFileSync = (command, args) => {
    calls.push([command,args]);
    // Model spawn/collection latency; repeated calls would occupy the event loop.
    Atomics.wait(pause,0,0,10);
    if(command==='/usr/sbin/sysctl') return '{ sec = 1000, usec = 0 }';
    if(command==='/bin/ps') return 'Mon Nov  2 10:00:00 2026';
    throw Error('Unexpected process probe '+command);
  };
  syncBuiltinESMExports();
  Object.defineProperty(process,'platform',{...platform,value:'darwin'});
  t.after(()=>{Object.defineProperty(process,'platform',platform);childProcess.execFileSync=original;syncBuiltinESMExports();});

  const cleanup = createSandboxCleanupJournal({directory:join(root,'cleanup'),scratchRoot:()=>scratchRoot,destroy:async()=>{}});
  const job_id = 'wf-pull-0000000000000000-12345678';
  const sandbox_id = sandboxNameFor(job_id);
  const handle = {job_id,sandbox_id};
  const backend = {
    async prepare() {
      await withCredentialPreparation(root,async()=>{
        handle.scratch_dir=await createSandboxScratch(sandbox_id,scratchRoot,journal,{beforeCreate:scratch=>{
          handle.scratch_dir=scratch;cleanup.register(handle);
        }});
      });
      return handle;
    },
    async destroy() {
      await releaseSandboxScratchRecord(sandbox_id,handle.scratch_dir,journal);
      await rm(handle.scratch_dir,{recursive:true,force:true});
      cleanup.finish(handle,{removed:true,scratch_removed:true,policy_removed:true});
      return {removed:true,scratch_removed:true};
    },
  };
  await backend.prepare();
  await backend.destroy();
  const preparationCalls = calls.length;

  const server = createServer((_req,res)=>res.end('ok'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const ledger = createLendingLedger({file:join(root,'ledger.json')});
  let deadlineAt;
  const started = performance.now();
  const deadline = new Promise(resolve=>setTimeout(()=>{deadlineAt=performance.now()-started;resolve();},10));
  const response = new Promise((resolve,reject)=>get('http://127.0.0.1:'+server.address().port,res=>{
    res.resume();res.on('end',()=>resolve(performance.now()-started));
  }).on('error',reject));
  // Status/lending sweeps repeatedly read the ledger under process locks.
  for(let i=0;i<100;i++){ledger.snapshotReadOnly('claude');ledger.entries();}
  await deadline;
  const httpMs = await response;
  t.diagnostic(JSON.stringify({preparationProcessProbes:preparationCalls,lendingReads:200,lendingProcessProbes:calls.length-preparationCalls,deadlineMs:deadlineAt,httpMs}));
  assert.equal(preparationCalls,2,'one sysctl + one ps for credential, scratch, scope and record locks combined');
  assert.equal(calls.length-preparationCalls,0,'200 lending reads must add no synchronous process probes');
  assert.ok(deadlineAt<1500,`deadline delayed ${deadlineAt}ms`);
  assert.ok(httpMs<1500,`HTTP delayed ${httpMs}ms`);
});

test('Darwin lock ownership retains unknown/live owners and skips identity reads for ESRCH', async t => {
  const root = await mkdtemp(join(tmpdir(),'mac-owner-safety-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const lock=join(root,'lock'),directory=lock+'.owners-v1';await mkdir(directory);
  const token='12345678-1234-1234-1234-123456789012';
  let namespace=null;try{namespace=fs.readlinkSync('/proc/self/ns/pid');}catch{}
  const record={version:1,host:hostname(),namespace,pid:123456,boot:'darwin:1000',start:'2000',token};
  const publish=()=>{
    fs.symlinkSync(JSON.stringify(record),join(directory,token+'.choosing'));
    fs.symlinkSync(JSON.stringify({...record,ticket:'1'}),join(directory,token+'.ticket'));
  };
  publish();
  let foreignReads=0;
  const posixIdentityReader=pid=>{if(pid===process.pid)return {boot:'darwin:1000',start:'3000'};foreignReads++;throw Error('unknown');};
  assert.throws(()=>acquireProcessLockSync(lock,{platform:'darwin',posixIdentityReader,processKill:()=>{}}),{code:'lock_busy'});
  assert.equal(fs.readdirSync(directory).length,2,'unknown is never removed');
  assert.equal(foreignReads,1);
  const release=acquireProcessLockSync(lock,{platform:'darwin',posixIdentityReader,processKill:pid=>{
    if(pid===record.pid)throw Object.assign(new Error('gone'),{code:'ESRCH'});
  }});release();
  assert.equal(foreignReads,1,'ESRCH skips ps/sysctl');
  assert.deepEqual(fs.readdirSync(directory),[]);
});

test('4096 cleanup records bound identity spawns; retired lock directories take no locks', async t => {
  const root=await mkdtemp(join(tmpdir(),'mac-cleanup-sweep-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'cleanup'),scratch=join(root,'scratch');
  await mkdir(directory);await mkdir(scratch);
  for(let i=0;i<4096;i++) {
    const id='00000000-0000-4000-8000-'+i.toString(16).padStart(12,'0');
    const job_id='cleanup-fixture-'+i;
    const sandbox_id=sandboxNameFor(job_id);
    fs.writeFileSync(join(directory,id+'.json'),JSON.stringify({version:2,_cleanupId:id,owner_scope:sandboxOwnerScope(),sbx_home:_internal.sbxHome(),job_id,sandbox_id,
      scratch_dir:join(scratch,'wf-job-'+sandbox_id+'-'+id),create:'dispatched',compute_created:true,create_settled:true,compute_stopped:false,data_cleanup:'pending',policy_cleanup:'pending'}));
  }
  const platform=Object.getOwnPropertyDescriptor(process,'platform');
  const original=childProcess.execFileSync,symlink=fs.symlinkSync,fsync=fs.fsyncSync;
  // Count lock work here; separate durability tests cover the real fsync barriers.
  fs.fsyncSync=()=>{};
  let spawns=0,acquisitions=0;
  childProcess.execFileSync=(command)=>{spawns++;return command==='/usr/sbin/sysctl'?'{ sec = 1000, usec = 0 }':'Mon Nov  2 10:00:00 2026';};
  fs.symlinkSync=(target,file,...args)=>{if(String(file).endsWith('.choosing'))acquisitions++;return symlink(target,file,...args);};
  syncBuiltinESMExports();Object.defineProperty(process,'platform',{...platform,value:'darwin'});
  t.after(()=>{Object.defineProperty(process,'platform',platform);childProcess.execFileSync=original;fs.symlinkSync=symlink;fs.fsyncSync=fsync;syncBuiltinESMExports();});
  const cleanup=createSandboxCleanupJournal({directory,scratchRoot:()=>scratch,destroy:async()=>({removed:true,scratch_removed:true,policy_removed:true})});
  await cleanup.reap();
  const periodic={acquisitions,spawns};
  spawns=0;acquisitions=0;
  const proof=await cleanup.reconcileOwned({inventory:async()=>[]});
  const startup={acquisitions,spawns};
  for(const file of fs.readdirSync(directory))if(file.endsWith('.json'))fs.unlinkSync(join(directory,file));
  spawns=0;acquisitions=0;
  await cleanup.reap();await cleanup.reconcileOwned({inventory:async()=>[]});
  assert.equal(acquisitions,0,'retired owners-v1 directories do not authorize or require record locks');
  assert.equal(spawns,0,'missing records do not spawn identity probes');
  t.diagnostic(JSON.stringify({records:4096,periodic,startup,retired:{acquisitions,spawns}}));
  assert.equal(periodic.acquisitions,64,'periodic reaper caps each pass at 32 records, with a record and scope lock each');
  assert.ok(periodic.spawns<=2,`periodic reaper spawned ${periodic.spawns} identity processes`);
  assert.equal(proof.removed,true);
  assert.equal(startup.acquisitions,8192,'startup reconciliation takes two locks for every retained JSON record');
  assert.ok(startup.spawns<=2,`startup reconciliation spawned ${startup.spawns} identity processes`);
});

test('idle lending and status polls add no Darwin identity spawns after initialization', {timeout:60000}, async t => {
  const {default:cp}=await import('node:child_process');
  const {default:fs}=await import('node:fs');
  const {syncBuiltinESMExports}=await import('node:module');
  const descriptor=Object.getOwnPropertyDescriptor(process,'platform'),exec=cp.execFileSync,symlink=fs.symlinkSync;
  let spawns=0,acquisitions=0,owner,lender;
  cp.execFileSync=(command,args,...rest)=>{
    if(command==='/usr/sbin/sysctl'){spawns++;return '{ sec = 1000, usec = 0 }';}
    if(command==='/bin/ps'){spawns++;return 'Mon Nov  2 10:00:00 2026';}
    return exec(command,args,...rest);
  };
  fs.symlinkSync=(target,file,...args)=>{if(String(file).endsWith('.choosing'))acquisitions++;return symlink(target,file,...args);};
  syncBuiltinESMExports();Object.defineProperty(process,'platform',{...descriptor,value:'darwin'});
  try {
    const f=await appFixture(t);
    const connected=await f.connect({pollMs:1000,adapters:[claude,codex].map(a=>({...a,installed:true,signedIn:true})),
      lendingSignInProbe:async()=>({signedIn:true}),
      lendingIdentityProbe:async({harnessNames})=>({providers:harnessNames.map(harness_id=>({harness_id,installed:true,signedIn:true}))}),
      lendingProbeRunner:async()=>{throw Object.assign(new Error('synthetic unavailable'),{probe_failure:'probe_unavailable'});}},
      {pollMs:1000});
    owner=connected.owner;lender=connected.lender;
    await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
    await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:connected.circle.id}});
    await api(lender.app,'/api/status');
    const first=spawns;acquisitions=0;
    for(let i=0;i<6;i++) {
      await Promise.all([api(lender.app,'/api/home'),api(lender.app,'/api/status'),api(lender.app,'/api/agents')]);
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    assert.ok(first<=2,'initialization reads this process identity at most once');
    assert.ok(acquisitions>0,'the fixture must exercise real app/profile/ledger locks');
    assert.equal(spawns-first,0,'idle lender work and UI/tray reads must not repeat identity probes');
  } finally {
    await lender?.app.close();await owner?.app.close();
    Object.defineProperty(process,'platform',descriptor);cp.execFileSync=exec;fs.symlinkSync=symlink;syncBuiltinESMExports();
  }
});

