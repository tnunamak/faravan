import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as p from '../lib/protocol/index.mjs';
const vectors=JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json',import.meta.url)));
const key=p.privateKeyFromSeed(Buffer.from(vectors.keys[0].seed_hex,'hex'));
test('signed working directory requires its capability and rejects traversal',()=>{
 const job=structuredClone(vectors.objects.job.envelope.payload);job.working_directory='packages/app';job.requirements.capabilities.push('working_directory_v1');
 assert.doesNotThrow(()=>p.signEnvelope('job',job,key));
 assert.equal(p.validateRequirements(job.requirements,{recognizedCapabilities:['patch-output','verify_v1']}).ok,false,'older lender fails closed');
 job.working_directory='../escape';assert.throws(()=>p.signEnvelope('job',job,key));
 job.working_directory='packages/app';job.requirements.capabilities=job.requirements.capabilities.filter(c=>c!=='working_directory_v1');assert.throws(()=>p.signEnvelope('job',job,key));
});

test('filtered pinned snapshots require updated lenders while legacy Git jobs remain valid',()=>{
 const job=structuredClone(vectors.objects.job.envelope.payload);
 job.source={kind:'git',url:'https://example.test/source',commit:'a'.repeat(40),object_format:'sha1'};
 assert.doesNotThrow(()=>p.signEnvelope('job',job,key),'legacy source remains valid');
 job.requirements.capabilities.push('filtered_git_v1');
 assert.doesNotThrow(()=>p.signEnvelope('job',job,key));
 assert.equal(p.validateRequirements(job.requirements,{recognizedCapabilities:['patch-output','verify_v1','results_v1']}).ok,false,'an older lender cannot accept the new send');
 job.source={kind:'none'};job.result={kind:'message'};job.requirements.capabilities.push('results_v1');
 assert.throws(()=>p.signEnvelope('job',job,key),'a filtered Git promise cannot be attached to a different source');
});
