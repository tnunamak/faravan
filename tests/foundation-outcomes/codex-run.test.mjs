import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexProvider } from '../../lib/v1/providers/codex.mjs';

const descriptor = {schemaVersion:1,id:'codex',label:'Synthetic Codex',signInKind:'browser_oauth',
  refreshKind:'rotating',usageKind:'job_local',maxConcurrentJobs:1,
  models:[{id:'synthetic-model',label:'Model',efforts:[{id:'high',label:'High'}],
    defaultEffort:'high',enabled:true,rank:0,pareto:null}],
  nativeUnits:[{id:'tokens',scale:1}],
  destinations:[{origin:'https://fixture.invalid',pathPrefixes:['/v1/infer'],methods:['POST']}]};
function input() {
  const amount={unit:'native',nativeUnit:'tokens',byResource:[{id:'tokens',instance:null,amount:100}]};
  return {selection:{providerId:'codex',accountId:'a',modelId:'synthetic-model',effortId:'high'},
    jobKey:'synthetic-guest-key',job:{signedPayload:'opaque'},
    receipt:{schemaVersion:1,accountId:'a',jobId:'j',attemptId:'t',policyVersion:'p',
      quotedLedgerRevision:0,settingsRevision:0,evaluatedAtMs:10,amount,mode:'cold_pace'},
    enforcement:{amount:structuredClone(amount),wallLimitMs:1000,stopOnBudget:true,metering:'measured',limitations:[]}};
}
function mapped(x) { return {ok:true,value:{schemaVersion:1,command:'fixture-codex',
  args:['exec','--json','--model',x.selection.modelId,'--effort',x.selection.effortId],
  env:{GUEST_KEY:x.jobKey},proxy:{origin:'https://local-proxy.invalid'},
  receipt:x.receipt,enforcement:x.enforcement}}; }
const make = effects => createCodexProvider({descriptor,effects});
const code = r => r.error?.code;

