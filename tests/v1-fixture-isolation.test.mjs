import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/v1-journey.mjs';

test('the coordinator fixture rejects stale app-port readers without poisoning its protocol assertions',async t=>{
  const f=await fixture(t);
  for(const path of ['/api/status','/api/events?after=0']) {
    const response=await fetch(f.origin+path);
    assert.equal(response.status,404);assert.equal((await response.json()).code,'not_found');
  }
  assert.deepEqual(f.failures,[]);
});

test('invalid coordinator traffic still fails the fixture assertion gate',async()=>{
  const cleanup=[];const f=await fixture({after:fn=>cleanup.push(fn)});
  const response=await fetch(f.origin+'/v1/not-circles');await response.arrayBuffer();
  assert.equal(response.status,400);assert.equal(f.failures.length,1);
  await assert.rejects(cleanup[0](),{code:'ERR_ASSERTION'});
});
