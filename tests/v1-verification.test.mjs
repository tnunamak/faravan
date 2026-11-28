import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DockerSbxBackend, CHECK_STOP_MS } from '../lib/docker-backend.mjs';
import { buildValidatedJobSpec, runJob, resolveHarness } from '../lib/executor.mjs';
import { CHECK_SKIPPED, checkSummary, changedTestFiles } from '../lib/protocol/verification.mjs';
import { createLender } from '../lib/v1/lender.mjs';
import * as p from '../lib/protocol/index.mjs';
import { lenderFixture, until } from './helpers/v1-lender-fixture.mjs';
import { realLenderFixture } from './helpers/v1-real-lender-fixture.mjs';

const spec = () => buildValidatedJobSpec({taskDigest:'a'.repeat(64),harness:resolveHarness('codex'),
  entrypointWithPrompt:'agent',verify:{cmd:'npm test'}});
const inventory = (hash,path) => hash.repeat(64)+'  ./'+path+'\0';

test('P9 parsers report numeric evidence only; test/config changes include additions and removals',()=>{
  for (const [cmd,output,parser,summary] of [
    ['npm test','# pass 49\n# fail 0','npm','49 passed, 0 failed'],
    ['npx jest','Tests: 2 failed, 8 passed, 10 total','jest','2 failed, 8 passed'],
    ['npm test','Test Files 1 passed\n Tests 7 passed (7)','vitest','7 passed'],
    ['pytest','===== 3 passed, 1 skipped in 0.2s =====','pytest','3 passed, 1 skipped'],
    ['custom','secret=private output',null,''],
  ]) assert.deepEqual(checkSummary(cmd,output),{parser,summary});
  assert.deepEqual(changedTestFiles(inventory('a','old.test.js')+inventory('a','package.json'),
    inventory('b','package.json')+inventory('a','__tests__/new.js')+inventory('b','src/app.js')),
    ['__tests__/new.js','old.test.js','package.json']);
  assert.deepEqual(changedTestFiles('',inventory('a','test_api.py')+inventory('a','conftest.py')),['conftest.py','test_api.py']);
  assert.throws(()=>changedTestFiles('',inventory('a','../bad.test.js')),{code:'output_invalid'});
  for(const verify of [{cmd:' '},{cmd:'npm test\ntrue'},{cmd:'x',extra:true}])
    assert.throws(()=>buildValidatedJobSpec({taskDigest:'a',harness:resolveHarness('codex'),entrypointWithPrompt:'agent',verify}));
});

// Agent and check sandboxes are separate: the check sandbox exists only after the agent's is removed.
async function twoSandboxes(t,overrides={}) {
  const events=[],scratch=await mkdtemp(join(tmpdir(),'p9-check-'));t.after(()=>rm(scratch,{recursive:true,force:true}));
  const agent={sandbox_id:'agent-sandbox',scratch_dir:'/unused',_entrypoint:'agent'},check={sandbox_id:'check-sandbox',scratch_dir:scratch,_entrypoint:'true'};
  let snapshots=0;
  const backend={
    admitJob:async()=>({ok:true}),probeCapabilities:async()=>({available:true}),prepare:async()=>agent,
    prepareCheck:async h=>{assert.equal(h,agent);events.push('prepare:check');return check;},
    start:async(h,options)=>{
      if(h===agent&&!h._bookkeeping){assert.equal(options.reserveSeconds,180);events.push('agent');h._lastExecStdout='agent output';}
      else if(h.sandbox_id===check.sandbox_id)events.push('workspace:check');
    },
    verificationFiles:async h=>{events.push('inventory:'+h.sandbox_id);return inventory(snapshots++?'b':'a','unit.test.js');},
    collectDeclaredOutputs:async()=>{events.push('collect');return [{path:'.wf-result/result.tar.gz',bytes_content:Buffer.from('tree')}];},
    cancel:async h=>{events.push('cancel:'+h.sandbox_id);},
    destroy:async h=>{events.push('destroy:'+h.sandbox_id);return {sandbox_id:h.sandbox_id,removed:true};},
    ...overrides,
  };
  return {backend,events,agent,check};
}

