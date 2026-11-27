---------------------- MODULE LaunchComposition ----------------------
EXTENDS Naturals, TLC
CONSTANT Mode
\* One job, one quota unit, two process incarnations. Crash preserves durable
\* state and the backend; it loses authorization and arms. No clock arithmetic.
\* Admission contract: held denotes a sufficient DURABLE hold, not a fresh
\* estimate. Eq.17 soundness belongs upstream: absent envelopes use Q.
\* LendingLease contract: registry authorization is not dispatch or execution;
\* observation persistence and coordinator acceptance precede the guest ack.
\* These are interface contracts, not an INSTANCE/refinement proof of either
\* existing module. Filesystem durability and backend removal are trusted seams.
VARIABLE s
vars == <<s>>
UpgradeMode == Mode \in {"upgrade", "upgrade-bug", "upgrade-present", "upgrade-unverified"}
Init == s = [ph |-> "hold", inc |-> 1, revision |-> 0, held |-> FALSE, holdId |-> 0, lockOwner |-> 1, cleanupId |-> 0,
  armed |-> FALSE, callbackPending |-> FALSE, authorized |-> FALSE, pending |-> FALSE,
  requested |-> FALSE, dispatches |-> 0, observed |-> FALSE, accepted |-> FALSE,
  ack |-> FALSE, running |-> FALSE, removed |-> FALSE,
  owned |-> FALSE, journalCreated |-> FALSE, closing |-> FALSE, drained |-> FALSE, released |-> FALSE,
  poisoned |-> FALSE, late |-> FALSE, unsafeStart |-> FALSE,
  recovery |-> FALSE, release |-> "previous", recordFormat |-> "none",
  owner |-> "none", sandbox |-> "absent",
  absenceVerified |-> FALSE, holdEnded |-> FALSE,
  crashed |-> FALSE, shut |-> FALSE, resolved |-> FALSE, crashGap |-> FALSE, at |-> "none"]
\* lib/v1/lending-pace50-adapter.mjs:274-286 persist before effects.
PersistHold == /\ s.ph = "hold" /\ ~s.closing
  /\ s' = [s EXCEPT !.ph = "arm", !.held = TRUE, !.holdId = 1, !.revision = 1]

\* lib/v1/lending-pace50-adapter.mjs:135-144; lib/durable-write.mjs:10-43 write/rename/fsync seam.
PersistFault == /\ ~UpgradeMode /\ s.ph = "hold" /\ ~s.closing
  /\ \E durable \in BOOLEAN :
      s' = [s EXCEPT !.ph = "fault", !.held = durable, !.holdId = IF durable THEN 1 ELSE 0,
        !.revision = IF durable THEN 1 ELSE 0, !.poisoned = TRUE]

\* lib/v1/lending-pace50-adapter.mjs:232 await may outlive close.
AwaitArm == /\ s.ph = "arm" /\ ~s.closing
  /\ s' = [s EXCEPT !.ph = "arming", !.callbackPending = TRUE]

\* lib/v1/lending-pace50-adapter.mjs:229-242; early mode skips persist.
Arm == /\ (s.ph = "arming" \/ (Mode = "early" /\ s.ph = "hold")) /\ ~s.closing
  /\ s' = [s EXCEPT !.ph = "authorize", !.armed = TRUE, !.callbackPending = FALSE]

\* lib/v1/lending-pace50-adapter.mjs:217-225,244-248; registry only.
Authorize == /\ s.ph = "authorize" /\ s.armed /\ ~s.closing
  /\ s' = [s EXCEPT !.ph = "pending", !.authorized = TRUE]

\* lib/v1/lender.mjs:895-901,961,976-978 journal before backend.
PersistPending == /\ s.ph = "pending" /\ ~s.closing
  /\ s' = [s EXCEPT !.ph = "request", !.pending = TRUE, !.journalCreated = TRUE]

\* lib/v1/lender.mjs:976-995 intent save precedes coordinator/final admission.
PersistStartIntent == /\ s.ph = "request" /\ ~s.closing
  /\ s' = [s EXCEPT !.ph = "dispatch", !.requested = TRUE]

