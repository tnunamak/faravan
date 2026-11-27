------------------------------- MODULE Hosting -------------------------------
(***************************************************************************)
(* Reviewed: 57712e0115584d4d00bc9af59f79cf904f309f10.                      *)
(* Primary-circle hosting abstraction: two homes, two ports, two process  *)
(* slots (each with two incarnations). No uniqueness guard is assumed.    *)
(* A live child includes startup before bind; serving means the circle's *)
(* committed state is available, not merely that a socket is listening.   *)
(*                                                                       *)
(* Boundaries: one circle C; successful identity/provisioning/publication *)
(* calls abstract their internals. Invalid signed identity refuses. The   *)
(* store implementation and startServer child internals are outside this  *)
(* model's reviewed source boundary. In particular, Launch models a child *)
(* returned by startServer before waitReady, NOT proof that two children  *)
(* can both bind or serve. One listener per port abstracts one bind domain*)
(* (different IP addresses on one numeric port are not explored).         *)
(*                                                                       *)
(* Atomic identity capture+signal excludes the documented final PID reuse*)
(* race (lib/v1/host.mjs:85-89). Incarnation comparisons DO distinguish a  *)
(* stale recorded PID from a new child. Crashes can occur between every   *)
(* action; abrupt launcher death does not imply child cleanup. Graceful   *)
(* failure, unlike abrupt death, stops only the child that launch owns.   *)
(* Tunnels, additional circles/router replacement, supervisor scheduling, *)
(* OS signal timing, and wall-clock lock budgets are not fully modeled.   *)
(* ResumeTimeout represents exhaustion of the real finite lock wait.     *)
(* GenCheck=FALSE and WaitResume=FALSE are historical comparison variants;*)
(* current-code configurations set both TRUE. No TLC run is claimed.      *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS MaxRequests, MaxAppStarts, Unreadable, ExplicitHome,
          DiscoverLegacy, GenCheck, WaitResume, AllowCrash, DirectHomes
Homes == {"A", "B"}
Ports == {1, 2}
Pids == {1, 2}
OpIds == {1, 2}
Circle == "C"
NoOwner == [pid |-> 0, incarnation |-> 0]
EmptyOp == [kind |-> "none", home |-> "A", ph |-> "free",
            generation |-> 0, pid |-> 0, incarnation |-> 0,
            adopted |-> FALSE, clear |-> FALSE, seq |-> 0,
            initialQuiet |-> FALSE, portSignalled |-> FALSE,
            expected |-> NoOwner]
EmptyProcess(p) ==
  [pid |-> p, incarnation |-> 0, home |-> "A", circle |-> "none",
   port |-> 1, phase |-> "down", live |-> FALSE, stateHome |-> "none",
   signalled |-> FALSE]

VARIABLE s
vars == <<s>>
lock == s.lock
occupancy == s.occupancy
processes == s.processes
FreeOps == {i \in OpIds : s.ops[i].ph = "free"}
Owner(p) == [pid |-> p, incarnation |-> processes[p].incarnation]
RecordedAlive(h) ==
  \E p \in Pids : s.status[h] = Owner(p) /\ processes[p].live
                  /\ processes[p].home = h
RecordedPid(h) == CHOOSE p \in Pids : s.status[h] = Owner(p)
OwnListener(h, port) ==
  \E p \in Pids : occupancy[port] = p /\ processes[p].live
                  /\ processes[p].home = h
Serving(h) == \E p \in Pids : processes[p].live
                /\ processes[p].home = h /\ processes[p].phase = "serving"

(* Initial durable snapshots: lib/v1/host.mjs:17-29, 201-214, 249-251.
   State already committed at one home; naming can precede provisioning.
   Empty process/status state represents a machine restart. *)
Init ==
  /\ s \in [
       config : [Homes -> [exists : BOOLEAN, named : BOOLEAN,
                          wanted : {"unset", "yes", "no"},
                          generation : {0}, port : Ports,
                          knownOrigin : BOOLEAN]],
       committed : SUBSET Homes,
       processes : [Pids -> {EmptyProcess(1), EmptyProcess(2)}],
       status : [Homes -> {NoOwner}],
       lock : [Homes -> {0}],
       occupancy : [Ports -> {0}],
       ops : [OpIds -> {EmptyOp}],
       app : {"down"}, appHome : {"none"}, appStarts : {0},
       appSpawns : {0}, appGeneration : {0}, requests : {0},
       stopOK : [Homes -> BOOLEAN], badSignal : {FALSE},
       disrupted : {FALSE}, timedOut : {FALSE}]
  /\ s.processes = [p \in Pids |-> EmptyProcess(p)]
  /\ Cardinality(s.committed) <= 1
  /\ \A h \in Homes :
       /\ s.config[h].named => s.config[h].exists
       /\ h \in s.committed => s.config[h].named
       /\ s.config[h].named => s.config[h].knownOrigin
       /\ s.config[h].wanted = "yes" => h \in s.committed
       /\ ~s.stopOK[h]

(* lib/host.mjs:26-47, 52-55, 61-80. B is one representative
   legacy candidate; unreadable ownership means no owned-circle matches,
   NOT unconditional selection of A: stable-default fallback still runs. *)
Resolve(readOK) ==
  LET matches == {h \in Homes : s.config[h].named /\ readOK}
      committedV1 == {h \in Homes : s.config[h].exists}
  IN IF ExplicitHome \in Homes THEN ExplicitHome
     ELSE IF Cardinality(matches) > 1 THEN "conflict"
     ELSE IF matches # {} THEN CHOOSE h \in matches : TRUE
     ELSE IF ~DiscoverLegacy THEN "A"
     ELSE IF Cardinality(committedV1) > 1 THEN "conflict"
     ELSE IF committedV1 # {} THEN CHOOSE h \in committedV1 : TRUE
     ELSE "A"

(* lib/v1/host-command.mjs:34-49; host-intent.mjs:13-29.
   Pure record helper: the detached operation retains its chosen home and
   observed generation, even if a stop executes before it gets the lock. *)
NewOp(kind, h, clear, expected) ==
  [EmptyOp EXCEPT !.kind = kind, !.home = h, !.ph = "spawned",
    !.generation = s.config[h].generation, !.clear = clear,
    !.expected = expected, !.seq = s.requests + 1]

(* lib/v1/host-intent.mjs:13-29; lib/host.mjs:26-47.
   One resume decision per app start; no retry loop is manufactured. *)
AppStart ==
  /\ s.app = "down" /\ s.appStarts < MaxAppStarts
  /\ \E readOK \in (IF Unreadable THEN BOOLEAN ELSE {TRUE}) :
     LET h == Resolve(readOK) IN
     /\ IF h \in Homes
           THEN IF s.config[h].wanted = "yes" /\ s.config[h].named
                   /\ ~RecordedAlive(h) /\ FreeOps # {}
                   /\ s.requests < MaxRequests
                THEN \E i \in FreeOps :
                  s' = [s EXCEPT !.app = "up", !.appHome = h,
                    !.appStarts = @ + 1, !.appSpawns = 1,
                    !.appGeneration = s.config[h].generation,
                    !.requests = @ + 1,
                    !.ops[i] = NewOp("resume", h, FALSE, NoOwner)]
                ELSE s' = [s EXCEPT !.app = "up", !.appHome = h,
                    !.appStarts = @ + 1, !.appSpawns = 0]
           ELSE s' = [s EXCEPT !.app = "up", !.appHome = h,
                    !.appStarts = @ + 1, !.appSpawns = 0]

