# Sandbox audit A: reproduction and fixes

Baseline: `36de8dc5c5889f216cb074817a86e16d28322bb5` on
`fix/mac-sbx-keychain-1027`. Each finding had a failing regression test before
its corresponding implementation change. Round 2 adds Linux live storage probes;
no credentialed GitHub request, model request or real MCP server was used.

| Finding | Failing observation | Change and regression file |
| --- | --- | --- |
| B1 | Ordinary Claude and Codex internet jobs prepared despite saved GitHub authority. The first guard also missed custom, registry and target-sandbox secrets. | Read all credential namespaces as JSON; refuse effective credentials outside the selected service and explicit GitHub grant. Disable SSH forwarding and its configured socket. Serialize supported sign-in writes against durable sandbox leases. `tests/sandbox-audit-authority.test.mjs`, `tests/auth-flow.test.mjs`, `tests/github-auth.test.mjs` |
| M1 | The policy model permitted GitHub, Docker, Ubuntu and an unexpected kit host, including after source cloning. | Remove sandbox kit allow rules and deny extras; keep only declared providers, registries and the temporary source window. Declare Codex's required `chatgpt.com` apex explicitly. `tests/sandbox-audit-network.test.mjs` |
| M2 | Internet sandbox creation omitted a gateway deny. | Deny `mcp-gateway.docker.internal` at creation and verify policy decisions on ports 80 and 443. The policy model retains the deny after a new allowance. `tests/sandbox-audit-authority.test.mjs` |
| M3 | Finite stdout/stderr floods exceeded small raw budgets without stopping; lender collection proceeded. | Count cumulative raw bytes before decoding, guard filtering or retention; cancel on overflow. Cover guarded and unguarded runs, combined streams and lender cancellation. `tests/sandbox-audit-output.test.mjs` |
| M4 | Remote sources with 20 MiB plus one expanded byte or 1,001 headers were accepted. Cancellation could delete scratch before source writes stopped. | Apply lender source caps in a worker with a ten-second deadline; join extraction before scratch removal. Cover valid executable sources, small caps and timeout responsiveness. `tests/sandbox-audit-archive.test.mjs` |
| M5 | A preferred-disk request reached preparation through real Docker admission. Round 1 refused every borrowed job while readiness still reported success. | Require a locally exercised mountless storage path, size all writable VM disks within the signed budget, reserve aggregate admission capacity before creation and verify actual disks and mounts before execution. Setup and availability refuse unqualified machines. Physical host reservation remains unproven; see below. `tests/sandbox-audit-storage.test.mjs` |
| N1 | Restart left job/helper scratch behind; failed deletion disappeared from durable state after result delivery. | Write private scratch journals before directory creation, validate recovery paths, retain a separate retry queue and block new admission until deletion succeeds. Cover restart, sibling preservation, failed deletion, tampered records and symlinks. `tests/sandbox-audit-cleanup.test.mjs` |

No code-level finding was classified as not reproduced. The tests establish
the missing controls and their new behavior, not the audit's live exploit chains.

Round 1 targeted validation had 390 passes and one opt-in live test skipped.
The prior wording that sbx was unavailable was incorrect: the opt-in flag was
unset. Round 2 uses installed sbx 0.49.2 and accessible KVM. No files under
`public/`, `ui/` or `tests/browser-verify/` changed.

## Review regressions

The failed-check preparation test first returned a successful result with a skipped
check and an empty scratch retry queue. Cleanup now aggregates nested scratch
receipts before settling the attempt; restart recovers job, helper and check
journals. A separate test first left setup scratch behind when its durable setup
row had no scratch path. The reaper now consults the validated private journal.
It also sweeps journals with a definitely dead creator and an absent VM, even
without an attempt row; live preparation and unknown ownership remain untouched.

The catalog freshness tests and failure-vocabulary test failed before their
updates. The generated telemetry catalog now includes shipped modules and the
storage readiness check. Archive size/deadline refusals have explicit request
classifications; credential, cleanup and storage failures have setup classifications.
The P9 timer fixture now answers the credential probe so it reaches its intended
creation failure and retains the deadline assertions.

## Linux storage qualification

The implemented option is mountless `sbx create`, with trusted creation-only
`DOCKER_SANDBOXES_ROOT_SIZE` and `DOCKER_SANDBOXES_DOCKER_SIZE` values. Omitting a
path from `sbx run` would still mount the current directory. Source is staged under
the existing archive bounds, copied into a private guest directory, and results
use the existing bounded output stream. Git helpers and fresh check sandboxes
inherit guest block-device capacity checks. A durable, cross-process ledger charges each active
sandbox's guest capacity plus 8 GiB shared admission headroom, retaining charges
until removal proof. A local probe must verify the disk/mount layout, and each
job repeats that check. Host storage protection is unavailable, so lending is blocked.

