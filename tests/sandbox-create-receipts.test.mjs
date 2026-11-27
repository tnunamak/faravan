import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {lendingMeterJobId,_internal} from '../lib/docker-backend.mjs';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import {createCheckSandboxes} from '../lib/v1/check-sandboxes.mjs';
import {crashProcess} from './helpers/crash-process.mjs';
import {fileSbx,receiptBackend,receiptJob,receiptedHandle} from './helpers/sandbox-receipt-fixture.mjs';

const CHILD=fileURLToPath(new URL('./helpers/sandbox-receipt-child.mjs',import.meta.url));
const ENV=['FARAVAN_SBX_HOME','FARAVAN_SCRATCH_ROOT'];

async function sandboxRoot(t) {
  const root=await mkdtemp(join(tmpdir(),'wf-receipt-'));
  const saved=Object.fromEntries(ENV.map(name=>[name,process.env[name]]));
  process.env.FARAVAN_SBX_HOME=join(root,'sbx-home');process.env.FARAVAN_SCRATCH_ROOT=join(root,'scratch');
  await mkdir(process.env.FARAVAN_SBX_HOME,{recursive:true});
  t.after(async()=>{
    for(const name of ENV)if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];
    await rm(root,{recursive:true,force:true});
  });
  return root;
}
const removals=(sbx,name)=>sbx.calls().filter(args=>args[0]==='rm'&&args.includes(name));
const stops=(sbx,name)=>sbx.calls().filter(args=>args[0]==='stop'&&args.includes(name));
const rows=async root=>{
  const directory=join(root,'profile','v1','sandbox-cleanup');
  const names=await readdir(directory).catch(()=>[]);
  return Promise.all(names.filter(name=>name.endsWith('.json')).map(async name=>JSON.parse(await readFile(join(directory,name),'utf8'))));
};

test('each create dispatch reserves a fresh name durably before sbx runs',async t=>{
  const root=await sandboxRoot(t);
  const seen=[];
  const sbx=fileSbx(join(root,'sbx'),{create:async name=>{
    // The reservation must already be durable when the create command starts.
    seen.push((await rows(root)).find(row=>row.sandbox_id===name)?.create);
    return {code:0};
  }});
  const backend=receiptBackend(root,sbx);
  const first=await backend.prepare(receiptJob());
  await backend.destroy(first);
  const second=await backend.prepare(receiptJob());
  await backend.destroy(second);
  assert.notEqual(first.sandbox_id,second.sandbox_id,'a retry of one job gets a new physical name');
  assert.deepEqual(seen,['dispatched','dispatched']);
});

test('two dispatches of one job, then a crash: recovery removes both exact names and reuses neither',async t=>{
  const root=await sandboxRoot(t);
  await crashProcess(t,CHILD,[root,'two-dispatches'],'prepared');
  const names=JSON.parse(await readFile(join(root,'prepared.json'),'utf8'));
  assert.equal(names.length,2);
  assert.ok(names.every(name=>/^wf-[0-9a-f]{16}$/.test(name)),'both dispatches created a sandbox: '+names);
  assert.notEqual(names[0],names[1]);
  const sbx=fileSbx(join(root,'sbx')),backend=receiptBackend(root,sbx);
  assert.deepEqual([...sbx.read()].sort(),[...names].sort());
  const proof=await backend.reconcileOwnedSandboxes();
  assert.equal(proof.removed,true);
  assert.deepEqual(sbx.read(),[]);
  const third=await backend.prepare(receiptJob());
  try {assert.ok(!names.includes(third.sandbox_id),'a removed name is never recycled');}
  finally {await backend.destroy(third);}
});

test('pending recovery removes its permanently reserved names even without materialization receipts',async t=>{
  const root=await sandboxRoot(t);
  await crashProcess(t,CHILD,[root,'five-targets'],'dispatched');
  const {name:main}=JSON.parse(await readFile(join(root,'main.json'),'utf8'));
  const sbx=fileSbx(join(root,'sbx')),backend=receiptBackend(root,sbx);
  const unreceipted=sbx.created().filter(name=>name!==main);
  assert.equal(unreceipted.length,4,'helper, check, check-git and meter all materialized');
  const pending={...backend.sandboxOwnership(),jobId:receiptJob().job_id,attemptId:'attempt-receipt',attempt:{attempt_id:'attempt-receipt'}};
  const proof=await backend.reconcilePending(pending);
  assert.equal(proof.removed,true,'permanent reservations authorize exact-name cleanup');
  for(const name of unreceipted)assert.ok(removals(sbx,name).length>=1,name+' is removed through its own reservation');
  assert.ok(!sbx.read().includes(main),'the receipted main sandbox is removed');
  assert.deepEqual(sbx.read(),[]);
  const status=backend.cleanupStatus();
  assert.equal(status.state,'clear');
  assert.deepEqual(status.remediation??[],[]);
});

