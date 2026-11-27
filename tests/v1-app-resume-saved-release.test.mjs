import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {pendingAttempts} from '../lib/v1/durable-cessation.mjs';
const source=await readFile(new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
const begin=source.indexOf('  async function startLendingAttempt(');
const end=source.indexOf('  // The standing rules a mode change',begin);
assert.ok(begin>=0&&end>begin);
const startAttempt=source.slice(begin,end);
function newPoolFixture(counters) {
  let resumes=0;
  const c={hostRateLimited:false,hostPollEpoch:0,updateAdmissionHeld:()=>false,safetyEpoch:4,safetyIntentEpoch:0,closed:false,quitting:false,lenderInit:null,stopCheckCoordinator:null,initHost:()=>({}),consumeLendingOnTrigger:()=>{},mintIntentGeneration:()=>{},now:()=>100,settings:{intent:'on',enabled:false,activeCircle:'circle',limits:{},
      standingRules:[],requesterLimits:[],modes:{}},stopFlights:new Map(),stopReceipt:null,policy:{enabled:false},lender:null,
    lendingTarget:async()=>({id:'circle',name:'circle'}),counterStore:{get:async()=>counters},pendingAttempts,
    checkSignInBeforeClaim:async()=>{},
    hasObservationJournal:()=>false, // these counters carry no observation journal
    hasUnfinishedLending:value=>[value,...Object.values(value?.accounts??{})].some(row=>row&&(row.pending||row.declinePending||row.stoppedPending||row.watchedStops?.length)),
    fail:(code,status=400)=>{throw Object.assign(new Error(code),{code,status});},resumeDurableCandidate:async()=>{resumes++;},
    readHostProfile:async()=>{},lenderAdapters:async()=>[],machineHold:()=> 'sandbox_not_ready',options:{},
    device:{keyId:'owner',client:async()=>({}),rosterCache:()=>({get:async()=>({current:null})})},availableParallelism:()=>1,totalmem:()=>8*1024**3,
    machineCapacity:()=>({}),AbortController,backend:{},accountExecution:null,createLender:()=>{},createLendingPool:({policy})=>{
      c.poolPolicy=policy;return {getState:()=>({status:'starting'}),start:()=>new Promise(()=>{})};
    },lendingHashes:{clear:()=>{}},controller:null,loop:null,lendingRuntime:null,
    heartbeat:{beat:async()=>{}},approval:()=>{},decisions:{record:()=>{}},automaticReceipt:()=>{},markNotApplied:()=>{},
    recordDiagnostic:async()=>{},telemetry:null,transcripts:new Map(),lastLendingShape:'',
    emit:()=>{},publicState:value=>value,nudgeHeartbeat:()=>{},readinessChanged:()=>{},
    pauseTimer:null,clearTimeout:()=>{},save:async()=>{},lendingView:()=>({enabled:c.settings.enabled}),
    quota:()=>{},readQuota:async()=>({}),daemonGate:null,userActive:()=>false,resumeFailed:null};
  const start=runInNewContext(`${startAttempt}\nstartLendingAttempt;`,c);
  return {c,start,resumes:()=>resumes};
}
for(const [name,counters] of [
  ['root release journal',{circle:'circle',declinePending:{stoppedByLender:true,attempt:{attempt_id:'saved-stop',job_digest:'sha256:'+'a'.repeat(64),generation:1},reason:{code:'stopped_by_lender'},idempotencyKey:'saved-release'}}],
  ['account release journal',{circle:'circle',accounts:{worker:{declinePending:{stoppedByLender:true,attempt:{attempt_id:'saved-stop',job_digest:'sha256:'+'a'.repeat(64),generation:1},reason:{code:'stopped_by_lender'},idempotencyKey:'saved-release'}}}}],
])test(`new automatic pool preserves the saved Stop ${name}`,async()=>{
  const f=newPoolFixture(counters);
  await f.start({id:'circle'},{auto:true,expectedEpoch:4});
  assert.equal(f.c.settings.enabled,false,'automatic startup must not reopen admission before journal recovery');
  assert.equal(f.c.poolPolicy.enabled,false);
  assert.equal(f.resumes(),0);
});

import {ClientError} from '../lib/v1/client.mjs';
import {appFixture, api, boundedFetch, waitFor} from './helpers/v1-app-fixture.mjs';

const deleteDigest='sha256:'+'a'.repeat(64);
const deleteKey='saved-copy-delete-original';
// Canonical flat protocol objects: lexicographic keys, not insertion-order ACK bytes.
const deleteAck=()=>({at:'2026-11-16T00:00:00Z',deleted:true,job_digest:deleteDigest});
const deleteJSON=(value,status=200)=>new Response(
  JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]]))),
  {status,headers:{'content-type':status===200?'application/json':'application/problem+json'}});
