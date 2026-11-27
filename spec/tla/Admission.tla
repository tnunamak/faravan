---------------------------- MODULE Admission ----------------------------
EXTENDS Naturals, TLC
CONSTANTS Fixed, Scenario, CancelSafe, RecheckSafe, NativeHeadroom, NextReservation
\* Citations refer to base a9f7bdf7 unless marked Fixed (73cab697).
\* Finite quotient: one representative hold; "multiple" means another identical
\* open hold prevents unique attribution. Values are quota units, not dollars.
VARIABLES phase, age, failed, scope, held, pending, cleanup, closed, usage,
          decision, restarted, rejected, swept, race, covered, nativeReleased
vars == <<phase, age, failed, scope, held, pending, cleanup, closed, usage,
          decision, restarted, rejected, swept, race, covered, nativeReleased>>
NativeScenario == Scenario \in {"native", "native-uncertainty", "native-clear-without-cover"}
CancelScenario == Scenario \in {"cancel-first", "cancel-start", "new-read", "revision", "infrastructure"}
\* lib/v1/lending-policy.mjs:567-575 creates the empty durable state.
Init == /\ phase = "idle" /\ age = "fresh" /\ failed = FALSE
        /\ scope = 0 /\ held = 0 /\ pending = 0 /\ cleanup = FALSE
        /\ closed = FALSE /\ usage = "unknown" /\ decision = "none"
        /\ restarted = FALSE /\ rejected = FALSE /\ swept = FALSE
        /\ covered = FALSE /\ nativeReleased = FALSE
        /\ race = [saved |-> "usable", latest |-> "good", read |-> "idle",
                    first |-> "none", cached |-> "none", start |-> "none",
                    firstSaved |-> "usable", firstLatest |-> "good",
                    newer |-> FALSE, revisionChanged |-> FALSE]
\* lib/v1/lending-pace50-source.mjs:215-232; lib/v1/lending-probe.mjs:417-423. Successful cached windows remain in ledger.
Age == /\ Scenario = "probe" /\ age = "fresh" /\ age' = "aging"
       /\ UNCHANGED <<phase, failed, scope, held, pending, cleanup, closed, usage, decision, restarted, rejected, swept, race, covered, nativeReleased>>
\* lib/v1/lending-pace50-source.mjs:219-232 failed refresh observation.
ProbeFails == /\ Scenario = "probe" /\ age = "aging" /\ ~failed
              /\ failed' = TRUE
              /\ UNCHANGED <<phase, age, scope, held, pending, cleanup, closed, usage, decision, restarted, rejected, swept, race, covered, nativeReleased>>
\* lib/v1/lender-pace50.mjs:788-798; lib/v1/lending-pace50-source.mjs:349-350; lib/v1/lending-policy.mjs:1390-1397.
\* A covering rise consumes the same point of physical headroom that it represents.
NativeAvailableHeadroom == IF covered /\ scope < 2 THEN (IF NativeHeadroom > 0 THEN NativeHeadroom - 1 ELSE 0) ELSE NativeHeadroom
AdmissionReason == IF Scenario = "probe" /\ failed /\ ~Fixed THEN "refresh_failed"
                   ELSE IF Scenario = "cap" /\ ~Fixed THEN "budget_too_small"
                   ELSE IF NativeScenario THEN
                     IF NativeAvailableHeadroom >= NextReservation + held + pending THEN "lend" ELSE "native_attempt_in_flight"
                   ELSE IF held > 0 \/ pending > 0 \/ (cleanup /\ ~closed)
                        THEN IF scope > 0 THEN "cross_window_exposure_unreconciled" ELSE "native_attempt_in_flight"
                   ELSE "lend"
Evaluate == /\ ~CancelScenario /\ decision # AdmissionReason /\ (Scenario # "probe" \/ failed)
 /\ (Scenario \notin {"multiple", "partial", "native", "native-uncertainty", "native-clear-without-cover", "known"} \/ cleanup)
 /\ decision' = AdmissionReason
 /\ UNCHANGED <<phase, age, failed, scope, held, pending, cleanup, closed, usage, restarted, rejected, swept, race, covered, nativeReleased>>
\* lib/v1/lending-policy.mjs:1481-1504 reservation ledger;
\* lib/v1/lender-pace50.mjs:1139-1230 reserve.
Reserve == /\ Scenario \in {"multiple", "partial", "native", "native-uncertainty", "native-clear-without-cover", "known"} /\ phase = "idle"
 /\ phase' = "reserved" /\ held' = 2
 /\ UNCHANGED <<age, failed, scope, pending, cleanup, closed, usage, decision, restarted, rejected, swept, race, covered, nativeReleased>>