The shell probe had a 3,758,096,384-byte root disk and a 536,870,912-byte Docker
disk. Finite writes larger than each disk failed with ENOSPC. The host canary and
a sibling VM's canary remained unchanged. A second finite pressure probe confirmed
that the host and sibling could both still write after ENOSPC. Its two VMs grew
host allocation by 4,926,238,720 bytes while more than 30 GiB remained free.
The resolver host mount was read-only;
a finite attempted write failed with EROFS. No host workspace was mounted.

The first Claude probe correctly failed: its kit adds a 2 GiB projects volume
and four 512 MiB state volumes. The revised plan accounts for these before
creation. Claude then passed with 3.5 GiB root, 512 MiB Docker and 4 GiB state,
totaling 8 GiB. Codex passed with the two-disk 4 GiB layout. Both copied a synthetic
source in and returned its exact contents. The shared job default is now 8 GiB;
Claude requests below 5 GiB refuse instead of silently allocating extra disks.
All named probe VMs were removed and independently confirmed absent.

Exhaustion can make a guest unbootable: archive copy-out failed on the full root,
and a later restart failed when Docker data was full. This is a failed job, not
a successful result. Cleanup still removed the VM. sbx 0.49.2 has no
`--log-driver` flag; these probes created no inner Docker containers and invoked
no agent. GUI environment variables were unset and stdin was closed. Two initial
remove commands requested confirmation and were skipped; explicit `--force`
removal was then used only for the named test sandboxes.

## What remains unqualified

The ledger prevents Faravan's cooperating processes from admitting aggregate
future VM capacity beyond observed free space and headroom. It does **not**
preallocate physical blocks against unrelated host writers. Native sbx cache,
image conversion and host log allocation are outside these guest disk ceilings.
No numeric inode promise was added. The research supplied for round 2 distinguishes
these contracts, and these results do not establish a whole-host byte/inode quota.
This host has no effective mount capabilities; a private user/mount namespace
probe failed with `uid_map: Operation not permitted`. A privileged, host-owned
storage pool and ancillary-allocation qualification remain deferred.

The complete backend no-model probe refused at `credential_scope_unenforceable`
before creating a VM in the existing credential identity. Storage qualification
does not qualify a credentialed agent journey. Multiple global provider secrets
can cause this conservative refusal; per-job provider bindings remain future work.
Faravan's sign-in writers are fenced for active jobs, but an external sbx command
can still mutate the shared credential store. No real GitHub authority was used
to test proxy substitution, and no SSH agent was contacted.

A modeled MCP gateway deny does not prove actual internal gateway routing.
Canary reads, management calls and registration during execution remain untested,
as do live provider connectivity after kit removal, direct stdout flooding,
macOS/Windows storage and the remaining DNS, redirect, IPv6 and host-interface
cases. Pre-journal scratch and legacy orphan records without creator identity
are retained unless an attempt or setup record establishes their ownership.

## Round 2 test results

One `nice -n 10 npm test` run completed: 467/469 files passed; 5,327 Node tests
had 5,301 passes, four failures, two skips, 20 TODOs and no cancellations.
Both shell files passed their applicable checks; privileged firewall execution
was skipped. The run took 1,653.8 seconds at concurrency four.

Three failures were ours: lender tests still expected refusal after a claim, or
used a four-limit fixture when trying to reach fractional-MiB validation. They
now assert refusal before any claim, while the fractional test advertises disk
support and still refuses before preparation. The entire lender file then
passed 132/132 tests. The final authority, cleanup and storage regression files
passed 28/28. Further targeted runs covered auth, executor, fresh verification,
setup cleanup, catalog and failure-classification changes. The last fixes were
verified by targeted files; the full suite was not repeated.

The remaining full-suite failure is pre-existing: the owner-approval CLI test
expects “Approved 1 device(s)” but receives “Approved 1 circle membership
request(s)”. It reproduced on the original base 36de8dc5. The base comparison
ran 43 tests: 41 passed, that assertion failed, and a separate approve-each test
timed out; the timeout did not occur in the head full run. The review's eight
telemetry failures did not recur in either head or base checks here. No cause
for that difference was established.

The runtime behavior was checked against Docker's [creation contract](https://docs.docker.com/reference/cli/sbx/create/),
[disk settings](https://docs.docker.com/ai/sandboxes/troubleshooting/) and
[credential configuration](https://docs.docker.com/ai/sandboxes/configuration/credentials/).
The supplied research also warns that a [reported image-finalization exhaustion](https://github.com/docker/sbx-releases/issues/676)
is outside a workspace quota; that report was not reproduced here.
