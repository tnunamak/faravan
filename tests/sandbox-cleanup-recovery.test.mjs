import './helpers/no-browser.mjs';
import {legacySandboxNameFor as testSandboxName} from '../lib/sandbox-name.mjs';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DockerSbxBackend,_internal} from '../lib/docker-backend.mjs';
import {withCleanCredentialScope} from './helpers/sbx-clean-scope.mjs';
import {writeCreateReceipt,bindTestSbxRuntime} from './helpers/sandbox-receipt-fixture.mjs';
import {randomBytes} from 'node:crypto';

const job={job_id:'recovery-job',image:'wf-faravan-guest@sha256:0000000000000000000000000000000000000000000000000000000000000000',entrypoint:'true',
  execution_scope:'owner',
  resources:{cpu:1,memory_mib:512,storage_mib:512,wall_seconds:60,output_bytes:1024,network_bytes:1024,max_processes:16},
  inputs:[],output_manifest:[],egress:'internet',provider_hosts:['**.openai.com']};
const empty=withCleanCredentialScope(async args=>({code:0,stdout:args[0]==='ls'?'[]':args[0]==='policy'?' {"rules":[]}':''}));

// The release rule now drains old absent creates. Cache and fallback tests
// stay within the recent-absence window; old-row drainage has separate coverage.
// The written availability rule adds one precheck before the journal inventory.
// An incomplete journal listing then stops the pass without rewriting rows.
test('reaper shares one complete inventory for thirteen established absent watches without releasing holds',async t=>{
  const root=await mkdtemp(join(tmpdir(),'reaper-shared-')),cleanupDirectory=join(root,'journal'),calls=[],handles=[];
  let storageReleased=0,scratchRemoved=0,deadlineCancelled=0;
  const runCommand=withCleanCredentialScope(async args=>{calls.push(args);return empty(args);});
  const backend=new DockerSbxBackend({cleanupDirectory,runCommand,now:()=>100_000,
    storage:{release:async()=>{storageReleased++;}},removeScratch:async()=>{scratchRemoved++;},
    sandboxDeadlines:{observed:()=>false,cancel:async()=>{deadlineCancelled++;}}});
  await mkdir(_internal.scratchRoot(),{recursive:true});
  t.after(async()=>{for(const h of handles)await rm(h.scratch_dir,{recursive:true,force:true});await rm(root,{recursive:true,force:true});});
  for(let i=0;i<13;i++){
    const sandbox_id='wf-'+randomBytes(8).toString('hex'),handle={job_id:'shared-'+i,sandbox_id,scratch_dir:await mkdtemp(join(_internal.scratchRoot(),'wf-job-'+sandbox_id+'-'))};
    bindTestSbxRuntime(backend,handle);
    backend.cleanupJournal.register(handle);backend.cleanupJournal.mark(handle,{create:'dispatched',absent_since:0});
    backend.cleanupJournal.finish(handle,{removed:false,unknown:'credential_revocation_pending',revocation:{step:'github_secret',error:'value_remains'}});handles.push(handle);
  }
  const before=await Promise.all(handles.map(h=>readFile(join(cleanupDirectory,h._cleanupId+'.json'),'utf8')));
  await backend.reapCleanup();
  assert.equal(calls.filter(args=>args[0]==='ls').length,2,'one availability check and one shared journal snapshot');
  assert.equal(calls.some(args=>args[0]==='rm'),false);
  assert.equal(storageReleased,0);assert.equal(scratchRemoved,0);assert.equal(deadlineCancelled,0);
  assert.deepEqual(await Promise.all(handles.map(h=>readFile(join(cleanupDirectory,h._cleanupId+'.json'),'utf8'))),before,'cached background absence cannot clear a prior admission hold or rewrite a watch');
  assert.equal(backend.cleanupStatus().create_watch,13);
});

async function reaperWatchFixture(t,{onCommand,observed=()=>false,absent=true}={}) {
  const root=await mkdtemp(join(tmpdir(),'reaper-safety-')),cleanupDirectory=join(root,'journal'),calls=[],summaries=[];
  let present=false,released=0,removedScratch=0;
  const runCommand=withCleanCredentialScope(async(args,options)=>{
    calls.push(args);const custom=await onCommand?.(args,options,f);if(custom)return custom;
    if(args[0]==='ls')return {code:0,stdout:JSON.stringify(present?[{name:f.handle.sandbox_id}]:[])};
    if(args[0]==='rm')present=false;
    return empty(args);
  });
  const backend=new DockerSbxBackend({cleanupDirectory,runCommand,now:()=>100_000,onReaperSummary:row=>summaries.push(row),cleanupListingSleep:async()=>{},
    sandboxDeadlines:{observed,cancel:async()=>true},storage:{release:async()=>{released++;}},
    removeScratch:async path=>{removedScratch++;await rm(path,{recursive:true,force:true});}});
  await mkdir(_internal.scratchRoot(),{recursive:true});
  const sandbox_id='wf-'+randomBytes(8).toString('hex'),handle={job_id:'watch-safety',sandbox_id,scratch_dir:await mkdtemp(join(_internal.scratchRoot(),'wf-job-'+sandbox_id+'-'))};
  bindTestSbxRuntime(backend,handle);
  backend.cleanupJournal.register(handle);backend.cleanupJournal.mark(handle,{create:'dispatched',...(absent?{absent_since:0}:{})});backend.cleanupJournal.finish(handle,{removed:false,unknown:'creation_unproven'});
  const file=join(cleanupDirectory,handle._cleanupId+'.json');
  const f={backend,handle,calls,summaries,file,root,setPresent:value=>{present=value;},counts:()=>({released,removedScratch}),
    rewrite:async changes=>writeFile(file,JSON.stringify({...JSON.parse(await readFile(file,'utf8')),...changes})),
    row:async()=>JSON.parse(await readFile(file,'utf8'))};
  t.after(async()=>{await rm(handle.scratch_dir,{recursive:true,force:true});await rm(root,{recursive:true,force:true});});return f;
}

