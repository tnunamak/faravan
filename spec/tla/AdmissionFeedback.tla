------------------------- MODULE AdmissionFeedback -------------------------
EXTENDS Naturals, FiniteSets
CONSTANT Bug
VARIABLE x
vars == <<x>>
\* ship e035f188. Two limits, two attempts (one already settled), two incarnations.
\* Admission contract: dispatch requires a durable sufficient hold at the current
\* revision, and no queued control/feedback fence (lib/v1/lending-pace50-adapter.mjs:450-498). This module
\* exports AdmissionOpen; it does not instantiate Admission's scenario quotient.
\* Stop contract: request is NOT cessation. Only backend cleanup establishes
\* ceased; only represented liabilities permit coverage (lib/v1/lending-policy.mjs:840-851).
\* Eq.17: the external Admission contract supplies sound owner/borrower envelopes,
\* or total_hi=Q when absent. This model does not certify historical kappa as an
\* envelope. B=2 is a supplied blind-exposure budget, not a freshness duration.
Limits == {1,2}
\* lib/v1/lending-policy.mjs:567-575, lib/v1/lending-pace50-adapter.mjs:122-127; running hold plus already represented burn.
Init == x = [stage |-> "idle", spent |-> 0, baseline |-> 0, rate |-> 1,
 gen |-> 0, captured |-> 0, done |-> 0, pending |-> FALSE, awaiting |-> FALSE,
 rev |-> 0, capturedRev |-> 0, feedbackGen |-> 0, required |-> 0,
 covered |-> {}, coveredAt |-> 0, blocked |-> FALSE, fence |-> FALSE,
 stopPending |-> FALSE, running |-> {1}, ceased |-> {2}, incarnation |-> 1,
 held |-> <<2,0>>, settled |-> <<1,1>>, blind |-> 1, actualBlind |-> 1,
 admittedUnsafe |-> FALSE, renewed |-> FALSE, repriced |-> FALSE,
 partial |-> FALSE, restarted |-> FALSE, drained |-> FALSE, reserved |-> FALSE]
\* lib/v1/lender-pace50.mjs:1412-1419: monotone cumulative spend and pending meter.
MeterTrigger == /\ x.stage = "idle"
 /\ x' = [x EXCEPT !.spent = 1, !.gen = 1, !.pending = TRUE, !.stage = "reading"]
\* lib/v1/lender-pace50.mjs:1418-1421; lib/v1/lending-pace50-adapter.mjs:403-406 revision captured at queue head.
BeginRecheck == /\ x.pending /\ ~x.awaiting
 /\ x' = [x EXCEPT !.pending = FALSE, !.awaiting = TRUE,
                    !.captured = x.gen, !.capturedRev = x.rev]
\* lib/v1/lender-pace50.mjs:1413-1416,1481-1485: same-spend arrival during await.
SameSpendNewMeter == /\ x.awaiting /\ x.gen = 1
 /\ x' = [x EXCEPT !.gen = 2, !.pending = Bug # "lost"]
\* lib/v1/lender-pace50.mjs:1447-1465: rounded unchanged reading retains original hold.
UnchangedReading == /\ x.awaiting /\ x.captured = 1 /\ x.gen = 2
 /\ x' = [x EXCEPT !.awaiting = FALSE, !.done = x.captured,
                    !.blind = IF Bug = "renew" THEN 0 ELSE @, !.renewed = TRUE]
\* lib/v1/lender-pace50.mjs:1442-1451: higher conversion on the next deferred response.
RateSurprise == /\ x.awaiting /\ x.captured = 2 /\ x.renewed
 /\ x' = [x EXCEPT !.rate = 2, !.awaiting = FALSE, !.done = 2, !.stage = "surprise"]
\* lib/v1/lender-pace50.mjs:1481-1485 completion seam must drain queued trigger.
Drain == /\ x.renewed /\ ~x.awaiting /\ ~x.pending /\ ~x.drained
 /\ x' = [x EXCEPT !.drained = TRUE]
\* lib/v1/lending-pace50-adapter.mjs:393-400: synchronous fence before persistence or callbacks await.
QueueFeedback == /\ x.stage = "surprise"
 /\ x' = [x EXCEPT !.fence = TRUE, !.stopPending = TRUE, !.stage = "queued"]
\* lib/v1/lending-pace50-adapter.mjs:419-421: an earlier On cannot clear a later Stop/feedback fence.
On == /\ x.stage = "queued"
 /\ x' = [x EXCEPT !.stage = "on", !.fence = Bug # "overtake"]
\* lib/v1/lending-pace50-adapter.mjs:450-454,481-498; lib/v1/lending-policy.mjs:1374. Exported Admission fence contract.
Admit == /\ x.stage = "on"
 /\ x' = [x EXCEPT !.admittedUnsafe = ~x.fence, !.stage = "admission"]
