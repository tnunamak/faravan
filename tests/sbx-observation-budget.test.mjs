import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DockerSbxBackend, ensureSbxDaemon, resetSbxDaemonGate, _internal } from '../lib/docker-backend.mjs';
import { removeSandboxPolicies } from '../lib/sandbox-policy-cleanup.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ok = stdout => ({code:0, stdout:stdout ?? '', stderr:''});
const help = '-d, --detach\n--name\n--kit\n--cpus\n--memory\n--skills\n--deny-network';
function fixture({before=async()=>{}}={}) {
  let now=0, broken=false;
  const calls=[];
  const raw=async (command,args) => {
    calls.push([command,...args]);
    await before(command,args);
    if(args.join(' ')==='daemon status')return ok('Status: running');
    if(args[0]==='version')return broken?{code:1,stderr:'missing'}:ok('sbx version: v0.51.0 abc123');
    if(args[0]==='diagnose')return ok('Daemon healthy\nDocker authentication healthy');
    if(args.join(' ')==='run --help')return ok(help);
    if(args[0]==='policy')return ok(args.includes('--json')?'{"rules":[]}':'Policy rules');
    if(command==='dpkg-query')return ok('docker-sbx\tinstalled\t0.51.0\ndocker-ce\tinstalled\t28.0.0\ncontainerd.io\tinstalled\t2.1.0\n');
    if(command==='docker')return ok('28.0.0');
    if(command==='containerd')return ok('containerd github.com/containerd/containerd v2.1.0');
    return ok();
  };
  const runCommand=async (command,args,options) => {
    if(command===(process.env.FARAVAN_SBX_BIN||'sbx')&&_internal.needsSbxDaemon(args))await ensureSbxDaemon({runCommand:raw,systemd:false,platformName:'darwin',env:options?.env,commandArgs:args});
    return raw(command,args);
  };
  const backend=new DockerSbxBackend({monotonic:()=>now,storage:{available:async()=>true}});
  backend._hostDiskCheck=async()=>({name:'host_disk',ok:true});
  const options={runCommand,platformName:'linux'};
  return {backend,options,calls,runCommand,setNow:value=>{now=value;},break:()=>{broken=true;},recover:()=>{broken=false;},
    sbx:()=>calls.filter(row=>!['dpkg-query','docker','containerd','test'].includes(row[0]))};
}

for(const idle of [true,false])test(`shared observation budget over 600 seconds (${idle?'idle':'active'})`,async t=>{
  const previous=process.env.FARAVAN_SBX_DAEMON_GATE;
  delete process.env.FARAVAN_SBX_DAEMON_GATE;
  t.after(()=>{if(previous===undefined)delete process.env.FARAVAN_SBX_DAEMON_GATE;else process.env.FARAVAN_SBX_DAEMON_GATE=previous;});
  const f=fixture();
  await f.backend.lenderCapabilities(f.options); // explicit initial diagnostics
  f.calls.length=0;
  let batches=0;
  for(let second=0;second<600;second++) {
    f.setNow(second*1000);
    const reads=[f.backend.lenderCapabilities({...f.options,observation:true,idle})];
    if(second%15===0)reads.push(f.backend.lenderCapabilities({...f.options,observation:true,idle}));
    if(second%30===0)reads.push(f.backend.lenderCapabilities({...f.options,cached:true,observation:true,idle}));
    await Promise.all(reads);
  }
  batches=f.calls.filter(row=>row[0]==='dpkg-query').length;
  t.diagnostic(JSON.stringify({batches,sbx:f.sbx().length,diagnose:f.sbx().filter(row=>row[1]==='diagnose').length}));
  assert.ok(batches<=(idle?10:40),`batches: ${batches}`);
  assert.equal(f.sbx().filter(row=>row[1]==='diagnose').length,0);
  assert.ok(f.sbx().length<=(idle?30:120),`sbx argv count: ${f.sbx().length}`);
});

