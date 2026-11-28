import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {testSbxRuntimeFields} from "./helpers/sandbox-receipt-fixture.mjs";

test('absence proof refuses live sandboxes, process references, incomplete scans and unsupported platforms', async () => {
  const {DockerSbxBackend}=await import('../lib/docker-backend.mjs');
  let names=[],scan={complete:true,references:[]};
  const backend=Object.create(DockerSbxBackend.prototype);
  const {sandboxOwnerScope}=await import('../lib/sandbox-name.mjs');
  const pending={owner_scope:sandboxOwnerScope(),sbx_home:'/synthetic-home',attemptId:'dead',jobId:'job'};
  backend.cleanupJournal={jobsStopped:()=>true};
  backend._rowHomeMatches=row=>row.sbx_home==='/synthetic-home';
  backend._rowRun=async()=>({code:0,stdout:JSON.stringify(names)});
  backend._legacyDaemonOptions={platformName:'linux',inspectProcesses:async()=>scan};
  const prove=()=>backend.proveHoldAbsent({attemptId:'dead',jobId:'job',pending});
  assert.equal((await prove()).absent,true);
  names=[{name:'unrelated-sandbox'}];assert.equal((await prove()).absent,false);
  names=[];scan={complete:true,references:['live process']};assert.equal((await prove()).absent,false);
  scan={complete:false,references:[]};assert.equal((await prove()).absent,false);
  scan={complete:true,references:[]};backend._legacyDaemonOptions.platformName='win32';assert.equal((await prove()).absent,false);
  backend._legacyDaemonOptions.platformName='linux';backend._rowRun=async()=>{throw Error('unreadable');};
  assert.equal((await prove()).absent,false);
});





test('macOS absence requires an empty complete inventory and a complete process table', async t => {
  const {DockerSbxBackend}=await import('../lib/docker-backend.mjs');
  let listing={code:0,stdout:'[]'}, processes={code:0,stdout:'  PID  PPID COMMAND\n    0     0 kernel_task\n    1     0 /sbin/launchd\n'};
  const calls=[];
  const backend=new DockerSbxBackend({runCommand:async(args,options)=>{
    calls.push({args,options});return listing;
  },legacyDaemonOptions:{platformName:'darwin',runProcessCommand:async(command,args,options)=>{
    assert.equal(command,'/bin/ps');assert.deepEqual(args,['-ww','-axo','pid,ppid,command']);
    assert.ok(options.timeout>0);return processes;
  }}});
  const pending={...testSbxRuntimeFields(backend._profileHome),...backend.sandboxOwnership(),attemptId:'dead',jobId:'job'};
  const prove=()=>backend.proveHoldAbsent({attemptId:'dead',jobId:'job',pending});
  await t.test('empty inventory and no job process permit release',async()=>{
    assert.equal((await prove()).absent,true);
    assert.deepEqual(calls[0].args,['ls','--json']);
    assert.equal(calls[0].options.env.HOME,backend.sandboxOwnership().sbx_home);
  });
  for(const row of [
    {code:0,stdout:'[{"name":"wf-0123456789abcdef"}]'},
    {code:1,stdout:'[]'}, {code:0,stdout:'[]',timedOut:true},
    {code:0,stdout:'[]',truncated:true}, {code:0,stdout:'not json'},
  ]) {
    await t.test('inventory '+JSON.stringify(row),async()=>{
      listing=row;const proof=await prove();assert.equal(proof.absent,false);assert.match(proof.reason,/^sandbox_/);
    });
  }
  listing={code:0,stdout:'[]'};
  for(const row of [
    {code:0,stdout:'  PID  PPID COMMAND\n 123 1 node worker-job\n'},
    {code:0,stdout:'  PID  PPID COMMAND\n 123 1 sbx exec wf-0123456789abcdef sleep 300\n'},
    {code:0,stdout:'  PID  PPID COMMAND\n 123 1 /path/containerd-shim-nerdbox-v1\n'},
    {code:1,stdout:''}, {code:0,stdout:'',timedOut:true},
    {code:0,stdout:'  PID  PPID COMMAND\n 1 0 /sbin/launchd\n',truncated:true},
    {code:0,stdout:'  PID  PPID COMMAND\n 1 0 /sbin/launchd\n',stderr:'ps: read failed'},
    {code:0,stdout:'  PID  PPID COMMAND\n 123 1 /bin/true'},
    {code:0,stdout:'  PID  PPID COMMAND\n broken row\n'},
    {code:0,stdout:'  PID  PPID COMMAND\n'},
  ]) {
    await t.test('process table '+JSON.stringify(row),async()=>{
      processes=row;const proof=await prove();assert.equal(proof.absent,false);assert.match(proof.reason,/^process_/);
    });
  }
});





test('hold absence refuses missing or mismatched job HOME evidence before scanning',async()=>{
  const {DockerSbxBackend}=await import('../lib/docker-backend.mjs');
  for(const platformName of ['linux','darwin']){
    let calls=0;
    const backend=new DockerSbxBackend({runCommand:async()=>{calls++;return {code:0,stdout:'[]'};},
      legacyDaemonOptions:{platformName,inspectProcesses:async()=>({complete:true,references:[]}),
        runProcessCommand:async()=>({code:0,stdout:'PID PPID COMMAND\n1 0 /sbin/launchd\n'})}});
    const receipt={...testSbxRuntimeFields(backend._profileHome),...backend.sandboxOwnership(),attemptId:'dead',jobId:'job'};
    for(const pending of [undefined,{...receipt,sbx_home:undefined},{...receipt,sbx_home:'/another-home'},
      {...receipt,attemptId:'other'},{...receipt,jobId:'other'},{...receipt,owner_scope:'0'.repeat(64)}]){
      const proof=await backend.proveHoldAbsent({attemptId:'dead',jobId:'job',pending});
      assert.equal(proof.absent,false);assert.equal(proof.reason,'sandbox_home_unverified');
    }
    assert.equal(calls,0,'unknown HOME must not fall back to the current listing');
    assert.equal((await backend.proveHoldAbsent({attemptId:'dead',jobId:'job',pending:receipt})).absent,true);
  }
});

const attemptId='recovery-attempt', jobId='recovery-job';
