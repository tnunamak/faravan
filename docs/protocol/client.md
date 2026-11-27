# Faravan v1 JavaScript client

Import createClient and ClientError from lib/v1/client.mjs. The client is a
transport and verification library, not a runner. It never executes or extracts
downloaded artifacts and never makes provider/model calls.

## Configuration and durable state

createClient takes origin (HTTPS, or literal loopback HTTP), circle, deviceKey
(an Ed25519 private KeyObject or {privateKey}), pinnedRootFingerprint, and
rosterCache. Optional lanMode defaults to false. Set it true only from a verified signed LAN invite or local signed provisioning. In LAN mode, origin must be private IPv4, .local or link-local HTTP (or HTTPS); signed roster, invite and request mode/origin must agree. Clients never infer LAN permission from an address. Optional fetch implements the standard fetch/Response streaming
interface. clock() returns integer Unix seconds. random(n) returns exactly n
cryptographically random bytes; use deterministic sources only in tests.
logger.debug receives only retry code/status/attempt, never bodies, keys or URLs.

rosterCache.get() returns a snapshot; rosterCache.set(snapshot) atomically
persists one. Both may return promises. Snapshot shape:

- current: the current signed Roster envelope, or null
- history: separately retained signed Roster envelopes for historical verification
- highestAcceptedEpoch: remembered highest epoch, initially 0
- highestAcceptedDigest: payload digest at that epoch, absent initially

Use a separate cache for each root/circle, and serialize access across client
instances/processes. This client serializes replacements within one instance,
but cannot implement a caller's cross-process durable transaction. Never erase
anti-rollback state to recover from a network error. Cached signatures/root/circle
and signed transport bindings are verified on load. Current authorization additionally requires an unexpired
roster containing this device. Historical rosters authorize verification only.

The client persists roster state only. Callers must persist job/attempt intent,
signed payloads and explicit idempotency keys before transmission, and reuse
those exact inputs to reconcile unknown outcomes/restarts. Omitting a key creates
a new operation key, suitable only for new operations. A ClientError on an HTTP
mutation carries operationKey when available; do not turn a timeout into a new
job or claim intent.

## API

All network methods accept an optional options object with signal. All POST
methods also accept idempotencyKey. submitJob signs its supplied full Job payload
and resolves {jobDigest, operationKey} after the original publish acknowledgement;
it never waits for execution. The payload must already contain author, intent,
timestamps and the currently accepted roster_epoch.

- uploadArtifact(bytes, mediaType, options) returns an ArtifactRef.
- getJob(jobDigest, options) returns a signature-verified JobView.
- listJobs({limit=50, cursor, signal}) is an async iterator yielding JobViews. It sends
  `Faravan-Client-Capabilities: results_v1`; without it the coordinator omits typed-result
  and source-none jobs (see Job list negotiation in v1.md).
  Limit is 1–100; cursors are opaque. Repeated cursors fail rather than loop.
- waitForJob(jobDigest, {signal, timeoutMs=300000, pollMs=1000}) returns a terminal
  JobView, or throws on timeout/abort. Terminal includes cancellation/failure.
- cancelJob(jobDigest, {reason='cancelled', signal, idempotencyKey}) returns the
  validated cancellation acknowledgement. Authority revocation does not prove
  computation stopped.
- fetchResult(jobDigest, {attempt, signal}) returns candidate Buffer only after
  verifying the signed Result and both candidate and transcript bytes.
  With includeMetadata:true it returns {bytes,candidate}, retaining the verified
  candidate ArtifactRef so extraction uses its signed media type, plus the signed
  `output` ({kind: message|files}) for a typed job. fetchReceipt returns `output` too.
  Both refuse `result_kind_mismatch` before any download when resultKind(output) differs
  from resultKind(job). submitJob refuses a job with `result` (`host_too_old`) when the
  host does not list `results_v1`.
