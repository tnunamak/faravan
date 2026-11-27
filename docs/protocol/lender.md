# Injected v1 lender library

This is a library for a later local-daemon integration, not a deployed daemon.
The checks use a fake backend, synthetic signed identities and loopback HTTP only.
No real provider, Docker, sbx, account, credential, enrollment or paid execution
is part of the implementation checks.

## API

createLender({ client, backend, policy, adapters, clock, onEvent, approve })
returns start(AbortSignal), pause(), resume(), snapshot and getState().
start resolves when the signal is aborted. Repeated start joins the same loop.
pause prevents subsequent polls and starts; an already-running job finishes.
A pending claim request is reconciled rather than discarded on pause.
Aborting start requests cancellation and waits for backend cleanup. A stopped
event is emitted only after removed:true and a client cessation acknowledgement.

The client must be the verified v1 client. Added backward-compatible helpers:
fetchArtifact(ref,{signal}) verifies bytes and digest; resultContext() exposes
only circle, public device fingerprint and current roster epoch; stopped reports
a terminal attempt's observed cessation. Signing stays inside completeAttempt.

The backend must be injected; there is no default Docker instantiation.
lenderCapabilities() is an observational preflight report with:
available, backend_id, egress, capabilities, enforced_limits, max_limits,
and pinned_git:true when cloneGitSource verifies the exact immutable commit.
The report uses protocol limit names: wall_seconds, cpu, memory_bytes,
disk_bytes, output_bytes. CPU, memory, wall and output enforcement are the
baseline for advertisement; disk may be absent. Each job's limit_modes is
matched independently; omitted modes remain required. Preferred unenforced
limits are carried into receipt.unenforced, never advertised as enforced.
It additionally implements the existing runJob backend lifecycle, including
admitJob, prepare, start, cloneGitSource, collectDeclaredOutputs, cancel,
destroy and probeCapabilities. destroy returns removed:true only after verified
cessation. Execution receipt limit names retain the runtime vocabulary:
cpu, memory, wall, output, storage, processes, network_bytes.

adapters is a list or async function returning caller-selected records:
{spec, installed:true, signedIn:true, enabled:true, harnessVersion, models,
capabilities}. spec is a trusted registered harness spec with image/entrypoint.
The lender advertises one selected harness at a time so it never unions a model
from one adapter with another harness. It never initiates authentication.

clock defaults to real time, or accepts {now,setTimeout,clearTimeout}; now is
Unix milliseconds. Tests supply a manually advanced clock.
onEvent receives snapshots with status, label, reason, current attempt and
counters. Exceptions from UI listeners do not authorize or interrupt work.
With offers_v1, approve(summary) returns literal true to accept an unclaimed offer.
The lender persists consent, makes the existing named claim, then prepares and starts
without another question. A preview or a local hide never changes coordinator state.
Cancellation, denial or changed readiness does not authorize execution. The summary includes the full
verified prompt, source/requirements, harness and startsNow disclosure.

## Policy and persistence

Default lending is off, approval mode ask, dailyJobs 3, dailyMinutes 60,
maxWallSeconds 1200, idleOnly false for automatic starts (opt in to idle-only), quotaReserve 30,
stopOnReturn false (opt in to a stop after two minutes of owner activity),
quotaMaxAgeMs 60000, leaseSeconds 120, renewMs 30000,
legacyHoldMs 60000, preparationTimeoutMs 180000, pollMs 1000, and the computer’s timeZone.
Offers use the borrower’s deadline; legacyHoldMs applies only to the older-host fallback.
The caller must select the displayed timezone and actual account/context rules.
No provider-terms/account-eligibility gate is added.

Automatic mode additionally needs userActive() returning false when idleOnly is
enabled, and quota() returning {remaining,observedAt}. remaining and reserve
must use the same documented caller units. Missing/stale/future quota readings
disable automatic starts. Manual approval does not claim to guarantee a reserve.
Policy and readiness are rechecked after approval, and membership/lease are
renewed before any run. There is one execution at a time.

