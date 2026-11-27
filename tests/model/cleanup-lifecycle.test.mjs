// Explicit-state model and source-seam replays for faravan@489a89c37f27f0e199d3403ca29bf2ef00ee0d30, changed to the release
// rule in docs/design/SANDBOX-CLEANUP-RECOVERY.md "Release rule: no guard hand-off": no guard is retired, cancelled or signalled
// for a watcher, no guard ends because a watcher serves its record, and recovery never hands a guarded row to the watcher.
// Transitions of the removed hand-off stay in the model behind an explicit `handOff`, `appSignals`, `retireInReconcile` or
// `watcherServesGuardedRow` flag that is off in the base runs and on only in the mutation controls and repaired controls, so
// each property still has a witness that the oracle can see. Line references in `at()` are to the pinned commit and are not
// renumbered; the source replays slice the current source by text.
// Run: node --test tests/model/cleanup-lifecycle.test.mjs
// Safety counterexamples intentionally FAIL the named property tests. Replay tests assert
// the observed behavior, not safety. No dependencies, network, signals or production edits.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';

const began=performance.now();
const PIN='489a89c37f27f0e199d3403ca29bf2ef00ee0d30';
const P={
  design:'docs/design/SANDBOX-CLEANUP-RECOVERY.md',
  owner:'lib/v1/sandbox-record-owner.mjs', lock:'lib/v1/lock.mjs',
  journal:'lib/sandbox-cleanup-journal.mjs', deadline:'lib/sandbox-deadline.mjs',
  guard:'lib/sandbox-deadline-supervisor.mjs', watcher:'lib/v1/sandbox-shared-watcher.mjs',
  proof:'lib/v1/sandbox-watch-proofs.mjs', app:'lib/docker-backend.mjs',
  gate:'lib/v1/deadline-recovery-gate.mjs',
};
const at=(p,lines)=>P[p]+':'+lines;
const clone=x=>JSON.parse(JSON.stringify(x));
const totals=[];
function explore(name,start,next,bad) {
  const nodes=[{s:start,parent:-1}],seen=new Set([JSON.stringify(start)]),found={};
  const coverage=new Set(); let edges=0;
  const trace=i=>{
    const result=[];
    for(;nodes[i].parent!==-1;i=nodes[i].parent)
      result.push({action:nodes[i].action,source:nodes[i].source});
    return result.reverse();
  };
  for(let h=0;h<nodes.length;h++) {
    const {s}=nodes[h];
    // The enabled actions are read first, so a property can ask whether a repair step exists in a state.
    const enabled=[];next(s,(action,source,change)=>enabled.push({action,source,change}));
    for(const property of bad(s,enabled.map(item=>item.action))) if(!found[property])
      found[property]={partition:name,steps:trace(h),state:s};
    const emit=(action,source,change)=>{
      const t=clone(s);change(t);edges++;coverage.add(action);
      const key=JSON.stringify(t);
      if(!seen.has(key)){seen.add(key);nodes.push({s:t,parent:h,action,source});}
    };
    for(const item of enabled)emit(item.action,item.source,item.change);
    assert.ok(nodes.length<=200000,'State cap exceeded, NOT a completed model: '+name);
  }
  const result={name,states:nodes.length,edges,coverage:[...coverage],found};
  totals.push(result); return result;
}
function best(runs,id) {
  return runs.map(r=>r.found[id]).filter(Boolean)
    .sort((a,b)=>a.steps.length-b.steps.length||a.partition.localeCompare(b.partition))[0]??null;
}
// Interleaving partition: durable row, receipt, manifest and ACK are independent.
// The model starts just after a create may have materialized, before hand-off.
// Process death is an environment event at ANY cut point; restart is a separate
// event, never an instantaneous disappearance of the unprotected interval.
function handoff({handOff=false,flagBeforeReceipt=true,retireOnFlag=false,ignoreServing=false,
                  prematureManifest=false,retainBackup=false,dropGuardOnAckFailure=false,levelTrigger=true}={}) {
  const seed={pc:0,row:false,receipt:false,manifest:false,ack:false,guard:true,
    watcher:0,owner:'',app:true,failed:false,checked:false,retired:false,
    scan:false,stopped:false,invalidRetire:false,crash:0,crashActor:'',restartRefused:false,
    seen:false,gone:false};
  const serves=s=>s.watcher===1&&s.owner==='watcher'&&s.ack;
  return explore('handoff-'+JSON.stringify(arguments[0]??{}),seed,(s,e)=>{
    const app=(pc)=>s.app&&!s.failed&&s.pc===pc;
    // Release rule: a row that has a guard is never handed off, so these app steps exist only when `handOff` is set.
    if(handOff&&app(0))e('Fence exec and persist adopted row with null acknowledgment',
      at('watcher','30-34'),t=>{t.pc=1;t.row=flagBeforeReceipt;});
    if(app(1)) {
      e('Persist own create receipt, then release app owner tenure',
        at('watcher','229-237'),t=>{t.pc=2;t.receipt=true;});
      e('Receipt/acknowledgment throws lock_busy; retain previous guard',
        at('watcher','39-41,232-236'),t=>{t.failed=true;if(dropGuardOnAckFailure)t.guard=false;});
    }
    if(app(2)||prematureManifest&&app(1))e('Persist manifest before asking watcher',
      at('watcher','238-249'),t=>{t.pc=3;t.manifest=true;if(!flagBeforeReceipt)t.row=true;});
    if(s.manifest&&!s.watcher&&!s.stopped&&s.crashActor!=='watcher'&&!s.owner)
      e('Watcher starts, claims exact manifest create, and publishes ready',
        at('watcher','62-70,300-315'),t=>{t.watcher=1;t.owner='watcher';});
    if(app(3)&&s.watcher===1&&s.owner==='watcher') {
      e('Read current challenge acknowledgment and persist it in row',
        at('watcher','250-261; lib/v1/sandbox-shared-watcher.mjs:34-36'),
        t=>{t.pc=4;t.ack=true;});
      e('Acknowledgment response is interrupted before row save',
        at('watcher','34-41,275-276'),t=>{t.failed=true;});
    }
    if(handOff&&s.guard&&!s.checked&&(serves(s)||retireOnFlag&&s.row||ignoreServing&&s.owner))
      e('Guard snapshots replacement readiness',
        at('guard','69-71'),t=>{t.checked=true;});
    if(handOff&&s.guard&&s.checked)e('Guard publishes watch_adopted and exits',
      at('guard','70-71'),t=>{t.invalidRetire=!serves(s);t.guard=retainBackup;t.retired=true;t.checked=false;});
    if(handOff&&app(4)&&serves(s)&&s.guard)
      e('Retirement rereads serving owner and signals bound guard',
        at('deadline','262-274,298-309'),t=>{t.guard=retainBackup;t.retired=true;});
    if(handOff&&app(4)&&!s.guard&&!s.scan)e('Final old-guard scan finishes',
      at('journal','195-197'),t=>{t.scan=true;});
    if(handOff&&app(4)&&s.scan&&serves(s))e('Final serving check permits admission release',
      at('journal','198-204'),t=>{t.pc=5;});
    if(handOff&&app(4)&&s.scan&&!serves(s))e('Final serving check refuses stopped watcher',
      at('journal','198-204'),t=>{t.failed=true;});
    // The guard stays the deadline remover of its own row until its removal is proven or its own deadline acts.
    if(s.guard&&!s.gone)e('Guard removes the bound name at its own deadline and proves it absent',
      at('guard','81-132'),t=>{t.gone=true;t.guard=false;});
    if(s.watcher===1&&!s.stopped)e('Watcher publishes not-ready and drains',
      at('watcher','302-308,328-329'),t=>{t.watcher=2;t.stopped=true;});
    if(s.watcher===2)e('Watcher drains, releases owner and exits',
      at('watcher','149,328-329'),t=>{t.watcher=0;t.owner='';});
    if(s.watcher===1&&!s.seen)e('Owner commits present sighting',
      at('watcher','127-134'),t=>{t.seen=true;});
    if(s.watcher===1&&s.seen&&!s.gone)e('Owner sees strictly later absence and proves gone',
      at('proof','108-124'),t=>{t.gone=true;});
    if(s.crash===0)for(const actor of ['app','watcher','guard']) {
      if(actor==='app'&&!s.app||actor==='watcher'&&!s.watcher||actor==='guard'&&!s.guard)continue;
      e(actor+' crashes at this durable cut point',at('design','91-105,158-169'),t=>{
        t.crash=1;t.crashActor=actor;
        if(actor==='app'){t.app=false;if(t.pc>0&&t.pc<4)t.failed=true;}
        if(actor==='watcher'){t.watcher=0;t.owner='';}
        if(actor==='guard'){t.guard=false;t.checked=false;}
      });
    }
    // Level trigger: every 15 s cleanup pass runs the recovery that startup runs. A pending row whose lifetime lock no process
    // holds gets a guard through the same registration path, with the app still running and no restart. The lock still stops a
    // second guard, so a pass never doubles a guard that runs.
    if(levelTrigger&&s.crash===1&&s.crashActor==='guard'&&s.app&&!s.gone)
      e('Cleanup pass finds the lifetime lock free and registers a guard by the startup recovery path',
        at('journal','621-724; lib/v1/app.mjs:3332'),t=>{t.crash=2;t.guard=true;});
    if(s.crash===1&&s.crashActor!=='guard')e(s.crashActor+' restart reads durable state',
      at('journal','678-710'),t=>{
        t.crash=2;
        if(t.crashActor==='app')t.app=true;
        if(t.crashActor==='watcher'&&t.manifest&&!t.stopped){t.watcher=1;t.owner='watcher';}
      });
  },(s,enabled)=>[
    ...(!s.gone&&!s.guard&&!serves(s)?['PROTECT']:[]),
    // PROTECT cannot hold at the instant a guard dies, in any design where a process can crash. The property a design can keep
    // is that an unprotected row always has a step that protects it again: a state without one waits for an outside event.
    ...(!s.gone&&!s.guard&&!serves(s)&&!enabled.some(action=>/^Cleanup pass/.test(action))?['PROTECT_REPAIR']:[]),
    ...(s.invalidRetire?['RETIRE_AUTH']:[]),
    ...(s.failed&&!s.gone&&!s.guard&&!serves(s)?['ACK_FAIL']:[]),
    ...(s.row&&!s.receipt?['ADOPT_AFTER_RECEIPT']:[]),
    ...(s.manifest&&!s.receipt?['MANIFEST_RECEIPT']:[]),
  ]);
}
// Separate startup cut point: the replacement guard published its identity but
// the app crashed before saving the new PID in the row. That guard is the only
// serving protector. It is not the stale PID saved in deadline_enforcer.
function startup({acceptPublishedReplacement=false,skipIdentity=false,retireInReconcile=false}={}) {
  return explore('startup-'+JSON.stringify(arguments[0]??{}),
    {pc:0,guard:true,watcher:false,own:false,checked:false},
    (s,e)=>{
      if(s.pc===0)e('Read current guard identity and status; row still saves prior PID',
        at('deadline','329-338'),t=>{t.pc=1;t.checked=true;t.own=acceptPublishedReplacement;});
      if(s.pc===1&&s.own)e('Keep sole published replacement guard',
        at('deadline','340'),t=>{t.pc=3;});
      if(s.pc===1&&!s.own&&!retireInReconcile)e('Adopt the guard by its exact PID and start identity; it is never signalled',
        at('deadline','reconcileGuards'),t=>{t.pc=3;});
      if(retireInReconcile&&s.pc===1&&!s.own)e('Final identity check; pre-handoff row skips serving test',
        at('deadline','341-347'),t=>{t.pc=2;});
      if(retireInReconcile&&s.pc===2&&(s.checked||skipIdentity))e('Signal sole guard before any watcher exists',
        at('deadline','348-352'),t=>{t.pc=3;t.guard=false;});
    },s=>!s.guard&&!s.watcher?['PROTECT']:[]);
}
// One read/kill race for both reconcileGuards and ordinary cancel. An external
// OS process may exit/reuse the PID even within a single JS synchronous turn.
function signals({skipFinalRead=false,pinnedHandle=false,teardown=null,appSignals=false}={}) {
  return explore('signal-'+JSON.stringify(arguments[0]??{}),
    {pc:0,current:1,checked:0,reused:false,wrong:false},(s,e)=>{
      // Release rule: the app never signals a guard (no cancel, no retire in reconcile); only teardown of an own child remains.
      if(!teardown&&!appSignals)return;
      if(s.pc===0)e(teardown?'Keep child handle from spawned process':'Await initial process identity',
        teardown??at('deadline','329; lib/sandbox-deadline.mjs:302'),t=>{t.pc=1;t.checked=1;});
      if(s.pc===1)e(teardown?'Teardown retains original child handle':'Read start identity synchronously immediately before kill',
        teardown??at('deadline','347; lib/sandbox-deadline.mjs:308'),t=>{t.pc=2;if(!skipFinalRead&&!teardown)t.checked=t.current;});
      if(s.pc>0&&s.pc<3&&!s.reused)e('OS exits checked process and reuses its numeric PID',
        at('design','126-132'),t=>{t.current=2;t.reused=true;});
      if(s.pc===2)e('Signal numeric PID',
        teardown??at('deadline','348; lib/sandbox-deadline.mjs:309'),t=>{
          t.pc=3;t.wrong=!pinnedHandle&&t.checked===1&&t.current!==t.checked;
        });
    },s=>s.wrong?['SIGNAL_IDENTITY']:[]);
}
function actors({oldGuard=true,unfencedGuard=false,oldTakesLock=false,watcherServesGuardedRow=true}={}) {
  return explore('actors-'+JSON.stringify(arguments[0]??{}),
    {owner:'',pc:[0,0],active:[false,false],overlap:false},(s,e)=>{
      for(let a=0;a<2;a++) {
        // A row an earlier version handed off can also have a guard now (recovery gives it one), so the watcher acts on it too:
        // each for one bounded action under the owner lock.
        if(a===0&&!watcherServesGuardedRow)continue;
        const actor=a===0?'watcher':oldGuard?'old guard':'current guard';
        const unlocked=a===1&&((oldGuard&&!oldTakesLock)||unfencedGuard);
        if(s.pc[a]===0&&(unlocked||!s.owner))
          e(actor+' begins one owner action',a===0?at('watcher','act, remove'):
            oldGuard?at('design','281-289'):at('guard','101-118'),
            t=>{t.pc[a]=1;if(!unlocked)t.owner=actor;t.active[a]=true;t.overlap=t.active.every(Boolean);});
        if(s.pc[a]===1)e(actor+' completes bounded operation and releases',
          a===0?at('watcher','act, remove'):at('guard','118-129'),
          t=>{t.pc[a]=2;t.active[a]=false;if(t.owner===actor)t.owner='';});
      }
    },s=>s.overlap?['ONE_ACTOR']:[]);
}
function noId({validateAuthoritativeRow=false,ignoreManifestId=false,manifestHasId=true}={}) {
  return explore('no-id-'+JSON.stringify(arguments[0]??{}),
    {rowId:false,manifestId:manifestHasId,crash:0,pc:0,acted:false},(s,e)=>{
      if(s.crash===0)e('Crash retains manifest; readable restored row names no create',
        at('design','216-227; lib/v1/sandbox-shared-watcher.mjs:156-166'),
        t=>{t.crash=1;});
      if(s.crash===1&&s.pc===0)e('Startup rereads only retained manifest',
        at('watcher','309-318'),t=>{t.pc=1;});
      if(s.pc===1&&(ignoreManifestId||s.manifestId)&&(!validateAuthoritativeRow||s.rowId))
        e('Watcher owns retained manifest create without consulting current row',
          at('watcher','62-70; lib/v1/sandbox-watch-proofs.mjs:140-144'),
          t=>{t.pc=2;t.acted=true;});
    },s=>!s.rowId&&s.acted?['NO_ID_REPLAY']:[]);
}
function epochs({resetEpoch=false,skipRecheck=false}={}) {
  return explore('epochs-'+JSON.stringify(arguments[0]??{}),
    {disk:0,high:0,owner:-1,handle:[0,0],released:[false,false],acquired:0,
      reopened:false,rewritten:false,crashed:false,bad:false},(s,e)=>{
      if(s.owner===-1&&s.acquired<2) {
        const a=s.acquired;
        e('Actor '+a+' takes process lock and durably advances epoch before grant',
          at('owner','39-49'),t=>{
            t.disk++;t.high=Math.max(t.high,t.disk);t.owner=a;t.handle[a]=t.disk;t.acquired++;
          });
      }
      if(s.owner>=0)e('Current actor releases its tenure',
        at('owner','71'),t=>{t.released[t.owner]=true;t.owner=-1;});
      if(!s.crashed&&s.owner>=0)e('Owner crashes; verified dead lock may be reclaimed',
        at('lock','277-290'),t=>{t.crashed=true;t.released[t.owner]=true;t.owner=-1;});
      if(!s.reopened)e('Restart reopens store without resetting ownership file',
        at('owner','27-47'),t=>{t.reopened=true;if(resetEpoch)t.disk=0;t.bad||=t.disk<t.high;});
      if(!s.rewritten)e('Cleanup row is rewritten, separate ownership file is preserved',
        at('journal','68-69; lib/v1/sandbox-record-owner.mjs:23'),t=>{t.rewritten=true;});
      for(let a=0;a<2;a++)if(s.handle[a]&&(s.released[a]||s.handle[a]!==s.disk))
        e('Stale actor '+a+' attempts owner action; recheck refuses it',
          at('owner','51-61'),t=>{if(skipRecheck)t.bad=true;});
    },s=>s.bad?['EPOCH_MONOTONIC']:[]);
}
function appFence({recheck=false,skipAcquire=false}={}) {
  return explore('app-fence-'+JSON.stringify(arguments[0]??{}),
    {pc:0,held:false,checked:false,bad:false},(s,e)=>{
      if(s.pc===0)e('App takes current owner handle',
        at('app','4896-4900'),t=>{t.pc=1;t.held=!skipAcquire;t.checked=!skipAcquire;});
      if(s.pc===1)e('Await listing; a check is required again before owner action',
        at('app','4905-4907'),t=>{t.pc=2;t.checked=false;});
      if(s.pc===2)e(recheck?'Recheck owner then mark and remove':'Mark create settled and issue rm without owner recheck',
        at('app','4908-4916'),t=>{t.pc=3;if(recheck)t.checked=true;t.bad=!t.checked||!t.held;});
      if(s.pc===3)e('Release owner in finally',
        at('app','4945'),t=>{t.pc=4;t.held=false;});
    },s=>s.bad?['APP_RM_FENCED']:[]);
}
function starvation({lifetimeHold=false}={}) {
  return explore('starvation-'+JSON.stringify(arguments[0]??{}),
    {pc:0,held:false,backoff:false,waits:0,violation:false},(s,e)=>{
      // Release rule: the watcher holds the record for one action only. `lifetimeHold` is the earlier design (a mutant here).
      if(s.pc===0)e(lifetimeHold?'Watcher claims record for poller lifetime':'Watcher takes the record for one action and releases it',
        at('watcher','act, touch, claim'),t=>{t.pc=1;t.held=lifetimeHold;});
      if(s.pc===1)e('Listing fails; poll returns bounded backoff holding no record',
        at('watcher','one'),t=>{t.pc=2;t.backoff=true;});
      if(s.pc===2&&s.waits<2)e('Waiting guard nonblocking acquire is refused',
        at('guard','101-105'),t=>{t.waits++;t.violation=t.held;});
    },s=>s.held&&s.backoff||s.violation?['NO_STARVATION']:[]);
}

