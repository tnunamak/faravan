# Previous-release holds after upgrade

`AdmissionRecovery` carries the release, cleanup-record format, owner scope,
sandbox presence, verified absence and terminal hold outcome as state. `Upgrade`
changes the executing release and rewrites no record. It is independent of
lifecycle phase: it can fire while the job runs, mid-sweep, mid-cleanup (backend
removed, proof persisted), or after the single bounded `Crash`/`Reopen`. The
previous release runs the ordinary sweep with its own identity proof and deletes
its own v1 row; the current release may not touch a v1 row until it is resolved.
`upgrade.at` records the phase at which `Upgrade` fired, and `upgrade.gap`
records a crash after the old row was resolved but before the hold ended.

`LaunchComposition` upgrade modes now run the whole launch lifecycle in the
previous release (hold, arm, pending journal, dispatch, which writes a v1 row and,
in `_present`, a live sandbox). `Upgrade` is a restart under new code that fires
from any phase (running, recover, handoff, clear, after a close) and moves to
recovery. `Crash` (once), `CloseBegin` (once, followed by `Restart`), `Finish`
(a running job ends) and `Settle` (hold ends after durable ownership) are part of
the upgrade runs. The previous release removes and deletes its own row; the
current release must verify absence and resolve a v1 row (`ResolveOldCleanup`)
before removal or `ReleaseOldPending`, so a crash between those two actions is
explored. All six original launch safety invariants stay in every upgrade config.
Terminal persistence-fault paths (`PersistFault`, `UnknownDispatch`,
`CandidateSaveFault`) stay safety-only in their original modes and are disabled
in upgrade runs, rather than assuming they always recover.

Both models use record format `old` for v1, `new` for current records, and `none`
after deletion. Resolution deletes a proven-absent legacy row; it does not
invent a current create receipt. Each model represents one attempt, not mixed
generations, multiple daemons, filesystem races or arbitrary upgrades. Upgrade
happens at most once. After the upgrade, a restart always re-enters recovery,
so the model does not resume pre-dispatch work (no new launch) after a restart.
`AdmissionAccounting` retains its existing cessation-proof interface: it has no
cleanup-record reader or code-version transition to refine in this change.

## Properties and fairness

`HoldLiveness` is `hold ~> released-or-charged` in `AdmissionRecovery`, and
`held ~> holdEnded` in the launch slice (which models release only).
`VerifiedRelease` forbids clearing cleanup, proving cessation or ending a hold
without verified absence. `HoldOutcome` ties the recovery model's terminal
outcome to removal of the hold.

Weak fairness means an action that remains enabled must eventually run. Recovery,
sweep, proof persistence, retry time advancement and settlement have this
assumption, as in the existing recovery model. Upgrade, job end, orderly-close restart and every lifecycle step must eventually
occur when enabled (a job that never ends never settles; a daemon never
restarted after close is excluded). The bounded crash can happen once; the model does not assume infinitely many
successful recoveries between infinitely many crashes. Storage is healthy in
the upgrade cases. The automatic-only configuration disables owner release and
still proves liveness, so an owner command does not mask a broken sweep.

`VerifyLegacyAbsence` / `VerifyAbsence` abstract complete evidence for the right
HOME, live daemon, readable inventory, complete process scan and matching job
identity. Their weak fairness assumes that evidence eventually becomes
available, not that an empty listing proves absence. This is an environmental
condition, not a daemon-health guarantee. With permanently unavailable evidence,
liveness would be dishonest: `_unverified` configs check retained-hold safety
only. For `_present`, weak fairness of `OwnerRemovesSandbox` / `OwnerCleanup`
explicitly assumes the owner eventually removes the legacy sandbox. The fix
must not automatically delete unknown legacy compute. Absent-sandbox cases need
no such owner-removal assumption. These fairness assumptions exclude stopped
recovery services, permanent storage failure and an owner who never acts.

## Counterexamples and sensitivity

The U1 witness is `LaunchComposition_upgrade_bug` (16 states):

1. Previous release runs the launch: hold, pending attempt, dispatch writes the
   old cleanup row (sandbox absent, no verified evidence).
2. `Upgrade` while the job runs: new code reads the same durable records.
3. `VerifyAbsence`: complete evidence proves absence.
4. Stutter forever: old-row resolution and ownerless release refuse. The hold
   never ends, despite fair recovery. `HoldLiveness` fails.

