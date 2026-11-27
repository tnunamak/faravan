------------------------------ MODULE ClaimCancelStop ------------------------------
EXTENDS Naturals, TLC

\* The claim/cancel/Stop shared-state rules changed on this branch (design 1119 items 3 and 4):
\* 1. Claim or don't claim: a lender whose claim-time admission (advertisement) says it cannot run
\*    an account job never claims it; a no-can-run answer that still arrives after the claim
\*    declines the attempt back to the queue with its real reason, never a masked failure.
\*    Citations: lib/v1/lender.mjs availability/lendableAccounts, account-execution.mjs
\*    admissionRefusal, lender.mjs decline at the wrap call site, store.mjs release.
\* 2. The cancellation front door: only the submitting borrower or the circle's steward may
\*    cancel. Citation: lib/v1/store.mjs cancel (job.author===device || steward===device).
\* 3. Two Stop states: authority revocation is immediate; compute stopping is observed
\*    separately. Citations: store.mjs cancel ack fields, stopped endpoint; stop-statechart-paths.
\* 4. An actual execution fault is the only route to a failed job. Citation: failures.mjs
\*    classification, lender.mjs client.fail path.

VARIABLES job, holder, attempt, canceller, computeStopped, authRevoked, faulted,
          advertisedA, advertisedB, cancelled, designated

vars == <<job, holder, attempt, canceller, computeStopped, authRevoked, faulted,
          advertisedA, advertisedB, cancelled, designated>>

Init == /\ job = "queued"
        /\ holder = "none"
        /\ attempt = "none"
        /\ canceller = "none"
        /\ computeStopped = FALSE
        /\ authRevoked = FALSE
        /\ faulted = FALSE
        /\ advertisedA = TRUE
        /\ advertisedB = TRUE
        /\ cancelled = FALSE
        /\ designated = "a"

\* The account each lender would lend changes with its facts (design 1119 item 3).
AdmitA == /\ job \in {"queued","claimed"} /\ ~advertisedA
         /\ advertisedA' = TRUE /\ UNCHANGED <<job,holder,attempt,canceller,computeStopped,authRevoked,faulted,advertisedB,cancelled,designated>>
AdmitB == /\ job \in {"queued","claimed"} /\ ~advertisedB
         /\ advertisedB' = TRUE /\ UNCHANGED <<job,holder,attempt,canceller,computeStopped,authRevoked,faulted,advertisedA,cancelled,designated>>
WithholdA == /\ advertisedA
            /\ advertisedA' = FALSE /\ UNCHANGED <<job,holder,attempt,canceller,computeStopped,authRevoked,faulted,advertisedB,cancelled,designated>>
WithholdB == /\ advertisedB
            /\ advertisedB' = FALSE /\ UNCHANGED <<job,holder,attempt,canceller,computeStopped,authRevoked,faulted,advertisedA,cancelled,designated>>

\* A claim happens only while the lender's claim-time admission says it can run the job.
ClaimA == /\ job = "queued" /\ advertisedA /\ designated \in {"none","a"}
         /\ job' = "claimed" /\ holder' = "a" /\ attempt' = "active"
         /\ UNCHANGED <<canceller,computeStopped,authRevoked,faulted,advertisedA,advertisedB,cancelled,designated>>
ClaimB == /\ job = "queued" /\ advertisedB /\ designated \in {"none","b"}
         /\ job' = "claimed" /\ holder' = "b" /\ attempt' = "active"
         /\ UNCHANGED <<canceller,computeStopped,authRevoked,faulted,advertisedA,advertisedB,cancelled,designated>>

\* A no-can-run answer after the claim declines with its real reason: the attempt is
\* released and the job reopens, exactly like the pre-claim gates.
WrapDeclineA == /\ job = "claimed" /\ holder = "a" /\ ~advertisedA
               /\ job' = "queued" /\ holder' = "none" /\ attempt' = "released"
               /\ UNCHANGED <<canceller,computeStopped,authRevoked,faulted,advertisedA,advertisedB,cancelled,designated>>
WrapDeclineB == /\ job = "claimed" /\ holder = "b" /\ ~advertisedB
               /\ job' = "queued" /\ holder' = "none" /\ attempt' = "released"
               /\ UNCHANGED <<canceller,computeStopped,authRevoked,faulted,advertisedA,advertisedB,cancelled,designated>>

\* An actual execution fault is the only way the job fails.
FaultA == /\ job = "claimed" /\ holder = "a"
         /\ job' = "failed" /\ faulted' = TRUE /\ attempt' = "released" /\ holder' = "none"
         /\ UNCHANGED <<canceller,computeStopped,authRevoked,advertisedA,advertisedB,cancelled,designated>>
