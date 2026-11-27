import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,lstat,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import {createLender} from '../lib/v1/lender.mjs';
import {createLendingPool} from '../lib/v1/lending-pool.mjs';
import {runAccountsCommand} from '../lib/v1/accounts-cli.mjs';
import {claudeAccountAdmission} from '../lib/claude-accounts.mjs';
import {accountBackend} from './helpers/claude-account-backend.mjs';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
import {until,deferred} from './helpers/v1-lender-fixture.mjs';
import {guestExec,collectGuest} from './helpers/git-guest.mjs';
import {resultArchive} from './helpers/v1-journey.mjs';

const token=()=>'sk-ant-oat01-'+randomBytes(32).toString('hex');
const quiet={write(){}};
// The app's own composition: the pool tells the hold which account a worker serves.
const gateFor=f=>claudeAccountAdmission({accounts:()=>f.registry.list(),sbxHome:()=>f.home,runtime:()=>f.backend.claudeAccountRuntime()});
const memory=(value=null)=>{let disk=value;return {get:async()=>structuredClone(disk),set:async next=>{disk=structuredClone(next);},acquire:async()=>()=>{},peek:()=>disk};};

// The lender's candidate keeps each reservation under the account the worker asked for; every settlement is recorded.
function reservations(policy){
 const base=policy.lendingRuntime.candidate,held=new Map(),log=[];
 const candidate=Object.create(base);
 candidate.reserve=async args=>{
  log.push(['reserve',args.accountKey??args.provider]);
  const grant=await base.reserve.call(base,args);
  if(!grant.ok)return grant;
  held.set(args.attemptId,args.accountKey??args.provider);
  return {...grant,reservation:{...grant.reservation,...(args.accountKey?{accountKey:args.accountKey}:{})}};
 };
 candidate.finish=async args=>{log.push(['finish',args.accountKey??args.provider]);held.delete(args.attemptId);return base.finish.call(base,args);};
 candidate.settle=async(attemptId,intent)=>{log.push(['settle',intent.accountKey??intent.provider,intent.prepared,intent.reason]);held.delete(attemptId);return base.settle.call(base,attemptId,intent);};
 policy.lendingRuntime={...policy.lendingRuntime,candidate};
 return {held,log};
}

// The production backend prepares and removes each sandbox (account route, scoped value, journal); the agent run is synthetic.
function hybrid(f,{block=false}={}){
 const prod=f.backend,runs=[],prepares=[],gates=[];
 const backend={
  sandboxOwnership:()=>prod.sandboxOwnership(),
  ensureGuestRuntime:async()=>({node:process.execPath}),
  lenderCapabilities:()=>({available:true,backend_id:'fake',pinned_git:true,enforced_limits:['wall_seconds','cpu','memory_bytes','disk_bytes','output_bytes'],
   max_limits:{wall_seconds:600,cpu:2,memory_bytes:2147483648,disk_bytes:4294967296,output_bytes:10485760},egress:['internet','provider-only'],capabilities:['patch-output']}),
  admitJob:()=>({ok:true,enforced_limits:['cpu','memory','wall','output','storage'],unenforced:[]}),
  async probeCapabilities(){return {available:true};},
  async prepare(spec,options){
   prepares.push(options?.accountKey??null);
   // Host storage enforcement is not under test here; the production backend refuses a required storage limit without it.
   const handle=await prod.prepare({...spec,required_limits:spec.required_limits?.filter(limit=>limit!=='storage')},options);
   handle._entrypoint??=spec.entrypoint;
   handle._execution={...handle._execution,egress_evidence:{'api.example.test':'allowed'},enforced_limits:['cpu','memory','wall','output','storage'],unenforced:[]};
   return handle;
  },
  async cloneGitSource(handle,source){handle._execution.verified_commit=source.commit;},
  async start(handle,opts={}){
   if(handle._sourcePreparation&&handle._entrypoint.includes('FARAVAN_GIT_SOURCE_OK')){handle._lastExecStdout='FARAVAN_GIT_SOURCE_OK\n';return;}
   if(await guestExec(handle,handle._entrypoint))return;
   if(handle._entrypoint.startsWith('mkdir -p .wf-result')||/login status|auth status/.test(handle._entrypoint))return;
   const gate=deferred();gates.push(gate);
   runs.push({sandbox:handle.sandbox_id,env:handle._credentialEnv??null});
   opts.onExecutionStarted?.();
   if(block)await gate.promise;
   handle._lastExecStdout='{"type":"turn.completed","usage":{"input_tokens":13,"output_tokens":5}}\n';
   opts.onLog?.({stream:'stdout',chunk:Buffer.from(handle._lastExecStdout)});
  },
  async collectDeclaredOutputs(handle,manifest){return await collectGuest(handle,manifest)??[{path:'.wf-result/result.tar.gz',bytes_content:resultArchive()}];},
  async cancel(){for(const gate of gates)gate.reject(Object.assign(new Error('synthetic cancellation'),{name:'AbortError'}));return {compute_stopped:true};},
  destroy:handle=>prod.destroy(handle),
  cleanupStatus:()=>prod.cleanupStatus(),
 };
 return {backend,runs,prepares,release:()=>{for(const gate of gates)gate.resolve();}};
}