\* lib/v1/lender.mjs:978-995,1028 actual backend.start, not launch_chunk.
Dispatch == /\ s.ph = "dispatch" /\ ~s.closing /\ s.authorized
  /\ s' = [s EXCEPT !.ph = "observe", !.dispatches = s.dispatches + 1, !.unsafeStart = (~s.held \/ s.holdId # 1),
      !.recordFormat = IF UpgradeMode THEN (IF s.release = "previous" THEN "old" ELSE "new") ELSE s.recordFormat,
      !.sandbox = IF Mode = "upgrade-present" THEN "present" ELSE s.sandbox]

\* lib/v1/lender.mjs:1010-1014 callback saves observation intent.
PersistStartObservation == /\ s.ph = "observe" /\ ~s.closing
  /\ s' = [s EXCEPT !.ph = "accept", !.observed = TRUE]

\* lib/v1/lender.mjs:1014 recoverObservation sends the durable intent.
AcceptStartObservation == /\ s.ph = "accept" /\ ~s.closing
  /\ s' = [s EXCEPT !.ph = "ack", !.accepted = TRUE]

\* lib/v1/lender.mjs:1014-1018; lib/docker-backend.mjs:2385-2389 guest ack gate.
AckGate == /\ s.ph = "ack" /\ ~s.closing
  /\ s' = [s EXCEPT !.ph = "running", !.ack = TRUE, !.running = TRUE]

\* lib/v1/lender.mjs:1396-1433 restart reads journal; adapter:175-178 volatile arms.
Crash == /\ (IF UpgradeMode THEN ~s.crashed ELSE s.inc = 1) /\ ~s.released
  /\ s' = [s EXCEPT !.inc = s.inc + 1, !.crashed = TRUE, !.lockOwner = 2,
      !.crashGap = (s.crashGap \/ (UpgradeMode /\ s.resolved /\ ~s.holdEnded)), !.ph = "recover", !.armed = FALSE, !.authorized = FALSE, !.closing = FALSE, !.poisoned = FALSE, !.recovery = TRUE, !.drained = FALSE, !.callbackPending = FALSE]

\* lib/v1/lender.mjs:1409-1419 identity-matched backend proof, never re-launch.
\* Upgrade modes: the previous release removes and deletes its own v1 row; the
\* current release may not touch a v1 row it did not write until it is resolved.
RecoverRemove == /\ s.ph = "recover" /\ (~UpgradeMode \/ s.release = "previous" \/ s.recordFormat # "old")
  /\ s' = [s EXCEPT !.ph = "handoff", !.removed = TRUE, !.cleanupId = 1, !.running = FALSE,
      !.recordFormat = IF UpgradeMode THEN "none" ELSE s.recordFormat,
      !.absenceVerified = s.absenceVerified \/ UpgradeMode,
      !.sandbox = IF UpgradeMode THEN "absent" ELSE s.sandbox, !.dispatches = IF Mode = "replay" /\ s.dispatches > 0 THEN s.dispatches + 1 ELSE s.dispatches]

\* lib/v1/lender.mjs:1412-1413 unknown removal retains entire reservation.
UnknownDispatch == /\ ~UpgradeMode /\ s.ph = "recover" /\ s.requested
  /\ s' = [s EXCEPT !.ph = "unknown", !.held = IF Mode = "refund" THEN FALSE ELSE s.held]

\* lib/v1/lender.mjs:1418-1433 removal/settlement must be durable before journal clears.
PersistCandidateOwnership == /\ s.ph = "handoff" /\ ~s.closing /\ ~s.released
  /\ s' = [s EXCEPT !.ph = "clear", !.owned = TRUE]

\* lib/v1/lender.mjs:1418,1424-1432 failed candidate persistence retains journal.
CandidateSaveFault == /\ ~UpgradeMode /\ s.ph = "handoff" /\ s.pending
  /\ s' = [s EXCEPT !.ph = "savefault", !.pending = IF Mode = "discard" THEN FALSE ELSE s.pending]

\* lib/v1/lender.mjs:1418-1433,1473-1480 ownership before journal deletion.
ClearPending == /\ s.ph = "clear"
  /\ s' = [s EXCEPT !.ph = "done", !.pending = FALSE]