(* lib/v1/host-command.mjs:44-49: detached child outlives app exit.
   Environmental app exit, not an implementation-level cleanup promise. *)
AppDown ==
  /\ s.app = "up"
  /\ s' = [s EXCEPT !.app = "down", !.appHome = "none"]

(* lib/v1/host-command.mjs:15-24, 34-49. Explicit override is resolved
   before spawn (lib/host.mjs:27-28). DirectHomes also explores explicit
   CLI calls to either home; otherwise operations use the app's resolution.
   Resume uses AppStart, not this owner's start action. *)
OwnerStart ==
  /\ s.app = "up" /\ s.requests < MaxRequests
  /\ \E i \in FreeOps,
        h \in (IF DirectHomes THEN Homes ELSE {s.appHome} \cap Homes) :
       s' = [s EXCEPT !.ops[i] = NewOp("start", h, FALSE, NoOwner),
             !.requests = @ + 1, !.stopOK[h] = FALSE]

(* lib/v1/host.mjs:337-363. clear=TRUE is an owner's stop;
   clear=FALSE retains intent. A maintenance caller may capture an owner. *)
RequestStop ==
  /\ s.app = "up" /\ s.requests < MaxRequests
  /\ \E i \in FreeOps, clear \in BOOLEAN,
        h \in (IF DirectHomes THEN Homes ELSE {s.appHome} \cap Homes) :
       s' = [s EXCEPT !.ops[i] =
         NewOp("stop", h, clear, IF clear THEN NoOwner ELSE s.status[h]),
         !.requests = @ + 1]