function launch(rf,{backend,accountKey,storage=memory(),events=[],diagnostics=[]}){
 const controller=new AbortController();
 const {storage:_unused,...policy}=rf.policy;
 const lender=createLender({client:rf.client,backend,adapters:rf.adapters,policy:{...policy,storage},clock:rf.clock,approve:async()=>true,
  onEvent:event=>events.push(event),onDiagnostic:entry=>diagnostics.push(entry),accountKey});
 const loop=Promise.resolve(lender.start(controller.signal)).catch(()=>{});
 return {lender,storage,events,diagnostics,stop:async()=>{controller.abort();await loop;}};
}

test('an added account stays unchecked until its scoped check passes, and admission follows that readiness',async t=>{
 const f=await accountBackend(t);
 let output='';const stdout={write:text=>output+=text};
 await runAccountsCommand(['add','claude','--label','Work'],{home:f.home,stdin:Readable.from([token()+'\n']),stdout,backend:f.backend});
 const added=JSON.parse(output),id=added.id,key=added.key;
 assert.equal(f.registry.get(id).enabled,false,'an added account is stored unchecked');
 const gate=gateFor(f);
 assert.equal(gate.reason(key),'claude_account_unavailable','nothing is admitted before the first readiness answer');
 assert.equal(gate.reason('claude'),null,'the default account is not judged by the added-account gate');
 await gate.refresh();
 assert.equal(gate.reason(key),'claude_account_unavailable','unchecked');
 f.flags.curl='401';
 assert.equal(await runAccountsCommand(['check',key],{home:f.home,stdout:quiet,backend:f.backend}),1);
 assert.equal(f.registry.get(id).enabled,false,'a failed check never enables the account');
 await gate.refresh();assert.equal(gate.reason(key),'claude_account_unavailable','401');
 f.flags.curl='200';
 assert.equal(await runAccountsCommand(['check',key],{home:f.home,stdout:quiet,backend:f.backend}),0);
 assert.equal(f.registry.get(id).enabled,true);
 await gate.refresh();assert.equal(gate.reason(key),null,'checked on this sbx and mixin');
 f.flags.version='newer-version';
 await gate.refresh();assert.equal(gate.reason(key),'claude_account_unavailable','sbx drift');
 assert.equal(gate.reason('claude'),null);
 f.flags.version='test-version';await gate.refresh();assert.equal(gate.reason(key),null);
 f.registry.setEnabled(id,false);await gate.refresh();assert.equal(gate.reason(key),'claude_account_unavailable','disabled by the owner');
});

test('an unready added account reserves nothing while the default account on the same computer takes the job',{timeout:60000},async t=>{
 let rf;
 t.after(async()=>{await rf?.stop?.();});
 const f=await accountBackend(t,{tokens:[token()]}),key=f.accounts[0].key;
 // Drift: the check was recorded for another sbx version.
 f.flags.version='newer-version';
 rf=await realLenderFixture(t,{harness:'claude-code-subscription',mutateJob:job=>{job.requirements.egress='provider-only';}});
 const {held,log}=reservations(rf.policy);
 const sbx=hybrid(f),gate=gateFor(f),events=[];
 const {storage:_unused,...policy}=rf.policy;
 policy.hold=(_job,{accountKey}={})=>gate.reason(accountKey);
 policy.lendingPolicy={accountSlots:1,machineSlots:2};
 // The saved counters name their calendar day; a store without one is refused as invalid (frozen counter-store safety).
 const today=new Date(rf.clock.now()).toISOString().slice(0,10),storage=memory({day:today,jobs:0,milliseconds:0,pending:null,accounts:{'claude:0':{day:today,jobs:0,milliseconds:0},[key+'#0']:{day:today,jobs:0,milliseconds:0}}});
 const pool=createLendingPool({createLender,storage,policy,adapters:rf.adapters,capacity:2,client:rf.client,backend:sbx.backend,
  clock:{now:rf.clock.now,monotonic:()=>performance.now()},approve:async()=>true,onEvent:e=>events.push(e)});
 const controller=new AbortController(),loop=pool.start(controller.signal);
 rf.stop=async()=>{controller.abort();await loop?.catch(()=>{});};
 await until(()=>log.some(([kind])=>kind==='finish'),'the job finished');
 assert.deepEqual(sbx.prepares,[null],'only the default account prepared a sandbox, with no account binding');
 assert.equal(log.some(([,account])=>account===key),false,'the unready account never reserved: '+JSON.stringify(log));
 assert.equal(held.size,0);
 await until(()=>pool.admits(null)===null,'the computer admits work again through the default account');
 const other=pool.getState().accountStates.find(s=>s.account===key+'#0');
 assert.equal(other.reason,'claude_account_unavailable',JSON.stringify(other));
 assert.equal(f.secrets.length,0);
});

