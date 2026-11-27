------------------------ MODULE AdmissionExposure ------------------------
EXTENDS Naturals, TLC
CONSTANT Mode
\* Two jobs, two applicable limits, quota Q=4 and blind-exposure budget B=1.
\* Eq.17 envelope increments below are TRUSTED ENVIRONMENT assumptions, not
\* facts inferred from age or history. Invalid envelopes imply total_hi=Q.
\* Stop-side assumption: each job consumes at most its reservation vector;
\* unbounded in-flight burn/cessation latency belongs to the timed-guard lane.
\* Resource roster and instance scope are fixed throughout this model.
\* Composition contract with Admission (no INSTANCE/state-space product):
\* Admission.Reserve consumes our Reserve certificate and persists its vector;
\* KnownUsage transfers held into unrepresented; Cleanup never refunds burn;
\* Sweep may consume RepresentBurn only with trusted coverage, not receipt time.
\* Admission's scalar held/pending are projections for ONE representative job;
\* that quotient cannot establish this module's quantitative theorem by itself.
VARIABLES actualOwnerUse, actualBorrowerUse, measuredHi, readCount, acquisitionTime, coverageTime, ownerEnvelope, borrowerEnvelope, envelopeValid, reserved, unrepresented, represented, pending, now, phase, roomOK, checkedOwn
vars == <<actualOwnerUse, actualBorrowerUse, measuredHi, readCount, acquisitionTime, coverageTime, ownerEnvelope, borrowerEnvelope, envelopeValid, reserved, unrepresented, represented, pending, now, phase, roomOK, checkedOwn>>
Resources == {1,2}
Jobs == {1,2}
Q == 4
B == 1
Min(a,b) == IF a < b THEN a ELSE b
SumJobs(f) == f[1] + f[2]
Held(r) == reserved[1][r] + reserved[2][r]
Blind(r) == unrepresented[1][r] + unrepresented[2][r]
OutstandingExposure(r) == SumJobs([j \in Jobs |-> actualBorrowerUse[j][r]-represented[j][r]])
LocalExposure(r) == SumJobs([j \in Jobs |-> unrepresented[j][r]+reserved[j][r]])
SoundHi(r) == IF envelopeValid[r]
 THEN Min(Q, measuredHi[r]+ownerEnvelope[r]+borrowerEnvelope[r]) ELSE Q
\* One quota unit stands for a plausible age reserve, never a certified rate.
LocalHi(r) == IF Mode = "estimate" THEN Min(Q,measuredHi[r]+1) ELSE SoundHi(r)
CheckedResources == IF Mode = "omit" THEN {1} ELSE Resources
\* lib/v1/lending-policy.mjs:567-575 empty durable state plus independent environmental ledger.
Init ==
 /\ actualOwnerUse = [r \in Resources |-> 0]
 /\ actualBorrowerUse = [j \in Jobs |-> [r \in Resources |-> 0]]
 /\ measuredHi = [r \in Resources |-> 0]
 /\ readCount = [r \in Resources |-> 0]
 /\ acquisitionTime = [r \in Resources |-> 0]
 /\ coverageTime = [r \in Resources |-> 0]
 /\ ownerEnvelope = [r \in Resources |-> 0]
 /\ borrowerEnvelope = [r \in Resources |-> 0]
 /\ envelopeValid = [r \in Resources |-> TRUE]
 /\ reserved = [j \in Jobs |-> [r \in Resources |-> 0]]
 /\ unrepresented = [j \in Jobs |-> [r \in Resources |-> 0]]
 /\ represented = [j \in Jobs |-> [r \in Resources |-> 0]]
 /\ pending = [r \in Resources |-> [ready |-> FALSE, at |-> 0, owner |-> 0, borrower |-> [j \in Jobs |-> 0]]]
 /\ now = 0
 /\ phase = [j \in Jobs |-> "idle"]
 /\ roomOK = TRUE
 /\ checkedOwn = FALSE
\* Environment at lib/v1/lending-policy.mjs:1425-1434; independent owner burn since measurement.
OwnerSpend(r) ==
 /\ now < 4 /\ actualOwnerUse[r] < Q
 /\ now' = now+1
 /\ actualOwnerUse' = [actualOwnerUse EXCEPT ![r] = @+1]
 /\ ownerEnvelope' = [ownerEnvelope EXCEPT ![r] = @+1]
 /\ UNCHANGED <<actualBorrowerUse, measuredHi, readCount, acquisitionTime, coverageTime, borrowerEnvelope, envelopeValid, reserved, unrepresented, represented, pending, phase, roomOK, checkedOwn>>
\* lib/v1/lending-policy.mjs:1011-1037 usage transfers hold to unrepresented; actual charge is external.
BorrowerSpend(j) ==
 /\ phase[j] = "reserved"
 /\ actualBorrowerUse' = [actualBorrowerUse EXCEPT ![j] = [r \in Resources |-> actualBorrowerUse[j][r]+1]]
 /\ reserved' = [reserved EXCEPT ![j] = [r \in Resources |-> 0]]
 /\ unrepresented' = [unrepresented EXCEPT ![j] = [r \in Resources |-> 1]]
 /\ borrowerEnvelope' = [r \in Resources |-> borrowerEnvelope[r]+1]
 /\ phase' = [phase EXCEPT ![j] = "spent"]
 /\ UNCHANGED <<actualOwnerUse, measuredHi, readCount, acquisitionTime, coverageTime, ownerEnvelope, envelopeValid, represented, pending, now, roomOK, checkedOwn>>
