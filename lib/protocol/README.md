# Pure Faravan v1 protocol core

Node >=22.13; only Node built-ins and statically imported adjacent JSON schemas.
No server, filesystem writes, network, browser, CLI, provider calls or persistence.
Key generation uses OS randomness in memory; fixed private seeds occur only in
explicit TEST-ONLY vector fixtures. Schema files are local imports, not fetched.

## Public API

Every exported function has a one-line contract in index.mjs or encoding.mjs.

- Encoding: canonicalize(value), strictParse(bytesOrText, {canonical=true}),
  digest(payload), digestBytes(Uint8Array), decodeBase64url(text, byteLength?).
  canonicalize emits RFC8785 JCS including finite fractional binary64 numbers.
  strictParse enforces the integer-only profile, duplicate rejection, UTF-8,
  Unicode, 262144-byte and depth-16 bounds. canonical:false permits pretty
  documentation input only; it must never be used to accept wire bytes.
- Keys: generateDeviceKeyPair(), generateRootKeyPair(), privateKeyFromSeed(seed),
  exportPublicKey(KeyObject), importPublicKey(rawBase64url), fingerprint(key).
  Generators return Node KeyObjects. Private seed import accepts 32 bytes or
  canonical base64url. Keys are canonical prime-order nonidentity Ed25519 points.
- Objects: signEnvelope(kind, payload, privateKey), verifyEnvelope(kind, envelope,
  publicKey). Kinds: job, result, roster, invite, cancellation, request.
  Receipts are unsigned inside Result; receipt signing is intentionally rejected.
  verifyEnvelope checks structure, numeric profile, digest/domain/signature and
  key binding. It does NOT authorize membership or trust caller-supplied roots.
- Requirements: validateRequirements(requirements, {recognizedCapabilities?}),
  canSatisfy(requirements, lenderCapabilities, {recognizedCapabilities?}).
  The default recognized vocabulary is patch-output, verify_v1 and results_v1. RESULT_KINDS and resultKind(job or result) give the result kind; an absent `result` means branch. Lender fields are
  harnesses, models, capabilities, egress, enforced_limits and max_limits.
  Outcomes are {ok:true,unmet:[]} or {ok:false,code,unmet:[...]} for matching.
  Advertisements are self-reports, not proof of backend enforcement.
- Binding predicates: checkAuthor(jobPayload, signerFingerprint),
  checkExecutor(resultPayload, signerFingerprint, attempt),
  checkCircle(payload, configuredCircle),
  checkJobDigest(resultPayload, independentlyRetainedDigest),
  checkAttempt(resultPayload, retainedAttempt).
- Rosters: createRoster({circle,epoch,members,issued_at,valid_until?}, rootKey),
  verifyRoster(envelope, {rootFingerprint,circle,now,highestAcceptedEpoch?,
  highestAcceptedDigest?}), checkRosterEpoch(payload, highestEpoch, sameEpochDigest?),
  findMember(verifiedRosterPayload, fingerprint).
  Creation defaults to 7 days; 30 days is the maximum. Clock is injected as a
  function returning integer Unix seconds. Expiry is exclusive; +60s issue skew
  is inclusive. Same-epoch acceptance requires the previously accepted digest.
- Invites: createInvite({circle,coordinator,invite_id,invite_public_key,created_at,
  expires_at}, rootKey), verifyInvite(envelope, {rootFingerprint,circle,
  coordinator,now}), encodeInviteLink(envelope, privateSeed), decodeInviteLink(url).
  decodeInviteLink validates encoding and self-signature/key binding, not trust,
  expiry or authority. Pins must arrive independently through a trusted channel.
- Short invites: generateInviteCode(), createInviteBinding(envelope, inviteKeyOrSeed),
  verifyInviteBinding(envelope, binding, {invitePublicKey}), encodeShortLink({coordinator,code,seed}),
  decodeShortLink(url), inviteLinkFromPublication({envelope,invite_binding}, {coordinator,seed}).
  The binding is the invite key's signature over the whole envelope (domain
  faravan/invite-binding/v1). The caller passes a public key it rebuilt from the
  link seed, never one read from the envelope; inviteLinkFromPublication does that
  check, then returns the equivalent long link. Nothing in a fetched envelope,
  including the root fingerprint, is trusted before the binding verifies.
- Enrollment: createEnrollmentProof({circle,invite_id,device_public_key,device_name?,person_name?}, inviteKey),
  verifyEnrollmentProof(proof, {invitePublicKey,circle,invite_id,device_public_key}).
  The owner supplies its independently registered invite key/context. One-time
  consumption and next-roster publication are outside this library.
- Requests: buildRequestProof(fields, privateKey), async verifyRequestProof(header,
  {publicKey,expected,now,consumeNonce}). Fields contain exact method, target,
  body_digest/content_length or raw body, content_type, artifact_media_type,
  circle, roster_epoch, created, nonce and idempotency_key. No nonce/clock is
  silently generated. expected requires ALL request routing/body fields plus
  independently authenticated key_id and roster_epoch; it omits schema,
  created and nonce. Target escaping/query order are preserved.

## Mandatory caller obligations

Verify a root-signed current roster against an independently pinned root and
circle, durably fence rollback/conflicting epochs, and look up membership before
using a device key for operational verification. Retain independently expected
job/attempt IDs; a server response must not supply the only expectation.

The caller must atomically consume (key_id, nonce). consumeNonce(keyId, nonce,
retainUntilUnixSeconds) returns true only on first acceptance, and retains until
at least receipt time +361 seconds. It is called AFTER signature/context/time
checks; exceptions fail closed as nonce_store_failure. Async callbacks are
supported. The core does not store nonces or perform transactions.

For artifact uploads, pass trusted declared metadata for early proof checking,
then independently stream/hash/count and compare before committing. Never claim
proof verification established actual body integrity if only declared metadata
was supplied. JSON raw bodies passed to buildRequestProof are strictly parsed.

Verification returns {ok:true,...} or {ok:false,code}; encoding/signing can throw
ProtocolError with stable code. Predicates use explicit author_mismatch,
executor_mismatch, wrong_circle, wrong_job_digest and stale_attempt. Structural
errors use invalid_request; unsupported kinds/vocabularies fail closed.
There is no receipt truth, scheduling consensus or execution-conformance claim.

## Checks and fixtures

The registered default check runs the existing hermetic suite and protocol-core
tests. The registered protocol check validates schema/examples/OpenAPI only.
Golden files under docs/protocol/vectors are immutable expected byte strings
recomputed in tests, including negative cases. Passing either check is not
independent implementation interoperability or production readiness.

A member’s optional `person_name` is separate from `device_name`. Enrollment binds it to the joining key, and the owner approves it in the signed roster. It is a display claim, not proof of identity.