function guardBackoff({holdDuringBackoff=false}={}) {
  return explore('guard-backoff-'+JSON.stringify(arguments[0]??{}),
    {pc:0,held:false,sleeping:false},(s,e)=>{
      if(s.pc===0)e('Guard acquires handle without waiting',at('guard','101-106'),t=>{t.pc=1;t.held=true;});
      if(s.pc===1)e('Reread row changed/unreadable; break retry through finally',
        at('guard','109-115,129'),t=>{t.pc=2;if(!holdDuringBackoff)t.held=false;});
      if(s.pc===2)e('Pause in backoff',at('guard','132'),t=>{t.pc=3;t.sleeping=true;});
    },s=>s.held&&s.sleeping?['NO_STARVATION']:[]);
}

function oldLive({handOff=false,stopJobBeforeRemove=false,permitNameReuse=false,originalJob=true}={}) {
  return explore('old-live-'+JSON.stringify(arguments[0]??{}),
    {pc:0,job:originalJob,oldGuard:true,ack:false,manifest:false,fenced:false,app:true,watcherLive:false,watcherHeld:false,
      admitted:false,crash:0,crashed:'',removedLive:false},(s,e)=>{
      if(s.pc===0)e('Retain own old guard across upgrade while original job uses name',
        at('deadline','336-340; docs/design/SANDBOX-CLEANUP-RECOVERY.md:281-289'),t=>{t.pc=1;});
      if(handOff&&s.pc===1&&!s.fenced&&!originalJob&&s.app)e('New handoff fences future exec',
        at('watcher','30-33'),t=>{t.fenced=true;});
      if(handOff&&s.fenced&&!s.manifest&&s.app)e('New handoff saves receipt then manifest, no acknowledgment yet',
        at('watcher','229-249'),t=>{t.manifest=true;});
      if(handOff&&s.manifest&&!s.watcherLive&&s.crashed!=='watcher')e('Watcher acquires new owner handle before acknowledgment',
        at('watcher','68,258-261'),t=>{t.watcherLive=true;t.watcherHeld=true;});
      if(handOff&&s.app&&s.watcherHeld&&!s.ack)e('App persists matching acknowledgment after watcher acquisition',
        at('watcher','34-36'),t=>{t.ack=true;});
      if(s.app&&!s.admitted)e('Admission attempts to reuse permanently reserved name',
        at('journal','106-113'),t=>{t.admitted=true;if(permitNameReuse)t.job=true;});
      if(s.pc===1&&s.oldGuard&&!(s.ack&&s.watcherHeld))e('Old no-lock guard reaches deadline, lists and removes its bound name',
        at('design','281-289; lib/sandbox-deadline-supervisor.mjs:81-118'),
        t=>{t.pc=2;if(stopJobBeforeRemove)t.job=false;t.removedLive=t.job;});
      if(handOff&&s.ack&&s.watcherHeld&&s.oldGuard)e('Old guard leaves on saved acknowledgment and watcher-held record',
        at('design','281-289'),t=>{t.oldGuard=false;});
      if(s.crash===0)for(const who of ['app','watcher','guard']) {
        if(who==='app'&&!s.app||who==='watcher'&&!s.watcherLive||who==='guard'&&!s.oldGuard)continue;
        e(who+' crashes at this upgrade cut point',at('design','91-105,281-289'),
          t=>{t.crash=1;t.crashed=who;if(who==='guard')t.oldGuard=false;
            if(who==='app')t.app=false;if(who==='watcher'){t.watcherLive=false;t.watcherHeld=false;}});
      }
      if(s.crash===1)e(s.crashed+' restarts; durable names remain reserved',
        at('journal','106-113,678-710'),t=>{t.crash=2;
          if(t.crashed==='app')t.app=true;
          if(t.crashed==='watcher'&&t.manifest){t.watcherLive=true;t.watcherHeld=true;}
          // A crashed old-version guard is not relaunched as old code by the upgrade.
          t.crashed='';});
    },s=>s.removedLive?['OLD_GUARD_NO_LIVE_REMOVE']:[]);
}
function proofOrder({skipPresent=false,skipOrder=false}={}) {
  return explore('proof-order-'+JSON.stringify(arguments[0]??{}),
    {phase:0,seq:1,present:0,absent:0,gone:false,bad:false},(s,e)=>{
      if(s.phase===0) {
        e('Begin early absent listing at sequence 2',
          at('proof','80-87'),t=>{t.phase=1;t.seq=2;t.absent=2;});
        e('Commit present sighting before later absent listing',
          at('proof','113-114'),t=>{t.phase=2;t.seq=2;t.present=2;});
        if(skipPresent)e('Mutant accepts absence without present sighting',
          at('proof','115-120'),t=>{t.phase=3;t.gone=true;t.bad=true;});
      }
      if(s.phase===1)e('Later owner commits present at sequence 3',
        at('proof','113-114'),t=>{t.phase=2;t.seq=3;t.present=3;});
      if(s.phase===2) {
        if(!s.absent)e('Begin later complete absence at next sequence',
          at('proof','80-87'),t=>{t.absent=++t.seq;});
        if(s.absent)e('Validate both sightings and strict order before gone',
          at('proof','40-41,115-118'),t=>{
            t.phase=3;t.gone=skipOrder||t.absent>t.present;
            t.bad=t.gone&&(!t.present||t.absent<=t.present);
          });
      }
    },s=>s.bad?['NO_GONE_WITHOUT_BOTH_SIGHTINGS']:[]);
}
function oneRm({once=false}={}) {
  return explore('one-rm-'+JSON.stringify(arguments[0]??{}),
    {pc:0,commands:0,held:false},(s,e)=>{
      if(s.pc===0)e('Guard takes handle after failed/complete listing',
        at('guard','81-102'),t=>{t.pc=1;t.held=true;});
      if(s.pc===1&&s.commands<2&&(!once||s.commands===0))
        e('Guard issues rm for same bound generation',
          at('guard','118'),t=>{t.commands++;t.pc=2;});
      if(s.pc===2)e('Follow-up listing fails; release before retry delay',
        at('guard','119-132'),t=>{t.held=false;t.pc=s.commands<2?0:3;});
    },s=>s.commands>1?['ONE_RM_PER_GENERATION']:[]);
}

