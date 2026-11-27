import test from 'node:test';
import assert from 'node:assert/strict';
import {runJob} from '../../lib/executor.mjs';

// prepare always throws before any handle, command, filesystem or native backend exists.
function boundary() {
 const stop=new Error('synthetic preparation boundary'),seen=[],calls={admit:0,probe:0,start:0,destroy:0};
 const backend={
  async admitJob(){calls.admit++;return {ok:true};},
  async probeCapabilities(){calls.probe++;return {available:true};},
  async prepare(spec,options){seen.push({spec,options});throw stop;},
  async start(){calls.start++;throw new Error('must never launch');},
  async destroy(){calls.destroy++;throw new Error('no handle exists');},
 };
 return {backend,stop,seen,calls};
}
const guest=()=>({job_id:'guest-job',entrypoint:['fixture-never-executed'],preparationContext:{jobId:'forged-job',attemptId:'forged-attempt',generation:999}});
test('host context stays separate from the guest and preserves signal and budget callback',async()=>{
 const b=boundary(),jobSpec=guest(),before=structuredClone(jobSpec),controller=new AbortController(),wallRemainingMs=()=>1000;
 const preparationContext=Object.freeze({jobId:'accepted-job',attemptId:'accepted-attempt',generation:7});
 await assert.rejects(runJob({jobSpec,preparationContext,signal:controller.signal,wallRemainingMs,backend:b.backend}),error=>error===b.stop);
 assert.equal(b.seen.length,1);assert.equal(b.seen[0].spec,jobSpec);assert.deepEqual(jobSpec,before);
 assert.deepEqual(b.seen[0].options,{signal:controller.signal,wallRemainingMs,separatePreparationClock:true,preparationContext});
 assert.equal(b.seen[0].options.preparationContext,preparationContext);
 assert.ok(Object.isFrozen(b.seen[0].options.preparationContext));
 assert.equal(b.calls.start,0);assert.equal(b.calls.destroy,0);
});
test('legacy caller and forged guest claim do not create host context',async()=>{
 const b=boundary(),jobSpec=guest(),before=structuredClone(jobSpec);
 await assert.rejects(runJob({jobSpec,backend:b.backend}),error=>error===b.stop);
 assert.deepEqual(b.seen[0].options,{signal:undefined,wallRemainingMs:undefined,separatePreparationClock:true});
 assert.ok(!Object.hasOwn(b.seen[0].options,'preparationContext'));
 assert.deepEqual(jobSpec,before);assert.equal(b.calls.start,0);
});
test('pre-aborted call has zero admission, preparation and launch',async()=>{
 const b=boundary(),controller=new AbortController(),reason=new Error('stop before preparation');controller.abort(reason);
 await assert.rejects(runJob({jobSpec:guest(),preparationContext:Object.freeze({jobId:'job',attemptId:'attempt',generation:1}),
  signal:controller.signal,backend:b.backend}),error=>error===reason);
 assert.deepEqual(b.seen,[]);assert.deepEqual(b.calls,{admit:0,probe:0,start:0,destroy:0});
});
