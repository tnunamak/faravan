import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, api, syntheticBackend} from './helpers/v1-app-fixture.mjs';

// "Faravan is starting it" and "no action for you" are true only while a repair really runs. When the repair
// ended without fixing the check, the row is a blocked state with a button the person can press.
const ok = name => ({name, ok: true});
const failing = (name, over) => ({name, ok: false, detail: 'x', fix: '', automatic: true, ...over});

async function statusAfterFailedRepair(t, checks, recoverHealth) {
  const f = await appFixture(t), backend = syntheticBackend(f.root);
  backend.probeCapabilities = async () => ({available: false, preflight: {ok: false, checks}});
  backend.recoverHealth = recoverHealth;
  const {app} = await f.start('owner', {backend});
  await api(app, '/api/readiness?refresh=true');
  return (await api(app, '/api/status')).lending_blockers;
}

test('a sandbox service whose repair threw is not described as being started', {timeout: 60000}, async t => {
  const model = await statusAfterFailedRepair(t, [ok('sbx_install'), failing('sbx_daemon', {detail: 'The sandbox service is not running yet.'}), ok('docker_login')],
    async () => { throw new Error('repair failed'); });
  const row = model.items.find(item => item.key === 'docker_running');
  assert.doesNotMatch(row.detail, /starting it/, 'no repair runs, so the row must not say one does');
  assert.equal(row.status, 'blocked');
  assert.equal(row.action, 'Check again');
});

test('an automatic network-rule failure that the repair did not fix offers Retry network setup', {timeout: 60000}, async t => {
  const model = await statusAfterFailedRepair(t, [ok('sbx_install'), ok('sbx_daemon'), ok('docker_login'), failing('network_policy', {detail: 'The sandbox network rules are not set.'})],
    async () => ({recovered: false}));
  const row = model.items.find(item => item.cause === 'network_policy');
  assert.equal(row.status, 'blocked');
  assert.equal(row.action, 'Retry network setup', 'a needs-you row names its action');
});

import {lendingBlockers} from '../lib/v1/blockers.mjs';
import {sandboxServiceUnavailableHold,deadlineRecoveryError} from '../lib/sandbox-remediation.mjs';

test('Docker installation and the sandbox service have distinct labels',()=>{
 const model=lendingBlockers({docker:{installed:null,running:null,signedIn:null},intent:{on:true}});
 assert.notEqual(model.items.find(row=>row.key==='docker_installed').label,model.items.find(row=>row.key==='docker_running').label);
});

for(const signedOut of [true,false])test('known sandbox refusal replaces idle spinners: '+(signedOut?'signed out':'service unavailable'),{timeout:20000},async t=>{
 const f=await appFixture(t),backend=syntheticBackend(f.root);
 const hold=sandboxServiceUnavailableHold({stderr:signedOut?'error: not signed in to Docker':'503 Service Unavailable'},{rowCount:319});
 backend.deadlineRecoveryHold=()=>hold;
 backend.ensureSandboxAdmission=async()=>{throw deadlineRecoveryError(hold);};
 backend.recoverSandboxDeadlines=async()=>{throw deadlineRecoveryError(hold);};
 const {app}=await f.start('known-readiness-refusal',{backend,cleanupRecheckMs:60000});
 const readiness=await api(app,'/api/readiness');assert.equal(readiness.ready,false);assert.equal(readiness.checks[0].ok,false);
 const status=await api(app,'/api/status'),blockers=await api(app,'/api/ops/status.blockers',{method:'POST',body:{}});
 for(const model of [status.lending_blockers,blockers.ordered]){
  const row=model.items.find(item=>item.key===(signedOut?'docker_signin':'docker_running'));
  assert.equal(row.status,'blocked');assert.equal(row.action,signedOut?'Sign in to Docker':'Check again');
  assert.ok(!model.items.some(item=>item.status==='unknown'||/Checking…/.test(item.detail)),JSON.stringify(model.items));
  assert.equal(model.canLend,false);
 }
 assert.equal(blockers.can_lend,false);
});

test('a known sleeping host is named instead of leaving dependent agent checks spinning',{timeout:20000},async t=>{
 const f=await appFixture(t),backend=syntheticBackend(f.root);
 backend.probeCapabilities=async()=>({available:false,preflight:{ok:false,checks:[ok('sbx_install'),failing('sbx_daemon',{detail:'This computer is asleep. Wake it to lend.',fix:'Wake this computer.',cause:'host_not_awake'})]}});
 const {app}=await f.start('sleeping-readiness',{backend});await api(app,'/api/readiness?refresh=true');
 const model=(await api(app,'/api/status')).lending_blockers,row=model.items.find(item=>item.key==='docker_running');
 assert.equal(row.status,'blocked');assert.match(row.detail,/asleep/);assert.ok(row.action);assert.equal(row.label,'Sandbox service');
 assert.ok(!model.items.some(item=>item.status==='unknown'));
});

