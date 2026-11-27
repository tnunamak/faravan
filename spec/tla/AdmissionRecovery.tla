------------------------ MODULE AdmissionRecovery ------------------------
EXTENDS Naturals, TLC
CONSTANTS Mode, Fault, Permanent
(***************************************************************************
 Two jobs: the stopped predecessor and one eligible successor. Two reset
 boundaries, one crash, one transient failure. No execution is relaunched.
 Contracts (not INSTANCE composition): Admission supplies an open hold and
 stable consenting controls; Stop/LendingLease supply attempt-bound cessation
 via backend removal and retain the pending journal until proof is durable.
 Settle requires durable proof plus a post-delay complete same-scope meter OR
 conservative charge at BOTH resets. Neither freshness nor 120 s proves eq.17:
 unknown envelopes imply Q. Quota arithmetic belongs to AdmissionExposure.
 Mode="current" faithfully has NO automatic reopen. "repair" adds that proposed
 supervisor contract. Other modes are intentional retry mutations, not claims
 about shipped code. Upgrade modes cover an ownerless previous-release
 attempt and an old cleanup row; see UPGRADE.md for fairness and code mapping.
 Environment may fail once, then must restore unless the
 explicitly permanent case is selected. WF applies only to enabled actions.
***************************************************************************)
VARIABLES hold, journal, storage, backend, readOK, faulted, restored,
          pending, due, active, sweepEnabled, poisoned, adapterClosed,
          now, reset, proof, removed, meter, sweeping, nextJob, crashed, upgrade
vars == <<hold,journal,storage,backend,readOK,faulted,restored,pending,due,
 active,sweepEnabled,poisoned,adapterClosed,now,reset,proof,removed,meter,
 sweeping,nextJob,crashed,upgrade>>
UpgradeMode == Mode \in {"upgrade", "upgrade-bug", "upgrade-record-bug",
 "upgrade-owner-bug", "upgrade-owner", "upgrade-auto", "upgrade-present", "upgrade-unverified", "upgrade-unsafe"}
Init == /\ hold = TRUE /\ journal = TRUE
 /\ storage = TRUE /\ backend = TRUE /\ readOK = TRUE /\ faulted = UpgradeMode /\ restored = UpgradeMode
 /\ pending = FALSE /\ due = 0 /\ active = TRUE /\ sweepEnabled = TRUE /\ poisoned = FALSE
 /\ adapterClosed = FALSE /\ now = 0 /\ reset = 0 /\ proof = FALSE /\ removed = FALSE
 /\ meter = FALSE /\ sweeping = FALSE /\ nextJob = FALSE /\ crashed = FALSE
 /\ upgrade = [release |-> "previous", format |-> IF UpgradeMode THEN "old" ELSE "new", owner |-> "none",
    sandbox |-> IF Mode = "upgrade-present" THEN "present" ELSE "absent",
    verified |-> FALSE, outcome |-> "open", at |-> "none", gap |-> FALSE, resolved |-> FALSE]