\* lib/v1/lending-pace50-adapter.mjs:589-595 close fences new actions.
CloseBegin == /\ ~s.closing /\ ~s.released /\ ~s.shut
  /\ s' = [s EXCEPT !.closing = TRUE, !.shut = UpgradeMode]

\* lib/v1/lending-pace50-adapter.mjs:593-595 bounded queue drain.
DrainExpire == /\ s.closing /\ ~s.drained
  /\ s' = [s EXCEPT !.drained = TRUE]

\* lib/v1/lending-pace50-adapter.mjs:596-607 dispose arms then release writer.
LockRelease == /\ s.drained /\ ~s.released
  /\ s' = [s EXCEPT !.released = TRUE, !.lockOwner = 0, !.armed = FALSE, !.authorized = FALSE]

\* lib/v1/lending-pace50-adapter.mjs:180-185,233-236 late arm disposed, queued write refused.
LateCallback == /\ s.released /\ s.callbackPending /\ ~s.late
  /\ s' = [s EXCEPT !.late = TRUE, !.callbackPending = FALSE, !.armed = Mode = "late", !.authorized = Mode = "late", !.revision = IF Mode = "late" THEN s.revision + 1 ELSE s.revision]

\* lib/v1/lender.mjs:1013-1018 gate intentionally bypassed by mutation.
EarlyAck == /\ Mode = "noack" /\ s.ph = "observe"
  /\ s' = [s EXCEPT !.ph = "running", !.running = TRUE, !.ack = TRUE]

\* `at = "recover"` means a crash preceded Upgrade (captured here, not read later).
\* Upgrade is a restart under new code and fires from ANY previous-release phase
\* (running, recovering, handing off, clearing, closed). It rewrites no record.
Upgrade == /\ UpgradeMode /\ s.release = "previous"
 /\ s' = [s EXCEPT !.release = "current", !.inc = s.inc + 1, !.lockOwner = 2, !.ph = "recover",
      !.armed = FALSE, !.authorized = FALSE, !.closing = FALSE, !.released = FALSE, !.drained = FALSE,
      !.poisoned = FALSE, !.recovery = TRUE, !.callbackPending = FALSE,
      !.at = IF s.ph = "running" THEN "run"
             ELSE IF s.ph = "recover" /\ s.crashed /\ s.recordFormat = "old" THEN "recover"
             ELSE IF s.ph \in {"handoff", "clear"} THEN "cleanup" ELSE "other"]
\* Restart after an orderly close; a daemon that never restarts is excluded.
Restart == /\ UpgradeMode /\ s.released
 /\ s' = [s EXCEPT !.ph = "recover", !.inc = s.inc + 1, !.lockOwner = 2, !.released = FALSE, !.closing = FALSE,
      !.drained = FALSE, !.recovery = TRUE]
\* A running job ends; cleanup then follows the ordinary recovery path.
Finish == /\ UpgradeMode /\ s.ph = "running" /\ ~s.closing
 /\ s' = [s EXCEPT !.ph = "recover", !.running = FALSE]
\* Durable cleanup and ownership precede settlement of the hold.
Settle == /\ UpgradeMode /\ s.ph = "done" /\ ~s.holdEnded
 /\ s' = [s EXCEPT !.held = FALSE, !.holdEnded = TRUE]
\* The owner may remove a present legacy sandbox. No unverified automatic rm.
OwnerCleanup == /\ UpgradeMode /\ s.ph = "recover" /\ s.release = "current"
 /\ s.recordFormat = "old" /\ s.sandbox = "present"
 /\ s' = [s EXCEPT !.sandbox = "absent"]
\* Trusted complete HOME/daemon/inventory/process evidence, not empty listing.
VerifyAbsence == /\ UpgradeMode /\ s.ph = "recover" /\ s.release = "current"
 /\ s.recordFormat = "old" /\ s.sandbox = "absent"
 /\ ~s.absenceVerified /\ Mode # "upgrade-unverified"
 /\ s' = [s EXCEPT !.absenceVerified = TRUE]
