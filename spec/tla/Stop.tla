------------------------------ MODULE Stop ------------------------------
EXTENDS Naturals, TLC
CONSTANTS Kind, Fault, RestartPeer
VARIABLE x
vars == <<x>>
\* One already-started attempt, one generation; two peer computers and a durable
\* coordinator (co-located with borrower or independently available). Citations
\* are lib/v1/ paths at 73cab697. The backend is synthetic in the replay.
\* lender.mjs:1119-1148, store.mjs:769-780: running attempt and durable reservation.
Init == x = [exec |-> "running", srv |-> "active", produced |-> FALSE,
 stopWanted |-> FALSE, lStop |-> FALSE, bIntent |-> FALSE,
 epoch |-> 0, cancelEpoch |-> 0, staleCancel |-> FALSE, cancelReq |-> FALSE, cancelReply |-> FALSE, work |-> "none", reply |-> "none",
 intent |-> "none", notified |-> FALSE, stoppedReport |-> FALSE,
 cleanup |-> FALSE, hold |-> TRUE, lView |-> "running", bView |-> "running",
 success |-> FALSE, down |-> FALSE, crashed |-> FALSE,
 lostRequest |-> FALSE, lostReply |-> FALSE, measure |-> "none"]
BUp == ~(x.down /\ RestartPeer = "borrower")
LUp == ~(x.down /\ RestartPeer = "lender")
\* cli.mjs:785-801 writes signed cancellation and stable operation key before HTTP.
BorrowerCancel == /\ BUp /\ Kind \in {"cancel", "cancel-race"} /\ ~x.stopWanted
 /\ (Kind # "cancel-race" \/ x.cleanup)
 /\ x' = [x EXCEPT !.stopWanted = TRUE, !.bIntent = TRUE]
\* client.mjs:589-600 sends the same durable payload on retry.
SendCancel == /\ BUp /\ x.bIntent /\ ~x.cancelReq /\ ~x.cancelReply /\ ~x.staleCancel
 /\ x' = [x EXCEPT !.cancelReq = TRUE]
\* store.mjs:1355-1371 commits revocation but compute_stopped stays false.
CommitCancel == /\ x.cancelReq /\ (x.cancelEpoch = x.epoch \/ x.srv = "cancelled")
 /\ x' = [x EXCEPT !.cancelReq = FALSE, !.cancelReply = TRUE,
   !.srv = IF @ = "active" THEN "cancelled" ELSE @]
\* Parsed acknowledgement or definitive terminal refusal retires the pending intent.
ReceiveCancel == /\ BUp /\ x.cancelReply
 /\ x' = [x EXCEPT !.cancelReply = FALSE, !.bIntent = FALSE]
\* lender.mjs:739-767 persists stop journal; lender-pace50.mjs:1419-1422
\* ownerStop -> lending-policy.mjs:905-919 writes owner intent plus stop effect.
LocalStop == /\ LUp /\ Kind \in {"lender", "owner", "finish-stop"} /\ ~x.stopWanted
 /\ x' = [x EXCEPT !.stopWanted = TRUE, !.lStop = TRUE,
   !.intent = "stop", !.lView = "stopping"]
\* lender.mjs:793-803 renew detects cancellation/uncertainty and aborts locally.
ObserveRevocation == /\ LUp /\ x.exec = "running" /\ x.srv = "cancelled" /\ ~x.lStop
 /\ x' = [x EXCEPT !.lStop = TRUE, !.intent = IF @ = "result" THEN @ ELSE "stop",
   !.lView = "stopping"]
\* lender.mjs:736-737; execute cleanup:1225-1257. Stop request is not removal.
StopExecution == /\ LUp /\ x.lStop /\ x.exec = "running" /\ Kind # "finish-stop"
 /\ x' = [x EXCEPT !.exec = "halted"]
\* lender.mjs:793-803 and lib/docker-backend.mjs:2335-2344 watchdog: bounded execution even
\* across a lost cancel request/notification. Fairness assumes watchdog works.
Deadline == /\ x.stopWanted /\ x.exec = "running" /\ Kind # "finish-stop"
 /\ x' = [x EXCEPT !.exec = "halted"]
