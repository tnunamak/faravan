import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,readdir,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import {createLender} from '../lib/v1/lender.mjs';
import {opById} from '../lib/v1/ops/registry.mjs';
import {fileSbx,receiptBackend,receiptJob,writeCreateReceipt} from './helpers/sandbox-receipt-fixture.mjs';
import {lenderFixture,until} from './helpers/v1-lender-fixture.mjs';

const ENV=['FARAVAN_SBX_HOME','FARAVAN_SCRATCH_ROOT'];
const NAME='wf-0123456789abcdef';
const HOUR=3600000,READY=180000;
// An app killed between the create dispatch and the settle write leaves this row; a clock the test moves
// and a storage spy stand in for the host.
async function stuckRoot(t,{listed=false}={}) {
  const root=await mkdtemp(join(tmpdir(),'wf-stuck-'));
  const saved=Object.fromEntries(ENV.map(name=>[name,process.env[name]]));
  process.env.FARAVAN_SBX_HOME=join(root,'sbx-home');process.env.FARAVAN_SCRATCH_ROOT=join(root,'scratch');
  await mkdir(process.env.FARAVAN_SBX_HOME,{recursive:true});await mkdir(process.env.FARAVAN_SCRATCH_ROOT,{recursive:true});
  t.after(async()=>{
    for(const name of ENV)if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];
    await rm(root,{recursive:true,force:true});
  });
  const sbx=fileSbx(join(root,'sbx'));
  if(listed)await sbx.run(['create','--name',NAME]);
  const directory=join(root,'profile','v1','sandbox-cleanup');
  await writeCreateReceipt(directory,{jobId:'job-stuck',name:NAME,ownerScope:sandboxOwnerScope(),home:process.env.FARAVAN_SBX_HOME,
    scratchRoot:process.env.FARAVAN_SCRATCH_ROOT,created:false,settled:false});
  const row=JSON.parse(await readFile(join(directory,(await readdir(directory)).find(n=>n.endsWith('.json'))),'utf8'));
  await mkdir(row.scratch_dir,{recursive:true});
  const clock={at:Date.UTC(2026,10,7)},released=[];
  const storage={available:async()=>true,release:async name=>{released.push(name);}};
  const make=(run=sbx.run)=>receiptBackend(root,{...sbx,run},{now:()=>clock.at,storage});
  return {root,sbx,directory,row,clock,released,make,scratch:row.scratch_dir};
}
const records=async directory=>(await readdir(directory).catch(()=>[])).filter(name=>name.endsWith('.json'));
const removals=sbx=>sbx.calls().filter(args=>args[0]==='rm');

test('the first empty listing keeps the row, its scratch and its storage as a watch',async t=>{
  const f=await stuckRoot(t),backend=f.make();
  const proof=await backend.reconcileOwnedSandboxes();
  assert.equal(proof.removed,false,'the admission hold stays until a bound passes');
  assert.equal((await records(f.directory)).length,1);
  assert.equal(existsSync(f.scratch),true);
  assert.deepEqual(f.released,[]);
  assert.deepEqual(removals(f.sbx),[]);
});

test('a create released only after recovery saw the first empty listing is removed when its name appears',async t=>{
  const f=await stuckRoot(t),backend=f.make();
  assert.equal((await backend.reconcileOwnedSandboxes()).removed,false);
  // The delayed create materializes after that first empty listing.
  await f.sbx.run(['create','--name',NAME]);
  f.clock.at+=1000;
  const restarted=f.make();
  await restarted.reapCleanup();
  assert.deepEqual(removals(f.sbx).map(args=>args.at(-1)),[NAME],'the name this install dispatched is removed');
  // The removal follows a listing, in this row's HOME, that shows the name.
  const calls=f.sbx.calls().map(args=>args[0]+(args[0]==='rm'?' '+args.at(-1):''));
  assert.ok(calls.indexOf('rm '+NAME)>calls.indexOf('create'),'rm only after the sandbox exists');
  assert.equal(calls[calls.indexOf('rm '+NAME)-1],'ls','rm directly follows a listing');
  assert.deepEqual(f.sbx.read(),[]);
  assert.deepEqual(await records(f.directory),[],'the row closes after the removal');
  assert.equal(existsSync(f.scratch),false);
  assert.deepEqual(f.released,[NAME]);
});

