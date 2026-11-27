import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileSbx,receiptBackend,receiptJob} from './helpers/sandbox-receipt-fixture.mjs';
import {sandboxDeadlineClock,sandboxDeadlineUnit} from '../lib/sandbox-deadline.mjs';
import {appFixture,syntheticBackend,api,waitFor} from './helpers/v1-app-fixture.mjs';

function fixture(t,{count=16,root=fs.mkdtempSync(path.join(os.tmpdir(),'abandoned-create-')),directory=path.join(root,'profile','v1','sandbox-cleanup')}={}) {
  const prior=process.env.FARAVAN_SCRATCH_ROOT,scratch=path.join(root,'scratch');
  process.env.FARAVAN_SCRATCH_ROOT=scratch;fs.mkdirSync(scratch,{recursive:true});fs.mkdirSync(directory,{recursive:true});
  t.after(()=>{if(prior===undefined)delete process.env.FARAVAN_SCRATCH_ROOT;else process.env.FARAVAN_SCRATCH_ROOT=prior;fs.rmSync(root,{recursive:true,force:true});});
  const clock=sandboxDeadlineClock(),sbx=fileSbx(root),transport=sbx.run;
  sbx.run=async(args,options)=>args[0]==='policy'&&args[1]==='ls'
    ?{code:0,stdout:JSON.stringify({rules:[...sbx.policy.state.globalRules,...Object.values(sbx.policy.state.sandboxes).flat()]}),stderr:''}:transport(args,options);
  const backend=receiptBackend(root,sbx,{cleanupDirectory:directory,onReaperSummary:()=>{},...(count>16?{storage:{release:async()=>{}}}:{})}),owner=backend.sandboxOwnership();
  // A local deciding experiment may load byte copies. Committed coverage uses
  // the same v2 shape with synthetic identities, paths and clock values.
  const copies=process.env.CLEANUP_ROW_COPIES?fs.readdirSync(process.env.CLEANUP_ROW_COPIES).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(process.env.CLEANUP_ROW_COPIES,n)))):null;
  const rows=Array.from({length:count},(_,i)=>{
    const id=randomUUID(),name='wf-'+i.toString(16).padStart(16,'0'),watched=copies?copies[i%copies.length].watch_state==='watch_adopted':i===5;
    const row={...(copies?copies[i%copies.length]:{}),version:2,_cleanupId:id,...owner,job_id:'abandoned-'+i,sandbox_id:name,
      scratch_dir:path.join(scratch,'wf-job-'+name+'-'+randomUUID()),create:'dispatched',compute_created:false,create_settled:false,compute_stopped:false,
      data_cleanup:'pending',policy_cleanup:'pending',absent_since:clock.wall-3*3600000};
    if(watched)Object.assign(row,{create_incarnation:id,exec_fenced:true,watch_generation:randomUUID(),watch_state:'watch_adopted',watch_challenge:'fixture',watch_ack:{challenge:'fixture',binary:'/fake/sbx'},watch_debt_retry:{name:'reserved',policy_revoked:false,scratch:'awaiting_compute',storage:'awaiting_compute'},policy_rules_left:1});
    else {Object.assign(row,{deadline_at:clock.wall-2*3600000,deadline_clock:{version:1,boot_id:clock.boot_id,boot_at:clock.boot_ms-2*3600000}});row.deadline_enforcer={kind:'systemd',unit:sandboxDeadlineUnit(row),binary:'/fake/sbx'};}
    fs.mkdirSync(row.scratch_dir);fs.writeFileSync(path.join(directory,id+'.json'),JSON.stringify(row));return row;
  });
  const countRows=()=>fs.readdirSync(directory).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).length;
  return {root,directory,sbx,backend,rows,countRows};
}

test('old absent dispatched creates drain through data and name-scoped policy cleanup',async t=>{
  const f=fixture(t),owned=f.rows.find(row=>row.watch_state==='watch_adopted').sandbox_id,foreign='wf-eeeeeeeeeeeeeeee';
  await f.sbx.run(['policy','allow','network','--sandbox',owned,'example.test:443']);
  await f.sbx.run(['policy','allow','network','--sandbox',foreign,'other.test:443']);
  await f.backend.recoverSandboxDeadlines().catch(()=>{});
  await f.backend.reapCleanup();
  assert.equal(f.countRows(),0,'all old never-created rows must drain');
  assert.ok(f.rows.every(row=>!fs.existsSync(row.scratch_dir)));
  assert.equal(f.sbx.policy.state.sandboxes[owned]?.length??0,0);
  assert.equal(f.sbx.policy.state.sandboxes[foreign].length,1,'other names retain their rules');
  // Reopen the backend: the fence must survive process memory and row deletion.
  const restarted=receiptBackend(f.root,f.sbx,{cleanupDirectory:f.directory,onReaperSummary:()=>{}});
  await f.sbx.run(['create','--name',owned]);
  await f.sbx.run(['create','--name',foreign]);
  await restarted.reconcileOwnedSandboxes();
  assert.equal(f.sbx.read().includes(owned),false,'a late create is still removed');
  assert.equal(f.sbx.read().includes(foreign),true);
});