test('a watch changed during the shared listing takes fresh inventory and post-rm proof',async t=>{
  let listed=0;const f=await reaperWatchFixture(t,{onCommand:async(args,_options,f)=>{
    if(args[0]==='ls'&&++listed===2){await f.rewrite({compute_created:true,create_settled:true});f.setPresent(true);return{code:0,stdout:'[]'};}
  }});
  await f.backend.reapCleanup();assert.equal(listed,4);assert.equal(f.calls.filter(a=>a[0]==='rm').length,1);
  assert.equal(existsSync(f.file),false);assert.equal(f.summaries[0].rows_settled,1);
});

for(const flags of [{truncated:true},{timedOut:true},{killed:true},{stderr:'warning'},{stdout:'{}'}])
test('incomplete shared inventory stops without changing a watch: '+JSON.stringify(flags),async t=>{
  let listed=0;const f=await reaperWatchFixture(t,{onCommand:args=>args[0]==='ls'&&++listed>=2?{code:0,stdout:'[]',...flags}:null});
  const before=await readFile(f.file);
  await assert.rejects(f.backend.reapCleanup(),error=>error.recovery_hold?.error_code==='sbx_daemon_unavailable');
  assert.equal(listed,4);assert.equal(existsSync(f.file),true);assert.deepEqual(f.counts(),{released:0,removedScratch:0});
  assert.deepEqual(await readFile(f.file),before);
  assert.equal(f.summaries[0].outcome,'aborted','the availability rule stops this pass before retrying rows');
});

test('supervisor-observed watches cannot settle from shared stale absence',async t=>{
  let listed=0;const f=await reaperWatchFixture(t,{observed:()=>true,onCommand:(args,_options,f)=>{
    if(args[0]==='ls'&&++listed===2){f.setPresent(true);return{code:0,stdout:'[]'};}
  }});
  await f.backend.reapCleanup();assert.equal(listed,4);assert.equal(f.calls.filter(a=>a[0]==='rm').length,1);
});

test('late materialization stays watched until a later fresh pass removes and verifies it',async t=>{
  let materialized=false;const f=await reaperWatchFixture(t,{onCommand:(args,_options,f)=>{
    if(!materialized&&args[0]==='policy'){materialized=true;f.setPresent(true);}
  }});
  const before=await readFile(f.file,'utf8');await f.backend.reapCleanup();
  assert.equal(await readFile(f.file,'utf8'),before);assert.equal(f.calls.some(a=>a[0]==='rm'),false);assert.deepEqual(f.counts(),{released:0,removedScratch:0});
  const prior=f.calls.length;await f.backend.reapCleanup();const later=f.calls.slice(prior);
  assert.equal(later.filter(a=>a[0]==='ls').length,4);assert.equal(later.filter(a=>a[0]==='rm').length,1);assert.equal(existsSync(f.file),false);
});

test('first absence uses the original fresh resolver path',async t=>{
  const f=await reaperWatchFixture(t,{absent:false});await f.backend.reapCleanup();
  assert.equal(f.calls.filter(a=>a[0]==='ls').length,2);assert.equal(Number.isFinite((await f.row()).absent_since),true);
});

test('daemon generation change during observation discards the shared snapshot',async t=>{
  const {resetSbxDaemonGate}=await import('../lib/docker-backend.mjs');let listed=0;
  const f=await reaperWatchFixture(t,{onCommand:args=>{if(args[0]==='ls'&&++listed===2)resetSbxDaemonGate();}});
  await f.backend.reapCleanup();assert.equal(listed,3);assert.equal(existsSync(f.file),true);
});

