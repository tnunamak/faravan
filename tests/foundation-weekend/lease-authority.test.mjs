import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {createClient} from '../../lib/v1/client.mjs';

// Conservative assumption: the existing legacy attempt API is NOT a signed
// account-bound LeaseAuthority. These tests preserve refusal before transport,
// not issue/renew/dispatch authority, membership or durable fence qualification.
function fixture() {
  let requests = 0;
  const {privateKey} = generateKeyPairSync('ed25519'); // disposable synthetic key, never persisted
  const client = createClient({
    origin:'https://coordinator.invalid',
    circle:'00000000-0000-4000-8000-000000000001',
    deviceKey:privateKey,
    pinnedRootFingerprint:'sha256:'+'1'.repeat(64),
    rosterCache:{get:async()=>null,set:async()=>assert.fail('refusal must not write a roster')},
    fetch:async()=>{requests++;assert.fail('refusal must precede transport');},
    clock:()=>2000000000,
  });
  const attempt = {
    attempt_id:'00000000-0000-4000-8000-000000000002',
    job_digest:'sha256:'+'2'.repeat(64),
    generation:1,
    holder:'sha256:'+'3'.repeat(64),
    state:'active',
    claimed_at:'2033-05-18T03:30:00Z',
    lease_expires_at:'2033-05-18T03:35:00Z',
    execution_started_at:null,
    reason:null,
    compute_stopped:false,
    stopped_at:null,
  };
  return {client,attempt,get requests(){return requests;}};
}
for (const field of ['accountId','selection','signedEnvelope']) {
  test('conservative legacy boundary: caller-added '+field+' is not lease authority',async()=>{
    const f=fixture();
    const input={...f.attempt,[field]:'caller-assertion'};
    for (const action of [
      ()=>f.client.renew(input),
      ()=>f.client.release(input,'released'),
    ]) {
      await assert.rejects(action,error=>error.code==='invalid_response');
    }
    assert.equal(f.requests,0);
  });
}
test('conservative legacy boundary: a different holder cannot renew or release an attempt',async()=>{
  const f=fixture();
  await assert.rejects(()=>f.client.renew(f.attempt),error=>error.code==='executor_mismatch');
  await assert.rejects(()=>f.client.release(f.attempt,'released'),error=>error.code==='executor_mismatch');
  assert.equal(f.requests,0);
});
test('conservative legacy boundary: invalid generation is rejected before transport',async()=>{
  const f=fixture();
  for (const generation of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1]) {
    await assert.rejects(()=>f.client.renew({...f.attempt,generation}),error=>error.code==='invalid_request');
  }
  assert.equal(f.requests,0);
});
test('conservative legacy boundary: malformed caller lease expiry is never accepted',async()=>{
  const f=fixture();
  for (const lease_expires_at of ['2033-13-01T00:00:00Z','forever',2000000300000]) {
    await assert.rejects(()=>f.client.renew({...f.attempt,lease_expires_at}),error=>error.code==='invalid_response');
  }
  assert.equal(f.requests,0);
});
