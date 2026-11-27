------------------------- MODULE ProbeOwnership -------------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANTS Coupled, StalePublish
\* e035f188: two candidate entries, one provider probe/controller (id 1).
\* Waiter 1 is a background read; waiter 2 is a guard with its own meterSession.
\* Coupled=TRUE is shipped ownership, FALSE is a proposed ownership repair.
\* StalePublish=TRUE intentionally removes candidate publication fences.
\* This checks evidence transport, not eq.17: no spend envelope is certified here.
VARIABLE v
vars == <<v>>
\* lending-probe.mjs:246; lender-pace50.mjs:565-570: empty volatile caches.
Init == v = [id |-> 0, captured |-> 0, cacheGen |-> 0, cacheAt |-> 0,
  pending |-> FALSE, aborted |-> FALSE, abortDue |-> FALSE,
  joined |-> {}, cancelled |-> {}, result |-> [w \in 1..2 |-> "none"],
  invalidated |-> FALSE, completed |-> FALSE, backoff |-> TRUE]
\* lending-probe.mjs:269-281,321-324: expiry makes provider work due again.
BackoffExpires == /\ v.backoff /\ v' = [v EXCEPT !.backoff = FALSE]
\* lending-probe.mjs:285-292; lender-pace50.mjs:637-646: capture generation.
StartRead == /\ ~v.backoff /\ v.id = 0
 /\ v' = [v EXCEPT !.id = 1, !.captured = v.cacheGen,
                  !.pending = TRUE, !.joined = {1}]
\* lender-pace50.mjs:634-646: an unshared guard can own a new provider probe.
StartGuardRead == /\ ~v.backoff /\ v.id = 0
 /\ v' = [v EXCEPT !.id = 1, !.captured = v.cacheGen,
                  !.pending = TRUE, !.joined = {2}]
\* lending-probe.mjs:372,443-459: meterSession joins provider work too.
JoinRead == /\ v.pending /\ 2 \notin v.joined /\ ~v.aborted /\ ~v.abortDue
 /\ v' = [v EXCEPT !.joined = @ \cup {2}]
\* lending-probe.mjs:247-254,373-377: individual signal links to transport.
CancelWaiter == /\ v.pending /\ 1 \in v.joined /\ 1 \notin v.cancelled
 /\ v' = [v EXCEPT !.cancelled = @ \cup {1},
                  !.abortDue = Coupled \/ (v.joined \subseteq {1})]
\* lender-pace50.mjs:703-707: increment generation, clear cache, cancel shared
\* entries only. Guard entry is separate, but its lower transport is shared.
InvalidateCandidateCache == /\ ~v.invalidated /\ v.pending
 /\ v' = [v EXCEPT !.invalidated = TRUE, !.cacheGen = 1,
   !.cacheAt = 0, !.cancelled = @ \cup {1},
   !.abortDue = ~v.aborted /\ (1 \in v.joined) /\ (Coupled \/ (v.joined \subseteq {1}))]
\* lending-probe.mjs:250,294-297: abort is synchronous; draining is separate.
\* Split only to expose the transport boundary; no completion overtakes abortDue.
AbortTransport == /\ v.pending /\ v.abortDue /\ ~v.aborted
 /\ v' = [v EXCEPT !.aborted = TRUE, !.abortDue = FALSE]
\* lending-probe.mjs:299-310,339-370; lender-pace50.mjs:648-652.
\* An uncooperative runner may return success after abort; host rejects it.
\* Guard may receive success across cache invalidation but cannot publish it.
CompleteOldRead == /\ v.pending /\ ~v.abortDue
 /\ v' = [v EXCEPT !.pending = FALSE, !.completed = TRUE,
   !.result = [w \in 1..2 |-> IF w \notin v.joined THEN "none"
       ELSE IF v.aborted \/ w \in v.cancelled THEN "cancelled" ELSE "good"],
   !.cacheAt = IF StalePublish \/ (~v.aborted /\ v.captured = v.cacheGen
                         /\ 1 \notin v.cancelled) THEN 2 ELSE v.cacheAt]
\* lending-probe.mjs:269-281: idle cadence can leave state unchanged.
Idle == UNCHANGED vars
Next == BackoffExpires \/ StartGuardRead \/ StartRead \/ JoinRead \/ CancelWaiter
     \/ InvalidateCandidateCache \/ AbortTransport \/ CompleteOldRead \/ Idle
Spec == Init /\ [][Next]_vars
TypeOK == /\ v.id \in 0..1 /\ v.cacheGen \in 0..1 /\ v.cacheAt \in 0..2
          /\ v.joined \subseteq 1..2 /\ v.cancelled \subseteq 1..2
NoCollateralAbort == ~(v.aborted /\ 2 \in v.joined /\ 2 \notin v.cancelled)
GuardNotLost == (v.invalidated /\ 2 \in v.joined) => v.result[2] # "cancelled"
CacheFence == v.invalidated => v.cacheAt = 0
CoupledContract == (Coupled /\ v.completed /\ v.aborted) =>
                    \A w \in v.joined : v.result[w] = "cancelled"
W_NoCancelBoundary == ~(v.aborted /\ 2 \in v.joined)
W_NoInvalidatedCompletion == ~(v.invalidated /\ v.completed /\ 2 \in v.joined)
W_NoGuardSurvival == ~(v.invalidated /\ v.completed /\ v.result[2] = "good")
=============================================================================
