import './helpers/no-browser.mjs';
import {testSbxRuntimeFields} from './helpers/sandbox-receipt-fixture.mjs';
import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {DockerSbxBackend,_internal} from '../lib/docker-backend.mjs';
import {legacySandboxNameFor as sandboxNameFor,sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import {sbxOwnerFile,readSbxOwner} from '../lib/sbx-daemon-owner.mjs';
import {createSandboxCleanupJournal} from '../lib/sandbox-cleanup-journal.mjs';
import {withCleanCredentialScope} from './helpers/sbx-clean-scope.mjs';
let root,saved;
beforeEach(async()=>{
  root=await mkdtemp(join(join(tmpdir(),'sr-XXXXXX').length<=22?tmpdir():'/tmp','sr-'));
  saved={FARAVAN_HOME:process.env.FARAVAN_HOME,FARAVAN_SCRATCH_ROOT:process.env.FARAVAN_SCRATCH_ROOT};
  process.env.FARAVAN_HOME=root;process.env.FARAVAN_SCRATCH_ROOT=join(root,'scratch');
  await writeFile(sbxOwnerFile(),JSON.stringify({id:'a'.repeat(64),executable:process.execPath}));
});
afterEach(async()=>{for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(root,{recursive:true,force:true});});
const job={job_id:'interrupted-create',image:'wf-faravan-guest@sha256:0000000000000000000000000000000000000000000000000000000000000000',entrypoint:'true',execution_scope:'owner',resources:{cpu:1,memory_mib:512,storage_mib:512,wall_seconds:60,output_bytes:1024,network_bytes:1024,max_processes:16},inputs:[],output_manifest:[],egress:'internet',provider_hosts:['**.openai.com']};
const result=(stdout='',code=0)=>({code,stdout,stderr:''});

for(const trigger of ['cancel','deadline kill','disk abort'])for(const failure of ['none','removal','first listing','final listing','refused create'])test(`${trigger} during create verifies cleanup (${failure})`,async()=>{
  let live=false,released=0,listing=0,handle;
  const backend=new DockerSbxBackend({cleanupDirectory:join(root,'journal'),deadlineTimers:{setTimeout(){return {unref(){}};},clearTimeout(){}},
    storage:{reserve:async()=>{},release:async()=>{released++;}},runCommand:withCleanCredentialScope(async args=>{
      if(args[0]==='ls'){
        listing++;
        if(failure==='first listing'||failure==='final listing'&&listing>1)return result('',1);
        return result(JSON.stringify(live?[{name:handle.sandbox_id,status:'running'}]:[]));
      }
      if(args[0]==='rm'){if(failure!=='removal')live=false;return result('',failure==='removal'?1:0);}
      return result('{"rules":[]}');
    })});
  const controller=new AbortController();
  let removals=0;
  // The interruption lands while the create runs. The create materializes;
  // its command reports success (a receipt) unless the create was refused.
  backend._runJobCommand=async(current,_args,_onLog,options={})=>{
    handle=current;options.onDispatch?.();live=true;
    if(trigger==='cancel')controller.abort();
    if(trigger==='deadline kill'){current._deadline.expired=true;current._deadline.controller.abort();}
    if(trigger==='disk abort')backend._diskSentries.get(current.sandbox_id).controller.abort();
    const outcome=result('',failure==='refused create'?1:0);options.onResult?.(outcome);
    return outcome;
  };
  const run=backend.runSbx.bind(backend);
  backend.runSbx=(args,...rest)=>{if(args[0]==='rm')removals++;return run(args,...rest);};
  let error;try{await backend.prepare(job,{signal:controller.signal});}catch(caught){error=caught;}
  assert.ok(handle,'the create command was reached');
  const receipt=error?.cleanup_receipt;
  const removed=failure==='none'||failure==='refused create';
  assert.equal(receipt?.removed,removed);
  if(removed){assert.equal(live,false);assert.ok(released>0);assert.equal((await readdir(join(root,'journal'))).filter(n=>n.endsWith('.json')).length,0);}
  else {assert.equal(released,0);assert.ok((await readdir(join(root,'journal'))).some(n=>n.endsWith('.json')));}
  if(failure==='refused create') {
    // The failed command still owns its permanently reserved physical name.
    assert.ok(removals>0);assert.equal(live,false);
    await assert.rejects(backend.admitJob({...job,sandbox_id:handle.sandbox_id}),{code:'cessation_unverified',recovery_scope:'target'});
  }
  assert.ok(listing>0);
});

test('an owner scope lookup never mints an owner record',async()=>{
  await rm(sbxOwnerFile());
  assert.throws(()=>sandboxOwnerScope(),/ownership.*missing|owner.*missing/i);
  assert.equal(existsSync(sbxOwnerFile()),false);
});

test('new cleanup rows record owner scope and sandbox HOME before creation',async()=>{
  const name=sandboxNameFor('scoped'),scratch=join(root,'scratch','wf-job-'+name+'-'+randomUUID());await mkdir(scratch,{recursive:true});
  const journal=createSandboxCleanupJournal({directory:join(root,'journal'),scratchRoot:()=>join(root,'scratch'),home:()=>_internal.sbxHome(),destroy:async()=>{}});
  const handle={ ...testSbxRuntimeFields(root),job_id:'scoped',sandbox_id:name,scratch_dir:scratch};journal.register(handle);journal.finish(handle,{});
  const row=JSON.parse(await readFile(join(root,'journal',handle._cleanupId+'.json'),'utf8'));
  assert.equal(row.owner_scope,readSbxOwner().id);assert.equal(row.sbx_home,_internal.sbxHome());
});

test('another install scope is foreign and does not block startup',async()=>{
  const name='wf-'+createHash('sha256').update('b'.repeat(64)+'\0foreign').digest('hex').slice(0,16),scratch=join(root,'scratch','wf-job-'+name+'-'+randomUUID());await mkdir(scratch,{recursive:true});
  const directory=join(root,'journal');await mkdir(directory);const id=randomUUID();
  await writeFile(join(directory,id+'.json'),JSON.stringify({ ...testSbxRuntimeFields(root),version:1,_cleanupId:id,owner_scope:'b'.repeat(64),job_id:'foreign',sandbox_id:name,scratch_dir:scratch}));
  const journal=createSandboxCleanupJournal({directory,scratchRoot:()=>join(root,'scratch'),home:()=>_internal.sbxHome(),destroy:async()=>assert.fail('foreign removal')});
  const proof=await journal.reconcileOwned({inventory:async()=>[],remove:async()=>assert.fail('foreign removal')});
  assert.equal(proof.removed,true);assert.ok(proof.foreign.includes(name));assert.ok(existsSync(join(directory,id+'.json')));
});

for(const state of ['absent','present','listing failed','no live daemon'])test(`legacy journal is read-only: ${state}`,async()=>{
  const name='wf-'+createHash('sha256').update('legacy').digest('hex').slice(0,16),directory=join(root,'journal'),id=randomUUID();
  const scratch=join(root,'scratch','wf-job-'+name+'-'+randomUUID());await mkdir(scratch,{recursive:true});await mkdir(directory);
  await writeFile(join(directory,id+'.json'),JSON.stringify({ ...testSbxRuntimeFields(root),version:1,_cleanupId:id,job_id:'legacy',sandbox_id:name,scratch_dir:scratch,sbx_home:_internal.sbxHome(),compute_stopped:false,data_cleanup:'owned',policy_cleanup:'owned'}));
  const commands=[];let releases=0;
  const backend=new DockerSbxBackend({home:root,cleanupDirectory:directory,storage:{release:async()=>{releases++;}},runCommand:async(args,options)=>{
    commands.push({args,env:options?.env});
    if(args[0]==='daemon')return result('Status: running');
    if(args[0]==='ls')return state==='listing failed'?result('',1):result(JSON.stringify(state==='present'?[{name,status:'running'}]:[]));
    assert.fail('legacy recovery must not mutate');
  },legacyDaemonOptions:{inspectDaemons:async()=>state==='no live daemon'?[]:[{pid:4242,environ:{HOME:_internal.sbxHome()}}],isProcessAlive:()=>true,inspectProcesses:async()=>({complete:true,references:[]})}});
  // An old record is reported and kept unless a verified listing and process
  // scan show its sandbox absent; then it closes without any sbx mutation.
  const proof=await backend.reconcileOwnedSandboxes();
  assert.equal(releases,0);
  if(state==='absent'){
    assert.equal(proof.removed,true);
    assert.equal(existsSync(join(directory,id+'.json')),false);
    assert.equal(existsSync(scratch),false);
  } else {
    assert.equal(proof.removed,false);
    assert.equal(existsSync(join(directory,id+'.json')),true);
    // The written availability rule reports failed inventory as a whole-service
    // blocker before row actions; other legacy debt stays individually named.
    if(state==='listing failed')assert.equal(backend.deadlineRecoveryHold().error_code,'sbx_daemon_unavailable');
    else assert.ok(proof.remediation?.some(row=>row.name===name));
  }
  assert.equal(commands.some(c=>['rm','stop','run','create'].includes(c.args[0])||c.args.join(' ')==='daemon start'),false);
  if(state==='present'){assert.match(JSON.stringify(proof),new RegExp(name));assert.match(JSON.stringify(proof),/rm --force/);}
  if(state==='absent'||state==='present')assert.ok(commands.filter(c=>c.args[0]==='ls').some(c=>c.env?.HOME===_internal.sbxHome()));
});

test('legacy pending checks old names without removal and settles only on a verified absent listing',async()=>{
  const old='wf-'+createHash('sha256').update('old-job').digest('hex').slice(0,16);let live=true,releases=0;const commands=[];
  const backend=new DockerSbxBackend({storage:{release:async()=>{releases++;}},runCommand:async args=>{commands.push(args);return args[0]==='daemon'?result('Status: running'):result(JSON.stringify(live?[{name:old,status:'running'}]:[]));},
    legacyDaemonOptions:{inspectDaemons:async()=>[{pid:4242,environ:{HOME:_internal.sbxHome()}}],isProcessAlive:()=>true,inspectProcesses:async()=>({complete:true,references:[]})}});
  const sourceDirectory=join(root,'v1'),scratchDir=join(root,'scratch','old-work');await mkdir(sourceDirectory);await mkdir(scratchDir,{recursive:true});
  const pending={ ...testSbxRuntimeFields(root),scratchDir,attemptId:'attempt',attempt:{attempt_id:'attempt'},jobId:'old-job',sbx_home:_internal.sbxHome()};
  assert.equal((await backend.reconcilePending(pending,{sourceDirectory})).removed,false);
  assert.equal(commands.some(args=>args[0]==='rm'||args[0]==='stop'),false);
  assert.equal(releases,0);live=false;
  const proof=await backend.reconcilePending(pending,{sourceDirectory});
  assert.equal(proof.removed,true);assert.equal(proof.full_charge,true,'usage of an old attempt is unknown');
  assert.equal(commands.some(args=>args[0]==='rm'||args[0]==='stop'),false);
});

test('legacy dead-scratch recovery never removes a live old name',async()=>{
  const name='wf-'+createHash('sha256').update('old-scratch').digest('hex').slice(0,16),parent=join(root,'scratch'),scratch=join(parent,'wf-job-'+name+'-'+randomUUID()),journal=join(root,'scratch-journal');
  await mkdir(scratch,{recursive:true});await mkdir(journal,{mode:0o700});
  await writeFile(join(journal,name+'.json'),JSON.stringify({ ...testSbxRuntimeFields(root),v:1,sandboxId:name,parent,scratch,ownerPid:2147483647,sbx_home:'/fixture/old'}),{mode:0o600});
  const commands=[];const backend=new DockerSbxBackend({scratchJournal:journal,runCommand:async args=>{commands.push(args);return args[0]==='daemon'?result('Status: running'):result(JSON.stringify([{name,status:'running'}]));},legacyDaemonOptions:{inspectDaemons:async()=>[{pid:4242,environ:{HOME:'/fixture/old'}}],isProcessAlive:()=>true}});
  await backend.reconcileOrphanedScratch();
  assert.equal(commands.some(args=>args[0]==='rm'||args[0]==='stop'),false);assert.ok(existsSync(scratch));
});

test('three rejected listings cannot become removal proof',async()=>{
  const name=sandboxNameFor('unreadable'),scratch=join(root,'scratch','wf-job-'+name+'-'+randomUUID());await mkdir(scratch,{recursive:true});let reads=0,releases=0;
  const backend=new DockerSbxBackend({cleanupDirectory:join(root,'journal'),storage:{release:async()=>{releases++;}},cleanupListingSleep:async()=>{},runCommand:async args=>args[0]==='ls'?(reads++,result('[]',1)):result()});
  const handle={ ...testSbxRuntimeFields(root),job_id:'unreadable',sandbox_id:name,scratch_dir:scratch};backend.cleanupJournal.register(handle);
  backend.cleanupJournal.mark(handle,{create:'dispatched',compute_created:true,create_settled:true});
  const proof=await backend.destroy(handle);
  assert.equal(proof.removed,false);assert.equal(releases,0);assert.equal(reads,3);
});

test('scratch scope is durable before the directory is created',async()=>{
  const {createSandboxScratch}=await import('../lib/sandbox-scratch.mjs');
  const name=sandboxNameFor('scope-write'),directory=join(root,'scratch-journal');
  const scratch=await createSandboxScratch(name,join(root,'scratch'),directory,{ownerScope:readSbxOwner().id,home:'/fixture/sandbox',beforeCreate:async path=>{
    const record=JSON.parse(await readFile(join(directory,name+'.json'),'utf8'));
    assert.equal(existsSync(path),false);assert.equal(record.owner_scope,readSbxOwner().id);assert.equal(record.sbx_home,'/fixture/sandbox');
  }});
  assert.ok(existsSync(scratch));
});

for(const cause of ['allowed','override','outside scratch','no daemon','process reference','scan unavailable','foreign directory'])test(`legacy HOME inference: ${cause}`,async()=>{
  const old='wf-'+createHash('sha256').update('legacy-inference').digest('hex').slice(0,16),directory=join(root,'journal'),id=randomUUID();
  const scratch=join(root,cause==='outside scratch'?'outside':'scratch','wf-job-'+old+'-'+randomUUID());await mkdir(scratch,{recursive:true});await mkdir(directory);
  await writeFile(join(directory,id+'.json'),JSON.stringify({ ...testSbxRuntimeFields(root),version:1,_cleanupId:id,job_id:'legacy-inference',sandbox_id:old,scratch_dir:scratch}));
  const savedOverride=process.env.FARAVAN_SBX_HOME;
  if(cause==='override')process.env.FARAVAN_SBX_HOME='/fixture/changed';
  const commands=[];let released=0;
  const backend=new DockerSbxBackend({home:cause==='foreign directory'?'/another/profile':root,cleanupDirectory:directory,storage:{release:async()=>{released++;}},runCommand:async(args,options)=>{
    commands.push({args,options});return args[0]==='daemon'?result('Status: running'):result('[]');
  },legacyDaemonOptions:{platformName:'linux',inspectDaemons:async({home})=>cause==='no daemon'?[]:[{pid:4242,environ:{HOME:home}}],isProcessAlive:()=>true,
    inspectProcesses:async()=>cause==='scan unavailable'?{complete:false,references:[]}: {complete:true,references:cause==='process reference'?[old]:[]}}});
  try {
    // Only complete evidence closes an old record; any gap reports and keeps it.
    const proof=await backend.reconcileOwnedSandboxes();assert.equal(proof.removed,cause==='allowed');assert.equal(released,0);
    assert.equal(existsSync(join(directory,id+'.json')),cause!=='allowed');
    assert.equal(commands.some(c=>c.args[0]==='rm'||c.args[0]==='stop'||c.args.join(' ')==='daemon start'),false);
  } finally {if(savedOverride===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=savedOverride;}
});

test('a closed legacy pending record retains its full charge despite zero-start evidence',async t=>{
  const {lenderFixture,until}=await import('./helpers/v1-lender-fixture.mjs');
  const {createLender}=await import('../lib/v1/lender.mjs');
  const f=await lenderFixture(t),attempt=f.attempt();
  f.policy.enabled=false;f.policy.recoveryOnly=true;f.policy.lendingRuntime={reconcileAttempt:async()=>{}};
  await f.policy.storage.set({day:'2026-10-09',jobs:1,milliseconds:120000,pending:{ ...testSbxRuntimeFields(root),attemptId:attempt.attempt_id,attempt,jobId:'legacy',reservedMs:120000,executionStartRequested:false,actualUse:{attemptId:attempt.attempt_id,ms:0}}});
  f.backend.reconcilePending=async row=>({removed:true,full_charge:true,attemptId:row.attemptId});
  const controller=new AbortController(),lender=createLender({...f.runOptions,client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock});
  const running=lender.start(controller.signal);running.catch(()=>{});
  try {await until(()=>f.saved().pending===null,'legacy record closes');assert.equal(f.saved().jobs,1);assert.equal(f.saved().milliseconds,120000);}
  finally {controller.abort();await running.catch(()=>{});}
});

test('Linux legacy process evidence scans every HOME and fails closed',async()=>{
  const {inspectLegacySandboxReferences}=await import('../lib/docker-backend.mjs');
  const proc=join(root,'proc'),pid=join(proc,'42');await mkdir(pid,{recursive:true});
  await writeFile(join(pid,'cmdline'),'other-tool\0wf-0123456789abcdef\0');
  await writeFile(join(pid,'environ'),'HOME=/a/different/home\0');
  await symlink(root,join(pid,'cwd'));
  const found=await inspectLegacySandboxReferences(['wf-0123456789abcdef'],{procRoot:proc});
  assert.equal(found.complete,true);assert.deepEqual(found.references,['wf-0123456789abcdef']);
  assert.equal((await inspectLegacySandboxReferences(['wf-0123456789abcdef'],{procRoot:join(root,'unavailable')})).complete,false);
});

for(const platformName of ['linux','darwin'])test(`legacy pending without HOME uses its own profile read-only on ${platformName}`,async()=>{
  const sourceDirectory=join(root,'v1'),scratchDir=join(root,'scratch','old-work');await mkdir(sourceDirectory);await mkdir(scratchDir,{recursive:true});
  const commands=[];
  const backend=new DockerSbxBackend({home:root,storage:{release:async()=>{}},runCommand:async(args,options)=>{
    commands.push({args,options});return args[0]==='daemon'?result('Status: running'):result('[]');
  },legacyDaemonOptions:{platformName,runProcessCommand:async()=>({code:0,stdout:'  PID  PPID COMMAND\n 1 0 /sbin/launchd\n',stderr:''}),inspectDaemons:async({home})=>platformName==='darwin'?[]:[{pid:4242,environ:{HOME:home}}],isProcessAlive:()=>true,
    inspectProcesses:async()=>{assert.equal(platformName,'linux');return {complete:true,references:[]};}}});
  const proof=await backend.reconcilePending({ ...testSbxRuntimeFields(root),scratchDir,jobId:'old-job',attemptId:'old-attempt',attempt:{attempt_id:'old-attempt'}},{sourceDirectory});
  assert.equal(proof.removed,true,'a verified absent listing closes an old pending attempt');
  assert.ok(commands.every(({args,options})=>['ls','daemon'].includes(args[0])&&options.env.HOME===_internal.sbxHome()));
});

test('a saved legacy cessation flag still requires a read-only check before Quit',async()=>{
  const {proveDurableCessation}=await import('../lib/v1/durable-cessation.mjs');
  const pending={ ...testSbxRuntimeFields(root),attemptId:'old-attempt',jobId:'old-job',attempt:{attempt_id:'old-attempt',job_digest:'old-digest',generation:1},cessationVerified:{attemptId:'old-attempt',jobDigest:'old-digest',generation:1}};
  let inspected=false;
  const proof=await proveDurableCessation({store:{directory:root,get:async()=>({pending})},backend:{reconcilePending:async(row,options)=>{inspected=true;assert.equal(options.sourceDirectory,root);return {removed:false,attemptId:row.attemptId};}}});
  assert.equal(proof.proven,false);assert.equal(inspected,true);
});

test('legacy scratch outside the profile cannot infer HOME from a shared journal',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'shared-scratch-journal-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const name='wf-'+createHash('sha256').update('shared-old-job').digest('hex').slice(0,16),parent=join(root,'scratch'),scratch=join(parent,'wf-job-'+name+'-'+randomUUID());
  await mkdir(scratch,{recursive:true});
  await writeFile(join(directory,name+'.json'),JSON.stringify({ ...testSbxRuntimeFields(root),v:1,sandboxId:name,parent,scratch,ownerPid:2147483647}),{mode:0o600});
  const backend=new DockerSbxBackend({home:root,scratchJournal:directory,storage:{release:async()=>assert.fail('unknown hold must remain')},runCommand:async args=>args[0]==='daemon'?result('Status: running'):result('[]'),
    legacyDaemonOptions:{inspectDaemons:async({home})=>[{pid:4242,environ:{HOME:home}}],isProcessAlive:()=>true,inspectProcesses:async()=>({complete:true,references:[]})}});
  await backend.reconcileOrphanedScratch();
  assert.equal(existsSync(scratch),true);assert.equal(existsSync(join(directory,name+'.json')),true);
});
