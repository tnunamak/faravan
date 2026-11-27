import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {lendingMeterJobId} from '../lib/docker-backend.mjs';
import {fileSbx, receiptBackend, receiptJob, receiptedHandle, testSbxRuntimeFields} from './helpers/sandbox-receipt-fixture.mjs';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT, HOUR_MS, MICRO, NOW, WEEK} from './helpers/pace50-fixtures.mjs';

test('a dead job retains its hold across restart, deadlines and controls; confirmed absence permits full charge only', async t => {
  const directory=fs.mkdtempSync(join(tmpdir(),'dead-hold-'));
  let at=NOW, absent=false, listingFailed=false;
  const source=createSyntheticPace50Source({start:NOW,kappa:{weekly:MICRO,short:MICRO},
    override:({base})=>({...base,resources:base.resources.filter(r=>r.kind==='weekly')})});
  const {DockerSbxBackend}=await import('../lib/docker-backend.mjs');
  const listing=()=>listingFailed ? {code:1,stderr:'unrecognised inventory service failure'}
    : {code:0,stdout:absent?'[]':'[{"name":"wf-0123456789abcdef"}]'};
  const backend=new DockerSbxBackend({runCommand:async()=>listing(),storage:{available:async()=>false},
    legacyDaemonOptions:{platformName:'darwin',runProcessCommand:async()=>({code:0,stdout:'  PID  PPID COMMAND\n 1 0 /sbin/launchd\n'})}});
  const pending={...testSbxRuntimeFields(backend._profileHome),...backend.sandboxOwnership(),attemptId:'dead',jobId:'job'};
  const open=()=>createPace50Candidate({directory,now:()=>at,account:ACCOUNT,account_week_id:WEEK,source,backend,pendingRecords:()=>[pending]});
  let pace=open();
  t.after(async()=>{await pace.adapter.close();fs.rmSync(directory,{recursive:true,force:true});});
  const reserve=attemptId=>pace.candidate.reserve({attemptId,jobId:'job',provider:'claude',model:'claude-haiku-5-5',
    job:{requirements:{limits:{wall_seconds:300}},expires_at:new Date(at+HOUR_MS).toISOString()},automatic:true,ownerAbsent:true});
  assert.equal((await reserve('dead')).ok,true);
  await pace.candidate.started('dead',{ok:true});
  const row=()=>pace.adapter.state().attempts.find(a=>a.id==='dead');
  const held=row().resources[0].held_micro;
  await pace.adapter.close();pace=open();await pace.adapter.recover();
  for(const elapsed of [HOUR_MS,7*24*HOUR_MS,365*24*HOUR_MS]){
    at=NOW+elapsed;await pace.candidate.probeHeld();
    assert.equal(row().resources[0].held_micro,held);
    assert.notEqual(row().hold_closed,true);
  }
  for(const type of ['pause','stop','on']){
    await pace.adapter.deliver({type,event_id:type,at});
    assert.equal(row().resources[0].held_micro,held);
  }
  assert.equal((await pace.candidate.release('dead',{reason:'cancel',prepared:false})).applied,false);
  assert.equal((await reserve('new')).ok,false,'stale exposure blocks a later lend');
  assert.equal((await pace.candidate.releaseHold('dead',{confirmed:false})).applied,false);
  assert.equal((await pace.candidate.releaseHold('dead',{confirmed:true})).applied,false,'unknown/live inventory refuses');
  await t.test('an unrecognised listing error refuses owner release and blocks lending despite healthy diagnostics',async()=>{
    absent=true;listingFailed=true;
    t.mock.method(backend,'_hostDiskCheck',async()=>({name:'host_disk',ok:true}));
    const runCommand=async(_command,args)=>{
      if(args[0]==='ls')return listing();
      if(args[0]==='version')return {code:0,stdout:'sbx version: v0.51.0 abc123'};
      if(args[0]==='diagnose')return {code:0,stdout:'Daemon healthy\nAuthentication healthy'};
      if(args[0]==='policy')return {code:0,stdout:'Global network policy: deny-all'};
      if(args[0]==='run')return {code:0,stdout:['-d','--detach-keys','--name','--kit','--cpus','--memory',
        '--skills','--static-mcp','--deny-network'].join('\n')};
      throw Error('Unexpected fake command: '+args.join(' '));
    };
    const capabilities=()=>backend.lenderCapabilities({runCommand,platformName:'darwin',sbxHomePath:'/fixture-sbx',
      userHome:'/fixture-owner',realpathPath:()=>'/fixture-keychains'});
    const report=await capabilities();
    assert.equal(report.available,false);
    assert.deepEqual(report.preflight.checks.filter(check=>!check.ok).map(check=>check.name),['docker_login']);
    assert.equal(report.preflight.checks.find(check=>check.name==='docker_login').unknown,true);
    const before=structuredClone(pace.adapter.state());
    assert.equal((await pace.candidate.releaseHold('dead',{confirmed:true})).applied,false);
    assert.deepEqual(pace.adapter.state(),before,'failed inventory preserves the entire hold');
    listingFailed=false;
    assert.equal((await capabilities()).available,true,'a successful listing restores lending readiness');
  });
  absent=true;
  assert.equal((await pace.candidate.releaseHold('dead',{confirmed:true})).applied,true);
  assert.equal(row().resources[0].held_micro,held,'absence alone does not remove late exposure');
  await pace.adapter.close();pace=open();
  const discount=await pace.adapter.transition({type:'cessation_proven',event_id:'discount',at,attempt_id:'dead',
    authoritative_cessation:true,usage_reconciled:true,zero_use_attested:true},{expectedRevision:pace.adapter.state().revision});
  assert.equal(discount.reason,'manual_full_charge_pending');
  for(const type of ['late_ack','launch_result']){
    const late=await pace.adapter.transition({type,event_id:'after-release-'+type,at,attempt_id:'dead',
      ok:true,may_have_started:true,authoritative_cessation:false},{expectedRevision:pace.adapter.state().revision});
    assert.equal(late.applied,false);
    assert.equal(late.reason,'manual_full_charge_pending');
  }
  for(const type of ['cross_reset_reconciled','late_exposure_carried']){
    await t.test('owner recovery refuses '+type,async()=>{
      const before=structuredClone(pace.adapter.state());
      const late=await pace.adapter.transition({type,event_id:'after-release-'+type,at,attempt_id:'dead'},
        {expectedRevision:before.revision});
      assert.equal(late.applied,false);
      assert.deepEqual(pace.adapter.state(),before,'refusal preserves the full hold and durable events');
      assert.equal(late.reason,'manual_full_charge_pending');
    });
  }
  at+=7*24*HOUR_MS-1;await pace.candidate.probeHeld();
  assert.equal(row().resources[0].held_micro,held,'one millisecond before the weekly protection deadline');
  at++;await pace.candidate.probeHeld();
  assert.equal(row().resources[0].held_micro,0);
  assert.equal(row().resources[0].spent_micro,held);
  assert.equal(row().resources[0].released_micro,0);
  const revision=pace.adapter.state().revision;
  assert.equal((await pace.candidate.releaseHold('dead',{confirmed:true})).applied,true);
  assert.equal(pace.adapter.state().revision,revision);
});

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