`AdmissionRecovery_upgrade_bug` models the same two refusals within the sweep
protocol. `_bug_record` retains only the cleanup refusal and still fails.
`_owner` / `_bug_owner` isolate the supported owner-command path by disabling
automatic recovery in BOTH configurations; accepting versus refusing the
ownerless record is the sole difference. The general fixed configuration can
recover through either path. `_auto` proves the automatic charge path alone.
`_bug_unsafe` deliberately allows cleanup resolution without evidence and
violates `VerifiedRelease`, showing that dropping the safety gate is detected.
The `_reach_*` configurations intentionally violate their witness invariants to
show release, charge and blocked uncertainty are reachable. Each `_upgrade*`
config tests U1 or one of these U1 safety/non-vacuity boundaries; none tests U2-U5.
Upgrade-boundary witnesses (`_upgrade_reach_run`, `_recovery`, `_cleanup`,
`_crashgap` in both models) prove each boundary is reachable: upgrade while the
job runs (Admission: before any sweep), mid-recovery (Launch: `Upgrade` after a crash with the old
row unresolved, captured in `at` at the moment of upgrade; Admission: mid-sweep), mid-cleanup (backend removed and hold
still held), and a crash after the old row was resolved but before the hold ended.
Admission's previous-release removal sets `verified` itself (identity proof), so
`_unverified` there blocks only the current release's evidence path.

## Code correspondence and limits

The bug configs describe the behavior at `d561d36e`: `_legacyReport` always
returns `removed:false`, `reconcileOwned` treats any old row as unresolved,
and `proveHoldAbsent` rejects ownerless attempts. U1 was reproduced against the
installed backend using previous-release record shapes; the supplied evidence
contains that replay. No new real-daemon or full-app replay was run here.

The intended fix on `fix/legacy-hold-upgrade`, inspected at
`b8297bb7219aba6fb0092437deb6ae7037ab86ea`, maps to:

| Model boundary | Code boundary |
|---|---|
| Verify absence | `DockerSbxBackend._legacyInventory` and `_proveLegacyHoldAbsent` validate daemon/HOME, inventory, process and attempt evidence |
| Resolve old cleanup | `reportOld(..., {settle:true})` / `closeAbsentLegacy` delete scratch and the old row; failed removal keeps the row |
| Automatic recovery / charge | `_reconcilePending` uses `closeWhenAbsent:true`, requires `resolveJobs`, then returns `full_charge:true`; the existing lender settles the attempt |
| Owner release | `proveHoldAbsent` accepts the ownerless branch through `_proveLegacyHoldAbsent`, requires resolved cleanup, then permits the existing owner hold transition |

No intended gate needs to differ from that branch for these modeled paths.
The model combines each evidence gathering operation into a trusted atomic
predicate and treats the durable cleanup deletion as one action. It cannot
check TOCTOU, locks, process-scan completeness, raw filesystem safety, Linux/macOS
parity, exact charge arithmetic or provider scope. If those seams do not satisfy
the stated predicate, passing TLC does not establish implementation safety.
The model's sweep retains the existing delayed meter/reset abstraction; the
legacy full-charge implementation may settle sooner. No timing guarantee is
claimed. Separate real-code tests must check those refinements.

| Risk | Coverage here / appropriate test |
|---|---|
| U1 old cleanup + ownerless pending | Caught when the fix is reverted in bug modes; fixed liveness and retained-hold safety pass |
| U2 account pending keys read only at root | Not modeled. Needs tests that write each account journal key and inspect the real update-idle gate. A future account-indexed admission model could express the invariant, but cannot establish writer reachability by itself |
| U3 installer readiness after package replacement | Not modeled. Needs a confined installer failure/rollback test |
| U4 saved UTC zone replaced | Not modeled. Needs serialized settings migration tests across time zones |
| U5 invalid policy resets all fields | Not modeled. Needs malformed saved-policy fixtures that assert preservation/notice behavior |

## Reproduce and results

The existing `npm run protocol:check` registry does not include the new configs.
No JavaScript was changed. Run the companion bounded checker for ALL configs of
both touched models, including every existing good, bug and reachability case:

```sh
uv run spec/tla/check-upgrades.py
```

