---------------------- MODULE AdmissionAccounting ----------------------
EXTENDS Naturals, TLC
CONSTANTS Scenario, Bug, Witness
\* Composition contract with Admission (no shared mutable variables): Reserve
\* supplies the durable hold for Admission.Reserve; Cleanup supplies Admission.cleanup, never closed;
\* SettleNative/ReleaseUnstarted supply closed only with proof and zero liability.
\* Measured inputs are trusted coverage, not fresh receipts. Eq.17's unknown
\* envelope branch has room zero and is outside this accounting-only quotient.
\* Two fixed attempt ids, short/weekly scopes, one burn per attempt per scope,
\* one aggregate and one restart. No reset, optimizer or process-launch proof.
VARIABLES a, revision, reads, meter, events, incarnation, preview, previewRoom, third
vars == <<a, revision, reads, meter, events, incarnation, preview, previewRoom, third>>
Jobs == {1,2}
Limits == {"short","weekly"}
Zero == [r \in Limits |-> 0]
Quote == [r \in Limits |-> IF Scenario = "race" /\ r = "short" THEN 2 ELSE 1]
Cap == [r \in Limits |-> IF Scenario = "race" /\ r = "short" THEN 3 ELSE 2]
Empty == [reserved |-> FALSE, started |-> FALSE, cleanup |-> FALSE,
 closed |-> FALSE, native |-> Scenario = "native", held |-> Zero,
 spent |-> Zero, pending |-> Zero, released |-> Zero, burn |-> 0]
Liability(r) == a[1].held[r]+a[2].held[r]+a[1].pending[r]+a[2].pending[r]
\* lib/v1/lending-policy.mjs:567-575; lib/v1/lending-pace50-adapter.mjs:122-127 durable genesis/load.
Init == /\ a = [j \in Jobs |-> Empty] /\ revision = 0
 /\ reads = [j \in Jobs |-> 0] /\ meter = Zero /\ events = {}
 /\ incarnation = 1 /\ preview = FALSE /\ previewRoom = Zero /\ third = FALSE
\* lib/v1/lending-pace50-adapter.mjs:475-511 queue + CAS; lib/v1/lending-policy.mjs:1380 duplicate and 1404-1412 native gate.
Reserve(j) == /\ ~a[j].reserved /\ (Scenario # "replace" \/ j = 1 \/ a[1].reserved)
 /\ (Bug = "race" \/ reads[j] = revision)
 /\ (Scenario # "native" \/ \A k \in Jobs : ~a[k].reserved \/
      (IF Bug = "native" THEN a[k].cleanup ELSE a[k].closed))
 /\ \A r \in Limits : Quote[r] + (IF Bug = "race" THEN 0 ELSE meter[r]+Liability(r)) <= Cap[r]
 /\ a' = [a EXCEPT ![j].reserved = TRUE, ![j].held = Quote]
 /\ revision' = revision+1
 /\ UNCHANGED <<reads,meter,events,incarnation,preview,previewRoom,third>>
\* lib/v1/lending-pace50-adapter.mjs:475-511 retry captures latest revision, not a second allocation.
Read(j) == /\ reads[j] # revision /\ reads' = [reads EXCEPT ![j] = revision]
 /\ UNCHANGED <<a,revision,meter,events,incarnation,preview,previewRoom,third>>
\* lib/v1/lending-policy.mjs:1380, 788 duplicate attempt/event refusal (stuttering retry).
DuplicateReserveEvent == UNCHANGED vars
 \/ /\ Bug = "duplicate" /\ a[1].reserved /\ a[1].held = Quote
    /\ "retry" \notin events
    /\ a' = [a EXCEPT ![1].held = [r \in Limits |-> 2*Quote[r]]]
    /\ events' = events \cup {"retry"} /\ revision' = revision+1
    /\ UNCHANGED <<reads,meter,incarnation,preview,previewRoom,third>>
\* lib/v1/lending-policy.mjs:929-975 started event; launch fidelity delegated to Lease contract.
Start(j) == /\ a[j].reserved /\ ~a[j].started /\ ~a[j].closed
 /\ a' = [a EXCEPT ![j].started = TRUE]
 /\ revision' = revision+1
 /\ UNCHANGED <<reads,meter,events,incarnation,preview,previewRoom,third>>
\* lib/v1/lending-policy.mjs:1011-1038 burn identity and complete vector; one burn id per attempt.
Usage(j) == /\ Scenario = "aggregate" /\ a[j].started /\ a[j].burn = 0
 /\ a' = [a EXCEPT ![j].held = Zero, ![j].spent = Quote,
                          ![j].pending = Quote, ![j].burn = j]
 /\ events' = events \cup {j}
 /\ revision' = revision+1
 /\ UNCHANGED <<reads,meter,incarnation,preview,previewRoom,third>>