test('old absent creates release resources behind a permanent fence after the create wait',async t=>{
  const f=await stuckRoot(t),backend=f.make();
  assert.equal((await backend.reconcileOwnedSandboxes()).removed,false);
  f.clock.at+=2*READY-1;
  assert.equal((await f.make().reconcileOwnedSandboxes()).removed,false,'one millisecond before the bound');
  f.clock.at+=1;
// The release rule now permits old never-created rows to drain after fresh
  // complete absence and scoped cleanup, provided the permanent name fence remains.
  const proof=await f.make().reconcileOwnedSandboxes();
  assert.equal(proof.admission_allowed,true);assert.equal(proof.removed,true);
  assert.equal(proof.watching??0,0);
  assert.equal((await records(f.directory)).length,0,'old cleanup debt drains');
  assert.equal(JSON.parse(await readFile(join(f.directory,NAME+'.scope.reserved'),'utf8')).abandoned_create,true);
  assert.equal(existsSync(f.scratch),false);
  assert.deepEqual(f.released,[NAME]);
  // The released proof is not reused: a late create is found by the next call in the same process.
  const same=f.make();
  assert.equal((await same.reconcileOwnedSandboxes()).admission_allowed,true);
  await f.sbx.run(['create','--name',NAME]);
  await same.reconcileOwnedSandboxes();
  assert.deepEqual(removals(f.sbx).map(args=>args.at(-1)),[NAME]);
});

test('fresh old absence drains the row and its permanent fence removes a create landing a day late',async t=>{
  const f=await stuckRoot(t);
  await f.make().reconcileOwnedSandboxes();
  f.clock.at+=2*READY;
// The release rule now permits old never-created rows to drain after fresh
  // complete absence and scoped cleanup, provided the permanent name fence remains.
  assert.equal((await f.make().reconcileOwnedSandboxes()).admission_allowed,true,'admission released after the bound');
  f.clock.at+=25*HOUR;
  assert.equal((await f.make().reconcileOwnedSandboxes()).admission_allowed,true);
  assert.equal((await records(f.directory)).length,0,'verified old absence drains the row');
  assert.equal(existsSync(f.scratch),false,'scratch is removed');
  assert.deepEqual(f.released,[NAME],'storage is released');
  assert.equal(JSON.parse(await readFile(join(f.directory,NAME+'.scope.reserved'),'utf8')).abandoned_create,true);
  assert.deepEqual(removals(f.sbx),[]);
  await f.sbx.run(['create','--name',NAME]);
  await f.make().reapCleanup();
  assert.deepEqual(removals(f.sbx).map(args=>args.at(-1)),[NAME]);
  assert.deepEqual(f.sbx.read(),[]);
  assert.deepEqual(await records(f.directory),[]);
  assert.equal(existsSync(f.scratch),false);
  assert.deepEqual(f.released,[NAME]);
});

test('pending recovery keeps recent absence unknown and resolves old fenced cleanup',async t=>{
  const f=await stuckRoot(t);
  const pending=backend=>({...backend.sandboxOwnership(),jobId:'job-stuck',attemptId:'attempt-stuck',attempt:{attempt_id:'attempt-stuck'}});
  for(const advance of [0,2*READY,25*HOUR]) {
    f.clock.at+=advance;
    const backend=f.make();
    const proof=await backend.reconcilePending(pending(backend));
    if(advance===0) {
      assert.equal(proof.removed,false,'recent absence is unknown');
      assert.equal(proof.code,'cessation_unverified');
      assert.notEqual(proof.scratch_removed,true);assert.notEqual(proof.data_cleanup,'removed');
      assert.equal((await records(f.directory)).length,1);assert.equal(existsSync(f.scratch),true);assert.deepEqual(f.released,[]);
    }else {
      assert.equal(proof.removed,true,'old verified absence resolves cleanup');
      assert.equal(proof.scratch_removed,true);assert.equal(proof.data_cleanup,'removed');
      assert.equal((await records(f.directory)).length,0);assert.equal(existsSync(f.scratch),false);assert.deepEqual(f.released,[NAME]);
      assert.equal(JSON.parse(await readFile(join(f.directory,NAME+'.scope.reserved'),'utf8')).abandoned_create,true);
    }
    assert.equal(proof.cessationVerified,undefined);
  }
});

