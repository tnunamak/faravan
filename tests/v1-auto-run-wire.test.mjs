import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import golden from '../docs/protocol/vectors/golden.json' with {type:'json'};
import * as p from '../lib/protocol/index.mjs';
const key=p.privateKeyFromSeed(Buffer.from(golden.keys[0].seed_hex,'hex'));
test('a typed request cannot carry the retired automatic choice',()=>{
 for(const intent of ['cheapest','strongest']){
  const payload=structuredClone(golden.objects.job.envelope.payload);
  payload.auto_run_v1={intent};payload.requirements.capabilities.push('auto_run_v1');
  assert.throws(()=>p.signEnvelope('job',payload,key),{code:'invalid_request'});
 }
});
test('a result cannot describe a retired automatic choice',()=>{
 const payload=structuredClone(golden.objects.result.envelope.payload);
 payload.receipt.auto_run_v1={intent:'cheapest',model:'example-model',effort:'low'};
 assert.throws(()=>p.signEnvelope('result',payload,key),{code:'invalid_request'});
});