for(const materialize of [true,false])test(`a failed create CLI ${materialize?'removes its reserved name when compute appears':'keeps recent absence UNKNOWN across restart'}`,async t=>{
  const root=await sandboxRoot(t);
  const sbx=fileSbx(join(root,'sbx'),{create:async()=>({code:1,stderr:'daemon timeout',materialize})});
  const backend=receiptBackend(root,sbx);
  await assert.rejects(backend.prepare(receiptJob()),{code:'sandbox_start_failed'});
  const [name]=sbx.created();
  if(materialize){
    assert.ok(removals(sbx,name).length>=1,'the permanent-name rule removes this exact sandbox');
    assert.deepEqual(stops(sbx,name),[]);assert.deepEqual(sbx.read(),[]);
    for(const current of [backend,receiptBackend(root,sbx)])assert.equal(current.cleanupStatus().state,'clear');
    await assert.rejects(backend.admitJob(receiptJob({sandbox_id:name})),{code:'cessation_unverified',recovery_scope:'target'});
    return;
  }
  assert.deepEqual(removals(sbx,name),[],'no removal without a create receipt');
  assert.deepEqual(stops(sbx,name),[]);
  assert.deepEqual(sbx.read(),materialize?[name]:[]);
  for(const current of [backend,receiptBackend(root,sbx)]) {
    const status=current.cleanupStatus();
    assert.equal(status.state,'unknown');
    const entry=status.remediation?.find(row=>row.name===name);
    assert.ok(entry,'the exact name is reported');
    assert.equal(entry.home,process.env.FARAVAN_SBX_HOME);
    assert.equal(Boolean(entry.command),materialize,'only a present sandbox has a removal command');
  }
  const restarted=receiptBackend(root,sbx);
  assert.equal((await restarted.reconcileOwnedSandboxes()).removed,false,'the hold survives restart');
  await restarted.reapCleanup();
  assert.deepEqual(removals(sbx,name),[]);
  assert.equal(restarted.cleanupStatus().state,'unknown');
});

test('a present sandbox without a receipt closes only after an outside removal is observed',async t=>{
  const root=await sandboxRoot(t);
  const sbx=fileSbx(join(root,'sbx'),{create:async()=>({code:1,stderr:'daemon timeout'})});
  const backend=receiptBackend(root,sbx);
  const run=backend.runSbx;
  backend.runSbx=async(args,options)=>args[0]==='rm'?{code:1,stdout:'',stderr:'fixture removal refused'}:run(args,options);
  await assert.rejects(backend.prepare(receiptJob()),{code:'sandbox_start_failed'});
  const [name]=sbx.created();
  // The owner runs the reported command.
  await sbx.run(['rm','--force',name]);
  const restarted=receiptBackend(root,sbx);
  assert.equal((await restarted.reconcileOwnedSandboxes()).removed,true);
  assert.equal(restarted.cleanupStatus().state,'clear');
});

test('an expired failed create removes its own reserved name without a materialization receipt',async t=>{
  const root=await sandboxRoot(t);
  let started;
  const created=new Promise(resolve=>{started=resolve;});
  const sbx=fileSbx(join(root,'sbx'),{create:async(name,args,options,{materialize})=>{
    materialize();started();
    await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}));
    return {code:137,materialize:true};
  }});
  const backend=receiptBackend(root,sbx);
  const preparing=backend.prepare(receiptJob());
  preparing.catch(()=>{});
  await created;
  backend.deadlineTimers.fireAll();
  await assert.rejects(preparing);
  const [name]=sbx.created();
  assert.deepEqual(stops(sbx,name),[]);
  assert.equal(removals(sbx,name).length,1);
  assert.equal(backend.cleanupStatus().state,'clear');
});

test('cleanup of an already absent sandbox has no observed removal transition',async t=>{
  const root=await sandboxRoot(t);
  await mkdir(join(root,'scratch'));
  const sbx=fileSbx(join(root,'inventory'));
  const backend=receiptBackend(root,sbx);
  const handle=await receiptedHandle(backend,{job_id:randomUUID(),...backend.sandboxOwnership()});
  const receipt=await backend.destroy(handle);
  assert.equal(receipt.removed,true);
  assert.equal(receipt.removal_observation,undefined);
  assert.equal(sbx.calls().some(([command])=>command==='rm'),false);
});