\* lib/v1/lending-policy.mjs:1140-1151 backend proof persists cessation, never a refund.
Cleanup(j) == /\ a[j].started /\ ~a[j].cleanup
 /\ a' = [a EXCEPT ![j].cleanup = TRUE,
      ![j].released = IF Bug = "cleanup" THEN a[j].held ELSE a[j].released,
      ![j].held = IF Bug = "cleanup" THEN Zero ELSE @]
 /\ revision' = revision+1
 /\ UNCHANGED <<reads,meter,events,incarnation,preview,previewRoom,third>>
\* lib/v1/lending-policy.mjs:604-624,1040-1077 complete aggregate covers ALL eligible burns.
\* Bug accepts one increment against two burns (double attribution).
AcceptAggregate(amount) == /\ Scenario = "aggregate" /\ events = Jobs /\ meter = Zero
 /\ a[1].cleanup /\ a[2].cleanup
 /\ (Bug = "aggregate" \/ amount = 2)
 /\ meter' = [r \in Limits |-> amount]
 /\ a' = [j \in Jobs |-> [a[j] EXCEPT !.pending = Zero]]
 /\ revision' = revision+1
 /\ UNCHANGED <<reads,events,incarnation,preview,previewRoom,third>>
\* lib/v1/lending-policy.mjs:1152-1186 post-proof, complete native meter charges one-point floor.
\* Meter coverage is an external trusted fact, not the 120s product timer.
SettleNative(j) == /\ Scenario = "native" /\ a[j].started /\ (a[j].cleanup \/ Bug = "proof") /\ ~a[j].closed
 /\ a' = [a EXCEPT ![j].held = Zero, ![j].spent = Quote, ![j].closed = TRUE]
 /\ meter' = [r \in Limits |-> meter[r]+Quote[r]]
 /\ revision' = revision+1
 /\ UNCHANGED <<reads,events,incarnation,preview,previewRoom,third>>
\* lib/v1/lending-policy.mjs:1078-1139 covered measured burn plus authoritative cessation closes hold.
CloseMeasured(j) == /\ Scenario = "aggregate" /\ a[j].cleanup /\ ~a[j].closed
 /\ a[j].burn # 0 /\ a[j].pending = Zero
 /\ a' = [a EXCEPT ![j].held = Zero, ![j].closed = TRUE,
     ![j].released = a[j].held]
 /\ revision' = revision+1
 /\ UNCHANGED <<reads,meter,events,incarnation,preview,previewRoom,third>>
\* lib/v1/lending-policy.mjs:1078-1139 cessation_proven for not_started: no dispatch and no usage.
ReleaseUnstarted(j) == /\ a[j].reserved /\ ~a[j].started /\ ~a[j].closed
 /\ a' = [a EXCEPT ![j].held = Zero, ![j].released = Quote, ![j].cleanup = TRUE, ![j].closed = TRUE]
 /\ revision' = revision+1
 /\ UNCHANGED <<reads,meter,events,incarnation,preview,previewRoom,third>>
\* lib/v1/lending-pace50-adapter.mjs:453 removes exactly replacingAttemptId from a read-only copy.
ReplacePreview == /\ Scenario = "replace" /\ a[1].reserved /\ a[2].reserved
 /\ ~preview /\ preview' = TRUE
 /\ previewRoom' = [r \in Limits |-> Cap[r] - meter[r] -
     (IF Bug = "replace" THEN 0 ELSE a[2].held[r]+a[2].pending[r])]
 /\ UNCHANGED <<a,revision,reads,meter,events,incarnation,third>>