\* Environmental seams: lending-pace50-adapter.mjs:138-145; lender-pace50.mjs:946-953;
\* backend request_cessation at lender-pace50.mjs:190-209.
FailService == /\ ~faulted /\ ~nextJob
 /\ faulted' = TRUE
 /\ storage' = (Fault # "save") /\ backend' = (Fault # "backend")
 /\ readOK' = (Fault # "read")
 /\ UNCHANGED <<hold,journal,restored,pending,due,active,sweepEnabled,
 poisoned,adapterClosed,now,reset,proof,removed,meter,sweeping,nextJob,crashed,upgrade>>
\* Same IO/provider seam; finite fault budget makes eventual health explicit.
RestoreService == /\ faulted /\ ~restored /\ ~Permanent
 /\ storage' = TRUE /\ backend' = TRUE /\ readOK' = TRUE /\ restored' = TRUE
 /\ UNCHANGED <<hold,journal,faulted,pending,due,active,sweepEnabled,poisoned,
 adapterClosed,now,reset,proof,removed,meter,sweeping,nextJob,crashed,upgrade>>
\* lender-pace50.mjs:771-778 restores ownership from the durable attempt.
Crash == /\ faulted /\ ~crashed /\ hold
 /\ crashed' = TRUE /\ active' = FALSE /\ sweeping' = FALSE
 /\ pending' = FALSE /\ adapterClosed' = TRUE
 /\ journal' = (IF Mode = "lost-owner" THEN FALSE ELSE journal)
 /\ sweepEnabled' = (Mode # "timer")
 /\ upgrade' = [upgrade EXCEPT !.gap = (upgrade.gap \/ (UpgradeMode /\ upgrade.resolved /\ upgrade.outcome = "open"))]
 /\ UNCHANGED <<hold,storage,backend,readOK,faulted,restored,due,poisoned,
 now,reset,proof,removed,meter,nextJob>>
\* lending-pace50-adapter.mjs:587-609,100-172. Restart is explicit; automatic poisoned
\* reopen is a PROPOSED supervisor, absent in lending-runtime.mjs:311-342.
Reopen == /\ faulted /\ restored /\ storage
 /\ (adapterClosed \/ (poisoned /\ Mode # "current" /\ Mode # "poison"))
 /\ active' = TRUE /\ adapterClosed' = FALSE /\ poisoned' = FALSE
 /\ UNCHANGED <<hold,journal,storage,backend,readOK,faulted,restored,pending,due,
 sweepEnabled,now,reset,proof,removed,meter,sweeping,nextJob,crashed,upgrade>>
\* lending-runtime.mjs:311-325; lender-pace50.mjs:942-953. Saturating due-time quotient:
\* 0=before delay, 1=settlement delay, 2=short reset, 3=weekly reset.
RetryDue == /\ now < 3 /\ now' = now + 1
 /\ reset' = (IF now' >= 2 THEN now' - 1 ELSE 0)
 /\ UNCHANGED <<hold,journal,storage,backend,readOK,faulted,restored,pending,due,
 active,sweepEnabled,poisoned,adapterClosed,proof,removed,meter,sweeping,nextJob,crashed,upgrade>>
\* lending-runtime.mjs:314: held sweep is independent of enabled/paused lending controls.
SweepStart == /\ faulted /\ hold /\ active /\ sweepEnabled /\ journal
 /\ ~adapterClosed /\ ~poisoned /\ ~sweeping /\ ~pending /\ now >= due
 /\ sweeping' = TRUE
 /\ UNCHANGED <<hold,journal,storage,backend,readOK,faulted,restored,pending,due,
 active,sweepEnabled,poisoned,adapterClosed,now,reset,proof,removed,meter,nextJob,crashed,upgrade>>
\* lending-pace50-adapter.mjs:565-584; lender-pace50.mjs:190-209.
\* The previous release removes by its own identity proof and deletes its own v1
\* row; the current release must first resolve a v1 row it did not write.
RecoverBackend == /\ sweeping /\ ~removed /\ backend
 /\ (~UpgradeMode \/ (Mode \notin {"upgrade-bug", "upgrade-owner-bug", "upgrade-owner"}
      /\ (upgrade.release = "previous" \/ (upgrade.verified /\ upgrade.format = "none"))))
 /\ removed' = TRUE
 /\ upgrade' = (IF UpgradeMode /\ upgrade.release = "previous"
      THEN [upgrade EXCEPT !.verified = TRUE, !.sandbox = "absent", !.format = "none"] ELSE upgrade)
 /\ UNCHANGED <<hold,journal,storage,backend,readOK,faulted,restored,pending,due,
 active,sweepEnabled,poisoned,adapterClosed,now,reset,proof,meter,sweeping,nextJob,crashed>>
\* lender-pace50.mjs:1034-1061; lending-pace50-adapter.mjs:138-145.
PersistProof == /\ sweeping /\ removed /\ ~proof /\ ~poisoned
 /\ proof' = storage
 /\ poisoned' = ~storage
 /\ UNCHANGED <<hold,journal,storage,backend,readOK,faulted,restored,pending,due,
 active,sweepEnabled,adapterClosed,now,reset,removed,meter,sweeping,nextJob,crashed,upgrade>>
\* lender-pace50.mjs:932-953: native force read and finally pending clear.
CanSettle == hold /\ proof /\ storage /\ ~poisoned /\ ~adapterClosed
 /\ (meter \/ (reset = 2 /\ Mode # "partial"))
SweepComplete == /\ sweeping /\ ~CanSettle
 /\ (removed \/ ~backend) /\ (proof \/ ~removed \/ poisoned)
 /\ sweeping' = FALSE
 /\ pending' = (Mode = "pending" /\ ~readOK)
 /\ meter' = (meter \/ (proof /\ readOK /\ now >= 1 /\ Mode # "no-force" /\ ~(Mode = "partial" /\ reset > 0)))
 /\ due' = (IF now < 3 THEN now + 1 ELSE 3)
 /\ UNCHANGED <<hold,journal,storage,backend,readOK,faulted,restored,active,
 sweepEnabled,poisoned,adapterClosed,now,reset,proof,removed,nextJob,crashed,upgrade>>
\* lender-pace50.mjs:959-997,914-922: native and per-resource reset settlement.

Settle == /\ sweeping /\ hold /\ proof /\ storage /\ ~poisoned /\ ~adapterClosed
 /\ (meter \/ (reset = 2 /\ Mode # "partial"))
 /\ hold' = FALSE /\ journal' = FALSE
 /\ upgrade' = [upgrade EXCEPT !.outcome = "charged"]
 /\ UNCHANGED <<storage,backend,readOK,faulted,restored,pending,due,active,
 sweepEnabled,poisoned,adapterClosed,now,reset,proof,removed,meter,sweeping,nextJob,crashed>>
\* Upgrade changes code, never rewrites the previous release's durable data.
\* One interrupted attempt: no owner_scope and a v1 cleanup record.
\* Fires from ANY previous-release state: running, mid-sweep, mid-cleanup, restarted.
Upgrade == /\ UpgradeMode /\ upgrade.release = "previous"
 /\ upgrade' = [upgrade EXCEPT !.release = "current",
      !.at = IF removed \/ proof THEN "cleanup" ELSE IF sweeping THEN "recovery"
             ELSE IF crashed THEN "restart" ELSE "run"]
 /\ UNCHANGED <<hold,journal,storage,backend,readOK,faulted,restored,pending,due,
 active,sweepEnabled,poisoned,adapterClosed,now,reset,proof,removed,meter,sweeping,nextJob,crashed>>
\* External owner remediation, not an automatic destructive legacy migration.
OwnerRemovesSandbox == /\ UpgradeMode /\ upgrade.release = "current"
 /\ upgrade.sandbox = "present"
 /\ upgrade' = [upgrade EXCEPT !.sandbox = "absent"]
 /\ UNCHANGED <<hold,journal,storage,backend,readOK,faulted,restored,pending,due,
 active,sweepEnabled,poisoned,adapterClosed,now,reset,proof,removed,meter,sweeping,nextJob,crashed>>
\* Trusted seam: attributable live daemon/HOME, complete inventory and process
\* scan, identity-matched attempt, safe journal/scratch. Empty listing alone
\* does not enable this action. Unverified mode never supplies that evidence.
VerifyLegacyAbsence == /\ UpgradeMode /\ upgrade.release = "current"
 /\ upgrade.sandbox = "absent" /\ ~upgrade.verified
 /\ Mode # "upgrade-unverified"
 /\ upgrade' = [upgrade EXCEPT !.verified = TRUE]
 /\ UNCHANGED <<hold,journal,storage,backend,readOK,faulted,restored,pending,due,
 active,sweepEnabled,poisoned,adapterClosed,now,reset,proof,removed,meter,sweeping,nextJob,crashed>>
\* Record format is old/new, or none after durable deletion. Resolution
\* deletes the old row; it must never fabricate a current create receipt.
ResolveLegacyRecord == /\ UpgradeMode /\ upgrade.release = "current"
 /\ upgrade.format = "old"
 /\ (upgrade.verified \/ Mode = "upgrade-unsafe")
 /\ Mode \notin {"upgrade-bug", "upgrade-record-bug"}
 /\ upgrade' = [upgrade EXCEPT !.format = "none", !.resolved = TRUE]
 /\ UNCHANGED <<hold,journal,storage,backend,readOK,faulted,restored,pending,due,
 active,sweepEnabled,poisoned,adapterClosed,now,reset,proof,removed,meter,sweeping,nextJob,crashed>>
\* Owner release is distinct from automatic recovery/charge. Both legacy
\* entry points must accept ownerless records only after verified absence.
ReleaseLegacyHold == /\ UpgradeMode /\ hold /\ storage
 /\ upgrade.release = "current" /\ upgrade.format = "none"
 /\ (upgrade.verified \/ Mode = "upgrade-unsafe")
 /\ (upgrade.owner # "none" \/ Mode \notin {"upgrade-bug", "upgrade-owner-bug"})
 /\ Mode # "upgrade-auto"
 /\ hold' = FALSE /\ journal' = FALSE
 /\ upgrade' = [upgrade EXCEPT !.outcome = "released"]
 /\ UNCHANGED <<storage,backend,readOK,faulted,restored,pending,due,
 active,sweepEnabled,poisoned,adapterClosed,now,reset,proof,removed,meter,sweeping,nextJob,crashed>>
\* lender-pace50.mjs:1265-1318; lending-pace50-adapter.mjs:468-512; no relaunch.
AdmitNext == /\ ~hold /\ active /\ storage /\ ~poisoned /\ ~adapterClosed
 /\ ~nextJob /\ nextJob' = TRUE
 /\ UNCHANGED <<hold,journal,storage,backend,readOK,faulted,restored,pending,due,
 active,sweepEnabled,poisoned,adapterClosed,now,reset,proof,removed,meter,sweeping,crashed,upgrade>>
Next == Upgrade \/ OwnerRemovesSandbox \/ VerifyLegacyAbsence \/ ResolveLegacyRecord \/ ReleaseLegacyHold \/ FailService \/ RestoreService \/ Crash \/ Reopen \/ RetryDue
 \/ SweepStart \/ RecoverBackend \/ PersistProof \/ SweepComplete \/ Settle \/ AdmitNext
 \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
 /\ WF_vars(Upgrade) /\ WF_vars(OwnerRemovesSandbox)
 /\ WF_vars(VerifyLegacyAbsence) /\ WF_vars(ResolveLegacyRecord)
 /\ WF_vars(ReleaseLegacyHold)
 /\ WF_vars(FailService) /\ WF_vars(RestoreService) /\ WF_vars(Reopen)
 /\ WF_vars(RetryDue) /\ WF_vars(SweepStart) /\ WF_vars(RecoverBackend)
 /\ WF_vars(PersistProof) /\ WF_vars(SweepComplete) /\ WF_vars(Settle) /\ WF_vars(AdmitNext)
HoldLiveness == hold ~> (upgrade.outcome \in {"released", "charged"})
VerifiedRelease == UpgradeMode =>
 ((~hold \/ proof \/ removed \/ upgrade.format = "none") =>
    (upgrade.verified /\ upgrade.sandbox = "absent"))
HoldOutcome == UpgradeMode => (~hold <=> upgrade.outcome \in {"released", "charged"})
W_UpgradeReleased == ~(upgrade.release = "current" /\ upgrade.outcome = "released")
W_UpgradeCharged == ~(upgrade.release = "current" /\ upgrade.outcome = "charged")
W_UpgradeBlocked == ~(upgrade.release = "current" /\ hold /\ ~upgrade.verified)
W_UpgradeRun == upgrade.at # "run"
W_UpgradeRecovery == upgrade.at # "recovery"
W_UpgradeCleanup == ~(upgrade.at = "cleanup" /\ hold)
W_UpgradeCrashGap == ~upgrade.gap
RecoveryLiveness == (<>[] (storage /\ backend /\ readOK)) => <>nextJob
SafeBlocked == ~nextJob /\ hold
W_NoFailedRead == ~(faulted /\ ~readOK /\ sweeping)
W_NoPoison == ~poisoned
W_NoCrashOwner == ~(crashed /\ journal /\ adapterClosed)
W_NoPartialReset == ~(reset = 1 /\ hold)
W_NoNext == ~nextJob
=============================================================================