test('two reservations on different added accounts get their own scoped values on their own sandboxes',{timeout:60000},async t=>{
 let rf;
 t.after(async()=>{await rf?.stop?.();});
 const tokens=[token(),token()];
 const f=await accountBackend(t,{tokens});
 rf=await realLenderFixture(t,{harness:'claude-code-subscription',mutateJob:job=>{job.requirements.egress='provider-only';}});
 await rf.submit();
 const {held,log}=reservations(rf.policy);
 const sbx=hybrid(f,{block:true});
 const workers=f.accounts.map(account=>launch(rf,{backend:sbx.backend,accountKey:account.key}));
 rf.stop=async()=>{sbx.release();await Promise.all(workers.map(w=>w.stop()));};
 await until(()=>sbx.runs.length===2,'both agents running at once');
 assert.deepEqual([...held.values()].sort(),f.accounts.map(a=>a.key).sort(),'one reservation per account');
 assert.deepEqual(sbx.prepares.sort(),f.accounts.map(a=>a.key).sort(),'each prepare names its reservation account');
 const scoped=f.secrets.map(row=>({scope:row.scope,name:row.name,token:row.token}));
 assert.equal(scoped.length,2);
 assert.deepEqual(scoped.map(row=>row.scope).sort(),sbx.runs.map(run=>run.sandbox).sort(),'each value is scoped to a running sandbox');
 assert.notEqual(scoped[0].scope,scoped[1].scope);
 assert.deepEqual(scoped.map(row=>row.token).sort(),[...tokens].sort(),'each sandbox holds its own account value');
 assert.ok(sbx.runs.every(run=>run.env.includes('CLAUDE_CODE_OAUTH_TOKEN=proxy-managed')));
 assert.equal(JSON.stringify(f.calls.map(call=>call.args)).includes(tokens[0])||JSON.stringify(f.calls.map(call=>call.args)).includes(tokens[1]),false,'argv never carries a value');
 sbx.release();
 await until(()=>log.filter(([kind])=>kind==='finish').length===2,'both jobs finished');
 await until(()=>f.secrets.length===0&&f.backend.cleanupStatus().state==='clear','scoped values removed');
});

test('a failed scoped preparation releases its reservation and never runs on the default sign-in',{timeout:60000},async t=>{
 let rf;
 t.after(async()=>{await rf?.stop?.();});
 const f=await accountBackend(t,{tokens:[token()]}),key=f.accounts[0].key;
 f.flags.failSet=true;
 rf=await realLenderFixture(t,{harness:'claude-code-subscription',mutateJob:job=>{job.requirements.egress='provider-only';}});
 const {held,log}=reservations(rf.policy);
 const sbx=hybrid(f);
 const worker=launch(rf,{backend:sbx.backend,accountKey:key});
 rf.stop=()=>worker.stop();
 await until(()=>log.some(([kind])=>kind==='settle'),'the reservation was settled');
 await until(()=>worker.storage.peek()?.pending===null&&worker.storage.peek()?.claimedPending===null,'the journal let go of the attempt');
 assert.deepEqual(log.filter(([kind])=>kind!=='reserve'),[['settle',key,false,'error']],'released unprepared, nothing charged');
 assert.equal(held.size,0);
 assert.ok(sbx.prepares.length>=1&&sbx.prepares.every(account=>account===key),'no preparation without the account: '+JSON.stringify(sbx.prepares));
 assert.deepEqual(sbx.runs,[],'no agent ran');
 assert.equal(f.calls.some(call=>call.args[0]==='exec'),false,'nothing executed in a sandbox');
 const failed=worker.events.find(e=>e.reason==='claude_account_unavailable'||e.code==='claude_account_unavailable'||JSON.stringify(e).includes('claude_account_unavailable'));
 assert.ok(failed,'the plain reason is reported: '+JSON.stringify(worker.events.map(e=>e.status+':'+(e.reason??''))));
});

