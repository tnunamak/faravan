# New user journey

Run the full journey from the repository root:

```sh
bash packaging/journey/new-user-journey.sh --synthetic
```

The v15 harness builds version `0.1.0`, installs its Linux tarball for separate owner and friend user homes, and writes
one summary to `~/.tmp/faravan-journey/run-<stamp>/summary.json`. Logs and disposable files stay in that run directory.
The installer writes a desktop entry and a `channel` file at the install root. The journey opens the desktop entry's
`Exec` command and checks that the installed app writes its state under the data home recorded in that channel file.
The app processes run with normal HOME-based resolution and no `FARAVAN_HOME` or `FARAVAN_HOME` override.

Headless Playwright drives Setup, invitation and approval, lending settings, the first send, friend result retrieval,
Stop and restart. The ops API reads back settings, ledger and meter state. It sets admission mode because the product
has no direct UI control. Synthetic mode uses a fixture account and backend; it does not use provider credentials.

Run the exact synthetic command twice before live mode. Live mode requires `JOURNEY_LIVE_CONFIRM=1`, uses Haiku only,
and caps each job at $1.50 and the full run at $2. Synthetic mode uses the reference smoke's $2 per-job and $4 total
caps. Live cap checks sum cumulative provider deltas in quota points, with a stable conversion rate per resource.
Polling detects breaches while a job runs. Missing or malformed counters fail; a fresh zero delta passes when the
reading and attempt accounting are complete. The public receipt has no canonical USD charge field, so the harness does
not guess by recursively searching its JSON. Synthetic mode reads the fixture meter's explicit `cost_usd` field.

```sh
JOURNEY_LIVE_CONFIRM=1 bash packaging/journey/new-user-journey.sh --live
```

The run uses fresh Faravan data and HOME directories on one host. It uses a locally built candidate tarball and prepared
provider sign-in and sandbox identities. Passing proves this setup's installed launcher, UI-driven circle, membership
approval, job submission, friend-visible result, Stop and owner restart. It does not prove fresh Docker or provider
sign-in onboarding, the published release artifact, or connectivity between different machines or networks.

The owner must click Setup's **Run the test** button. The harness checks that a new typed safety-test run passes.
Headless mode cannot start the tray, so desktop presence remains a reported exception (`{idleSeconds: 900}`). The
product has no UI control to set admission mode; the harness sets it through the API and records that exception. The UI
still handles per-job approval in `approve` mode. Synthetic mode marks its fixture account as not selected before the
UI selects it; live mode has no `agents.select` write.

Restart checks compare stable job identities and spend-ledger fields, including reservations and provider counters.
Missing attempt counters fail the no-double-count check. `journeyVersion` is 15 because `ledgerIntact` now includes the
spend ledger. Two passing synthetic summaries qualify for `--live` only when they use journey and harness version 15,
match the current clean source commit, and record a passing run.

## Per-build acceptance inventory

`journey-catalog.json` records the first owner/friend path and P1–P5.
Its Linux mappings name existing smoke summary checks, not new independent tests.
A plus sign in a test ID requires every named check. The approval mapping requires
the smoke's explicit approve mode. One-host checks do not prove two-host behavior.
For missing implementations, `fidelity` describes the required proof, not an achieved
level. `coverageKnowledge: UNKNOWN` means the scoped source cannot establish a
complete test; it is not a claim that no test exists anywhere in the repository.
Failure variants describe the scenarios to cover, not invented fault-injection tests.

The production command is data-only and does not start any application:

```sh
node packaging/journey/build-summary.mjs build.json evidence.json
```

`build.json` must contain exactly `buildId` and `artifacts`; artifacts must contain
exactly `linux` and `macos`, each a lowercase 64-character SHA-256 digest.
Build IDs are nonempty ASCII identifiers (letters, numbers, dot, underscore, colon
or hyphen; at most 128 characters). Evidence is an array of records with exactly:

- `id`, `platform` (`linux` or `macos`), `buildId`, `artifactDigest`;
- `testId` and `fidelity`, matching that catalog platform's implementation;
- `collected: true`;
- `runs`: an ordered array of `{ordinal: 1, status: "pass"}` or `"fail"`,
  numbering from 1 without gaps. An empty array means collected, not executed.