const baseH=handoff();
const signalTeardowns=[
  at('deadline','239'), at('guard','168'),
  at('watcher','302'), at('watcher','328'), at('app','725'),
  at('app','761'), at('app','1113'),
];
// Each teardown signals a ChildProcess this process started, through its live handle. The handle is released in the same
// callback that reaps the process, so a reaped process cannot be signalled by number (tests/sandbox-signal-identity.test.mjs S4);
// the source replay below shows that every teardown site is such a handle call and none is a numeric-PID call.
const baseRuns=[baseH,startup(),signals(),...signalTeardowns.map(teardown=>signals({teardown,pinnedHandle:true})),
  actors({oldGuard:false}),actors({oldGuard:true}),noId(),epochs(),appFence(),starvation(),guardBackoff(),
  oldLive(),oldLive({originalJob:false}),proofOrder(),oneRm()];
const propertyNames=['PROTECT','PROTECT_REPAIR','RETIRE_AUTH','SIGNAL_IDENTITY','ONE_ACTOR','ACK_FAIL','NO_ID_REPLAY','EPOCH_MONOTONIC','APP_RM_FENCED','NO_STARVATION','ADOPT_AFTER_RECEIPT','OLD_GUARD_NO_LIVE_REMOVE','ONE_RM_PER_GENERATION','NO_GONE_WITHOUT_BOTH_SIGHTINGS'];
const results=propertyNames.map(property=>{
  const witness=best(baseRuns,property);
  return {property,result:witness?'REACHABLE':'HOLDS',witness};
});
for(const result of results)test(result.property,()=>{
  assert.equal(result.witness,null,JSON.stringify(result));
});