test('a create that exceeds its timeout is refused and its row stays watched',async t=>{
  const f=await stuckRoot(t);
  const timeouts=[];
  const sbx=fileSbx(join(f.root,'sbx2'),{create:async(name,args,options)=>{
    timeouts.push(options?.timeout);
    return {code:1,stderr:'timed out',materialize:false};
  }});
  const backend=receiptBackend(f.root,sbx,{now:()=>f.clock.at,storage:{available:async()=>true,release:async()=>{}}});
  await assert.rejects(backend.prepare(receiptJob()),{code:'sandbox_start_failed'});
  assert.deepEqual(timeouts,[READY],'create runs under the ready budget, not unbounded');
  const [name]=sbx.created();
  const restarted=receiptBackend(f.root,sbx,{now:()=>f.clock.at,storage:{available:async()=>true,release:async()=>{}}});
  assert.equal((await restarted.reconcileOwnedSandboxes()).removed,false);
  assert.ok((await records(f.directory)).length>=2,'the refused create row is kept: '+name);
});

const guestGrants=(sbx,name)=>({
  secrets:sbx.secrets.filter(row=>row.scope===name).length,
  rules:(sbx.policy.state.sandboxes[name]??[]).length});
const startsOf=(sbx,name)=>sbx.calls().filter(args=>['run','exec','start'].includes(args[0])&&args.includes(name));
for(const [label,job] of [['helper guest',receiptJob()],['provider',receiptJob({image:'codex',auth_strategy:'docker-native-oauth',execution_scope:'owner'})]])
test(`a sandbox that appears after admission resumes holds no grant and runs nothing, and the watch removes it (${label})`,async t=>{
  const f=await stuckRoot(t);
  const storage={available:async()=>true,release:async()=>{}};
  let late=false,sbx,atDispatch;
  sbx=fileSbx(join(f.root,'sbx2'),{create:async(name)=>{
    if(late)return {code:0};
    // The preparing process had bound a credential to the reserved name and the daemon had attached its rules.
    sbx.secrets.push({scope:name,type:'service',name:sbx.GITHUB_SERVICE});
    atDispatch=guestGrants(sbx,name);
    return {code:1,stderr:'timed out',materialize:false};
  }});
  const make=()=>receiptBackend(f.root,sbx,{now:()=>f.clock.at,storage});
  await assert.rejects(make().prepare(job));
  const [name]=sbx.created();
  // A real `sbx create` scopes its kit's allow rules and the private-network denies to the sandbox only when it exists
  // (docker-backend policy comment: kit rules are "recreated at sandbox create"), so a create that never landed has none.
  assert.ok(atDispatch.secrets>0&&atDispatch.rules===0,'a credential is bound before dispatch, no rule exists yet: '+JSON.stringify(atDispatch));
  // Recovery observes the sandbox absent. Revocation is verified before the wait can end.
  assert.equal((await make().reconcileOwnedSandboxes()).removed,false);
  assert.equal(guestGrants(sbx,name).secrets,0,'the scoped credential is revoked on the first observation');
  assert.ok(sbx.calls().some(args=>args[0]==='policy'&&args[1]==='ls'),'the name-scoped network rules were checked');
  f.clock.at+=2*READY;
  const released=await make().reconcileOwnedSandboxes();
// The release rule now permits old never-created rows to drain after fresh
  // complete absence and scoped cleanup, provided the permanent name fence remains.
  assert.equal(released.admission_allowed,true,'admission resumes');assert.equal(released.removed,true);
  assert.equal(released.watching??0,0);
  assert.deepEqual(removals(sbx),[]);
  // Only now does the delayed create land.
  late=true;
  await sbx.run(['create','--name',name]);
  // Effective state at the moment of materialization, before any reaper pass.
  assert.equal(guestGrants(sbx,name).secrets,0,'no credential and no proxy secret binding for the late sandbox');
  assert.ok(!sbx.calls().some(args=>args[0]==='secret'&&args[1]==='set'),'nothing staged a secret');
  const inherited=sbx.policy.state.sandboxes[name];
  assert.ok(inherited.length>0,'the late create does attach its kit rules');
  assert.ok(inherited.every(rule=>rule.decision==='allow'&&rule.resources.every(r=>r==='api.anthropic.com:443')),
    'only the kit provisioning allowance, no job or proxy grant: '+JSON.stringify(inherited));
  assert.deepEqual(startsOf(sbx,name),[],'no entrypoint, exec or start for the late sandbox');
  assert.equal((await records(f.directory)).length,0,'cleanup rows are gone');
  assert.equal(JSON.parse(await readFile(join(f.directory,name+'.scope.reserved'),'utf8')).abandoned_create,true,'the exact name stays fenced');
  await make().reapCleanup();
  assert.deepEqual(removals(sbx).map(args=>args.at(-1)),[name],'the watch removes it by exact name');
  assert.deepEqual(startsOf(sbx,name),[]);
  assert.deepEqual(sbx.read(),[]);
  assert.deepEqual(guestGrants(sbx,name),{secrets:0,rules:0},'its kit rules are gone with the sandbox');
  assert.ok(!sbx.calls().some(args=>args[0]==='policy'&&['allow','deny'].includes(args[1])),'no policy was granted by recovery');
  assert.ok(!sbx.calls().some(args=>args[0]==='run'),'no run anywhere');
});