\* lib/v1/lending-policy.mjs:1420-1487 admission witness only: wrongly excluded liability is usable.
ThirdAdmission == /\ ~third
 /\ ((Scenario = "replace" /\ preview /\ a[2].held["short"] > 0 /\ previewRoom["short"] >= 2) \/
    (Scenario = "cleanup" /\ a[1].started /\ a[1].cleanup /\ ~a[1].closed /\
      (\A r \in Limits : meter[r]+Liability(r)+2 <= Cap[r])))
 /\ third' = TRUE
 /\ UNCHANGED <<a,revision,reads,meter,events,incarnation,preview,previewRoom>>
\* lib/v1/lending-pace50-adapter.mjs:131-145 poisoned writer reopens durable state, never repeats effects.
CrashAfterWrite == /\ incarnation = 1 /\ revision > 0 /\ incarnation' = 2
 /\ UNCHANGED <<a,revision,reads,meter,events,preview,previewRoom,third>>
Next == (~preview /\ (\E j \in Jobs : Reserve(j) \/ Read(j) \/ Start(j) \/ Usage(j) \/ Cleanup(j)
                       \/ SettleNative(j) \/ CloseMeasured(j) \/ ReleaseUnstarted(j)))
 \/ (\E amount \in 1..2 : AcceptAggregate(amount)) \/ ReplacePreview \/ ThirdAdmission \/ CrashAfterWrite \/ DuplicateReserveEvent
Spec == Init /\ [][Next]_vars
\* Executable interface to Admission's closure predicate for each fixed attempt.
\* This checks the shared proof/hold boundary, not a refinement of Admission.Next.
AdmissionSlice(j) == INSTANCE Admission WITH
 Fixed <- TRUE, Scenario <- "known", CancelSafe <- TRUE, RecheckSafe <- TRUE,
 \* Native release state is unused by this non-native ClosedHasProof projection.
 NativeHeadroom <- 2, NextReservation <- 1, covered <- FALSE, nativeReleased <- FALSE,
 \* The cancellation slice is idle here; ClosedHasProof depends only on cleanup and liabilities.
 race <- [saved |-> "usable", latest |-> "good", read |-> "idle",
          first |-> "none", cached |-> "none", start |-> "none",
          firstSaved |-> "usable", firstLatest |-> "good", newer |-> FALSE, revisionChanged |-> FALSE],
 phase <- (IF a[j].closed THEN "closed" ELSE "reserved"),
 age <- "fresh", failed <- FALSE, scope <- 0,
 held <- a[j].held["short"], pending <- a[j].pending["short"],
 cleanup <- a[j].cleanup, closed <- a[j].closed,
 usage <- (IF a[j].burn = 0 THEN "unknown" ELSE "known"),
 decision <- "none", restarted <- (incarnation = 2), rejected <- FALSE, swept <- FALSE
AdmissionContract == \A j \in Jobs : AdmissionSlice(j)!ClosedHasProof
Conservation == \A j \in Jobs, r \in Limits : a[j].reserved =>
 Quote[r] = a[j].held[r]+a[j].spent[r]+a[j].released[r]
Room == \A r \in Limits : meter[r]+Liability(r) <= Cap[r]
Coverage == \A r \in Limits : a[1].spent[r]+a[2].spent[r] <=
 meter[r]+a[1].pending[r]+a[2].pending[r]
UnknownRetained == \A j \in Jobs : a[j].cleanup /\ a[j].burn = 0 /\ ~a[j].closed => a[j].held = Quote
NativeExclusive == Scenario = "native" => ~(a[1].reserved /\ ~a[1].closed /\ a[2].reserved /\ ~a[2].closed)
OwnHoldOnly == ~third
NoPrematureAdmission == ~third
Boundary == CASE Scenario = "race" -> a[1].reserved /\ a[2].reserved
 [] Scenario = "aggregate" -> meter["short"] > 0
 [] Scenario = "cleanup" -> a[1].cleanup
 [] Scenario = "native" -> a[1].closed /\ a[2].reserved
 [] OTHER -> preview
NoBoundary == ~Boundary
Checked == CASE Witness -> NoBoundary
 [] Scenario = "race" -> Room
 [] Scenario = "aggregate" -> Coverage
 [] Scenario = "cleanup" -> UnknownRetained
 [] Scenario = "native" -> NativeExclusive
 [] OTHER -> OwnHoldOnly
=============================================================================
