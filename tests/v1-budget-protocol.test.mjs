import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import golden from '../docs/protocol/vectors/golden.json' with {type:'json'};
import * as p from '../lib/protocol/index.mjs';
const key=p.privateKeyFromSeed(Buffer.from(golden.keys[0].seed_hex,'hex'));
test('a typed request cannot carry the retired budget field',()=>{
 for(const budget_v1 of [{max_list_usd:5},{effort:'high'},{max_list_usd:5,effort:'high'}]){
  const payload=structuredClone(golden.objects.job.envelope.payload);
  payload.budget_v1=budget_v1;payload.requirements.capabilities.push('budget_v1');
  assert.throws(()=>p.signEnvelope('job',payload,key),{code:'invalid_request'});
 }
});