\* lender.mjs:1119-1144: backend returns valid output before delivery begins.
FinishWork == /\ LUp /\ Kind \in {"malformed", "finish-stop", "cancel-race"}
 /\ x.exec = "running" /\ (Kind # "finish-stop" \/ x.stopWanted)
 /\ x' = [x EXCEPT !.exec = "done", !.produced = TRUE, !.intent = "result", !.lView = "sending"]
\* lender.mjs:1230-1257,1410-1443: backend removal proof survives recovery.
Cleanup == /\ LUp /\ x.exec \in {"halted", "done"} /\ ~x.cleanup
 /\ x' = [x EXCEPT !.exec = "gone", !.cleanup = TRUE,
   !.intent = IF @ = "result" THEN @ ELSE "stop"]
\* lender.mjs:443-447,1412-1414 sends authenticated notification independently
\* of cleanup; 3s bounded request. Notify acknowledgement is never success.
SendNotice == /\ LUp /\ x.lStop /\ ~x.notified /\ x.work = "none" /\ x.reply = "none"
 /\ x' = [x EXCEPT !.work = "notify"]
\* lender.mjs:1144,1461-1479,1509; only proven-clean execution reports stopped.
SendWork == /\ LUp /\ x.cleanup /\ x.work = "none" /\ x.reply = "none"
 /\ x.intent \in {"stop", "result", "stopped"}
 /\ (Kind # "cancel-race" \/ x.srv = "cancelled")
 /\ x' = [x EXCEPT !.work = CASE x.intent = "result" -> "complete"
                                  [] x.intent = "stop" -> "release"
                                  [] OTHER -> "stopped"]
\* store.mjs:1276-1286 notification,1302-1353 complete,799-819 release,
\* 1374-1383 stopped. Completion and cancellation serialize durably.
CommitWork == /\ x.work # "none"
 /\ x' = [x EXCEPT
   !.srv = CASE x.work = "complete" /\ x.srv = "active" -> "accepted"
             [] x.work = "release" /\ x.srv = "active" -> "failed"
             [] OTHER -> @,
   !.stoppedReport = @ \/ x.work = "stopped",
   !.notified = @ \/ x.work = "notify",
   !.reply = CASE x.work = "complete" /\ x.srv \in {"cancelled", "failed"} -> "reject"
             [] x.work = "complete" /\ Fault = "malformed" -> "malformed"
             [] OTHER -> x.work,
   !.work = "none"]
\* client.mjs:279-289,778-781 + lender.mjs:184,1163-1165,1363-1376,
\* Completion reply ambiguity retains the result; refusal retains a cessation report.
ReceiveWork == /\ LUp /\ x.reply # "none"
 /\ x' = [x EXCEPT
   !.intent = CASE x.reply = "reject" -> "stopped"
                [] x.reply = "malformed" -> "result"
                [] x.reply = "complete" -> "done"
                [] x.reply = "release" -> "stopped"
                [] x.reply = "stopped" -> "done"
                [] OTHER -> @,
   !.lView = CASE x.reply = "reject" -> "stopped"
               [] x.reply = "malformed" -> "sending"
               [] x.reply = "complete" -> "finished"
               [] x.reply = "stopped" -> "stopped"
               [] OTHER -> @,
   !.success = @ \/ x.reply = "stopped",
   !.reply = "none"]
\* lender-pace50.mjs:1553-1594, lending-policy.mjs:1230-1262: max charge at
\* all resource resets closes cleanup-proven hold, independent of HTTP ACK.
SettleHold == /\ LUp /\ x.cleanup /\ x.hold
 /\ x' = [x EXCEPT !.hold = FALSE]
\* cli.mjs:712-763, state-projection.mjs:211-236: cancellation stays Stopping
\* until cessation is proven. Accepted result always wins the borrower projection.
BorrowerRead == /\ BUp
 /\ LET visible == CASE x.srv = "accepted" -> "finished"
                         [] x.srv = "failed" -> "failed"
                         [] x.srv = "cancelled" /\ x.stoppedReport -> "stopped"
                         [] x.srv = "cancelled" \/ x.notified -> "stopping"
                         [] OTHER -> "running" IN
    /\ x.bView # visible /\ x' = [x EXCEPT !.bView = visible]
