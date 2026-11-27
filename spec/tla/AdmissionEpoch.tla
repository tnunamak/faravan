--------------------------- MODULE AdmissionEpoch ---------------------------
EXTENDS Naturals, FiniteSets
CONSTANT Mode, Boundary
\* Contract composition, not the Cartesian product of Admission and Lease:
\* Admission's held/pending liabilities survive cessation; Lease I4/A5/A6
\* supply durable attempt-bound removal, never a proof for a newer execution.
\* One parent, one carry, two process incarnations, two limits; Q=2.
\* No certified incremental envelope is assumed: an unresolved successor
\* carries Q, not a freshness-derived rate. No monetary Stop theorem is claimed.
VARIABLE s
vars == <<s>>
Tuple(a,p,e,i) == <<a,p,e,i>>
Old == Tuple(0,0,0,0)
\* lib/v1/lending-policy.mjs:1492-1534: durable hold before dispatch.
Init == s = [account |-> 0, provider |-> 0, epoch |-> 0,
  short |-> 0, week |-> 0, now |-> 0, cold |-> TRUE, bound |-> FALSE,
  stopped |-> FALSE, checked |-> FALSE, deadline |-> 2,
  gen |-> 1, proofGen |-> 1, late |-> FALSE, cleanup |-> FALSE,
  held |-> <<2,2>>, pending |-> <<0,0>>, charged |-> <<0,0>>,
  carry |-> FALSE, carryScope |-> Old, parent |-> 0, successor |-> 0, carryPending |-> 0,
  settled |-> FALSE, admitted |-> FALSE, accepted |-> FALSE, checkedScope |-> Old,
  proofReceived |-> FALSE, seen |-> {}]
\* lib/v1/lending-policy.mjs:1234-1267; independent short reset.
ShortReset == /\ s.short = 0
 /\ s' = [s EXCEPT !.short = 1, !.now = 2, !.seen = @ \cup {"short"}]
\* lib/v1/lending-policy.mjs:863-880; weekly epoch does not identify short.
WeekAdvance == /\ s.week = 0 /\ s.short = 1
 /\ s' = [s EXCEPT !.week = 1, !.epoch = 1, !.now = 3,
                   !.seen = @ \cup {"week"}]
\* lib/v1/lending-native-guard.mjs:119-133: positive identity change stops.
AccountChange == /\ s.account = 0
 /\ s' = [s EXCEPT !.account = 1, !.seen = @ \cup {"account"}]
\* lib/v1/lending-native-guard.mjs:119-133; provider is part of source scope.
ProviderChange == /\ s.provider = 0
 /\ s' = [s EXCEPT !.provider = 1]
\* lib/v1/lender-pace50.mjs:711-737; guard:165-184.
ColdOpens == /\ s.cold /\ s.now = 0
 /\ s' = [s EXCEPT !.cold = FALSE, !.now = 1, !.seen = @ \cup {"cold"}]
\* lib/v1/lending-native-guard.mjs:134-135,175-199: bind may shorten only.
Bind == /\ ~s.cold /\ ~s.bound /\ ~s.checked
 /\ s' = [s EXCEPT !.bound = TRUE,
    !.deadline = IF Mode = "deadline" THEN 3 ELSE 2]
\* lib/v1/lender-pace50.mjs:727-737; native settlement:973-988.
\* Old evidence remains Old even if the current account/instance changes.
RecheckBound == /\ ~s.checked
 /\ LET same == Tuple(s.account,s.provider,s.epoch,s.short) = Old
         weak == IF Mode = "scope" THEN s.account = 0 /\ s.provider = 0 /\ s.epoch = 0
                 ELSE IF Mode = "account" THEN s.provider = 0 /\ s.epoch = 0 /\ s.short = 0
                 ELSE same
    IN s' = [s EXCEPT !.checked = TRUE, !.accepted = weak, !.checkedScope = Tuple(s.account,s.provider,s.epoch,s.short),
                      !.stopped = ~weak]
\* lib/v1/lending-policy.mjs:1140-1151; proof belongs to generation 1.
Cleanup == /\ ~s.cleanup /\ ~s.late
 /\ s' = [s EXCEPT !.cleanup = TRUE]