test('a create refused at the transport gate remains never-dispatched and leaves no row',async t=>{
  const f=fixture(t,{count:0});
  const original=f.backend._dispatchProtected.bind(f.backend);
  f.backend._dispatchProtected=async(handle,signal,launch,options)=>{if(options?.create)throw Object.assign(Error('admission refused'),{code:'cessation_unverified'});return original(handle,signal,launch,options);};
  // The injected transport participates in the same beforeExec hook as sbx.
  const run=f.backend.runSbx;
  f.backend.runSbx=async(args,options)=>{if(args[0]==='create')return options.beforeExec(()=>run(args,options));return run(args,options);};
  const register=f.backend.cleanupJournal.register;
  f.backend.cleanupJournal.register=(handle,options)=>{f.handle=handle;return register(handle,options);};
  await assert.rejects(f.backend.prepare(receiptJob()),{code:'cessation_unverified'});
  assert.equal(f.sbx.created().length,0);
  assert.equal(f.countRows(),0,'refusal before create must close the reservation');
});

for(const mode of ['unexpired','incomplete','other-home'])test(mode+' evidence cannot abandon a create',async t=>{
  const f=fixture(t,{count:1}),row=f.rows[0],file=path.join(f.directory,row._cleanupId+'.json');
  if(mode==='unexpired') {
    const clock=sandboxDeadlineClock();row.absent_since=clock.wall-1000;
    row.deadline_at=clock.wall+60000;row.deadline_clock={version:1,boot_id:clock.boot_id,boot_at:clock.boot_ms+60000};
  }
  if(mode==='other-home')row.sbx_home=path.join(f.root,'different-home');
  fs.writeFileSync(file,JSON.stringify(row));
  const run=f.backend.runSbx;
  if(mode==='incomplete')f.backend.runSbx=async(args,options)=>args[0]==='ls'?{code:0,stdout:'[]',stderr:'',truncated:true}:run(args,options);
  await f.backend.recoverSandboxDeadlines().catch(()=>{});
  await f.backend.reapCleanup().catch(error=>assert.equal(error.recovery_hold?.error_code,'sbx_daemon_unavailable'));
  assert.equal(f.countRows(),1);assert.ok(fs.existsSync(row.scratch_dir));
});

test('a failed policy removal retains the row and retries without touching another name',async t=>{
  const f=fixture(t,{count:1}),row=f.rows[0];
  await f.sbx.run(['policy','allow','network','--sandbox',row.sandbox_id,'example.test:443']);
  const run=f.backend.runSbx;
  f.backend.runSbx=async(args,options)=>args[0]==='policy'&&args[1]==='rm'?{code:1,stdout:'',stderr:'refused'}:run(args,options);
  await f.backend.recoverSandboxDeadlines().catch(()=>{});await f.backend.reapCleanup();assert.equal(f.countRows(),1);
  f.backend.runSbx=run;await f.backend.cleanupJournal.resolveJobs([row.job_id]);assert.equal(f.countRows(),0);
});

test('late-create policy debt retries even after compute disappears',async t=>{
  const f=fixture(t,{count:1}),row=f.rows[0];
  await f.backend.recoverSandboxDeadlines();assert.equal(f.countRows(),0);
  await f.sbx.run(['create','--name',row.sandbox_id]);
  const run=f.backend.runSbx;
  f.backend.runSbx=async(args,options)=>{
    if(args[0]==='rm'){fs.writeFileSync(path.join(f.root,'inventory.json'),'[]');return {code:0,stdout:'',stderr:''};}
    if(args[0]==='policy'&&args[1]==='rm')return {code:1,stdout:'',stderr:'refused'};
    return run(args,options);
  };
  await f.backend.reapCleanup();assert.equal(f.sbx.read().length,0);
  assert.equal(f.sbx.policy.state.sandboxes[row.sandbox_id].length,1);
  f.backend.runSbx=run;await f.backend.reapCleanup();
  assert.equal(f.sbx.policy.state.sandboxes[row.sandbox_id]?.length??0,0);
});