test('a lent job on an added account starts, reports progress and leaks its token nowhere',{timeout:60000},async t=>{
 let rf;
 t.after(async()=>{await rf?.stop?.();});
 const unique=token();
 const f=await accountBackend(t,{tokens:[unique]}),key=f.accounts[0].key;
 rf=await realLenderFixture(t,{harness:'claude-code-subscription',mutateJob:job=>{job.requirements.egress='provider-only';}});
 const {log}=reservations(rf.policy);
 const sbx=hybrid(f);
 const worker=launch(rf,{backend:sbx.backend,accountKey:key});
 rf.stop=()=>worker.stop();
 await until(()=>log.some(([kind])=>kind==='finish'),'the job finished');
 assert.equal(sbx.runs.length,1,'the agent started');
 assert.ok(worker.events.some(e=>e.status==='transcript'),'the transcript was emitted');
 assert.ok(worker.events.some(e=>e.status==='running'),'the run was reported: '+[...new Set(worker.events.map(e=>e.status))].join(','));
 assert.ok(rf.realRequests.some(r=>r.url.endsWith('/start')),'the coordinator heard the start');
 const job=await rf.owner.getJob(rf.jobDigest);
 const surfaces={events:worker.events,diagnostics:worker.diagnostics,state:worker.lender.getState(),journal:worker.storage.peek(),
  argv:f.calls.map(call=>call.args),cleanup:f.backend.cleanupStatus(),job,requests:rf.realRequests};
 for(const [name,value] of Object.entries(surfaces))assert.equal(JSON.stringify(value).includes(unique),false,name+' carries the token');
 assert.ok(f.calls.some(call=>call.input===unique),'the value went by standard input');
 const files=[];
 async function walk(dir){for(const name of await readdir(dir)){const p=join(dir,name),s=await lstat(p);if(s.isDirectory())await walk(p);else if(s.isFile())files.push(p);}}
 await walk(f.home);
 const holders=[];for(const p of files)if((await readFile(p)).includes(unique))holders.push(p);
 assert.equal(holders.length,1);assert.match(holders[0],/credential-generations\/[0-9a-f-]+\/value$/);
});

test('a reservation made between a failed check and the next refresh is refused',{timeout:60000},async t=>{
 let rf;
 t.after(async()=>{await rf?.stop?.();});
 const f=await accountBackend(t,{tokens:[token()]}),account=f.accounts[0],key=account.key;
 f.registry.setEnabled(account.record.accountId,true);
 const gate=gateFor(f);
 await gate.refresh();assert.equal(gate.reason(key),null);
 // The check fails after the last refresh and before the next one.
 const {recordClaudeAccountCheck,claudeKitDigest}=await import('../lib/claude-accounts.mjs');
 await recordClaudeAccountCheck(f.home,account.record,{version:'test-version',kitDigest:await claudeKitDigest(),status:200,controlStatus:200});
 rf=await realLenderFixture(t,{harness:'claude-code-subscription',mutateJob:job=>{job.requirements.egress='provider-only';}});
 const {held,log}=reservations(rf.policy);
 const sbx=hybrid(f),events=[];
 const {storage:_unused,...policy}=rf.policy;
 // Only the added account may take the job, so it is the only one that could reserve.
 policy.hold=(_job,{accountKey}={})=>accountKey===key?gate.reason(accountKey):'default_busy';
 policy.lendingPolicy={accountSlots:1,machineSlots:2};
 // The saved counters name their calendar day; a store without one is refused as invalid (frozen counter-store safety).
 const today=new Date(rf.clock.now()).toISOString().slice(0,10),storage=memory({day:today,jobs:0,milliseconds:0,pending:null,accounts:{'claude:0':{day:today,jobs:0,milliseconds:0},[key+'#0']:{day:today,jobs:0,milliseconds:0}}});
 const pool=createLendingPool({createLender,storage,policy,adapters:rf.adapters,capacity:2,client:rf.client,backend:sbx.backend,
  clock:{now:rf.clock.now,monotonic:()=>performance.now()},approve:async()=>true,onEvent:e=>events.push(e)});
 const controller=new AbortController(),loop=pool.start(controller.signal);
 rf.stop=async()=>{controller.abort();await loop?.catch(()=>{});};
 await new Promise(resolve=>setTimeout(resolve,2000));
 assert.equal(log.some(([kind])=>kind==='reserve'),false,'nothing reserved: '+JSON.stringify(log));
 assert.deepEqual(sbx.prepares,[]);
 assert.equal(held.size,0);
});