test('HOME change during observation retains the watch and its reservation',async t=>{
  const old=process.env.FARAVAN_SBX_HOME;let changed=false,listed=0;
  const f=await reaperWatchFixture(t,{onCommand:(args,_options,f)=>{if(args[0]==='ls'&&++listed===2&&!changed){changed=true;process.env.FARAVAN_SBX_HOME=join(f.root,'different-home');}}});
  try{await f.backend.reapCleanup();assert.equal(existsSync(f.file),true);assert.deepEqual(f.counts(),{released:0,removedScratch:0});assert.equal(f.calls.some(a=>a[0]==='rm'),false);}
  finally{if(old===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=old;}
});

test('cached watch revocation failure remains visible without releasing resources',async t=>{
  const f=await reaperWatchFixture(t,{onCommand:args=>args[0]==='policy'&&args[1]==='ls'?{code:1,stdout:''}:null});
  await f.backend.reapCleanup();const row=await f.row();
  assert.equal(row.unknown,'credential_revocation_pending');assert.equal(row.revocation_step,'network_policy');assert.deepEqual(f.counts(),{released:0,removedScratch:0});
});

test('reaper transport metrics count injected calls once and preserve the runner receiver',async t=>{
  const root=await mkdtemp(join(tmpdir(),'reaper-metrics-')),summaries=[];let calls=0,backend;
  const runner=function(args){assert.equal(this,backend);calls++;return Promise.resolve({code:0,stdout:'[]'});};
  backend=new DockerSbxBackend({cleanupDirectory:join(root,'journal'),runCommand:runner,onReaperSummary:row=>summaries.push(row)});
  await mkdir(_internal.scratchRoot(),{recursive:true});
  const sandbox_id='wf-'+randomBytes(8).toString('hex'),handle={job_id:'counted',sandbox_id,scratch_dir:await mkdtemp(join(_internal.scratchRoot(),'wf-job-'+sandbox_id+'-'))};
  backend.cleanupJournal.register(handle);backend.cleanupJournal.finish(handle,{removed:false});
  backend.destroy=async()=>{await backend.runSbx(['ls','--json']);await backend.runSbx(['policy','ls']);return{removed:false};};
  t.after(async()=>{await rm(handle.scratch_dir,{recursive:true,force:true});await rm(root,{recursive:true,force:true});});
  await backend.reapCleanup();assert.equal(calls,3,'availability is outside the journal metrics');assert.equal(summaries[0].command_calls,2);assert.equal(summaries[0].inventory_calls,1);
});

test('G14 removed compute retains scratch and policy cleanup debt through restart',async()=>{
  const root=await mkdtemp(join(tmpdir(),'faravan-g14-')),cleanupDirectory=join(root,'journal');
  let blocked=true,rules=[];
  const runCommand=async args=>{
    if(args[0]==='policy'&&args[1]==='ls')return {code:0,stdout:JSON.stringify({rules})};
    if(args[0]==='policy'&&args[1]==='rm'){
      if(blocked)return {code:1};
      rules=rules.filter(r=>r.id!==args[args.indexOf('--id')+1]);
    }
    return empty(args);
  };
  const first=new DockerSbxBackend({cleanupDirectory,runCommand,removeScratch:async dir=>{
    if(blocked)throw Error('injected removal failure');await rm(dir,{recursive:true,force:true});
  }});
  first._configureEgress=async()=>{};
  const handle=await first.prepare(job);
  await writeFile(join(handle.scratch_dir,'source.txt'),'private source');
  const scope='sandbox:'+handle.sandbox_id;
  rules=[{id:'own',scope,applies_to:scope,resource_type:'network',status:'active',editable:true},
    {id:'unrelated',scope:'all',applies_to:'all',resource_type:'network',status:'active',editable:true}];
  const receipt=await first.destroy(handle);
  assert.equal(receipt.removed,true);
  assert.equal(receipt.scratch_removed,false);
  assert.equal(receipt.policy_removed,false);
  // The counts are the debt; the unreadable-record count is part of status by rule, and the deadline report is the
  // recovery pass's own record, not a cleanup counter.
  const {deadline_recovery:_report,items,remediation,records,...counts}=first.cleanupStatus();
  assert.equal(records,1,'status counts the journal rows it saw; only the idle reaper reads it, and the app summary does not expose it');
  assert.equal(remediation.length,1);assert.equal(remediation[0].name,handle.sandbox_id);assert.equal(remediation[0].step,'network_policy');
  assert.equal(items.length,1);assert.equal(items[0].name,handle.sandbox_id); // One visible item per retained row.
  assert.deepEqual(counts,{state:'pending',data_cleanup_pending:1,policy_cleanup_pending:1,policy_cleanup_blocked:0,compute_cleanup_pending:0,unknown:0,unreadable_records:0});
  assert.equal(existsSync(handle.scratch_dir),true);
  blocked=false;
  const restarted=new DockerSbxBackend({cleanupDirectory,runCommand});
  await restarted.reapCleanup?.();
  assert.equal(existsSync(handle.scratch_dir),false,'restart removes debt without the old attempt record');
  assert.deepEqual(rules.map(r=>r.id),['unrelated']);
  assert.equal(restarted.cleanupStatus().state,'clear');
});

test('G14 SIGKILL during prepare leaves a discoverable scratch owner', {timeout:10000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'faravan-g14-kill-')),cleanupDirectory=join(root,'journal');
  const child=spawn(process.execPath,['--input-type=module','-e',`
    import {writeFile} from 'node:fs/promises';
    import {join} from 'node:path';
    import {DockerSbxBackend} from ${JSON.stringify(new URL('../lib/docker-backend.mjs',import.meta.url).href)};
    import {withCleanCredentialScope} from ${JSON.stringify(new URL('./helpers/sbx-clean-scope.mjs',import.meta.url).href)};
    const backend=new DockerSbxBackend({cleanupDirectory:process.argv[1],runCommand:withCleanCredentialScope(async args=>{
      if(args[0]==='create'){
        const scratch=args.filter(a=>a.startsWith('/')&&a.includes('wf-job-')).at(-1);await writeFile(join(scratch,'source.txt'),'survives kill');
        process.send({scratch});await new Promise(()=>{});
      }return {code:0,stdout:'[]'};
    })});
    setInterval(()=>{},1000);
    await backend.prepare(${JSON.stringify(job)});
  `,cleanupDirectory],{stdio:['ignore','ignore','pipe','ipc']});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  const [message]=await once(child,'message');
  const unrelated=join(root,'unrelated');await mkdir(unrelated);await writeFile(join(unrelated,'keep'),'keep');
  child.kill('SIGKILL');await once(child,'exit');
  assert.equal(await readFile(join(message.scratch,'source.txt'),'utf8'),'survives kill');
  const next=new DockerSbxBackend({cleanupDirectory,runCommand:empty});
  assert.equal(next.cleanupStatus().data_cleanup_pending,1,'a dead prepare is visible even before the first successful cleanup');
  await next.reapCleanup?.();
  // The create was dispatched and never returned or appeared: the sandbox may
  // still appear and mount this folder, so the debt is reported, not guessed.
  assert.equal(existsSync(message.scratch),true,'an unproven create keeps its scratch');
  assert.equal(next.cleanupStatus().unknown,1,'the dead prepare is reported as unknown');
  assert.equal(await readFile(join(unrelated,'keep'),'utf8'),'keep');
});

