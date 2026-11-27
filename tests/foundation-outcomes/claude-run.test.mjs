import test from 'node:test';
import assert from 'node:assert/strict';
import {createClaudeProvider} from '../../lib/v1/providers/claude.mjs';

const descriptor = () => ({schemaVersion:1,id:'synthetic',label:'Synthetic',
  signInKind:'api_key',refreshKind:'none',usageKind:'job_local',maxConcurrentJobs:null,
  models:[{id:'model',label:'Model',efforts:[{id:'high',label:'High'}],defaultEffort:'high',
    enabled:true,rank:0,pareto:null}],nativeUnits:[{id:'credits',scale:1000}],
  destinations:[{origin:'https://synthetic.invalid',pathPrefixes:['/v1'],methods:['POST']}]});
function input() {
  const selection={providerId:'synthetic',accountId:'a',modelId:'model',effortId:'high'};
  const amount={unit:'native',nativeUnit:'credits',byResource:[{id:'budget',instance:'epoch',amount:100}]};
  return {selection,jobKey:'synthetic-guest-key',job:{prompt:'fixture',selection:structuredClone(selection)},
    receipt:{schemaVersion:1,accountId:'a',jobId:'j',attemptId:'t',policyVersion:'policy',
      quotedLedgerRevision:0,settingsRevision:0,evaluatedAtMs:1,amount,mode:'observed'},
    enforcement:{amount:structuredClone(amount),wallLimitMs:1000,stopOnBudget:true,metering:'estimated',limitations:['fixture']}};
}
const run = x => ({ok:true,value:{schemaVersion:1,command:'synthetic-command',
  args:[x.selection.modelId,x.selection.effortId],env:{GUEST:x.jobKey},proxy:{kind:'fixture'},
  receipt:structuredClone(x.receipt),enforcement:structuredClone(x.enforcement)}});