FaultB == /\ job = "claimed" /\ holder = "b"
         /\ job' = "failed" /\ faulted' = TRUE /\ attempt' = "released" /\ holder' = "none"
         /\ UNCHANGED <<canceller,computeStopped,authRevoked,advertisedA,advertisedB,cancelled,designated>>

\* The front door: the submitting borrower or the circle's steward may cancel.
\* Authority revocation is committed at once.
CancelByBorrower == /\ job \in {"queued","claimed"} /\ ~cancelled
                  /\ cancelled' = TRUE /\ canceller' = "borrower" /\ authRevoked' = TRUE
                  /\ job' = "cancelled"
                  /\ attempt' = (IF attempt = "active" THEN "releasing" ELSE attempt)
                  /\ UNCHANGED <<holder,computeStopped,faulted,advertisedA,advertisedB,designated>>
CancelBySteward == /\ job \in {"queued","claimed"} /\ ~cancelled
                  /\ cancelled' = TRUE /\ canceller' = "steward" /\ authRevoked' = TRUE
                  /\ job' = "cancelled"
                  /\ attempt' = (IF attempt = "active" THEN "releasing" ELSE attempt)
                  /\ UNCHANGED <<holder,computeStopped,faulted,advertisedA,advertisedB,designated>>
\* A plain member's cancellation is refused at the front door and changes nothing.
CancelByPlain == /\ job \in {"queued","claimed"} /\ ~cancelled
                /\ FALSE
                /\ UNCHANGED vars

\* The lender's own local safety Stop is its own authority act, never a borrower cancel.
LocalStop == /\ job = "claimed" /\ holder # "none"
            /\ authRevoked' = TRUE /\ attempt' = "releasing" /\ computeStopped' = TRUE
            /\ UNCHANGED <<job,holder,canceller,faulted,advertisedA,advertisedB,cancelled,designated>>

\* Compute stopping is observed separately, after authority was revoked or the work ended.
ObserveStopped == /\ attempt = "releasing" /\ authRevoked
                 /\ computeStopped' = TRUE /\ attempt' = "released" /\ holder' = "none"
                 /\ UNCHANGED <<job,canceller,authRevoked,faulted,advertisedA,advertisedB,cancelled,designated>>

CompleteA == /\ job = "claimed" /\ holder = "a"
           /\ job' = "done" /\ attempt' = "released" /\ holder' = "none" /\ computeStopped' = TRUE
           /\ UNCHANGED <<canceller,authRevoked,faulted,advertisedA,advertisedB,cancelled,designated>>
CompleteB == /\ job = "claimed" /\ holder = "b"
           /\ job' = "done" /\ attempt' = "released" /\ holder' = "none" /\ computeStopped' = TRUE
           /\ UNCHANGED <<canceller,authRevoked,faulted,advertisedA,advertisedB,cancelled,designated>>

\* A terminal job changes nothing by itself.
Settled == /\ job \in {"done","failed","cancelled"}
          /\ UNCHANGED vars

Next == \/ AdmitA \/ AdmitB \/ WithholdA \/ WithholdB
       \/ ClaimA \/ ClaimB
       \/ WrapDeclineA \/ WrapDeclineB
       \/ FaultA \/ FaultB
       \/ CancelByBorrower \/ CancelBySteward \/ CancelByPlain
       \/ LocalStop \/ ObserveStopped
       \/ CompleteA \/ CompleteB
       \/ Settled

\* Rules the reader agreed to, each one sentence:
\* 1. Only the submitting borrower or the steward ever cancels.
FrontDoor == canceller \in {"none","borrower","steward"}
\* 2. A lender only ever claims while its claim-time admission said it could run the job.
ClaimImpliesAdmission == holder = "none" \/ job \in {"claimed","cancelled"}
\* Only the designated member's store ever dispatches (owner-offline topology).
DesignatedOnlyDispatches == designated = "none" \/ holder # "b"
\* 3. An admission hold never fails a job; only an actual execution fault does.
AdmissionNeverFails == job # "failed" \/ faulted
\* 4. Compute is only ever reported stopped after an authority event ended it.
ComputeStopsAfterAuthority == ~computeStopped \/ authRevoked \/ job \in {"done","failed"}
\* 5. A cancellation is authority, and it is recorded even while compute keeps running.
\*    (authority_revoked and compute_stopped are separate observations)
RevokedWithoutObservedStop == ~cancelled \/ authRevoked

Invariant == /\ FrontDoor /\ ClaimImpliesAdmission /\ AdmissionNeverFails
            /\ ComputeStopsAfterAuthority /\ RevokedWithoutObservedStop /\ DesignatedOnlyDispatches

Spec == Init /\ [][Next]_vars
=============================================================================
