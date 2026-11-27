import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import golden from '../docs/protocol/vectors/golden.json' with {type:'json'};
import * as p from '../lib/protocol/index.mjs';
const key=p.privateKeyFromSeed(Buffer.from(golden.keys[0].seed_hex,'hex'));
const check={cmd:'npm test',exit:null,timed_out:true,parser:null,summary:'',observed_by:'sandbox',changed_test_files:[]};
const payload=timing=>({...structuredClone(golden.objects.result.envelope.payload),checks:[{...check,...timing}]});
test('signed checks retain measured duration and enforced timeout, including zero, and legacy fields stay optional',()=>{
 for(const timing of [{},{duration_ms:0},{duration_ms:300012,timeout_ms:300000}]) {
  const result=p.signEnvelope('result',payload(timing),key);assert.deepEqual(result.payload.checks[0],{...check,...timing});assert.equal(p.verifyEnvelope('result',result,p.exportPublicKey(key)).ok,true);
 }
});
test('signed check timing rejects negatives, fractions, overflow and unrecognized timing fields',()=>{
 for(const timing of [{duration_ms:-1},{timeout_ms:-1},{timeout_ms:1.5},{duration_ms:Number.MAX_SAFE_INTEGER+1},{elapsed_ms:5}])assert.throws(()=>p.signEnvelope('result',payload(timing),key));
});