test('raw cancel and destroy refuse a name with no create receipt',async t=>{
  const root=await sandboxRoot(t);
  const sbx=fileSbx(join(root,'sbx'));
  await sbx.run(['create','--name','wf-0123456789abcdef']);
  const backend=receiptBackend(root,sbx);
  const handle={...backend.sandboxOwnership(),job_id:'guessed',sandbox_id:'wf-0123456789abcdef',scratch_dir:join(root,'scratch','wf-job-wf-0123456789abcdef-x')};
  await assert.rejects(backend.cancel(handle),{code:'cessation_unverified'});
  const receipt=await backend.destroy(handle);
  assert.equal(receipt.removed,false);
  assert.deepEqual(stops(sbx,'wf-0123456789abcdef'),[]);
  assert.deepEqual(removals(sbx,'wf-0123456789abcdef'),[]);
});

test('doctor never removes a guessed name after a failed test workspace',async t=>{
  const root=await sandboxRoot(t);
  const sbx=fileSbx(join(root,'sbx'));
  const backend=receiptBackend(root,sbx);
  backend.prepare=async()=>{throw Object.assign(new Error('sbx create failed'),{code:'sandbox_start_failed'});};
  const result=await backend.testWorkspace();
  assert.equal(result.ok,false);
  assert.deepEqual(sbx.calls().filter(args=>args[0]==='rm'),[]);
});

test('an expired check row with no handle never removes a predicted name',async t=>{
  const root=await sandboxRoot(t);
  const id='wf-pull-0000000000000000-0123abcd';
  // Before fresh names, a check row's name was predicted from its job id.
  const legacyName=_internal.sandboxNameFor?.(id)??'wf-'+'a'.repeat(16);
  const calls=[];
  const backend={
    async runSbx(args){calls.push(args);return {code:0,stdout:JSON.stringify([{name:legacyName}])};},
    async destroy(){calls.push(['destroy']);return {removed:false};},
  };
  const file=join(root,'checks.json');
  await writeFile(file,JSON.stringify([{job_id:id,sandbox_id:legacyName,expires_at:1,scratch_dir:null}]));
  const checks=createCheckSandboxes({backend,file,now:()=>10});
  await checks.reap();
  assert.deepEqual(calls.filter(args=>args[0]==='rm'),[]);
});

test('orphaned scratch recovery never removes compute',async t=>{
  const root=await sandboxRoot(t);
  const sbx=fileSbx(join(root,'sbx'));
  const name='wf-'+'b'.repeat(16);
  await sbx.run(['create','--name',name]);
  const backend=receiptBackend(root,sbx);
  const scratch=join(root,'scratch','wf-job-'+name+'-'+randomUUID());
  await mkdir(scratch,{recursive:true});await mkdir(join(root,'scratch-journal'),{recursive:true,mode:0o700});
  await writeFile(join(root,'scratch-journal',name+'.json'),JSON.stringify({v:1,sandboxId:name,parent:join(root,'scratch'),scratch,ownerPid:2147483647,owner_scope:sandboxOwnerScope(),sbx_home:process.env.FARAVAN_SBX_HOME}),{mode:0o600});
  await backend.reconcileOrphanedScratch();
  assert.deepEqual(removals(sbx,name),[]);
  assert.ok(sbx.read().includes(name));
});

test('a scoped journal row from before receipts is reported, never removed',async t=>{
  const root=await sandboxRoot(t);
  const sbx=fileSbx(join(root,'sbx'));
  const name='wf-'+'c'.repeat(16),id=randomUUID();
  await sbx.run(['create','--name',name]);
  const scratch=join(root,'scratch','wf-job-'+name+'-'+randomUUID());
  await mkdir(join(root,'scratch'),{recursive:true});
  const directory=join(root,'profile','v1','sandbox-cleanup');await mkdir(directory,{recursive:true});
  await writeFile(join(directory,id+'.json'),JSON.stringify({version:1,_cleanupId:id,owner_scope:sandboxOwnerScope(),sbx_home:process.env.FARAVAN_SBX_HOME,
    job_id:'old-job',sandbox_id:name,scratch_dir:scratch,compute_stopped:false,data_cleanup:'owned',policy_cleanup:'owned'}));
  const backend=receiptBackend(root,sbx);
  assert.equal((await backend.reconcileOwnedSandboxes()).removed,false);
  await backend.reapCleanup();
  assert.deepEqual(removals(sbx,name),[]);
  const status=backend.cleanupStatus();
  assert.equal(status.state,'unknown');
  assert.ok(status.remediation?.some(row=>row.name===name));
});

test('the meter target is named per dispatch, not from its attempt',async t=>{
  const root=await sandboxRoot(t);
  const sbx=fileSbx(join(root,'sbx'));
  const backend=receiptBackend(root,sbx);
  const handle=await backend.prepare(receiptJob({job_id:lendingMeterJobId('attempt-x')}));
  try {assert.notEqual(handle.sandbox_id,_internal.sandboxNameFor?.(lendingMeterJobId('attempt-x')));}
  finally {await backend.destroy(handle);}
  assert.equal(backend.cleanupStatus().state,'clear');
});