Retain every execution in order, including the first failure; never replace a
failed record with a later green record. One record represents one case on one
platform. Duplicate records are invalid, not retries. A collector must bind the
evidence to the actual build and installed artifact at observation time. This
reducer validates that contract; it does not independently observe the product or
authenticate a collector. No automatic conversion from legacy smoke summaries is
provided: those summaries alone lack this per-case execution history and exact
artifact bindings. Do not invent those fields from a passing aggregate.

Output names collected, executed, first-try failures, retried passes, all retried
cases, failures, NOT_RUN and NOT_BUILT per platform, with counts. Invalid or foreign
data never contributes to valid collection/execution counts. Missing implementations
remain NOT_BUILT even if green data is submitted. Any retry prevents readiness,
including two green executions. Exit codes are 0 for ready, 1 for not ready and 2
for unreadable inputs or incorrect command arguments.

`summarizeBuild` is the production API: it loads the catalog and uses separately
pinned required IDs and reviewed source mappings. Changing coverage requires a
reviewed code change, not an evidence flag or a shortened requirement list.
`reduceEvidenceContract` is a lower-level reusable inventory contract; its ready
value is only for the explicitly supplied inventory, and is not product readiness.
The complete fixture tests use this lower-level contract. The current production
catalog cannot become ready until the missing proofs are implemented and reviewed.
Neither unit fixture passes nor one-host passes imply installed two-host acceptance.

For review, run these commands from the repository root:

```sh
node --check packaging/journey/build-summary.mjs
node --test tests/journey-two-computer.test.mjs
git diff --check
```

No product journey, UI bundle build or paid backend execution is needed to test the data-only reducer.

## Preservation and redaction (S9 step 6)

`packaging/journey/preservation.mjs` is a pure module (no file or process access
of its own) that checks a run preserved the user's existing app state and that
retained evidence carries no raw secrets. The later driver collects the inputs
as plain objects and calls `checkPreservation`; the module never reads
credential stores, machines or app data itself.

Prerequisites the driver must collect before calling the check:

- Before/after snapshots of the approved nonsecret app preferences, including
  the visible tray model list and selections.
- Before/after channel identity.
- The run-owned roots for app state, install and evidence, plus the list of
  paths the run wrote.
- Process and forward close receipts: every process/forward the run closes must
  be run-owned, and every expected close needs its receipt.
- The install destination and its run ownership; a `reused-install` label also
  needs an explicit prior run receipt.
- The text of the evidence artifacts (step records, trace and log text).

Every result is labelled `fresh-install` or `reused-install`. A result is
`pass`, or `blocked`/`failed` with a stable code and the offending item
(`item` never contains a secret value). Use `redactEvidence` to replace
secrets in evidence text with the fixed marker `[REDACTED]`; the check passes
on redacted output.

Blocked codes (`BLOCKED_CODES` in the module):

- `write_outside_run_roots` — a write outside the run-owned app state, install
  or evidence roots.
- `tray_model_list_changed` — any change to the visible tray model list.
- `tray_model_selection_changed` — any change to the tray model selections.
- `channel_identity_changed` — the channel identity changed during the run.
- `evidence_contains_session_token_url` — a `?token=`, `&token=` or `#token=`
  URL in evidence text.
- `evidence_contains_bearer_token` — a bare bearer token in evidence text.
- `evidence_contains_invitation` — an invitation token, code, payload, url or
  link in evidence text.
- `evidence_contains_auth_header` — an `Authorization:` header in evidence text.
- `cleanup_unowned_process` — cleanup of a process or forward the run does not own.
- `install_destination_not_run_owned` — the install destination is not owned by
  this run.
- `missing_cleanup_receipt` — an expected process or forward close has no receipt.
- `reused_install_without_prior_receipt` — a `reused-install` label without an
  explicit prior run receipt.
- `missing_input` — a required input is missing or malformed (result `failed`).

## Local source lending

For three completed jobs across both agent kits, including a pinned Git source,
use [the local source check](LOCAL-LEND.md). It has separate synthetic,
no-job preflight and explicitly confirmed live modes.
