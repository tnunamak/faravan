import '../helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLender} from '../../lib/v1/lender.mjs';
import {realLenderFixture} from '../helpers/v1-real-lender-fixture.mjs';
import {until,deferred} from '../helpers/v1-lender-fixture.mjs';

async function bounded(promise,label,ms=30000) {
  let timer;
  try {return await Promise.race([promise,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error('Timed out: '+label)),ms);
  })]);} finally {clearTimeout(timer);}
}
function launch(f) {
  const controller=new AbortController();
  const lender=createLender({client:f.client,backend:f.backend,adapters:f.adapters,
    policy:f.policy,clock:f.clock,approve:async()=>true,credentialValues:async()=>[],
    onEvent:event=>f.events.push(event)});
  let failure;
  const settled=lender.start(controller.signal).catch(error=>{failure=error;});
  f.stop=async()=>{controller.abort();await bounded(settled,'lender shutdown');if(failure)throw failure;};
  return lender;
}
const runs=f=>f.calls.filter(([kind])=>kind==='run').length;
const renewals=f=>f.realRequests.filter(row=>row.url.endsWith('/renew')).length;
async function verifiedRetained(f,attempt) {
  const view=await f.owner.getJob(f.jobDigest);
  assert.equal(view.state,'result-accepted');
  assert.equal(view.current_attempt.attempt_id,attempt.attempt_id);
  assert.equal(view.current_attempt.generation,attempt.generation);
  assert.equal(view.current_attempt.compute_stopped,true);
  assert.ok(view.current_attempt.stopped_at);
  const before=f.realRequests.length;
  const first=await f.owner.fetchResult(f.jobDigest,{includeMetadata:true,attempt});
  assert.ok(f.realRequests.slice(before).some(row=>/\/artifacts\//.test(row.url)),
    'positive control: real verification fetched retained artifact bytes');
  const again=await f.owner.fetchResult(f.jobDigest,{includeMetadata:true,attempt});
  assert.deepEqual(again,first,'duplicate verified read does not change retained output');
  assert.equal(runs(f),1);
  assert.equal(f.saved().outputPending,null);
  assert.equal(f.saved().resultPending,null);
  return first;
}

test('graceful owner Stop retains actually verified output and rejects corrupt returned bytes',
  {timeout:120000},async t=>{
    let corrupt=false,corruptReads=0;
    const f=await realLenderFixture(t,{hold:true,intercept:(req,res)=>{
      if(!corrupt||req.method!=='GET'||!req.url.includes('/artifacts/'))return false;
      corruptReads++;
      const bytes=Buffer.from('deliberately corrupt retained artifact');
      res.writeHead(200,{'content-type':'application/octet-stream','content-length':bytes.length});
      res.end(bytes);return true;
    }});
    const providerStops=[],stopReceipts=[];
    const requestStop=f.client.requestStop.bind(f.client);
    f.client.requestStop=async(...args)=>{const receipt=await requestStop(...args);stopReceipts.push(receipt);return receipt;};
    f.backend.requestStop=async(_handle,reason)=>{
      providerStops.push(reason);f.execution.resolve();return {delivered:true};
    };
    const lender=launch(f);
    try {
      await bounded(f.entered.promise,'actual held execution');
      const view=await f.owner.getJob(f.jobDigest),attempt=structuredClone(view.current_attempt);
      assert.ok(attempt.execution_started_at);
      assert.equal(lender.getState().current,attempt.attempt_id);
      assert.equal(runs(f),1);
      await bounded(lender.stopCurrentJob(attempt.attempt_id),'graceful owner Stop');
      await until(()=>f.events.some(e=>e.status==='finished'),'verified host delivery',30000);
      assert.deepEqual(providerStops,['owner']);
      assert.ok(stopReceipts.some(row=>row.attempt_id===attempt.attempt_id&&
        row.job_digest===f.jobDigest&&row.generation===attempt.generation&&row.requested_at),
        'independent coordinator stop receipt distinguishes this from ordinary completion');
      assert.ok(f.saves.some(row=>row.pending?.gracefulStopReason==='owner'&&row.pending.stopRequestKey));
      assert.ok(f.calls.some(([kind])=>kind==='destroy'));
      const verified=await verifiedRetained(f,attempt);
      corrupt=true;
      await assert.rejects(()=>f.owner.fetchResult(f.jobDigest,{includeMetadata:true,attempt}));
      assert.ok(corruptReads>0,'rejection followed a successful HTTP200 corrupt artifact response');
      corrupt=false;
      assert.deepEqual(await f.owner.fetchResult(f.jobDigest,{includeMetadata:true,attempt}),verified,
        'a refused corrupt download does not mutate accepted output');
      assert.equal(runs(f),1);
    } finally {corrupt=false;f.execution.resolve();await f.stop();}
  });

for(const stage of ['save','upload','destroy'])test('Stop retains collected output held at '+stage,
  {timeout:120000},async t=>{
    const f=await realLenderFixture(t),gate=deferred(),entered=deferred();
    let held=false;
    const hold=async()=>{if(!held){held=true;entered.resolve();await gate.promise;}};
    if(stage==='save') {
      const set=f.policy.storage.set;
      f.policy.storage.set=async value=>{
        if(value.outputPending&&!f.saved()?.outputPending)await hold();
        return set(value);
      };
    } else if(stage==='upload') {
      const upload=f.client.uploadResultArtifacts.bind(f.client);
      f.client.uploadResultArtifacts=async(...args)=>{await hold();return upload(...args);};
    } else {
      const destroy=f.backend.destroy.bind(f.backend);
      f.backend.destroy=async(...args)=>{if(f.saved()?.outputPending)await hold();return destroy(...args);};
    }
    const stopEntered=deferred(),providerStops=[];
    f.backend.requestStop=async(_handle,reason)=>{
      providerStops.push(reason);stopEntered.resolve();return {delivered:false};
    };
    const lender=launch(f);
    let stopping;
    try {
      await bounded(entered.promise,'collected output held at '+stage);
      assert.equal(runs(f),1);
      assert.ok(f.calls.some(([kind])=>kind==='collect'));
      const view=await f.owner.getJob(f.jobDigest),attempt=structuredClone(view.current_attempt);
      assert.ok(attempt.execution_started_at);
      assert.equal(lender.getState().current,attempt.attempt_id);
      stopping=lender.stopCurrentJob(attempt.attempt_id).catch(error=>{
        assert.equal(error.code,'no_current_job','only the documented deferred-Stop response is allowed');
      });
      await bounded(stopEntered.promise,'Stop reaches provider before releasing '+stage);
      assert.notEqual((await f.owner.getJob(f.jobDigest)).state,'result-accepted');
      assert.ok(!f.events.some(e=>e.status==='finished'||e.status==='stopped'||e.stopCompletion),
        'held bytes are not a delivered result or completed Stop');
      if(stage==='upload') {
        const before=renewals(f);
        f.clock.advance(f.policy.renewMs+1000);
        await until(()=>renewals(f)>before,'renewal while stopped upload waits',30000);
      }
      gate.resolve();await bounded(stopping,'deferred Stop settles');
      await until(()=>f.events.some(e=>e.status==='finished'),'retained output delivered',30000);
      await verifiedRetained(f,attempt);
      assert.ok(providerStops.includes('owner'));
      assert.ok(f.calls.some(([kind])=>kind==='destroy'));
      assert.ok(f.saves.some(row=>row.pending?.gracefulStopReason==='owner'&&row.pending.stopRequestKey),
        'unconfirmed provider stop has a durable recovery record');
    } finally {
      gate.resolve();f.execution.resolve();
      try {if(stopping)await bounded(stopping,'Stop cleanup');} finally {await f.stop();}
    }
  });
