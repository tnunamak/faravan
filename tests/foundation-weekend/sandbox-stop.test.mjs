import test from 'node:test';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {DockerSbxBackend} from '../../lib/docker-backend.mjs';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, readdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createLaunchBackend} from '../../lib/v1/launch-backend.mjs';

// Synthetic effects through the actual facade. No Docker, agent or provider runs.
const deferred = () => { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve}; };
const attempt = {attemptId:'attempt',jobId:'job',generation:1,leaseProof:{schemaVersion:1,signedEnvelope:'fixture-only'}};
const selection = {providerId:'fixture',accountId:'account',modelId:'model',effortId:null};
const amount = {unit:'window_micro_points',byResource:[{id:'window',instance:'epoch',amount:1}]};
const run = {schemaVersion:1,command:'fixture',args:[],env:{},proxy:{},
  receipt:{schemaVersion:1,accountId:'account',jobId:'job',attemptId:'attempt',policyVersion:'fixture',
    quotedLedgerRevision:1,settingsRevision:1,evaluatedAtMs:100,amount,mode:'observed'},
  enforcement:{amount,wallLimitMs:1000,stopOnBudget:true,metering:'measured',limitations:[]}};
async function fixture(t) {
  const journalDirectory=await mkdtemp(path.join(tmpdir(),'launch-backend-'));
  t.after(()=>rm(journalDirectory,{recursive:true,force:true}));
  const events=[], registryFile=path.join(journalDirectory,'fixture-registry');
  fs.writeFileSync(registryFile,'{}',{mode:0o600});
  const registry={
    set(key,value){const data=JSON.parse(fs.readFileSync(registryFile));data[key]=value;fs.writeFileSync(registryFile,JSON.stringify(data));},
    get(key){return JSON.parse(fs.readFileSync(registryFile))[key];},
    clear(){fs.writeFileSync(registryFile,'{}');},
  };
  let status='running', acknowledge=true, cleanup=true, now=100;
  const handle={sandbox_id:'sandbox',job_id:'job',_cleanupId:'incarnation'};
  const backend={
    async prepare(job,{signal}) { events.push('prepare'); assert.equal(job.job_id,'job'); registry.set('sandbox',handle); return handle; },
    async start(h,options) { events.push('start'); options.onExecutionStarted?.({at:now}); },
    async cancel(h) { events.push('cancel'); assert.deepEqual(h,handle); if(acknowledge)status='exited'; },
    async inspect() { return {job_id:'job',status}; },
    async destroy(h) { events.push('destroy'); if(!cleanup)return {removed:false,scratch_removed:false};
      status='destroyed'; return {job_id:'job',sandbox_id:'sandbox',removed:true,scratch_removed:true,policy_removed:true,storage_removed:true}; },
  };
  const options={backend,journalDirectory,resolveJob:async()=>({job_id:'job',resources:{wall_seconds:1}}),
    bindRun:async({handle:h,run:r})=>{assert.strictEqual(h,handle);assert.deepEqual(r,run);events.push('bind');},
    recoverHandle:async()=>registry.get('sandbox')??{kind:'unknown'},clock:()=>now};
  return {options,backend,handle,registry,events,newFacade:()=>createLaunchBackend(options),
    status:v=>{status=v;},ack:v=>{acknowledge=v;},cleanup:v=>{cleanup=v;},time:v=>{now=v;}};
}
const prep = facade => facade.prepare({attempt,selection,signal:new AbortController().signal});
test('normal lifecycle, replay, changed operation and restart preserve identity and cleanup debt',async t=>{
  const f=await fixture(t); const facade=f.newFacade();
  assert.deepEqual(await prep(facade),{ok:true,value:{sandboxId:'sandbox'}});
  assert.equal(f.events.includes('start'),false);
  const first=await facade.start({sandboxId:'sandbox',run,operationId:'start',signal:new AbortController().signal});
  assert.equal(first.ok,true);
  assert.ok(['started','uncertain'].includes(first.value.kind));
  assert.equal((await facade.start({sandboxId:'sandbox',run,operationId:'start'})).ok,true);
  assert.equal(f.events.filter(x=>x==='start').length,1);
  const changed=structuredClone(run);changed.args=['changed'];
  assert.equal((await facade.start({sandboxId:'sandbox',run:changed,operationId:'start'})).error.code,'operation_conflict');
  // Key revocation belongs to LendingLaunch, not this facade.
  f.events.push('caller-key-revoked');
  const stopped=await facade.stop({sandboxId:'sandbox',reason:'owner'});
  assert.equal(stopped.ceasedAtMs,100);
  assert.ok(f.events.indexOf('caller-key-revoked')<f.events.indexOf('cancel'));
  f.cleanup(false);
  assert.equal((await facade.remove({sandboxId:'sandbox',operationId:'remove'})).ok,false);
  f.cleanup(true);const restarted=f.newFacade();
  assert.equal((await restarted.remove({sandboxId:'sandbox',operationId:'remove'})).ok,true);
  const count=f.events.filter(x=>x==='destroy').length;
  assert.equal((await restarted.remove({sandboxId:'sandbox',operationId:'remove'})).ok,true);
  assert.equal(f.events.filter(x=>x==='destroy').length,count);
  assert.equal((await restarted.start({sandboxId:'sandbox',run,operationId:'new-start'})).ok,false);
});
test('late preparation after abort cancels and removes exactly that resource and never starts',async t=>{
  const f=await fixture(t), entered=deferred(), late=deferred();
  f.backend.prepare=async()=>{entered.resolve();await late.promise;f.registry.set('sandbox',f.handle);return f.handle;};
  const facade=f.newFacade(), controller=new AbortController();
  const pending=facade.prepare({attempt,selection,signal:controller.signal});
  await entered.promise;controller.abort();late.resolve();
  assert.equal((await pending).ok,false);
  assert.deepEqual(f.events,['cancel','destroy']);
  assert.equal((await prep(f.newFacade())).ok,false);
});
test('cancel acknowledgement and unknown recovery never count as cessation',async t=>{
  const f=await fixture(t), facade=f.newFacade();await prep(facade);
  f.ack(false);f.status('unknown');
  assert.deepEqual(await facade.stop({sandboxId:'sandbox',reason:'owner'}),{ceasedAtMs:null});
  f.registry.clear();
  assert.deepEqual(await f.newFacade().stop({sandboxId:'sandbox',reason:'owner'}),{ceasedAtMs:null});
  assert.equal((await f.newFacade().remove({sandboxId:'sandbox',operationId:'remove'})).ok,false);
});
test('lost start stays uncertain, no replay dispatch, and an unrelated usage promise does not block stop',async t=>{
  const f=await fixture(t), late=deferred(), entered=deferred();
  f.backend.start=async()=>{f.events.push('start');entered.resolve();await late.promise;throw new Error('lost response');};
  const facade=f.newFacade();await prep(facade);
  const started=await facade.start({sandboxId:'sandbox',run,operationId:'start'});
  await entered.promise;assert.equal(started.value.kind,'uncertain');
  const usage=new Promise(()=>{});void usage; // deliberately no dependency from facade Stop
  const stop=await facade.stop({sandboxId:'sandbox',reason:'owner'});
  assert.equal(stop.ceasedAtMs,null); // a deferred dispatch could still act later
  late.resolve();await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await f.newFacade().stop({sandboxId:'sandbox',reason:'owner'})).ceasedAtMs,100);
  assert.equal((await f.newFacade().start({sandboxId:'sandbox',run,operationId:'start'})).value.kind,'uncertain');
  assert.equal(f.events.filter(x=>x==='start').length,1);
});
test('foreign recovered incarnation is never cancelled or removed',async t=>{
  const f=await fixture(t);await prep(f.newFacade());
  f.registry.set('sandbox',{...f.handle,_cleanupId:'foreign'});
  assert.equal((await f.newFacade().stop({sandboxId:'sandbox',reason:'owner'})).ceasedAtMs,null);
  assert.equal((await f.newFacade().remove({sandboxId:'sandbox',operationId:'remove'})).ok,false);
  assert.deepEqual(f.events,['prepare']);
});
test('journal failure before dispatch has no backend effects; journal excludes job/run secrets',async t=>{
  const f=await fixture(t);const invalid=path.join(f.options.journalDirectory,'not-a-directory');
  await writeFile(invalid,'fixture');
  const bad=createLaunchBackend({...f.options,journalDirectory:invalid});
  assert.equal((await prep(bad)).ok,false);assert.deepEqual(f.events,[]);
  const facade=f.newFacade();await prep(facade);
  const files=await readdir(f.options.journalDirectory);
  const state=await readFile(path.join(f.options.journalDirectory,files.find(x=>x.endsWith('.json'))),'utf8');
  assert.equal(state.includes('signedEnvelope'),false);
  assert.equal(state.includes('fixture-only'),false);
});

