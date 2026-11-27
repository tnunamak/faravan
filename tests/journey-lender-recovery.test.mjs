import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLender,TEMPORARY_HOLD_REOFFER_MS} from '../lib/v1/lender.mjs';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
import {lenderFixture,until} from './helpers/v1-lender-fixture.mjs';

function launch(f,extra={}) {
  const controller=new AbortController();
  const lender=createLender({client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock,
    approve:async()=>true,onEvent:e=>f.events.push(e),...extra});
  const loop=lender.start(controller.signal);
  f.stop=async()=>{controller.abort();await loop;};
  return lender;
}
const turn=()=>new Promise(r=>setTimeout(r,20));
async function pump(f,check,label) {
  for(let i=0;i<120&&!check();i++){f.clock.advance(300);await turn();}
  assert.ok(check(),label);
}
for(const stoppedByLender of [false,true])test(`J2-2 J5-2 deleted pre-start release clears (Stop=${stoppedByLender})`,async t=>{
  const f=await lenderFixture(t);
  await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,
    declinePending:{attempt:f.attempt(),reason:'{"code":"approval_denied"}',idempotencyKey:'deleted-release',stoppedByLender}});
  f.override=({route,res})=>{if(route.endsWith('/release')||route.includes('/jobs/')){f.problem(res,'not_found',404);return true;}return false;};
  launch(f);
  await pump(f,()=>f.saved().declinePending===null,'deleted release must clear');
  assert.equal(f.calls.filter(([kind])=>kind==='run').length,0);
});
for(const endpoint of ['/release','/stopped'])test(`J2-3 J5-1 deleted Stop clears at ${endpoint}`,async t=>{
  const f=await lenderFixture(t,{hold:true});
  let missing=false;
  f.override=({route,res})=>{if(missing&&(route.endsWith(endpoint)||route.includes('/jobs/'))){f.problem(res,'not_found',404);return true;}return false;};
  const lender=launch(f);
  await until(()=>f.calls.some(([kind])=>kind==='run'));
  missing=true;await lender.stopCurrentJob(lender.getState().current);
  await pump(f,()=>!f.saved().pending,'Stop must clear after proven removal');
  assert.ok(f.calls.some(([kind])=>kind==='destroy'));
  assert.equal(f.saved().lastRecovery.removed,true);
});

test('J2-1 J5-6 recovered output over combined limit is retained and clears',async t=>{
  const f=await lenderFixture(t);
  launch(f);await until(()=>f.events.some(e=>e.status==='finished'));await f.stop();
  const snapshot=structuredClone(f.saves.find(s=>s.outputPending));
  snapshot.pending=null;snapshot.claimedPending=null;snapshot.acceptedClaim=null;snapshot.resultPending=null;
  snapshot.outputPending.claim.job.payload.requirements.limits.output_bytes=
    snapshot.outputPending.result.collected.reduce((sum,file)=>sum+Buffer.from(file.bytes_content,'base64').length,0)+1;
  f.client.getJob=async()=>({state:'active'});
  await f.policy.storage.set(snapshot);f.events.length=0;launch(f);
  await pump(f,()=>!f.saved().outputPending,'invalid recovered output must clear');
  assert.equal(f.saved().rejectedOutput.code,'output_too_large');
  assert.ok(f.saved().rejectedOutput.output.result.collected.length);
});
for(const code of ['invalid_content_type','size_mismatch','invalid_json'])test(`J2-5 unusable completion reply clears: ${code}`,async t=>{
  const f=await lenderFixture(t);
  f.client.completeAttempt=async()=>{throw Object.assign(new Error(code),{code,responseReceived:true,outcome:'unknown'});};
  launch(f);await until(()=>f.saved()?.resultPending);
  await pump(f,()=>!f.saved().resultPending,'unusable replies must have bounded replay');
  assert.equal(f.saved().lastResultOutcome.code,code);
  assert.ok(f.saved().rejectedResult.intent.payload);
  assert.ok(f.events.some(e=>e.status==='result-unconfirmed'));
});

test('J5-3 restored cooldown is bounded after backward wall step',async t=>{
  const f=await lenderFixture(t);
  await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,declineUntil:f.clock.now()+3600000});
  launch(f);
  await pump(f,()=>f.events.some(e=>e.status==='finished'),'restored cooldown must expire on elapsed time');
});