\* lib/v1/lending-probe.mjs:305-310 acquisition seam; true coverage may predate delivery.
AcquireReading(r) ==
 /\ ~pending[r].ready /\ readCount[r] < 2
 /\ pending' = [pending EXCEPT ![r] = [ready |-> TRUE, at |-> now, owner |-> actualOwnerUse[r], borrower |-> [j \in Jobs |-> actualBorrowerUse[j][r]]]]
 /\ readCount' = [readCount EXCEPT ![r] = @+1]
 /\ acquisitionTime' = [acquisitionTime EXCEPT ![r] = now]
 /\ UNCHANGED <<actualOwnerUse, actualBorrowerUse, measuredHi, coverageTime, ownerEnvelope, borrowerEnvelope, envelopeValid, reserved, unrepresented, represented, now, phase, roomOK, checkedOwn>>
\* lib/v1/lending-probe.mjs:339-363 publication; fresh receipt does not prove burn coverage.
DeliverLaggedReading(r) ==
 /\ pending[r].ready
 /\ measuredHi' = [measuredHi EXCEPT ![r] = Min(Q,pending[r].owner+SumJobs(pending[r].borrower))]
 /\ coverageTime' = [coverageTime EXCEPT ![r] = pending[r].at]
 /\ ownerEnvelope' = [ownerEnvelope EXCEPT ![r] = actualOwnerUse[r]-pending[r].owner]
 /\ borrowerEnvelope' = [borrowerEnvelope EXCEPT ![r] = SumJobs([j \in Jobs |-> actualBorrowerUse[j][r]-pending[r].borrower[j]])]
 /\ pending' = [pending EXCEPT ![r].ready = FALSE]
 /\ unrepresented' = IF Mode = "refresh" THEN [unrepresented EXCEPT ![1][r] = 0, ![2][r] = 0] ELSE unrepresented
 /\ UNCHANGED <<actualOwnerUse, actualBorrowerUse, readCount, acquisitionTime, envelopeValid, reserved, represented, now, phase, roomOK, checkedOwn>>
\* lib/v1/lending-reading-age.mjs:5-14 explicitly supplies an estimate, not a future bound.
LoseEnvelopeValidity(r) ==
 /\ envelopeValid[r]
 /\ envelopeValid' = [envelopeValid EXCEPT ![r] = FALSE]
 /\ UNCHANGED <<actualOwnerUse, actualBorrowerUse, measuredHi, readCount, acquisitionTime, coverageTime, ownerEnvelope, borrowerEnvelope, reserved, unrepresented, represented, pending, now, phase, roomOK, checkedOwn>>
\* lib/v1/lending-policy.mjs:1425-1434,1481-1504; atomic lib/v1/lending-pace50-adapter.mjs:486-512.
Reserve(j) ==
 /\ phase[j] = "idle" /\ (j = 1 \/ phase[1] = "spent")
 /\ \A r \in CheckedResources: LocalHi(r)+Held(r)+Blind(r)+1 <= Q
 /\ \A r \in Resources: LocalExposure(r)+1 <= B
 /\ reserved' = [reserved EXCEPT ![j] = [r \in Resources |-> 1]]
 /\ phase' = [phase EXCEPT ![j] = "reserved"]
 /\ roomOK' = (roomOK /\ (\A r \in Resources: SoundHi(r)+Held(r)+1 <= Q))
 /\ UNCHANGED <<actualOwnerUse, actualBorrowerUse, measuredHi, readCount, acquisitionTime, coverageTime, ownerEnvelope, borrowerEnvelope, envelopeValid, unrepresented, represented, pending, now, checkedOwn>>
\* lib/v1/lending-pace50-adapter.mjs:440-468 replacement preview excludes ONLY own hold.
RecheckOwnReservation(j) ==
 /\ phase[j] = "reserved" /\ ~checkedOwn
 /\ \A r \in Resources: LocalHi(r)+Held(r)-reserved[j][r]+Blind(r)+1 <= Q
 /\ checkedOwn' = TRUE
 /\ UNCHANGED <<actualOwnerUse, actualBorrowerUse, measuredHi, readCount, acquisitionTime, coverageTime, ownerEnvelope, borrowerEnvelope, envelopeValid, reserved, unrepresented, represented, pending, now, phase, roomOK>>
\* lib/v1/lending-policy.mjs:1039-1085 reconciliation requires attributed covered burn.
RepresentBurn(j,r) ==
 /\ phase[j] = "spent" /\ unrepresented[j][r] > 0
 /\ pending[r].borrower[j] > represented[j][r]
 /\ ~pending[r].ready
 /\ represented' = [represented EXCEPT ![j][r] = pending[r].borrower[j]]
 /\ unrepresented' = [unrepresented EXCEPT ![j][r] = actualBorrowerUse[j][r]-pending[r].borrower[j]]
 /\ UNCHANGED <<actualOwnerUse, actualBorrowerUse, measuredHi, readCount, acquisitionTime, coverageTime, ownerEnvelope, borrowerEnvelope, envelopeValid, reserved, pending, now, phase, roomOK, checkedOwn>>
Next == (\E r \in Resources: OwnerSpend(r) \/ AcquireReading(r) \/ DeliverLaggedReading(r) \/ LoseEnvelopeValidity(r))
 \/ (\E j \in Jobs: BorrowerSpend(j) \/ Reserve(j) \/ RecheckOwnReservation(j))
 \/ (\E j \in Jobs, r \in Resources: RepresentBurn(j,r))
 \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
RoomSound == roomOK
ExposureBudget == \A r \in Resources: OutstandingExposure(r) <= B
W_NoOwnerBurst == ~(actualOwnerUse[2] = Q /\ phase[1] = "reserved")
W_NoUnknownBoundary == ~(~envelopeValid[2] /\ phase[1] = "spent")
W_NoSequential == phase[2] # "spent"
W_NoOwnRecheck == ~checkedOwn
W_NoCoverage == represented[1][1] = 0
=============================================================================
