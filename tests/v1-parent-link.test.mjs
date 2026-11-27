import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import golden from '../docs/protocol/vectors/golden.json' with {type:'json'};
import * as p from '../lib/protocol/index.mjs';
const key=p.privateKeyFromSeed(Buffer.from(golden.keys[0].seed_hex,'hex'));
const parent={job_digest:'sha256:'+'a'.repeat(64),result_digest:'sha256:'+'b'.repeat(64)};
function job(value=parent,caps=['parent_link_v1']){const payload=structuredClone(golden.objects.job.envelope.payload);payload.parent=value;payload.requirements.capabilities=caps;return payload;}
test('the requester signs both parent job and parent result, and declares the capability',()=>{
 const signed=p.signEnvelope('job',job(),key);assert.deepEqual(signed.payload.parent,parent);assert.equal(p.verifyEnvelope('job',signed,p.exportPublicKey(key)).ok,true);
 const changed=structuredClone(signed);changed.payload.parent.job_digest='sha256:'+'c'.repeat(64);assert.equal(p.verifyEnvelope('job',changed,p.exportPublicKey(key)).ok,false);
});
test('parent references reject malformed ids, hidden fields, and capability mismatches',()=>{
 for(const value of [null,{}, {...parent,job_digest:'bad'},{...parent,extra:'x'}])assert.throws(()=>p.signEnvelope('job',job(value),key));
 assert.throws(()=>p.signEnvelope('job',job(parent,[]),key));const absent=job();delete absent.parent;assert.throws(()=>p.signEnvelope('job',absent,key));
});