async function deleteTransportFixture(t,reply,{maxAttempts=2}={}) {
  const f=await appFixture(t),sends=[];
  let applied=false;
  const owner=await f.start('owner',{pollMs:250,
    clientOptions:{retry:{maxAttempts,baseMs:0,capMs:0},sleep:async()=>{}},
    fetch:async(url,options)=>{
      if(options?.method==='POST'&&new URL(url).pathname.endsWith('/delete')) {
        sends.push({key:options.headers['Idempotency-Key'],path:new URL(url).pathname});
        return reply({count:sends.length,options,apply:()=>{applied=true;}});
      }
      return boundedFetch(url,options);
    }});
  await f.provisionFromHome('owner');
  const circle=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Delete classification'}});
  return {client:await owner.app.device.client(circle.id),sends,applied:()=>applied};
}
function assertDeleteSends(f,count) {
  assert.equal(f.sends.length,count,'preserve existing retry policy');
  assert.deepEqual(f.sends.map(send=>send.key),Array(count).fill(deleteKey));
  assert.ok(f.sends.every(send=>send.path.endsWith('/jobs/'+deleteDigest.slice(7)+'/delete')));
}
for(const [name,code,reply] of [
  ['applied malformed JSON','invalid_json',({apply})=>{apply();return new Response('{broken',{headers:{'content-type':'application/json'}});}],
  ['truncated success','size_mismatch',({apply})=>{apply();return new Response('{}',{headers:{'content-type':'application/json','content-length':'50'}});}],
  ['wrong job ACK','invalid_response',({apply})=>{apply();return deleteJSON({...deleteAck(),job_digest:'sha256:'+'b'.repeat(64)});}],
  ['false ACK','invalid_response',({apply})=>{apply();return deleteJSON({...deleteAck(),deleted:false});}],
  ['missing ACK field','invalid_response',({apply})=>{apply();return deleteJSON({at:deleteAck().at,job_digest:deleteDigest});}],
  ['aborted success body','network_error',({apply})=>{apply();return new Response(new ReadableStream({start(controller){controller.error(new DOMException('Lost body','AbortError'));}}),{headers:{'content-type':'application/json'}});}],
])test('delete keeps original uncertainty for '+name,async t=>{
  const f=await deleteTransportFixture(t,reply);
  await assert.rejects(f.client.deleteJob(deleteDigest,{idempotencyKey:deleteKey}),error=>{
    assert.equal(error.outcome,'unknown');assert.equal(error.operationKey,deleteKey);
    // Parser spelling is not the oracle for deliberately malformed JSON.
    if(name!=='applied malformed JSON')assert.equal(error.code,code);
    assert.notEqual(error.code,'noncanonical_json','valid ACK variants must reach ACK validation');
    return true;
  });
  assert.equal(f.applied(),true);
  assertDeleteSends(f,name==='aborted success body'?2:1);
});

test('delete dropped dispatched responses remain unknown with the original key',async t=>{
  const f=await deleteTransportFixture(t,({apply})=>{apply();throw new Error('synthetic dropped reply');});
  await assert.rejects(f.client.deleteJob(deleteDigest,{idempotencyKey:deleteKey}),error=>{
    assert.equal(error.outcome,'unknown');assert.equal(error.operationKey,deleteKey);return true;
  });
  assert.equal(f.applied(),true);assertDeleteSends(f,2);
});

test('delete genuine explicit refusal without prior uncertainty remains not applied',async t=>{
  const f=await deleteTransportFixture(t,()=>deleteJSON({code:'forbidden',outcome:'not_applied'},403));
  await assert.rejects(f.client.deleteJob(deleteDigest,{idempotencyKey:deleteKey}),error=>{
    assert.equal(error.code,'forbidden');assert.equal(error.outcome,'not_applied');assert.equal(error.operationKey,deleteKey);return true;
  });
  assert.equal(f.applied(),false);assertDeleteSends(f,1);
});

test('delete transport then refusal cannot erase the earlier unresolved application',async t=>{
  const f=await deleteTransportFixture(t,({count,apply})=>{
    if(count===1){apply();throw new Error('synthetic dropped reply');}
    return deleteJSON({code:'forbidden',outcome:'not_applied'},403);
  });
  await assert.rejects(f.client.deleteJob(deleteDigest,{idempotencyKey:deleteKey}),error=>{
    assert.equal(error.code,'forbidden');assert.equal(error.outcome,'unknown');assert.equal(error.operationKey,deleteKey);return true;
  });
  assert.equal(f.applied(),true);assertDeleteSends(f,2);
});

test('delete exact job-bound true canonical ACK remains success',async t=>{
  const f=await deleteTransportFixture(t,({apply})=>{apply();return deleteJSON(deleteAck());});
  assert.deepEqual(await f.client.deleteJob(deleteDigest,{idempotencyKey:deleteKey}),deleteAck());
  assert.equal(f.applied(),true);assertDeleteSends(f,1);
});

test('delete invalid digest is a pre-dispatch refusal',async t=>{
  const f=await deleteTransportFixture(t,()=>assert.fail('must not dispatch'));
  await assert.rejects(f.client.deleteJob('invalid',{idempotencyKey:deleteKey}),error=>{
    assert.equal(error.code,'invalid_request');assert.equal(error.outcome,'not_applied');return true;
  });
  assertDeleteSends(f,0);assert.equal(f.applied(),false);
});


test('terminal delete 503 retains Retry-After and original operation key with one attempt',async t=>{
  const problem={code:'service_unavailable',outcome:'not_applied'};
  const f=await deleteTransportFixture(t,()=>{
    const response=deleteJSON(problem,503);response.headers.set('retry-after','60');return response;
  },{maxAttempts:1});
  await assert.rejects(f.client.deleteJob(deleteDigest,{idempotencyKey:deleteKey}),error=>{
    assert.ok(error instanceof ClientError);
    assert.equal(error.code,'service_unavailable');assert.equal(error.status,503);
    assert.equal(error.retryable,true);assert.deepEqual(error.problem,problem);
    assert.equal(error.outcome,'unknown');assert.equal(error.operationKey,deleteKey);
    assert.equal(error.retryAfterSeconds,60);
    return true;
  });
  assertDeleteSends(f,1);assert.equal(f.applied(),false);
});