const code = r => {assert.equal(r.ok,false);return r.error.code;};
test('absent ports preserve generic unsupported behavior before descriptor/input validation',async()=>{
  const p=createClaudeProvider({descriptor:{schemaVersion:1,id:'synthetic'}});
  assert.equal(code(p.makeRun({})),'adapter_unsupported');
  assert.equal(code(await p.authorizeRequest({})),'adapter_unsupported');
  assert.deepEqual(await p.readUsage({}),{kind:'unavailable',code:'adapter_unsupported'});
  assert.equal(code(p.parseJobUsage({})),'invalid_provider_response');
  assert.equal(p.classifyReplay({dispatched:true}),'never');
});
test('configured mapping preserves effective selection and exact approved records',()=>{
  let seen;
  const p=createClaudeProvider({descriptor:descriptor(),effects:{makeRun:x=>{seen=x;return run(x);}}});
  const x=input(),r=p.makeRun(x);
  assert.equal(r.ok,true);assert.deepEqual(seen.selection,x.selection);
  assert.deepEqual(r.value.receipt,x.receipt);assert.deepEqual(r.value.enforcement,x.enforcement);
  assert.notEqual(seen.job,x.job);assert.equal('auth' in seen,false);
});
test('invalid configured binding, amount, model and effort never reach mapper',()=>{
  let calls=0;const p=createClaudeProvider({descriptor:descriptor(),effects:{makeRun:x=>{calls++;return run(x);}}});
  const mutations=[
    x=>x.selection.providerId='other',x=>x.selection.accountId='other',
    x=>x.selection.modelId='missing',x=>x.selection.effortId='missing',
    x=>x.selection.effortId=null,x=>x.job.selection.accountId='other',
    x=>x.receipt.amount.byResource[0].amount=-1,
    x=>x.receipt.amount.nativeUnit='unknown',
    x=>x.enforcement.amount.byResource[0].instance='other',
    x=>x.receipt.quotedLedgerRevision=0.5,
    x=>x.receipt.amount.byResource.push({...x.receipt.amount.byResource[0]}),
    x=>x.enforcement.stopOnBudget=false,
  ];
  for(const mutate of mutations){const x=input();mutate(x);assert.equal(p.makeRun(x).ok,false);}
  assert.equal(calls,0);
});
test('mapper mutation cannot alter caller and cannot rewrite approved records',()=>{
  const x=input(),before=structuredClone(x);
  const p=createClaudeProvider({descriptor:descriptor(),effects:{makeRun:y=>{
    y.job.prompt='changed';y.selection.modelId='changed';
    y.receipt.amount.byResource[0].amount=999;return run(y);
  }}});
  assert.equal(code(p.makeRun(x)),'invalid_provider_response');assert.deepEqual(x,before);
});
test('malformed run and changed nested enforcement are rejected',()=>{
  for(const mutate of [r=>r.value.args=[1],r=>r.value.env={X:1},
    r=>r.value.proxy=null,r=>r.value.enforcement.limitations.push('changed')]){
    const p=createClaudeProvider({descriptor:descriptor(),effects:{makeRun:x=>{const r=run(x);mutate(r);return r;}}});
    assert.equal(code(p.makeRun(input())),'invalid_provider_response');
  }
});
test('configured host authorization validates destinations before effect and retains one-shot ownership',async()=>{
  let calls=0,seen,disposed=0;
  const body={kind:'one_shot',stream:new ReadableStream(),dispose:async()=>{disposed++;}};
  const auth={accountId:'a',providerId:'synthetic',generation:0,secret:{fixture:true}};
  const request={method:'POST',url:'https://synthetic.invalid/v1/messages',headers:{},body};
  const p=createClaudeProvider({descriptor:descriptor(),effects:{authorizeRequest:async x=>{
    calls++;seen=x;return {ok:true,value:x.request};
  }}});
  assert.equal((await p.authorizeRequest({auth,request})).ok,true);
  assert.equal(seen.request.body,body);assert.equal(disposed,0);
  for(const url of ['https://synthetic.invalid.evil/v1/messages','https://synthetic.invalid/v11',
    'https://user:pass@synthetic.invalid/v1/messages','https://synthetic.invalid/v1/%2e%2e/admin']){
    assert.equal(code(await p.authorizeRequest({auth,request:{...request,url}})),'destination_denied');
  }
  assert.equal((await p.authorizeRequest({auth:{...auth,providerId:'other'},request})).ok,false);
  assert.equal(calls,1);assert.equal(disposed,0);
});
test('usage binding and nested numeric schema reject malformed records',()=>{
  const reading={schemaVersion:1,accountId:'a',attemptId:'t',eventId:'e',sequence:0,atMs:1,
    semantics:'delta',meterEpoch:'epoch',amount:{unit:'credits',value:2},
    windowDebits:[{id:'week',instance:'w1',micro:2}]};
  for(const mutate of [x=>x.accountId='other',x=>x.attemptId='other',x=>x.sequence=-1,
    x=>x.amount.value=NaN,x=>x.amount.unit='unknown',x=>x.windowDebits[0].micro=0.5]){
    const p=createClaudeProvider({descriptor:descriptor(),effects:{parseJobUsage:()=>{
      const r=structuredClone(reading);mutate(r);return {ok:true,value:r};
    }}});
    assert.equal(code(p.parseJobUsage({accountId:'a',attemptId:'t',event:{}})),'invalid_provider_response');
  }
  const p=createClaudeProvider({descriptor:descriptor(),effects:{parseJobUsage:()=>({ok:true,value:reading}),
    classifyReplay:()=> 'safe_if_reconstructable'}});
  assert.deepEqual(p.parseJobUsage({accountId:'a',attemptId:'t',event:{}}),{ok:true,value:reading});
  assert.equal(p.classifyReplay({method:'POST',dispatched:true}),'never');
});

test('descriptor validation happens before effects and does not alter generic sign-in ports',async()=>{
  let calls=0;
  const bad=descriptor();bad.nativeUnits[0].scale=0;
  const p=createClaudeProvider({descriptor:bad,effects:{makeRun:x=>{calls++;return run(x);}}});
  assert.equal(code(p.makeRun(input())),'adapter_unsupported');assert.equal(calls,0);
  const begin=async()=>({ok:true,value:{flowId:'fixture'}});
  const delegated=createClaudeProvider({descriptor:descriptor(),effects:{beginSignIn:begin}});
  assert.equal(delegated.beginSignIn,begin);
});
test('host auth-expired remains typed for broker handling, without reflecting upstream details',async()=>{
  const p=createClaudeProvider({descriptor:descriptor(),effects:{authorizeRequest:async()=>({
    ok:false,error:{code:'auth_expired',retryAtMs:null,raw:'PRIVATE-SENTINEL'}})}});
  const r=await p.authorizeRequest({auth:{accountId:'a',providerId:'synthetic',generation:0,secret:{}},
    request:{method:'POST',url:'https://synthetic.invalid/v1/messages',headers:{},body:{kind:'empty'}}});
  assert.equal(code(r),'auth_expired');assert.equal(JSON.stringify(r).includes('PRIVATE-SENTINEL'),false);
});
