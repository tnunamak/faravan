# Golden protocol-core vectors

WARNING: ALL PRIVATE KEYS HERE ARE SYNTHETIC, PUBLIC, TEST-ONLY MATERIAL.
The four Ed25519 seeds are 32 repeated bytes of 01, 02, 03 and 04.
They belong to no user, account or circle and must never be used for real enrollment.

- golden.json: fixed seeds/raw public keys/fingerprints; job, result, roster,
  invite, cancellation, request and enrollment envelopes; exact payload and
  envelope JCS; payload SHA256 digests; fragment-only invite link; request header;
  the invite binding for the golden invite (digest of the whole envelope, signed
  by the invite key in domain faravan/invite-binding/v1) and its short link.
  Receipt is unsigned, embedded in Result, and has its own JCS/digest vector.
- jcs.json: UTF-16 property sorting, literal Unicode/escaping, nested values and
  RFC8785 binary64 serialization. Fractional/large-number JCS vectors are NOT
  valid integer-only protocol bodies.
- negative.json: named deterministic mutations of golden.json, plus malformed
  wire input. Every entry names a test operation and expected stable failure code.

tests/protocol-core.test.mjs reconstructs each positive envelope from its fixed
seed and compares the complete canonical bytes/signature/digest, compares the
link and header byte-for-byte, and executes every negative fixture. It also
constructs signature inputs independently using node:crypto and checks an
RFC8032 primitive vector. Tests never rewrite fixtures or call a network service.
A deliberate protocol change must update reviewed fixtures explicitly; do not
replace expectations with values computed during the same assertion.

The /join URL contains TEST-ONLY private material in its fragment, never its
query/path/public Invite. Application code must not log it and must erase browser
history after consuming a real link. Creating/decoding this fixture does not
enroll anything.

These fixtures establish regression coverage, not independent-implementation
interoperability. ArtifactRef hashes/counts are illustrative, not blob fixtures.
They prove neither model use, runtime policy, HTTP behavior, persistence,
transactional one-time enrollment/nonce handling, nor server conformance.

The full rename command runs scripts/rename/regenerate-vectors.mjs to rebuild the TEST-ONLY vectors from their unsigned payloads and repository test keys. A person must review the resulting vector and worked-example diff before committing.