\* lib/v1/lending-policy.mjs:795-807: durable feedback roster/time; adapter commits atomically.
PersistFeedback == /\ x.stage = "admission"
 /\ x' = [x EXCEPT !.blocked = TRUE, !.feedbackGen = x.gen,
 !.required = 2, !.rev = @ + 1, !.stage = "persisted"]
\* lib/v1/lending-policy.mjs:808-823 and 273-279: only outstanding liability changes price.
\* Split is explanatory: production persists feedback and repricing atomically;
\* no admission/coverage action is enabled between these two modeled steps.
RepriceOutstanding == /\ x.stage = "persisted"
 /\ x' = [x EXCEPT !.held = <<4,0>>,
 !.settled = IF Bug = "double" THEN <<2,2>> ELSE @,
 !.repriced = TRUE, !.stage = "repriced"]
\* lib/v1/lending-policy.mjs:824-828; lib/v1/lender-pace50.mjs:95-98,231-235 effects request Stop, no refund.
RequestStop == /\ x.stage = "repriced"
 /\ x' = [x EXCEPT !.stopPending = FALSE, !.fence = FALSE, !.stage = "stopping"]
\* lib/v1/lender-pace50.mjs:1525-1580; Stop.Cleanup contract, then represented usage.
CeaseAndRepresent == /\ x.stage = "stopping"
 /\ x' = [x EXCEPT !.running = {}, !.ceased = {1,2}, !.held = <<0,0>>,
 !.stage = IF x.restarted THEN "coverage" ELSE "ceased"]
\* lib/v1/lending-pace50-adapter.mjs:122-127 reloads durable block; lib/v1/lender-pace50.mjs:771-778 loses live registry.
Restart == /\ x.stage \in {"repriced", "stopping", "ceased"} /\ x.incarnation = 1
 /\ x' = [x EXCEPT !.incarnation = 2, !.restarted = TRUE,
 !.fence = FALSE, !.stage = IF @ = "ceased" THEN "coverage" ELSE @]
\* lib/v1/lending-policy.mjs:838-854: old timestamps cover nothing, current subset only itself.
CoverSubset == /\ x.stage = "coverage"
 /\ \E at \in {1,2}: x' = [x EXCEPT
 !.covered = IF at >= x.required THEN {1} ELSE {}, !.coveredAt = at,
 !.blocked = IF Bug = "coverage" THEN FALSE ELSE TRUE,
 !.partial = TRUE, !.stage = "partial"]
\* lib/v1/lending-policy.mjs:840-857: complete fresh roster AND ceased, reconciled liabilities.
CoverAll == /\ x.stage = "partial"
 /\ x' = [x EXCEPT !.covered = Limits, !.coveredAt = 2, !.blocked = FALSE,
 !.blind = 0, !.actualBlind = 0, !.stage = "done"]
\* lib/v1/lending-pace50-adapter.mjs:481-498; lib/v1/lending-policy.mjs:1374: durable feedback is checked after restart,
\* even when the volatile fence has disappeared. No new reserve until it clears.
AdmissionOpen == ~x.blocked /\ ~x.fence /\ ~x.stopPending
TryReserve == /\ x.stage \in {"repriced", "stopping", "coverage", "partial", "done"}
 /\ ~x.reserved
 /\ LET allowed == ~x.fence /\ ~x.stopPending /\ (Bug = "admission" \/ ~x.blocked) IN
 x' = [x EXCEPT !.reserved = allowed,
 !.admittedUnsafe = @ \/ (allowed /\ (x.running # {} \/ x.held # <<0,0>> \/ x.covered # Limits))]
Next == MeterTrigger \/ BeginRecheck \/ SameSpendNewMeter \/ UnchangedReading
 \/ RateSurprise \/ Drain \/ QueueFeedback \/ On \/ Admit \/ PersistFeedback
 \/ RepriceOutstanding \/ RequestStop \/ CeaseAndRepresent \/ Restart
 \/ CoverSubset \/ CoverAll \/ TryReserve \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
TriggersDrained == x.drained => x.done = x.gen
BlindBudget == x.blind >= x.actualBlind /\ x.actualBlind <= 2
CoverageSound == x.partial /\ x.covered # Limits => x.blocked
FenceOrder == ~x.admittedUnsafe
SettledStable == x.settled = <<1,1>>
W_Trigger == ~(x.done = 2 /\ x.drained)
W_Blind == ~x.renewed
W_Coverage == ~(x.partial /\ x.restarted)
W_Fence == ~(x.stage = "admission")
W_Reprice == ~x.repriced
W_Admission == ~x.reserved
=============================================================================