const pendingAttempt=backend=>({...backend.sandboxOwnership(),jobId:receiptJob().job_id,attemptId:'attempt-receipt',attempt:{attempt_id:'attempt-receipt'}});

test('a crash after the check-git row is registered and its create returned: pending recovery removes it and closes the row',async t=>{
  const root=await sandboxRoot(t);
  await crashProcess(t,CHILD,[root,'check-git-created'],'created');
  const {name}=JSON.parse(await readFile(join(root,'check-git.json'),'utf8'));
  const sbx=fileSbx(join(root,'sbx')),backend=receiptBackend(root,sbx);
  assert.deepEqual(sbx.read(),[name]);
  const proof=await backend.reconcilePending(pendingAttempt(backend));
  assert.equal(proof.removed,true,'the attempt is released once its check-git row is closed');
  assert.equal(removals(sbx,name).length,1,'check-git is removed through its own receipt');
  assert.deepEqual(sbx.read(),[]);
  assert.deepEqual((await rows(root)).filter(row=>row.sandbox_id===name),[],'the check-git row is closed');
});

test('a crash after the check-git row is registered, before its create: recovery closes the row with no removal',async t=>{
  const root=await sandboxRoot(t);
  await crashProcess(t,CHILD,[root,'check-git-reserved'],'reserved');
  const reserved=(await rows(root)).filter(row=>row.job_id===receiptJob().job_id+'-check-git');
  assert.equal(reserved.length,1,'the row is durable before any create');
  const name=reserved[0].sandbox_id;
  const sbx=fileSbx(join(root,'sbx')),backend=receiptBackend(root,sbx);
  assert.deepEqual(sbx.created(),[],'the crash came before the create command');
  const proof=await backend.reconcilePending(pendingAttempt(backend));
  assert.equal(proof.removed,true);
  assert.deepEqual(removals(sbx,name),[]);
  assert.deepEqual((await rows(root)).filter(row=>row.sandbox_id===name),[],'the check-git row is closed');
});

test('two dispatches of one job, crash, restart: pending recovery closes both persisted rows before release',async t=>{
  const root=await sandboxRoot(t);
  await crashProcess(t,CHILD,[root,'two-dispatches'],'prepared');
  const names=JSON.parse(await readFile(join(root,'prepared.json'),'utf8'));
  assert.equal(names.length,2);assert.notEqual(names[0],names[1]);
  const sbx=fileSbx(join(root,'sbx')),backend=receiptBackend(root,sbx);
  const proof=await backend.reconcilePending(pendingAttempt(backend));
  assert.equal(proof.removed,true);
  for(const name of names)assert.equal(removals(sbx,name).length,1,name+' is removed through its own row');
  assert.deepEqual(sbx.read(),[]);
  assert.deepEqual((await rows(root)).filter(row=>names.includes(row.sandbox_id)),[],'both persisted rows are closed');
});

test('pending recovery closes both reserved dispatches after complete absence',async t=>{
  const root=await sandboxRoot(t);
  await crashProcess(t,CHILD,[root,'redispatch-live'],'dispatched');
  const {name:first}=JSON.parse(await readFile(join(root,'first.json'),'utf8'));
  const {name:second}=JSON.parse(await readFile(join(root,'second.json'),'utf8'));
  assert.ok(second,'the second dispatch has its own name');assert.notEqual(first,second);
  const sbx=fileSbx(join(root,'sbx')),backend=receiptBackend(root,sbx);
  assert.deepEqual([...sbx.read()].sort(),[first,second].sort());
  const proof=await backend.reconcilePending(pendingAttempt(backend));
  assert.equal(proof.removed,true,'both reserved names are proven absent');
  assert.equal(removals(sbx,first).length,1,'the receipted first dispatch is still removed');
  assert.equal(removals(sbx,second).length,1);
  assert.deepEqual(sbx.read(),[]);
  assert.equal(backend.cleanupStatus().state,'clear');
});

test('a create dispatch refuses while an uninstall holds the lock, and its row stays undispatched',async t=>{
  const {acquireUninstallLock}=await import('../lib/v1/uninstall-lock.mjs');
  const root=await mkdtemp(join(tmpdir(),'receipt-uninstall-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const sbx=fileSbx(join(root,'sbx')),backend=receiptBackend(root,sbx);
  const release=acquireUninstallLock(join(root,'profile'));
  try {
    await assert.rejects(backend.prepare(receiptJob()));
    assert.deepEqual(sbx.created(),[],'no create runs during an uninstall');
  } finally {release();}
  assert.equal(backend.cleanupStatus().unknown,0,'a refused dispatch leaves no unproven creation behind');
});