test('delete uncertainty preserves diagnostics from a frozen ClientError',async t=>{
  const underlying=new Error('synthetic underlying transport cause');
  const problem={code:'service_unavailable',outcome:'not_applied'};
  const original=new ClientError('service_unavailable',{status:503,retryable:true,problem,cause:underlying});
  original.retryAfterSeconds=60;original.responseReceived=true;
  Object.freeze(original);
  const f=await deleteTransportFixture(t,()=>{throw original;},{maxAttempts:1});
  await assert.rejects(f.client.deleteJob(deleteDigest,{idempotencyKey:deleteKey}),error=>{
    assert.notEqual(error,original);
    assert.equal(error.code,'service_unavailable');assert.equal(error.status,503);
    assert.equal(error.retryable,true);assert.equal(error.problem,problem);
    assert.equal(error.cause,original);assert.equal(error.cause.cause,underlying);
    assert.equal(error.retryAfterSeconds,60);assert.equal(error.responseReceived,true);
    assert.equal(error.outcome,'unknown');assert.equal(error.operationKey,deleteKey);
    return true;
  });
  assertDeleteSends(f,1);
});

test('concurrent deletes retain their own keys when the transport reuses one error',async t=>{
  const original=new ClientError('service_unavailable',{status:503,retryable:true});
  const f=await deleteTransportFixture(t,()=>{throw original;},{maxAttempts:1});
  const keys=[deleteKey,'saved-copy-delete-other'];
  const results=await Promise.allSettled(keys.map(idempotencyKey=>f.client.deleteJob(deleteDigest,{idempotencyKey})));
  assert.deepEqual(results.map(({status,reason})=>[status,reason?.code,reason?.outcome,reason?.operationKey]),
    keys.map(key=>['rejected','service_unavailable','unknown',key]));
  assert.notEqual(results[0].reason,results[1].reason);
  assert.ok(results.every(({reason})=>reason.cause===original));
  assert.equal(original.operationKey,undefined);
  assert.equal(original.outcome,'not_applied');
  assert.deepEqual(f.sends.map(send=>send.key).sort(),keys.sort());
});

test('delete prior dispatch ambiguity retains refusal diagnostics without erasing uncertainty',async t=>{
  const f=await deleteTransportFixture(t,({count,apply})=>{
    if(count===1){apply();throw new Error('synthetic dropped reply');}
    const response=deleteJSON({code:'forbidden',outcome:'not_applied'},403);
    response.headers.set('retry-after','60');return response;
  });
  await assert.rejects(f.client.deleteJob(deleteDigest,{idempotencyKey:deleteKey}),error=>{
    assert.equal(error.code,'forbidden');assert.equal(error.status,403);
    assert.equal(error.retryable,false);assert.equal(error.problem.outcome,'not_applied');
    assert.equal(error.outcome,'unknown');assert.equal(error.operationKey,deleteKey);
    assert.equal(error.retryAfterSeconds,60);return true;
  });
  assertDeleteSends(f,2);assert.equal(f.applied(),true);
});

test('delete response parse failure retains its received-response diagnostic',async t=>{
  const f=await deleteTransportFixture(t,()=>new Response('{}',{
    headers:{'content-type':'application/json','content-length':'50'},
  }),{maxAttempts:1});
  await assert.rejects(f.client.deleteJob(deleteDigest,{idempotencyKey:deleteKey}),error=>{
    assert.equal(error.code,'size_mismatch');assert.equal(error.responseReceived,true);
    assert.equal(error.outcome,'unknown');assert.equal(error.operationKey,deleteKey);return true;
  });
  assertDeleteSends(f,1);
});

test('delete pre-dispatch cancellation stays the original cancellation and sends nothing',async t=>{
  const controller=new AbortController(),reason=new DOMException('Synthetic cancellation','AbortError');
  const f=await deleteTransportFixture(t,()=>assert.fail('cancelled delete must not dispatch'));
  controller.abort(reason);
  await assert.rejects(f.client.deleteJob(deleteDigest,{idempotencyKey:deleteKey,signal:controller.signal}),
    error=>{assert.equal(error,reason);return true;});
  assertDeleteSends(f,0);assert.equal(f.applied(),false);
});

test('delete cancellation after dispatch retains unknown outcome rather than a safe refusal',async t=>{
  const controller=new AbortController(),reason=new DOMException('Synthetic cancellation','AbortError');
  const f=await deleteTransportFixture(t,({apply})=>{apply();controller.abort(reason);throw reason;},{maxAttempts:1});
  await assert.rejects(f.client.deleteJob(deleteDigest,{idempotencyKey:deleteKey,signal:controller.signal}),error=>{
    assert.equal(error.outcome,'unknown');assert.equal(error.operationKey,deleteKey);
    assert.equal(error.cause,reason);return true;
  });
  assertDeleteSends(f,1);assert.equal(f.applied(),true);
});


import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {durableWrite, syncDirectory} from '../lib/durable-write.mjs';
import {createSavedReads, jobReadKey} from '../lib/v1/saved-reads.mjs';

