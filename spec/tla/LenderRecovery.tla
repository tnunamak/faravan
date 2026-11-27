------------------------- MODULE LenderRecovery -------------------------
EXTENDS Naturals, TLC
\* Local journals omitted by LendingLease (which models coordinator ownership).
\* Each case starts at the concrete recovery boundary in lender.mjs. Network
\* eventually returns a definitive refusal, disk eventually permits a write,
\* and the monotonic clock advances. Remote state NEVER proves local removal.
CONSTANT Kind
VARIABLE x
vars == <<x>>
Init == x = [pending |-> TRUE, removed |-> (Kind \notin {"stop", "save"}),
 accounted |-> (Kind # "stop"), healthy |-> FALSE, retained |-> FALSE,
 durable |-> FALSE, retries |-> 0, cooldown |-> 1, wall |-> 1,
 cancelWanted |-> FALSE, computeStopped |-> FALSE, transportFailed |-> FALSE]
Restore == /\ ~x.healthy /\ x' = [x EXCEPT !.healthy = TRUE]
Cleanup == /\ ~x.removed /\ (Kind # "save" \/ (x.durable /\ (~x.cancelWanted \/ x.computeStopped)))
 /\ x' = [x EXCEPT !.removed = TRUE]
\* Executor cancellation does not wait for storage. Destruction does.
Cancel == /\ Kind = "save" /\ ~x.cancelWanted /\ ~x.removed
 /\ x' = [x EXCEPT !.cancelWanted = TRUE]
CancelCompute == /\ x.cancelWanted /\ ~x.computeStopped
 /\ x' = [x EXCEPT !.computeStopped = TRUE]
Account == /\ x.removed /\ ~x.accounted
 /\ x' = [x EXCEPT !.accounted = TRUE]
\* A wall correction can change the sign, but never the elapsed-time deadline.
WallStep == /\ x.wall = 1 /\ x' = [x EXCEPT !.wall = 0]
Tick == /\ x.cooldown > 0 /\ x' = [x EXCEPT !.cooldown = @ - 1]
Replay == /\ Kind = "ack" /\ x.pending /\ x.healthy /\ x.retries < 3
 /\ x' = [x EXCEPT !.retries = @ + 1]
\* A transport error preserves the received unusable reply count for this result.
TransportError == /\ Kind = "ack" /\ x.pending /\ x.retries > 0
 /\ x' = [x EXCEPT !.transportFailed = ~@]
\* The independent onCollected owner retries across execution cancellation.
SaveOutput == /\ Kind = "save" /\ x.pending /\ x.healthy
 /\ x' = [x EXCEPT !.durable = TRUE, !.pending = FALSE]
Dispose == /\ x.pending /\ x.healthy /\ x.removed /\ x.accounted
 /\ (CASE Kind = "ack" -> x.retries = 3
         [] Kind = "cooldown" -> x.cooldown = 0
         [] Kind = "save" -> FALSE
         [] OTHER -> TRUE)
 /\ x' = [x EXCEPT !.pending = FALSE,
   !.retained = Kind \in {"output", "ack", "decline", "stop"}]
Done == /\ ~x.pending /\ UNCHANGED vars
Next == Cancel \/ CancelCompute \/ TransportError \/ Done \/ Restore \/ Cleanup \/ Account \/ WallStep \/ Tick \/ Replay \/ SaveOutput \/ Dispose
Spec == Init /\ [][Next]_vars /\ WF_vars(Restore) /\ WF_vars(Cleanup)
 /\ WF_vars(Account) /\ WF_vars(Tick) /\ WF_vars(Replay)
 /\ WF_vars(SaveOutput) /\ WF_vars(Dispose) /\ WF_vars(CancelCompute)
Progress == x.pending ~> ~x.pending
CessationBeforeClear == (~x.pending /\ Kind = "stop") => (x.removed /\ x.accounted)
EvidenceBeforeClear == (~x.pending /\ Kind \in {"output", "ack", "decline", "stop"}) => x.retained
CancellationStopsCompute == x.cancelWanted ~> x.computeStopped
SavedOutputCleanup == (Kind = "save" /\ x.durable) ~> x.removed
CancellationBeforeRemoval == (Kind = "save" /\ x.cancelWanted /\ x.removed) => x.computeStopped
OutputBeforeRemoval == (Kind = "save" /\ x.removed) => x.durable
SaveBeforeClear == (~x.pending /\ Kind = "save") => x.durable
=============================================================================