test('a failed or thrown revocation keeps the hold with its own reason and retries',async t=>{
  for(const mode of ['false','throw']) {
    const f=await stuckRoot(t);
    f.sbx.secrets.push({scope:NAME,type:'service',name:f.sbx.GITHUB_SERVICE});
    let broken=true;
    const run=async(args,options)=>{
      if(broken&&args[0]==='secret'&&args[1]==='rm') {
        if(mode==='throw')throw new Error('secret store down');
        return {code:1,stdout:'',stderr:'denied'};
      }
      return f.sbx.run(args,options);
    };
    // A listing that still shows the value makes the revocation false; a thrown listing makes it throw.
    const guarded=async(args,options)=>broken&&mode==='throw'&&args[0]==='secret'&&args[1]==='ls'?Promise.reject(new Error('down')):run(args,options);
    const backend=f.make(guarded);
    assert.equal((await backend.reconcileOwnedSandboxes()).removed,false);
    f.clock.at+=5*READY;
    assert.equal((await f.make(guarded).reconcileOwnedSandboxes()).removed,false,mode+': the bound alone never resumes admission');
    assert.ok(f.make(guarded).cleanupStatus().remediation.some(row=>row.name===NAME&&row.reason==='credential_revocation_pending'),mode);
    broken=false;
    // The release rule now resolves old absent creates once scoped cleanup succeeds.
    const retried=await f.make(guarded).reconcileOwnedSandboxes();
    assert.equal(retried.admission_allowed,true,mode+': retried once revocation works');assert.equal(retried.removed,true);
    assert.equal((await records(f.directory)).length,0);
    assert.equal(f.sbx.secrets.length,0);
  }
});