function appliedCopyFixture() {
  const directory=fs.mkdtempSync(join(tmpdir(),'saved-applied-')),metadata=join(directory,'authority.json');
  let fault=null,failRemoval=false,writes=0,removals=0;
  const options={directory,
    remove:(...args)=>{removals++;if(failRemoval)throw Error('owned removal fault');return fs.rmSync(...args);},
    persist:(file,text)=>{
      if(file!==metadata)return durableWrite(file,text);
      writes++;
      const io={openSync:(...args)=>fs.openSync(...args),closeSync:fd=>fs.closeSync(fd),
        writeAllSync:(fd,data)=>{if(fault==='write')throw Error('owned write fault');fs.writeFileSync(fd,data);},
        fsyncSync:fd=>fs.fsyncSync(fd),
        renameSync:(...args)=>{if(fault==='rename')throw Error('owned rename fault');fs.renameSync(...args);},
        unlinkSync:file=>fs.unlinkSync(file),
        fsyncDirectory:dir=>{if(fault==='after')throw Error('owned post-rename fault');syncDirectory(dir);}};
      durableWrite(file,text,{io});
    }};
  return {metadata,directory,open:()=>createSavedReads(options),
    bytes:()=>fs.readFileSync(metadata,'utf8'),writes:()=>writes,removals:()=>removals,
    fault:value=>{fault=value;},failRemoval:()=>{failRemoval=true;},
    dispose:()=>fs.rmSync(directory,{recursive:true,force:true})};
}
const appliedCases=[
  [{kind:'job',digest:deleteDigest,circle:'a'},'validated_delete_ack'],
  [{kind:'circle',circle:'a'},'durable_local_leave'],
];
function seedAppliedCopies(cache) {
  const key=jobReadKey('a',deleteDigest),other=jobReadKey('b','unrelated');
  cache.remember(key,{result:'old'},cache.ticket(key));
  cache.remember(other,{result:'unrelated'},cache.ticket(other));
  return {key,other};
}
for(const [scope,effect] of appliedCases)for(const applied of [false,true])
test('restart recovery requires explicit applied evidence, not pending '+scope.kind+' '+applied,()=>{
  const f=appliedCopyFixture();
  try {
    let cache=f.open();const {key,other}=seedAppliedCopies(cache);
    const id=cache.beginInvalidation(scope);
    if(applied)cache.markInvalidationApplied(id,scope,effect);
    cache=f.open();
    assert.equal(cache.recall(key),null);
    assert.equal(cache.recall(other).value.result,'unrelated');
    assert.deepEqual(cache.recoverAppliedInvalidations(),applied?[id]:[]);
    assert.equal(cache.recall(key),null);
    assert.equal(cache.pendingInvalidations().length,applied?0:1);
    cache=f.open();
    assert.deepEqual(cache.recoverAppliedInvalidations(),[]);
    assert.equal(cache.recall(key),null);
    assert.equal(cache.recall(other).value.result,'unrelated');
    if(!applied) {
      assert.deepEqual(cache.pendingInvalidations(),[{id,scope}],'legacy pending remains unresolved');
      cache.cancelInvalidation(id);
      assert.equal(cache.recall(key).value.result,'old','explicit known-not-applied cancellation still works');
    }else if(scope.kind==='circle') {
      cache.remember(key,{result:'fresh rejoin'},cache.ticket(key));
      assert.equal(f.open().recall(key).value.result,'fresh rejoin');
    }else {
      cache.remember(key,{result:'late'},cache.ticket(key));
      assert.equal(f.open().recall(key),null);
    }
  }finally{f.dispose();}
});

for(const [scope,effect] of appliedCases)test('applied evidence binds token, exact scope and effect; cannot cancel '+scope.kind,()=>{
  const f=appliedCopyFixture();
  try {
    let cache=f.open();seedAppliedCopies(cache);
    const id=cache.beginInvalidation(scope),before=f.bytes();
    const wrongScope={...scope,circle:'wrong'};
    for(const args of [[randomUUID(),scope,effect],[id,wrongScope,effect],[id,scope,'unknown'],
      [id,scope,effect==='validated_delete_ack'?'durable_local_leave':'validated_delete_ack']]) {
      assert.throws(()=>cache.markInvalidationApplied(...args),{code:'invalid_saved_read_invalidation'});
      assert.throws(()=>cache.retireAppliedInvalidation(...args),{code:'invalid_saved_read_invalidation'});
      assert.equal(f.bytes(),before);
    }
    assert.throws(()=>cache.retireAppliedInvalidation(id,scope,effect),{code:'invalid_saved_read_invalidation'});
    cache.markInvalidationApplied(id,scope,effect);
    const marked=f.bytes(),writes=f.writes();
    cache.markInvalidationApplied(id,{...scope},effect);
    assert.equal(f.bytes(),marked);assert.equal(f.writes(),writes,'repeat mark has no new write');
    cache=f.open();
    assert.throws(()=>cache.cancelInvalidation(id),{code:'invalid_saved_read_invalidation'});
    assert.throws(()=>cache.retireAppliedInvalidation(id,wrongScope,effect),{code:'invalid_saved_read_invalidation'});
    assert.equal(f.bytes(),marked);
    cache.retireAppliedInvalidation(id,scope,effect);
    assert.deepEqual(f.open().pendingInvalidations(),[]);
  }finally{f.dispose();}
});