test('configured factory export preserves exact selection, opaque job, receipt and enforcement', () => {
  let calls=0;
  const x=input();
  const a=make({makeRun(y){calls++;assert.deepEqual(y,x);assert.notEqual(y,x);return mapped(y);}});
  const result=a.makeRun(x);
  assert.equal(result.ok,true);assert.equal(calls,1);
  assert.deepEqual(result.value.receipt,x.receipt);
  assert.deepEqual(result.value.enforcement,x.enforcement);
  assert.deepEqual(result.value.args,['exec','--json','--model','synthetic-model','--effort','high']);
});
test('invalid provider/account/model/effort/amount makes zero mapper calls', () => {
  let calls=0;const a=make({makeRun(x){calls++;return mapped(x);}});
  for(const edit of [x=>x.selection.providerId='other',x=>x.receipt.accountId='b',
    x=>x.selection.accountId='',x=>x.selection.modelId='missing',x=>x.selection.effortId='low',
    x=>x.receipt.amount.byResource[0].amount=-1,x=>x.enforcement.amount.byResource[0].amount=99,
    x=>x.receipt.schemaVersion=2,x=>x.enforcement.stopOnBudget=false]) {
    const x=input();edit(x);assert.equal(a.makeRun(x).ok,false);
  }
  assert.equal(calls,0);
});
test('mapper mutation and malformed output rejected without altering caller', () => {
  const x=input(),saved=structuredClone(x);
  assert.equal(make({makeRun(y){y.selection.modelId='changed';return mapped(y);}}).makeRun(x).ok,false);
  assert.deepEqual(x,saved);
  for(const edit of [r=>r.value.args=[42],r=>r.value.env={X:42},
    r=>r.value.receipt={...r.value.receipt,attemptId:'other'},r=>r.value.proxy=null]) {
    assert.equal(make({makeRun(y){const r=mapped(y);edit(r);return r;}}).makeRun(x).ok,false);
  }
});
test('missing mapping retains unsupported before binding validation; replay always never', () => {
  const a=make({classifyReplay:()=> 'safe_if_reconstructable'});
  assert.equal(code(a.makeRun({})), 'adapter_unsupported');
  assert.equal(a.classifyReplay({method:'POST',dispatched:true}), 'never');
  assert.equal(code(createCodexProvider({}).makeRun(input())), 'adapter_unsupported');
});
test('host authorization rejects unrelated destination/binding before effects and preserves one-shot body', async () => {
  let calls=0,opened=0,disposed=0;
  const body={kind:'one_shot',stream:{},dispose:async()=>{disposed++;}};
  const auth={providerId:'codex',accountId:'a',generation:0,secret:{synthetic:'host-only'}};
  const request={method:'POST',url:'https://fixture.invalid/v1/infer',headers:{Authorization:'guest', 'X-Account-Id':'foreign',Accept:'text/event-stream'},body};
  const a=make({authorizeRequest:async x=>{
    calls++;assert.equal(x.request.body,body);
    assert.equal(Object.keys(x.request.headers).some(k=>k.toLowerCase()==='authorization'),false);
    assert.equal(Object.keys(x.request.headers).some(k=>k.toLowerCase()==='x-account-id'),false);
    return {ok:true,value:{...x.request,headers:{...x.request.headers,Authorization:'Bearer synthetic'}}};
  }});
  for(const change of [x=>x.auth.providerId='wrong',x=>x.auth.accountId='',x=>x.auth.generation=-1,
    x=>x.request.url='https://other.invalid/v1/infer',x=>x.request.url='https://fixture.invalid/admin',
    x=>x.request.method='GET']) {
    const x={auth:{...auth},request:{...request}};change(x);
    assert.equal((await a.authorizeRequest(x)).ok,false);
  }
  assert.equal(calls,0);
  const r=await a.authorizeRequest({auth,request});assert.equal(r.ok,true);
  assert.equal(r.value.body,body);assert.equal(calls,1);assert.equal(opened,0);assert.equal(disposed,0);
  assert.equal(request.headers.Authorization,'guest');
});
test('authorization effect cannot redirect host material or substitute body', async () => {
  const x={auth:{providerId:'codex',accountId:'a',generation:1,secret:{}},
    request:{url:'https://fixture.invalid/v1/infer',method:'POST',headers:{},body:{kind:'empty'}}};
  assert.equal((await make({authorizeRequest:async y=>({ok:true,value:{...y.request,url:'https://evil.invalid/'}})}).authorizeRequest(x)).ok,false);
});
function observation(raw={type:'turn.completed',usage:{input_tokens:11,output_tokens:3,cached_input_tokens:5}}) {
  return {accountId:'a',attemptId:'t',event:{eventId:'e',sequence:2,atMs:100,meterEpoch:'epoch',raw,windowDebits:[]}};
}
test('native completion grammar counts input plus output once, preserves durable observation binding', () => {
  const r=make({}).parseJobUsage(observation());
  assert.deepEqual(r,{ok:true,value:{schemaVersion:1,accountId:'a',attemptId:'t',eventId:'e',sequence:2,atMs:100,
    semantics:'delta',meterEpoch:'epoch',amount:{unit:'tokens',value:14},windowDebits:[]}});
  assert.equal('model' in r.value,false);
  const x=observation();x.event.windowDebits=[{id:'w',instance:'i',micro:7}];
  assert.deepEqual(make({}).parseJobUsage(x).value.windowDebits,x.event.windowDebits);
});
test('invalid/missing token counts, event fields and inferred window data rejected', () => {
  for(const raw of [{type:'turn.started'}, {type:'turn.completed',usage:{input_tokens:1}},
    {type:'turn.completed',usage:{input_tokens:null,output_tokens:2}},
    {type:'turn.completed',usage:{input_tokens:-1,output_tokens:2}},
    {type:'turn.completed',usage:{input_tokens:Number.MAX_SAFE_INTEGER,output_tokens:2}}])
    assert.equal(make({}).parseJobUsage(observation(raw)).ok,false);
  for(const edit of [x=>x.event.sequence=-1,x=>x.event.eventId='',x=>x.event.atMs=NaN,
    x=>x.event.windowDebits=[{id:'w',instance:'i',micro:-1}]]) {
    const x=observation();edit(x);assert.equal(make({}).parseJobUsage(x).ok,false);
  }
});
test('explicit parser mapping cannot return a foreign account/attempt or invalid native unit', () => {
  const valid=make({}).parseJobUsage(observation());
  for(const edit of [x=>x.accountId='other',x=>x.attemptId='other',x=>x.amount.unit='invented']) {
    const r=structuredClone(valid);edit(r.value);
    assert.equal(make({parseJobUsage:()=>r}).parseJobUsage(observation()).ok,false);
  }
});