ResolveOldCleanup == /\ UpgradeMode /\ s.ph = "recover" /\ s.release = "current" /\ s.absenceVerified
 /\ s.recordFormat = "old" /\ Mode # "upgrade-bug"
 /\ s' = [s EXCEPT !.recordFormat = "none", !.removed = TRUE, !.cleanupId = 1, !.resolved = TRUE, !.running = FALSE]
\* Owner release of the ownerless attempt, after the old row is gone and
\* absence is verified. No new create receipt is invented.
ReleaseOldPending == /\ UpgradeMode /\ s.ph = "recover" /\ s.release = "current" /\ s.absenceVerified
 /\ s.recordFormat = "none" /\ s.removed /\ (s.owner # "none" \/ Mode # "upgrade-bug")
 /\ s' = [s EXCEPT !.held = FALSE, !.pending = FALSE, !.holdEnded = TRUE, !.owned = TRUE, !.ph = "done"]
Next == Upgrade \/ Restart \/ Finish \/ Settle \/ OwnerCleanup \/ VerifyAbsence \/ ResolveOldCleanup \/ ReleaseOldPending \/ AwaitArm \/ PersistHold \/ PersistFault \/ Arm \/ Authorize \/ PersistPending \/ PersistStartIntent \/ Dispatch \/ PersistStartObservation \/ AcceptStartObservation \/ AckGate \/ Crash \/ RecoverRemove \/ UnknownDispatch \/ PersistCandidateOwnership \/ CandidateSaveFault \/ ClearPending \/ CloseBegin \/ DrainExpire \/ LockRelease \/ LateCallback \/ EarlyAck \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
 /\ WF_vars(Upgrade) /\ WF_vars(Restart) /\ WF_vars(Finish) /\ WF_vars(Settle)
 /\ WF_vars(OwnerCleanup) /\ WF_vars(VerifyAbsence)
 /\ WF_vars(ResolveOldCleanup) /\ WF_vars(ReleaseOldPending)
 /\ WF_vars(PersistHold) /\ WF_vars(AwaitArm) /\ WF_vars(Arm) /\ WF_vars(Authorize)
 /\ WF_vars(PersistPending) /\ WF_vars(PersistStartIntent) /\ WF_vars(Dispatch)
 /\ WF_vars(PersistStartObservation) /\ WF_vars(AcceptStartObservation) /\ WF_vars(AckGate)
 /\ WF_vars(RecoverRemove) /\ WF_vars(PersistCandidateOwnership) /\ WF_vars(ClearPending)
 /\ WF_vars(DrainExpire) /\ WF_vars(LockRelease)
HoldLiveness == s.held ~> s.holdEnded
VerifiedRelease == UpgradeMode =>
 ((s.holdEnded \/ s.removed) => (s.absenceVerified /\ s.sandbox = "absent"))
W_UpgradeEnd == ~s.holdEnded
W_UpgradeBlocked == ~(s.release = "current" /\ s.held /\ ~s.absenceVerified)
W_UpgradeRun == s.at # "run"
W_UpgradeRecovery == s.at # "recover"
W_UpgradeCleanup == ~(s.at = "cleanup" /\ s.held)
W_UpgradeCrashGap == ~s.crashGap

\* History flags preserve violations after cleanup or crash.
DurableBeforeDispatch == ~s.unsafeStart
NoLaunchReplay == s.dispatches <= 1
UnknownRetainsHold == (s.requested /\ s.cleanupId # 1) => s.held
NoLateEffect == s.late => (s.lockOwner # 1 /\ ~s.armed /\ ~s.authorized /\ s.revision <= 1)
JournalOwnership == (s.journalCreated /\ ~s.pending) => s.owned
AckHasObservation == s.running => (s.ack /\ s.observed /\ s.accepted /\ s.dispatches > 0)
W_Hold == ~(s.held /\ s.ph = "arm")
W_Dispatch == ~(s.dispatches = 1 /\ ~s.observed)
W_Recovery == ~(s.recovery /\ s.dispatches = 1 /\ s.removed)
W_Unknown == ~(s.ph = "unknown" /\ s.held)
W_Late == ~s.late
W_Journal == ~(s.ph = "savefault" /\ s.pending /\ ~s.owned)
W_Ack == ~s.running
=============================================================================
