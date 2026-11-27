import test from 'node:test';
import assert from 'node:assert/strict';
import {createWalkProductPort} from '../foundation-walk/product-port.mjs';

test('conservative registry port preserves real operation shapes and never synthesizes W success', async () => {
  const calls = [], options = {confirmation:'synthetic-owner-approval'};
  const replies = [
    {id:'circle-fixture', membershipProjection:{phase:'approved'}},
    {jobDigest:'a'.repeat(64), operationKey:'resume-fixture', selection:{accountId:'acct-fixture', attemptId:'attempt-fixture'}},
    {path:'/synthetic/result', output:{accountId:'acct-fixture', attemptId:'attempt-fixture'}},
    {current:'attempt-fixture', enabled:false},
    {summary:{phase:'waiting'}, lending:{}}, {},
  ];
  const port = createWalkProductPort({transport:async (id, input, config) => {
    calls.push({id,input,config}); return replies[calls.length - 1];
  }});
  const inputs = [
    ['circles.join',{link:'synthetic-invite'}],
    ['jobs.submit',{prompt:'fixture', noSource:true, model:'model-fixture', budget_v1:{effort:'high'}, draft_id:'draft-fixture'}],
    ['jobs.result',{digest:'a'.repeat(64),circle:'circle-fixture'}],
    ['lending.stop_job',{attemptId:'attempt-fixture'}],
    ['status.get',{}], ['circles.leave',{circle:'circle-fixture'}],
  ];
  for (let i=0;i<inputs.length;i++) {
    const [id,input]=inputs[i];
    assert.equal(await port.call(id,input,options), replies[i]);
    assert.equal(calls[i].input,input); assert.equal(calls[i].config,options);
    assert.equal(calls[i].id,id);
  }
});

test('unknown operation and unfrozen selected-submit fields fail before transport, not by silent downgrade', async () => {
  let calls=0;
  const port=createWalkProductPort({transport:async()=>{calls++;}});
  await assert.rejects(port.call('jobs.imaginary',{}), {code:'unknown_operation'});
  await assert.rejects(port.call('jobs.submit',{prompt:'fixture',noSource:true,
    runRequest:{schemaVersion:1,models:'any',effortId:'high'}}), {code:'unregistered_input'});
  await assert.rejects(port.call('lending.stop_job',{}), {code:'missing_input'});
  assert.equal(calls,0);
});

test('ambiguous submit is never retried and preserves the original resume evidence', async () => {
  let calls=0;
  const error=Object.assign(new Error('synthetic ambiguity'), {code:'submit_unknown',operationKey:'resume-fixture',jobDigest:'b'.repeat(64)});
  const port=createWalkProductPort({transport:async()=>{calls++;throw error;}});
  await assert.rejects(port.call('jobs.submit',{prompt:'fixture',noSource:true,draft_id:'draft-fixture'}), e=>e===error);
  assert.equal(calls,1);
  assert.equal(error.operationKey,'resume-fixture');
});

test('bounded wait uses only zero-second registered reads and injected clock; idle/cancel are not cessation', async () => {
  const responses=[
    {done:false,job:{job_digest:'c'.repeat(64),state:'claimed',status:'Stopping',current_attempt:{attemptId:'attempt-fixture',accountId:'account-fixture'}}},
    {done:false,job:{job_digest:'c'.repeat(64),state:'cancelled',status:'Stop requested',compute_stopped:false}},
  ], calls=[], sleeps=[];
  const port=createWalkProductPort({
    transport:async(id,input)=>{calls.push({id,input});return responses[calls.length-1];},
    clock:{sleep:async ms=>{sleeps.push(ms);}},
  });
  const result=await port.wait({digest:'c'.repeat(64),circle:'circle-fixture'}, {maxPolls:2,pollMs:5});
  assert.equal(result,responses[1]); assert.equal(result.done,false);
  assert.equal(result.job.compute_stopped,false);
  assert.equal(calls.length,2); assert.deepEqual(sleeps,[5]);
  for(const call of calls)assert.deepEqual(call,{id:'jobs.wait',input:{digest:'c'.repeat(64),circle:'circle-fixture',timeout_seconds:0}});
});

test('done is passed through, not upgraded to verified result or cessation', async () => {
  const response={done:true,job:{job_digest:'d'.repeat(64),state:'failed',status:'Failed'}};
  let calls=0;
  const port=createWalkProductPort({transport:async()=>{calls++;return response;},clock:{sleep:async()=>assert.fail('no extra poll')}});
  assert.equal(await port.wait({digest:'d'.repeat(64)},{maxPolls:3,pollMs:1}),response);
  assert.equal(calls,1);
  assert.equal('compute_stopped' in response.job,false);
});

test('abort and invalid budgets produce no hidden polling or submit',async()=>{
  let calls=0;
  const abort=new AbortController(); abort.abort(new Error('fixture stopped'));
  const port=createWalkProductPort({transport:async()=>{calls++;},clock:{sleep:async()=>{}}});
  await assert.rejects(port.wait({digest:'e'.repeat(64)},{maxPolls:2,pollMs:1,signal:abort.signal}), e=>e===abort.signal.reason);
  await assert.rejects(port.wait({digest:'e'.repeat(64)},{maxPolls:Infinity,pollMs:1}), {code:'invalid_poll_budget'});
  assert.equal(calls,0);
});
