import test from 'node:test';
import assert from 'node:assert/strict';
import {createUsageHostReader} from '../../lib/v1/usage-host-reader.mjs';

// Bounded existing authenticated-reader evidence, NOT OAuth enrollment support.
// The record and responses are synthetic; no real endpoint or native store is used.
function fixture(fetchImpl) {
  return createUsageHostReader({
    store:{credential:()=>{throw new Error('verification must not import a native credential');}},
    records:{codex:{parser:'codex',hosts:['fixture.invalid'],subscriptionKinds:['oauth'],
      usage:{url:'https://fixture.invalid/usage',headers:{},keep:{}}}},
    fetchImpl,now:()=>1000,timeoutMs:1000,
  });
}
const response = body => ({status:200,json:async()=>body});
const verify = (reader,accountKey,signal) => reader.verify({
  provider:'codex',accountKey,bearer:'synthetic-sentinel',kind:'oauth',signal,
});

test('existing authenticated reader: stable subject comes from account_id, not email or local account key', async () => {
  const replies=[
    {account_id:'subject-A',email:'first@example.invalid'},
    {account_id:'subject-A',email:'changed@example.invalid'},
    {account_id:'subject-B',email:'first@example.invalid'},
  ];
  let calls=0;
  const reader=fixture(async()=>response(replies[calls++]));
  const a=await verify(reader,'local-1');
  const same=await verify(reader,'local-2');
  const different=await verify(reader,'local-3');
  assert.equal(a.ok,true);assert.equal(same.ok,true);assert.equal(different.ok,true);
  assert.match(a.identity_sha256_16,/^[a-f0-9]{16}$/);
  assert.equal(a.identity_sha256_16,same.identity_sha256_16);
  assert.notEqual(a.identity_sha256_16,different.identity_sha256_16);
  assert.equal(calls,3);
  assert.equal(JSON.stringify([a,same,different]).includes('synthetic-sentinel'),false);
});

test('existing authenticated reader: successful HTTP and email alone do not verify a stable subject', async () => {
  const reader=fixture(async()=>response({email:'person@example.invalid'}));
  const result=await verify(reader,'local-1');
  assert.equal(result.ok,false);assert.equal(result.identity_sha256_16,null);
});

test('existing authenticated reader: cancellation before verification has zero transport effects', async () => {
  let calls=0;
  const reader=fixture(async()=>{calls++;return response({account_id:'subject-A'});});
  const controller=new AbortController();controller.abort();
  await assert.rejects(verify(reader,'local-1',controller.signal),error=>error.probe_failure==='cancelled');
  assert.equal(calls,0);
});

test('existing authenticated reader: cancellation during response prevents successful identity publication', async () => {
  let entered,release;
  const began=new Promise(resolve=>{entered=resolve;});
  const pending=new Promise(resolve=>{release=resolve;});
  const reader=fixture(async()=>{entered();return {status:200,json:()=>pending};});
  const controller=new AbortController();
  const work=verify(reader,'local-1',controller.signal);
  const rejected=assert.rejects(work,error=>error.probe_failure==='cancelled');
  try {
    await began;controller.abort();release({account_id:'subject-A'});
    await rejected;
  } finally {release({account_id:'subject-A'});await work.catch(()=>{});}
});
