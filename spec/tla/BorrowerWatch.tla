--------------------------- MODULE BorrowerWatch ---------------------------
EXTENDS Naturals
VARIABLE x
vars == <<x>>
Init == x = [job |-> "running", tracked |-> TRUE, ready |-> FALSE]
Expire == /\ x.job = "running" /\ x' = [x EXCEPT !.job = "expired-failure"]
Deliver == /\ x.job = "expired-failure" /\ x' = [x EXCEPT !.job = "accepted"]
Observe == /\ x.tracked /\ x.job = "accepted"
 /\ x' = [x EXCEPT !.ready = TRUE, !.tracked = FALSE]
Next == Expire \/ Deliver \/ Observe \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars /\ WF_vars(Expire) /\ WF_vars(Deliver) /\ WF_vars(Observe)
DelayedResultNotified == (x.job = "accepted") ~> x.ready
=============================================================================