test('G14 recovery preserves live scratch and refuses a replaced symlink',async()=>{
  const root=await mkdtemp(join(tmpdir(),'faravan-g14-safe-')),cleanupDirectory=join(root,'journal');
  const first=new DockerSbxBackend({cleanupDirectory,runCommand:empty});first._configureEgress=async()=>{};
  const handle=await first.prepare(job);
  const next=new DockerSbxBackend({cleanupDirectory,runCommand:empty});
  await next.reapCleanup();assert.equal(existsSync(handle.scratch_dir),true);
  first.removeScratch=async()=>{throw Error('cannot remove');};
  await first.destroy(handle);
  await rm(handle.scratch_dir,{recursive:true});
  const unrelated=join(root,'unrelated');await mkdir(unrelated);await writeFile(join(unrelated,'keep'),'keep');
  await symlink(unrelated,handle.scratch_dir,'dir');
  await next.reapCleanup();
  assert.equal(await readFile(join(unrelated,'keep'),'utf8'),'keep');
  assert.equal(existsSync(handle.scratch_dir),true,'ambiguous cleanup debt is retained');
});

test('G14 old cleanup debt of a job never touches the live sandbox of its next dispatch',async()=>{
  const root=await mkdtemp(join(tmpdir(),'faravan-g14-name-')),cleanupDirectory=join(root,'journal');
  const commands=[];
  const backend=new DockerSbxBackend({cleanupDirectory,runCommand:async args=>{commands.push(args);return empty(args);}});
  backend._configureEgress=async()=>{};
  const old=await backend.prepare(job);
  const remove=backend.removeScratch;backend.removeScratch=async()=>{throw Error('busy');};
  await backend.destroy(old);backend.removeScratch=remove;
  const live=await backend.prepare(job);
  assert.notEqual(live.sandbox_id,old.sandbox_id,'each dispatch has its own name');
  const next=new DockerSbxBackend({cleanupDirectory,runCommand:async args=>{commands.push(args);return empty(args);}});
  commands.length=0;
  await next.reapCleanup();
  assert.equal(commands.some(args=>args[0]==='rm'),false,'old debt must not remove the live replacement');
  assert.equal(existsSync(old.scratch_dir),false,'the old debt closes through its own record');
  assert.equal(existsSync(live.scratch_dir),true);
  await backend.destroy(live);await next.reapCleanup();
  assert.equal(existsSync(live.scratch_dir),false);
});

test('scoped pending recovery reports stopped compute separately from retained borrower source',async()=>{
  const root=await mkdtemp(join(tmpdir(),'faravan-g14-legacy-')),cleanupDirectory=join(root,'journal');
  const id=await writeCreateReceipt(cleanupDirectory,{jobId:job.job_id,name:'wf-'+randomBytes(8).toString('hex'),
    ownerScope:sandboxOwnerScope(),home:_internal.sbxHome(),scratchRoot:_internal.scratchRoot()});
  const scratch=JSON.parse(await readFile(join(cleanupDirectory,id+'.json'),'utf8')).scratch_dir;
  await mkdir(scratch,{recursive:true});await writeFile(join(scratch,'source'),'borrower source');
  const first=new DockerSbxBackend({cleanupDirectory,runCommand:empty,removeScratch:async()=>{throw Error('busy');}});
  const receipt=await first.reconcilePending({owner_scope:sandboxOwnerScope(),sbx_home:_internal.sbxHome(),attemptId:'attempt',attempt:{attempt_id:'attempt'},jobId:job.job_id});
  assert.equal(receipt.removed,true);assert.equal(existsSync(scratch),true);
  assert.equal(receipt.scratch_removed,false);assert.equal(receipt.data_cleanup,'pending');
  assert.equal(first.cleanupStatus().compute_cleanup_pending,0);
  assert.ok(first.cleanupStatus().data_cleanup_pending>0);
  await new DockerSbxBackend({cleanupDirectory,runCommand:empty}).reapCleanup();
  assert.equal(existsSync(scratch),false);
});

test('restart recovery force-removes an orphaned run sandbox and reports it gone only after sbx ls drops it',async()=>{
  // An agent that escaped the in-guest watchdog may still run inside this sandbox. sbx rm kills everything in the VM.
  const root=await mkdtemp(join(tmpdir(),'faravan-orphan-')),cleanupDirectory=join(root,'journal');
  // Recovery acts on the dispatch the journal recorded, never on a name
  // recomputed from the job: the job-derived name here belongs to someone else.
  const sandbox='wf-'+randomBytes(8).toString('hex'),derived=testSandboxName(job.job_id);
  const live=new Set([sandbox,derived]),commands=[];
  await writeCreateReceipt(cleanupDirectory,{jobId:job.job_id,name:sandbox,ownerScope:sandboxOwnerScope(),
    home:_internal.sbxHome(),scratchRoot:_internal.scratchRoot()});
  const runCommand=async args=>{
    commands.push(args);
    if(args[0]==='ls')return {code:0,stdout:JSON.stringify([...live].map(name=>({name})))};
    if(args[0]==='rm'&&args.includes('--force')){live.delete(args.at(-1));return {code:0,stdout:''};}
    return empty(args);
  };
  const receipt=await new DockerSbxBackend({cleanupDirectory,runCommand}).reconcilePending(
    {owner_scope:sandboxOwnerScope(),sbx_home:_internal.sbxHome(),attemptId:'attempt-orphan',attempt:{attempt_id:'attempt-orphan'},jobId:job.job_id});
  assert.equal(receipt.removed,true);
  assert.equal(live.has(sandbox),false,'the orphaned sandbox is gone');
  const removal=commands.findIndex(args=>args[0]==='rm'&&args.at(-1)===sandbox);
  assert.ok(removal>=0,'sbx rm --force was issued for the orphaned sandbox');
  assert.ok(commands.slice(removal+1).some(args=>args[0]==='ls'),'removal is confirmed by a later sbx ls');
  assert.ok(live.has(derived),'a sandbox named from the job identity is not this attempt\'s');
  assert.ok(!commands.some(args=>args[0]==='rm'&&args.at(-1)===derived));
});