test('Checking requires a current check and expires while a transport remains hung',{timeout:20000},async t=>{
 const f=await appFixture(t),backend=syntheticBackend(f.root);let elapsed=0,release,entered;
 const begun=new Promise(resolve=>{entered=resolve;}),pending=new Promise(resolve=>{release=resolve;});
 backend.probeCapabilities=async()=>{entered();return pending;};
 const {app}=await f.start('bounded-status-check',{backend,monotonic:()=>elapsed,shutdownProofMs:500});await begun;
 try {
  const during=(await api(app,'/api/status')).lending_blockers;
  assert.ok(during.items.some(item=>item.status==='unknown'&&item.detail==='Checking…'));
  elapsed=20001;
  const after=(await api(app,'/api/status')).lending_blockers;
  assert.ok(!after.items.some(item=>item.status==='unknown'||item.detail==='Checking…'));
  assert.equal(after.canLend,false);assert.ok(after.items.some(item=>item.status==='blocked'&&item.action==='Check again'));
 }finally{release({available:true,preflight:{ok:true,checks:[ok('sbx_install'),ok('sbx_daemon'),ok('docker_login')]}});await api(app,'/api/readiness?refresh=true').catch(()=>{});}
});

test('a fresh readiness refusal outranks an older unknown ordered snapshot',()=>{
 const model=lendingBlockers({docker:{installed:null,running:null,signedIn:null},intent:{on:true},agents:[{id:'codex',enabled:true,installed:null,signedIn:null}],
  readiness:{ready:false,checks:[{name:'sbx_daemon',ok:false,label:'error: not signed in to Docker',remedy:'Sign in to Docker'}]},checking:{machine:false,agents:[]}});
 assert.equal(model.first?.key,'docker_signin');assert.equal(model.first.action,'Sign in to Docker');assert.ok(!model.items.some(row=>row.status==='unknown'));
});

test('blockers offers the fresh sign-in action even when status was read before readiness finished',async()=>{
 const {opById}=await import('../lib/v1/ops/registry.mjs');
 const ordered=lendingBlockers({docker:{installed:null,running:null,signedIn:null},intent:{on:true}});
 const status={state:'paused',intent:{on:true,state:'paused'},blockers:[],lending_blockers:ordered};
 const readiness={ready:false,checks:[{name:'sbx_daemon',ok:false,label:'error: not signed in to Docker',remedy:'Sign in to Docker'}]};
 const value=await opById('status.blockers').handler({call:async id=>id==='status.get'?status:id==='readiness.get'?readiness:id==='agents.list'?[{id:'codex',useForLending:true,installed:true,signedIn:true}]:[]},{});
 assert.equal(value.ordered.first?.key,'docker_signin');assert.ok(value.next_steps.some(step=>/signin.start|Sign in to Docker/.test(step)),JSON.stringify(value.next_steps));
});

test('an expired observation does not claim Docker was proven stopped',async()=>{
 const {effectiveState}=await import('../lib/v1/lending-state.mjs'),agents=[{id:'codex',enabled:true,installed:true,signedIn:true}];
 const status=effectiveState({intent:'on',agents,blocking:{docker:{installed:null,running:null,signedIn:null},agents,checking:{machine:false,agents:[]}}});
 assert.equal(status.intent.reason,'sandbox_not_ready');
});

test('a new sign-in generation never serves a healthy answer from the previous generation while its probe hangs',{timeout:20000},async t=>{
 const f=await appFixture(t),backend=syntheticBackend(f.root);let generation=0,release;
 Object.defineProperty(backend,'signInGeneration',{get:()=>generation});
 const {app}=await f.start('generation-readiness',{backend,statusReadTimeoutMs:25});
 assert.equal((await api(app,'/api/readiness?refresh=true')).ready,true);
 const pending=new Promise(resolve=>{release=resolve;});backend.probeCapabilities=async()=>pending;generation++;
 try {
  const next=await api(app,'/api/readiness');
  assert.equal(next.ready,false,'a prior generation cannot supply current readiness');
  assert.ok(next.checks.some(check=>check.unknown===true));
 }finally{release({available:true,preflight:{ok:true,checks:[ok('sbx_install'),ok('sbx_daemon'),ok('docker_login')]}});await api(app,'/api/readiness?refresh=true').catch(()=>{});}
});

test('blockers reads the canonical status after readiness settles so its headline and summary agree',async()=>{
 const {opById}=await import('../lib/v1/ops/registry.mjs');let observed=false;
 const readiness={ready:false,checks:[{name:'docker_login',ok:false,label:'Not signed in.',remedy:'Sign in to Docker'}]};
 const healthy=lendingBlockers({docker:{installed:true,running:true,signedIn:true},intent:{on:true}});
 const failed=lendingBlockers({docker:{installed:true,running:true,signedIn:false},intent:{on:true},readiness});
 const status=fresh=>({state:fresh?'blocked':'ready',reason:fresh?'docker_signed_out':null,intent:{on:true,state:'ready'},
  headline:fresh?failed.headline:'Lending is on',summary:{headline:fresh?failed.headline:'Ready to lend'},
  blockers:fresh?[{kind:'docker_signed_out',message:'Sign in to Docker.'}]:[],lending_blockers:fresh?failed:healthy});
 const value=await opById('status.blockers').handler({call:async id=>{
  if(id==='readiness.get'){await Promise.resolve();observed=true;return readiness;}
  if(id==='status.get')return status(observed);
  return [];
 }},{});
 assert.equal(value.can_lend,false);assert.equal(value.state,'blocked');
 assert.equal(value.headline,failed.headline);assert.equal(value.summary.headline,failed.headline);
});