for(const requested of [false,true])test('restart settles old fenced cleanup once; execution requested='+requested,async t=>{
  const f0=await stuckRoot(t);
  await f0.make().reconcileOwnedSandboxes();
  f0.clock.at+=2*READY;
  const backend=f0.make();
  const f=await lenderFixture(t);
  const attemptId=JSON.parse(await readFile(new URL('../docs/protocol/vectors/golden.json',import.meta.url),'utf8')).objects.result.envelope.payload.attempt_id;
  const pending={...backend.sandboxOwnership(),attemptId,jobId:'job-stuck',reservedMs:60000,prepare_contract:'create-only',...(requested?{executionStartRequested:true}:{}),
    attempt:{attempt_id:attemptId,job_digest:f.jobDigest,generation:1}};
  await f.policy.storage.set({day:'2026-10-09',jobs:1,milliseconds:60000,pending,requesters:{}});
  for(const method of ['reconcileOwnedSandboxes','isOwnedSandboxAdmissionCurrent','reconcilePending','isSandboxHomeCurrent','sandboxOwnership'])
    f.backend[method]=(...args)=>backend[method](...args);
  // The release of the interrupted claim is not under test here; this coordinator serves no job lookup to confirm it.
  f.client.release=async()=>({state:'released'});
  const stoppedCalls=[];
  f.client.stopped=async(...args)=>{stoppedCalls.push(args[0].attempt_id);return {state:'stopped'};};
  const controller=new AbortController(),lender=createLender({...f.runOptions,client:f.client,backend:f.backend,policy:f.policy,adapters:f.adapters,clock:f.clock,onEvent:e=>f.events.push(e)});
  const running=lender.start(controller.signal);running.catch(()=>{});
  try {
    await until(()=>f.saved()?.pending===null&&f.saved()?.lastRecovery?.attemptId===attemptId,'pending released');
    assert.equal(f.saved().lastRecovery.removed,true,'old fenced cleanup resolves the attempt');
    assert.equal(f.saves.some(row=>row.pending?.cessationVerified),true,'cessation follows verified fenced cleanup');
    assert.deepEqual(f.saved().scratchPending??[],[],'scratch belongs to the watch row, not a blocking slot');
    assert.equal(f.saved().jobs,requested?1:0,requested?'an explicit execution request retains its full charge':'the unstarted reservation is released');
    assert.equal(f.saved().milliseconds,requested?60000:0,'only never-started evidence refunds time');
    assert.equal((await records(f0.directory)).length,0,'old debt drains');
    assert.equal(existsSync(f0.scratch),false);
    assert.deepEqual(f0.released,[NAME]);
    assert.equal(JSON.parse(await readFile(join(f0.directory,NAME+'.scope.reserved'),'utf8')).abandoned_create,true);
    assert.notEqual(lender.getState().status,'stopping');
    assert.notEqual(lender.admits(null),'cessation_unverified');
    // Verified old cleanup settles once; later materialization cannot duplicate its report.
    for(let i=0;i<5;i++){f.clock.advance(3000);await new Promise(r=>setTimeout(r,20));}
    assert.equal(stoppedCalls.length,1,'one stopped report after old cleanup');
    assert.equal(f.saved().stoppedPending??null,null);
    assert.deepEqual(f.saved().watchedStops??[],[]);
    // A late name is removed behind the permanent fence without another report.
    await f0.sbx.run(['create','--name',NAME]);
    await backend.reapCleanup();
    assert.deepEqual(removals(f0.sbx).map(args=>args.at(-1)),[NAME]);
    assert.deepEqual(await records(f0.directory),[]);
    for(let i=0;i<200&&stoppedCalls.length<1;i++){f.clock.advance(3000);await new Promise(r=>setTimeout(r,20));}
    assert.equal(stoppedCalls.length,1,'exactly one final stopped report');
    for(let i=0;i<5;i++){f.clock.advance(3000);await new Promise(r=>setTimeout(r,20));}
    assert.equal(stoppedCalls.length,1);
    assert.deepEqual(f.saved().watchedStops??[],[]);
  } finally {
    controller.abort();await running.catch(()=>{});
  }
});

// Cleanup isolation rule: a permanently reserved name is removed if it appears.
test('a listed reserved sandbox without an old absence receipt is removed by its own name',async t=>{
  const f=await stuckRoot(t,{listed:true}),backend=f.make();
  assert.equal((await backend.reconcileOwnedSandboxes()).removed,true);
  assert.deepEqual(await records(f.directory),[]);
  assert.deepEqual(removals(f.sbx).map(args=>args.at(-1)),[NAME]);
  assert.equal(JSON.parse(await readFile(join(f.directory,NAME+'.scope.reserved'),'utf8')).retired_name,true);
});

test('a failed or unparsable listing keeps the row and starts no watch clock',async t=>{
  for(const listing of [{code:1,stdout:'',stderr:'daemon down'},{code:0,stdout:'not json'}]) {
    const f=await stuckRoot(t),run=f.sbx.run;
    const backend=f.make(async(args,options)=>args[0]==='ls'?listing:run(args,options));
    assert.equal((await backend.reconcileOwnedSandboxes()).removed,false,JSON.stringify(listing));
    f.clock.at+=3*READY;
    assert.equal((await f.make(async(args,options)=>args[0]==='ls'?listing:run(args,options)).reconcileOwnedSandboxes()).removed,false,'time alone never releases');
    assert.equal((await records(f.directory)).length,1);
    assert.deepEqual(removals(f.sbx),[]);
  }
});

