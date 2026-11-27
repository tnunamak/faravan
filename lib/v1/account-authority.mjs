import {sign,verify} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {canonicalize} from '../protocol/index.mjs';
import {ok,fault} from './accounts.mjs';

// Integration-owned domain: these are coordinator leases, not signed jobs or
// caller-supplied expiration hints. The client obtains the signer from the
// configured coordinator transport and reconciles durable authority every use.
const bytes=payload=>Buffer.from('faravan.account-lease.v1\0'+canonicalize(payload));
export function signLease(payload,privateKey) {
  return {schemaVersion:1,signedEnvelope:JSON.stringify({payload,
    signature:sign(null,bytes(payload),privateKey).toString('base64url')})};
}
export function verifyLease(proof,publicKey,current,nowMs) {
  try {
    if(proof?.schemaVersion!==1||typeof proof.signedEnvelope!=='string'||proof.signedEnvelope.length>16384)
      return fault('lease_invalid');
    const {payload,signature}=JSON.parse(proof.signedEnvelope);
    if(!verify(null,bytes(payload),publicKey,Buffer.from(signature,'base64url')))return fault('lease_invalid');
    for(const key of ['circle','holder','jobId','attemptId','selection','fence','membershipEpoch'])
      if(!isDeepStrictEqual(payload[key],current[key]))return fault('lease_fenced');
    if(!Number.isSafeInteger(payload.fence)||payload.fence<1||
      !Number.isSafeInteger(payload.expiresAtMs)||payload.expiresAtMs>current.expiresAtMs||payload.expiresAtMs<=nowMs)
      return fault('lease_expired');
    return ok({expiresAtMs:payload.expiresAtMs,fence:payload.fence});
  }catch{return fault('lease_invalid');}
}

/** The broker's per-call authority, answered from the signed lease the selected lender already holds (P2:
 * a provider dispatch or its publication must not depend on another member being online — the measured
 * I1 dependency). The coordinator still issues the lease at claim time and renews it; `remembered(circle)`
 * is the verifying key and membership epoch from the lender's most recent lease, and `keyId` pins the
 * holder. Verification keeps its exact binding, generation and expiry; the broker's own key state fences
 * older generations, and remote revocation lands with the next renewal or stop, bounded by the lease. */
export function createLocalLeaseAuthority({keyId,remembered,now=Date.now}={}) {
  const authority = {
    remember(lease) {
      const circle = lease?.binding?.circle, publicKey = lease?.publicKey;
      if (typeof circle !== 'string' || !circle || typeof publicKey !== 'string' || !publicKey) return;
      remembered.set(circle, {publicKey, membershipEpoch: lease.binding.membershipEpoch});
    },
    async verify({proof,selection,jobId,attemptId,nowMs}) {
      let payload;
      try { payload = JSON.parse(proof?.signedEnvelope ?? '{}').payload; }
      catch { return fault('lease_invalid'); }
      const circle = typeof payload?.circle === 'string' ? payload.circle : null;
      const entry = circle !== null ? remembered.get(circle) : null;
      if (!entry) return fault('authority_unavailable');
      return verifyLease(proof, entry.publicKey,
        {circle, holder: typeof keyId === 'function' ? keyId() : keyId, jobId, attemptId, selection,
          fence: payload.fence, membershipEpoch: entry.membershipEpoch, expiresAtMs: payload.expiresAtMs},
        Number.isSafeInteger(nowMs) ? nowMs : now());
    },
  };
  return authority;
}
