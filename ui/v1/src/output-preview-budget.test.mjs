import test from 'node:test';
import assert from 'node:assert/strict';
import {createOutputPreviewBudget, imageWithinPixelLimit,readPreviewBlob} from './output-preview-budget.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
};

test('page budget bounds concurrent loads and retained image bytes and count', async () => {
  const budget = createOutputPreviewBudget({bytes:12,maxImageBytes:6,count:2,concurrency:1,pixels:100});
  const first = deferred(), second = deferred();
  let running = 0, peak = 0;
  const load = gate => async () => { running++; peak = Math.max(peak,running); await gate.promise; running--; return new Blob(['123456']); };
  const one = budget.acquire(load(first));
  const two = budget.acquire(load(second));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(peak,1);
  first.resolve();
  const leaseOne = await one;
  const leaseTwoPromise = two;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(budget.snapshot(),{active:1,retainedCount:2,retainedBytes:6,inFlightBytes:6,waiting:0});
  leaseOne.release();
  second.resolve();
  const leaseTwo = await leaseTwoPromise;
  assert.ok(leaseTwo);
  assert.equal(peak,1);
  leaseTwo.release();
  assert.deepEqual(budget.snapshot(),{active:0,retainedCount:0,retainedBytes:0,inFlightBytes:0,waiting:0});
});

test('page budget reserves bytes before loading and queues until retained bytes are released', async () => {
  const budget = createOutputPreviewBudget({bytes:8,maxImageBytes:6,count:4,concurrency:3,pixels:100});
  const first = await budget.acquire(async () => new Blob(['123456']));
  const next = budget.acquire(async () => new Blob(['123']));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(budget.snapshot(),{active:0,retainedCount:1,retainedBytes:6,inFlightBytes:0,waiting:1});
  first.release();
  const second = await next;
  assert.ok(second);
  assert.equal(budget.snapshot().retainedBytes,3);
  second.release();
});

test('pixel validation rejects raster dimensions before browser decode', async () => {
  const png = Buffer.alloc(24);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
  png.write('IHDR',12,'ascii');
  png.writeUInt32BE(20,16); png.writeUInt32BE(20,20);
  assert.equal(await imageWithinPixelLimit(new Blob([png],{type:'image/png'}),399),false);
  assert.equal(await imageWithinPixelLimit(new Blob([png],{type:'image/png'}),400),true);
});


test('image bodies stop reading at the byte cap and SVG cannot bypass pixel budgets',async()=>{
 let cancelled=false;
 const response=new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(5));controller.enqueue(new Uint8Array(5));},cancel(){cancelled=true;}}),{headers:{'content-type':'image/png'}});
 assert.equal(await readPreviewBlob(response,6),null);assert.equal(cancelled,true);
 const small=await readPreviewBlob(new Response('abc',{headers:{'content-type':'image/png'}}),3);assert.equal(small.size,3);
 assert.equal(await imageWithinPixelLimit(new Blob(['<svg width="1" height="1"><filter/></svg>'],{type:'image/svg+xml'})),false);
});
