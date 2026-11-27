import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createLender} from '../lib/v1/lender.mjs';
import {createJobOperations} from '../lib/v1/cli.mjs';
import {until} from './helpers/v1-lender-fixture.mjs';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';

const runs=f=>f.calls.filter(([kind])=>kind==='run').length;
function launch(f) {
  const controller=new AbortController();
  const lender=createLender({client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock,
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

test('accepted requester read preserves the signed stop limit anchored to actual execution start',{timeout:60000},async t=>{
  const f=await realLenderFixture(t,{hold:true});
  const circle={id:f.job.payload.circle};
  const device={keyId:f.attempt().holder,selectCircle:async()=>circle,client:async()=>f.owner,
    intentStore:()=>({list:async()=>[]})};
  const operations=createJobOperations({device,home:join(f.root,'requester-projection-home')});
  const input={digest:f.jobDigest,circle:circle.id};

  assert.equal((await operations.get(input)).hardStopAt,undefined,'a queued request has no execution deadline');
  const lender=launch(f);
  try {
    await until(()=>runs(f)===1,'accepted fake execution starts');
    const started=Date.parse((await f.owner.getJob(f.jobDigest)).current_attempt.execution_started_at);
    const projected=await operations.get(input);
    assert.equal(projected.hardStopAt,new Date(started+120000).toISOString(),
      'the verified signed wall limit is anchored to the coordinator start time');
  } finally {
    if(lender.getState().current)await lender.stopCurrentJob(lender.getState().current).catch(()=>{});
    await f.stop();
  }
});