- fetchTranscript(jobDigest, {attempt, signal}) returns verified transcript Buffer.
- claimNext(advertisement, {leaseSeconds=120, waitSeconds=30, signal,
  idempotencyKey}) returns Claim or null. It reconciles the returned attempt by
  GET before returning, since a replayed claim may have expired.
- declineJob(jobDigest, {signal, idempotencyKey}) requires host capability `offer_decline_v1`. It posts `{}` to `/jobs/{digest}/decline` and verifies `{job_digest,declined:boolean}`. A true result records or confirms a refusal that survives host restart and excludes only this device from offers and claims. A false result means the job is no longer queued and this device has no recorded refusal. Neither result claims or cancels the job.
- Job reads advertise `decline_count_v1` to receive an anonymous `declined_count`; older hosts may omit it. A decline of a job that is no longer queued is acknowledged without recording a refusal. The host prunes refusals for departed roster members when another device declines, so a rejoining member may see that job again.
- renew(attempt, {leaseSeconds=120, signal, idempotencyKey}), release(attempt,
  reason='released', options), and fail(attempt, reason, options) return Attempt.
- uploadResultArtifacts({candidate, transcript, candidateMediaType='text/x-diff',
  transcriptMediaType='application/x-ndjson'}, options) returns the two references.
- completeAttempt(attempt, fullResultPayload, options) signs and submits Result.
  The exact retained completion acknowledgement is successful even for a retry
  after the original attempt became terminal.
- enroll(inviteLink, options), getEnrollment(enrollmentId, options), and
  refreshRoster(options) perform root-pinned membership operations. The invite
  seed remains local; enrollment transmits only public invite/device/proofs.

Attempt arguments are complete OpenAPI Attempt objects. Result verification gets
the accepted JobView before Result and checks digest, generation, attempt ID and
holder. The caller must also supply the attempt it retained independently of the
result response (`attempt_required` otherwise), and the two must agree. The server can still lie about scheduling; signatures are not
coordinator-independent consensus or evidence of quality.

## Wire clarifications and bounds

The v1 wire specification only defines long polling for claim-next. waitForJob
therefore performs bounded, abortable GET polling without inventing query fields.
claimNext uses the specified 0–30-second long poll and a fresh key for each new
poll intent; transport retries of that intent retain its original key/body.

There is no HEAD or artifact metadata endpoint. uploadArtifact probes via a
proof-authenticated GET capped at the exact proposed byte length, verifies
length/hash, and skips PUT when bytes exist. GET does not expose stored declared
media type; deduplication therefore establishes byte identity only. Callers must
use the same media type for a digest. Missing blobs (404) trigger PUT; other
failures do not imply absence. A race with garbage collection can still make
later submission report artifact_missing; caller must reconcile/reupload.

Response JSON is capped at 262144 bytes and parsed with protocol strict UTF-8,
canonical JSON and depth/numeric checks. Artifact responses are streamed into a
bounded buffer; the public bytes API is deliberately capped by maxArtifactBytes
(default 16 MiB, configurable up to wire 1 GiB) and maxTranscriptBytes (default
4 MiB, no greater than artifact cap). Content-Length excess rejects before read;
incremental limits reject chunked excess. Buffers are not extracted or rendered.

Transport retries cover only network/read failures, 429 and 5xx, never ordinary
4xx, redirects, bad signatures or malformed success responses. Each retry signs
a fresh nonce/time with the exact original key/body. Defaults are four attempts,
100 ms exponential backoff, jitter and a 5000 ms backoff cap; integer Retry-After
(and HTTP-date defensively) is a minimum delay, not truncated by the cap.
retry.{maxAttempts,baseMs,capMs} and abortable sleep(ms,signal) support hermetic
tests. Retry-After beyond the platform timer range is surfaced as the original
retryable error so a caller can schedule it without an early retry.
Redirects are rejected and never receive forwarded proof or enrollment material.

ClientError exposes code, status (0 for local/transport failures), retryable,
problem (bounded parsed problem+json or null), outcome and optional operationKey.
Caller abort reasons are preserved. A network failure has outcome unknown.