policy.storage provides async get() and atomic set(value). Use the exported
createLenderCounterStorage(file,{decorate}) for file-backed counters: it provides
atomic durable replacement plus a cross-process acquire/release lifecycle.
The lender acquires ownership before loading counters and holds it for the
entire loop. All participating circles/accounts must use the same canonical
device-wide counter path; independent paths cannot enforce a shared budget.
Custom storage may supply an equivalent acquire lifecycle. In-memory storage
remains suitable only for isolated tests. The local app uses the file-backed
factory and shared process ownership for its own daemon state.

The state contains day (YYYY-MM-DD in policy.timeZone), jobs, milliseconds,
pending, claimPending, acceptedClaim and resultPending. claimPending journals the named
job, acceptance time and immutable idempotency key before the request is sent.
acceptedClaim retains acknowledged consent across a restart before preparation.
A preparation interrupted by restart is retried only after exact sandbox cessation
and release of the old attempt. An uncertain execution start is never rerun.

The new offers_v1 read route lists queued jobs, oldest first, with published_at.
Its long poll waits at most 30 seconds and wakes on publication, release or failure
before start. On old hosts, complete /jobs scans occur at most once per minute:
up to 2,000 retained jobs are supported, with immutable JobViews cached by digest.
Above that boundary the explicitly labeled legacy claim-next path holds for 60 seconds.
Old lenders still interoperate through claim-next and may hold work while deciding.

Automatic acceptance requires a standing rule scoped to current people, agents,
per-job time, daily/weekly job and time caps, hours and expiry (30 days by default).
Bare legacy automatic mode is not a standing grant. New people or larger jobs ask.
Rule removal or expiry prevents new automatic accepts. Already accepted immutable jobs
retain consent for the accepted agent through restart. Changing that agent discards that
acceptance and evaluates the offer again. Lending Off, Pause and Stop still gate execution.

Before starting, one job and its full
wall budget are durably reserved. Verified cleanup settles elapsed time;
unverified cleanup/crash retains the reservation and blocks further work.
Restart calls backend.reconcilePending(pending,{signal}) when available. It must
independently verify cessation and return both the exact pending attemptId and
removed:true before pending is cleared. Missing hooks, mismatched attempts,
unverified removal and errors preserve the reservation and block new work.
The durable pending record includes attempt identity, reservedMs, and jobId
before preparation, plus sandboxId when preparation supplies one. Reconciliation
retains the prior full job/runtime charge conservatively. DockerSbxBackend uses
bounded sbx listings and confirms absence after removal; unknown output fails
closed. These parsing assumptions are covered with stubs, not live sbx tests.
If verified cleanup already happened before a crash, an attempt-bound durable
cessationVerified record saved atomically with resultPending supplies that
evidence. Recovery requires matching attempt ID, job digest and generation;
missing or mismatched evidence still needs the backend hook and fails closed.
Day rollover never erases unresolved work. Durable-write failure is fail-closed.

Claim transport retries preserve the same advertisement and idempotency key;
unknown outcomes are not treated as an empty queue. After artifact upload,
the exact completion payload and key are durably saved before submission.
Exhausted acknowledgements are retried without re-execution or re-timestamping,
including after restart. Only network uncertainty, 429 and 5xx retain the
pending completion retry. A definitive 4xx records lastResultOutcome, emits a
failed event with the reason, clears resultPending and permits fresh claims.
A locally rejected committed claim is reconciled against the real attempt,
released when possible, and its idempotency key abandoned once rejection is
definitive; transient reconciliation errors retain the pending key.

Process locks carry PID/start/boot/host identity and recover only demonstrably
dead owners. Live, malformed, foreign or legacy unidentified owners fail closed;
no age timeout grants ownership. SIGKILL recovery does not itself prove sandbox
cessation or clear a budget reservation.

## Reused execution and limitations

The lender calls the existing buildValidatedJobSpec, runJob and buildTaskReceipt.
runJob now accepts an AbortSignal, cancels and destroys the same prepared handle,
checks cancellation between phases, and attaches cleanup evidence to failures.
The existing clone/materialization hook and output packaging path are reused,
not copied into a second executor. patch-output is not advertised because this
executor currently emits only a whole-workspace gzip. Candidate gzip and transcript are uploaded;
the client signs the result. Private receipt identities/host paths are excluded.
Measured usage is carried over; missing token counts and model remain null.
Execution evidence must cover all mandatory runtime limits before completion.