test('J2-4 automatic quota refusal reoffers after allowance repair',async t=>{
  const f=await realLenderFixture(t,{mutateJob:job=>{job.expires_at='2026-10-09T18:00:00Z';}});let blocked=true;
  f.policy.lendingRuntime.candidate.reserve=async()=>blocked?{ok:false,reason:'quota_reserve'}:{ok:true,reservation:{provider:'codex',model:null},decision:{effort_max:null}};
  launch(f);await until(()=>f.events.some(e=>e.reason==='quota_reserve'));blocked=false;
  await until(()=>!f.saved().declinePending&&!f.saved().claimedPending,'capacity refusal clears');
  f.clock.advance(TEMPORARY_HOLD_REOFFER_MS);await turn();
  await pump(f,()=>f.events.some(e=>e.status==='finished'),'same job finishes after allowance repair');
  assert.equal((await f.owner.getJob(f.jobDigest)).state,'result-accepted');
  assert.ok(f.saves.some(s=>s.declined?.some(row=>row.expiresAt<Date.parse(f.job.payload.expires_at))));
});

test('J5-5 first spool write failure retries bytes before cleanup',async t=>{
  const f=await lenderFixture(t);const save=f.policy.storage.set;let failed=false;
  f.policy.storage.set=async value=>{if(value.outputPending&&!failed){failed=true;assert.equal(f.calls.some(([kind])=>kind==='destroy'),false);throw Object.assign(new Error('temporary write failure'),{code:'EIO'});}return save(value);};
  launch(f);await until(()=>failed);
  await pump(f,()=>f.events.some(e=>e.status==='finished'),'collected bytes must survive transient first write failure');
  const durable=f.saves.findIndex(s=>s.outputPending);
  assert.ok(durable>=0);assert.ok(f.result);
});

for(const stop of [false,true])test(`deleted coordinator record permits successor (Stop=${stop})`,async t=>{
  const f=await realLenderFixture(t,{hold:stop});
  const release=f.client.release.bind(f.client);let offline=true;
  f.client.release=(...args)=>{if(offline)throw Object.assign(new Error('offline'),{code:'network_error',retryable:true});return release(...args);};
  const lender=launch(f,{approve:async()=>stop});
  if(stop){await until(()=>f.calls.some(([kind])=>kind==='run'));await lender.stopCurrentJob(lender.getState().current);}
  else await until(()=>f.saved()?.declinePending);
  await f.owner.cancelJob(f.jobDigest);await f.owner.deleteJob(f.jobDigest);
  offline=false;
  await pump(f,()=>!f.saved().pending&&!f.saved().declinePending,'deleted coordinator record clears local obligations');
  const successor=await f.submit();
  await f.stop();f.execution.resolve();
  let claimed=false;
  const claim=f.client.claimNext.bind(f.client);
  f.client.claimNext=async(...args)=>{const value=await claim(...args);if(value?.job_digest===successor)claimed=true;return value;};
  launch(f,{approve:async()=>true});
  await pump(f,()=>claimed,'successor discovery');
  assert.equal((await f.owner.getJob(successor)).job_digest,successor);
});

test('J5-3 live cooldown ignores backward wall correction',async t=>{
  const f=await lenderFixture(t);const elapsed=f.clock.now;let correction=0,claims=0;
  f.clock.monotonic=elapsed;f.clock.now=()=>elapsed()+correction;
  await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,declineUntil:f.clock.now()+3000});
  f.client.claimNext=async()=>{claims++;return null;};
  launch(f);await until(()=>f.clock.pending().includes(3000));
  correction=-3600000;
  await pump(f,()=>claims>0,'wall rollback must not extend live elapsed-time cooldown');
});

