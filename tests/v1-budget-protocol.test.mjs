import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as p from '../lib/protocol/index.mjs';
const golden=JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json',import.meta.url)));
const job=()=>structuredClone(golden.objects.job.envelope.payload);
const key=p.privateKeyFromSeed(Buffer.from(golden.keys[0].seed_hex,'hex'));
test('budget extension is signed and requires matching capability',()=>{
 const v=job();v.budget_v1={max_list_usd:5,effort:'high'};v.requirements.capabilities.push('budget_v1');
 assert.doesNotThrow(()=>p.signEnvelope('job',v,key));
 v.requirements.capabilities=v.requirements.capabilities.filter(x=>x!=='budget_v1');assert.throws(()=>p.signEnvelope('job',v,key));
});
test('closed budget fields reject provider window/account details and invalid effort',()=>{
 for(const patch of [{kappa:1},{account:'private'},{used_pct:30},{effort:'unrecognized'},{max_list_usd:0}]){
 const v=job();v.budget_v1={max_list_usd:5,...patch};v.requirements.capabilities.push('budget_v1');assert.throws(()=>p.signEnvelope('job',v,key));}
});
