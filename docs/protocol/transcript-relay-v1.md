# Live transcript relay (`transcript_relay_v1`)

This optional channel carries the lender's already-redacted NDJSON snapshot while
an attempt runs. The host stores the latest snapshot per job/attempt. It does not
append transcript history. The final signed result and its transcript artifact
remain separate.

All paths below are relative to `/v1/circles/<circle_uuid>`. Requests use the
normal request proof, canonical JSON, membership, nonce and POST idempotency rules.
The host advertises `transcript_relay_v1` in `GET /capabilities`. Both client
methods check that capability before requesting the relay path; absence raises
`ClientError` with code `host_too_old`.

## Upload

`POST /jobs/<64 lowercase hex digest characters>/transcript`

The exact request body is:

```json
{"attempt":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","seq":1,"text":"{\"type\":\"text\",\"text\":\"Checked parser\"}\n","truncated":false}
```

- `attempt`: lowercase UUID of the current attempt.
- `seq`: positive safe integer, strictly greater than its last accepted sequence.
  Gaps are allowed. Count limits count accepted uploads, not sequence values.
- `text`: already-redacted NDJSON snapshot as a string, at most 65,536 UTF-8 bytes.
  The relay treats it as opaque text; the reporter owns projection and redaction.
- `truncated`: required boolean, supplied by the reporter.

Only the attempt holder can upload. The attempt must be current, active, started,
and have an unexpired lease on a nonterminal job. The job's audience gate also
applies. The author can upload only when also the holder. Unrelated members,
including circle owners/admins, cannot upload or read relay content.

Successful POST returns status 200 and exactly:

```json
{"job_digest":"sha256:<64 lowercase hex>","attempt":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","seq":1,"at":"2026-10-20T18:00:00Z"}
```

`at` is the host's upload timestamp (UTC, whole seconds). Only this small
acknowledgement enters idempotency storage. Repeating the same idempotency key and
body returns the acknowledgement without charging another update.

Uploads must be at least two host-clock seconds apart. Each attempt can accept
at most 2,048 uploads. Sequence, count, rate, quotas and snapshot replacement are
checked in the same SQLite transaction. Failed writes do not advance them.

The canonical JSON body cannot exceed 262,144 bytes, or the host's smaller JSON
body limit. Escaping can make it larger than `text`'s UTF-8 size. The host also
requires the resulting GET response to fit that JSON response limit before
accepting an upload.

## Read

`GET /jobs/<64 lowercase hex digest characters>/transcript`

There are no query parameters. Reads select only the current attempt. Only the
job author and that attempt's holder can read it; being a previous holder grants
no access to the current attempt. Frozen audience and current membership gates
apply. Other members receive `not_found`, as for an unknown job.

The exact response is:

```json
{"job_digest":"sha256:<64 lowercase hex>","attempt":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","seq":1,"at":"2026-10-20T18:00:00Z","text":"{\"type\":\"text\",\"text\":\"Checked parser\"}\n","truncated":false,"available":true}
```

Before the first upload, or after snapshot retention removes it, `seq` is 0,
`at` is null, `text` is empty, and `truncated` is false. `attempt` is the current
attempt UUID, or null when no attempt exists.

`available` is true if a retained snapshot exists, including an empty uploaded
snapshot. Without a snapshot it is true only when the current holder's latest
heartbeat is less than 90 seconds old and advertises `transcript_relay_v1`.
Thus `available:true` with `seq:0` means a capable lender has not uploaded yet;
`available:false` means the host has no current evidence that the holder supports
the relay. No attempt means `available:false`. A retained snapshot stays readable
after the attempt ends or its heartbeat becomes stale.

## Storage and errors

Default relay quotas are 16 MiB per circle and 4 MiB per uploading device,
configured as store quota keys `transcriptCircleBytes` and
`transcriptDeviceBytes`. These are separate from artifact quotas and count the
canonical serialized snapshot, including its metadata and JSON escaping.
Replacement charges only the byte difference. Empty uploads still consume a
small amount of storage. Normal daily mutation/idempotency budgets also apply.
The endpoint uses the existing global request and authenticated member JSON body
admission pools; it has no bypass or reserved service pool.

Snapshots expire 24 hours after their last upload, with cleanup on the next store
request. Job deletion and terminal job retention delete all its relay snapshots
and per-attempt counters. Snapshot expiry alone keeps sequence/rate/count
metadata until job deletion so expiry cannot reset the attempt's upload budget.
No expired snapshot text is returned or copied into a final result.

Errors follow the existing problem response schema: `invalid_request` (400),
`forbidden` (403, a permitted reader who is not the writer), `not_found` (404),
`stale_attempt` / `lease_expired` / `job_terminal` / `job_expired` (409 or 410,
as in existing attempt operations), `payload_too_large` (413), and
`rate_limited` / `quota_exceeded` (429). Existing authentication, roster and
idempotency errors also apply.

## Client methods

```js
await client.postLiveTranscript(attempt, {
  seq: 1, text: redactedSnapshot, truncated: false,
  signal, idempotencyKey,
}); // {job_digest, attempt, seq, at}

await client.fetchLiveTranscript(jobDigest, {signal});
// {job_digest, attempt, seq, at, text, truncated, available}
```

The client checks exact response fields, digest/attempt/sequence binding,
timestamps, booleans, snapshot byte limits, and consistency of empty responses.

## Lender presentation boundary

The lender applies its private-workspace normalization before building relay
snapshots. The reporter projects known Claude/Codex activity events and uses the
trust scanner’s environment classification and credential rules on their text.
Account/session records, original provider correlation IDs, home paths, emails,
file edit bodies, raw tool results and command output stay on the lending
computer. Tool completion and error status can still travel without their bodies.
Only simple check invocations such as `npm test` receive a command label;
arbitrary shell commands can contain file contents or identity, so their details
stay local. Agent prose remains untrusted and is checked before clipping.

Each reporter retains at most 64 KiB of complete presentation records, plus a
bounded unfinished line for each output stream. It coalesces uploads to at most
one every five seconds, with one request in flight and one pending snapshot.
Relay failures do not change the signed result or its final transcript artifact.
