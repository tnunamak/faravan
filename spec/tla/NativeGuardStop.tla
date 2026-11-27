-------------------------- MODULE NativeGuardStop --------------------------
EXTENDS NativeGuard
VARIABLE stopState
\* Compose the one-job lender-stop slice. Stop's transport may stutter while
\* use continues; it cannot project a halted/gone execution before cessation.
\* This checks the shared contract, not an implementation refinement proof.
S == INSTANCE Stop WITH x <- stopState, Kind <- "lender",
                       Fault <- "none", RestartPeer <- "none"
combinedVars == <<x, stopState>>
CombinedInit == Init /\ S!Init
CombinedNext ==
 \/ RequestStop /\ S!LocalStop
 \/ (Next /\ ~RequestStop /\ UNCHANGED stopState)
 \/ (S!Next /\ stopState'.stopWanted = stopState.stopWanted
     /\ (stopState'.exec \in {"halted", "gone"} => ~x.running)
     /\ UNCHANGED x)
CombinedSpec == CombinedInit /\ [][CombinedNext]_combinedVars
CessationBeforeCleanup == stopState.cleanup => ~x.running
StopSafety == S!NoFalseStopSuccess /\ S!HoldClosedHasCleanup
=============================================================================
