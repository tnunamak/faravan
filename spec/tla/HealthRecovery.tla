-------------------------- MODULE HealthRecovery --------------------------
EXTENDS Naturals
VARIABLE x
vars == <<x>>
\* Expands AdmissionRecovery backend availability with the idle repair flight.
\* A child can hang despite a repaired daemon. Timeout kills the client only;
\* ownership remains held until that client has closed. No concurrent repair.
Init == x = [flight |-> "idle", healthy |-> FALSE, fault |-> FALSE,
              expired |-> FALSE, reaped |-> FALSE, refreshed |-> FALSE]
Start == /\ x.flight = "idle" /\ ~x.refreshed
 /\ x' = [x EXCEPT !.flight = "running", !.expired = FALSE, !.reaped = FALSE]
Hang == /\ x.flight = "running" /\ ~x.fault
 /\ x' = [x EXCEPT !.flight = "hung", !.fault = TRUE]
Restore == /\ ~x.healthy /\ x' = [x EXCEPT !.healthy = TRUE]
Deadline == /\ x.flight \in {"running","hung"} /\ ~x.expired /\ (~x.healthy \/ x.flight = "hung")
 /\ x' = [x EXCEPT !.expired = TRUE]
Reap == /\ x.expired /\ ~x.reaped /\ x' = [x EXCEPT !.reaped = TRUE]
Release == /\ x.reaped /\ x.flight \in {"running","hung"}
 /\ x' = [x EXCEPT !.flight = "idle"]
Complete == /\ x.flight = "running" /\ x.healthy
 /\ x' = [x EXCEPT !.flight = "done", !.reaped = TRUE, !.refreshed = TRUE]
Next == Start \/ Hang \/ Restore \/ Deadline \/ Reap \/ Release \/ Complete \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars /\ WF_vars(Start) /\ WF_vars(Restore)
 /\ WF_vars(Deadline) /\ WF_vars(Reap) /\ WF_vars(Release) /\ WF_vars(Complete)
RepairReleases == (x.flight = "hung") ~> (x.flight # "hung")
RefreshProgress == <>x.refreshed
OwnershipRetained == (x.flight = "idle" /\ x.expired) => x.reaped
=============================================================================