for(const stage of ['mark','retire'])for(const fault of ['write','rename','after'])
test('applied '+stage+' '+fault+' failure latches until explicit reload and restart follows disk',()=>{
  const f=appliedCopyFixture();
  try {
    const [scope,effect]=appliedCases[0],cache=f.open(),{key,other}=seedAppliedCopies(cache);
    const id=cache.beginInvalidation(scope);
    if(stage==='retire')cache.markInvalidationApplied(id,scope,effect);
    const before=f.bytes();f.fault(fault);
    assert.throws(()=>stage==='mark'?cache.markInvalidationApplied(id,scope,effect):
      cache.retireAppliedInvalidation(id,scope,effect),{code:'saved_reads_unavailable'});
    const disk=f.bytes(),writes=f.writes();
    assert.equal(disk===before,fault!=='after','exercise actual pre/post-rename disk outcomes');
    assert.equal(cache.recall(key),null);assert.equal(cache.recall(other),null,'whole failed instance latches');
    assert.throws(()=>cache.recoverAppliedInvalidations(),{code:'saved_reads_unavailable'});
    assert.throws(()=>cache.markInvalidationApplied(id,scope,effect),{code:'saved_reads_unavailable'});
    assert.equal(f.writes(),writes);assert.equal(f.bytes(),disk,'latched calls do not overwrite');
    f.fault(null);
    assert.equal(cache.reloadInvalidations(),true);
    const restarted=f.open(),pending=restarted.pendingInvalidations();
    assert.equal(restarted.recall(key),null);
    assert.equal(restarted.recall(other).value.result,'unrelated');
    if(stage==='mark'&&fault!=='after') {
      assert.deepEqual(pending,[{id,scope}]);
      assert.deepEqual(restarted.recoverAppliedInvalidations(),[]);
    }else {
      assert.deepEqual(restarted.recoverAppliedInvalidations(),stage==='retire'&&fault==='after'?[]:[id]);
      assert.deepEqual(f.open().pendingInvalidations(),[]);
      assert.equal(f.open().recall(key),null);
    }
  }finally{f.dispose();}
});

for(const [scope,effect] of appliedCases)test('applied retirement survives physical removal failure '+scope.kind,()=>{
  const f=appliedCopyFixture();
  try {
    let cache=f.open();const {key,other}=seedAppliedCopies(cache),id=cache.beginInvalidation(scope);
    cache.markInvalidationApplied(id,scope,effect);
    f.failRemoval();cache=f.open();
    assert.deepEqual(cache.recoverAppliedInvalidations(),[id]);
    assert.ok(f.removals()>0,'attempted removal of real saved payload');
    const payloadFiles=fs.readdirSync(f.directory,{recursive:true}).filter(file=>file.endsWith('.json')&&file!=='authority.json');
    assert.ok(payloadFiles.length>=2,'failed removal leaves real bytes');
    cache=f.open();assert.equal(cache.recall(key),null);
    assert.equal(cache.recall(other).value.result,'unrelated');
    assert.deepEqual(cache.recoverAppliedInvalidations(),[]);
  }finally{f.dispose();}
});

for(const corrupt of ['phase','effect','missing-effect','pending-effect','extra','duplicate'])
test('invalid applied metadata remains byte-for-byte fail closed '+corrupt,()=>{
  const f=appliedCopyFixture();
  try {
    const cache=f.open(),{key}=seedAppliedCopies(cache),[scope,effect]=appliedCases[0];
    const id=cache.beginInvalidation(scope);cache.markInvalidationApplied(id,scope,effect);
    const value=JSON.parse(f.bytes()),row=value.pending[0];
    if(corrupt==='phase')row.phase='unknown';
    if(corrupt==='effect')row.effect='durable_local_leave';
    if(corrupt==='missing-effect')delete row.effect;
    if(corrupt==='pending-effect')delete row.phase;
    if(corrupt==='extra')row.foreign=true;
    if(corrupt==='duplicate')value.pending.push({...row});
    const bytes=JSON.stringify(value);fs.writeFileSync(f.metadata,bytes);
    const reopened=f.open();assert.equal(reopened.recall(key),null);
    assert.throws(()=>reopened.recoverAppliedInvalidations(),{code:'saved_reads_unavailable'});
    assert.equal(reopened.reloadInvalidations(),false);assert.equal(f.bytes(),bytes);
  }finally{f.dispose();}
});

test('observed applied phase cannot roll back at a newer revision',()=>{
  const f=appliedCopyFixture();
  try {
    const cache=f.open(),[scope,effect]=appliedCases[0],{key}=seedAppliedCopies(cache);
    const id=cache.beginInvalidation(scope);cache.markInvalidationApplied(id,scope,effect);
    const value=JSON.parse(f.bytes());delete value.pending[0].phase;delete value.pending[0].effect;value.revision++;
    const bytes=JSON.stringify(value);fs.writeFileSync(f.metadata,bytes);
    assert.equal(cache.recall(key),null);
    assert.equal(cache.reloadInvalidations(),false);
    assert.throws(()=>cache.cancelInvalidation(id),{code:'saved_reads_unavailable'});
    assert.equal(f.bytes(),bytes);
  }finally{f.dispose();}
});

test('explicit legacy begin and commit remain supported without recovery evidence',()=>{
  const f=appliedCopyFixture();
  try {
    const cache=f.open(),{key}=seedAppliedCopies(cache);
    cache.commitInvalidation(cache.beginInvalidation(appliedCases[0][0]));
    assert.equal(f.open().recall(key),null);
    assert.deepEqual(f.open().pendingInvalidations(),[]);
  }finally{f.dispose();}
});


test('recovery retires only the applied token while an unrelated pending token stays fenced',()=>{
  const f=appliedCopyFixture();
  try {
    let cache=f.open();const {key,other}=seedAppliedCopies(cache),[scope,effect]=appliedCases[0];
    const done=cache.beginInvalidation(scope),unknownScope={kind:'circle',circle:'b'};
    const unknown=cache.beginInvalidation(unknownScope);
    cache.markInvalidationApplied(done,scope,effect);cache=f.open();
    const before=f.bytes();
    assert.throws(()=>cache.markInvalidationApplied(done,{kind:'job',digest:deleteDigest},effect),
      {code:'invalid_saved_read_invalidation'},'optional circle is part of the exact scope');
    assert.throws(()=>cache.retireAppliedInvalidation(done,{...scope,digest:'other'},effect),
      {code:'invalid_saved_read_invalidation'});
    assert.equal(f.bytes(),before);
    assert.deepEqual(cache.recoverAppliedInvalidations(),[done]);
    cache=f.open();
    assert.deepEqual(cache.pendingInvalidations(),[{id:unknown,scope:unknownScope}]);
    assert.equal(cache.recall(key),null);assert.equal(cache.recall(other),null);
    cache.cancelInvalidation(unknown);
    assert.equal(cache.recall(other).value.result,'unrelated');
    assert.equal(cache.recall(key),null);
  }finally{f.dispose();}
});