test('slow callers share one flight; cancelling a waiter cannot cancel another reader',async()=>{
  let release,started;
  const waiting=new Promise(resolve=>{started=resolve;});
  const blocked=new Promise(resolve=>{release=resolve;});
  let hold=false;
  const f=fixture({before:async(_command,args)=>{if(hold&&args.join(' ')==='ls -q'){started();await blocked;}}});
  await f.backend.lenderCapabilities(f.options);
  f.calls.length=0;hold=true;
  const controller=new AbortController();
  const first=f.backend.lenderCapabilities({...f.options,observation:true,signal:controller.signal});
  await waiting;
  f.setNow(60000);
  const second=f.backend.lenderCapabilities({...f.options,observation:true});
  controller.abort(new Error('cancelled waiter'));
  await assert.rejects(first,/cancelled waiter/);
  release();
  assert.equal((await second).available,false,'an overdue success cannot admit work');
  assert.equal(f.calls.filter(row=>row[0]==='dpkg-query').length,1);
});

test('observations keep their timestamp and return independent copies',async()=>{
  const f=fixture();await f.backend.lenderCapabilities(f.options);
  const first=await f.backend.lenderCapabilities({...f.options,observation:true,idle:true});
  f.setNow(59000);
  first.preflight.checks.length=0;
  const second=await f.backend.lenderCapabilities({...f.options,observation:true,idle:true});
  assert.equal(second.preflight.probed_at,first.preflight.probed_at);
  assert.ok(second.preflight.checks.length>0);
  assert.equal(second.preflight.cached,true);
  const before=f.calls.length;f.setNow(60000);
  await f.backend.lenderCapabilities({...f.options,observation:true,idle:true});
  assert.ok(f.calls.length>before);
});