for(const observed of [{exit:0,timed_out:false},{exit:1,timed_out:false},{exit:137,timed_out:true}])
test('P9 executor runs checks in a new sandbox after the agent sandbox is removed: '+JSON.stringify(observed),async t=>{
  const jobSpec=spec();
  const f=await twoSandboxes(t);
  const agentStart=f.backend.start;
  f.backend.start=async(h,options)=>{if(h===f.agent&&!h._bookkeeping)jobSpec.verify.cmd='tampered';return agentStart(h,options);};
  f.backend.verify=async(h,{cmd,workdir})=>{assert.equal(h,f.check);assert.equal(cmd,'npm test');assert.equal(workdir,'.');f.events.push('checks:check-sandbox');
    return {...observed,timeout_ms:5000,stdout:'# pass 1\n# fail 0'};};
  const result=await runJob({jobSpec,backend:f.backend});
  assert.deepEqual(f.events,['inventory:agent-sandbox','agent','collect','destroy:agent-sandbox',
    'prepare:check','workspace:check','inventory:check-sandbox','checks:check-sandbox','destroy:check-sandbox']);
  assert.deepEqual(result.checks,[{cmd:'npm test',...observed,timeout_ms:5000,parser:'npm',summary:'1 passed, 0 failed',changed_test_files:['unit.test.js'],observed_by:'sandbox'}]);
  assert.equal(result.execution.stdout,'agent output');
  assert.equal(result.execution.sandbox_id,'agent-sandbox');
  assert.equal(result.cleanupReceipt.removed,true);
});

test('P9 cancellation during checks stops and removes both sandboxes; backends without a check sandbox fail before prepare',async t=>{
  const controller=new AbortController();
  const f=await twoSandboxes(t,{verify:async()=>{controller.abort(Object.assign(new Error('cancelled'),{code:'cancelled'}));return {exit:0,timed_out:false};}});
  await assert.rejects(runJob({jobSpec:spec(),backend:f.backend,signal:controller.signal}),{code:'cancelled'});
  assert.deepEqual(f.events.filter(e=>/^(cancel|destroy):/.test(e)),['destroy:agent-sandbox','cancel:check-sandbox','destroy:check-sandbox']);
  await assert.rejects(runJob({jobSpec:spec(),backend:{}}),{code:'policy_unenforceable'});
  const {prepareCheck,...sameSandboxOnly}=f.backend;
  await assert.rejects(runJob({jobSpec:spec(),backend:{...sameSandboxOnly,prepare:()=>assert.fail('declined first')}}),{code:'policy_unenforceable'});
});

test('P9 backend preserves the agent reserve and bounds the check command by the job deadline',async()=>{
  let clock=0;const calls=[],backend=new DockerSbxBackend({monotonic:()=>clock});
  const handle={sandbox_id:'same-sandbox',_entrypoint:'agent',_deadline:{endsAt:600000},_execution:{}};
  backend._runJobCommand=async(h,args)=>{assert.equal(h,handle);calls.push(args);return {code:0,stdout:'',stderr:''};};
  clock=30000;await backend.start(handle,{reserveSeconds:180});
  assert.match(calls[0].at(-1),/timeout --signal=KILL 390s sh -c 'agent'/);
  // The check command has no guest timeout binary: the host watchdog stops it CHECK_STOP_MS before the deadline.
  clock=570000;assert.equal((await backend.verify(handle,{cmd:'npm test',workdir:'repo'})).timeout_ms,30000-CHECK_STOP_MS);
  assert.equal(calls.at(-1).at(-1),"cd 'repo' && sh -c 'npm test'");
  const commands=calls.length;
  clock=599500;assert.deepEqual(await backend.verify(handle,{cmd:'npm test',workdir:'repo'}),{exit:null,timed_out:false,stdout:'',skipped:'time'});
  assert.equal(calls.length,commands,'no command starts without check time');
  await assert.rejects(backend.start(handle,{reserveSeconds:180}),{code:'wall_timeout'});
  backend._runJobCommand=async()=>({code:137,stdout:'partial',stderr:''});clock=0;
  await backend.start(handle,{reserveSeconds:180});
  assert.equal(handle._lastExecStdout,'partial');
});