\* lib/v1/lending-policy.mjs:929-960; a delayed started receipt invalidates
\* earlier cessation knowledge (generation 2 is the new uncertainty, not
\* a second provider launch), as Lease's delayed ObserveDeliver can do.
LateStart == /\ s.cleanup /\ ~s.late
 /\ s' = [s EXCEPT !.late = TRUE, !.gen = 2, !.settled = FALSE,
                   !.seen = @ \cup {"late"}]
\* lib/v1/lending-policy.mjs:1193-1233: atomic carry creation and old charge.
\* cur.epoch must equal from.epoch; trusted source routing supplies account
\* and provider identity. A weekly rollover needs separate successor evidence.
CarryMaximum == /\ s.late /\ s.short = 1 /\ ~s.carry
 /\ s.account = 0 /\ s.provider = 0 /\ s.epoch = 0
 /\ s' = [s EXCEPT !.carry = TRUE, !.carryScope = Tuple(s.account,s.provider,s.epoch,s.short), !.parent = 1, !.successor = 2,
   !.carryPending = 2, !.held[1] = 0, !.pending[1] = 0,
   !.charged[1] = 2, !.seen = @ \cup {"carry"}]
\* lib/v1/lending-policy.mjs:1234-1267: carry fence and per-limit charge.
ResetSettle == /\ s.cleanup /\ s.short = 1 /\ ~s.settled
 /\ (~s.late \/ s.carry \/ Mode = "carry")
 /\ s' = [s EXCEPT !.settled = TRUE, !.held = <<0,0>>,
    !.charged = <<2, IF s.week = 1 THEN 2 ELSE 0>>,
    !.pending = <<0, IF (s.week = 1 /\ ~s.late) \/ Mode = "weekly" THEN 0 ELSE 2>>,
    !.seen = @ \cup {"settle"}]
\* lib/v1/lending-policy.mjs:1380-1412: new admission sees carried liability.
Admit == /\ s.settled /\ s.late /\ ~s.admitted
 /\ s' = [s EXCEPT !.admitted = TRUE]
\* lib/v1/lending-policy.mjs:1140-1151, late_ack_unresolved fence;
\* LendingLease I4: an old generation's proof cannot close its successor.
ReceiveOldProof == /\ s.late /\ ~s.proofReceived
 /\ s' = [s EXCEPT !.proofReceived = TRUE,
     !.carryPending = IF Mode = "proof" \/ s.proofGen = s.gen THEN 0 ELSE @,
     !.seen = @ \cup {"proof"}]
\* lib/v1/lending-pace50-adapter.mjs:122-127: reload durable ownership.
Reopen == UNCHANGED vars
Next == ShortReset \/ WeekAdvance \/ AccountChange \/ ProviderChange
 \/ ColdOpens \/ Bind \/ RecheckBound \/ Cleanup \/ LateStart
 \/ CarryMaximum \/ ResetSettle \/ Admit \/ ReceiveOldProof \/ Reopen
Spec == Init /\ [][Next]_vars
ScopeExact == s.accepted => s.checkedScope = Old
\* The captured tuple makes this a decision-time check, not retroactive revocation.
DeadlineNeverLater == s.deadline <= 2
WeeklyRetained == (s.settled /\ s.week = 0) => s.pending[2] = 2
CarryBeforeSlack == (s.admitted /\ s.late) => s.carry
ProofGeneration == s.carry => (s.parent = 1 /\ s.successor = 2 /\ s.carryPending = 2)
W_Boundary == CASE Boundary = "scope" -> ~(s.checked /\ s.checkedScope[4] = 1 /\ s.checkedScope[3] = 0)
 [] Boundary = "account" -> ~(s.checked /\ s.checkedScope[1] = 1)
 [] Boundary = "deadline" -> ~s.bound
 [] Boundary = "weekly" -> ~(s.settled /\ s.week = 0)
 [] Boundary = "carry" -> ~(s.admitted /\ s.late /\ s.carry)
 [] OTHER -> ~(s.proofReceived /\ s.carry)
=============================================================================
