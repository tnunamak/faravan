---------------------------- MODULE NativeGuard ----------------------------
EXTENDS Integers, TLC
CONSTANTS Mode, Sound, Horizon, F, P, L, T, R, q, Batch, Allowance, Q
VARIABLE x
vars == <<x>>
Min(a,b) == IF a < b THEN a ELSE b
Margin == q + R * (L + P + T) + Batch
Certified == Sound /\ Allowance > Margin
Threshold == IF Certified /\ Mode # "margin" THEN Allowance - Margin ELSE Allowance
\* One job and window. No quota admission or settlement is inferred from this
\* contract. In particular Stop.tla's Cleanup must mean ActualCessation here,
\* never StopDelivered. Rates/lag/cessation are environmental assumptions,
\* not facts established by the 60s freshness or 120s settlement settings.
Init == x = [now |-> 0, lastFreshAt |-> 0, coveredAt |-> 0,
  measuredHi |-> 0, owner |-> 0, borrower |-> 0, pollPending |-> FALSE,
  pollDue |-> F \div 2, hung |-> FALSE, usableResult |-> FALSE, timerDue |-> F,
  decisionDue |-> FALSE, stopRequestedAt |-> -1, spendAtStop |-> 0,
  delivered |-> FALSE, proven |-> FALSE, actualCeasedAt |-> -1,
  running |-> TRUE, armed |-> TRUE, crashed |-> FALSE, crashAt |-> -1, forged |-> FALSE,
  lateRearmed |-> FALSE, hangBoundary |-> FALSE]
\* guard:92-108: read starts independently of the already armed deadline.
PollStart == /\ ~x.crashed /\ x.armed /\ ~x.pollPending
 /\ x.now >= x.pollDue /\ x.stopRequestedAt = -1
 /\ x' = [x EXCEPT !.pollPending = TRUE, !.usableResult = FALSE]
\* guard:99: an unresolved provider promise leaves the read pending.
Hang == /\ x.pollPending /\ ~x.hung /\ x' = [x EXCEPT !.hung = TRUE]
\* guard:99-107: rejection neither erases evidence nor moves the deadline.
PollFail == /\ x.pollPending
 /\ x' = [x EXCEPT !.pollPending = FALSE, !.pollDue = x.now + 1]
\* guard:101,133-135,189-204: late results are ignored after halt. A
\* provider reading covers L ticks ago; receipt time is not coverage time.
PollComplete == /\ x.pollPending /\ x.now >= L
 /\ LET at == x.now - L
        b == R * Min(at, IF x.actualCeasedAt = -1 THEN at ELSE x.actualCeasedAt)
        measured == Min(Q, at + b) IN
 /\ x' = [x EXCEPT !.pollPending = FALSE,
   !.usableResult = x.stopRequestedAt = -1 /\ ~x.crashed,
   !.lateRearmed = @ \/ (Mode = "late" /\ x.stopRequestedAt # -1),
   !.armed = IF Mode = "late" /\ x.stopRequestedAt # -1 THEN TRUE ELSE @,
   !.lastFreshAt = IF x.stopRequestedAt = -1 /\ ~x.crashed THEN at ELSE @,
   !.coveredAt = IF x.stopRequestedAt = -1 /\ ~x.crashed THEN at ELSE @,
   !.measuredHi = IF x.stopRequestedAt = -1 /\ ~x.crashed THEN measured ELSE @,
   !.timerDue = IF x.stopRequestedAt = -1 /\ ~x.crashed THEN at + F ELSE @,
   !.pollDue = x.now + 1,
   !.decisionDue = @ \/ (x.stopRequestedAt = -1 /\ ~x.crashed /\ measured >= Threshold)]
\* guard:79-82: deadline callback does not await poll. Decision/request are
\* separate zero-time steps; Tick cannot advance past a due decision.
TimerFire == /\ ~x.crashed /\ x.armed /\ x.now >= x.timerDue
 /\ (Mode # "wait" \/ ~x.pollPending)
 /\ x' = [x EXCEPT !.decisionDue = TRUE]
\* guard:65-73; lender:716-746,748-764: callback requests stop, not exit.
RequestStop == /\ x.decisionDue /\ x.stopRequestedAt = -1
 /\ x' = [x EXCEPT !.stopRequestedAt = x.now, !.spendAtStop = x.borrower,
   !.armed = FALSE, !.decisionDue = FALSE,
   !.hangBoundary = x.hung /\ x.pollPending /\ x.now = F]
