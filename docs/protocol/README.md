# Protocol

This directory specifies Faravan v1. A protocol requirement is not proof
that a particular runtime or sandbox enforces it; see the recorded evidence
and remaining limitations in [STATUS](../STATUS.md).

- [v1 normative specification](v1.md): identity, signatures, lifecycle, HTTP,
  idempotency, policy, artifacts, cancellation, worked examples and open questions.
- [OpenAPI 3.1 API](openapi.yaml): JSON syntax, which is valid YAML 1.2, with
  self-contained component schemas mirroring the adjacent files. RequestProof
  and other control schemas are inline.
- [Job schema](job.schema.json): signed immutable job and shared definitions.
- [Result schema](result.schema.json): signed job/attempt-bound result.
- [Receipt schema](receipt.schema.json): self-reported effective configuration.
- [Progress schema](progress.schema.json): optional coarse-step channel, not a signed object.
- [Heartbeat schema](heartbeat.schema.json): optional presence channel, not a signed object.
- [Roster schema](roster.schema.json): root-signed current membership.
- [Invite schema](invite.schema.json): root-signed one-time enrollment invitation.
- [Invite binding schema](invite-binding.schema.json) and [invite publication schema](invite-publication.schema.json): the short-link signature by the invite key, and the `POST /invites` body that carries it (v1.md section 5.1).
- [Test-key examples](examples/): one object per schema; signed envelopes use
  synthetic fixed TEST-ONLY seeds and verifiable signatures. ArtifactRef values
  remain illustrative, not downloadable blob fixtures.
- [Golden vectors](vectors/README.md): exact JCS/digest/signature/link/proof bytes
  and expected failure codes, recomputed by tests/protocol-core.test.mjs.
- [Pure core API](../../lib/protocol/README.md): functions and caller obligations.

Schemas use JSON Schema 2020-12. Load all five schemas together and resolve
their example-domain identifiers and relative references locally; do not fetch
those identifiers from the internet. Enable format assertions. Parse and JCS
canonicalize pretty-printed examples before any wire serialization.

The registered `protocol` check is intended to compile schemas, validate these
examples, and validate OpenAPI. A passing structural check does not test JCS,
Ed25519, identity equalities, leases, concurrency, quota enforcement, sandboxing
or archive safety. Actual executed-check results belong in the assignment report.
The [v0 envelope reference](../history/envelope-v0.md) remains historical.
The read-only [legacy verifier](../../lib/legacy-verify.mjs) checks frozen
evidence against an independently pinned historical key. It grants no
execution authority; see [retirement](hosting.md#retiring-an-old-host).

A `verify_v1` check runs after the agent in the same sandbox. The agent could
change the project's test files and tools before that command runs. Its signed
command, exit status and summary are observations, not independent proof. The
local receipt and changes APIs add `check_context` with `independent: false`,
`agent_mutable_workspace: true`, and a plain explanation. This also covers old
results with checks. Raw signed checks and their wire format stay unchanged.

A stronger runner would start a fresh sandbox from the verified patched source,
use pinned tools and a clean environment, and prevent the agent's old processes
from changing it. Both sandboxes must share the job's total time limit. That
runner is a follow-up, not implemented here. The agent can still change test
files in the patch, so a separate runner would not replace review of those files.