It uses the existing runner's Java heap/off-heap limits and TLC flags, reduces
workers to two, runs one JVM at a time at `nice -n 19`, caps each run at five
minutes and deletes its state directory under disk-backed `~/.tmp`. It checks
each config's declared expected result, including the named liveness violation.
No depth constraint truncates the finite state graph.

The repository's documented jar checksum is
`011267fca25d0752cf18894dd585cd28b96960c112ea8a20b823ea770e7e10cd`.
The available shared cache instead hashes to
`e20447644bfabd29d6bd0fc2c0eb1473fb301c1a0e4dfe1961938ce5a191edbf`; the original
pin was not available. The results below use a fresh download of the documented
v1.8.0 release URL (TLC `2026.11.06.182551`, rev `c058b21`), which hashes to
`8bc07d8686b7e40bbc289a5744324865526b1c107f7f21571a937b488dbbfe03`. The release
artifact is not stable, so earlier recorded hashes differ. The original runner
and pin remain unchanged. The companion checker needs an explicit override:

```sh
curl -fsSL -o "$HOME/.tmp/upgrade-tla2tools.jar" https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar
uv run spec/tla/check-upgrades.py --jar "$HOME/.tmp/upgrade-tla2tools.jar" --sha256 "$(sha256sum "$HOME/.tmp/upgrade-tla2tools.jar" | cut -d' ' -f1)"
```

Recorded 2026-11-06 with two workers. Every run took under two seconds and no
bound was reduced: all state graphs are finite and fully explored. Counts for
early-stopping safety witnesses can vary with scheduling. A named property below
means the expected violation, not an unexpected test failure. All 56 outcomes
match their expectation.