test('output handoff prevents removal from being reported early',async t=>{
  const f=await fixture(t),facade=f.newFacade(),handoff=deferred(),entered=deferred();
  await prep(facade);await facade.stop({sandboxId:'sandbox',reason:'owner'});
  const destroy=f.backend.destroy;
  f.backend.destroy=async h=>{entered.resolve();await handoff.promise;return destroy(h);};
  let finished=false;
  const pending=facade.remove({sandboxId:'sandbox',operationId:'remove'}).then(result=>{finished=true;return result;});
  try {
    await entered.promise;assert.equal(finished,false);
    handoff.resolve();assert.equal((await pending).ok,true);
  } finally {handoff.resolve();await pending;}
});
test('post-create persistence failure reconnects registry identity without a second create',async t=>{
  const f=await fixture(t),create=f.backend.prepare;let creates=0;
  const key=createHash('sha256').update(JSON.stringify(attempt.attemptId)).digest('hex');
  const lock=path.join(f.options.journalDirectory,key+'.lock');
  f.backend.prepare=async(...args)=>{creates++;const h=await create(...args);fs.mkdirSync(lock);return h;};
  assert.equal((await prep(f.newFacade())).ok,false);
  fs.rmdirSync(lock);
  assert.equal((await prep(f.newFacade())).ok,true);
  assert.equal(creates,1);
});
test('real inspect adapter rejects incomplete listing, prefix identity and unrelated incarnation',async()=>{
  const handle={sandbox_id:'wf-one',job_id:'job',_cleanupId:'incarnation'};
  let result={code:0,stdout:JSON.stringify([{name:'wf-one-other',status:'stopped'}]),stderr:''};
  let owner={_cleanupId:'incarnation',create_settled:false};
  const backend={cleanupJournal:{authority:()=>owner},_rowRun:async(h,args)=>{
    assert.deepEqual(args,['ls','--json']);return result;
  }};
  const inspect=()=>DockerSbxBackend.prototype.inspect.call(backend,handle);
  assert.equal((await inspect()).status,'unknown');
  result={code:0,stdout:JSON.stringify([{name:'wf-one',status:'stopped'}]),stderr:'',truncated:true};
  assert.equal((await inspect()).status,'unknown');
  result.truncated=false;assert.equal((await inspect()).status,'exited');
  owner={...owner,_cleanupId:'foreign'};assert.equal((await inspect()).status,'unknown');
});