(* Helpers implement finally/unlock: lib/v1/host.mjs:260, 386. *)
Done(i) ==
  [s EXCEPT !.ops[i] = EmptyOp,
            !.lock[s.ops[i].home] =
              IF @ = i THEN 0 ELSE @]
Phase(i, phase) == [s EXCEPT !.ops[i].ph = phase]

(* lib/v1/host.mjs:144-158, 311-318, 347.
   The real resume waits up to 10 s; WaitResume=FALSE is the old behavior.
   The lock is indexed by home, not one global exclusion. *)
Acquire(i) ==
  LET o == s.ops[i] IN
  /\ o.ph = "spawned"
  /\ IF lock[o.home] = 0
       THEN s' = [s EXCEPT !.lock[o.home] = i, !.ops[i].ph = "locked"]
       ELSE /\ (o.kind # "resume" \/ ~WaitResume)
            /\ s' = Done(i)

(* lib/v1/host.mjs:137-150. Even current resume waits are finite.
   Keep this distinct from successful acquisition for liveness limits. *)
ResumeTimeout(i) ==
  /\ s.ops[i].ph = "spawned" /\ s.ops[i].kind = "resume"
  /\ lock[s.ops[i].home] # 0 /\ WaitResume
  /\ s' = [Done(i) EXCEPT !.timedOut = TRUE]

(* lib/v1/host.mjs:154-167, 311-318.
   Only automatic resumes are fenced. Owner starts do not carry that fence. *)
Prepare(i) ==
  LET o == s.ops[i] IN
  /\ o.ph = "locked" /\ o.kind \in {"start", "resume"}
  /\ IF o.kind = "resume" /\ GenCheck /\
        (~s.config[o.home].exists \/ s.config[o.home].wanted = "no"
         \/ o.generation # s.config[o.home].generation)
       THEN s' = Done(i)
       ELSE s' = [s EXCEPT !.config[o.home].exists = TRUE,
                  !.ops[i].ph = "port"]

(* lib/v1/host.mjs:168-177; coordinator-owner.mjs:116-149.
   Adoption requires port occupied AND exact recorded incarnation/home.
   A live but not-yet-listening child is not discovered by this conjunction. *)
CheckPort(i) ==
  LET o == s.ops[i] h == o.home port == s.config[h].port IN
  /\ o.ph = "port"
  /\ IF occupancy[port] = 0
       THEN s' = Phase(i, IF s.config[h].knownOrigin THEN "name" ELSE "launch")
       ELSE IF RecordedAlive(h) /\ processes[RecordedPid(h)].port = port
            THEN LET p == RecordedPid(h) IN
                 s' = [s EXCEPT !.ops[i].pid = p,
                   !.ops[i].incarnation = processes[p].incarnation,
                   !.ops[i].adopted = TRUE, !.ops[i].ph = "name"]
            ELSE IF ~s.config[h].named
                 THEN \E alternate \in Ports :
                   /\ occupancy[alternate] = 0
                   /\ s' = [s EXCEPT !.config[h].port = alternate,
                         !.ops[i].ph =
                           IF s.config[h].knownOrigin THEN "name" ELSE "launch"]
                 ELSE s' = Done(i)