\* client.mjs:279-294 transport ambiguity: no commit/no reply evidence.
LoseRequest == /\ Fault = "request" /\ ~x.lostRequest /\ (x.cancelReq \/ x.work # "none")
 /\ x' = [x EXCEPT !.lostRequest = TRUE, !.cancelReq = FALSE, !.work = "none"]
LoseReply == /\ Fault = "reply" /\ ~x.lostReply /\ (x.cancelReply \/ x.reply # "none")
 /\ x' = [x EXCEPT !.lostReply = TRUE, !.cancelReply = FALSE, !.reply = "none"]
\* cli.mjs:785-801 durable cancel; lender.mjs:1410-1528/1728-1743 durable
\* stop/result recovery. Crash loses transport state, never SQLite or journals.
Crash == /\ RestartPeer # "none" /\ ~x.crashed /\ (x.stopWanted \/ x.produced)
 /\ x' = [x EXCEPT !.crashed = TRUE, !.down = TRUE,
   !.cancelReq = IF RestartPeer = "borrower" THEN FALSE ELSE @,
   !.cancelReply = IF RestartPeer = "borrower" THEN FALSE ELSE @,
   !.work = IF RestartPeer = "lender" THEN "none" ELSE @,
   !.reply = IF RestartPeer = "lender" THEN "none" ELSE @]
Recover == /\ x.down /\ x' = [x EXCEPT !.down = FALSE]
\* Measurement sink failure is recorded without controlling lending.
Measurement == /\ Kind = "measurement" /\ x.measure = "none"
 /\ x' = [x EXCEPT !.measure = "recorded"]
\* runtime timer/idle loops: lender.mjs:1779-1781, lending-runtime.mjs:307-321.
Tick == UNCHANGED vars
AdvanceRoster == /\ x.bIntent /\ x.epoch = 0
 /\ x' = [x EXCEPT !.epoch = 1]
RefuseStaleCancel == /\ x.cancelReq /\ x.cancelEpoch # x.epoch /\ x.srv # "cancelled"
 /\ x' = [x EXCEPT !.cancelReq = FALSE, !.staleCancel = TRUE]
RenewCancel == /\ BUp /\ x.staleCancel /\ ~x.cancelReq
 /\ x' = [x EXCEPT !.cancelEpoch = x.epoch, !.staleCancel = FALSE]
Next == AdvanceRoster \/ RefuseStaleCancel \/ RenewCancel \/ BorrowerCancel \/ SendCancel \/ CommitCancel \/ ReceiveCancel \/ LocalStop
 \/ ObserveRevocation \/ StopExecution \/ Deadline \/ FinishWork \/ Cleanup
 \/ SendNotice \/ SendWork \/ CommitWork \/ ReceiveWork \/ SettleHold \/ BorrowerRead
 \/ LoseRequest \/ LoseReply \/ Crash \/ Recover \/ Measurement \/ Tick
Spec == Init /\ [][Next]_vars
 /\ WF_vars(RefuseStaleCancel) /\ WF_vars(RenewCancel)
 /\ WF_vars(BorrowerCancel) /\ WF_vars(SendCancel) /\ WF_vars(CommitCancel)
 /\ WF_vars(ReceiveCancel) /\ WF_vars(LocalStop) /\ WF_vars(ObserveRevocation)
 /\ WF_vars(StopExecution) /\ WF_vars(Deadline) /\ WF_vars(FinishWork)
 /\ WF_vars(Cleanup) /\ WF_vars(SendWork) /\ WF_vars(CommitWork)
 /\ WF_vars(ReceiveWork) /\ WF_vars(SettleHold) /\ WF_vars(BorrowerRead)
 /\ WF_vars(Recover) /\ WF_vars(Measurement)
TypeOK == /\ x.exec \in {"running", "halted", "done", "gone"}
          /\ x.srv \in {"active", "cancelled", "failed", "accepted"}
NoFalseStopSuccess == (x.success \/ x.bView = "stopped") => x.exec = "gone"
HoldClosedHasCleanup == ~x.hold => x.cleanup
FinishedNeverFailed == x.produced => (x.lView # "failed" /\ x.bView # "failed")
MeasurementNotSilentlyLost == x.measure # "lost_silently"
StoppedSandboxGone == x.stopWanted ~> (x.exec = "gone")
StoppedHoldClosed == x.stopWanted ~> ~x.hold
BorrowerFinal == x.stopWanted ~> (x.bView \in {"finished", "failed", "stopped"})
CancelRenewalProgress == (Kind = "cancel") => (x.bIntent ~> ~x.bIntent)
=============================================================================
