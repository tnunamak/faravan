---------------------------- MODULE LendingLease ----------------------------
(***************************************************************************)
(* The lending lease and launch fence for one job, as implemented on       *)
(* fix/launch-fence-1101 (b4f581f2):                                       *)
(*   coordinator  lib/v1/store.mjs   claim, renew, start, observed-start,  *)
(*                                   release/fail, stopped, complete,      *)
(*                                   normalize (lease expiry, the fence    *)
(*                                   and its time bound), try counting.    *)
(*   lender       lib/v1/lender.mjs  claim -> prepare -> start -> launch,  *)
(*                                   durable observation intents, the      *)
(*                                   launch ack, renew, the local lease    *)
(*                                   timer, stop reports, crash recovery.  *)
(*   guest        lib/docker-backend.mjs  the agent waits for the launch   *)
(*                                   ack; the wall watchdog kills it at    *)
(*                                   the sandbox deadline + stop window.   *)
(*                                                                         *)
(* Time is in ticks. The constants keep the inequalities the code relies   *)
(* on, not the exact seconds (see README.md for the mapping):              *)
(*   Kill <= MaxLease   the guard stop window (32 s) fits in one lease     *)
(*   Behind <= MaxLease a lender clock may lag by the proof age (300 s)    *)
(*   Ahead  < MaxLease  a lender clock may lead by 60 s                    *)
(*                                                                         *)
(* ASSUMPTIONS (each is what the code assumes; the variants drop some):    *)
(*  A1 The coordinator's state is durable: every handler is one SQLite     *)
(*     transaction. A coordinator restart loses only requests in flight;   *)
(*     the "lost" outcomes of each round trip cover that.                  *)
(*  A2 The coordinator clock is the reference clock ("now"). A lender's    *)
(*     clock is now + off[l], with -Behind <= off <= Ahead: the proof date  *)
(*     window [now-300 s, now+60 s] (lib/protocol verifyRequestMetadata)   *)
(*     rejects every request from a lender outside it.                     *)
(*  A3 The guest watchdog kills the agent's process group at              *)
(*     prepare time + Wall + Kill, on a guest clock that keeps pace with  *)
(*     real time even while the lender is dead.                           *)
(*     (Escape = TRUE drops this: the kill may never happen.)             *)
(*  A4 The agent cannot run before the launch ack file holds the secret;  *)
(*     only the live lender process knows the secret, and it writes the   *)
(*     ack only after the coordinator accepted observed-start and its own *)
(*     lease still looks valid. (AckGate = FALSE drops this: the agent    *)
(*     runs as soon as the lender launches it, as before the ack.)        *)
(*  A5 Durable lender writes (pending attempt, observation intents, stop  *)
(*     and result intents) finish before the step that depends on them.   *)
(*     A crash loses only volatile state; sandboxes keep running.         *)
(*  A6 Crash recovery removes the pending sandbox before it reports       *)
(*     /stopped (backend.reconcilePending proof).                         *)
(*  A7 Requests and answers may be lost. Observed-start requests and      *)
(*     answers may also be delayed without bound and reordered (they are  *)
(*     the only messages whose delay changes the outcome: the store       *)
(*     accepts a late observation). Every other call is one round trip    *)
(*     whose request or answer may be lost; a delayed call of those kinds *)
(*     equals the same call made later. Idempotent replays equal fresh    *)
(*     calls. Accepting any observation delay over-approximates the proof *)
(*     date window, which is sound for the safety checks.                 *)
(*  A8 One job. The author never cancels, and no member is revoked.       *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, TLC

CONSTANTS Lenders, MaxAttempts, MaxGen, Lease, Wall, MaxLease, Kill,
          Ahead, Behind, Expiry, MaxNet, CrashLenders,
          AckGate,   \* TRUE in this branch: the agent waits for the launch ack
          Escape     \* FALSE in this branch's assumptions: the watchdog always kills

Gens == 1..MaxGen
Terminal == {"failed", "expired", "done"}
Holding == {"held", "prepared", "observing", "running"}
Live == {"prepared", "waiting", "agent"}

VARIABLES
  now,       \* coordinator (reference) clock
  off,       \* [Lenders -> offset] lender clock = now + off[l]
  jstate,    \* job state at the coordinator
  jreason,   \* job terminal_reason: "none" | "lease" | "other"
  gen,       \* job.generation = index of the current attempt (0: none yet)
  tries,     \* job.attempts_started
  att,       \* [Gens -> attempt record] (attempt id == generation here)
  net,       \* observed-start requests in flight
  lend,      \* [Lenders -> volatile lender state]
  dur,       \* [Lenders -> durable lender state]
  sbx,       \* [Gens -> "none" | "prepared" | "waiting" | "agent" | "dead"]
  killAt,    \* [Gens -> time at which the guest watchdog kills]
  ran,       \* ghost: attempts whose agent really ran
  accepted,  \* ghost: attempts whose result the coordinator accepted
  staleHit   \* ghost: a request for an older attempt changed the job under a live newer try

vars == <<now, off, jstate, jreason, gen, tries, att, net, lend, dur, sbx, killAt, ran, accepted, staleHit>>
coordVars == <<jstate, jreason, gen, tries, att, accepted, staleHit>>

NoAtt == [holder |-> "none", st |-> "none", lexp |-> 0, started |-> FALSE,
          observed |-> FALSE, stopped |-> FALSE, isoPass |-> FALSE, why |-> "none"]
Idle == [up |-> TRUE, ph |-> "idle", g |-> 0, llexp |-> 0, isoPass |-> FALSE]

Init ==
  /\ now = 0
  /\ off \in [Lenders -> {-Behind, 0, Ahead}]
  /\ jstate = "queued" /\ jreason = "none" /\ gen = 0 /\ tries = 0
  /\ att = [g \in Gens |-> NoAtt]
  /\ net = {}
  /\ lend = [l \in Lenders |-> Idle]
  /\ dur = [l \in Lenders |-> [pend |-> 0, obs |-> {}, stop |-> {}, result |-> 0]]
  /\ sbx = [g \in Gens |-> "none"]
  /\ killAt = [g \in Gens |-> 0]
  /\ ran = {} /\ accepted = {} /\ staleHit = FALSE

LNow(l) == now + off[l]
Min(a, b) == IF a < b THEN a ELSE b
Max(a, b) == IF a > b THEN a ELSE b

(***************************************************************************)
(* Coordinator (store.mjs)                                                 *)
(***************************************************************************)
\* unknownLaunch: a start the coordinator authorized but never saw begin.
Unknown(g) == att[g].started /\ ~att[g].observed
\* fenced: such a start whose attempt ended without a result, before /stopped.
Fenced(g) == att[g].st \in {"released", "failed", "expired"} /\ Unknown(g) /\ ~att[g].stopped
\* fenceBound with a schema-valid wall limit.
Bound(g) == att[g].lexp + Wall + MaxLease
FenceEnded(g) == Fenced(g) /\ now >= Bound(g)

\* normalize() has work to do. Every handler normalizes first; the model applies it
\* eagerly instead, as a step that must happen before any other (it is a pure
\* function of the stored state and the clock, so the two are equivalent).
NeedNorm ==
  /\ jstate \notin Terminal
  /\ \/ Expiry <= now
     \/ gen > 0 /\ jstate = "claimed" /\ att[gen].st = "active" /\ att[gen].lexp <= now
     \/ gen > 0 /\ jstate = "claimed" /\ FenceEnded(gen)

Normalize ==
  /\ NeedNorm
  /\ IF Expiry <= now THEN
       /\ jstate' = "expired" /\ jreason' = "other"
       /\ att' = IF gen > 0 /\ att[gen].st = "active"
                 THEN [att EXCEPT ![gen].st = "expired", ![gen].why = "other"] ELSE att
     ELSE IF att[gen].st = "active" /\ att[gen].lexp <= now THEN
       /\ att' = [att EXCEPT ![gen].st = "expired", ![gen].why = "lease"]
       /\ IF Unknown(gen) /\ now < Bound(gen)
          THEN UNCHANGED <<jstate, jreason>>   \* the launch fence holds the job
          ELSE /\ jstate' = IF att[gen].observed \/ tries >= MaxAttempts THEN "failed" ELSE "queued"
               /\ jreason' = "lease"
     ELSE \* the fence's time bound passed
       /\ jstate' = IF tries >= MaxAttempts THEN "failed" ELSE "queued"
       /\ jreason' = IF att[gen].why = "lease" THEN "lease" ELSE "other"
       /\ UNCHANGED att
  /\ UNCHANGED <<now, off, gen, tries, net, lend, dur, sbx, killAt, ran, accepted, staleHit>>

\* active(): the attempt holds a live, unfenced lease on the current generation.
Active(l, g) ==
  /\ att[g].holder = l /\ gen = g
  /\ jstate = "claimed"
  /\ ~Fenced(g)
  /\ att[g].st = "active" /\ att[g].lexp > now

\* The lender hears an observation answer: the durable intent is cleared either way.
\* With the ack gate it writes the ack only if its own lease still looks valid.
\* (A delayed answer equals the lender hearing it later, so answers are not queued.)
HearObs(l, g, ok) ==
  /\ dur' = [dur EXCEPT ![l].obs = @ \ {g}]
  /\ IF lend[l].up /\ lend[l].ph = "observing" /\ g = lend[l].g
     THEN IF ok /\ LNow(l) < lend[l].llexp
          THEN /\ lend' = [lend EXCEPT ![l].ph = "running"]
               /\ IF AckGate /\ sbx[g] = "waiting"
                  THEN /\ sbx' = [sbx EXCEPT ![g] = "agent"] /\ ran' = ran \cup {g}
                  ELSE UNCHANGED <<sbx, ran>>
          ELSE /\ lend' = [lend EXCEPT ![l].ph = "stopping"] /\ UNCHANGED <<sbx, ran>>
     ELSE UNCHANGED <<lend, sbx, ran>>

\* observeExecutionStart. It checks holder, generation and an authorized start,
\* but not that the attempt is current: a late observation of a freed try still
\* spends a try (368d4ca2 "count a late observation of a freed try").
ObserveDeliver ==
  /\ \E m \in net :
     LET g == m.g
         l == m.who
         okc == att[g].holder = l /\ att[g].started
     IN /\ net' = net \ {m}
        /\ IF okc /\ ~att[g].observed
           THEN LET gone == att[g].stopped \/ (jstate \notin Terminal /\ FenceEnded(g))
                    wasFenced == Fenced(g) /\ ~gone
                    t1 == tries + 1
                    resolve == wasFenced /\ jstate \notin Terminal /\ gen = g
                    spentOut == gone /\ jstate = "queued" /\ t1 >= MaxAttempts
                    js == IF resolve \/ spentOut THEN "failed" ELSE jstate
                IN /\ att' = [att EXCEPT ![g].observed = TRUE]
                   /\ tries' = t1
                   /\ jstate' = js
                   /\ jreason' = IF js # jstate THEN (IF att[g].why = "lease" THEN "lease" ELSE "other") ELSE jreason
                   \* A late observation may spend the last try of a queued job (by design);
                   \* it must never change the job while a newer try holds a live lease.
                   /\ staleHit' = (staleHit \/ (gen # g /\ js # jstate /\ att[gen].st = "active"))
           ELSE UNCHANGED <<att, tries, jstate, jreason, staleHit>>
        /\ \/ HearObs(l, g, okc)
           \/ UNCHANGED <<lend, dur, sbx, ran>>      \* the answer is lost
  /\ UNCHANGED <<now, off, gen, accepted, killAt>>

(***************************************************************************)
(* Lender (lender.mjs), with each other call as one round trip.            *)
(* A lender serves one job at a time.                                      *)
(***************************************************************************)
Ph(l, ph) == [lend EXCEPT ![l].ph = ph]
Outcomes == {"lost", "unheard", "heard"}   \* request lost / applied, answer lost / answered

\* claim (store claim; client claimJob). The lender saves the pending attempt first.
Claim(l) ==
  /\ lend[l].up /\ lend[l].ph = "idle" /\ dur[l].pend = 0 /\ dur[l].result = 0
  /\ jstate = "queued" /\ tries < MaxAttempts /\ gen < MaxGen /\ Expiry - now >= 1
  /\ \E o \in {"unheard", "heard"} :
       LET g == gen + 1
           e == Min(now + Lease, Expiry)
       IN /\ gen' = g /\ jstate' = "claimed"
          /\ att' = [att EXCEPT ![g] = [NoAtt EXCEPT !.holder = l, !.st = "active", !.lexp = e]]
          /\ IF o = "heard"
             THEN /\ lend' = [lend EXCEPT ![l] = [up |-> TRUE, ph |-> "held", g |-> g, llexp |-> e, isoPass |-> FALSE]]
                  /\ dur' = [dur EXCEPT ![l].pend = g]
             ELSE UNCHANGED <<lend, dur>>
  /\ UNCHANGED <<now, off, jreason, tries, net, sbx, killAt, ran, accepted, staleHit>>

\* prepare(): creates the sandbox and its wall deadline. The watchdog's kill time
\* is the sandbox deadline plus the guard's stop window.
Prepare(l) ==
  /\ lend[l].up /\ lend[l].ph = "held" /\ LNow(l) < lend[l].llexp
  /\ LET g == lend[l].g IN
     /\ sbx' = [sbx EXCEPT ![g] = "prepared"]
     /\ killAt' = [killAt EXCEPT ![g] = now + Wall + Kill]
  /\ lend' = Ph(l, "prepared")
  /\ UNCHANGED <<now, off, net, dur, ran, coordVars>>

\* start (store start, which checks but never counts a try; client startAttempt then
\* re-reads the attempt and needs it active with a lease valid on its own clock).
\* On success the lender execs the guarded command; the guard reports "started"; the
\* lender saves an observation intent, then sends it. Without the ack gate the agent
\* itself runs from this point.
\* A deterministic isolation refusal occurs while prepared, before authorization.
\* Both failed and inconclusive checks use this existing stop/report recovery path.
\* isoPass belongs to this lender's current preparation. att.isoPass is a ghost
\* history bit retained after a crash, so an already-running sandbox stays covered.
IsolationPass(l) ==
  /\ lend[l].up /\ lend[l].ph = "prepared" /\ ~lend[l].isoPass
  /\ Active(l, lend[l].g)
  /\ lend' = [lend EXCEPT ![l].isoPass = TRUE]
  /\ att' = [att EXCEPT ![lend[l].g].isoPass = TRUE]
  /\ UNCHANGED <<now, off, net, dur, sbx, killAt, ran, jstate, jreason, gen, tries, accepted, staleHit>>

IsolationAdmission(l) == lend[l].isoPass
SkipIsolation(l) == TRUE  \* mutation: authorize without running the check

IsolationRefusal(l) ==
  /\ lend[l].up /\ lend[l].ph = "prepared" /\ ~lend[l].isoPass
  /\ lend' = Ph(l, "stopping")
  /\ UNCHANGED <<now, off, net, dur, sbx, killAt, ran, coordVars>>

Start(l) ==
  /\ lend[l].up /\ lend[l].ph = "prepared"
  /\ IsolationAdmission(l)
  /\ LET g == lend[l].g
         okc == Active(l, g) /\ tries < MaxAttempts
     IN \E o \in Outcomes :
        /\ att' = IF o # "lost" /\ okc THEN [att EXCEPT ![g].started = TRUE] ELSE att
        /\ IF o = "heard" /\ okc /\ LNow(l) < att[g].lexp /\ sbx[g] = "prepared"
           THEN /\ dur' = [dur EXCEPT ![l].obs = @ \cup {g}]
                /\ net' = net \cup {[who |-> l, g |-> g]}
                /\ IF AckGate
                   THEN /\ lend' = [lend EXCEPT ![l].ph = "observing", ![l].llexp = Max(@, att[g].lexp)]
                        /\ sbx' = [sbx EXCEPT ![g] = "waiting"] /\ UNCHANGED ran
                   ELSE /\ lend' = [lend EXCEPT ![l].ph = "running", ![l].llexp = Max(@, att[g].lexp)]
                        /\ sbx' = [sbx EXCEPT ![g] = "agent"] /\ ran' = ran \cup {g}
           ELSE /\ lend' = Ph(l, "stopping")
                /\ UNCHANGED <<dur, net, sbx, ran>>
  /\ UNCHANGED <<now, off, jstate, jreason, gen, tries, killAt, accepted, staleHit>>

\* Durable observation intents are resent until answered (sendObservations).
ResendObs(l) ==
  /\ lend[l].up
  /\ \E g \in dur[l].obs : net' = net \cup {[who |-> l, g |-> g]}
  /\ UNCHANGED <<now, off, lend, dur, sbx, killAt, ran, coordVars>>

\* renew. A failed renew, or one whose new lease is already past on the lender's clock, stops the run.
Renew(l) ==
  /\ lend[l].up /\ lend[l].ph \in Holding
  /\ LET g == lend[l].g
         e == Min(Max(att[g].lexp, now + Lease), Expiry)
     IN \E o \in Outcomes :
        /\ att' = IF o # "lost" /\ Active(l, g) THEN [att EXCEPT ![g].lexp = e] ELSE att
        /\ lend' = IF o # "heard" THEN lend
                   ELSE IF Active(l, g) /\ LNow(l) < e THEN [lend EXCEPT ![l].llexp = Max(@, e)]
                   ELSE Ph(l, "stopping")
  /\ UNCHANGED <<now, off, jstate, jreason, gen, tries, net, dur, sbx, killAt, ran, accepted, staleHit>>

\* The local lease timer (armDeadline) fires.
LeaseTimer(l) ==
  /\ lend[l].up /\ lend[l].ph \in Holding /\ LNow(l) >= lend[l].llexp
  /\ lend' = Ph(l, "stopping")
  /\ UNCHANGED <<now, off, net, dur, sbx, killAt, ran, coordVars>>

\* Stop: remove the sandbox, keep a durable stop intent, and go idle.
Stop(l) ==
  /\ lend[l].up /\ lend[l].ph = "stopping"
  /\ LET g == lend[l].g IN
     /\ sbx' = [sbx EXCEPT ![g] = IF @ = "none" THEN "none" ELSE "dead"]
     /\ dur' = [dur EXCEPT ![l].pend = 0, ![l].stop = @ \cup {g}]
  /\ lend' = [lend EXCEPT ![l] = Idle]
  /\ UNCHANGED <<now, off, net, killAt, ran, coordVars>>

\* A stop intent is reported as release / fail (finishAttempt), then /stopped, and
\* resent until /stopped is answered. Release: an unobserved authorized start is
\* fenced like a lost lease; anything else frees or ends the job. A refused release
\* (the lease already ended) changes nothing. /stopped: the holder proved its sandbox
\* gone, which ends a fence without spending a try.
ReleaseEffect(l, g) ==
  IF Active(l, g)
  THEN [st |-> "released", why |-> "other",
        js |-> IF Unknown(g) THEN jstate ELSE IF att[g].observed \/ tries >= MaxAttempts THEN "failed" ELSE "queued",
        jr |-> IF Unknown(g) THEN jreason ELSE "other"]
  ELSE [st |-> att[g].st, why |-> att[g].why, js |-> jstate, jr |-> jreason]

StopReport(l) ==
  /\ lend[l].up
  /\ \E g \in dur[l].stop, o \in {"release_only", "unheard", "heard"} :
     LET r == ReleaseEffect(l, g)
         a1 == [att EXCEPT ![g].st = r.st, ![g].why = r.why]
         canStop == a1[g].holder = l /\ a1[g].st \notin {"active", "none"}
         fenced1 == a1[g].st \in {"released", "failed", "expired"} /\ a1[g].started
                    /\ ~a1[g].observed /\ ~a1[g].stopped
         resolve == canStop /\ fenced1 /\ r.js \notin Terminal /\ gen = g
     IN IF o = "release_only" \/ ~canStop
        THEN /\ att' = a1 /\ jstate' = r.js /\ jreason' = r.jr /\ UNCHANGED dur
        ELSE /\ att' = [a1 EXCEPT ![g].stopped = TRUE]
             /\ jstate' = IF resolve THEN (IF tries >= MaxAttempts THEN "failed" ELSE "queued") ELSE r.js
             /\ jreason' = IF resolve THEN (IF a1[g].why = "lease" THEN "lease" ELSE "other") ELSE r.jr
             /\ dur' = IF o = "heard" THEN [dur EXCEPT ![l].stop = @ \ {g}] ELSE dur
  /\ UNCHANGED <<now, off, gen, tries, net, lend, sbx, killAt, ran, accepted, staleHit>>

\* The run ends (the agent exits, or the watchdog or deadline killed it): the lender
\* removes the sandbox and saves the result intent.
Finish(l) ==
  /\ lend[l].up /\ lend[l].ph = "running"
  /\ LET g == lend[l].g IN
     /\ sbx' = [sbx EXCEPT ![g] = "dead"]
     /\ dur' = [dur EXCEPT ![l].pend = 0, ![l].result = g]
  /\ lend' = [lend EXCEPT ![l] = Idle]
  /\ UNCHANGED <<now, off, net, killAt, ran, coordVars>>

\* complete. A lease fences execution, not delivery: the "delayed" branch accepts a
\* result for the current attempt of a job that failed only because its lease expired.
Complete(l) ==
  /\ lend[l].up /\ dur[l].result # 0
  /\ LET g == dur[l].result
         delayed == jstate = "failed" /\ jreason = "lease" /\ att[g].st \in {"active", "expired"}
                    /\ att[g].why \in {"none", "lease"} /\ gen = g /\ att[g].holder = l
         ok == att[g].started /\ (delayed \/ Active(l, g))
     IN \E o \in Outcomes :
        /\ IF o # "lost" /\ ok
           THEN /\ att' = [att EXCEPT ![g].st = "completed"]
                /\ jstate' = "done"
                /\ accepted' = accepted \cup {g}
                /\ staleHit' = (staleHit \/ gen # g)
           ELSE UNCHANGED <<att, jstate, accepted, staleHit>>
        /\ dur' = IF o = "heard" THEN [dur EXCEPT ![l].result = 0] ELSE dur
  /\ UNCHANGED <<now, off, jreason, gen, tries, net, lend, sbx, killAt, ran>>

\* Only lenders in CrashLenders crash; a crash matters only while a job is in hand.
Crash(l) ==
  /\ l \in CrashLenders /\ lend[l].up /\ lend[l].ph # "idle"
  /\ lend' = [lend EXCEPT ![l] = [up |-> FALSE, ph |-> "down", g |-> 0, llexp |-> 0, isoPass |-> FALSE]]
  /\ UNCHANGED <<now, off, net, dur, sbx, killAt, ran, coordVars>>

\* Restart recovery (reconcilePending): remove the pending sandbox, then release
\* ("restart_interrupted") and report /stopped through the durable stop intent.
Restart(l) ==
  /\ ~lend[l].up
  /\ LET g == dur[l].pend IN
     /\ sbx' = IF g # 0 /\ sbx[g] # "none" THEN [sbx EXCEPT ![g] = "dead"] ELSE sbx
     /\ dur' = IF g # 0 THEN [dur EXCEPT ![l].pend = 0, ![l].stop = @ \cup {g}] ELSE dur
  /\ lend' = [lend EXCEPT ![l] = Idle]
  /\ UNCHANGED <<now, off, net, killAt, ran, coordVars>>

Lender(l) ==
  \/ Claim(l) \/ Prepare(l) \/ IsolationPass(l) \/ IsolationRefusal(l) \/ Start(l) \/ ResendObs(l)
  \/ Renew(l) \/ LeaseTimer(l) \/ Stop(l) \/ StopReport(l)
  \/ Finish(l) \/ Complete(l) \/ Crash(l) \/ Restart(l)

(***************************************************************************)
(* Environment                                                             *)
(***************************************************************************)
Drop ==
  /\ \E m \in net : net' = net \ {m}
  /\ UNCHANGED <<now, off, lend, dur, sbx, killAt, ran, coordVars>>

\* The guest watchdog (A3). It is urgent: time cannot pass a due kill.
WatchdogDue(g) == sbx[g] \in Live /\ now >= killAt[g]
Watchdog ==
  /\ \E g \in Gens : WatchdogDue(g) /\ sbx' = [sbx EXCEPT ![g] = "dead"]
  /\ UNCHANGED <<now, off, net, lend, dur, killAt, ran, coordVars>>

Tick ==
  /\ now < Expiry
  /\ ~NeedNorm
  /\ Escape \/ \A g \in Gens : ~WatchdogDue(g)
  /\ now' = now + 1
  /\ UNCHANGED <<off, net, lend, dur, sbx, killAt, ran, coordVars>>

\* The end: the job is terminal and the clock reached the horizon. Not a deadlock.
Done ==
  /\ now = Expiry /\ jstate \in Terminal
  /\ UNCHANGED vars

Next ==
  \/ Normalize
  \/ ~NeedNorm /\ (ObserveDeliver \/ \E l \in Lenders : Lender(l))
  \/ Drop \/ Watchdog \/ Tick \/ Done

Spec == Init /\ [][Next]_vars /\ WF_vars(Tick) /\ WF_vars(Normalize) /\ WF_vars(Watchdog)

\* Bound the message pool so that TLC terminates.
NetBound == Cardinality(net) <= MaxNet
Sym == Permutations(Lenders)

(***************************************************************************)
(* Properties                                                              *)
(***************************************************************************)
TypeOK ==
  /\ jstate \in {"queued", "claimed"} \cup Terminal
  /\ gen \in 0..MaxGen /\ tries \in 0..(MaxGen + 1)

\* I1: never two sandboxes executing the agent at once. A sandbox stays "agent"
\* until a lender removes it or the watchdog kills it.
I1_OneExecuting == Cardinality({g \in Gens : sbx[g] = "agent"}) <= 1

\* I2a: real agent runs never exceed max_attempts.
I2a_RunsWithinMax == Cardinality(ran) <= MaxAttempts
\* I2b: every sandbox whose agent really started was counted as a try.
I2b_RunsCounted == Cardinality(ran) <= tries
\* I2d: T21 ends the job after any run that started the agent, so a job runs at
\* most once, whatever max_attempts says.
I2d_AtMostOneRun == Cardinality(ran) <= 1
\* I2c: the try counter never exceeds max_attempts.
I2c_CounterWithinMax == tries <= MaxAttempts

\* I4: a stale lender never completes for, or changes the job under, a newer try.
I4_NoStaleEffect == ~staleHit /\ \A g \in accepted : g = gen

\* I3 (bounded, as a safety check): a claimed job always has a live lease or a
\* fence whose time bound has not passed, so a finite deadline frees it.
I3s_ClaimHasDeadline ==
  (~NeedNorm /\ jstate = "claimed") =>
    \/ att[gen].st = "active" /\ now < att[gen].lexp
    \/ Fenced(gen) /\ now < Bound(gen)

I5_IsolationBeforeRun == \A g \in ran : att[g].isoPass
W_NoIsolationRun == ran = {}

\* Reachability witnesses: each must be VIOLATED, which shows the bounds reach the
\* paths the invariants are about (a check that passes vacuously proves nothing).
W_NoSuccessorAfterUnknownLaunch == ~(gen = 2 /\ att[1].started /\ ~att[1].observed /\ att[2].started)
W_NoLateObservation == ~(att[1].observed /\ att[1].stopped /\ gen = 2)
W_NoDelayedResult == ~(\E g \in accepted : att[g].why = "lease")

\* I3 (liveness): a claimed job always leaves "claimed" under fair time.
I3_NeverStuck == [](jstate = "claimed" => <>(jstate # "claimed"))
=============================================================================