(* lib/v1/host.mjs:201-212. The primary circle id and signed origin
   are saved BEFORE provisionLocalCircle; a crash can leave only the name. *)
NameCircle(i) ==
  /\ s.ops[i].ph = "name"
  /\ s' = [s EXCEPT !.config[s.ops[i].home].named = TRUE,
                   !.config[s.ops[i].home].knownOrigin = TRUE,
                   !.ops[i].ph = "provision"]

(* lib/v1/host.mjs:33-60, 213-214. Represents successful identity-checked
   committed provisioning, separate from naming and process launch. *)
Provision(i) ==
  /\ s.ops[i].ph = "provision"
  /\ s' = [s EXCEPT !.committed = @ \cup {s.ops[i].home},
       !.ops[i].ph = IF s.ops[i].pid = 0 THEN "launch" ELSE "publish"]

(* lib/v1/host.mjs:229-232. A new launch removes the old status
   before startServer; a crash may leave no status and no new child.
   Adopted processes never enter this path. *)
ClearStatus(i) ==
  /\ s.ops[i].ph = "launch"
  /\ s' = [s EXCEPT !.status[s.ops[i].home] = NoOwner,
                   !.ops[i].ph = "spawn"]

(* lib/v1/host.mjs:226-235, 270-278. startServer and waitReady are
   separate calls. No guard forbids another live process at this home.
   pid+incarnation identifies the launched child even after slot reuse. *)
Launch(i) ==
  LET h == s.ops[i].home IN
  /\ s.ops[i].ph = "spawn"
  /\ \E p \in Pids :
       /\ ~processes[p].live /\ processes[p].incarnation < 2
       /\ s' = [s EXCEPT
           !.processes[p] = [pid |-> p,
             incarnation |-> processes[p].incarnation + 1,
             home |-> h, circle |-> IF s.config[h].named THEN Circle ELSE "none",
             port |-> s.config[h].port, live |-> TRUE, phase |-> "starting",
             stateHome |-> "none", signalled |-> FALSE],
           !.ops[i].pid = p,
           !.ops[i].incarnation = processes[p].incarnation + 1,
           !.ops[i].ph = "ready"]

(* lib/v1/host.mjs:285-296, 330-331; coordinator-owner.mjs:116-140.
   Environmental child status write, with an exact incarnation. The
   initial (under-parent-lock) launch has no restart generation fence.
   This is not a model of the unreviewed child's internal implementation. *)
Announce(p) ==
  /\ processes[p].live /\ processes[p].phase = "starting"
  /\ s.status[processes[p].home] # Owner(p)
  /\ s' = [s EXCEPT !.status[processes[p].home] = Owner(p)]

(* lib/v1/host.mjs:232-237: environment of startServer/waitReady.
   Listening alone is not circle readiness; only one socket owns a port.
   Collision fails that child rather than overwriting another listener. *)
Bind(p) ==
  /\ processes[p].live /\ processes[p].phase = "starting"
  /\ IF occupancy[processes[p].port] = 0
       THEN s' = [s EXCEPT !.occupancy[processes[p].port] = p,
                          !.processes[p].phase = "listening"]
       ELSE s' = [s EXCEPT !.processes[p].live = FALSE,
                          !.processes[p].phase = "down"]

(* lib/v1/host.mjs:213-218, 235-247. Serving a named circle requires
   its local committed store, including provisioning after unknown-origin
   startup. This abstracts successful authenticated coordinator calls. *)