for(const [code,status] of [['invalid_content_type',null],['size_mismatch',503]])
test(`J2-5 unusable replies remain counted across transport errors: ${code}`,async t=>{
  const f=await lenderFixture(t);let sends=0,payload;
  f.client.completeAttempt=async(_remote,value)=>{
    payload??=structuredClone(value);assert.deepEqual(value,payload);
    const unusable=++sends%2===1;
    throw Object.assign(new Error(unusable?code:'transport'),unusable?
      {code,responseReceived:true,outcome:'unknown'}:
      {code:status?'unavailable':'network_error',status:status??0,retryable:true,outcome:'unknown'});
  };
  launch(f);await until(()=>f.saved()?.resultPending);
  await pump(f,()=>sends>=4,'received unusable reply followed by a transport failure');
  await f.stop();launch(f);
  await pump(f,()=>!f.saved().resultPending,'interleaved failures must not reset received reply count after restart');
  assert.ok(f.events.some(e=>e.status==='result-unconfirmed'));
  assert.deepEqual(f.saved().rejectedResult.intent.payload,payload);
  assert.equal(sends,7,'three unusable recovery replies remain counted across intervening transport failures');
  const counts=f.saves.filter(s=>s.resultPending).map(s=>s.resultPending.unknownAckRetries??0);
  assert.ok(counts.every((count,index)=>index===0||count>=counts[index-1]),'the stored count never decreases for the retained result');
});

for(const code of ['EIO','ENOSPC'])for(const cancel of ['renewal','outer'])
test(`J5-5 ${code} handoff survives ${cancel} cancellation before retry`,async t=>{
  const f=await realLenderFixture(t);const save=f.policy.storage.set,destroy=f.backend.destroy,renew=f.client.renew.bind(f.client);
  let failed=false,healthy=false,durable=false,writes=0;const order=[];
  f.policy.pollMs=f.policy.renewMs*2;
  f.policy.storage.set=async value=>{
    if(value.outputPending&&!healthy){writes++;failed=true;throw Object.assign(new Error('disk unavailable'),{code});}
    await save(value);
    if(value.outputPending){durable=true;order.push('durable');}
  };
  f.backend.destroy=async(...args)=>{order.push('destroy');return destroy(...args);};
  f.client.renew=async(...args)=>{if(!failed)return renew(...args);throw Object.assign(new Error('renewal unavailable'),{code:'network_error',retryable:true});};
  launch(f);await until(()=>failed,'first output save fails');
  let stopping;
  try {
    if(cancel==='renewal')f.clock.advance(f.policy.renewMs);
    else stopping=f.stop();
    await until(()=>f.calls.some(([kind])=>kind==='cancel'),'compute cancelled promptly');
    await turn();
    assert.equal(order.includes('destroy'),false,'scratch must remain until collected bytes are durable');
    assert.equal(durable,false);
    assert.equal(writes,1,'cancellation occurs before the first save retry');
  } finally {
    healthy=true;
    f.clock.advance(f.policy.pollMs);await turn();
    await stopping;
  }
  await pump(f,()=>durable&&order.includes('destroy'),'independent handoff persists bytes and permits cleanup');
  assert.ok(order.indexOf('durable')<order.indexOf('destroy'));
  assert.ok(f.saves.some(s=>s.outputPending?.result.collected.length));
});

test('a borrower cancel that lands while recovered output uploads is not shown as failed',{timeout:20000},async t=>{
  const f=await lenderFixture(t);
  launch(f);await until(()=>f.events.some(e=>e.status==='finished'));await f.stop();
  const snapshot=structuredClone(f.saves.find(s=>s.outputPending));
  snapshot.pending=null;snapshot.claimedPending=null;snapshot.acceptedClaim=null;snapshot.resultPending=null;
  let cancelled=false,uploads=0;
  // The preflight sees an active job; the cancel lands during the upload, which the lender then rejects as terminal.
  f.client.getJob=async()=>({state:cancelled?'cancelled':'active'});
  f.client.uploadResultArtifacts=async()=>{uploads++;cancelled=true;throw Object.assign(new Error('job terminal'),{code:'job_terminal',status:409});};
  await f.policy.storage.set(snapshot);f.events.length=0;launch(f);
  t.after(()=>f.stop?.().catch(()=>{}));
  await pump(f,()=>!f.saved().outputPending,'recovered output must leave the spool');
  assert.ok(uploads>=1,'the recovered upload never ran');
  const failed=f.events.find(e=>e.status==='failed');
  assert.equal(failed,undefined,'cancelled recovered output shown failed: '+failed?.reason);
  assert.equal(f.saved().lastResultOutcome?.code??f.saved().rejectedOutput?.code,'cancelled');
});