test('observed applied token cannot disappear without a committed local retirement',()=>{
  const f=appliedCopyFixture();
  try {
    const cache=f.open(),[scope,effect]=appliedCases[0],{key}=seedAppliedCopies(cache);
    const id=cache.beginInvalidation(scope);cache.markInvalidationApplied(id,scope,effect);
    const value=JSON.parse(f.bytes());value.pending=[];value.revision++;
    const bytes=JSON.stringify(value);fs.writeFileSync(f.metadata,bytes);
    assert.equal(cache.recall(key),null);assert.equal(cache.reloadInvalidations(),false);
    assert.equal(f.bytes(),bytes);
  }finally{f.dispose();}
});

test('a null saved-read ticket blocks that job; an unrelated current ticket stays readable', () => {
 const start=source.indexOf('  const deletedReadBlocked=');
 const end=source.indexOf('\n  // Delete and leave',start);
 assert.ok(start>=0&&end>start);
 const probes=[],checks=[];
 const key=(circle,digest)=>JSON.stringify([circle,digest]);
 const retired=key('invented-circle','invented-retired');
 const savedReads={
  pendingInvalidations(){checks.push('checked');return [];},
  ticket(value){probes.push(value);return value===retired?null:{revision:1};},
 };
 const blocked=runInNewContext(source.slice(start,end)+'\ndeletedReadBlocked',
  {savedReads,jobReadKey:key,deletedReadFences:new Set(['invented-local-fence'])});
 assert.equal(blocked('invented-local-fence','invented-circle'),true);
 assert.deepEqual(probes,[],'local fence denies before saved-read lookup');
 assert.equal(blocked('invented-retired','invented-circle'),true);
 assert.equal(blocked('invented-other','invented-circle'),false);
 assert.deepEqual(probes,[retired,key('invented-circle','invented-other')]);
 assert.deepEqual(checks,['checked','checked']);
});