test('P9 inventory script observes content, permissions and symlink changes without following links',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'p9-inventory-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await mkdir(join(dir,'repo'));await writeFile(join(dir,'repo/package.json'),'{}');
  const backend=new DockerSbxBackend();
  backend._runJobCommand=async(_h,args)=>({code:0,stdout:execFileSync('sh',['-c',args.at(-1)],{cwd:dir}).toString()});
  const before=await backend.verificationFiles({},'repo');
  await writeFile(join(dir,'repo/package.json'),'{"scripts":{}}');
  await symlink('/missing-private-file',join(dir,'repo/link.test.js'));
  const after=await backend.verificationFiles({},'repo');
  assert.deepEqual(changedTestFiles(before,after),['link.test.js','package.json']);
});

for(const observed of [{exit:1,timed_out:false},{exit:137,timed_out:true}])
test('P9 signed job, downgrade and result delivery: '+JSON.stringify(observed),async t=>{
  const f=await lenderFixture(t,{mutateJob:job=>{job.verify={cmd:'npm test'};job.requirements.capabilities=['verify_v1'];job.requirements.limits.wall_seconds=300;}});
  const capability=f.backend.lenderCapabilities;
  f.backend.lenderCapabilities=()=>({...capability(),capabilities:['verify_v1']});
  f.backend.verificationFiles=async()=>'';f.backend.verify=async()=>({...observed,timeout_ms:180000,stdout:'# pass 2\n# fail 1'});
  const req=f.job.payload.requirements,report=f.backend.lenderCapabilities();
  assert.equal(p.validateRequirements(req,{recognizedCapabilities:['patch-output']}).ok,false);
  assert.equal(p.canSatisfy(req,{harnesses:['codex'],models:[],capabilities:[],egress:report.egress,
    enforced_limits:report.enforced_limits,max_limits:report.max_limits}).ok,false);
  const controller=new AbortController(),lender=createLender({...f.runOptions,client:f.client,backend:f.backend,adapters:f.adapters,
    policy:f.policy,clock:f.clock,approve:async()=>true,onEvent:e=>f.events.push(e)});
  const running=lender.start(controller.signal).catch(e=>{if(!controller.signal.aborted)throw e;});
  f.stop=async()=>{controller.abort();await running;};
  await until(()=>f.result,'verified result');await f.stop();
  assert.equal(f.calls.find(([kind])=>kind==='prepare')[1].verify.cmd,'npm test');
  const evidence=f.result.payload.checks[0];assert.equal(evidence.exit,observed.exit);assert.equal(evidence.timed_out,observed.timed_out);assert.equal(evidence.summary,'2 passed, 1 failed');
  assert.ok(f.calls.some(([kind])=>kind==='prepareCheck'),'checks ran in a separate sandbox');
  assert.equal(evidence.timeout_ms,180000);assert.ok(Number.isSafeInteger(evidence.duration_ms)&&evidence.duration_ms>=0);
  assert.equal('skipped' in evidence,false,'a command that ran is never marked skipped');
  const key=p.generateDeviceKeyPair().privateKey;
  const signed=p.signEnvelope('result',f.result.payload,key);
  assert.equal(p.verifyEnvelope('result',signed,p.exportPublicKey(key)).ok,true);
  signed.payload.checks[0].exit=0;assert.equal(p.verifyEnvelope('result',signed,p.exportPublicKey(key)).ok,false);
  for(const bad of [{summary:'x'.repeat(121)},{observed_by:'agent'},{exit:256},{changed_test_files:['../secret.test.js']},
    {duration_ms:-1},{timeout_ms:1.5},{skipped:'raw sbx error'},{skipped:CHECK_SKIPPED.time}])
    assert.throws(()=>p.signEnvelope('result',{...f.result.payload,checks:[{...evidence,...bad}]},key));
  const old={...f.result.payload};delete old.checks;assert.doesNotThrow(()=>p.signEnvelope('result',old,key));
  const noCapability=structuredClone(f.job.payload);noCapability.requirements.capabilities=[];
  assert.throws(()=>p.signEnvelope('job',noCapability,key));
  assert.equal(p.digest({...f.job.payload,verify:{cmd:'different'}})===p.digest(f.job.payload),false);
});