test('an adopted row without an absence timestamp records first absence and later drains',async t=>{
  const f=fixture(t,{count:1}),row=f.rows[0],file=path.join(f.directory,row._cleanupId+'.json');
  delete row.absent_since;delete row.deadline_at;delete row.deadline_clock;delete row.deadline_enforcer;
  Object.assign(row,{watch_state:'watch_adopted',create_incarnation:row._cleanupId,watch_generation:randomUUID(),watch_challenge:'fixture',watch_ack:{challenge:'fixture',binary:'/fake/sbx'}});
  fs.writeFileSync(file,JSON.stringify(row));
  await f.backend.cleanupJournal.resolveJobs([row.job_id]);
  const saved=JSON.parse(fs.readFileSync(file));
  assert.equal(Number.isFinite(saved.absent_since),true,'first complete absence must start the recovery window');
  assert.equal(saved.create_settled,false);
  f.backend._now=()=>saved.absent_since+360001;
  await f.backend.cleanupJournal.resolveJobs([row.job_id]);assert.equal(f.countRows(),0);
});

test('abandonment removes scoped GitHub residue even without an older row flag',async t=>{
  const f=fixture(t,{count:1}),row=f.rows[0],other='wf-eeeeeeeeeeeeeeee';
  f.sbx.secrets.push({scope:row.sandbox_id,type:'service',name:f.sbx.GITHUB_SERVICE},{scope:other,type:'service',name:f.sbx.GITHUB_SERVICE});
  await f.backend.recoverSandboxDeadlines();assert.equal(f.countRows(),0);
  assert.equal(f.sbx.secrets.some(item=>item.scope===row.sandbox_id),false);
  assert.equal(f.sbx.secrets.some(item=>item.scope===other),true);
});

test('a failed late-name removal cannot certify owned compute gone',async t=>{
  const f=fixture(t,{count:1}),row=f.rows[0];
  await f.backend.recoverSandboxDeadlines();await f.sbx.run(['create','--name',row.sandbox_id]);
  const run=f.backend.runSbx;
  f.backend.runSbx=async(args,options)=>args[0]==='rm'?{code:1,stdout:'',stderr:'refused'}:run(args,options);
  assert.equal((await f.backend.reconcileOwnedSandboxes()).removed,false);
  assert.equal(f.countRows(),0,'the permanent fence owns the late target');
  f.backend.runSbx=run;
  assert.equal((await f.backend.reconcileOwnedSandboxes()).removed,true);
  assert.equal(f.sbx.read().length,0);
});

for(const provenance of [true,false])test(provenance?'known kit residue on an absent fenced name resolves without native removal':'unproven provisioned policy still requires native name cleanup',async t=>{
  const f=fixture(t,{count:1}),row=f.rows[0],other='wf-eeeeeeeeeeeeeeee',file=path.join(f.directory,row._cleanupId+'.json');
  delete row.deadline_at;delete row.deadline_clock;delete row.deadline_enforcer;
  Object.assign(row,{watch_state:'watch_adopted',create_incarnation:row._cleanupId,watch_generation:randomUUID(),watch_challenge:'fixture',watch_ack:{challenge:'fixture',binary:'/fake/sbx'},policy_rules_left:1});
  fs.writeFileSync(file,JSON.stringify(row));
  const rule=name=>({id:'provisioned-'+name,scope:'sandbox:'+name,applies_to:'sandbox:'+name,resource_type:'network',status:'active',decision:'allow',
    resources:['example.test:443'],editable:false,layer:'local',origin:provenance?'scoped':'local',...(provenance?{provenance:{created_via:'provisioned',source:'sandboxes'}}:{})});
  f.sbx.policy.state.sandboxes[row.sandbox_id]=[rule(row.sandbox_id)];f.sbx.policy.state.sandboxes[other]=[rule(other)];
  const run=f.backend.runSbx;
  f.backend.runSbx=async(args,options)=>args[0]==='rm'?{code:0,stdout:'',stderr:''}:run(args,options);
  await f.backend.recoverSandboxDeadlines();
  assert.equal(f.countRows(),provenance?0:1,'only known kit residue on an absent fenced name resolves without policy removal');
  f.backend.runSbx=run;await f.backend.reapCleanup();
  assert.equal(f.countRows(),0,'the known provisioned-rule residue must not retain the row');
  assert.equal(f.sbx.policy.state.sandboxes[row.sandbox_id]?.length??0,provenance?1:0);
  assert.equal(f.sbx.policy.state.sandboxes[other].length,1,'another name retains its provisioned policy');
  if(!provenance)assert.ok(f.sbx.calls().some(args=>args[0]==='rm'&&args.at(-1)===row.sandbox_id));
  assert.ok(f.sbx.calls().filter(args=>args[0]==='rm').every(args=>args.at(-1)===row.sandbox_id));
  assert.equal(f.sbx.created().length,0,'cleanup never creates compute');
});

