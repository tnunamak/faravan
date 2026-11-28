import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLender} from '../lib/v1/lender.mjs';
import {until} from './helpers/v1-lender-fixture.mjs';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
import {jobWatchRevision} from '../lib/v1/job-watch.mjs';

const runs=f=>f.calls.filter(([kind])=>kind==='run').length;
function launch(f) {
  const controller=new AbortController();
  const lender=createLender({...f.runOptions,client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock,
    approve:async()=>true,onEvent:event=>f.events.push(event)});
  const running=lender.start(controller.signal);
  let failure;const settled=Promise.resolve(running).catch(error=>{failure=error;});
  f.stop=async()=>{
    controller.abort();let timer;
    try {await Promise.race([settled,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Lender shutdown timed out')),2000);})]);}
    finally {clearTimeout(timer);}
    if(failure&&failure.name!=='AbortError'&&failure.code!=='aborted')throw failure;
  };
  return lender;
}

test('the coordinator shares an authenticated stop request without asserting cessation',{timeout:60000},async t=>{
  const f=await realLenderFixture(t,{hold:true}),lender=launch(f);
  try {
    await until(()=>runs(f)===1,'accepted fake execution starts');
    const before=await f.owner.getJob(f.jobDigest),attempt=before.current_attempt;
    const revision=jobWatchRevision(before,null);
    const pushed=f.owner.waitForJobChange(f.jobDigest,{after:revision,waitSeconds:5});
    const request=await f.client.requestStop(attempt,{idempotencyKey:'shared-stop-request'});
    const changed=await pushed;
    assert.notEqual(changed.revision,revision,'the coordinator wakes a requester watch when the lender records Stop');
    assert.deepEqual(request,{attempt_id:attempt.attempt_id,job_digest:f.jobDigest,
      generation:attempt.generation,requested_at:request.requested_at});
    assert.equal((await f.owner.getStopRequest(attempt)).attempt_id,attempt.attempt_id,
      'the requester reads the holder-authenticated fact');
    const view=await f.owner.getJob(f.jobDigest);
    assert.equal(view.current_attempt.compute_stopped,false);
    assert.equal(view.current_attempt.state,'active');
    assert.ok(f.realRequests.some(row=>row.url.endsWith('/stop-request')));
  } finally {
    if(lender.getState().current)await lender.stopCurrentJob(lender.getState().current).catch(()=>{});
    await f.stop();
  }
});

test('offline stop delivery survives lender restart and replays the same request key',{timeout:60000},async t=>{
  const f=await realLenderFixture(t,{hold:true});
  f.backend.destroy=async()=>({removed:false});
  f.backend.reconcilePending=async pending=>({attemptId:pending.attemptId,removed:false});
  const requestStop=f.client.requestStop.bind(f.client);
  let dropAcknowledgements=true;
  f.client.requestStop=async(...args)=>{
    const response=await requestStop(...args);
    if(dropAcknowledgements)throw Object.assign(new Error('synthetic lost acknowledgement'),{code:'network_error'});
    return response;
  };
  let lender=launch(f);
  try {
    await until(()=>runs(f)===1,'accepted fake execution starts');
    await lender.stopCurrentJob(lender.getState().current);
    await until(()=>f.events.some(event=>event.reason==='cleanup_pending'),'local cleanup remains unconfirmed');
    const key=f.saved().pending.stopRequestKey;
    assert.ok(key,'the request key is durable before delivery');
    const attempt=f.saved().pending.attempt;
    assert.ok(f.realRequests.some(row=>row.url.endsWith('/stop-request')),
      'the server committed the request even though its acknowledgement was lost');
    assert.equal(f.realRequests.filter(row=>row.url.endsWith('/stop-request')&&row.key===key).length>=1,true);
    await f.stop();

    dropAcknowledgements=false;
    lender=launch(f);
    await until(()=>f.realRequests.filter(row=>row.url.endsWith('/stop-request')&&row.key===key).length>=2,
      'restart retries the committed stop request');
    assert.equal(f.saved().pending.stopRequestKey,key,'restart reuses the original idempotency key');
    const observed=await f.owner.getStopRequest(attempt);
    assert.equal(observed.attempt_id,attempt.attempt_id);
    assert.deepEqual(new Set(f.realRequests.filter(row=>row.url.endsWith('/stop-request')&&row.key).map(row=>row.key)),new Set([key]));
  } finally {
    await f.stop();
  }
});
