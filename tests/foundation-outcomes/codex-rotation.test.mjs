import test from 'node:test';
import assert from 'node:assert/strict';
import {createUsageTokenRefresher} from '../../lib/v1/usage-token-refresh.mjs';

// Legacy helper regressions only; these do not certify the frozen Codex adapter.
// All material is synthetic and kept in memory, with no real store or endpoint.
function fixture({generation=1,reply}={}) {
  let at=1000000,calls=0,released=0;
  const cred={kind:'oauth',generation,refresh:'synthetic-refresh',expiresAt:0};
  const refresher=createUsageTokenRefresher({
    store:{credential:async()=>cred,lockRefresh:async()=>()=>{released++;},
      stagedRefresh:async()=>null,identity:async()=> 'synthetic-subject'},
    reader:{verify:async()=>{throw new Error('not expected for these outcomes');}},
    records:{codex:{refresh:{url:'https://fixture.invalid/token',hosts:['fixture.invalid'],clientId:'synthetic-client'}}},
    fetchImpl:async()=>{calls++;if(reply instanceof Error)throw reply;return reply;},
    now:()=>at,timeoutMs:1000,backoffMs:10,
  });
  return {refresher,calls:()=>calls,released:()=>released,setTime:value=>{at=value;}};
}
const response=(status,body={},retry=null)=>({status,json:async()=>body,headers:{get:()=>retry}});

test('generation zero is a real fence: stale consumer never exchanges a successor generation', async()=>{
  const f=fixture({generation:1,reply:new Error('must not dispatch')});
  const result=await f.refresher.refresh('codex',{force:true,ifGeneration:0});
  assert.deepEqual(result,{ok:true,refreshed:false,generation:1});
  assert.equal(f.calls(),0);assert.equal(f.released(),1);
});

test('matching generation zero still refreshes; concurrent consumers join one throttled request', async()=>{
  const f=fixture({generation:0,reply:response(429,{},'3600')});
  const results=await Promise.all(Array.from({length:20},()=>f.refresher.refresh('codex',{force:true,ifGeneration:0})));
  assert.equal(f.calls(),1);assert.equal(f.released(),1);
  assert.equal(results[0].reason,'refresh_throttled');assert.equal(results[0].retryAtMs,4600000);
  f.setTime(4599999);
  assert.equal((await f.refresher.refresh('codex',{force:true,ifGeneration:0})).reason,'refresh_backoff');
  assert.equal(f.calls(),1);
  f.setTime(4600000);
  await f.refresher.refresh('codex',{force:true,ifGeneration:0});
  assert.equal(f.calls(),2);
});

test('full HTTP-date throttle deadline survives local backoff cap in this helper instance', async()=>{
  const deadline=10000000;
  const f=fixture({reply:response(429,{},new Date(deadline).toUTCString())});
  const result=await f.refresher.refresh('codex',{force:true,ifGeneration:1});
  assert.equal(result.retryAtMs,deadline);
  f.setTime(deadline-1);
  assert.equal((await f.refresher.refresh('codex',{force:true})).reason,'refresh_backoff');
  assert.equal(f.calls(),1);
});

test('explicit rejected grant and transient service error remain distinct', async()=>{
  const revoked=fixture({reply:response(400,{error:'invalid_grant'})});
  const transient=fixture({reply:response(503)});
  assert.deepEqual(await revoked.refresher.refresh('codex',{force:true}),
    {ok:false,reason:'invalid_grant',account_state:'unknown'});
  await revoked.refresher.refresh('codex',{force:true});
  assert.equal(revoked.calls(),1);
  assert.deepEqual(await transient.refresher.refresh('codex',{force:true}),
    {ok:false,reason:'refresh_unavailable',account_state:'retry'});
  assert.equal(transient.calls(),1);
});

test('expired OAuth material is due but absent refresh capability is not',()=>{
  const {refresher}=fixture();
  assert.equal(refresher.isDue({kind:'oauth',refresh:'synthetic',expiresAt:999999}),true);
  assert.equal(refresher.isDue({kind:'api_key',expiresAt:0}),false);
});