| Config | Expected | Actual | Generated | Distinct | Seconds |
|---|---|---|---:|---:|---:|
| AdmissionRecovery_backend | pass | pass | 743 | 242 | 1.37 |
| AdmissionRecovery_lost-owner | RecoveryLiveness | RecoveryLiveness | 568 | 191 | 0.97 |
| AdmissionRecovery_no-force | pass | pass | 572 | 177 | 0.96 |
| AdmissionRecovery_partial | RecoveryLiveness | RecoveryLiveness | 570 | 176 | 0.98 |
| AdmissionRecovery_pending | RecoveryLiveness | RecoveryLiveness | 614 | 201 | 1.03 |
| AdmissionRecovery_permanent | pass | pass | 115 | 40 | 0.61 |
| AdmissionRecovery_poison | RecoveryLiveness | RecoveryLiveness | 661 | 217 | 0.83 |
| AdmissionRecovery_reach-next | W_NoNext | W_NoNext | 419 | 149 | 0.56 |
| AdmissionRecovery_reach-owner | W_NoCrashOwner | W_NoCrashOwner | 7 | 6 | 0.55 |
| AdmissionRecovery_reach-poison | W_NoPoison | W_NoPoison | 111 | 43 | 0.77 |
| AdmissionRecovery_reach-read | W_NoFailedRead | W_NoFailedRead | 19 | 13 | 0.84 |
| AdmissionRecovery_reach-reset | W_NoPartialReset | W_NoPartialReset | 21 | 13 | 0.78 |
| AdmissionRecovery_read | pass | pass | 680 | 216 | 0.91 |
| AdmissionRecovery_repair | pass | pass | 796 | 254 | 0.82 |
| AdmissionRecovery_save | RecoveryLiveness | RecoveryLiveness | 661 | 217 | 0.82 |
| AdmissionRecovery_timer | RecoveryLiveness | RecoveryLiveness | 568 | 191 | 0.68 |
| AdmissionRecovery_upgrade | pass | pass | 4234 | 1332 | 0.88 |
| AdmissionRecovery_upgrade_auto | pass | pass | 2146 | 695 | 0.83 |
| AdmissionRecovery_upgrade_bug | HoldLiveness | HoldLiveness | 372 | 116 | 0.81 |
| AdmissionRecovery_upgrade_bug_owner | HoldLiveness | HoldLiveness | 602 | 188 | 0.97 |
| AdmissionRecovery_upgrade_bug_record | HoldLiveness | HoldLiveness | 1448 | 439 | 1.16 |
| AdmissionRecovery_upgrade_bug_unsafe | VerifiedRelease | VerifiedRelease | 30 | 21 | 0.69 |
| AdmissionRecovery_upgrade_owner | pass | pass | 963 | 312 | 1.08 |
| AdmissionRecovery_upgrade_present | pass | pass | 4406 | 1380 | 0.86 |
| AdmissionRecovery_upgrade_reach_charge | W_UpgradeCharged | W_UpgradeCharged | 1667 | 608 | 0.79 |
| AdmissionRecovery_upgrade_reach_cleanup | W_UpgradeCleanup | W_UpgradeCleanup | 221 | 98 | 0.90 |
| AdmissionRecovery_upgrade_reach_crashgap | W_UpgradeCrashGap | W_UpgradeCrashGap | 158 | 76 | 1.35 |
| AdmissionRecovery_upgrade_reach_recovery | W_UpgradeRecovery | W_UpgradeRecovery | 79 | 43 | 0.67 |
| AdmissionRecovery_upgrade_reach_release | W_UpgradeReleased | W_UpgradeReleased | 89 | 48 | 0.64 |
| AdmissionRecovery_upgrade_reach_run | W_UpgradeRun | W_UpgradeRun | 2 | 2 | 0.63 |
| AdmissionRecovery_upgrade_reach_unverified | W_UpgradeBlocked | W_UpgradeBlocked | 2 | 2 | 0.56 |
| AdmissionRecovery_upgrade_unverified | pass | pass | 1276 | 391 | 0.59 |
| LaunchComposition | pass | pass | 626 | 225 | 0.50 |
| LaunchComposition_discard | JournalOwnership | JournalOwnership | 218 | 91 | 0.57 |
| LaunchComposition_early | DurableBeforeDispatch | DurableBeforeDispatch | 717 | 259 | 0.57 |
| LaunchComposition_late | NoLateEffect | NoLateEffect | 624 | 225 | 0.67 |
| LaunchComposition_noack | AckHasObservation | AckHasObservation | 216 | 91 | 0.77 |
| LaunchComposition_reach_ack | W_Ack | W_Ack | 472 | 171 | 0.68 |
| LaunchComposition_reach_dispatch | W_Dispatch | W_Dispatch | 238 | 87 | 0.86 |
| LaunchComposition_reach_hold | W_Hold | W_Hold | 2 | 2 | 0.73 |
| LaunchComposition_reach_journal | W_Journal | W_Journal | 224 | 93 | 0.88 |
| LaunchComposition_reach_late | W_Late | W_Late | 624 | 225 | 0.61 |
| LaunchComposition_reach_recovery | W_Recovery | W_Recovery | 243 | 101 | 0.75 |
| LaunchComposition_reach_unknown | W_Unknown | W_Unknown | 215 | 87 | 0.72 |
| LaunchComposition_refund | UnknownRetainsHold | UnknownRetainsHold | 208 | 85 | 0.73 |
| LaunchComposition_replay | NoLaunchReplay | NoLaunchReplay | 247 | 102 | 0.76 |
| LaunchComposition_upgrade | pass | pass | 8668 | 2922 | 1.06 |
| LaunchComposition_upgrade_bug | HoldLiveness | HoldLiveness | 5652 | 2000 | 1.31 |
| LaunchComposition_upgrade_present | pass | pass | 8938 | 3014 | 0.96 |
| LaunchComposition_upgrade_reach | W_UpgradeEnd | W_UpgradeEnd | 146 | 76 | 0.65 |
| LaunchComposition_upgrade_reach_cleanup | W_UpgradeCleanup | W_UpgradeCleanup | 198 | 99 | 0.66 |
| LaunchComposition_upgrade_reach_crashgap | W_UpgradeCrashGap | W_UpgradeCrashGap | 2134 | 825 | 0.58 |
| LaunchComposition_upgrade_reach_recovery | W_UpgradeRecovery | W_UpgradeRecovery | 1373 | 532 | 0.62 |
| LaunchComposition_upgrade_reach_run | W_UpgradeRun | W_UpgradeRun | 4622 | 1718 | 0.63 |
| LaunchComposition_upgrade_reach_unverified | W_UpgradeBlocked | W_UpgradeBlocked | 139 | 69 | 0.80 |
| LaunchComposition_upgrade_unverified | pass | pass | 5727 | 1908 | 0.90 |
