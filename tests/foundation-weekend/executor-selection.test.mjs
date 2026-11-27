import test from 'node:test';
import assert from 'node:assert/strict';
import {createExecutionRunAdapter} from '../../lib/v1/execution-adapter.mjs';

function fixture() {
  const selection = {providerId:'synthetic',accountId:'account-a',modelId:'model-a',effortId:'high'};
  const attempt = {jobId:'job-a',attemptId:'attempt-a',generation:1,leaseProof:{schemaVersion:1,signedEnvelope:'synthetic-proof'}};
  const amount = {unit:'window_micro_points',byResource:[{id:'window',instance:'epoch',amount:10}]};
  const receipt = {schemaVersion:1,accountId:'account-a',jobId:'job-a',attemptId:'attempt-a',
    policyVersion:'policy-1',quotedLedgerRevision:0,settingsRevision:1,evaluatedAtMs:100,amount,mode:'observed'};
  const enforcement = {amount,wallLimitMs:1000,stopOnBudget:true,metering:'estimated',limitations:['synthetic']};
  const job = {signedPayload:'synthetic-signed-payload',selection,
    runRequest:{schemaVersion:1,models:[{providerId:'synthetic',modelId:'model-a'}],effortId:'high'}};
  const seen = {resolve:[],make:[]};
  const provider = {descriptor:{id:'synthetic',models:[{id:'model-a',enabled:true,defaultEffort:'high',efforts:[{id:'high'}]}]},
    makeRun(input) {
      seen.make.push(input);
      return {ok:true,value:{schemaVersion:1,command:'synthetic-command',args:['synthetic-argument'],
        env:{JOB_KEY:input.jobKey},proxy:{route:'synthetic-proxy'},receipt:input.receipt,enforcement:input.enforcement}};
    }};
  const adapter = createExecutionRunAdapter({
    providers:{getProvider:id=>id==='synthetic'?{ok:true,value:provider}:{ok:false,error:{code:'provider_not_found'}}},
    // Conservative assumption: integration already authenticated and bound this payload.
    resolveJob:async binding=>{seen.resolve.push(binding);return {ok:true,value:job};},
  });
  return {adapter,provider,job,seen,input:{attempt,selection,jobKey:'synthetic-short-lived-key',receipt,enforcement}};
}

test('conservative authenticated integration context supplies actual job to makeRun without changing prepare input', async () => {
  const f=fixture(), request=structuredClone(f.job.runRequest);
  f.input.hostAuth={secret:'host-secret-sentinel'}; // Host-only context must not reach the provider input.
  const result=await f.adapter.makeRun(f.input);
  assert.equal(result.ok,true);
  assert.deepEqual(f.seen.resolve,[{jobId:'job-a',attemptId:'attempt-a'}]);
  assert.equal(f.seen.make.length,1);
  assert.deepEqual(f.seen.make[0].job,f.job);
  assert.deepEqual(f.seen.make[0].selection,f.input.selection);
  assert.deepEqual(f.job.runRequest,request);
  assert.deepEqual(Object.keys(f.seen.make[0]).sort(),['enforcement','job','jobKey','receipt','selection']);
  assert.equal(result.value.env.JOB_KEY,f.input.jobKey);
  assert.deepEqual(result.value.receipt,f.input.receipt);
  assert.deepEqual(result.value.enforcement,f.input.enforcement);
  assert.equal(JSON.stringify(result).includes('host-secret-sentinel'),false);
});

test('explicit effort and requested model are never silently changed', async () => {
  for(const field of ['effortId','modelId']) {
    const f=fixture();
    f.input.selection={...f.input.selection,[field]:'different'};
    f.job.selection=f.input.selection; // Exercise requested/effective validation, not a selection mismatch.
    const result=await f.adapter.makeRun(f.input);
    assert.equal(result.ok,false);
    assert.equal(f.seen.make.length,0);
  }
});

test('null requested effort resolves only to descriptor default', async () => {
  const f=fixture();f.job.runRequest.effortId=null;
  assert.equal((await f.adapter.makeRun(f.input)).ok,true);
  const bad=fixture();bad.job.runRequest.effortId=null;bad.provider.descriptor.models[0].defaultEffort='other';
  assert.equal((await bad.adapter.makeRun(bad.input)).ok,false);
  assert.equal(bad.seen.make.length,0);
});

test('unsupported provider and receipt or enforcement mismatch refuse before makeRun', async () => {
  for(const change of [
    f=>{f.input.selection={...f.input.selection,providerId:'unsupported'};},
    f=>{f.input.receipt={...f.input.receipt,accountId:'account-b'};},
    f=>{f.input.receipt={...f.input.receipt,attemptId:'attempt-b'};},
    f=>{f.input.enforcement={...f.input.enforcement,amount:{unit:'window_micro_points',byResource:[]}};},
  ]) {
    const f=fixture();change(f);
    assert.equal((await f.adapter.makeRun(f.input)).ok,false);
    assert.equal(f.seen.make.length,0);
  }
});

test('cancellation during signed-job lookup prevents makeRun', async () => {
  const f=fixture(),controller=new AbortController();
  let release;
  const adapter=createExecutionRunAdapter({providers:{getProvider:()=>({ok:true,value:f.provider})},
    resolveJob:()=>new Promise(resolve=>{release=resolve;})});
  const pending=adapter.makeRun({...f.input,signal:controller.signal});
  controller.abort();
  release({ok:true,value:f.job});
  assert.equal((await pending).error.code,'cancelled');
  assert.equal(f.seen.make.length,0);
});

test('provider cannot mutate caller records or substitute receipt in returned run', async () => {
  const f=fixture(),before=structuredClone(f.input);
  f.provider.makeRun=input=>{
    input.receipt.accountId='other';
    return {ok:true,value:{schemaVersion:1,command:'synthetic',args:[],env:{},proxy:{},
      receipt:input.receipt,enforcement:input.enforcement}};
  };
  assert.equal((await f.adapter.makeRun(f.input)).ok,false);
  assert.deepEqual(f.input,before);
});

test('provider failures are sanitized without carrying host material', async () => {
  const f=fixture();
  f.provider.makeRun=()=>{throw new Error('host-secret-sentinel');};
  const result=await f.adapter.makeRun(f.input);
  assert.equal(result.ok,false);
  assert.equal(JSON.stringify(result).includes('host-secret-sentinel'),false);
});