const rejectedReadbacks={
  'failed exit':{code:1,stdout:'[]',stderr:''},
  'invalid JSON':{code:0,stdout:'not-json',stderr:''},
  'non-array':{code:0,stdout:'{}',stderr:''},
  'invalid row':{code:0,stdout:'[{}]',stderr:''},
  'duplicate name':{code:0,stdout:'[{"name":"other"},{"name":"other"}]',stderr:''},
};
for(const [label,after] of Object.entries(rejectedReadbacks))for(const nativePolicy of [false,true])
test((nativePolicy?'native-policy':'late-name')+' cleanup retains debt after '+label,async t=>{
  const f=fixture(t,{count:1}),row=f.rows[0];
  if(nativePolicy){
    f.sbx.policy.state.sandboxes[row.sandbox_id]=[{id:'kit-rule',scope:'sandbox:'+row.sandbox_id,applies_to:'sandbox:'+row.sandbox_id,
      resource_type:'network',status:'active',decision:'allow',editable:false}];
  }else{
    await f.backend.recoverSandboxDeadlines();assert.equal(f.countRows(),0);
    await f.sbx.run(['create','--name',row.sandbox_id]);
  }
  let removed=false;const run=f.backend.runSbx;
  f.backend.runSbx=async(args,options)=>{
    if(args[0]==='rm'){
      removed=true;
      // Even if native metadata cleanup succeeds, bad compute readback must
      // retain data and the row rather than certify cessation.
      if(nativePolicy)delete f.sbx.policy.state.sandboxes[row.sandbox_id];
      return {code:1,stdout:'',stderr:''};
    }
    if(args[0]==='ls'&&removed)return after;
    return run(args,options);
  };
  if(nativePolicy){
    const original=f.backend._finishDestroy.bind(f.backend);let receipt;
    f.backend._finishDestroy=async(...args)=>receipt=await original(...args);
    // The service-availability rule reports an invalid owned listing as a
    // whole-pass refusal; the cleanup receipt must still retain its debt.
    await assert.rejects(f.backend.recoverSandboxDeadlines(),error=>error.recovery_hold?.error_code==='sbx_daemon_unavailable');
    assert.equal(receipt.removed,false,'invalid readback cannot certify absence');
    assert.equal(f.countRows(),1);assert.ok(fs.existsSync(row.scratch_dir));
  }else{
    assert.equal((await f.backend.reconcileOwnedSandboxes()).removed,false,'invalid readback cannot certify absence');
    const fence=JSON.parse(fs.readFileSync(path.join(f.directory,row.sandbox_id+'.scope.reserved')));
    assert.equal(fence.cleanup_pending,true);assert.ok(f.sbx.read().includes(row.sandbox_id));
  }
});

test('startup serves while 319 old rows drain in the background',async t=>{
  // This checks traversal and serving; per-write durability is covered separately.
  t.mock.method(fs,'fsyncSync',()=>{});
  const app=await appFixture(t),home=await app.home('hundreds'),directory=path.join(home,'v1','sandbox-cleanup');
  const f=fixture(t,{count:319,root:path.join(app.root,'compute'),directory}),backend=syntheticBackend(app.root);
  backend.sandboxOwnership=()=>f.backend.sandboxOwnership();
  for(const method of ['recoverSandboxDeadlines','deadlineRecoveryHold','cleanupStatus','reapCleanup'])backend[method]=(...args)=>f.backend[method](...args);
  let release;const pending=new Promise(resolve=>{release=resolve;}),recover=backend.recoverSandboxDeadlines;
  backend.recoverSandboxDeadlines=async(...args)=>{await pending;return recover(...args);};
  let timer,started;
  try {started=await Promise.race([app.start('hundreds',{backend,cleanupRecheckMs:20}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('startup waited for cleanup')),5000);})]);
    assert.ok(await api(started.app,'/api/status'));assert.equal(f.countRows(),319);
  }finally{clearTimeout(timer);release();}
  await waitFor(()=>f.countRows()===0,'hundreds of cleanup rows drain',30000);
  assert.ok(await api(started.app,'/api/status'));
});