\* lib/v1/lending-policy.mjs:929-975; lib/v1/lender-pace50.mjs:1364-1374. Split dispatch from acknowledgement.
Launch == /\ phase = "reserved" /\ phase' = "launched"
 /\ UNCHANGED <<age, failed, scope, held, pending, cleanup, closed, usage, decision, restarted, rejected, swept, race, covered, nativeReleased>>
\* lib/v1/lender-pace50.mjs:1364-1374 records acknowledged start.
Running == /\ phase = "launched" /\ phase' = "running"
 /\ UNCHANGED <<age, failed, scope, held, pending, cleanup, closed, usage, decision, restarted, rejected, swept, race, covered, nativeReleased>>
\* lib/v1/lending-policy.mjs:1008-1029 usage consumes held into pending burn.
KnownUsage == /\ Scenario = "known" /\ phase = "running" /\ usage = "unknown"
 /\ usage' = "known" /\ held' = 0 /\ pending' = 1
 /\ UNCHANGED <<phase, age, failed, scope, cleanup, closed, decision, restarted, rejected, swept, race, covered, nativeReleased>>
\* lib/v1/lending-policy.mjs:1131-1143 cleanup sets ceased but explicitly keeps hold_closed false.
Cleanup == /\ phase = "running" /\ (Scenario # "known" \/ usage = "known") /\ phase' = "ceased" /\ cleanup' = TRUE
 /\ UNCHANGED <<age, failed, scope, held, pending, closed, usage, decision, restarted, rejected, swept, race, covered, nativeReleased>>
\* lib/v1/lending-policy.mjs:1222-1254: charge short maximum, leave weekly unrepresented.
ResetShort == /\ cleanup /\ scope = 0 /\ Scenario = "partial"
 /\ scope' = 1 /\ held' = 0 /\ pending' = 1
 /\ UNCHANGED <<phase, age, failed, cleanup, closed, usage, decision, restarted, rejected, swept, race, covered, nativeReleased>>
\* lib/v1/lending-policy.mjs:1222-1254: every window eventually ends; full unknown maximum charged.
ResetAll == /\ cleanup /\ scope < 2 /\ scope' = 2 /\ held' = 0 /\ pending' = 0
 /\ closed' = TRUE /\ usage' = "maximum" /\ phase' = "closed"
 /\ UNCHANGED <<age, failed, cleanup, decision, restarted, rejected, swept, race, covered, nativeReleased>>
\* lib/v1/lending-runtime.mjs:307-321 supplies a real 30s sweep. lib/v1/lender-pace50.mjs:416-435 refuses multiple
\* attribution; lib/v1/lender-pace50.mjs:901-911 requires old short scope too. Fixed lib/v1/lender-pace50.mjs:1553-1592 charges
\* covered maxima and excludes reset ledgers. Native work closes only after the retained step is covered.
\* An unchanged native reading can replace R only after the lag-covered read; elapsed time alone proves no coverage.
\* An early/no post-delay read cannot replace R. The mutation releases without reading.
NativeBlindSweep == /\ Scenario = "native" /\ ~Fixed /\ cleanup /\ ~closed /\ held = 2 /\ age = "fresh"
 /\ held' = 0 /\ pending' = 1
 /\ UNCHANGED <<phase, age, failed, scope, cleanup, closed, usage, decision, restarted, rejected, swept, race, covered, nativeReleased>>
\* Quotient of a host-owned reading after cleanup + settlement delay, under the meter-lag premise.
NativeLagRead == /\ NativeScenario /\ cleanup /\ age = "fresh"
 /\ age' = "lag-read"
 /\ UNCHANGED <<phase, failed, scope, held, pending, cleanup, closed, usage, decision, restarted, rejected, swept, race, covered, nativeReleased>>
NativeRelease == /\ NativeScenario /\ cleanup /\ age = "lag-read" /\ usage = "unknown" /\ ~closed
 /\ held' = 0 /\ pending' = (IF Scenario = "native-uncertainty" /\ ~Fixed THEN 0 ELSE 1)
 /\ usage' = "meter" /\ nativeReleased' = TRUE
 /\ UNCHANGED <<phase, age, failed, scope, cleanup, closed, decision, restarted, rejected, swept, race, covered>>
\* Only a later aggregate rise establishes coverage of the retained step.
NativeCover == /\ NativeScenario /\ cleanup /\ nativeReleased /\ ~closed /\ ~covered /\ scope = 0
 /\ covered' = TRUE
 /\ UNCHANGED <<phase, age, failed, scope, held, pending, cleanup, closed, usage, decision, restarted, rejected, swept, race, nativeReleased>>
\* Mutation: an unchanged-meter sweep clears the step after a correct release.
NativeClearWithoutCover == /\ Scenario = "native-clear-without-cover" /\ ~Fixed
 /\ nativeReleased /\ ~covered /\ ~closed /\ scope = 0
 /\ held' = 0 /\ pending' = 0 /\ closed' = TRUE /\ phase' = "closed" /\ usage' = "maximum"
 /\ UNCHANGED <<age, failed, scope, cleanup, decision, restarted, rejected, swept, race, covered, nativeReleased>>

Sweep == /\ cleanup /\ ~closed /\ ~swept /\ (Scenario # "partial" \/ scope > 0)
 /\ (~NativeScenario \/ covered)
 /\ swept' = TRUE
 /\ LET canClose == Fixed \/ NativeScenario \/ (usage = "known" /\ scope = 0) IN
      /\ closed' = canClose /\ held' = IF canClose THEN 0 ELSE held
      /\ pending' = IF canClose THEN 0 ELSE pending
      /\ usage' = IF canClose THEN "maximum" ELSE usage
      /\ phase' = IF canClose THEN "closed" ELSE phase
 /\ UNCHANGED <<age, failed, scope, cleanup, decision, restarted, rejected, race, covered, nativeReleased>>
\* lib/v1/lending-pace50-adapter.mjs:122-127 reloads same durable ledger; registry is volatile.
Restart == /\ cleanup /\ ~restarted /\ restarted' = TRUE
 /\ UNCHANGED <<phase, age, failed, scope, held, pending, cleanup, closed, usage, decision, rejected, swept, race, covered, nativeReleased>>
\* lib/v1/lending-policy.mjs:371 rejects different version; lib/v1/lending-pace50-adapter.mjs:127 never replaces with genesis.
LoadOlder == /\ Scenario = "legacy" /\ ~rejected /\ rejected' = TRUE
 /\ UNCHANGED <<phase, age, failed, scope, held, pending, cleanup, closed, usage, decision, restarted, swept, race, covered, nativeReleased>>
\* lib/v1/lending-runtime.mjs:307-321 timer may repeat without changing any durable field.
Tick == UNCHANGED vars

\* New citations: e035f188. Saved ledger windows and latest probe outcome are
\* independent: lending-probe.mjs:362-363,417-423 (failure does not write ledger).
\* lender-pace50.mjs:634-650 -> lending-probe.mjs:283-294 starts shared read.
BeginRead == /\ CancelScenario /\ race.read = "idle"
 /\ race' = [race EXCEPT !.read = "inflight"]
 /\ UNCHANGED <<phase, age, failed, scope, held, pending, cleanup, closed, usage, decision, restarted, rejected, swept, covered, nativeReleased>>
\* lender-pace50.mjs:1318 finally invalidates at reserve; other lifecycle
\* callers:1470,1491,1526,1627. :703-707 abort shared entries; probe:296,362
\* stores cancelled as latest outcome, without replacing the saved windows.
\* Abstract the abort and its drained completion as one action.
InvalidateRead == /\ CancelScenario /\ race.read = "inflight"
 /\ race.start = "none"
 /\ (Scenario = "cancel-first" \/ race.first # "none")
 /\ race' = [race EXCEPT !.read = "cancelled", !.latest = "cancelled"]
 /\ UNCHANGED <<phase, age, failed, scope, held, pending, cleanup, closed, usage, decision, restarted, rejected, swept, covered, nativeReleased>>
RefreshClass(outcome) == CASE outcome = "good" -> "good"
 [] outcome = "cancelled" -> "cancelled"
 [] outcome = "transient" -> "transient"
 [] outcome = "infrastructure" -> IF RecheckSafe THEN "transient" ELSE "invalidating"
 [] OTHER -> "invalidating"
Usable(saved, latest) == saved = "usable" /\ RefreshClass(latest) # "invalidating"
EvidenceReason(saved, latest) == IF Usable(saved, latest) THEN "lend" ELSE "evidence_unusable"
CancelReason == IF ~RecheckSafe /\ (race.newer \/ race.revisionChanged) THEN "controls"
 ELSE IF CancelSafe THEN EvidenceReason(race.saved, race.latest)
 ELSE IF race.saved # "usable" THEN "evidence_unusable"
 ELSE IF race.cached = "cancelled" THEN "quota_unknown" ELSE "lend"
AgeEvidence == /\ CancelScenario /\ CancelSafe /\ race.saved = "usable" /\ race.start = "none"
 /\ race' = [race EXCEPT !.saved = "stale"]
 /\ UNCHANGED <<phase, age, failed, scope, held, pending, cleanup, closed, usage, decision, restarted, rejected, swept, covered, nativeReleased>>
RefreshOutcome == /\ CancelScenario /\ CancelSafe /\ race.start = "none"
 /\ race.latest \in {"good", "cancelled"}
 /\ \E outcome \in (IF Scenario = "infrastructure" THEN {"infrastructure"} ELSE {"transient", "invalidating", "unknown"}):
    race' = [race EXCEPT !.latest = outcome,
      !.saved = IF RefreshClass(outcome) = "invalidating" THEN "invalidated" ELSE @]
 /\ UNCHANGED <<phase, age, failed, scope, held, pending, cleanup, closed, usage, decision, restarted, rejected, swept, covered, nativeReleased>>
\* lender-pace50.mjs:1300-1311 first check uses adapter.admit and
\* lending-pace50-source.mjs:216-217,332-333 attaches cached probe detail;
\* observationProofFailures:357-361 accepts successful saved windows at this check.
FirstCheck == /\ CancelScenario /\ race.first = "none" /\ race.read # "idle"
 /\ (Scenario # "cancel-first" \/ race.read = "cancelled")
 /\ race' = [race EXCEPT !.first = IF CancelSafe THEN EvidenceReason(race.saved, race.latest)
    ELSE IF race.saved = "usable" THEN "lend" ELSE "evidence_unusable",
    !.firstSaved = race.saved, !.firstLatest = race.latest]
 /\ UNCHANGED <<phase, age, failed, scope, held, pending, cleanup, closed, usage, decision, restarted, rejected, swept, covered, nativeReleased>>
\* lender.mjs:983-991 -> lender-pace50.mjs:1360-1381; cached read
\* lending-probe.mjs:417-423 -> source:333 -> observationHold:548-551
\* -> declineCodeFor:60-69. No second reservation is created.
\* lending-pace50-source.mjs:216-217 synchronously samples readings.cached before awaiting
\* funding (:237). A later invalidation cannot alter this sampled outcome.
\* lender-pace50.mjs:634 excludes admissionOnly/excludingAttemptId from shared
\* entries; :648 preserves an unshared result even across invalidation.
PreStartRead == /\ CancelScenario /\ race.first # "none" /\ race.cached = "none"
 /\ race' = [race EXCEPT !.cached = race.latest]
 /\ UNCHANGED <<phase, age, failed, scope, held, pending, cleanup, closed, usage, decision, restarted, rejected, swept, covered, nativeReleased>>
\* Compatible successful evidence and unrelated meter receipts can land across the preview await.
NewerSuccessfulRead == /\ Scenario = "new-read" /\ race.cached # "none" /\ race.start = "none" /\ ~race.newer
 /\ race' = [race EXCEPT !.newer = TRUE, !.saved = "usable", !.latest = "good"]
 /\ UNCHANGED <<phase, age, failed, scope, held, pending, cleanup, closed, usage, decision, restarted, rejected, swept, covered, nativeReleased>>
UnrelatedStateRevision == /\ Scenario = "revision" /\ race.cached # "none" /\ race.start = "none" /\ ~race.revisionChanged
 /\ race' = [race EXCEPT !.revisionChanged = TRUE]
 /\ UNCHANGED <<phase, age, failed, scope, held, pending, cleanup, closed, usage, decision, restarted, rejected, swept, covered, nativeReleased>>
UsableChangeStillAdmits == race.start # "none" /\ Usable(race.saved, race.latest)
 /\ (race.newer \/ race.revisionChanged) => race.start = "lend"

PreStartCheck == /\ CancelScenario /\ race.first # "none"
 /\ race.cached # "none" /\ race.start = "none"
 /\ race' = [race EXCEPT !.start = CancelReason]
 /\ UNCHANGED <<phase, age, failed, scope, held, pending, cleanup, closed, usage, decision, restarted, rejected, swept, covered, nativeReleased>>
CancelledCacheContinuity == CancelScenario /\ race.saved = "usable"
 => race.first # "quota_unknown" /\ race.start # "quota_unknown"

DispatchImpliesUsable == race.start = "lend" => Usable(race.saved, race.latest)
GateAgreement == race.start # "none" /\ race.firstSaved = race.saved /\ race.firstLatest = race.latest
 /\ ~(race.newer \/ race.revisionChanged) => race.first = race.start
TransientKeepsEvidence == [][RefreshOutcome /\ race'.latest \in {"transient", "infrastructure"} => race'.saved = race.saved]_vars
InvalidatingRefusesBoth == (race.firstLatest \in {"invalidating", "unknown"} => race.first # "lend")
 /\ (race.latest \in {"invalidating", "unknown"} /\ race.start # "none" => race.start # "lend")

Next == NativeCover \/ NativeClearWithoutCover \/ NativeLagRead \/ NativeRelease \/ NativeBlindSweep \/ NewerSuccessfulRead \/ UnrelatedStateRevision \/ AgeEvidence \/ RefreshOutcome \/ BeginRead \/ InvalidateRead \/ FirstCheck \/ PreStartRead \/ PreStartCheck \/ Age \/ ProbeFails \/ Evaluate \/ Reserve \/ Launch \/ Running \/ Cleanup
        \/ KnownUsage \/ ResetShort \/ ResetAll \/ Sweep \/ Restart \/ LoadOlder \/ Tick
Spec == Init /\ [][Next]_vars /\ WF_vars(NativeLagRead) /\ WF_vars(NativeRelease) /\ WF_vars(BeginRead) /\ WF_vars(InvalidateRead)
 /\ WF_vars(FirstCheck) /\ WF_vars(PreStartRead) /\ WF_vars(PreStartCheck) /\ WF_vars(Age) /\ WF_vars(ProbeFails)
 /\ WF_vars(Evaluate) /\ WF_vars(Reserve) /\ WF_vars(Launch) /\ WF_vars(Running)
 /\ WF_vars(KnownUsage) /\ WF_vars(Cleanup) /\ WF_vars(Sweep) /\ WF_vars(LoadOlder) /\ WF_vars(ResetShort)
\* Distinguish convergence on covering evidence from eventual closure at week end.
TimeSpec == Spec /\ WF_vars(ResetAll)
TypeOK == /\ covered \in BOOLEAN /\ nativeReleased \in BOOLEAN /\ NativeHeadroom \in Nat /\ NextReservation \in Nat
 /\ held \in 0..2 /\ pending \in 0..1 /\ scope \in 0..2
 /\ race.saved \in {"usable", "stale", "invalidated"}
 /\ race.latest \in {"good", "cancelled", "transient", "infrastructure", "invalidating", "unknown"}
 /\ race.read \in {"idle", "inflight", "cancelled"}
 /\ race.cached \in {"none", "good", "cancelled", "transient", "infrastructure", "invalidating", "unknown"}
 /\ race.first \in {"none", "lend", "evidence_unusable"}
 /\ race.start \in {"none", "lend", "quota_unknown", "evidence_unusable", "controls"}
CancelChecksComplete == CancelScenario => <> (race.first # "none" /\ race.start # "none")
NativeBlindRetained == Scenario = "native" /\ cleanup /\ ~closed /\ age = "fresh" => held + pending = 2
NativeUncertaintyRetained == NativeScenario /\ nativeReleased /\ ~covered /\ scope < 2 => held + pending >= 1
NativeClosedHasCoverage == (closed /\ NativeScenario) => covered \/ scope = 2
NativeAdmissionRule == NativeScenario /\ nativeReleased /\ scope = 0 =>
 ((AdmissionReason = "lend") <=> (NativeAvailableHeadroom >= NextReservation + held + pending))
ClosedHasProof == closed => (cleanup /\ held = 0 /\ pending = 0)
ResetWindowExcluded == scope > 0 => held = 0
CacheContinuity == Scenario = "probe" => decision # "refresh_failed"
DefaultCoversCall == Scenario = "cap" => decision # "budget_too_small"
LegacyRejected == Scenario = "legacy" /\ rejected => phase = "idle"
\* No fairness assumption forces a later rise. An unchanged native meter may retain U until reset.
CleanupReady == cleanup /\ (~NativeScenario \/ covered \/ scope = 2)
CleanupCloses == CleanupReady ~> closed
CleanupIdleLends == (CleanupReady /\ (~NativeScenario \/ NativeAvailableHeadroom >= NextReservation)) ~> (decision = "lend")
NativeHeadroomLends == (NativeScenario /\ NativeHeadroom >= NextReservation + 1) => (cleanup ~> (decision = "lend"))
IdleEventuallyLends == Scenario \in {"probe", "cap"} => <> (decision = "lend")
CoveredSweepCloses == swept => closed
=============================================================================