test('an unavailable saved-read store does not masquerade as a null ticket', () => {
 const start=source.indexOf('  const deletedReadBlocked=');
 const end=source.indexOf('\n  // Delete and leave',start);
 assert.ok(start>=0&&end>start);
 const probes=[];
 const savedReads={
  pendingInvalidations(){probes.push('pending');throw new Error('invented store unavailable');},
  ticket(){probes.push('unexpected ticket');return null;},
 };
 const blocked=runInNewContext(source.slice(start,end)+'\ndeletedReadBlocked',
  {savedReads,jobReadKey:()=> 'invented-key',deletedReadFences:new Set(['invented-local-fence'])});
 assert.equal(blocked('invented-local-fence','invented-circle'),true);
 assert.deepEqual(probes,[],'an in-memory fence still blocks without asking the unavailable store');
 assert.equal(blocked('invented-other','invented-circle'),false);
 assert.deepEqual(probes,['pending'],'a thrown store inspection must not be interpreted as a null ticket');
});
async function appDeleteFenceFixture(t) {
 const f=await appFixture(t);let fault=null,offline=false,posts=0,removals=0,held=null,releaseRead=null,metadata;
 const appOptions={pollMs:250,clientOptions:{retry:{maxAttempts:1,baseMs:0,capMs:0}},
  savedReadStorage:{
   persist:(file,text)=>{
    if(file.endsWith('/authority.json')){
     metadata=file;const value=JSON.parse(text);
     const stage=value.jobs.some(row=>row.deleted)?'commit':value.pending.some(row=>row.phase==='applied')?'mark':value.pending.length?'begin':'idle';
     if(fault===stage)throw Object.assign(Error('owned '+stage+' fault'),{code:'EIO'});
    }
    durableWrite(file,text);
   },
   remove:(...args)=>{removals++;if(fault==='rm')throw Object.assign(Error('owned rm fault'),{code:'EACCES'});return fs.rmSync(...args);},
  },
  fetch:async(url,options)=>{
   const path=new URL(url).pathname;
   if(options?.method==='POST'&&path.endsWith('/delete')){
    posts++;
    const value=JSON.parse(fs.readFileSync(metadata,'utf8'));
    assert.ok(value.pending.some(row=>row.scope.digest===deleteDigest&&!row.phase),'durable begin precedes remote request');
    if(fault==='refusal')return deleteJSON({code:'forbidden',outcome:'not_applied'},403);
    if(fault==='unknown')throw Error('owned dispatched connection loss');
    return deleteJSON(deleteAck());
   }
   if(path.endsWith('/retention')){
    const digest='sha256:'+path.split('/').at(-2);
    if(offline&&digest===deleteDigest)return deleteJSON({code:'unavailable'},503);
    const info={job_digest:digest,state:'result-accepted',ended_at:null,retained_until:null,deletable:true};
    if(held&&digest===deleteDigest){held();held=null;await new Promise(resolve=>{releaseRead=resolve;});}
    return deleteJSON(info);
   }
   return boundedFetch(url,options);
  }};
 let owner=await f.start('owner',appOptions);
 await f.provisionFromHome('owner');
 const circle=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'App delete fence'}});
 const path='/api/jobs/'+deleteDigest+'/retention?circle='+circle.id;
 await api(owner.app,path);
 const other='/api/jobs/sha256:'+'b'.repeat(64)+'/retention?circle='+circle.id;
 const post=()=>api(owner.app,'/api/jobs/'+deleteDigest+'/delete',{method:'POST',body:{circle:circle.id},raw:true,status:null});
 return {f,owner,circle,path,other,post,posts:()=>posts,removals:()=>removals,
  fault:value=>{fault=value;},offline:()=>{offline=true;},
  pending:()=>JSON.parse(fs.readFileSync(metadata,'utf8')).pending,
  restart:async()=>{await owner.app.close();fault=null;owner=await f.start('owner',appOptions);return owner.app;},
  hold:()=>new Promise(resolve=>{held=resolve;}),release:()=>releaseRead?.()};
}
test('actual app delete refuses before effects when durable begin fails',async t=>{
 const f=await appDeleteFenceFixture(t);f.fault('begin');
 const response=await f.post();assert.ok(response.status>=400);await response.text();
 assert.equal(f.posts(),0);
 assert.equal((await api(f.owner.app,f.other)).job_digest,'sha256:'+'b'.repeat(64));
});
for(const stage of ['mark','commit','rm','emission'])test('actual app keeps exact delete ACK successful despite local '+stage+' failure',async t=>{
 const f=await appDeleteFenceFixture(t);f.fault(stage);
 if(stage==='emission'){
  const observe=f.owner.app.telemetry.observe.bind(f.owner.app.telemetry);
  t.mock.method(f.owner.app.telemetry,'observe',(kind,data)=>{
   if(kind==='event:job'&&data?.deleted)throw Error('owned emission fault');
   return observe(kind,data);
  });
 }
 const response=await f.post(),value=await response.json();
 assert.equal(response.status,200);assert.equal(value.deleted,true);assert.equal(value.job_digest,deleteDigest);
 assert.equal(value.localRetirement.state,'unconfirmed');assert.notEqual(value.outcome,'not_applied');
 assert.equal(f.posts(),1);
 f.offline();
 const read=await api(f.owner.app,f.path,{raw:true,status:null});assert.ok(read.status>=400);
 assert.equal((await read.json()).savedAt,undefined);
 const repeated=await f.post();assert.ok(repeated.status>=400);await repeated.text();assert.equal(f.posts(),1);
 assert.equal((await api(f.owner.app,f.other)).job_digest,'sha256:'+'b'.repeat(64));
 if(stage==='rm')assert.ok(f.removals()>0);
});
for(const outcome of ['refusal','unknown'])test('actual app cancels only proven not-applied '+outcome,async t=>{
 const f=await appDeleteFenceFixture(t);f.fault(outcome);
 const response=await f.post();assert.ok(response.status>=400);await response.text();
 assert.equal(f.posts(),1);assert.equal(f.pending().length,outcome==='refusal'?0:1);
 f.offline();
 const read=await api(f.owner.app,f.path,{raw:true,status:null}),value=await read.json();
 if(outcome==='refusal'){assert.equal(read.status,200);assert.equal(typeof value.savedAt,'string');}
 else {assert.ok(read.status>=400);assert.equal(value.savedAt,undefined);}
});
test('actual app rejects a held late read after acknowledged deletion',async t=>{
 const f=await appDeleteFenceFixture(t),entered=f.hold();
 const read=api(f.owner.app,f.path,{raw:true,status:null});
 try{
  await entered;const response=await f.post();assert.equal(response.status,200);assert.equal((await response.json()).deleted,true);
 }finally{f.release();}
 const late=await read;assert.ok(late.status>=400);assert.equal((await late.json()).savedAt,undefined);
 assert.equal(f.posts(),1);
});

for(const stage of ['mark','commit'])test('actual app restart retires only durably applied delete phase '+stage,async t=>{
 const f=await appDeleteFenceFixture(t);f.fault(stage);
 const deleted=await f.post();assert.equal(deleted.status,200);assert.equal((await deleted.json()).deleted,true);
 assert.equal(f.pending().length,1);
 assert.equal(f.pending()[0].phase,stage==='commit'?'applied':undefined);
 const restarted=await f.restart();
 assert.equal(f.pending().length,stage==='commit'?0:1);
 f.offline();const read=await api(restarted,f.path,{raw:true,status:null});
 assert.ok(read.status>=400);assert.equal((await read.json()).savedAt,undefined);assert.equal(f.posts(),1);
 assert.equal((await api(restarted,f.other)).job_digest,'sha256:'+'b'.repeat(64));
});