// Admission needs the hand-off to the shared watcher, not a time bound: once the watcher has the name, the lender takes
// work (docs/design/SANDBOX-CLEANUP-RECOVERY.md, "Hand-off to the shared watcher": "Only then may the old sandbox guard
// retire and the cleanup check release the hold for that name"), and the row stays (same section: "The record and its
// remaining cleanup duties stay visible"). Lending stuck in Stopping still fails this test.
test('the lender is never held in stopping by a watched row, before or after the bound, and the row stays',async t=>{
  const f0=await stuckRoot(t),f=await lenderFixture(t);
  const backend=f0.make();
  f.backend.reconcileOwnedSandboxes=options=>backend.reconcileOwnedSandboxes(options);
  f.backend.isOwnedSandboxAdmissionCurrent=proof=>backend.isOwnedSandboxAdmissionCurrent(proof);
  const controller=new AbortController(),lender=createLender({...f.runOptions,client:f.client,backend:f.backend,policy:f.policy,adapters:f.adapters,clock:f.clock,approve:async()=>true,onEvent:e=>f.events.push(e)});
  const running=lender.start(controller.signal);running.catch(()=>{});
  try {
    const claimed=()=>f.requests.some(r=>r.route==='/jobs/claim-next');
    // Admission after recovery is shown by the lender asking for work, not by "some event, not stopping".
    await until(()=>{if(!claimed()&&f.clock.pending().includes(3000))f.clock.advance(3000);return claimed();},'the lender asks for work after recovery');
    assert.notEqual(lender.getState().status,'stopping');
    assert.equal(f.events.some(e=>e.status==='stopping'&&e.reason==='cleanup_pending'),false,'no hold is raised for the watched row');
    assert.equal((await records(f0.directory)).length,1,'the obligation is not discharged');
    f0.clock.at+=2*READY;
    const before=f.requests.filter(r=>r.route==='/jobs/claim-next').length;
    await until(()=>{if(f.requests.filter(r=>r.route==='/jobs/claim-next').length<=before&&f.clock.pending().includes(3000))f.clock.advance(3000);return f.requests.filter(r=>r.route==='/jobs/claim-next').length>before;},'the lender asks for work again after the bound');
    assert.notEqual(lender.getState().status,'stopping');
    assert.notEqual(lender.admits(null),'cessation_unverified');
    assert.equal((await records(f0.directory)).length,1,'time alone does not discharge the row');
  } finally {controller.abort();await running.catch(()=>{});}
});

test('status_blockers reports the hold with the sandbox name, and nothing once it closes',async()=>{
  const call=held=>async id=>structuredClone({
    'status.get':{intent:{on:true},blockers:held?[{kind:'cessation_unverified'}]:[],lending:held?{remediation:[{name:NAME,reason:'creation_unproven'}]}:{},lending_blockers:null},
    'readiness.get':{ready:true,checks:[]},
    'agents.list':[{id:'codex',name:'Codex',useForLending:true,installed:true,signedIn:true}],
    'circles.list':[]})[id];
  const held=await opById('status.blockers').handler({call:call(true)});
  assert.equal(held.can_lend,false);
  assert.equal(held.blockers.length,1);
  assert.equal(held.blockers[0].kind,'cessation_unverified');
  assert.match(held.blockers[0].message,new RegExp(NAME));
  const clear=await opById('status.blockers').handler({call:call(false)});
  assert.deepEqual(clear.blockers,[]);
  assert.equal(clear.can_lend,true);
});

test('the running app lists the hold as a blocker while the lender waits, and drops it when the sandbox is confirmed gone',{timeout:60000},async t=>{
  const {appFixture}=await import('./helpers/triage-small-app-fixture.mjs');
  const {api,waitFor}=await import('./helpers/v1-app-fixture.mjs');
  const f=await appFixture(t),{lender,circle}=await f.connect();
  let gone=false;
  lender.backend.reconcileOwnedSandboxes=async()=>({removed:gone,admission_allowed:true,foreign:[]});
  lender.backend.isOwnedSandboxAdmissionCurrent=()=>true;
  lender.backend.cleanupSlotHold=()=>gone?null:'cessation_unverified';
  lender.backend.cleanupStatus=()=>({items:gone?[]:[{id:'synthetic-row',name:NAME,home:'/synthetic',account_key:'codex',compute_may_run:true,reason:'cleanup_deferred'}]});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  await waitFor(async()=>(await api(lender.app,'/api/status')).blockers?.some(b=>b.kind==='cleanup_pending'),'hold listed as a blocker');
  // The raw blocker the app emits carries the same plain sentence and fix that status.blockers reports.
  const raw=(await api(lender.app,'/api/status')).blockers.find(b=>b.kind==='cleanup_pending');
  assert.match(raw.message??'',new RegExp(NAME));
  assert.equal(raw.fix.op,'cleanup.retry');assert.equal(raw.fix.human,'Clean up now'); // One per-row action under the isolation rule.
  const listed=(await api(lender.app,'/api/ops/status.blockers',{method:'POST',body:{}})).blockers.find(b=>b.kind==='cleanup_pending');
  assert.equal(listed.message,raw.message);
  gone=true;
  await waitFor(async()=>!(await api(lender.app,'/api/status')).blockers?.some(b=>b.kind==='cleanup_pending'),'blocker dropped',20000);
});

