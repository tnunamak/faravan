import '../helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api} from '../helpers/v1-app-fixture.mjs';
import {createLendingDiagnostics} from '../../lib/v1/lending-readiness.mjs';

for(const provider of ['codex','claude'])test('real readiness producer preserves required facts without allowance: '+provider,async t=>{
 const f=await appFixture(t),identity={account_sha256_16:'a'.repeat(16),email_sha256_16:'b'.repeat(16)};
 let scenario='none',calls=0;
 const effects={
  readings:async()=>{calls++;return scenario==='deferred'?{refresh_succeeded:false,refresh_outcome:'deferred'}:null;},
  funding:()=>({identity:scenario==='mismatch'?{...identity,account_sha256_16:'c'.repeat(16)}:identity,
   codex_plan:{plan_type:scenario==='funding'?'free':'pro',limit_reached:false},
   extra_usage:scenario==='funding'?'enabled':'disabled',guest_auth:{loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}}),
  expectedIdentity:()=>scenario==='identity'?null:identity,
  expectedExecutor:()=>({backend_id:'owned-fixture',accepts:v=>v==='1'}),
  stopEvidence:()=>scenario==='stop'?null:{executor:{backend_id:'owned-fixture',sbx_version:'1'},
   stop:{delivered:true,fallback:null,latency_ms:1,removed:true}},stopBoundMs:35000,stopAnswerMs:30000,
 };
 // Test production construction with native effects replaced, not fabricated
 // observation objects. No allowance or sign-in job may be launched.
 const {app}=await f.start('readiness-'+provider,{lendingReadinessSourceFactory:options=>createLendingDiagnostics({...options,...effects})});
 await api(app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
 if(provider==='codex')for(const name of ['none','deferred','identity','mismatch','funding','stop']){
   scenario=name;const before=calls;
   const row=(await api(app,'/api/lending/readiness')).agents[0];
   assert.equal(calls,before+1,'one local observation, no forced probe');
   const checks=Object.fromEntries(row.checks.map(check=>[check.id,check]));
   assert.deepEqual(Object.keys(checks),['signed_in','account','subscription','job_control','usage_estimate']);
   const failing={identity:'account',mismatch:'account',funding:'subscription',stop:'job_control'}[name];
   for(const id of ['account','subscription','job_control'])assert.equal(checks[id].state=== 'pass',id!==failing,name+': '+id);
   assert.equal(checks.usage_estimate.state,'pass');assert.equal(row.hasReading,false);
 }
 const source=createLendingDiagnostics(effects);
 for(const name of ['none','deferred','identity','mismatch','funding','stop']){
   scenario=name;const value=await source.requiredEvidence({provider});
   assert.equal(value.identity.verified,!['identity','mismatch'].includes(name));
   assert.equal(value.funding.subscription_only==='proven',name!=='funding');
   assert.equal(value.stop.bounded_execution==='proven',name!=='stop');
 }
});

import * as source from '../../lib/v1/lending-readiness.mjs';
const EXPECTED_EXECUTOR={backend_id:'docker-sbx',accepts:v=>v==='sbx version v0.49.2'};
const EXECUTOR={backend_id:'docker-sbx',sbx_version:'sbx version v0.49.2'};
const STOP={delivered:true,fallback:null,latency_ms:890,removed:true};
test('the executor is proven only when the sbx backend that ran the probe is the expected one at an accepted version', () => {
  assert.deepEqual(source.executorProof(EXECUTOR, EXPECTED_EXECUTOR), { single_executor: 'proven', reason: null });
  assert.equal(source.executorProof(null, EXPECTED_EXECUTOR).single_executor, 'unknown', 'no observation is not an executor');
  assert.equal(source.executorProof({ ...EXECUTOR, backend_id: 'other-backend' }, EXPECTED_EXECUTOR).single_executor, 'unknown');
  assert.equal(source.executorProof({ ...EXECUTOR, sbx_version: 'sbx version v0.41.0' }, EXPECTED_EXECUTOR).single_executor, 'unknown');
  assert.equal(source.executorProof({ ...EXECUTOR, sbx_version: undefined }, EXPECTED_EXECUTOR).single_executor, 'unknown');
  assert.equal(source.executorProof(EXECUTOR, null).single_executor, 'unknown', 'an unconfigured expectation proves nothing');
});

test('the stop bound is proven only by a delivered guard receipt inside the configured bound, with host removal', () => {
  assert.deepEqual(source.stopProof(STOP, 30000, 30000), { bounded_execution: 'proven', reason: null, uncertainty_ms: 0 });
  assert.equal(source.stopProof(null, 30000, 30000).bounded_execution, 'unknown', 'no measured receipt');
  assert.equal(source.stopProof({ ...STOP, delivered: false, fallback: 'hard' }, 30000, 30000).bounded_execution, 'unknown');
  assert.equal(source.stopProof({ ...STOP, latency_ms: 30001 }, 30000, 30000).bounded_execution, 'unknown', 'slower than the bound');
  assert.equal(source.stopProof({ ...STOP, removed: false }, 30000, 30000).bounded_execution, 'unknown', 'a receipt alone does not end a descendant');
  assert.equal(source.stopProof(STOP, null, 30000).bounded_execution, 'unknown', 'an unconfigured bound proves nothing');
});

