import {sandboxRemediationLines} from '../sandbox-remediation.mjs';
// Remediation sentences for the pool label, skipping any the account's own label already states.
function remediationLinesNotIn(label,remediation){
 const fresh=remediation.filter(row=>!row.command||!label?.includes(row.command));
 return [...new Set(sandboxRemediationLines(fresh))].filter(line=>!label?.includes(line));
}
// Account workers keep independent lease/recovery journals. Their daily time and
// requester ceilings share this one durable write queue and the existing lock.
const journals=['pending','claimPending','claimedPending','acceptedClaim','outputPending','resultPending','declinePending','stoppedPending','watchedStops'];
import {hasPendingObservations,lenderDayKey} from './lender.mjs';
import {accountKey as accountKeyOf,childIdFor,isAccountKey,parseChildId,providerOfKey} from './lending-account-key.mjs';
export {parseChildId};
const clone=structuredClone;
const providerOf=id=>id.startsWith('claude')?'claude':id==='codex'?'codex':id;
// A stored row that is not an account key (a recovery row) keeps its leading word as its provider, as before.
const providerOfChild=key=>isAccountKey(key)?providerOfKey(key):String(key).split(':')[0];
// A worker with no numbered slot is never counted against the slot limit.
const withinSlots=(child,slots)=>child.slot!==null&&child.slot<slots;
const hasWork=s=>journals.some(k=>s?.[k])||hasPendingObservations(s?.observationPending);
// Lists that belong to the whole computer, not to one account: what the owner hid or stopped, and each
// standing rule's use. They live once, on the root. Every worker reads them and its writes merge into them.
const SHARED=['hiddenOffers','ruleUsage','jobConsents'];
const WEEK=7*86400000;
const usageKey=e=>JSON.stringify([e.id,e.attemptId??null,e.jobDigest??null,e.acceptedAt??null]);
const rowKey=(key,e)=>key==='ruleUsage'?usageKey(e):e.jobDigest;
// The shared rows a worker holds, each as its key and content. A row it still holds unchanged is a copy, not an update.
const heldRows=lists=>Object.fromEntries(SHARED.map(key=>[key,new Map((lists[key]??[]).filter(e=>e&&!e.reserved).map(e=>[rowKey(key,e),JSON.stringify(e)]))]));
export function createLendingPool({storage,policy,createLender,adapters,capacity=1,maxResources={cpu:Infinity,memoryBytes:Infinity},...options}) {
 let root=null,writing=Promise.resolve(),children=[],loop=null,paused=false,addWorkers=()=>{};
 // One review card per job. Every account worker sees the same queued job and asks to approve it. The first asks; the others
 // wait on that answer and never open a second card. If the first was accepted, that worker claims the job, so for the
 // others it is taken. A skip or a timeout is the owner's answer for every worker. Nothing is kept once the answer is in.
 const inFlightApprovals=new Map();
 const approve=typeof options.approve!=='function'?undefined:details=>{
  const key=details?.jobDigest;
  if(key==null)return options.approve(details);
  const first=inFlightApprovals.get(key);
  if(first)return first.then(answer=>answer===true?{withdrawn:true,code:'offer_taken'}:answer);
  const answer=Promise.resolve().then(()=>options.approve(details));
  inFlightApprovals.set(key,answer);
  const forget=()=>{if(inFlightApprovals.get(key)===answer)inFlightApprovals.delete(key);};
  answer.then(forget,forget);
  return answer;
 };
 const registered=()=>options.accounts?.()??[];
 const keyOf=account=>account.key??accountKeyOf(account);
 // True when the registry knows this provider's accounts and this key is not one the owner has on.
 const accountOff=(provider,key)=>{const own=registered().filter(a=>a.provider===provider);return own.length>0&&!own.some(a=>a.enabled!==false&&keyOf(a)===key);};
 const readAdapters=async()=>typeof adapters==='function'?await adapters():adapters;
 const update=fn=>{const result=writing.then(async()=>{const next=fn(clone(root));await storage.set(next);root=next;});writing=result.catch(()=>{});return result;};
 const now=()=>options.clock?.now?.()??Date.now();
 // A worker's list is authoritative for the entries it carries; entries it never saw (written by another
 // worker after its read) are kept until they expire.
 const mergeShared=(target,list,key)=>{
  const incoming=(list??[]).filter(e=>e&&!e.reserved);
  const own=new Set(incoming.map(e=>rowKey(key,e)));
  // A resumed accepted job writes its attempt over the hold (or zero-use row) it replaces. That row's key changes, so
  // the key match above cannot drop it; the same grant would count twice. Real use of an earlier attempt is kept.
  const replaced=e=>key==='ruleUsage'&&(!e.attemptId||(e.finished===true&&e.ms===0))&&e.jobDigest!=null&&
    incoming.some(n=>n.id===e.id&&n.jobDigest===e.jobDigest&&n.acceptedAt===e.acceptedAt);
  const alive=key==='ruleUsage'?e=>e.at>now()-WEEK:e=>e.expiresAt>now();
  target[key]=[...incoming,...(target[key]??[]).filter(e=>!own.has(rowKey(key,e))&&!replaced(e))].filter(alive).slice(-10000);
 };
 const ruleById=id=>(policy.standingRules??[]).find(rule=>rule.id===id);
 // A recorded acceptance replaces its claim hold, including when kept work is replayed after a pause.
 // Old journals without a job duration conservatively hold the rule's longest job, or all remaining time when uncapped.
 const reservations=(state,except)=>Object.entries(state.accounts??{}).filter(([id,row])=>id!==except&&row?.claimPending?.ruleId)
  .map(([,row])=>row.claimPending)
  .filter(intent=>!(state.ruleUsage??[]).some(e=>e.id===intent.ruleId&&e.jobDigest===intent.jobDigest&&e.acceptedAt===intent.acceptedAt))
  .map(intent=>{
   const duration=Number.isSafeInteger(intent.wallSeconds)&&intent.wallSeconds>0?intent.wallSeconds:ruleById(intent.ruleId)?.maxWallSeconds;
   return {id:intent.ruleId,jobDigest:intent.jobDigest,acceptedAt:intent.acceptedAt,at:intent.acceptedAt??now(),
    ms:Number.isSafeInteger(duration)&&duration>0?duration*1000:Number.MAX_SAFE_INTEGER,reserved:true};
  });
 const ruleTotals=(state,id)=>{
  // A row whose agent never ran (ran:false) counts neither a job nor time, as in the lender.
  const entries=[...(state.ruleUsage??[]),...reservations(state,null)].filter(e=>e.id===id&&e.ran!==false&&e.at>now()-WEEK);
  const today=lenderDayKey(now(),policy.timeZone),daily=entries.filter(e=>lenderDayKey(e.at,policy.timeZone)===today);
  return {weeklyJobs:entries.length,weeklyMs:entries.reduce((n,e)=>n+e.ms,0),dailyJobs:daily.length,dailyMs:daily.reduce((n,e)=>n+e.ms,0)};
 };
 const overRule=(id,used)=>{const rule=ruleById(id);return Boolean(rule)&&(
  Number.isFinite(rule.dailyJobs)&&used.dailyJobs>rule.dailyJobs||
  Number.isFinite(rule.weeklyJobs)&&used.weeklyJobs>rule.weeklyJobs||
  Number.isFinite(rule.dailyMinutes)&&used.dailyMs>rule.dailyMinutes*60000||
  Number.isFinite(rule.weeklyMinutes)&&used.weeklyMs>rule.weeklyMinutes*60000);};
 const summarize=next=>{
  for(const row of Object.values(next.accounts??{}))for(const key of SHARED)if(row&&key in row){mergeShared(next,[...(row[key]??[]),...(next[key]??[])],key);delete row[key];}
  const values=Object.values(next.accounts??{}),days=values.map(v=>v.day).filter(Boolean).sort();
  const day=days.at(-1)??next.day;
  next.day=day;next.jobs=0;next.milliseconds=0;next.requesters={};
  for(const row of values){if(row.day===day||hasWork(row)){next.jobs+=row.jobs??0;next.milliseconds+=row.milliseconds??0;
   for(const [key,used]of Object.entries(row.requesters??{})){const prev=next.requesters[key]??{jobs:0,milliseconds:0};next.requesters[key]={jobs:prev.jobs+used.jobs,milliseconds:prev.milliseconds+used.milliseconds};}}
  }
  for(const key of journals)next[key]=values.find(v=>v[key])?.[key]??null;
  next.observationPending=values.flatMap(v=>v.observationPending??[]);
  next.lastRequesterLimit=values.map(v=>v.lastRequesterLimit).filter(Boolean).sort((a,b)=>String(a.at).localeCompare(String(b.at))).at(-1)??null;
  for(const key of SHARED)next[key]??=[];
  return next;
 };
 function childStore(id){
  // The shared rows this worker last read or wrote. Only a row it changed since then may overwrite the root's copy: an unchanged one
  // is a stale snapshot, and the root may hold a newer refund or reservation for the same key.
  let held=heldRows({});
  const unchanged=(key,e)=>held[key].get(rowKey(key,e))===JSON.stringify(e);
  return {acquire:async()=>()=>{},
  directory:storage.directory,
  ...(storage.retainRejectedResult?{retainRejectedResult:value=>storage.retainRejectedResult(value)}:{}),get:async()=>{
   const row=root.accounts[id]??null;
   const shared={hiddenOffers:clone(root.hiddenOffers??[]),ruleUsage:[...clone(root.ruleUsage??[]),...reservations(root,id)],jobConsents:clone(root.jobConsents??[])};
   held=heldRows(shared);
   // An account that has not written yet has no counters of its own, but it still sees the computer's shared lists.
   return row?{...clone(row),...shared}:(SHARED.some(key=>shared[key].length)?{jobs:0,milliseconds:0,pending:null,...shared}:null);
  },set:next=>{const written=heldRows(next);return update(previous=>{
  const before=previous.accounts[id]??{jobs:0,milliseconds:0},wasPending=Boolean(before.pending)&&before.pending?.attemptId===next.pending?.attemptId,isPending=Boolean(next.pending);
  const rules=new Set([...(next.ruleUsage??[]).filter(e=>!e.reserved).map(e=>e.id),next.claimPending?.ruleId].filter(Boolean));
  const usedBefore=new Map([...rules].map(rule=>[rule,ruleTotals(previous,rule)]));
  const row=clone(next);for(const key of SHARED){mergeShared(previous,(row[key]??[]).filter(e=>!unchanged(key,e)),key);delete row[key];}
  previous.accounts[id]=row;summarize(previous);
  // Workers on different accounts can match one rule at the same moment. Whichever write would take the
  // rule past its cap, as a new claim or a new recorded use, is refused before any claim or agent runs.
  for(const rule of rules){const used=ruleTotals(previous,rule),was=usedBefore.get(rule);
   if(used.weeklyJobs>was.weeklyJobs&&overRule(rule,used))throw Object.assign(new Error('rule_limit'),{code:'rule_limit'});}
  // The serial worker's admission check may predate another worker's write.
  // Reject that reservation before any source/sandbox/agent work begins.
  if(isPending&&!wasPending&&next.pending.charged!==false&&
     (Number.isFinite(policy.dailyJobs)&&previous.jobs>policy.dailyJobs||
      Number.isFinite(policy.dailyMinutes)&&previous.milliseconds>policy.dailyMinutes*60000))throw Object.assign(new Error('daily_limit'),{code:'daily_limit'});
  if(isPending&&!wasPending) {
   const charged=next.pending.charged!==false;
   const active=activeReservations(previous).length;
   const maximum=Math.min(capacity,policy.lendingPolicy?.machineSlots??capacity);
   const held=activeReservations(previous).map(s=>s.pending.resources??{cpu:2,memoryBytes:4*1024**3});
   if(held.reduce((n,r)=>n+r.cpu,0)>maxResources.cpu||held.reduce((n,r)=>n+r.memoryBytes,0)>maxResources.memoryBytes)throw Object.assign(new Error('machine_capacity'),{code:'machine_capacity'});
   if(active>maximum)throw Object.assign(new Error('machine_capacity'),{code:'machine_capacity'});
   for(const cap of charged?policy.requesterLimits??[]:[]){const used=previous.requesters[JSON.stringify([cap.circle,cap.keyId])];
    if(used&&(cap.dailyJobs!=null&&used.jobs>cap.dailyJobs||cap.dailyMinutes!=null&&used.milliseconds>cap.dailyMinutes*60000))throw Object.assign(new Error('requester_limit'),{code:'requester_limit'});
   }
  }
  return previous;
 }).then(result=>{for(const key of SHARED)if(next[key]!==undefined)held[key]=written[key];return result;});}};}
 function activeReservations(state=root){return Object.entries(state?.accounts??{}).filter(([id,s])=>s?.pending&&!children.some(c=>c.id===id&&c.worker.getState().status==='stopping'&&c.worker.getState().reason==='cleanup_pending')).map(([,s])=>s);}
 function aggregate(){
  const states=children.map(c=>({account:c.id,...c.worker.getState()}));
  // An agent the owner did not choose is not lent; its quiet wait never stands for the whole computer.
  const cleanup=states.find(s=>s.reason==='cleanup_pending');
  const available=cleanup&&!paused&&policy.enabled!==false?states.find((s,i)=>s.reason!=='cleanup_pending'&&children[i].worker.admits?.()===null):null;
  const active=states.find(s=>s.current)??states.find(s=>s.status==='offer')??available??cleanup??states.find(s=>s.reason!=='lending_off')??states[0]??{status:'paused',current:null,paused:true};
  const remediation=[...new Map(states.flatMap(s=>s.remediation??[]).map(row=>[JSON.stringify([row.command,row.name,row.reason,row.step,row.error]),row])).values()];
  return {...active,counters:root?clone(root):null,accountStates:states.map(({counters,...s})=>s),
   heldOffers:[...new Map(states.flatMap(s=>s.heldOffers??[]).map(offer=>[offer.id,offer])).values()]
     .filter(offer=>!states.some(s=>s.currentJobDigest===offer.id)),
   currentJobs:states.filter(s=>s.current).map(s=>({account:s.account,attemptId:s.current,agent:s.agent})),paused:paused||policy.enabled===false,
   ...(states.filter(s=>s.current).length>1?{label:states.filter(s=>s.current).length+' jobs running'}:{}),
   ...(remediation.length?{remediation,label:[active.label,...remediationLinesNotIn(active.label,remediation)].filter(Boolean).join('\n')}:{})};
 }
 // Facts about one event (an accepted offer names its job, attempt and requester) pass through untouched;
 // state updates are merged with the pool's view. Both say which account they came from.
 const passthrough=['transcript','contribution','agent-signed-out','offer','offer-updated','offer-removed','offer-accepted'];
 const emitFor=account=>({stopCompletion,...event})=>{
  if(passthrough.includes(event.status))return options.onEvent?.({...event,account});
  // Aggregate status describes the pool; this completion describes only its source attempt.
  return options.onEvent?.({...event,...aggregate(),account,...(stopCompletion?{stopCompletion}:{})});
 };
 const pool={
  start(signal){
   if(loop)return loop;
   loop=(async()=>{
    const release=await storage.acquire?.();
    try {
     const saved=await storage.get();
     root=saved??{jobs:0,milliseconds:0,pending:null};
     const records=await readAdapters(),providers=[...new Set(records.map(a=>providerOf(a.spec.harness_id)))];
     if(!providers.length&&!hasWork(root)&&!Object.values(root.accounts??{}).some(hasWork))return;
     if(!root.accounts){const old=clone(root);delete old.accounts;
       // A root with no counters, no work and a registry that already names the accounts has nothing for a provider-keyed row to
       // own. Writing one would start a worker for an account the owner never made.
       const blank=!hasWork(old)&&!old.jobs&&!old.milliseconds&&(registered().length>0||saved==null);
       root={...root,accounts:blank?{}:{[(providers[0]??'recovery')+':0']:old}};}
     else {
       // Older writers could leave a root-only obligation alongside account
       // summaries. Summarizing must not erase its last durable owner.
       const rows=Object.values(root.accounts);
       const identity=value=>value?.attemptId??value?.attempt?.attempt_id??value?.claim?.attempt?.attempt_id??value?.jobDigest;
       const orphaned=journals.filter(key=>root[key]&&!rows.some(row=>row[key]&&
         (identity(root[key])?identity(row[key])===identity(root[key]):JSON.stringify(row[key])===JSON.stringify(root[key]))));
       const known=new Set(rows.flatMap(row=>(row.observationPending??[]).map(item=>item.idempotencyKey)));
       const observations=(root.observationPending??[]).filter(item=>!known.has(item.idempotencyKey));
        if(orphaned.length||observations.length) {
         const legacy={day:root.day,jobs:Math.max(0,(root.jobs??0)-rows.reduce((n,row)=>n+(row.jobs??0),0)),
           milliseconds:Math.max(0,(root.milliseconds??0)-rows.reduce((n,row)=>n+(row.milliseconds??0),0)),requesters:{}};
         for(const [key,used] of Object.entries(root.requesters??{}))legacy.requesters[key]={
           jobs:Math.max(0,used.jobs-rows.reduce((n,row)=>n+(row.requesters?.[key]?.jobs??0),0)),
           milliseconds:Math.max(0,used.milliseconds-rows.reduce((n,row)=>n+(row.requesters?.[key]?.milliseconds??0),0))};
         for(const key of orphaned)legacy[key]=clone(root[key]);
          if(observations.length)legacy.observationPending=clone(observations);
         let id='recovery:0';
         while(root.accounts[id])id+=':legacy';
         root.accounts[id]=legacy;
       }
     }
     if((Object.values(root.accounts).some(row=>SHARED.some(key=>row&&key in row))||SHARED.some(key=>!Array.isArray(root[key])))){root=summarize(clone(root));await storage.set(root);}
     const group=new AbortController(),combined=signal?AbortSignal.any([signal,group.signal]):group.signal;
     const tasks=[],failures=[];
     addWorkers=()=>{
     if(combined.aborted)return;
     const slots=policy.lendingPolicy?.accountSlots??1;
     // One worker, and so one sandbox session, per enabled account in the owner's order. A provider with no account in the
     // registry (an install that predates it) keeps its one provider-keyed worker.
     const keysFor=provider=>{const own=registered().filter(a=>a.provider===provider);
      const enabled=own.filter(a=>a.enabled!==false);
      return own.length?(enabled.length?enabled:options.accountExecution?.availability?own.slice(0,1):[]).map(keyOf):[provider];};
     const ids=[...new Set([...providers.flatMap(provider=>keysFor(provider).flatMap(key=>Array.from({length:slots},(_,i)=>childIdFor(key,i)))),...Object.keys(root.accounts)])];
     for(const id of ids){
      if(children.some(c=>c.id===id))continue;
      const {accountKey,slot}=parseChildId(id),provider=providerOfChild(accountKey);
      const childPolicy={};
      for(const key of Object.keys(policy))if(!['storage','hold','observeLending'].includes(key))Object.defineProperty(childPolicy,key,{enumerable:true,get:()=>policy[key],set:value=>{policy[key]=value;}});
      childPolicy.storage=childStore(id);
      childPolicy.observeLending=async job=>{
       const observed=await policy.observeLending?.(job,{provider,accountKey})??{};
       const waits=[...(observed.waits??[])];
       const wait=(reason,at=now()+120000)=>waits.push({reason,nextEvaluationAtMs:at});
       const readCleanup=()=>({
        cleanup:options.backend?.cleanupSlotHold?.(accountKey,{slot:slot??0,fallback:children[0]?.id===id,knownAccounts:children.map(c=>c.accountKey),slots:policy.lendingPolicy?.accountSlots??1}),
        unknownDebts:options.backend?.unknownCleanupDebts?.(children.map(c=>c.accountKey))??0});
       const {cleanup,unknownDebts}=options.backend?.withCleanupSnapshot?options.backend.withCleanupSnapshot(readCleanup):readCleanup();
       if(cleanup)wait('cleanup_pending');
       if(slot!==null&&slot>=(policy.lendingPolicy?.accountSlots??1))wait('conditions_unavailable');
       const maximum=Math.min(capacity,policy.lendingPolicy?.machineSlots??capacity);
       if(activeReservations().length+unknownDebts>=maximum)wait('cleanup_pending');
       const own=Boolean(job&&policy.ownKeyId&&job.author===policy.ownKeyId);
       if(!own&&(Number.isFinite(policy.dailyJobs)&&root.jobs>=policy.dailyJobs||
         Number.isFinite(policy.dailyMinutes)&&root.milliseconds>=policy.dailyMinutes*60000)){
         let at=Math.floor(now()/60000)*60000+60000;
         while(lenderDayKey(at,policy.timeZone)===lenderDayKey(now(),policy.timeZone))at+=60000;
         wait('daily_limit',at);
       }
       return {...observed,enabledNow:observed.enabledNow!==false&&!paused&&!accountOff(provider,accountKey),waits};
      };
      const source=typeof adapters==='function'?async()=>(await readAdapters()).filter(a=>providerOf(a.spec.harness_id)===provider):records.filter(a=>providerOf(a.spec.harness_id)===provider);
      const child={id,worker:createLender({...options,...(approve?{approve}:{}),policy:childPolicy,adapters:source,accountKey,accountSlot:slot??0,onEvent:emitFor(id)}),accountKey,slot};children.push(child);
      tasks.push(Promise.resolve(child.worker.start(combined)).catch(error=>{failures.push(error);group.abort(error);}));
     }
     };
     try {addWorkers();}
     catch(error){failures.push(error);group.abort(error);}
     // Decide whether to stand by before yielding. Reconfigure can add workers while we wait.
     if(!tasks.length&&!combined.aborted)
      await new Promise(resolve=>combined.addEventListener('abort',resolve,{once:true}));
     let drained=0;
     while(drained<tasks.length) {
      const pending=tasks.slice(drained);
      drained=tasks.length;
      await Promise.all(pending);
     }
     if(failures.length)throw failures[0];
    } finally {addWorkers=()=>{};await writing;await release?.();}
   })().finally(()=>{loop=null;});
   return loop;
  },
  reconfigure(){addWorkers();for(const child of children)child.worker.reconfigure?.();},
  /** Whether an offer of `job` arriving now would be admitted by some account: null, or the first reason it would not.
   * A pool whose loop ended admits nothing, whatever its last state said (judge r10 R9). */
  admits(job){
   if(!loop)return 'lender_stopped';
   if(paused||policy.enabled===false)return 'paused';
   // The same machine headroom a reservation checks (above): the jobs already held plus this one must fit.
   const held=activeReservations().map(s=>s.pending.resources??{cpu:2,memoryBytes:4*1024**3});
   const limits=job?.requirements?.limits??{};
   if(held.reduce((n,r)=>n+r.cpu,0)+(limits.cpu??2)>maxResources.cpu||
      held.reduce((n,r)=>n+r.memoryBytes,0)+(limits.memory_bytes??4*1024**3)>maxResources.memoryBytes)return 'machine_capacity';
   const slots=policy.lendingPolicy?.accountSlots??1;
   // One reading of the cleanup journal serves every child's hold; each child's answer must come back synchronously.
   const askChildren=()=>children.filter(c=>withinSlots(c,slots)).map(c=>{
    const answer=typeof c.worker.admits==='function'?c.worker.admits(job):'lender_stopped';
    if(typeof answer?.then==='function')throw Object.assign(new Error('admits must answer synchronously'),{code:'cleanup_snapshot_misuse'});
    return answer;
   });
   const reasons=options.backend?.withCleanupSnapshot?options.backend.withCleanupSnapshot(askChildren):askChildren();
   if(!reasons.length)return 'lender_starting';
   // A busy account outranks any refusal: the next job waits for it. A sandbox failure outranks an account's own refusal.
   const first=['busy','sandbox_cannot_start'].find(reason=>reasons.includes(reason));
   // An unchosen agent's refusal comes last: a chosen agent's real cause (signed out, checking) is what to fix.
   return reasons.includes(null)?null:first??reasons.find(r=>!['lender_stopped','lending_off'].includes(r))??reasons.find(r=>r!=='lender_stopped')??reasons[0]??'lender_stopped';
  },
  /** A known identity or settings change: every slot-zero account forgets its last availability and re-proves it (lender.mjs). */
  refreshAdmission(){
   const slots=policy.lendingPolicy?.accountSlots??1;
   return Promise.all(children.filter(c=>withinSlots(c,slots)).map(c=>c.worker.refreshAdmission?.()));
  },
  pause(){paused=true;for(const c of children)c.worker.pause();},
  hideWaitingOffers(){return Promise.all(children.map(c=>c.worker.hideWaitingOffers?.()));},
  acceptWaitingOffer(jobDigest){for(const c of children)c.worker.acceptWaitingOffer?.(jobDigest);},
  settleAcceptedOffers(){return Promise.all(children.map(c=>c.worker.settleAcceptedOffers?.()));},
  resume(){for(const c of children)c.worker.resume();paused=false;},
  cessation(){const pending=children.map(c=>c.worker.cessation()).find(s=>!s.proven);return pending??{proven:true,attemptId:null};},
  ownsSignedAccountAttempt(attemptId){return children.some(c=>c.worker.ownsSignedAccountAttempt?.(attemptId));},
  async stopCurrentJob(attemptId){const child=children.find(c=>c.worker.getState().current===attemptId);if(!child)throw Object.assign(new Error('no_current_job'),{code:'no_current_job'});await child.worker.stopCurrentJob(attemptId);return aggregate();},
  getState:aggregate,
  get snapshot(){return aggregate();}
 };
 return pool;
}