\* lender:735-736,758-761: delivery acknowledgement retains live exposure.
StopDelivered == /\ x.stopRequestedAt # -1 /\ ~x.delivered
 /\ x' = [x EXCEPT !.delivered = TRUE, !.proven = Mode = "ack"]
\* faravan-guard:355-410: group cessation, not leader exit or pipe closure.
ActualCessation == /\ x.running /\ x.delivered
 /\ x' = [x EXCEPT !.running = FALSE, !.actualCeasedAt = x.now, !.proven = TRUE]
\* guard:138-161: forged low in-band output cannot refresh trusted evidence.
InbandMeter == /\ x.armed /\ ~x.forged /\ x.now > x.lastFreshAt
 /\ x' = [x EXCEPT !.forged = TRUE,
   !.lastFreshAt = IF Mode = "inband" THEN x.now ELSE @,
   !.timerDue = IF Mode = "inband" THEN x.now + F ELSE @]
\* lender:1396-1481 recovery seam. Losing host timers does not kill a job.
Crash == /\ ~x.crashed /\ x.stopRequestedAt = -1
 /\ x' = [x EXCEPT !.crashed = TRUE, !.armed = FALSE, !.decisionDue = FALSE,
   !.crashAt = x.now]
\* faravan-guard:189-204,396-402: assumed independent watchdog contract.
\* The model does not prove OS process-tree containment or these bounds.
Watchdog == /\ x.crashed /\ x.running
 /\ x' = [x EXCEPT !.running = FALSE, !.actualCeasedAt = x.now, !.proven = TRUE]
\* Clock follows Lease's bounded-clock approach. Urgency constrains elapsed
\* time, rather than mistaking weak fairness for an upper latency bound.
\* Owner envelope is 1/tick; borrower is R/tick only on the sound path.
Tick == /\ x.now < Horizon /\ ~x.decisionDue
 /\ (x.crashed \/ ~x.armed \/ x.now < x.timerDue \/ (Mode = "wait" /\ x.pollPending))
 /\ (~Sound \/ ~x.crashed \/ ~x.running \/ x.now < x.crashAt + T)
 /\ (~Sound \/ x.stopRequestedAt = -1 \/ ~x.running \/ x.now < x.stopRequestedAt + T)
 /\ x' = [x EXCEPT !.now = @ + 1, !.owner = Min(Q, @ + 1),
   !.borrower = Min(Q, @ + IF x.running THEN (IF Sound THEN R ELSE R + 2) ELSE 0)]
Next == Tick \/ PollStart \/ Hang \/ PollFail \/ PollComplete \/ TimerFire
 \/ RequestStop \/ StopDelivered \/ ActualCessation \/ InbandMeter \/ Crash \/ Watchdog
 \/ (x.now = Horizon /\ UNCHANGED vars)
Spec == Init /\ [][Next]_vars
TypeOK == /\ x.now \in 0..Horizon /\ x.borrower \in 0..Q
 /\ x.actualCeasedAt \in -1..Horizon
StaleOnTime == (~x.crashed /\ x.stopRequestedAt = -1) => x.now <= x.timerDue
NoLateRearm == ~x.lateRearmed /\ (x.stopRequestedAt # -1 => ~x.armed)
InbandUntrusted == x.lastFreshAt = x.coveredAt
AckNotCessation == x.proven => ~x.running
ResidualBound == x.stopRequestedAt # -1 => x.borrower - x.spendAtStop <= R*T + Batch
CertificationHonest == (Certified /\ x.stopRequestedAt # -1) => Threshold = Allowance - Margin
\* Eq.17: trusted measured high plus both incremental envelopes, capped Q.
\* Without sound envelopes Q is the only bound. Freshness alone adds none.
TotalHi == IF Sound THEN Min(Q, x.measuredHi + (1+R)*(x.now-x.coveredAt) + q + Batch) ELSE Q
Eq17 == Min(Q, x.owner + x.borrower) <= TotalHi
Uncertified == ~Sound => ~Certified
W_NoStopAfterHang == ~x.hangBoundary
=============================================================================
