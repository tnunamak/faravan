--------------------------- MODULE Lending ---------------------------
EXTENDS Integers, TLC
CONSTANT UnsafeRelease
VARIABLES phase, reserved, consumed, dispatched, starts, revoked
vars == <<phase, reserved, consumed, dispatched, starts, revoked>>
Init == /\ phase = [a \in {1,2} |-> "idle"]
        /\ reserved = [a \in {1,2} |-> 0]
        /\ consumed = [a \in {1,2} |-> 0]
        /\ dispatched = [a \in {1,2} |-> FALSE]
        /\ starts = [a \in {1,2} |-> 0]
        /\ revoked = [a \in {1,2} |-> FALSE]
Reserve(a) == /\ phase[a] = "idle"
              /\ phase' = [phase EXCEPT ![a] = "prepared"]
              /\ reserved' = [reserved EXCEPT ![a] = 10]
              /\ UNCHANGED <<consumed,dispatched,starts,revoked>>
Dispatch(a) == /\ phase[a] = "prepared" /\ ~revoked[a]
               /\ phase' = [phase EXCEPT ![a] = "uncertain"]
               /\ dispatched' = [dispatched EXCEPT ![a] = TRUE]
               /\ starts' = [starts EXCEPT ![a] = @ + 1]
               /\ UNCHANGED <<reserved,consumed,revoked>>
Stop(a) == /\ phase[a] \in {"prepared","uncertain"}
           /\ phase' = [phase EXCEPT ![a] = "ceased"]
           /\ revoked' = [revoked EXCEPT ![a] = TRUE]
           /\ UNCHANGED <<reserved,consumed,dispatched,starts>>
Release(a) == /\ phase[a] = "ceased" \/ (phase[a] = "prepared" /\ ~dispatched[a]) \/ (UnsafeRelease /\ phase[a] = "uncertain")
              /\ phase' = [phase EXCEPT ![a] = "released"]
              /\ reserved' = [reserved EXCEPT ![a] = 0]
              /\ UNCHANGED <<consumed,dispatched,starts,revoked>>
Settle(a) == /\ phase[a] = "ceased"
             /\ phase' = [phase EXCEPT ![a] = "settled"]
             /\ reserved' = [reserved EXCEPT ![a] = 0]
             /\ consumed' = [consumed EXCEPT ![a] = 3]
             /\ UNCHANGED <<dispatched,starts,revoked>>
Read == UNCHANGED vars
Next == (\E a \in {1,2}: Reserve(a) \/ Dispatch(a) \/ Stop(a) \/ Release(a) \/ Settle(a)) \/ Read
NoDuplicate == \A a \in {1,2}: starts[a] <= 1
NoUnverifiedRelease == \A a \in {1,2}: (dispatched[a] /\ ~revoked[a]) => reserved[a] = 10
Conservation == \A a \in {1,2}: reserved[a] >= 0 /\ consumed[a] >= 0 /\ reserved[a] + consumed[a] <= 10
=====================================================================