test('the borrower reads the sandbox checks with the verified result, apart from the receipt; no checks, no field',async t=>{
  const f=await realLenderFixture(t,{mutateJob:job=>{job.verify={cmd:'npm test'};job.requirements.capabilities=['verify_v1'];job.requirements.limits.wall_seconds=300;}});
  const capability=f.backend.lenderCapabilities;
  f.backend.lenderCapabilities=()=>({...capability(),capabilities:['verify_v1']});
  f.backend.verificationFiles=async()=>'';f.backend.verify=async()=>({exit:1,timed_out:false,stdout:'# pass 2\n# fail 1'});
  const controller=new AbortController(),lender=createLender({...f.runOptions,client:f.client,backend:f.backend,adapters:f.adapters,
    policy:f.policy,clock:f.clock,approve:async()=>true,onEvent:e=>f.events.push(e)});
  const running=lender.start(controller.signal).catch(e=>{if(!controller.signal.aborted)throw e;});
  await until(()=>f.events.some(e=>e.status==='finished'),'finished result');controller.abort();await running;
  const view=await f.owner.getJob(f.jobDigest),attempt=view.current_attempt;assert.equal(view.state,'result-accepted');
  const read=await f.owner.fetchResult(f.jobDigest,{attempt,includeMetadata:true});
  assert.deepEqual(read.checks.map(c=>[c.cmd,c.exit,c.timed_out,c.summary,c.observed_by]),[['npm test',1,false,'2 passed, 1 failed','sandbox']]);
  assert.equal('checks' in read.receipt,false,'the receipt stays the lender\'s self-report');
  assert.equal(read.receipt.self_reported,true);
});

test('P9 a check sandbox that cannot start still delivers the work, signed, with a fixed skipped reason and no timing',async t=>{
  const f=await lenderFixture(t,{mutateJob:job=>{job.verify={cmd:'npm test'};job.requirements.capabilities=['verify_v1'];job.requirements.limits.wall_seconds=300;}});
  const capability=f.backend.lenderCapabilities;
  f.backend.lenderCapabilities=()=>({...capability(),capabilities:['verify_v1']});
  f.backend.verificationFiles=async()=>'';f.backend.verify=async()=>assert.fail('no command without a check workspace');
  f.backend.prepareCheck=async()=>{throw Object.assign(new Error('sbx: raw boot failure /home/lender/secret'),{code:'sandbox_ready_timeout',cleanup_receipt:{removed:true}});};
  const controller=new AbortController(),lender=createLender({...f.runOptions,client:f.client,backend:f.backend,adapters:f.adapters,
    policy:f.policy,clock:f.clock,approve:async()=>true,onEvent:e=>f.events.push(e)});
  const running=lender.start(controller.signal).catch(e=>{if(!controller.signal.aborted)throw e;});
  f.stop=async()=>{controller.abort();await running;};
  await until(()=>f.result,'result with a skipped check');await f.stop();
  assert.deepEqual(f.result.payload.checks,[{cmd:'npm test',exit:null,timed_out:false,parser:null,summary:'',
    skipped:CHECK_SKIPPED.workspace,changed_test_files:[],observed_by:'sandbox'}]);
  assert.doesNotMatch(JSON.stringify(f.result.payload),/raw boot|secret/);
});