// Each mutation really changes a guard/transition. Base-reachable properties
// have a bad mutant too, but that is not evidence of an existing prevention
// mechanism. Counterfactual repaired controls below identify that distinction.
test('mutation controls: every property oracle detects a violation',()=>{
  const mH=handoff({handOff:true,retireOnFlag:true,prematureManifest:true,ignoreServing:true,dropGuardOnAckFailure:true});
  const cases={
    PROTECT:best([mH,startup({retireInReconcile:true})],'PROTECT'),
    PROTECT_REPAIR:best([handoff({levelTrigger:false})],'PROTECT_REPAIR'),
    RETIRE_AUTH:best([mH],'RETIRE_AUTH'),
    SIGNAL_IDENTITY:best([signals({skipFinalRead:true,appSignals:true})],'SIGNAL_IDENTITY'),
    ONE_ACTOR:best([actors({oldGuard:false,unfencedGuard:true,watcherServesGuardedRow:true})],'ONE_ACTOR'),
    ACK_FAIL:best([mH],'ACK_FAIL'),
    NO_ID_REPLAY:best([noId({ignoreManifestId:true,manifestHasId:false})],'NO_ID_REPLAY'),
    EPOCH_MONOTONIC:best([epochs({resetEpoch:true}),epochs({skipRecheck:true})],'EPOCH_MONOTONIC'),
    APP_RM_FENCED:best([appFence({recheck:true,skipAcquire:true})],'APP_RM_FENCED'),
    NO_STARVATION:best([guardBackoff({holdDuringBackoff:true}),starvation({lifetimeHold:true})],'NO_STARVATION'),
    ADOPT_AFTER_RECEIPT:best([handoff({handOff:true,flagBeforeReceipt:true})],'ADOPT_AFTER_RECEIPT'),
    OLD_GUARD_NO_LIVE_REMOVE:best([oldLive({permitNameReuse:true,originalJob:false})],'OLD_GUARD_NO_LIVE_REMOVE'),
    ONE_RM_PER_GENERATION:best([oneRm({once:false})],'ONE_RM_PER_GENERATION'),
    NO_GONE_WITHOUT_BOTH_SIGHTINGS:best([proofOrder({skipPresent:true}),proofOrder({skipOrder:true})],'NO_GONE_WITHOUT_BOTH_SIGHTINGS'),
  };
  for(const [name,witness]of Object.entries(cases))assert.ok(witness,name+' vacuous mutant');
});
test('counterfactual repairs and current-code narrow controls',()=>{
  const good=[
    [startup({acceptPublishedReplacement:true}),'PROTECT'],
    [handoff(),'PROTECT_REPAIR'],
    [signals({pinnedHandle:true,appSignals:true}),'SIGNAL_IDENTITY'],
    [actors({oldTakesLock:true,watcherServesGuardedRow:true}),'ONE_ACTOR'],
    [actors({oldGuard:false,watcherServesGuardedRow:true}),'ONE_ACTOR'],
    [noId({validateAuthoritativeRow:true}),'NO_ID_REPLAY'],
    [epochs(),'EPOCH_MONOTONIC'],
    [appFence({recheck:true}),'APP_RM_FENCED'],
    [starvation(),'NO_STARVATION'],
    [guardBackoff(),'NO_STARVATION'],
    [handoff({handOff:true,flagBeforeReceipt:false}),'ADOPT_AFTER_RECEIPT'],
    [oldLive({stopJobBeforeRemove:true}),'OLD_GUARD_NO_LIVE_REMOVE'],
    [oldLive({originalJob:false}),'OLD_GUARD_NO_LIVE_REMOVE'],
    [noId({manifestHasId:false}),'NO_ID_REPLAY'],
    [oneRm({once:true}),'ONE_RM_PER_GENERATION'],
    [proofOrder(),'NO_GONE_WITHOUT_BOTH_SIGHTINGS'],
  ];
  for(const [run,id]of good)assert.ok(!run.found[id],id+' repaired/control failed');
  assert.ok(!baseH.found.MANIFEST_RECEIPT,'Current manifest never precedes receipt');
});

