import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as p from '../lib/protocol/index.mjs';
const golden=JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json',import.meta.url)));
const key=p.privateKeyFromSeed(Buffer.from(golden.keys[1].seed_hex,'hex'));
const result=golden.objects.result.envelope.payload;
const check={cmd:'npm test',exit:null,timed_out:false,parser:null,summary:'',observed_by:'sandbox',changed_test_files:[]};
const messages=['The fresh check workspace could not start.','The returned source could not be prepared for the check.','No check time was left.'];
test('signed skipped checks accept fixed messages and leave legacy checks valid',()=>{
  for(const skipped of messages) {
    const signed=p.signEnvelope('result',{...result,checks:[{...check,skipped}]},key);
    assert.equal(p.verifyEnvelope('result',signed,p.exportPublicKey(key)).ok,true);
  }
  assert.doesNotThrow(()=>p.signEnvelope('result',{...result,checks:[{...check,exit:0}]},key));
});
test('skipped checks reject arbitrary messages, executed exits and invented timing',()=>{
  for(const extra of [{skipped:''},{skipped:'x'.repeat(161)},{skipped:'private host diagnostic'},
    {skipped:messages[0],exit:0},{skipped:messages[0],duration_ms:0},{skipped:messages[0],timeout_ms:1000}])
    assert.throws(()=>p.signEnvelope('result',{...result,checks:[{...check,...extra}]},key),undefined,JSON.stringify(extra));
});
