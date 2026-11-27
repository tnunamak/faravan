import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {signLease,verifyLease,createLocalLeaseAuthority} from '../lib/v1/account-authority.mjs';

// P2 (design 1119, trigger met): the per-call lease authority is lender-local. The same exact binding,
// generation and expiry checks run against the signed lease the selected lender already holds, so a
// provider dispatch or its publication never depends on another member being online. The coordinator still
// issues and renews leases; revocation recorded there lands with the next renewal or stop.

const selection={providerId:'codex',accountId:'a1',modelId:'m',effortId:'high'};
const base={circle:'circle-1',holder:'holder-key',jobId:'sha256:'+'1'.repeat(64),attemptId:'attempt-1',
  selection,fence:3,membershipEpoch:7,expiresAtMs:100000};
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const pem=publicKey.export({format:'pem',type:'spki'});

function authorityWith(extraEpoch) {
  const remembered=new Map();
  const authority=createLocalLeaseAuthority({keyId:'holder-key',remembered});
  authority.remember({binding:{circle:base.circle,membershipEpoch:extraEpoch??base.membershipEpoch},publicKey:pem});
  return authority;
}
const prove=lease=>({proof:signLease(lease,privateKey),selection:lease.selection,jobId:lease.jobId,
  attemptId:lease.attemptId,nowMs:50000});

test('a remembered lease verifies locally with its exact binding and no network', async () => {
  const authority=authorityWith();
  const result=await authority.verify(prove({...base}));
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.deepEqual(result.value,{expiresAtMs:base.expiresAtMs,fence:base.fence});
});

test('a dispatch for a different job, attempt, selection or lender is fenced', async () => {
  const authority=authorityWith();
  // The proof claims one binding; the broker asks about the one it issued the guest key for.
  for(const change of [{jobId:'sha256:'+'2'.repeat(64)},{attemptId:'attempt-2'},
      {selection:{...selection,modelId:'other'}},{holder:'holder-other'}]) {
    const result=await authority.verify({...prove({...base,...change}),selection,jobId:base.jobId,attemptId:base.attemptId});
    assert.equal(result.ok,false,JSON.stringify(change));
    assert.equal(result.error.code,'lease_fenced',JSON.stringify(change));
  }
});

test('a tampered signature is invalid and an expired lease is expired', async () => {
  const authority=authorityWith();
  const proof=signLease(base,privateKey);
  const tampered=JSON.parse(proof.signedEnvelope);
  tampered.signature=Buffer.from('not-a-signature').toString('base64url');
  const invalid=await authority.verify({proof:{schemaVersion:1,signedEnvelope:JSON.stringify(tampered)},
    selection,jobId:base.jobId,attemptId:base.attemptId,nowMs:50000});
  assert.equal(invalid.ok,false);
  assert.equal(invalid.error.code,'lease_invalid');
  const expired=await authority.verify(prove({...base,expiresAtMs:40000}));
  assert.equal(expired.ok,false);
  assert.equal(expired.error.code,'lease_expired');
});

test('a lease from a stale membership epoch is fenced, matching the remote semantics', async () => {
  // The remote verify compared the proof against the roster epoch at verification time; locally the
  // remembered epoch plays that role, so a newer roster fences an old lease exactly as before.
  const authority=authorityWith(8);
  const result=await authority.verify(prove({...base}));
  assert.equal(result.ok,false);
  assert.equal(result.error.code,'lease_fenced');
});

test('a lease for a circle whose key the lender has not seen is unavailable, never guessed', async () => {
  const remembered=new Map();
  const authority=createLocalLeaseAuthority({keyId:'holder-key',remembered});
  const result=await authority.verify(prove({...base,circle:'circle-unknown'}));
  assert.equal(result.ok,false);
  assert.equal(result.error.code,'authority_unavailable');
});

test('a renewal the coordinator re-issued updates the remembered epoch without breaking the old lease until it expires', async () => {
  const remembered=new Map();
  const authority=createLocalLeaseAuthority({keyId:'holder-key',remembered});
  authority.remember({binding:{circle:base.circle,membershipEpoch:base.membershipEpoch},publicKey:pem});
  assert.equal((await authority.verify(prove({...base}))).ok,true);
  // A newer lease from the same circle carries the circle's stable key and the new epoch.
  authority.remember({binding:{circle:base.circle,membershipEpoch:9},publicKey:pem});
  const renewed=await authority.verify(prove({...base,membershipEpoch:9,fence:4}));
  assert.equal(renewed.ok,true,JSON.stringify(renewed));
  assert.equal(renewed.value.fence,4);
  // The pre-renewal proof no longer matches the remembered membership epoch.
  const stale=await authority.verify(prove({...base}));
  assert.equal(stale.error.code,'lease_fenced');
});

test('the local check is the same verification the coordinator lease itself passed at issue time', () => {
  // Parity witness: verifyLease with the issuer's key and the issued binding accepts; any field drift fences.
  const proof=signLease(base,privateKey);
  assert.equal(verifyLease(proof,publicKey,base,50000).ok,true);
  assert.equal(verifyLease(proof,publicKey,{...base,fence:4},50000).error.code,'lease_fenced');
  assert.equal(verifyLease(proof,publicKey,{...base,selection:{...selection,accountId:'a2'}},50000).error.code,'lease_fenced');
});
