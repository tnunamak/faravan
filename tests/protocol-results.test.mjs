import './helpers/no-browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sign, createPublicKey, createHash } from 'node:crypto';
import * as p from '../lib/protocol/index.mjs';

const read = name => JSON.parse(readFileSync(new URL('../docs/protocol/'+name, import.meta.url)));
const golden = read('vectors/golden.json');
const keys = golden.keys.map(k => p.privateKeyFromSeed(Buffer.from(k.seed_hex,'hex')));
const pub = golden.keys.map(k => k.public_key);
const obj = Object.fromEntries(Object.entries(golden.objects).map(([k,v])=>[k,v.envelope]));
const clone = x => structuredClone(x);
function rawSign(kind,payload,key=keys[0]) {
  const bytes=Buffer.concat([Buffer.from('faravan/'+kind+'/v1\0'),createHash('sha256').update(p.canonicalize(payload)).digest()]);
  return {payload,signature:{algorithm:'Ed25519',key_id:p.fingerprint(createPublicKey(key)),value:sign(null,bytes,key).toString('base64url')}};
}
const verifyJob = payload => p.verifyEnvelope('job',rawSign('job',payload),pub[0]);
const verifyResult = payload => p.verifyEnvelope('result',rawSign('result',payload,keys[1]),pub[1]);
function messageJob(change={}) {
  const job=clone(obj.job.payload);
  job.source={kind:'none'};job.result={kind:'message'};
  job.requirements.capabilities=['results_v1'];
  return {...job,...change};
}
function messageResult({output={kind:'message'},receipt={}}={}) {
  const result=clone(obj.result.payload);
  result.candidate={...result.candidate,media_type:'application/gzip'};
  result.receipt={...result.receipt,source:{kind:'none'},capabilities_applied:['results_v1'],candidate_format:'tree',...receipt};
  if(output!==undefined)result.output=output;
  return result;
}

test('a signed source {kind:none} with a message result is a valid job',()=>{
  const signed=p.signEnvelope('job',messageJob(),keys[0]);
  const checked=p.verifyEnvelope('job',signed,pub[0]);
  assert.equal(checked.ok,true,checked.code);
  assert.deepEqual(checked.payload.source,{kind:'none'});
  assert.deepEqual(checked.payload.result,{kind:'message'});
  assert.equal(verifyJob(messageJob({result:{kind:'files'}})).ok,true);
  // A folder job may also ask for an answer instead of code changes.
  assert.equal(verifyJob({...messageJob(),source:clone(obj.job.payload.source)}).ok,true);
});

test('source none is exact and never implied',()=>{
  for(const source of [{kind:'none',url:'https://example.com'},{kind:'none',artifact:obj.job.payload.source.artifact},{kind:'empty'},{}])
    assert.equal(verifyJob(messageJob({source})).ok,false,JSON.stringify(source));
  const {source,...missing}=messageJob();
  assert.equal(verifyJob(missing).ok,false,'source stays required');
  const noResult=messageJob();delete noResult.result;
  assert.equal(verifyJob(noResult).ok,false,'a job with nothing to work on must say what it returns');
});

test('result kinds are closed and tied both ways to results_v1',()=>{
  for(const result of [{kind:'branch'},{kind:'report'},{kind:'diff'},{kind:'message',path:'x'},{},'message'])
    assert.equal(verifyJob(messageJob({result})).ok,false,JSON.stringify(result));
  assert.equal(verifyJob(messageJob({requirements:{...messageJob().requirements,capabilities:[]}})).ok,false,'result without results_v1');
  const legacy=clone(obj.job.payload);legacy.requirements.capabilities=['results_v1'];
  assert.equal(verifyJob(legacy).ok,false,'results_v1 without a result');
  assert.equal(verifyJob(clone(obj.job.payload)).ok,true,'legacy jobs are unchanged');
});

test('a validator without results_v1 refuses these jobs as unsupported_version',()=>{
  // Old validators check the capability vocabulary before the schema (see requirements()).
  const old=p.validateRequirements(messageJob().requirements,{recognizedCapabilities:['patch-output','verify_v1']});
  assert.deepEqual(old,{ok:false,code:'unsupported_version'});
  const lender={harnesses:['codex'],models:['example-model'],capabilities:['verify_v1'],egress:['provider-only'],
    enforced_limits:Object.keys(obj.job.payload.requirements.limits),max_limits:{...obj.job.payload.requirements.limits}};
  assert.deepEqual(p.canSatisfy(messageJob().requirements,lender).unmet,['capability:results_v1']);
  assert.equal(p.canSatisfy(messageJob().requirements,{...lender,capabilities:['verify_v1','results_v1']}).ok,true);
});

test('result output names the primary output and binds a tree candidate',()=>{
  assert.equal(verifyResult(messageResult()).ok,true,verifyResult(messageResult()).code);
  assert.equal(verifyResult(messageResult({output:{kind:'files'}})).ok,true);
  for(const output of [{kind:'report'},{kind:'message',report_path:'faravan-output/report.md'},{kind:'branch'},{},'message'])
    assert.equal(verifyResult(messageResult({output})).ok,false,JSON.stringify(output));
  const diff=messageResult();diff.candidate.media_type='text/x-diff';
  assert.equal(verifyResult(diff).ok,false,'a message result is never a diff');
  for(const receipt of [{candidate_format:'diff',diffstat:{files:0,insertions:0,deletions:0}},{diff_unavailable:'git_failed'},{candidate_format:undefined}]) {
    const r=messageResult({receipt});if(receipt.candidate_format===undefined)delete r.receipt.candidate_format;
    assert.equal(verifyResult(r).ok,false,JSON.stringify(receipt));
  }
  assert.equal(verifyResult(clone(obj.result.payload)).ok,true,'legacy results are unchanged');
});

test('resultKind maps an absent result to branch, the only encoding of code changes',()=>{
  assert.deepEqual(p.RESULT_KINDS,['branch','message','files']);
  assert.equal(p.resultKind(clone(obj.job.payload)),'branch');
  assert.equal(p.resultKind(messageJob()),'message');
  assert.equal(p.resultKind(messageJob({result:{kind:'files'}})),'files');
  assert.equal(p.resultKind(clone(obj.result.payload)),'branch');
  assert.equal(p.resultKind(messageResult()),'message');
});