Serve(p) ==
  /\ processes[p].live /\ processes[p].phase = "listening"
  /\ s.config[processes[p].home].named
  /\ processes[p].home \in s.committed
  /\ s' = [s EXCEPT !.processes[p].phase = "serving",
       !.processes[p].circle = Circle,
       !.processes[p].stateHome = processes[p].home]

(* lib/v1/host.mjs:235-239. An unknown tunnel origin is learned only
   after listening; naming and provisioning then run as separate actions. *)
ReadyForOrigin(i) ==
  LET o == s.ops[i] IN
  /\ o.ph = "ready" /\ o.pid \in Pids
  /\ processes[o.pid].live /\ processes[o.pid].incarnation = o.incarnation
  /\ processes[o.pid].phase \in {"listening", "serving"}
  /\ s' = Phase(i, IF s.config[o.home].named /\ o.home \in s.committed
                   THEN "publish" ELSE "name")

(* lib/v1/host.mjs:240-252. Readiness is signed publication AND invite
   success, not a live PID. Only a non-resume records host_wanted=true. *)
StartReady(i) ==
  LET o == s.ops[i] IN
  /\ o.ph = "publish" /\ o.pid \in Pids
  /\ processes[o.pid].live /\ processes[o.pid].incarnation = o.incarnation
  /\ processes[o.pid].phase = "serving"
  /\ s' = [Done(i) EXCEPT !.config[o.home].wanted =
             IF o.kind = "start" THEN "yes" ELSE @]

(* lib/v1/host.mjs:253-260; host-command.mjs:78-119.
   Ordinary failure/TERM cleanup stops only this launch's own handle;
   adopted processes survive. No cleanup proof is inferred from KILL. *)
StartFailure(i) ==
  LET o == s.ops[i] IN
  /\ o.kind \in {"start", "resume"}
  /\ o.ph \notin {"free", "spawned"}
  /\ IF o.pid \in Pids /\ ~o.adopted
       THEN IF processes[o.pid].incarnation = o.incarnation
            THEN s' = [Done(i) EXCEPT
                   !.processes[o.pid].live = FALSE,
                   !.processes[o.pid].phase = "down",
                   !.occupancy[processes[o.pid].port] =
                     IF @ = o.pid THEN 0 ELSE @, !.disrupted = TRUE]
            ELSE s' = [Done(i) EXCEPT !.disrupted = TRUE]
       ELSE s' = [Done(i) EXCEPT !.disrupted = TRUE]

(* lib/v1/host.mjs:341-363. Stop persists a fresh generation first,
   and only clearIntent ends durable intent. An expected owner mismatch
   refuses before changing intent; tunnel shutdown is an async boundary. *)
StopIntent(i) ==
  LET o == s.ops[i] h == o.home IN
  /\ o.kind = "stop" /\ o.ph = "locked"
  /\ IF ~s.config[h].exists \/
        (o.expected # NoOwner /\ (o.expected # s.status[h] \/ ~RecordedAlive(h)))
       THEN s' = Done(i)
       ELSE s' = [s EXCEPT !.config[h].generation = @ + 1,
             !.config[h].wanted = IF o.clear THEN "no" ELSE @,
             !.ops[i].ph = "signal"]

(* lib/v1/host.mjs:364-383; coordinator-owner.mjs:106-149.
   Re-read status after awaited tunnel shutdown, check expected owner
   again, then signal only a verified live incarnation of this home. *)
StopSignal(i) ==
  LET o == s.ops[i] h == o.home IN
  /\ o.ph = "signal"
  /\ IF o.expected # NoOwner /\ o.expected # s.status[h]
       THEN s' = Done(i)
       ELSE IF RecordedAlive(h)
            THEN LET p == RecordedPid(h) IN
                 s' = [s EXCEPT !.processes[p].signalled = TRUE,
                      !.ops[i].pid = p,
                      !.ops[i].incarnation = processes[p].incarnation,
                      !.ops[i].ph = "waitStop",
                      !.badSignal = @ \/ processes[p].home # h]
            ELSE s' = Phase(i, "portStop")