const root=process.env.CLEANUP_MODEL_SOURCE_ROOT
  ?pathToFileURL(path.resolve(process.env.CLEANUP_MODEL_SOURCE_ROOT)+path.sep)
  :new URL('../../',import.meta.url);
const source=p=>fs.readFileSync(new URL(p,root),'utf8');
function slice(p,start,end) {
  const text=source(p),a=text.indexOf(start),b=end?text.indexOf(end,a+start.length):text.length;
  assert.ok(a>=0&&b>a,'Source seam moved: '+p+' / '+start);
  return text.slice(a,b);
}
const compile=(body,bindings,returns)=>new Function(...Object.keys(bindings),
  body.replace(/\bexport /g,'')+'\nreturn '+returns+';')(...Object.values(bindings));
const name='wf-0000000000000001';
const rowFixture=()=>({_cleanupId:'11111111-1111-4111-8111-111111111111',sandbox_id:name,
  create_incarnation:'11111111-1111-4111-8111-111111111111',watch_generation:'generation-1',
  sbx_home:'/fixture/home',owner_scope:'owner',create:'dispatched',compute_created:false,
  create_settled:false,compute_stopped:false,absent_since:1,deadline_at:1});
const observed=[];
function confirmed(property,detail){observed.push({property,detail});}
const inventory=r=>{try{return r.code===0?JSON.parse(r.stdout):null;}catch{return null;}};
const listing=present=>({code:0,stdout:JSON.stringify(present?[{name}]:[]),stderr:''});
const denied=()=>Object.assign(Error('busy'),{code:'lock_busy'});
const stop=()=>Object.assign(Error('test stop'),{code:'TEST_STOP'});
function supervisor(serving=()=>null) {
  return compile(slice(P.guard,'export const DEADLINE_COMMAND_MS=','// The guard publishes its identity'),{
    fs:{},path,sharedWatchServing:serving,completeWatchInventory:inventory,
    sandboxDeadlineClock:()=>({wall:2}),sandboxDeadlineRemaining:()=>0,
    acquireRecordOwner:()=>{throw Error('Inject fence');},watchProofDirectory:x=>x,
    syncDirectory:()=>{},createIdOf:r=>r?._cleanupId??r?.create_incarnation??null,
    execFile:()=>{throw Error('No subprocesses');},
  },'superviseSandboxDeadline');
}
function manager(overrides={}) {
  // Only injected branches are reached. Dynamic watcher import must never run:
  // these replays exercise pre-handoff reconcile and ordinary cancel/register.
  return compile(slice(P.deadline,'export function createSandboxDeadlineManager('),{
    process:{platform:'darwin',execPath:'/fixture/node',kill:()=>{throw Error('Real kill forbidden');}},
    runDeadlineCommand:async()=>({code:1}),sandboxDeadlineClock:()=>({wall:2}),
    spawn:()=>{throw Error('Real spawn forbidden');},deadlineProcessIdentity:async()=>null,
    readState:()=>null,deadlineProcessStartSync:()=>null,listDeadlineGuardProcesses:async()=>[],
    target:()=>{},deadlineSupervisorPayload:(r,binary)=>({sandbox_id:r.sandbox_id,sbx_home:r.sbx_home,binary,
      recordPath:'/fixture/journal/'+r._cleanupId+'.json',
      statusPath:'/fixture/journal/'+r._cleanupId+'.json.deadline'}),
    deadlineBinding:()=> 'binding',sandboxDeadlineRemaining:()=>1000,
    sandboxDeadlineUnit:()=> 'fixture-unit',sandboxDeadlineUnitMatches:(_row,unit)=>unit==='fixture-unit',guardFile:'/fixture/guard',
    deadlineSuccessorPath:payload=>payload.statusPath+'.ready',buildSuffix:()=> 'fixture-build',
    processLockOwners:()=>[],path,SANDBOX_GUARD_BUILD_ID:'fixture-build',
    handedOff:r=>r?.watch_state==='watch_adopted'&&Boolean(r._cleanupId)&&r.watch_ack?.challenge===r.watch_challenge,
    deadlineMaterialized:()=>false,
  },'createSandboxDeadlineManager')({binary:'/fixture/sbx',...overrides});
}
function adapter() {
  return compile(slice(P.watcher,'const validName=','export function completeWatchInventory'),{
    path,randomUUID:()=> 'challenge',handedOff:r=>r.watch_ack?.challenge===r.watch_challenge&&Boolean(r.watch_challenge),
    sharedWatchServing:()=>null,
  },'adoptSandboxWatch');
}
function poller() {
  return compile(slice(P.watcher,'export function completeWatchInventory','function paths('),{
    WATCH_POLL_MS:5000,WATCH_BACKOFF_MS:60000,
  },'createWatchPoller');
}
function memoryProofs({skipOwnerChecks=false,skipStrictOrder=false}={}) {
  // Executes exact record-owner and proof-store bodies. Atomic durable-write
  // and process mutual exclusion are injected boundaries, not an fsync/OS test.
  const data=new Map(),locks=new Set();
  const nofile=()=>Object.assign(Error('missing'),{code:'ENOENT'});
  const fakeFs={mkdirSync(){},lstatSync(p){if(!data.has(p))throw nofile();return {isSymbolicLink:()=>false};},
    readFileSync(p){if(!data.has(p))throw nofile();return data.get(p);}};
  const durableWrite=(p,value)=>{data.set(p,value);};
  const lock=p=>{if(locks.has(p))throw denied();locks.add(p);let done=false;
    return ()=>{if(!done){done=true;locks.delete(p);}};};
  let ownerBody=slice(P.owner,'export const STALL_MS=');
  if(skipOwnerChecks)ownerBody=ownerBody
    .replace('if(released)throw lost();','')
    .replace('if(saved?.epoch!==state.epoch||saved.role!==role)throw lost();','');
  const owner=compile(ownerBody,{
    fs:fakeFs,path,durableWrite,acquireProcessLockSync:lock,
    processLockOwners:p=>locks.has(p)?[{pid:123}]:[],
  },'({acquireRecordOwner,readOwnership})');
  let proofBody=slice(P.proof,'const VALID_NAME=');
  if(skipStrictOrder)proofBody=proofBody
    .replace('if(finite(listedAt)&&!(listedAt>next.present_at))return null;','');
  const factory=compile(proofBody,{
    fs:fakeFs,path,durableWrite,acquireProcessLock:async p=>lock(p),
    acquireRecordOwner:owner.acquireRecordOwner,
  },'watchProofStore');
  return {factory,owner,data,locks};
}
test('source replay PROTECT: reconcile adopts the sole published replacement guard and never signals it',async()=>{
  const row=rowFixture();row.deadline_enforcer={kind:'guard',pid:11,start:'old'};
  let live=true,signals=0;
  const payload={sandbox_id:name,sbx_home:row.sbx_home,binary:'/fixture/sbx',launchMode:'guard',deadline_at:row.deadline_at,recordPath:'/fixture/journal/'+row._cleanupId+'.json',
    statusPath:'/fixture/journal/'+row._cleanupId+'.json.deadline'};
  const m=manager({listProcesses:async()=>[{pid:22,payload}],
    processStart:async()=>live?'replacement':null,processStartSync:()=> 'replacement',
    stateReader:()=>({pid:22,start:'replacement',binding:'binding',state:'armed'}),
    kill:()=>{signals++;live=false;}});
  const result=await m.reconcileGuards({directory:'/fixture/journal',rowFor:()=>row});
  assert.equal(signals,0);assert.equal(result.adopted.length,1);assert.equal(result.retired,undefined);assert.equal(live,true);
  confirmed('PROTECT','Real reconcileGuards adopts the sole replacement while the row saves the old PID; nothing is signalled and there is no retire branch.');
});
test('source replay RETIRE_AUTH: a serving watcher is not a reason for the guard to publish a hand-off or end',async()=>{
  const row=rowFixture(),states=[];let rounds=0;
  const served={...row,watch_state:'watch_adopted',watch_challenge:'c',watch_ack:{challenge:'c',binary:'/fixture/sbx'}};
  await assert.rejects(supervisor(()=>({}))(row,{
    readRecord:()=>served,publish:state=>states.push(state),fence:()=>{throw denied();},
    run:async()=>listing(true),pause:async()=>{if(++rounds>=2)throw stop();}}),{code:'TEST_STOP'});
  assert.equal(states.some(state=>state.state==='watch_adopted'),false);assert.ok(rounds>=2,'the guard kept its rounds');
  confirmed('RETIRE_AUTH','Real supervisor reads a row acknowledged by a serving watcher and keeps its rounds; it publishes no hand-off and does not return.');
});
test('source replay PROTECT_REPAIR: the 15 s cleanup loop runs the recovery that registers a guard for a pending row without one',()=>{
  const loop=slice('lib/v1/app.mjs','const reapData=()=>{','Backends without an explicit capability contract');
  assert.match(loop,/deadlineRecovery\.retry\(\)/,'each pass runs the recovery');
  assert.match(loop,/setInterval\(reapData,options\.cleanupRecheckMs\?\?15000\)/,'every 15 s');
  assert.match(source(P.app),/this\.cleanupJournal\.recoverDeadlines\(this\.sandboxDeadlines,/,'the recovery is the journal pass over the real manager');
  const protect=slice(P.journal,'const protect=async(row','const recover=async row');
  assert.match(protect,/if\(!active\)\s*\{[^}]*manager\.register\(locked,\{recovery:true\}\)/,'a row without a live guard gets one through register()');
  confirmed('PROTECT_REPAIR','The app loop calls the same recovery as startup every 15 s; a pending row without a live guard is registered one there, and the lifetime lock on the status path stops a second guard (tests/sandbox-guard-restart.test.mjs R1 to R5).');
});
test('source replay SIGNAL_IDENTITY: the manager has no cancel and reconcile never signals, even when the identity could be reused',async()=>{
  const row=rowFixture();row.deadline_enforcer={kind:'guard',pid:22,start:'original'};
  let identity='original',signalled=0;
  const payload={sandbox_id:name,sbx_home:row.sbx_home,binary:'/fixture/sbx',launchMode:'guard',deadline_at:row.deadline_at,recordPath:'/fixture/journal/'+row._cleanupId+'.json',
    statusPath:'/fixture/journal/'+row._cleanupId+'.json.deadline'};
  const m=manager({processStart:async()=>identity,
    processStartSync:()=>{const checked=identity;identity='reused';return checked;},
    stateReader:()=>({pid:22,start:'original',binding:'binding',state:'armed'}),
    listProcesses:async()=>[{pid:22,payload}],
    kill:()=>{signalled++;}});
  assert.equal(m.cancel,undefined);assert.equal(m.retireForWatch,undefined);
  row.deadline_enforcer={kind:'guard',pid:11,start:'other'};
  await m.reconcileGuards({directory:'/fixture/journal',rowFor:()=>row});
  assert.equal(signalled,0);
  confirmed('SIGNAL_IDENTITY','Real manager exposes no cancel or retire, and reconcile sends no signal; the remaining kill sites signal a process this process started, by its own handle.');
});
test('source replay SIGNAL_IDENTITY: child teardown uses handles; the verified build upgrade has one numeric signal site',()=>{
  let handleCalls=0,numericCalls=0;
  for(const file of [P.deadline,P.guard,P.watcher,P.app]) {
    const lines=source(file).split('\n');
    lines.forEach((line,index)=>{
      if(/^\s*(\/\/|\*)/.test(line))return;
      if(/\bprocess\.kill\(/.test(line)) {
        if(file===P.deadline&&line.includes('signalGuard=')) {
          numericCalls++;assert.match(line,/signalGuard=\(pid,signal\)=>process\.kill\(pid,signal\)/);
          const managerSource=source(P.deadline);
          assert.match(managerSource,/processStartSync\(state\.pid\)!==state\.start/);
          assert.match(managerSource,/deadlineBinding\(item\.payload\)===deadlineBinding\(payload\)/);
          assert.match(managerSource,/signalGuard\(state\.pid,'SIGTERM'\)/);
        }else assert.match(line,/process\.kill\(.*,\s*0\s*\)/,file+':'+(index+1)+' signals a number');
      }
      for(const call of line.matchAll(/([A-Za-z_.?]+)\.kill\(/g)) {
        if(call[1]==='process')continue;
        handleCalls++;
        assert.match(call[1],/^(child|command|pending\.child\??|target)\??$/,file+':'+(index+1)+' signals something other than a child handle');
      }
    });
  }
  assert.ok(handleCalls>=7,'the seven child teardown sites were found');
  assert.equal(numericCalls,source(P.deadline).includes('signalGuard=')?1:0,'only the authorized build-upgrade site signals a PID');
  confirmed('SIGNAL_IDENTITY','Child teardown uses handles; the release rule additionally permits verified old-build replacement, with payload and final identity checks. The PID check remains a snapshot.');
});
test('source replay ACK_FAIL and ADOPT_AFTER_RECEIPT: for a row with no guard, lock_busy leaves the adopted flag and rejects a guard restart',async()=>{
  const row=rowFixture(),saved=[];
  const result=await adapter()({status:'watching',row},{
    fence:()=>{},persist:r=>saved.push(clone(r)),acknowledge:async()=>{throw denied();}});
  assert.equal(result.status,'failed');assert.equal(result.reason,'record_held');
  assert.equal(saved.length,1);assert.equal(saved[0].watch_state,'watch_adopted');
  assert.equal(saved[0].watch_ack,null);
  // The launch path never gives an adopted row a guard; recovery does, once it finds none alive.
  await assert.rejects(manager().register(saved[0]),/reserved for cleanup/);
  const launched=await manager({spawnGuard:()=>{throw stop();}}).register(saved[0],{recovery:true}).catch(error=>error);
  assert.equal(launched.code,'TEST_STOP','recovery reaches the guard launch for an adopted row');
  confirmed('ADOPT_AFTER_RECEIPT','Real adapter saves adopted flag before acknowledgment/receipt and keeps it on lock_busy; the journal never calls it for a row that has a guard.');
  confirmed('ACK_FAIL','Real register refuses a null-ack adopted row on the launch path and restores its guard in recovery, so the loss of its only guard is closed at the next startup.');
});
test('source replay NO_ID_REPLAY: retained manifest acts without authoritative row create id',async()=>{
  const mem=memoryProofs(),proofs=mem.factory({home:'/fixture/home',owner:'owner'});
  const row=rowFixture(),item={name,create_incarnation:row._cleanupId,watch_generation:row.watch_generation,state:'watch_adopted'};
  await proofs.receipt(row,1);
  const currentRow={...row};delete currentRow._cleanupId;delete currentRow.create_incarnation;
  assert.throws(()=>proofs.own(currentRow,{role:'watcher'}),/binding is invalid/);
  const calls=[];
  const p=poller()({read:()=>({names:[item]}),proofs,publish:()=>{},
    run:async args=>{calls.push(args[0]);return listing(true);}});
  await p.tick();await p.drain();p.stop();await p.drain();
  assert.ok(calls.includes('rm'));
  confirmed('NO_ID_REPLAY','Real poller/proof-store/owner bodies remove from retained manifest despite authoritative row lacking both create identifiers; replay assumes that restored row/manifest cut point.');
});
test('source replay EPOCH_MONOTONIC and strict gone evidence',async()=>{
  const mem=memoryProofs(),row=rowFixture(),proofs=mem.factory({home:'/fixture/home',owner:'owner'});
  const a=proofs.own(row,{role:'app'});assert.equal(a.epoch,1);
  await proofs.receipt(row,1,{tenure:a});
  const early=await proofs.stamp();await proofs.observe(row,true,{tenure:a});
  assert.equal(await proofs.observe(row,false,{listedAt:early,tenure:a}),null);
  assert.equal(proofs.gone(row),null);
  a.release();
  const reopened=mem.factory({home:'/fixture/home',owner:'owner'}),b=reopened.own(row,{role:'watcher'});
  assert.equal(b.epoch,2);assert.throws(()=>a.assertCurrent(),{code:'owner_lost'});
  const later=await reopened.stamp();await reopened.observe(row,false,{listedAt:later,tenure:b});
  const gone=reopened.gone(row);assert.ok(gone.absent_at>gone.present_at);b.release();
  confirmed('EPOCH_MONOTONIC','Real owner/proof bodies preserve epoch on reopen and reject released old handle, with atomic-write/lock fakes.');
  confirmed('NO_GONE_WITHOUT_BOTH_SIGHTINGS','Real proof body refuses earlier absence and accepts later stamped absence.');
});

test('source mutation controls: missing epoch and strict-order checks are detected',async()=>{
  const row=rowFixture(),mem=memoryProofs({skipOwnerChecks:true});
  const proofs=mem.factory({home:'/fixture/home',owner:'owner'});
  const first=proofs.own(row,{role:'app'});first.release();
  const current=proofs.own(row,{role:'watcher'});
  assert.doesNotThrow(()=>first.mark(),'Mutant should wrongly admit stale owner action');
  current.release();
  const order=memoryProofs({skipStrictOrder:true}).factory({home:'/fixture/home',owner:'owner'});
  const tenure=order.own(row,{role:'app'}),early=await order.stamp();
  await order.observe(row,true,{tenure});
  const invalid=await order.observe(row,false,{listedAt:early,tenure});
  assert.equal(invalid.state,'gone');assert.ok(invalid.absent_at<=invalid.present_at);
  tenure.release();
});

test('source replay APP_RM_FENCED: ordinary destruction never calls owner recheck',async()=>{
  const row={...rowFixture(),compute_created:true,create_settled:false};
  let held=true,checks=0,stale=false,removed=false,marked=false;
  const owner={assertCurrent(){checks++;if(stale)throw Object.assign(Error('lost'),{code:'owner_lost'});},release(){held=false;}};
  const method=slice(P.app,'  async _resolveCompute(','\n  async _finishDestroy(');
  const obj=compile('const body={'+method+'};',{
    createIdOf:r=>r._cleanupId,watchProofDirectory:x=>x,acquireRecordOwner:()=>owner,
    daemonJobContext:{run:async(_ctx,fn)=>fn()},establishedAbsentWatch:()=>false,
    parseSbxListing:r=>JSON.parse(r.stdout).map(x=>x.name),completeSbxListing:r=>r.code===0,
    CREATE_CESSATION_BOUND_MS:()=>0,removeSandboxGitHub:async()=>true,removeSandboxPolicies:async()=>true,
  },'body');
  Object.assign(obj,{_watchInventoryCurrent:()=>false,_rowHomeMatches:()=>true,
    cleanupJournal:{authority:()=>row,mark:()=>{marked=true;return true;}},sandboxDeadlines:{},
    _rowRun:async(_row,args)=>{assert.equal(held,true);
      if(args[0]==='rm'){removed=true;return {code:0};}
      stale=true;return listing(!removed);}});
  const result=await obj._resolveCompute(row);
  assert.equal(checks,0);assert.equal(marked,true);assert.equal(removed,true);assert.equal(result.removed,true);assert.equal(held,false);
  confirmed('APP_RM_FENCED','Real ordinary method marks and removes after awaits with zero assertCurrent calls; injected epoch loss is a defensive seam, not proved naturally reachable lock theft.');
});
test('source replay NO_STARVATION: watcher holds no record between actions; changed-row guard does not',async()=>{
  let held=false,acquired=0;
  const item={name,create_incarnation:'id',watch_generation:'g'};
  const tenure={mark(){},release(){held=false;}};
  const p=poller()({read:()=>({names:[item]}),publish:()=>{},run:async()=>({code:1}),
    proofs:{own:()=>{held=true;acquired++;return tenure;},stamp:async()=>1}});
  assert.equal(await p.tick(),5000);assert.ok(acquired>0,'the watcher took the record to save progress');assert.equal(held,false,'and let it go');
  p.stop();await p.drain();assert.equal(held,false);
  for(const mode of ['changed','unreadable']) {
    const row=rowFixture();let reads=0,guardHeld=false,paused=false,reason;
    await assert.rejects(supervisor()(row,{
      readRecord:()=>{if(++reads!==3)return row;if(mode==='unreadable')throw Error('read failed');return {...row,_cleanupId:'changed'};},
      fence:()=>{guardHeld=true;return {release(){guardHeld=false;}};},
      publish:state=>{reason=state.reason;},
      run:async args=>{assert.notEqual(args[0],'rm');return listing(true);},
      pause:async()=>{assert.equal(guardHeld,false);paused=true;throw stop();},
    }),{code:'TEST_STOP'});
    assert.equal(paused,true);assert.equal(reason,'record_'+mode);
  }
  confirmed('NO_STARVATION','Real watcher returns its delay with no record held; real changed-row and unreadable-row guard branches release before pause.');
});
test('source replay ONE_RM_PER_GENERATION: guard retries same-name removal after unproved listing',async()=>{
  const row=rowFixture();let removals=0,held=false;
  await assert.rejects(supervisor()(row,{
    readRecord:()=>row,fence:()=>{held=true;return {release(){held=false;}};},
    run:async args=>{if(args[0]==='rm'){assert.equal(held,true);removals++;}return {code:1};},
    pause:async()=>{assert.equal(held,false);if(removals===2)throw stop();},
  }),{code:'TEST_STOP'});
  assert.equal(removals,2);
  confirmed('ONE_RM_PER_GENERATION','Real guard repeats rm after failed listings and releases handle between attempts; this is documented idempotent retry.');
});
test('source control: no-ID row rejected by adapter; current guarded fence refuses overlap',async()=>{
  const row=rowFixture();delete row._cleanupId;delete row.create_incarnation;
  let persisted=false;
  const untouched=await adapter()({status:'watching',row},{persist:()=>{persisted=true;}});
  assert.equal(untouched.row,row);assert.equal(persisted,false);
  let removed=false,reported;
  await assert.rejects(supervisor()(rowFixture(),{
    readRecord:rowFixture,fence:()=>{throw denied();},publish:s=>{reported=s;},
    run:async args=>{if(args[0]==='rm')removed=true;return listing(true);},
    pause:async()=>{throw stop();},
  }),{code:'TEST_STOP'});
  assert.equal(removed,false);assert.equal(reported.reason,'record_held');
});
test('source control: fresh registration refuses an already reserved name',()=>{
  const register=compile(slice(P.journal,'  function register(handle','  // Durable create facts'),{
    validSandboxDeadline:()=>true,canonicalScratchPath:()=>'/fixture/scratch',scratchRoot:()=>'/fixture/scratch',
    fs:{mkdirSync(){},lstatSync(){return {isSymbolicLink:()=>false};},existsSync:()=>true},
    directory:'/fixture/journal',sync:()=>{},path,randomUUID:()=> 'new-id',
    scope:x=>x,file:x=>x,acquireProcessLockSync:()=>()=>{},home:()=>'/fixture/home',
    recorded:()=>false,reserveDeadlineName:()=>{throw Error('Must refuse before reserve');},
    sandboxOwnerScope:()=> 'owner',write:()=>{},leases:new Map(),admissions:new WeakMap(),owners:new Map(),
  },'register');
  assert.throws(()=>register({deadline_at:1,sandbox_id:name,scratch_dir:'/fixture/scratch',sbx_home:'/fixture/home'}),/already reserved/);
});
test('complete suite stays under 60 seconds and prints reproducible evidence',()=>{
  assert.ok(performance.now()-began<60000,'Full model exceeded 60 seconds');
  const evidence={
    pin:PIN,elapsedMs:Math.round(performance.now()-began),
    bounds:[
      'BFS to finite fixpoint, hard 200000-state cap per partition; cap breach is a test failure, never HOLDS.',
      'One symbolic random name and generation, two owner acquisitions, one process crash/restart at every enabled handoff/upgrade cut point.',
      'Names/generations are equality classes, not a full two-name cross-product. Name reuse admission has a separate real-source negative replay.',
      'At most two rm commands; at most two waiter attempts. No bounded-wait proof follows: a retained live holder can block indefinitely.',
      'Separate property partitions, not whole-host exhaustive verification; shortest traces are relative to their explicit seeds.',
      'Atomic durable writes and verified process locks are abstractions; malformed ownership files refuse, external ownership-file deletion or hostile filesystem modification excluded.',
      'ChildProcess.kill sites signal through a live handle that is released when the process is reaped (tests/sandbox-signal-identity.test.mjs S4); the teardown partitions pin the handle, and the source replay shows each site is a handle call. Numeric-PID signal sites are listed with a reason in S5. Signal-0 existence probes do not terminate processes and are excluded.',
      'OS PID reuse and other-process stop may occur between adjacent synchronous operations. No instantaneous crash restart or scheduling fairness assumed.',
      'Old supervisor transition follows the assignment and design lines 281-289; old binary source is not at this pin, so its counterexamples are MODEL-ONLY.',
      'No-ID replay starts with a retained manifest and restored row with no create id; provenance of that restored state is an explicit hypothesis.',
      'APP_RM_FENCED is a required-recheck protocol property. Its source replay injects invalidation, not an asserted naturally reachable live-lock takeover.',
      'No created compute is called gone before both sightings; never-dispatched rows are outside that premise.',
      'Release rule: the base runs have no hand-off, no retire, no cancel and no guard exit for a serving watcher. Rows that never had a guard (no deadline fields) are outside the guarded-row partitions; the watcher adoption of those rows is unchanged and is covered by the source replays only.',
      'A guard process that dies while the app keeps running leaves its row without a remover until the next recovery registers a guard; that is the PROTECT crash trace, not a hand-off effect. Recovery now registers a guard for every pending row with a deadline and no live guard, including a row an earlier version handed off.',
      'The watcher takes a record for one action only, so it can act on a row that also has a guard; an older guard that takes no owner lock can overlap one action of the watcher (the accepted window of design lines 281-289, idempotent removal).',
    ],
    baseRuns:baseRuns.map(({found,...r})=>r),
    results,sourceReplays:observed,
    allRuns:totals.map(({found,coverage,...r})=>r),
  };
  console.log('CLEANUP_MODEL_EVIDENCE '+JSON.stringify(evidence));
});