for(const mode of ['absent','present','live-client','unknown-client','unavailable'])test('expired dispatch settles only with complete absence and no create client: '+mode,async t=>{
  const f=fixture(t,{count:1}),row=f.rows[0],file=path.join(f.directory,row._cleanupId+'.json');
  delete row.absent_since;
  fs.writeFileSync(file,JSON.stringify(row));
  f.backend._createClientAbsent=async()=>mode==='unknown-client'?null:mode!=='live-client';
  if(mode==='present')await f.sbx.run(['create','--name',row.sandbox_id]);
  const run=f.backend.runSbx;
  f.backend.runSbx=async(args,options)=>{
    if(mode==='unavailable'&&args[0]==='ls')return {code:1,stdout:'',stderr:'unavailable'};
    if(mode==='present'&&args[0]==='rm')return {code:1,stdout:'',stderr:'refused'};
    return run(args,options);
  };
  await f.backend.cleanupJournal.resolveJobs([row.job_id]);
  assert.equal(f.countRows(),mode==='absent'?0:1);
  assert.equal(fs.existsSync(row.scratch_dir),mode!=='absent');
  if(mode!=='absent')assert.notEqual(JSON.parse(fs.readFileSync(file)).create_abandoned,true);
});

test('a runtime fence refusal after dispatch publication leaves no dispatched obligation',async t=>{
  const f=fixture(t,{count:0}),run=f.backend.runSbx;
  f.backend.runSbx=async(args,options)=>{
    if(args[0]==='create')return options.beforeExec(()=>{throw Object.assign(Error('runtime changed before spawn'),{code:'claude_account_unavailable',sbxLaunchRefused:true});});
    return run(args,options);
  };
  await assert.rejects(f.backend.prepare(receiptJob()),{code:'claude_account_unavailable'});
  assert.equal(f.sbx.created().length,0);
  assert.equal(f.countRows(),0,'the runtime fence proves no create left the process');
});

for(const mode of ['absent','live','guard','truncated','stderr','failed','malformed','missing-newline','empty','throws'])test('create client absence proof: '+mode,async t=>{
  const f=fixture(t,{count:0}),name='wf-0123456789abcdef';
  f.backend._legacyDaemonOptions.runProcessCommand=async(command,args,options)=>{
    assert.equal(command,'/bin/ps');assert.deepEqual(args,['-ww','-axo','pid,ppid,command']);
    assert.deepEqual(options.env,{LC_ALL:'C'});assert.ok(options.timeout>0);
    if(mode==='throws')throw Error('process scan failed');
    const line=mode==='live'?` 2 1 /some/path/sbx create --name ${name}`:
      mode==='guard'?` 2 1 node sandbox-deadline-supervisor.mjs {"sandbox_id":"${name}","create":"dispatched"}`:' 2 1 /usr/bin/idle';
    return {code:mode==='failed'?1:0,stdout:mode==='empty'?'':mode==='malformed'?'PID PPID COMMAND\nunreadable\n':
      ' PID PPID COMMAND\n'+line+(mode==='missing-newline'?'':'\n'),truncated:mode==='truncated',stderr:mode==='stderr'?'warning':''};
  };
  assert.equal(await f.backend._createClientAbsent({sandbox_id:name}),['absent','guard'].includes(mode));
});

test('recorded absolute sbx runtime launches with a minimal PATH',async t=>{
  const f=fixture(t,{count:0}),binary=path.join(f.root,'sbx');
  fs.writeFileSync(binary,'#!/bin/sh\nprintf "[]\\n"\n',{mode:0o755});
  const {hostDefaultSbxRuntime,describeSbxRuntime}=await import('../lib/sbx-runtime.mjs');
  const {spawnSbxChild}=await import('../lib/docker-backend.mjs');
  const env={HOME:f.root,PATH:'/usr/bin:/bin'},runtime=hostDefaultSbxRuntime({binary,env,currentEnv:()=>env});
  assert.equal(describeSbxRuntime(runtime).binary.path,binary);
  const result=await spawnSbxChild(runtime,['ls','--json'],{env});
  assert.equal(result.stdout,'[]\n');assert.equal(result.stderr,'');
});