(* lib/v1/host.mjs:370-383. Signal is not proof of exit: wait for
   the recorded incarnation, or report failure if it remains alive. *)
StopObserve(i) ==
  LET o == s.ops[i] IN
  /\ o.ph = "waitStop"
  /\ IF processes[o.pid].live /\ processes[o.pid].incarnation = o.incarnation
       THEN s' = Done(i)
       ELSE s' = Phase(i, "portStop")

(* lib/v1/host.mjs:384, 396-422. Query all bind addresses/listeners:
   stop a verified listener for this home even when status named another.
   Never signal a foreign listener or a different home's coordinator. *)
StopPort(i) ==
  LET o == s.ops[i] port == s.config[o.home].port IN
  /\ o.ph = "portStop"
  /\ IF occupancy[port] = 0
       THEN s' = [s EXCEPT !.ops[i].initialQuiet = TRUE,
                          !.ops[i].ph = "verifyPort"]
       ELSE IF OwnListener(o.home, port)
            THEN LET p == occupancy[port] IN
                 s' = [s EXCEPT !.processes[p].signalled = TRUE,
                      !.ops[i].portSignalled = TRUE,
                      !.ops[i].ph = "verifyPort",
                      !.badSignal = @ \/ processes[p].home # o.home]
            ELSE s' = Phase(i, "verifyPort")

(* lib/v1/host.mjs:407-422. Initially quiet returns immediately.
   Initially busy succeeds only if this sweep signalled a verified listener
   AND the subsequent probe is quiet. A foreign listener disappearing on
   its own does not authorize success (stopped remains false in the code). *)
VerifyPort(i) ==
  LET o == s.ops[i] IN
  /\ o.ph = "verifyPort"
  /\ s' = [Done(i) EXCEPT !.stopOK[o.home] =
       IF o.clear /\ o.seq = s.requests
         THEN o.initialQuiet \/
              (o.portSignalled /\ occupancy[s.config[o.home].port] = 0)
         ELSE @]

(* lib/v1/host.mjs:85-89, 370-383. Environmental completion of TERM.
   Unlike atomic deletion at signal time this allows stop failure/delay. *)
ProcessExit(p) ==
  /\ processes[p].live /\ processes[p].signalled
  /\ s' = [s EXCEPT !.processes[p].live = FALSE,
       !.processes[p].phase = "down",
       !.occupancy[processes[p].port] = IF @ = p THEN 0 ELSE @]

(* lib/v1/host-command.mjs:44-49, 93-114; host.mjs:253-260.
   Abrupt launcher death can leave its detached child; finally cleanup is
   not guaranteed on crash. Per-home lock is freed by process death. *)
OpCrash(i) ==
  /\ AllowCrash /\ s.ops[i].ph # "free"
  /\ s' = [Done(i) EXCEPT !.disrupted = TRUE]

(* lib/v1/host.mjs:64-73, 300-305. Environmental coordinator crash.
   Supervisors are outside scope; a later app resume may restart it. *)
HostCrash(p) ==
  /\ AllowCrash /\ processes[p].live
  /\ s' = [s EXCEPT !.processes[p].live = FALSE,
       !.processes[p].phase = "down",
       !.occupancy[processes[p].port] = IF @ = p THEN 0 ELSE @,
       !.disrupted = TRUE]

(* lib/v1/host.mjs:169-177, 409-422. External occupancy is not an
   owned coordinator and is never signalled by the model. *)
ForeignTakes(port) ==
  /\ occupancy[port] = 0
  /\ s' = [s EXCEPT !.occupancy[port] = -1, !.disrupted = TRUE]
ForeignLeaves(port) ==
  /\ occupancy[port] = -1
  /\ s' = [s EXCEPT !.occupancy[port] = 0]