for(const uncertain of [false,true])test((uncertain?'retried uncertain local Delete':'acknowledged local Delete')+
  ' retires only the target signed job watch',{timeout:120000},async t=>{
  const f=await appFixture(t), watches=[], deletes=[], jobReads=[], detailAttempts=[], deleteKeys=[];
  let deleted, releaseAck, firstAck;
  const match=(pathname,tail)=>new RegExp('^/v1/circles/([^/]+)/jobs/([0-9a-f]{64})/'+tail+'$').exec(pathname);
  const owner=await f.start('owner',{pollMs:250,
    ...(uncertain?{clientOptions:{retry:{maxAttempts:2,baseMs:0,capMs:0},sleep:async()=>{}}}:{}),
    fetch:async(url,options={})=>{
    const target=new URL(url);
    assert.equal(target.origin,f.origin);
    const watch=options.method==='GET'&&match(target.pathname,'watch');
    if(watch){
      const after=target.searchParams.get('after');
      const row={circle:decodeURIComponent(watch[1]),digest:'sha256:'+watch[2],after,aborted:false,reply:null};
      assert.equal(target.searchParams.get('wait'),'30');
      assert.match(after??'',/^sha256:[0-9a-f]{64}$/);
      assert.ok(options.headers['Faravan-Proof']??options.headers['faravan-proof'],'watch carries a proof header');
      return new Promise((resolve,reject)=>{
        const abort=()=>{row.aborted=true;
          if(!uncertain||row.digest!==deleted)reject(options.signal.reason);
        };
        row.reply=revision=>{
          options.signal.removeEventListener('abort',abort);
          resolve(deleteJSON({revision}));
        };
        watches.push(row);
        if(options.signal.aborted)abort();
        else options.signal.addEventListener('abort',abort,{once:true});
      });
    }
    const deletion=options.method==='POST'&&match(target.pathname,'delete');
    if(deletion){
      const digest='sha256:'+deletion[2];
      deletes.push({circle:decodeURIComponent(deletion[1]),digest});
      const key=options.headers['Idempotency-Key'];
      assert.ok(key,'Delete is bound to an operation key');
      deleteKeys.push(key);
      if(deletes.length===1){
        assert.equal(f.jobs.delete(digest),true,'fixture-owned coordinator job exists for ACK');
        firstAck={...deleteAck(),job_digest:digest};
        if(uncertain)throw new Error('synthetic lost dispatched Delete response');
      } else {
        assert.equal(uncertain,true);
        assert.equal(deletes.length,2,'one client replay');
        assert.equal(key,deleteKeys[0],'replay uses the exact same operation key');
        assert.equal(firstAck.job_digest,digest,'replay is bound to the original target');
        await new Promise(resolve=>{releaseAck=resolve;});
      }
      return deleteJSON(firstAck);
    }
    const detail=options.method==='GET'&&/^\/v1\/circles\/([^/]+)\/jobs\/([0-9a-f]{64})$/.exec(target.pathname);
    if(detail){
      detailAttempts.push('sha256:'+detail[2]);
      const response=await boundedFetch(url,options);
      if(response.ok)jobReads.push('sha256:'+detail[2]);
      return response;
    }
    return boundedFetch(url,options);
  }});
  await f.provisionFromHome('owner');
  const circle=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Delete watch isolation'}});
  async function submit(prompt){
    const result=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,prompt,
      git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),harness:'codex'}});
    return result.jobDigest;
  }
  deleted=await submit('Synthetic target that will be forgotten');
  const unrelated=await submit('Synthetic unrelated job that stays tracked');
  assert.notEqual(deleted,unrelated);
  const rows=digest=>watches.filter(row=>row.digest===digest);
  const [first,other]=await waitFor(()=>rows(deleted)[0]&&rows(unrelated)[0]&&[rows(deleted)[0],rows(unrelated)[0]],'both signed watches parked',20000);
  assert.equal(first.circle,circle.id);
  assert.equal(other.circle,circle.id);
  assert.equal(first.aborted,false);assert.equal(other.aborted,false);
  const different=after=>'sha256:'+(after==='sha256:'+'0'.repeat(64)?'1':'0').repeat(64);
  const cycle=async (watch,index)=>{
    const next=different(watch.after),beforeReads=jobReads.filter(digest=>digest===unrelated).length;
    watch.reply(next);
    const resumed=await waitFor(()=>rows(unrelated)[index],'unrelated signed Detail and rearm',20000);
    assert.equal(resumed.after,next);assert.equal(resumed.circle,circle.id);assert.equal(resumed.aborted,false);
    assert.ok(jobReads.filter(digest=>digest===unrelated).length>beforeReads,'changed revision triggers a successful signed job read');
    return resumed;
  };
  const deletion=api(owner.app,'/api/jobs/'+encodeURIComponent(deleted)+'/delete',{method:'POST',body:{circle:circle.id}});
  deletion.catch(()=>{}); // the joined assertion below owns this promise
  // The synthetic transport retains the live watch reply until after ACK.
  if(uncertain)t.after(()=>{releaseAck?.();first.reply(different(first.after));});
  let currentSibling=other;
  try {
    if(uncertain){
      await waitFor(()=>releaseAck,'second transport dispatch parked before ACK',20000);
      assert.equal(first.aborted,true,'the durable Delete fence has already stopped the target watch');
      assert.equal(other.aborted,false);
      currentSibling=await cycle(other,1);
      assert.equal(rows(deleted).length,1);
      assert.equal(first.aborted,true,'the target stays fenced while the sibling advances');
      releaseAck();
    }
    const ack=await deletion;
    assert.deepEqual(ack,{...deleteAck(),job_digest:deleted});
    assert.deepEqual(deletes,Array.from({length:uncertain?2:1},()=>({circle:circle.id,digest:deleted})));
    if(uncertain)assert.deepEqual(deleteKeys,[deleteKeys[0],deleteKeys[0]]);
    await waitFor(()=>first.aborted,'the target watch is retired by the end of Delete',20000);
    assert.equal(currentSibling.aborted,false);
    const targetReads=detailAttempts.filter(digest=>digest===deleted).length;
    if(uncertain)first.reply(different(first.after)); // deliver after the real abort; transport ignores it on purpose
    await cycle(currentSibling,uncertain?2:1);
    assert.equal(rows(deleted).length,1,'forgotten watch did not rearm during the sibling cycle');
    assert.equal(detailAttempts.filter(digest=>digest===deleted).length,targetReads,'late target reply did not trigger a signed Detail read');
  } finally {
    if(uncertain){releaseAck?.();first.reply(different(first.after));}
  }
});