test('home, binary replacement and lifecycle generation never share evidence',async t=>{
  const previousHome=process.env.FARAVAN_SBX_HOME, previousBin=process.env.FARAVAN_SBX_BIN;
  const directory=mkdtempSync(join(tmpdir(),'sbx-observation-'));
  t.after(()=>{
    if(previousHome===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=previousHome;
    if(previousBin===undefined)delete process.env.FARAVAN_SBX_BIN;else process.env.FARAVAN_SBX_BIN=previousBin;
    rmSync(directory,{recursive:true,force:true});
  });
  const bin=join(directory,'sbx');writeFileSync(bin,'#!/bin/sh\nexit 0\n',{mode:0o755});
  process.env.FARAVAN_SBX_BIN=bin;
  const f=fixture();await f.backend.lenderCapabilities(f.options);
  const read=()=>f.backend.lenderCapabilities({...f.options,observation:true,idle:true});
  assert.equal((await read()).available,true);
  process.env.FARAVAN_SBX_HOME='/tmp/obs-home-b';
  assert.equal((await read()).available,false,'diagnostics from another home cannot admit work');
  await f.backend.lenderCapabilities(f.options);
  assert.equal((await read()).available,true);
  writeFileSync(bin,'#!/bin/sh\n# replacement executable\nexit 0\n',{mode:0o755});
  assert.equal((await read()).available,false,'replacement binary needs its own diagnostics');
  await f.backend.lenderCapabilities(f.options);
  assert.equal((await read()).available,true);
  resetSbxDaemonGate();
  assert.equal((await read()).available,false,'lifecycle invalidation retires old evidence');
});

test('cleanup and forced job checks obtain fresh daemon status outside the batch',async t=>{
  const previous=process.env.FARAVAN_SBX_DAEMON_GATE;
  delete process.env.FARAVAN_SBX_DAEMON_GATE;
  t.after(()=>{if(previous===undefined)delete process.env.FARAVAN_SBX_DAEMON_GATE;else process.env.FARAVAN_SBX_DAEMON_GATE=previous;});
  const f=fixture();await f.backend.lenderCapabilities(f.options);
  await f.backend.lenderCapabilities({...f.options,observation:true,idle:true});
  f.calls.length=0;
  await f.backend.lenderCapabilities(f.options);
  assert.equal(f.sbx().filter(row=>row.slice(1).join(' ')==='daemon status').length,3);
  f.calls.length=0;
  assert.equal(await removeSandboxPolicies(args=>f.runCommand('sbx',args),'wf-0123456789abcdef'),true);
  assert.equal(f.sbx().filter(row=>row.slice(1).join(' ')==='daemon status').length,2);
});

test('failed background observations keep a cooldown and job rechecks remain fresh',async()=>{
  const f=fixture();f.break();
  const options={...f.options,observation:true,idle:true};
  assert.equal((await f.backend.lenderCapabilities(options)).available,false);
  const count=f.calls.length;
  await f.backend.lenderCapabilities(options);
  assert.equal(f.calls.length,count);
  await f.backend.lenderCapabilities(f.options);
  assert.ok(f.calls.length>count);
});

test('a failing host stays within forty background batches in ten minutes',async()=>{
  const f=fixture();f.break();
  for(let second=0;second<600;second++){
    f.setNow(second*1000);
    await Promise.all(Array.from({length:3},()=>f.backend.lenderCapabilities({...f.options,observation:true,idle:true})));
  }
  assert.equal(f.calls.filter(row=>row[0]==='dpkg-query').length,40);
  assert.equal(f.sbx().filter(row=>row[1]==='diagnose').length,0);
});

test('a newer disk failure fences a cached observation waiting on local bytes',async()=>{
  const f=fixture();await f.backend.lenderCapabilities(f.options);
  const options={...f.options,observation:true,idle:true};
  await f.backend.lenderCapabilities(options);
  let started,release,reads=0;
  const waiting=new Promise(resolve=>{started=resolve;});
  const blocked=new Promise(resolve=>{release=resolve;});
  f.backend._hostDiskCheck=async()=>{
    if(++reads===1){started();return blocked;}
    return {name:'host_disk',ok:false,reason:'host_disk_low'};
  };
  const older=f.backend.lenderCapabilities(options);await waiting;
  assert.equal((await f.backend.lenderCapabilities(options)).available,false);
  release({name:'host_disk',ok:true});
  assert.equal((await older).available,false);
});

test('a fresh check crossing an identity change must re-prove the new home',async t=>{
  const previous=process.env.FARAVAN_SBX_HOME;
  t.after(()=>{if(previous===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=previous;});
  let started,release,reads=0;
  const waiting=new Promise(resolve=>{started=resolve;});
  const blocked=new Promise(resolve=>{release=resolve;});
  const f=fixture({before:async(_command,args)=>{if(args.join(' ')==='ls -q'&&++reads===1){started();await blocked;}}});
  process.env.FARAVAN_SBX_HOME='/tmp/obs-home-a';
  const older=f.backend.lenderCapabilities(f.options);await waiting;
  process.env.FARAVAN_SBX_HOME='/tmp/obs-home-b';
  assert.equal((await f.backend.lenderCapabilities(f.options)).available,true);
  release();
  assert.equal((await older).available,true);
  assert.equal(f.sbx().filter(row=>row[1]==='diagnose').length,3,'the old-home success must be re-read, not relabelled');
});

test('a skipped diagnostic preserves verified evidence and recovers after the failed observation cooldown',async()=>{
  const f=fixture();
  assert.equal((await f.backend.lenderCapabilities(f.options)).available,true);
  const diagnosticsAt=f.backend._diagnosticEvidence.at;
  f.break();
  const failed=await f.backend.lenderCapabilities(f.options);
  assert.equal(failed.available,false);
  assert.equal(failed.preflight.diagnostics_observed_at,null,'a skipped diagnostic has no new timestamp');
  const options={...f.options,observation:true,idle:true};
  assert.equal((await f.backend.lenderCapabilities(options)).available,false);
  const count=f.calls.length,diagnoses=f.sbx().filter(row=>row[1]==='diagnose').length;
  f.recover();f.setNow(14999);
  assert.equal((await f.backend.lenderCapabilities(options)).available,false);
  assert.equal(f.calls.length,count,'failed observation stays in its cooldown');
  f.setNow(15000);
  const recovered=await f.backend.lenderCapabilities(options);
  assert.equal(recovered.available,true);
  assert.equal(recovered.preflight.diagnostics_observed_at,diagnosticsAt);
  assert.equal(f.sbx().filter(row=>row[1]==='diagnose').length,diagnoses,'background recovery never diagnoses');
});

test('an actual diagnostic failure supersedes earlier verified evidence',async()=>{
  const f=fixture();let fail=false;
  const runCommand=(command,args,options)=>fail&&args[0]==='diagnose'
    ? Promise.resolve({code:1,stderr:'Daemon healthy\nKVM error: Permission denied (os error 13)'})
    : f.runCommand(command,args,options);
  const options={...f.options,runCommand};
  assert.equal((await f.backend.lenderCapabilities(options)).available,true);
  fail=true;
  assert.equal((await f.backend.lenderCapabilities(options)).available,false);
  const observed=await f.backend.lenderCapabilities({...options,observation:true,idle:true});
  assert.equal(observed.available,false);
  assert.equal(observed.preflight.checks.find(check=>check.name==='kvm_access').ok,false);
});

test('a skipped diagnostic cannot preserve evidence across a home change',async t=>{
  const previous=process.env.FARAVAN_SBX_HOME;
  t.after(()=>{if(previous===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=previous;});
  const f=fixture();
  assert.equal((await f.backend.lenderCapabilities(f.options)).available,true);
  process.env.FARAVAN_SBX_HOME='/tmp/obs-home-b';f.break();
  assert.equal((await f.backend.lenderCapabilities(f.options)).available,false);
  assert.equal(f.backend._diagnosticEvidence,null);
  f.recover();f.setNow(15000);
  assert.equal((await f.backend.lenderCapabilities({...f.options,observation:true,idle:true})).available,false);
});

test('an executed diagnostic failure survives a concurrent skipped diagnostic',async()=>{
  const f=fixture();let hold=false,started,finish;
  const entered=new Promise(resolve=>{started=resolve;});
  const diagnostic=new Promise(resolve=>{finish=resolve;});
  const runCommand=(command,args,options)=>{
    if(hold&&args[0]==='diagnose'){started();return diagnostic;}
    return f.runCommand(command,args,options);
  };
  const options={...f.options,runCommand};
  assert.equal((await f.backend.lenderCapabilities(options)).available,true);
  hold=true;
  const earlier=f.backend.lenderCapabilities(options);
  await entered;
  f.break();
  assert.equal((await f.backend.lenderCapabilities(options)).available,false);
  f.recover();
  finish({code:1,stderr:'Daemon healthy\nKVM error: Permission denied (os error 13)'});
  assert.equal((await earlier).available,false);
  const diagnoses=f.sbx().filter(row=>row[1]==='diagnose').length;
  const observed=await f.backend.lenderCapabilities({...options,observation:true,idle:true});
  assert.equal(observed.available,false,'a skipped check cannot hide a real diagnostic failure');
  assert.equal(f.sbx().filter(row=>row[1]==='diagnose').length,diagnoses,'observation requires a new explicit diagnostic');
});

test('a newer actual diagnostic supersedes an older in-flight diagnostic failure',async()=>{
  const f=fixture();let count=0,started,finish;
  const entered=new Promise(resolve=>{started=resolve;});
  const diagnostic=new Promise(resolve=>{finish=resolve;});
  const runCommand=(command,args,options)=>{
    if(args[0]==='diagnose'&&++count===2){started();return diagnostic;}
    return f.runCommand(command,args,options);
  };
  const options={...f.options,runCommand};
  assert.equal((await f.backend.lenderCapabilities(options)).available,true);
  const earlier=f.backend.lenderCapabilities(options);await entered;
  f.break();assert.equal((await f.backend.lenderCapabilities(options)).available,false);f.recover();
  assert.equal((await f.backend.lenderCapabilities(options)).available,true);
  finish({code:1,stderr:'Daemon unhealthy'});
  assert.equal((await earlier).available,false);
  assert.equal((await f.backend.lenderCapabilities({...options,observation:true,idle:true})).available,true);
  assert.equal(count,3,'only the initial, held and newer explicit diagnostics ran');
});

test('a skipped diagnostic settling last cannot restore evidence captured before a real failure',async()=>{
  const f=fixture();let hold=false,diagnosticStarted,versionStarted,finishDiagnostic,finishVersion;
  const diagnosed=new Promise(resolve=>{diagnosticStarted=resolve;});
  const versioned=new Promise(resolve=>{versionStarted=resolve;});
  const diagnostic=new Promise(resolve=>{finishDiagnostic=resolve;});
  const version=new Promise(resolve=>{finishVersion=resolve;});
  let waitVersion=false;
  const runCommand=(command,args,options)=>{
    if(args[0]==='version'&&waitVersion){versionStarted();return version;}
    if(args[0]==='diagnose'&&hold){diagnosticStarted();return diagnostic;}
    return f.runCommand(command,args,options);
  };
  const options={...f.options,runCommand};
  assert.equal((await f.backend.lenderCapabilities(options)).available,true);
  hold=true;const earlier=f.backend.lenderCapabilities(options);await diagnosed;
  waitVersion=true;const later=f.backend.lenderCapabilities(options);await versioned;
  finishDiagnostic({code:1,stderr:'Daemon unhealthy'});assert.equal((await earlier).available,false);
  finishVersion({code:1,stderr:'temporary version failure'});assert.equal((await later).available,false);
  waitVersion=false;
  assert.equal((await f.backend.lenderCapabilities({...options,observation:true,idle:true})).available,false);
});

test('diagnostic order follows execution after version, not the start of the full check',async()=>{
  const f=fixture();let waitVersion=false,started,finishVersion,failDiagnostic=false;
  const entered=new Promise(resolve=>{started=resolve;});
  const version=new Promise(resolve=>{finishVersion=resolve;});
  const runCommand=(command,args,options)=>{
    if(args[0]==='version'&&waitVersion){started();return version;}
    if(args[0]==='diagnose'&&failDiagnostic)return Promise.resolve({code:1,stderr:'Daemon unhealthy'});
    return f.runCommand(command,args,options);
  };
  const options={...f.options,runCommand};
  assert.equal((await f.backend.lenderCapabilities(options)).available,true);
  waitVersion=true;const delayed=f.backend.lenderCapabilities(options);await entered;
  waitVersion=false;
  assert.equal((await f.backend.lenderCapabilities(options)).available,true);
  failDiagnostic=true;finishVersion(ok('sbx version: v0.51.0 abc123'));
  assert.equal((await delayed).available,false);
  assert.equal((await f.backend.lenderCapabilities({...options,observation:true,idle:true})).available,false,'the latest actual diagnosis failed');
});


test('disk sweep calls keep the backend runner and leave the observation cooldown intact',async()=>{
  const f=fixture();
  await f.backend.lenderCapabilities(f.options);
  await f.backend.lenderCapabilities({...f.options,observation:true,idle:true});
  const signal=new AbortController().signal,forwarded=[];
  f.backend.runSbx=(args,options)=>{
    forwarded.push({args,options});
    return f.runCommand(process.env.FARAVAN_SBX_BIN||'sbx',args,options);
  };
  const before=f.calls.length;
  const adapters=f.backend.diskSweepAdapters();
  for(const args of [['template','ls','--json'],['ls','--json']])await adapters.runSbx(args,{signal,timeout:1234});
  assert.deepEqual(forwarded.map(row=>row.args),[['template','ls','--json'],['ls','--json']]);
  assert.ok(forwarded.every(row=>row.options.signal===signal&&row.options.timeout===1234));
  const afterSweep=f.calls.length;
  assert.ok(afterSweep>before,'the disk inventory remains a fresh backend read');
  for(let second=1;second<60;second++){
    f.setNow(second*1000);
    await f.backend.lenderCapabilities({...f.options,observation:true,idle:true});
  }
  assert.equal(f.calls.length,afterSweep,'the sweep did not reset the background spawn cooldown');
});
