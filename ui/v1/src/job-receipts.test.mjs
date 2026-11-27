import test from 'node:test';
import assert from 'node:assert/strict';
import {knownJobReceipt,loadJobReceipt} from './job-receipts.mjs';
const job = {job_digest:'job',result_digest:'result',circle:{id:'circle'}};
test('list/detail receipt metadata is shared, bound to circle and result, and never downloads artifacts',async()=>{
 const paths=[], api={get:async path=>{paths.push(path);return {receipt:{candidate_format:'diff',diffstat:{files:0}}};}};
 assert.equal(knownJobReceipt(api,job),undefined);
 const receipt=await loadJobReceipt(api,job);
 assert.equal(knownJobReceipt(api,job),receipt);
 assert.equal(await loadJobReceipt(api,job),receipt);
 assert.deepEqual(paths,['jobs/job/receipt?circle=circle']);
 assert.equal(knownJobReceipt(api,{...job,result_digest:'new'}),undefined);
 assert.equal(knownJobReceipt(api,{...job,circle:{id:'other'}}),undefined);
 assert.equal(knownJobReceipt({get:api.get},job),undefined);
});
test('failed metadata fetches can be retried and the cache stays bounded',async()=>{
 let calls=0;const api={get:async()=>{if(++calls===1)throw Error('offline');return {receipt:{}};}};
 await assert.rejects(loadJobReceipt(api,job),/offline/);
 await loadJobReceipt(api,job);
 for(let i=0;i<50;i++)await loadJobReceipt(api,{...job,result_digest:String(i)});
 assert.equal(knownJobReceipt(api,job),undefined);
});
