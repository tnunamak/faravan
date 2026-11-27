------------------------------ MODULE DiskDelete ------------------------------
\* The store protocol of the disk sweep, reduced to what decides safety.
\* Items are things made by this app (Mine) plus one thing the app did not make (Foreign).
\* A sweep removes sandboxes and cache directories. An item can be made again after it is gone
\* (a cache directory has a fixed name), so the model lets every item be made, removed and made
\* again, any number of times.
\* Every writer of the store takes the gate. A removal is a command whose effect can land at any
\* later time, including after the sweeper stopped waiting for it. A removal record (an op):
\*   - is written before the command is sent, with the exact identity;
\*   - closes only when the command returned an exit code (Close: the effect has landed, or it
\*     refused). A command whose outcome is unknown (Timeout) keeps its record open for good;
\*   - while it is open, the identity is not sent again (no second command) and is not made again.
\* Two constants turn off the rules, to show that the checks catch the failures:
\*   Redispatch   - an open record's identity may be sent a second time;
\*   AbsenceCloses- a record closes when the item is seen absent, whatever may still be pending.
\* The code follows Redispatch = FALSE and AbsenceCloses = FALSE (lib/disk-sweep.mjs).
EXTENDS Naturals, FiniteSets

CONSTANTS Mine, Foreign, Redispatch, AbsenceCloses

VARIABLES
  gate,      \* "free" or "create" (a create is open)
  listed,    \* items present in the store
  owned,     \* items the ledger records as ours (set at the end of the create that made them)
  leases,    \* items a job protects
  ops,       \* open removal records
  unknown,   \* records whose command outcome is unknown (the sweeper stopped waiting)
  pending    \* per item: removal commands sent whose effect has not landed or been refused

vars == <<gate, listed, owned, leases, ops, unknown, pending>>

Init == /\ gate = "free"
        /\ listed = Foreign
        /\ owned = {}
        /\ leases = {}
        /\ ops = {}
        /\ unknown = {}
        /\ pending = [i \in Mine |-> 0]

\* A create holds the gate from before the create until the item is recorded as owned.
\* The job's protection is written under the same gate, before the item exists. An item whose
\* record is open is never made again.
CreateBegin(i) == /\ gate = "free" /\ i \notin listed /\ i \notin ops /\ i \notin leases
                  /\ gate' = "create"
                  /\ leases' = leases \cup {i}
                  /\ UNCHANGED <<listed, owned, ops, unknown, pending>>
CreateEnd(i) == /\ gate = "create" /\ i \in leases /\ i \notin listed
                /\ gate' = "free"
                /\ listed' = listed \cup {i}
                /\ owned' = owned \cup {i}
                /\ UNCHANGED <<leases, ops, unknown, pending>>

\* A job protects an item it will reuse, under the gate, before using it. An item with an open
\* record is refused.
Reuse(i) == /\ gate = "free" /\ i \in listed /\ i \notin ops
            /\ leases' = leases \cup {i}
            /\ UNCHANGED <<gate, listed, owned, ops, unknown, pending>>
EndJob(i) == /\ i \in leases /\ gate = "free"
             /\ leases' = leases \ {i}
             /\ UNCHANGED <<gate, listed, owned, ops, unknown, pending>>

\* The sweeper sends a removal only for an owned, listed, unprotected item, under the gate. While
\* the item has an open record it is not sent again (unless Redispatch). At most two commands
\* per item are modelled.
Issue(i) == /\ gate = "free" /\ i \in owned /\ i \in listed /\ i \notin leases
            /\ (Redispatch \/ i \notin ops)
            /\ pending[i] < 2
            /\ ops' = ops \cup {i}
            /\ pending' = [pending EXCEPT ![i] = @ + 1]
            /\ UNCHANGED <<gate, listed, owned, leases, unknown>>

\* The effect of a sent command lands whenever the daemon gets to it, including after the caller
\* gave up. Whatever item has that identity at that time is removed.
Land(i) == /\ pending[i] > 0
           /\ listed' = listed \ {i}
           /\ pending' = [pending EXCEPT ![i] = @ - 1]
           /\ UNCHANGED <<gate, owned, leases, ops, unknown>>
\* A clean refusal is terminal, and is seen only by a sweeper still waiting for the command.
Refuse(i) == /\ pending[i] > 0 /\ i \notin unknown
             /\ pending' = [pending EXCEPT ![i] = @ - 1]
             /\ ops' = IF pending[i] = 1 THEN ops \ {i} ELSE ops
             /\ UNCHANGED <<gate, listed, owned, leases, unknown>>
\* The sweeper stops waiting for a command (a timeout, an abort, a transport error).
Timeout(i) == /\ i \in ops /\ pending[i] > 0 /\ i \notin unknown
              /\ unknown' = unknown \cup {i}
              /\ UNCHANGED <<gate, listed, owned, leases, ops, pending>>
\* The command returned an exit code and the item is seen gone: the record closes. Nothing is
\* pending for that identity, and the outcome was known.
Close(i) == /\ i \in ops /\ i \notin unknown /\ i \notin listed /\ pending[i] = 0
            /\ ops' = ops \ {i}
            /\ owned' = owned \ {i}
            /\ UNCHANGED <<gate, listed, leases, unknown, pending>>
\* The old rule: seeing the item absent closes the record, even with a command still pending.
AbsentCloses(i) == /\ AbsenceCloses /\ i \in ops /\ i \notin listed
                   /\ ops' = ops \ {i}
                   /\ owned' = owned \ {i}
                   /\ unknown' = unknown \ {i}
                   /\ UNCHANGED <<gate, listed, leases, pending>>

Next == \E i \in Mine : CreateBegin(i) \/ CreateEnd(i) \/ Reuse(i) \/ EndJob(i) \/ Issue(i) \/ Land(i)
                        \/ Refuse(i) \/ Timeout(i) \/ Close(i) \/ AbsentCloses(i)

Spec == Init /\ [][Next]_vars

TypeOK == /\ gate \in {"free", "create"}
          /\ listed \subseteq Mine \cup Foreign /\ owned \subseteq Mine
          /\ leases \subseteq Mine /\ ops \subseteq Mine /\ unknown \subseteq ops
          /\ pending \in [Mine -> 0..2]

\* The item the app did not make is never removed.
ForeignSafe == Foreign \subseteq listed
\* An item a job protects is never removed under it, including an item that was made again after
\* an earlier one was removed.
LeasedStays == leases \subseteq listed \/ (gate = "create")
\* A command that may still land always has an open record: its identity is fenced.
PendingIsFenced == \A i \in Mine : pending[i] > 0 => i \in ops
\* Only owned items are ever sent.
OnlyOwnedIssued == \A i \in Mine : pending[i] > 0 => i \in owned \/ i \notin listed
\* One command at a time per identity.
NoDuplicateCommand == \A i \in Mine : pending[i] <= 1
================================================================================