// Two attempts whose sandboxes are both still watched: each keeps its own final report, and each resolves alone.
async function watchedLender(t) {
  const f=await lenderFixture(t);
  const removed=new Set(),stopped=[],home='/watched-home';
  f.backend.sandboxOwnership=()=>({owner_scope:'f'.repeat(64),sbx_home:home});
  f.backend.isSandboxHomeCurrent=()=>true;
  f.backend.reconcilePending=async row=>removed.has(row.attemptId)
    ?{removed:true,attemptId:row.attemptId,sbx_home:home,scratch_removed:true}
    :{removed:false,watching:true,attemptId:row.attemptId,sbx_home:home};
  f.client.release=async()=>({state:'released'});
  f.client.stopped=async attempt=>{stopped.push(attempt.attempt_id);return {state:'stopped'};};
  const pendingFor=attemptId=>({owner_scope:'f'.repeat(64),sbx_home:home,attemptId,jobId:'job-'+attemptId.slice(0,4),reservedMs:60000,
    prepare_contract:'create-only',attempt:{attempt_id:attemptId,job_digest:f.jobDigest,generation:1}});
  // One lender run, ended as soon as the condition holds (a restart is the next run).
  const run=async done=>{
    const controller=new AbortController(),lender=createLender({...f.runOptions,client:f.client,backend:f.backend,policy:f.policy,adapters:f.adapters,clock:f.clock,onEvent:e=>f.events.push(e)});
    const running=lender.start(controller.signal);running.catch(()=>{});
    try {
      for(let i=0;i<300&&!done();i++){f.clock.advance(3000);await new Promise(r=>setTimeout(r,20));}
      assert.ok(done(),'condition reached');
    } finally {controller.abort();await running.catch(()=>{});}
  };
  const settle=async()=>{await run(()=>false).catch(()=>{});};
  return {f,removed,stopped,pendingFor,run,settle};
}
const ATTEMPT_A='11111111-1111-4111-8111-111111111111',ATTEMPT_B='22222222-2222-4222-8222-222222222222';

test('two watched attempts keep one report each, resolve in reverse order across a restart, and each is reported once',async t=>{
  const w=await watchedLender(t);
  const {f}=w;
  const seed=pending=>f.policy.storage.set({...(f.saved()??{day:'2026-10-09',requesters:{}}),jobs:1,milliseconds:60000,pending});
  await seed(w.pendingFor(ATTEMPT_A));
  await w.run(()=>f.saved()?.pending===null&&f.saved()?.watchedStops?.length===1);
  // A restart later finds a second interrupted attempt while the first watch is still open.
  await seed(w.pendingFor(ATTEMPT_B));
  await w.run(()=>f.saved()?.pending===null&&f.saved()?.watchedStops?.length===2);
  assert.deepEqual(f.saved().watchedStops.map(row=>row.attemptId).sort(),[ATTEMPT_A,ATTEMPT_B]);
  assert.deepEqual(w.stopped,[],'nothing is reported while both watches are open');
  // The later watch resolves first; the earlier one stays open across a restart.
  w.removed.add(ATTEMPT_B);
  await w.run(()=>w.stopped.length===1);
  assert.deepEqual(w.stopped,[ATTEMPT_B]);
  await w.run(()=>f.saved()?.stoppedPending==null);
  assert.deepEqual(f.saved().watchedStops.map(row=>row.attemptId),[ATTEMPT_A],'only its own entry left the collection');
  w.removed.add(ATTEMPT_A);
  await w.run(()=>w.stopped.length===2&&f.saved().watchedStops==null);
  await w.run(()=>f.saved()?.stoppedPending==null);
  assert.deepEqual(w.stopped,[ATTEMPT_B,ATTEMPT_A],'each attempt is reported exactly once, in resolution order');
});