OpStep(i) == Acquire(i) \/ Prepare(i) \/ CheckPort(i) \/ NameCircle(i)
  \/ Provision(i) \/ ClearStatus(i) \/ Launch(i) \/ ReadyForOrigin(i) \/ StartReady(i)
  \/ StopIntent(i) \/ StopSignal(i) \/ StopObserve(i) \/ StopPort(i)
  \/ VerifyPort(i)
ChildStep(p) == Announce(p) \/ Bind(p) \/ Serve(p) \/ ProcessExit(p)
Next ==
  \/ AppStart \/ AppDown \/ OwnerStart \/ RequestStop
  \/ \E i \in OpIds : OpStep(i) \/ OpCrash(i) \/ StartFailure(i) \/ ResumeTimeout(i)
  \/ \E p \in Pids : ChildStep(p) \/ HostCrash(p)
  \/ \E port \in Ports : ForeignTakes(port) \/ ForeignLeaves(port)
Spec == Init /\ [][Next]_vars
  /\ \A i \in OpIds : WF_vars(OpStep(i))
  /\ \A p \in Pids : WF_vars(ChildStep(p))

TypeOK ==
  /\ lock \in [Homes -> (OpIds \cup {0})]
  /\ occupancy \in [Ports -> (Pids \cup {-1, 0})]
  /\ s.committed \subseteq Homes
  /\ s.requests \in 0..MaxRequests /\ s.appStarts \in 0..MaxAppStarts
  /\ \A h \in Homes : s.config[h].generation \in 0..MaxRequests
  /\ \A p \in Pids :
       /\ processes[p].pid = p /\ processes[p].incarnation \in 0..2
       /\ processes[p].home \in Homes /\ processes[p].port \in Ports
       /\ processes[p].circle \in {Circle, "none"}
       /\ processes[p].stateHome \in Homes \cup {"none"}
       /\ processes[p].live \in BOOLEAN
       /\ processes[p].phase \in {"down", "starting", "listening", "serving"}
  /\ \A port \in Ports : occupancy[port] \in Pids =>
       (processes[occupancy[port]].live /\ processes[occupancy[port]].port = port)
  /\ \A h \in Homes : lock[h] # 0 =>
       (s.ops[lock[h]].home = h /\ s.ops[lock[h]].ph # "free")

(* Counts live processes, including pre-bind children, NOT occupied ports. *)
H5_UniqueLiveCoordinator ==
  \A h \in Homes : Cardinality({p \in Pids :
    processes[p].live /\ processes[p].home = h
    /\ processes[p].circle = Circle}) <= 1

(* Abstraction-consistency invariant, not an independent proof of the
   child's store selection: Serve assumes validated local provisioning
   and assigns stateHome from home. No host_wanted antecedent. *)
H2_ServingCommitted ==
  \A p \in Pids : processes[p].live /\ processes[p].phase = "serving" =>
    (processes[p].home \in s.committed
     /\ processes[p].stateHome = processes[p].home
     /\ processes[p].circle = Circle /\ s.config[processes[p].home].named)
H2_OneCommittedHome ==
  Cardinality(s.committed) <= 1 /\ H2_ServingCommitted
H3_OwnSignalsOnly == ~s.badSignal
H1_StopSticks ==
  \A h \in Homes : s.stopOK[h] => (~Serving(h) /\ s.config[h].wanted # "yes")
H4_NoLoop == s.appSpawns <= 1
Quiet == s.app = "up" /\ \A i \in OpIds : s.ops[i].ph = "free"
H4_Comes_Back ==
  <>[]Quiet => <>[](\A h \in Homes :
    (s.appHome = h /\ s.appSpawns = 1 /\ s.config[h].wanted = "yes"
     /\ s.config[h].generation = s.appGeneration
     /\ h \in s.committed /\ ~s.disrupted /\ ~s.timedOut) => Serving(h))
=============================================================================