async function orphanFixture(t,{falseProof=false}={}) {
  const root=await mkdtemp(join(tmpdir(),'faravan-owned-barrier-')),cleanupDirectory=join(root,'journal');
  const live=new Set(),commands=[];let failList=false,removeWorks=false,ownedBeforeLaunch=false;
  const runCommand=withCleanCredentialScope(async args=>{
    commands.push(args);
    if(args[0]==='ls')return failList?{code:1,stdout:''}:{code:0,stdout:JSON.stringify([...live].map(name=>({name})))};
    if(['run','create'].includes(args[0])&&args.includes('--name')) {
      const name=args[args.indexOf('--name')+1];
      const rows=(await readdir(cleanupDirectory)).filter(n=>n.endsWith('.json'));
      ownedBeforeLaunch=(await Promise.all(rows.map(n=>readFile(join(cleanupDirectory,n),'utf8'))))
        .some(text=>JSON.parse(text).sandbox_id===name);
      live.add(name);
    }
    if(args[0]==='rm'&&removeWorks)live.delete(args.at(-1));
    return {code:0,stdout:args[0]==='policy'?'{"rules":[]}':''};
  });
  const first=new DockerSbxBackend({cleanupDirectory,runCommand});first._configureEgress=async()=>{};
  const handle=await first.prepare(job);
  assert.equal(ownedBeforeLaunch,true,'ownership is durable before the fake sandbox launch');
  // Unverified removal releases process locks but retains the durable obligation.
  assert.equal((await first.destroy(handle)).removed,false);
  if(falseProof)for(const name of (await readdir(cleanupDirectory)).filter(n=>n.endsWith('.json'))) {
    const file=join(cleanupDirectory,name),row=JSON.parse(await readFile(file,'utf8'));
    await writeFile(file,JSON.stringify({...row,compute_stopped:true}));
  }
  const restarted=new DockerSbxBackend({cleanupDirectory,runCommand});
  removeWorks=true;commands.length=0;
  t.after(async()=>{failList=false;removeWorks=true;await restarted.reconcileOwnedSandboxes?.();await rm(root,{recursive:true,force:true});});
  return {restarted,live,commands,handle,setFailList:value=>{failList=value;},setRemoveWorks:value=>{removeWorks=value;}};
}
test('owned-orphan barrier removes journaled compute without any counters or pending',async t=>{
  const f=await orphanFixture(t),proof=await f.restarted.reconcileOwnedSandboxes();
  assert.equal(proof.removed,true);assert.equal(f.live.has(f.handle.sandbox_id),false);
  const removal=f.commands.findIndex(args=>args[0]==='rm'&&args.at(-1)===f.handle.sandbox_id);
  assert.ok(removal>=0);assert.ok(f.commands.slice(removal+1).some(args=>args[0]==='ls'));
});
test('owned-orphan barrier ignores a false saved compute-stopped proof',async t=>{
  const f=await orphanFixture(t,{falseProof:true});
  assert.equal((await f.restarted.reconcileOwnedSandboxes()).removed,true);
  assert.equal(f.live.has(f.handle.sandbox_id),false);
});
test('owned-orphan barrier leaves foreign wf sandboxes untouched',async t=>{
  const f=await orphanFixture(t),foreign='wf-0123456789abcdef';f.live.add(foreign);
  const proof=await f.restarted.reconcileOwnedSandboxes();
  assert.equal(proof.removed,true);assert.deepEqual(proof.foreign,[foreign]);
  assert.ok(f.live.has(foreign));assert.ok(!f.commands.some(args=>args[0]==='rm'&&args.at(-1)===foreign));
});
test('owned-orphan barrier fails closed on listing failure and retries',async t=>{
  const f=await orphanFixture(t);f.setFailList(true);
  assert.equal((await f.restarted.reconcileOwnedSandboxes()).removed,false);
  assert.ok(f.live.has(f.handle.sandbox_id));assert.ok(!f.commands.some(args=>args[0]==='rm'));
  f.setFailList(false);assert.equal((await f.restarted.reconcileOwnedSandboxes()).removed,true);
});
test('owned-orphan saved stopped flag still requires inventory after sign-out',async t=>{
  const f=await orphanFixture(t,{falseProof:true});f.setFailList(true);
  assert.equal((await f.restarted.reconcileOwnedSandboxes()).removed,false);
  assert.ok(f.live.has(f.handle.sandbox_id));
  f.setFailList(false);
  assert.equal((await f.restarted.reconcileOwnedSandboxes()).removed,true);
  assert.equal(f.live.has(f.handle.sandbox_id),false);
});
for(const kind of ['corrupt','symlink'])test('owned-orphan '+kind+' journal cannot prove empty when signed out',async t=>{
  const root=await mkdtemp(join(tmpdir(),'faravan-invalid-journal-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const cleanupDirectory=join(root,'journal');
  if(kind==='symlink')await symlink(root,cleanupDirectory);
  else {
    await mkdir(cleanupDirectory);
    await writeFile(join(cleanupDirectory,'00000000-0000-0000-0000-000000000000.json'),'{');
  }
  const backend=new DockerSbxBackend({cleanupDirectory,runCommand:async()=>({code:1,stderr:'not signed in'})});
  assert.equal((await backend.reconcileOwnedSandboxes()).removed,false);
});
test('owned-orphan barrier does not trust successful rm while the sandbox remains listed',async t=>{
  const f=await orphanFixture(t);f.setRemoveWorks(false);
  assert.equal((await f.restarted.reconcileOwnedSandboxes()).removed,false);
  assert.ok(f.live.has(f.handle.sandbox_id));
  f.setRemoveWorks(true);assert.equal((await f.restarted.reconcileOwnedSandboxes()).removed,true);
});
test('owned-orphan barrier never removes a listed live locked owner from the same journal',async t=>{
  const root=await mkdtemp(join(tmpdir(),'faravan-live-barrier-')),cleanupDirectory=join(root,'journal'),commands=[];
  const names=new Set();
  const runCommand=async args=>{
    commands.push(args);
    if(args[0]==='ls')return {code:0,stdout:JSON.stringify([...names].map(name=>({name})))};
    if(['run','create'].includes(args[0])&&args.includes('--name'))names.add(args[args.indexOf('--name')+1]);
    if(args[0]==='rm')names.delete(args.at(-1));
    return empty(args);
  };
  const live=new DockerSbxBackend({cleanupDirectory,runCommand});live._configureEgress=async()=>{};
  const handle=await live.prepare(job);
  t.after(async()=>{await live.destroy(handle);await rm(root,{recursive:true,force:true});});
  commands.length=0;
  const next=new DockerSbxBackend({cleanupDirectory,runCommand});
  assert.equal((await next.reconcileOwnedSandboxes()).removed,false);
  assert.ok(names.has(handle.sandbox_id),'the locked owner is actually listed');
  assert.ok(!commands.some(args=>args[0]==='rm'));
});

test('owned-orphan journal defaults to the explicit home and does not adopt another home',async t=>{
  const root=await mkdtemp(join(tmpdir(),'faravan-homes-barrier-')),homeA=join(root,'a'),homeB=join(root,'b'),live=new Set(),commands=[];
  const runCommand=withCleanCredentialScope(async args=>{
    commands.push(args);
    if(args[0]==='ls')return {code:0,stdout:JSON.stringify([...live].map(name=>({name})))};
    if(['run','create'].includes(args[0])&&args.includes('--name'))live.add(args[args.indexOf('--name')+1]);
    if(args[0]==='rm')live.delete(args.at(-1));
    return {code:0,stdout:args[0]==='policy'?'{"rules":[]}':''};
  });
  const first=new DockerSbxBackend({home:homeA,runCommand});first._configureEgress=async()=>{};
  const handle=await first.prepare({...job,job_id:'different-home-job'});
  t.after(async()=>{await first.destroy(handle);await rm(root,{recursive:true,force:true});});
  assert.ok((await readdir(join(homeA,'v1','sandbox-cleanup'))).some(name=>name.endsWith('.json')));
  commands.length=0;
  const second=new DockerSbxBackend({home:homeB,runCommand});
  const proof=await second.reconcileOwnedSandboxes();
  assert.equal(proof.removed,true);assert.deepEqual(proof.foreign,[handle.sandbox_id]);
  assert.ok(live.has(handle.sandbox_id));assert.ok(!commands.some(args=>args[0]==='rm'));
});

test('owned-orphan startup generation is shared and does not reap newly started sibling work',async t=>{
  const f=await orphanFixture(t),releaseFirst=f.restarted.beginLendingSession();
  const first=f.restarted.reconcileOwnedSandboxes(),releaseSibling=f.restarted.beginLendingSession();
  const sibling=f.restarted.reconcileOwnedSandboxes();
  t.after(()=>{releaseFirst();releaseSibling();});
  assert.equal(first,sibling,'pool children share the in-flight barrier');
  assert.equal((await first).removed,true);
  f.restarted._configureEgress=async()=>{};
  const active=await f.restarted.prepare({...job,job_id:'post-barrier-sibling'});
  try {
    f.commands.length=0;
    // The live sibling is its own job's row, so it neither blocks admission nor counts as old compute proven gone.
    assert.equal((await f.restarted.reconcileOwnedSandboxes()).admission_allowed,true);
    assert.ok(f.live.has(active.sandbox_id),'the later pool child must not sweep new work');
    assert.ok(f.commands.every(args=>args[0]==='ls'),'the permanent-name fence only scans; live sibling work is not removed');
  }finally {await f.restarted.destroy(active);}
});

test('owned-orphan new session on the same backend rechecks failed-shutdown compute',async t=>{
  const f=await orphanFixture(t),releaseFirst=f.restarted.beginLendingSession();
  assert.equal((await f.restarted.reconcileOwnedSandboxes()).removed,true);
  f.restarted._configureEgress=async()=>{};
  const orphan=await f.restarted.prepare({...job,job_id:'later-session-orphan'});
  f.setRemoveWorks(false);assert.equal((await f.restarted.destroy(orphan)).removed,false);
  releaseFirst();
  const releaseSecond=f.restarted.beginLendingSession();
  try {
    assert.equal((await f.restarted.reconcileOwnedSandboxes()).removed,false,'old success cannot admit a new session');
    assert.ok(f.live.has(orphan.sandbox_id));
    f.setRemoveWorks(true);
    assert.equal((await f.restarted.reconcileOwnedSandboxes()).removed,true);
    assert.ok(!f.live.has(orphan.sandbox_id));
  }finally {releaseSecond();}
});

test('owned-orphan aborted shared in-flight barrier is not cached as success',async t=>{
  const f=await orphanFixture(t),controller=new AbortController();
  const releaseA=f.restarted.beginLendingSession(),releaseB=f.restarted.beginLendingSession();
  const run=f.restarted.runSbx;let listed,unblock;
  const reached=new Promise(resolve=>{listed=resolve;});
  const held=new Promise(resolve=>{unblock=resolve;});
  let firstList=true;
  f.restarted.runSbx=async(args,options)=>{
    if(args[0]==='ls'&&firstList){firstList=false;listed();await held;}
    return run(args,options);
  };
  t.after(()=>{unblock();releaseA();releaseB();});
  const first=f.restarted.reconcileOwnedSandboxes({signal:controller.signal});
  const sibling=f.restarted.reconcileOwnedSandboxes();
  assert.equal(first,sibling);
  await reached;controller.abort();unblock();
  assert.equal((await first).removed,false);
  assert.equal((await sibling).removed,false);
  const before=f.commands.filter(args=>args[0]==='ls').length;
  const retry=f.restarted.reconcileOwnedSandboxes();
  assert.notEqual(retry,first);
  assert.equal((await retry).removed,true);
  assert.ok(f.commands.filter(args=>args[0]==='ls').length>before,'retry inventories instead of trusting the aborted flight');
});

test('owned-orphan released debt invalidates already-settled proof at consumption',async t=>{
  const f=await orphanFixture(t),releaseA=f.restarted.beginLendingSession();
  assert.equal((await f.restarted.reconcileOwnedSandboxes()).removed,true);
  f.restarted._configureEgress=async()=>{};
  const prepare=()=>f.restarted.prepare({...job,job_id:'settled-proof-orphan'});
  const orphan=await (releaseA.run?releaseA.run(prepare):prepare());
  f.setRemoveWorks(false);
  assert.equal((await f.restarted.destroy(orphan)).removed,false);
  const releaseB=f.restarted.beginLendingSession();
  t.after(()=>{releaseA();releaseB();});
  const cached=f.restarted.reconcileOwnedSandboxes();
  queueMicrotask(releaseA);
  const proof=await cached;
  assert.ok(f.live.has(orphan.sandbox_id));
  assert.equal(f.restarted.isOwnedSandboxProofCurrent?.(proof),false,'a settled promise cannot authorize after its generation is invalidated');
  f.setRemoveWorks(true);
  const fresh=await f.restarted.reconcileOwnedSandboxes();
  assert.equal(fresh.removed,true);
  assert.equal(f.restarted.isOwnedSandboxProofCurrent(fresh),true);
  assert.ok(!f.live.has(orphan.sandbox_id));
});

async function policyDebtFixture(t,{debt='policy',editable=false,failure=null}={}) {
  const root=await mkdtemp(join(tmpdir(),'faravan-policy-debt-')),home=join(root,'home'),cleanupDirectory=join(home,'v1','sandbox-cleanup');
  let now=0,retained=debt,rules=[],problem=failure;const calls=[];
  const sandbox='wf-'+randomBytes(8).toString('hex'),scope='sandbox:'+sandbox;
  const runCommand=withCleanCredentialScope(async args=>{
    calls.push(args);
    if(args[0]==='ls')return {code:0,stdout:JSON.stringify(retained==='compute'?[{name:sandbox}]:[])};
    if(args[0]==='policy'&&args[1]==='ls'){
      if(problem==='exit')return {code:1,stdout:''};
      return {code:0,stdout:JSON.stringify({rules})};
    }
    if(args[0]==='policy'&&args[1]==='rm')rules=rules.filter(row=>row.id!==args[args.indexOf('--id')+1]);
    return empty(args);
  });
  const options={home,cleanupDirectory,runCommand,monotonic:()=>now,removeScratch:async dir=>{
    if(retained==='scratch')throw Error('folder busy');await rm(dir,{recursive:true,force:true});
  }};
  const backend=new DockerSbxBackend(options);
  await mkdir(_internal.scratchRoot(),{recursive:true});
  const handle={job_id:job.job_id,sandbox_id:sandbox,
    scratch_dir:await mkdtemp(join(_internal.scratchRoot(),'wf-job-'+sandbox+'-'))};
  bindTestSbxRuntime(backend,handle);
  backend.cleanupJournal.register(handle);
  backend.cleanupJournal.mark(handle,{create:'dispatched',compute_created:true,create_settled:true});
  rules=[{id:problem==='id'?undefined:'locked-rule',scope,applies_to:scope,status:'active',resource_type:'network',editable:false}];
  if(editable)rules.push({...rules[0],id:'editable-rule',editable:true});
  const result=await backend.destroy(handle);
  t.after(async()=>{retained='policy';problem=null;rules=[];await backend.destroy(handle);await rm(root,{recursive:true,force:true});});
  return {root,home,backend,handle,result,calls,options,rows:()=>rules,setNow:value=>{now=value;},
    row:async()=>JSON.parse(await readFile(join(cleanupDirectory,handle._cleanupId+'.json'),'utf8')),
    rewrite:async change=>{
      const file=join(cleanupDirectory,handle._cleanupId+'.json'),row=JSON.parse(await readFile(file,'utf8'));
      await writeFile(file,JSON.stringify({...row,...change}));
    }};
}

test('policy-only cleanup uses six cycles over ten minutes and resets after record changes',async t=>{
  const f=await policyDebtFixture(t);f.calls.length=0;
  for(let now=0;now<=600000;now+=15000){f.setNow(now);await f.backend.reapCleanup();}
  // Permanent-name sweeps and service availability are independent of policy retry backoff.
  const policyCalls=()=>f.calls.filter(args=>args[0]==='policy').length;
  assert.equal(policyCalls(),12,'six policy cycles with strict listing and readback');
  const before=policyCalls();
  await f.backend.reapCleanup();assert.equal(policyCalls(),before,'same time stays delayed');
  await f.rewrite({policy_cleanup:'pending'});
  await f.backend.reapCleanup();assert.ok(policyCalls()>before,'changed contents reset the delay');
  const after=f.calls.length;
  await new DockerSbxBackend(f.options).reapCleanup();
  assert.ok(f.calls.length>after,'a new backend retries immediately');
});

test('editable sibling is removed before policy-only debt becomes blocked',async t=>{
  const f=await policyDebtFixture(t,{editable:true});
  assert.equal(f.result.policy_removed,false);assert.equal(f.result.policy_blocked,true);
  assert.deepEqual(f.rows().map(row=>row.id),['locked-rule']);
  assert.equal((await f.row()).policy_cleanup,'blocked');
  assert.equal(f.backend.cleanupStatus().policy_cleanup_pending,1);
  assert.equal(f.backend.cleanupStatus().policy_cleanup_blocked,1);
  assert.equal(f.backend.cleanupStatus().state,'blocked');
});

for(const debt of ['compute','scratch'])test(debt+' debt is retried on every fifteen-second pass',async t=>{
  const f=await policyDebtFixture(t,{debt});f.calls.length=0;
  for(let now=0;now<=600000;now+=15000){
    f.setNow(now);const before=f.calls.filter(args=>args[0]==='rm').length;
    await f.backend.reapCleanup();
    assert.equal(f.calls.filter(args=>args[0]==='rm').length-before,debt==='compute'?1:0);
    assert.equal(f.backend.cleanupStatus().state,'pending');
  }
});

for(const failure of ['exit','id'])test('policy listing '+failure+' keeps cleanup pending rather than blocked',async t=>{
  const f=await policyDebtFixture(t,{failure});
  await f.backend.reapCleanup();
  assert.equal((await f.row()).policy_cleanup,'pending');
  assert.equal(f.backend.cleanupStatus().state,'pending');
  assert.equal(f.backend.cleanupStatus().policy_cleanup_blocked??0,0);
  assert.notEqual(f.result.policy_blocked,true);
});

for(const debt of ['policy','compute','scratch'])test('uninstall handles '+debt+' cleanup debt safely',async t=>{
  const {runUninstall}=await import('../lib/v1/uninstall.mjs');
  const f=await policyDebtFixture(t,{debt});let stdout='',stderr='';
  const result=await runUninstall(['--yes'],{
    home:f.home,userHome:f.root,installDir:join(f.root,'program'),coordinatorHome:join(f.root,'coordinator'),env:{},platform:'linux',
    cleanupBackend:f.backend,device:{listCircles:async()=>[]},alive:()=>false,sleep:async()=>{},
    hostedCoordinatorRecord:async()=>null,stopV1Host:async()=>{},fetch:async()=>{throw Error('unexpected network access');},
    run:async(command,args)=>({code:command==='pgrep'?1:command==='systemctl'&&args.includes('is-active')?3:0,stdout:'',stderr:''}),
    stdout:{write:text=>{stdout+=text;}},stderr:{write:text=>{stderr+=text;}}
  });
  assert.equal(result,debt==='policy'?0:1);
  if(debt==='policy'){
    assert.match(stderr,/Warning:/);assert.ok(stderr.includes(f.handle.sandbox_id));assert.match(stderr,/locked-rule/);
    assert.match(stdout,/uninstall steps are complete/);assert.equal(existsSync(f.home),false);
  }else{
    assert.match(stderr,/Could not clear sandbox cleanup debt/);assert.equal(existsSync(f.home),true);
  }
});

test('policy delay caps at one hour and startup reconciliation ignores it',async t=>{
  const f=await policyDebtFixture(t);f.calls.length=0;const times=[];
  for(let now=0;now<=14400000;now+=15000){
    f.setNow(now);const before=f.calls.filter(args=>args[0]==='policy').length;await f.backend.reapCleanup();
    if(f.calls.filter(args=>args[0]==='policy').length>before)times.push(now);
  }
  assert.deepEqual(times.slice(0,6),[0,15000,45000,105000,225000,465000]);
  assert.equal(times.at(-1)-times.at(-2),3600000);
  assert.equal(times.at(-2)-times.at(-3),3600000);
  const before=f.calls.length;
  const result=await f.backend.cleanupJournal.reconcileOwned({inventory:async()=>[],remove:row=>f.backend._finishDestroy(row,true)});
  assert.equal(result.removed,true);assert.ok(f.calls.length>before);
});