test('release command is consequential and requires CLI confirmation', async()=>{
  const {opById}=await import('../lib/v1/ops/registry.mjs');
  const {opsRoute}=await import('../lib/v1/ops/cli.mjs');
  const op=opById('lending.release_hold');
  assert.equal(op.safety,'consequential');
  assert.equal(op.rest.fixed,undefined);
  assert.match(op.confirm({}),/without a refund/);
  assert.equal(opsRoute(['lending','release-hold']).op.id,op.id);
});

test('doctor names a fake stuck hold without resetting it', async t=>{
  const {createRequire}=await import('node:module');
  const {cmdDoctor}=createRequire(import.meta.url)('../bin/faravan');
  const home=fs.mkdtempSync(join(tmpdir(),'dead-hold-doctor-'));
  const saved=process.env.FARAVAN_HOME;
  process.env.FARAVAN_HOME=home;
  t.after(()=>{if(saved===undefined)delete process.env.FARAVAN_HOME;else process.env.FARAVAN_HOME=saved;fs.rmSync(home,{recursive:true,force:true});});
  fs.mkdirSync(join(home,'v1'));
  const file=join(home,'v1','lending-pace50-state.json');
  const text=JSON.stringify({attempts:[{id:'dead',hold_closed:false,resources:[{held_micro:100,unrepresented_micro:0}]}]});
  fs.writeFileSync(file,text);
  let output='';
  t.mock.method(process.stdout,'write',chunk=>{output+=chunk;return true;});
  await cmdDoctor(['--quick'],{storeFree:async()=>null,backendFactory:()=>({probeCapabilities:async()=>({preflight:{ok:true,checks:[]}})})});
  assert.match(output,/HOLD dead:.*faravan lending release-hold --attempt-id 'dead' --yes/);
  assert.match(output,/charged in full.*wait/);
  assert.doesNotMatch(output,/reset protection|durable cessation|cold window|late exposure|sandbox shims|aggregate usage/i);
  assert.equal(fs.readFileSync(file,'utf8'),text);
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

test('release confirmation is supplied by the caller, never by the operation body',async()=>{
  const {runOp}=await import('../lib/v1/ops/execute.mjs');
  const {opById}=await import('../lib/v1/ops/registry.mjs');
  assert.equal(opById('lending.release_hold').rest.fixed,undefined);
  const calls=[];
  const ctx={rest:async(...args)=>{calls.push(args);return {};}};
  await assert.rejects(runOp('lending.release_hold',{attemptId:'dead'},ctx),{code:'confirmation_required'});
  assert.equal(calls.length,0);
  await runOp('lending.release_hold',{attemptId:'dead'},{...ctx,confirmed:true});
  assert.deepEqual(calls[0][2].body,{attemptId:'dead'});
  assert.equal(calls[0][2].headers['faravan-confirm'],'yes');
});

test('release CLI asks y/N at a terminal and requires --yes in scripts',async()=>{
  const {runOpsCommand}=await import('../lib/v1/ops/cli.mjs');
  const {PassThrough}=await import('node:stream');
  const calls=[],args=['lending','release-hold','--attempt-id','dead'];
  const options={client:{call:async(...args)=>{calls.push(args);return {};}},stdout:{write:()=>{}},stderr:{write:()=>{}},stdin:{isTTY:false}};
  assert.equal(await runOpsCommand(args,options),6);assert.equal(calls.length,0);
  assert.equal(await runOpsCommand([...args,'--yes'],options),0);assert.equal(calls.pop()[2].confirmed,true);
  for(const answer of ['n','y']){
    const stdin=new PassThrough();stdin.isTTY=true;let prompt='';
    const result=runOpsCommand(args,{...options,stdin,stderr:{write:text=>{
      prompt+=text;if(text.includes('[y/N]'))setImmediate(()=>stdin.end(answer+'\n'));
    }}});
    assert.equal(await result,answer==='y'?0:6);assert.match(prompt,/\[y\/N\]/);
  }
  assert.equal(calls.length,1);assert.equal(calls[0][2].confirmed,true);
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
const environments=new WeakSet();

async function rig(t) {
  const root=fs.mkdtempSync(join(tmpdir(),'receipt-absence-'));
  if(!environments.has(t)) {
    environments.add(t);
    const saved=Object.fromEntries(['FARAVAN_SBX_HOME','FARAVAN_SCRATCH_ROOT'].map(key=>[key,process.env[key]]));
    t.after(()=>{for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;});
  }
  process.env.FARAVAN_SBX_HOME=join(root,'sandbox-home');
  process.env.FARAVAN_SCRATCH_ROOT=join(root,'scratch');
  fs.mkdirSync(process.env.FARAVAN_SBX_HOME);fs.mkdirSync(process.env.FARAVAN_SCRATCH_ROOT);
  let pace,afterListing=async()=>{};
  const sbx=fileSbx(join(root,'sbx'));
  const run=sbx.run;
  sbx.run=async(...args)=>{const result=await run(...args);if(args[0][0]==='ls')await afterListing();return result;};
  const backend=receiptBackend(root,sbx,{legacyDaemonOptions:{platformName:'linux',inspectProcesses:async()=>({complete:true,references:[]})}});
  const pending={...testSbxRuntimeFields(backend._profileHome),...backend.sandboxOwnership(),attemptId,jobId,attempt:{attempt_id:attemptId}};
  const directory=join(root,'policy');
  const source=createSyntheticPace50Source({start:NOW,kappa:{weekly:MICRO,short:MICRO},
    override:({base})=>({...base,resources:base.resources.filter(row=>row.kind==='weekly')})});
  const open=()=>createPace50Candidate({directory,now:()=>NOW,account:ACCOUNT,account_week_id:WEEK,source,backend,pendingRecords:()=>[pending]});
  pace=open();
  t.after(async()=>{
    await pace.adapter.close();
    fs.rmSync(root,{recursive:true,force:true});
  });
  const grant=await pace.candidate.reserve({attemptId,jobId,provider:'claude',model:'claude-haiku-5-5',
    job:{requirements:{limits:{wall_seconds:300}},expires_at:new Date(NOW+HOUR_MS).toISOString()},automatic:true,ownerAbsent:true});
  assert.equal(grant.ok,true,JSON.stringify(grant));
  await pace.candidate.started(attemptId,{ok:true});
  await pace.adapter.close();pace=open();await pace.adapter.recover();
  const row=()=>pace.adapter.state().attempts.find(row=>row.id===attemptId);
  const bytes=()=>fs.readFileSync(join(directory,'lending-pace50-state.json'),'utf8');
  const prove=()=>backend.proveHoldAbsent({attemptId,jobId,pending});
  const release=()=>pace.candidate.releaseHold(attemptId,{confirmed:true});
  const handle=async(job=jobId,options={})=>{
    const h=await receiptedHandle(backend,{job_id:job,...options});
    backend.cleanupJournal.finish(h,{}); // A dead holder leaves the durable receipt, with no live lease.
    return h;
  };
  return {root,sbx,backend,pending,row,bytes,prove,release,handle,get pace(){return pace;},
    onListing:fn=>{afterListing=fn;},restart:async()=>{await pace.adapter.close();pace=open();await pace.adapter.recover();}};
}

test('absence checks every receipted dispatch across five roles, including repeated names per role', async t=>{
    const f=await rig(t);
    const roles=[jobId,jobId+'-git',jobId+'-check',jobId+'-check-git',lendingMeterJobId(attemptId)];
    const handles=[];
    for(const role of roles)for(let repeat=0;repeat<2;repeat++)handles.push(await f.handle(role,{created:false,settled:false}));
    assert.equal(new Set(handles.map(h=>h.sandbox_id)).size,10);
    const directory=join(f.root,'profile','v1','sandbox-cleanup');
    const records=handles.map(h=>({file:join(directory,h._cleanupId+'.json'),
      row:JSON.parse(fs.readFileSync(join(directory,h._cleanupId+'.json'),'utf8'))}));
    const failures=[];
    for(const h of handles) {
      // Only this dispatch is unsettled; another unresolved row cannot mask a missed role.
      for(const {file,row} of records)fs.writeFileSync(file,JSON.stringify(row._cleanupId===h._cleanupId?row:
        {...row,compute_stopped:true,create_settled:true,data_cleanup:'removed',policy_cleanup:'removed'}));
      // A listed physical name always vetoes, whether the row has a success receipt or not.
      await f.sbx.run(['create','--name',h.sandbox_id]);
      assert.equal((await f.prove()).absent,false,h.sandbox_id);
      await f.sbx.run(['rm','--force',h.sandbox_id]);
      const out=await f.prove();
      if(out.absent===true)failures.push(h.sandbox_id);
    }
    assert.deepEqual(failures,[],'every unsettled dispatched row vetoes even an empty inventory');
  });

test('foreign owner, job, name and HOME receipt bindings refuse recovery and never authorize removal', async t=>{
    const failures=[];
    for(const field of ['owner_scope','job_id','sandbox_id','sbx_home']) {
      const f=await rig(t),h=await f.handle();
      const file=join(f.root,'profile','v1','sandbox-cleanup',h._cleanupId+'.json');
      const row=JSON.parse(fs.readFileSync(file,'utf8'));
      row[field]=field==='sandbox_id'?'wf-0000000000000000':field==='sbx_home'?join(f.root,'other-home'):'foreign';
      fs.writeFileSync(file,JSON.stringify(row));
      await f.sbx.run(['create','--name',h.sandbox_id]);
      const calls=f.sbx.calls().length;
      assert.equal((await f.backend.destroy(h)).removed,false,'foreign receipt cannot authorize deletion');
      assert.equal(f.sbx.calls().slice(calls).some(args=>args[0]==='rm'),false);
      await f.sbx.run(['rm','--force',h.sandbox_id]); // Simulated outside removal is not a receipt repair.
      const before=f.bytes(),out=await f.release();
      if(out.applied!==false||out.reason!=='cessation_unverified'||f.bytes()!==before)failures.push(field);
    }
    assert.deepEqual(failures,[],'foreign or mismatched retained history must keep the hold without a policy event');
  });

test('a dispatched exit-one create stays creation_unproven after restart; never-dispatched reservation is the control', async t=>{
    const f=await rig(t);
    const sandbox_id='wf-'+randomBytes(8).toString('hex');
    const reserved={...testSbxRuntimeFields(f.backend._profileHome),job_id:'never-dispatched',sandbox_id,
      scratch_dir:fs.mkdtempSync(join(process.env.FARAVAN_SCRATCH_ROOT,'wf-job-'+sandbox_id+'-'))};
    f.backend.cleanupJournal.register(reserved);
    f.backend.cleanupJournal.finish(reserved,{});
    assert.equal((await f.backend.destroy(reserved)).removed,true,'reserved with no dispatch can be resolved');
    const failed=fileSbx(join(f.root,'failed-sbx'),{create:async()=>({code:1,stderr:'invalid image',materialize:false})});
    const backend=receiptBackend(f.root,failed);
    await assert.rejects(backend.prepare(receiptJob({job_id:jobId})),{code:'sandbox_start_failed'});
    assert.equal(failed.created().length,1);
    assert.deepEqual(failed.read(),[]);
    const restarted=receiptBackend(f.root,failed);
    assert.equal((await restarted.reconcilePending(f.pending)).removed,false);
    assert.ok(restarted.cleanupStatus().remediation.some(row=>row.reason==='creation_unproven'));
    const before=f.bytes(),held=f.row().resources.map(row=>row.held_micro);
    const out=await f.release();
    assert.deepEqual(f.row().resources.map(row=>row.held_micro),held,'unknown create cannot release any reservation');
    assert.equal(out.applied,false,'two empty inventories cannot prove a dispatched failed create never started');
    assert.equal(f.bytes(),before);
  });


test('unreadable and unresolved cleanup records refuse release without changing policy or journal',async t=>{
  for(const state of ['unreadable','dispatched','creation_unproven']) {
    const f=await rig(t),h=await f.handle(jobId,{created:false,settled:false});
    const file=join(f.root,'profile','v1','sandbox-cleanup',h._cleanupId+'.json');
    const row=JSON.parse(fs.readFileSync(file,'utf8'));
    if(state==='creation_unproven')row.unknown=state;
    const text=state==='unreadable'?'invalid json':JSON.stringify(row);
    fs.writeFileSync(file,text);
    const before=f.bytes(),held=f.row().resources.map(row=>row.held_micro);
    const out=await f.release();
    assert.equal(out.applied,false,state);
    assert.equal(out.reason,'cessation_unverified');
    assert.equal(out.detail,'sandbox_cleanup_unverified');
    assert.equal(f.bytes(),before);
    assert.deepEqual(f.row().resources.map(row=>row.held_micro),held);
    assert.equal(fs.readFileSync(file,'utf8'),text,'absence proof must not repair or delete records');
  }
});

test('matching settled records and an empty never-dispatched journal permit only full-charge recovery',async t=>{
  for(const withRows of [false,true]) {
    const f=await rig(t);
    if(withRows)for(const role of [jobId,jobId+'-git',jobId+'-check',jobId+'-check-git',lendingMeterJobId(attemptId)]) {
      const h=await f.handle(role);
      const file=join(f.root,'profile','v1','sandbox-cleanup',h._cleanupId+'.json');
      const row=JSON.parse(fs.readFileSync(file,'utf8'));
      fs.writeFileSync(file,JSON.stringify({...row,compute_stopped:true,data_cleanup:'removed',policy_cleanup:'removed'}));
    }
    const held=f.row().resources.map(row=>row.held_micro);
    assert.equal((await f.release()).applied,true);
    assert.deepEqual(f.row().resources.map(row=>row.held_micro),held);
    assert.ok(f.row().resources.every(row=>row.released_micro===0));
  }
});