Lease renewal occurs well inside the requested lease, including during review
and execution. A separate deadline covers lease expiry and job hard expiry.
Fence, cancellation, expiry or uncertain renewal aborts execution; lease renewal
stops, and cessation is reported only after cleanup. Pause does not cancel a run.
In-flight renewal is reconciled before completion.

DockerSbxBackend can advertise the four enforceable default limits after
preflight. Disk remains unenforced and only jobs explicitly marking it preferred
can match. Pinned Git completion requires verified_commit equal to source.commit;
missing or mismatched evidence prevents result publication. Preflight reports
are observations, not guarantees or independent security attestation.

Archive-source jobs (application/gzip) are supported: the lender downloads the
source, verifies its digest and size, and extracts it with lib/archive.mjs into
fresh scratch, keeping executable bits and .git (it is the borrower's own source).
Other archive media types are released with policy_unenforceable.
A `{kind:"none"}` source materializes nothing: the agent starts in an empty folder.
The lender advertises `results_v1`. For a job with `result` (message or files) it
frames the agent to answer in its final message (message) and to save files in
`faravan-output/`, skips the diff, returns a gzip tar of `faravan-output/` only
(`candidate_format: tree`), and signs `output:{kind}` equal to the job's kind. A real signed-in Claude no-source message job is
recorded in [docs/testing/no-project-jobs.md](../testing/no-project-jobs.md). Receipts are not independent attestation. Receipt evidence is self-reported, not a sandbox
security proof. Result provenance does not establish code correctness.

## The sandbox's network policy

A sandbox inherits every global allow rule of sbx (the 0.48 default allows about 190 destinations, among them
`**.amazonaws.com`, `**.googleapis.com`, GitHub and the package registries), and a deny rule beats an allow rule. For a job
that is not `internet`, the lender therefore reads the policy that applies to the sandbox (`sbx policy ls <sandbox> --json
--type network`), allows only the provider hosts, the named registries and the agent kit's own allowances, and denies every
other inherited allowance for that sandbox. It then reads the rules back and runs `sbx policy check` for every pattern and a
spread of exact hosts; any destination that is still allowed, or a listing it cannot read, fails the job with
`policy_unenforceable` before the agent starts. An inherited allowance that is wider than what the job needs (for example a
global `**.com`) cannot be denied without blocking the job, so the job is refused too.

The agent's own sbx kit allows a few hosts for its sandbox beyond the provider (Codex: GitHub, Docker and Ubuntu hosts; Claude:
its own sign-in hosts). They are part of that agent's declared needs: kept, listed in the receipt (`kit_hosts`), and named in
the safety facts (`network.kit_hosts`, from the adapter's `egress_kit_hosts`). A global wildcard that overlaps a kit host
(`**.github.com` over `api.github.com`) cannot be denied without blocking the kit, so it stays open and is listed in the receipt
as `kit_wider_hosts`. A wildcard over a whole top-level domain is never accepted, and nothing neither requested nor kit-required is
left open. A kit that allows a host the job's GitHub clone needs keeps it for the whole run (`network_scope` `whole_run`).

A Git source is cloned inside the sandbox before the agent starts. GitHub is allowed for that clone by a rule of its own;
when the clone is done the lender removes that rule, denies GitHub again and checks it (sbx applies a rule to a running sandbox
at once). The receipt's `network_scope` is `clone_only` when that happened, or `whole_run` when the agent's own provider hosts
include GitHub, so it stays reachable.

## Observed egress in receipts

After the agent runs, the lender reads the sandbox's network log (`sbx policy log <sandbox> --json`) and records each host it reached (`allowed`) or was blocked from (`denied`), host and port only, at most 32 entries. When the log cannot be read, `egress_evidence` is `{"*": "unknown"}`. An empty object is never used for "unavailable", because it would read as "reached nothing".

The per-job cap defaults to 10% of the weekly allowance and the owner can change it. Once a usable reading shows the cap or reserve floor has been reached, Faravan requests a stop within its 145-second app control budget. Jobs admitted from an older cached reading have a 235-second startup app control budget until the first live read. Provider reporting lag can delay the reading by an amount Faravan cannot bound. These budgets do not guarantee when the job stops running. Its hold lasts until the meter shows its use or the weekly reset.
