import {mkdir, open, readFile, rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {isDeepStrictEqual} from 'node:util';
import {tryLockAsync} from '../os-lock.mjs';

const clone = structuredClone;
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const ok = value => ({ok:true,value});
const fail = (code,accountId) => ({ok:false,error:{code,retryAtMs:null,
  nextAction:{id:'reconcile_attempt',label:'Check this attempt',target:accountId ? {accountId} : {}}}});
const rejected = code => ({kind:'rejected',code});
const safe = n => Number.isSafeInteger(n) && n >= 0;
const coordinate = r => JSON.stringify([r.unit,r.id,r.instance]);

// One short cross-process transaction protects the ledger and operation results together.
// The kernel releases this lock after a crash; never steal a live lock by age.
function storage(directory) {
  async function transaction(fn) {
    await mkdir(directory,{recursive:true,mode:0o700});
    const lock = join(directory,'writer.lock');
    let acquired;
    for (let n=0;n<1000;n++) {
      acquired=await tryLockAsync(lock);if(acquired)break;await delay(5);
    }
    if (!acquired) throw new Error('journal_locked');
    try {
      let data;
      try {data=JSON.parse(await readFile(join(directory,'lending.json'),'utf8'));}
      catch(e) {if(e.code!=='ENOENT') throw e; data={schemaVersion:1,accounts:{},launches:{},offers:{}};}
      const result = await fn(data);
      const temp = join(directory,randomUUID()+'.tmp');
      const file = await open(temp,'wx',0o600);
      try {await file.writeFile(JSON.stringify(data)); await file.sync();} finally {await file.close();}
      if(!acquired.held())throw new Error('journal_lock_lost');
      await rename(temp,join(directory,'lending.json'));
      const dir = await open(directory,'r');
      try {await dir.sync();} finally {await dir.close();}
      return clone(result);
    } finally {acquired.release();}
  }
  return {transaction};
}
const emptyAccount = id => ({schemaVersion:1,revision:0,accountId:id,resources:[],attempts:[],operations:{}});
function account(data,id) {
  if (typeof id !== 'string' || !id || ['__proto__','constructor','prototype'].includes(id)) throw new TypeError('invalid account');
  return data.accounts[id] ??= emptyAccount(id);
}
function amountRows(amount) {
  if (!['native','window_micro_points'].includes(amount?.unit) || !Array.isArray(amount.byResource) ||
      amount.unit==='native' && !amount.nativeUnit) throw new TypeError('invalid amount');
  const rows=amount.byResource.map(r=>({...r,unit:amount.unit==='native' ? amount.nativeUnit : amount.unit}));
  if (!rows.length || rows.some(r=>!r.id || !safe(r.amount) || r.amount===0 || !(r.instance===null || typeof r.instance==='string')) ||
      new Set(rows.map(coordinate)).size!==rows.length) throw new TypeError('invalid amount');
  return rows;
}
export function createLendingLedger({journal,settings,nativeUnits=[],usageSource}) {
  const db=storage(journal.directory);
  const write = (name,input,fn) => db.transaction(async data=>{
    const a=account(data,input.accountId), key=input.operationId, payload=hash({name,input});
    if (!key) return rejected('operation_conflict');
    if (a.operations[key]) return a.operations[key].payload===payload
      ? {...a.operations[key].result,kind:a.operations[key].result.kind==='applied'?'replay':a.operations[key].result.kind}
      : rejected('operation_conflict');
    const before=clone(a);
    const result=await fn(a,data);
    if(result.kind==='rejected' || result.kind==='conflict') Object.assign(a,before);
    a.operations[key]={payload,result};
    return result;
  });
  const find=(a,i)=>a.attempts.find(t=>t.reservationId===i.reservationId);
  return {
    snapshot:id=>db.transaction(data=>{const {operations,...snapshot}=account(data,id);return snapshot;}),
    compareAndReserve:i=>write('reserve',i,async a=>{
      if ((await settings()).revision!==i.settingsRevision) return {kind:'conflict',code:'settings_conflict',revision:a.revision};
      if (a.revision!==i.expectedRevision) return {kind:'conflict',code:'ledger_conflict',revision:a.revision};
      if (i.receipt.accountId!==i.accountId || i.receipt.quotedLedgerRevision!==i.expectedRevision ||
          i.receipt.settingsRevision!==i.settingsRevision || !isDeepStrictEqual(i.receipt.amount,i.enforcement.amount) ||
          a.attempts.some(t=>t.attemptId===i.receipt.attemptId || t.jobId===i.receipt.jobId && t.state!=='ceased'))
        return rejected('invalid_transition');
      const rows=amountRows(i.receipt.amount), reservationId=randomUUID();
      if(i.receipt.amount.unit==='native' && !nativeUnits.some(u=>u.id===i.receipt.amount.nativeUnit && safe(u.scale) && u.scale>0))
        return rejected('invalid_transition');
      for(const row of rows) {
        let r=a.resources.find(r=>coordinate(r)===coordinate(row));
        if(!r) {r={id:row.id,instance:row.instance,unit:row.unit,consumed:0,reserved:0,unrepresented:0};a.resources.push(r);}
        if(!safe(r.reserved+row.amount)) throw new TypeError('ledger overflow');
        r.reserved+=row.amount;
      }
      a.attempts.push({attemptId:i.receipt.attemptId,jobId:i.receipt.jobId,state:'prepared',reservationId,
        resources:rows.map(({amount,...r})=>({...r,remaining:amount})),events:{}});
      return {kind:'applied',value:{reservationId},revision:++a.revision};
    }),
    commitStart:i=>write('start',i,a=>{
      const t=find(a,i); if(!t || t.state==='ceased') return rejected('invalid_transition');
      t.state='started';return {kind:'applied',value:null,revision:++a.revision};
    }),
    release:i=>write('release',i,(a,data)=>{
      const t=find(a,i);if(!t) return rejected('invalid_transition');
      if(!['never_started','verified'].includes(i.cessation?.kind) || !safe(i.cessation.atMs)) return rejected('cessation_unverified');
      if(i.cessation.kind==='never_started' && t.state!=='prepared' && t.state!=='ceased') return rejected('cessation_unverified');
      if(i.cessation.kind==='never_started' && Object.values(data.launches).some(r=>r.reservationId===i.reservationId && (r.dispatched || r.preparing || r.backendPending)))
        return rejected('cessation_unverified');
      for(const row of t.resources) {const r=a.resources.find(r=>coordinate(r)===coordinate(row));r.reserved-=row.remaining;row.remaining=0;}
      if(a.resources.some(r=>![r.reserved,r.consumed,r.unrepresented].every(safe))) return rejected('invalid_transition');
      t.state='ceased';return {kind:'applied',value:null,revision:++a.revision};
    }),
    settle:i=>write('settle',i,(a,data)=>{
      const t=find(a,i);
      if(!t || i.usage.accountId!==i.accountId || !safe(i.cessationAtMs)) return rejected('invalid_transition');
      if(Object.values(data.launches).some(r=>r.reservationId===i.reservationId && r.dispatched && !safe(r.ceasedAtMs)))
        return rejected('cessation_unverified');
      // A supplies durable normalized events. Cumulative native values are differenced by epoch;
      // windowDebits are cumulative within that epoch as well, never across window instances.
      const normalized=usageSource?.(i.accountId);
      const producerBound=normalized?.accountId===i.accountId&&i.usage.jobReadings.every(event=>
        normalized.jobReadings.some(known=>known.eventId===event.eventId&&hash(known)===hash(event)));
      for(const event of i.usage.jobReadings.filter(e=>e.attemptId===t.attemptId)) {
        if(event.accountId!==i.accountId) return rejected('invalid_transition');
        if(Object.hasOwn(t.events,event.eventId)) {if(t.events[event.eventId]!==hash(event)) return rejected('operation_conflict');continue;}
        if(!['cumulative','delta'].includes(event.semantics) || !safe(event.sequence)) return rejected('invalid_transition');
        t.sequences ??= {};
        const last=t.sequences[event.meterEpoch]??0;
        if(!producerBound && event.semantics==='delta' && event.sequence!==last+1) return rejected('invalid_transition');
        if(event.sequence<=last) continue;
        t.totals ??= {};
        const debits=[...event.windowDebits.map(r=>({...r,unit:'window_micro_points',value:r.micro})),
          ...t.resources.filter(r=>r.unit===event.amount.unit && r.unit!=='window_micro_points')
            .map(r=>({...r,value:event.amount.value}))];
        for(const d of debits) {
          if(!safe(d.value)) return rejected('invalid_transition');
          const row=t.resources.find(r=>coordinate(r)===coordinate(d));if(!row) continue;
          const k=JSON.stringify([event.meterEpoch,coordinate(d)]), previous=t.totals[k]??0;
          if(event.semantics==='cumulative' && d.value<previous) return rejected('invalid_transition');
          const debit=event.semantics==='delta'?d.value:d.value-previous;
          t.totals[k]=previous+debit;
          // Attribute each increment, not the latest cumulative total, to its proof boundary.
          // Old journals without attribution retain their debt conservatively.
          t.debits ??= [];
          t.debits.push({meterEpoch:event.meterEpoch,sequence:event.sequence,
            coordinate:coordinate(d),amount:debit,covered:false});
          const r=a.resources.find(r=>coordinate(r)===coordinate(row));
          const represented=Math.min(debit,row.remaining);row.remaining-=represented;r.reserved-=represented;
          r.consumed+=debit;r.unrepresented+=debit;
        }
        t.events[event.eventId]=hash(event);
        t.sequences[event.meterEpoch]=event.sequence;
      }
      if(a.resources.some(row=>![row.reserved,row.consumed,row.unrepresented].every(safe)))return rejected('invalid_transition');
      const coverage=i.usage.reading?.coverage;
      if(coverage?.kind==='proven') {
        // Drop only this attempt's debt with a covering watermark, in matching window instances.
        const watermark=coverage.throughSequenceByAttempt[t.attemptId];
        const events=i.usage.jobReadings.filter(e=>e.attemptId===t.attemptId);
        if(safe(watermark) && events.length && events.every(e=>
          e.sequence<=watermark && t.events[e.eventId]===hash(e))) {
          // Sequence numbers restart with a meter epoch. A batch only proves its own epochs;
          // a watermark for epoch A must not clear an equally numbered debit from epoch B.
          const epochs=new Set(events.map(e=>e.meterEpoch));
          for(const row of t.resources) {
            if(row.unit!=='window_micro_points' ||
                !i.usage.reading.windows.some(w=>w.id===row.id && w.instance===row.instance)) continue;
            const r=a.resources.find(r=>coordinate(r)===coordinate(row));
            for(const debit of t.debits??[]) {
              if(debit.covered || debit.coordinate!==coordinate(row) ||
                  !epochs.has(debit.meterEpoch) || debit.sequence>watermark) continue;
              if(debit.amount>r.unrepresented)return rejected('invalid_transition');
              r.unrepresented-=debit.amount;debit.covered=true;
            }
          }
        }
      }
      // A Stop/EOF is not final usage. Only a proven attempt watermark,
      // after the declared posting horizon and in this exact resource instance,
      // can release the unused remainder. Unknown coordinates stay reserved.
      const reading=i.usage.reading,events=i.usage.jobReadings.filter(e=>e.attemptId===t.attemptId);
      const final=reading?.accountId===i.accountId&&safe(reading.postingUncertaintyMs)&&
        safe(reading.observedAtMs)&&safe(reading.receivedAtMs)&&reading.receivedAtMs>=reading.observedAtMs&&
        reading.observedAtMs>=i.cessationAtMs+reading.postingUncertaintyMs&&
        coverage?.kind==='proven'&&safe(coverage.throughSequenceByAttempt[t.attemptId])&&events.length>0&&
        events.every(e=>e.sequence<=coverage.throughSequenceByAttempt[t.attemptId]&&t.events[e.eventId]===hash(e));
      if(final)for(const row of t.resources) {
        // Epochs absent from this batch keep their debt and reservation.
        const epochs=Object.keys(t.sequences??{});
        const allEpochs=epochs.every(epoch=>events.some(e=>e.meterEpoch===epoch&&e.sequence===t.sequences[epoch]));
        const measured=row.unit==='window_micro_points'&&row.instance!==null&&
          reading.windows.some(w=>w.id===row.id&&w.instance===row.instance)&&
          events.some(e=>e.windowDebits.some(w=>w.id===row.id&&w.instance===row.instance));
        if(!allEpochs||!measured)continue;
        const r=a.resources.find(r=>coordinate(r)===coordinate(row));r.reserved-=row.remaining;row.remaining=0;
      }
      t.state=t.resources.every(row=>row.remaining===0)?'ceased':'settling';
      return {kind:'applied',value:null,revision:++a.revision};
    }),
  };
}

export function createLendingLaunch({ledger,broker,providers,backend,coordinator,settings,journal,clock}) {
  const db=storage(journal.directory), now=()=>typeof clock==='function'?clock():clock.now();
  const update=(id,fn)=>db.transaction(data=>fn(data.launches[id],data));
  const read=id=>update(id,r=>r);
  const finishRelease=async(r,reason,operationId)=>{
    // A persisted claim fences side effects through the final handle write. A crash may
    // strand this fence; without provider reconciliation it must never mean "released".
    if(r.preparing)return fail('preparation_pending');
    if(r.keyId)await broker.revokeJobKey(r.keyId);
    if(r.backendPending) {
      // A failed prepare may already own a native resource. Only its adapter
      // can reconcile the exact attempt; absence of an outer handle proves nothing.
      if(typeof backend.reconcilePreparation!=='function')return fail('preparation_uncertain');
      const cleanup=await backend.reconcilePreparation({attempt:r.attempt,operationId:operationId+'/prepare-cleanup'});
      if(!cleanup?.ok || cleanup.value?.kind!=='removed')return fail('preparation_uncertain');
      r=await update(r.attempt.attemptId,row=>{row.backendPending=false;row.preparationCleaned=true;return row;});
    }
    if(r.dispatched && !safe(r.ceasedAtMs)) return fail('cessation_unverified');
    if(r.dispatched)return fail('settlement_required');
    if(r.sandboxId) {const removed=await backend.remove({sandboxId:r.sandboxId,operationId:operationId+'/remove'});if(!removed.ok)return removed;}
    const released=await coordinator.release({attempt:r.attempt,operationId:operationId+'/release',reason});
    // A fence denies this generation; it does not confirm release/reclaim.
    // Retain the durable intent and reservation until a positive release receipt.
    if(!released?.ok || !['released','already_released'].includes(released.value?.kind)) return fail('authority_unavailable');
    if(r.reservationId) {
      const result=await ledger.release({accountId:r.selection.accountId,reservationId:r.reservationId,operationId:operationId+'/ledger',
        cessation:{kind:r.dispatched?'verified':'never_started',atMs:r.ceasedAtMs??r.releaseAtMs}});
      if(!['applied','replay'].includes(result.kind)) return fail(result.code);
    }
    await update(r.attempt.attemptId,(row,data)=>{
      row.state='released';
      const old=data.offers[r.attempt.jobId]??{failures:0};
      const setup=reason==='preparation_failed';
      const failures=old.failures+(setup?1:0);
      data.offers[r.attempt.jobId]={failures,consent:false,accepted:false,
        retryAtMs:now()+(setup?Math.min(300000*2**Math.min(failures-1,10),1800000):300000),
        needsEvaluation:true};
    });
    return ok({claimable:true});
  };
  async function preparationFailure(attemptId,result,operationId) {
    const r=await update(attemptId,row=>{row.preparing=false;row.prepareOutcome=result;row.releaseAtMs??=now();return row;});
    await finishRelease(r,'preparation_failed',operationId+'/failure');
    return result;
  }
  return {
    pending:()=>db.transaction(data=>Object.values(data.launches).filter(row=>row.state!=='released')),
    async settleUsage({attemptId,usage}) {
      const row=await read(attemptId);
      if(!row?.reservationId||!safe(row.ceasedAtMs))return fail('cessation_unverified');
      const operationId=attemptId+'/usage/'+hash({reading:usage.reading,jobReadings:usage.jobReadings,cessationAtMs:row.ceasedAtMs});
      const result=await ledger.settle({accountId:row.selection.accountId,reservationId:row.reservationId,
        operationId,usage,cessationAtMs:row.ceasedAtMs});
      return ['applied','replay'].includes(result.kind)?ok(null):fail(result.code);
    },
    async prepareLend(i) {
      await mkdir(journal.directory,{recursive:true,mode:0o700});
      const owner=await tryLockAsync(join(journal.directory,hash(i.attempt.attemptId)+'.prepare.lock'));
      if(!owner)return fail('preparation_pending');
      try {
      const {attempt,selection,receipt,enforcement,operationId,signal,job}=i;
      if(receipt.accountId!==selection.accountId || receipt.jobId!==attempt.jobId || receipt.attemptId!==attempt.attemptId ||
          !isDeepStrictEqual(receipt.amount,enforcement.amount)) return fail('job_binding_mismatch');
      const payload=hash({...i,signal:undefined});
      const initial=await update(attempt.attemptId,(r,data)=>{
        if(r) return r.payload===payload?r:{error:'operation_conflict'};
        if(Object.values(data.launches).some(r=>r.attempt.jobId===attempt.jobId && r.attempt.generation===attempt.generation && r.state!=='released'))
          return {error:'invalid_transition'};
        return data.launches[attempt.attemptId]={attempt,selection,receipt,enforcement,payload,state:'preparing',operationId};
      });
      if(initial.error)return fail(initial.error);
      if(initial.preparing&&initial.prepareOwnerProtocol===1){
        const orphan=await update(attempt.attemptId,row=>{row.preparing=false;row.backendPending=true;row.stopping=true;return row;});
        return await finishRelease(orphan,'preparation_failed',operationId+'/orphan');
      }
      if(initial.prepareOutcome)return initial.prepareOutcome;
      if(initial.prepared)return ok(initial.prepared);
      if(initial.state!=='preparing')return fail('invalid_transition');
      // Claim preparation once, including concurrent callers in different processes.
      const claimed=await update(attempt.attemptId,r=>{
        if(r.stopping || r.state!=='preparing')return 'invalid_transition';
        if(r.preparing)return 'preparation_pending';
        r.preparing=true;r.prepareOwnerProtocol=1;return null;
      });
      if(claimed)return fail(claimed);
      const reservation=await ledger.compareAndReserve({accountId:selection.accountId,expectedRevision:receipt.quotedLedgerRevision,
        settingsRevision:receipt.settingsRevision,operationId:operationId+'/reserve',receipt,enforcement});
      if(!['applied','replay'].includes(reservation.kind))return preparationFailure(attempt.attemptId,fail(reservation.code),operationId);
      const reservationId=reservation.value.reservationId;
      await update(attempt.attemptId,r=>Object.assign(r,{reservationId}));
      const key=await broker.issueJobKey({selection,jobId:attempt.jobId,attemptId:attempt.attemptId,leaseProof:attempt.leaseProof});
      if(!key.ok)return preparationFailure(attempt.attemptId,key,operationId);
      await update(attempt.attemptId,r=>Object.assign(r,{keyId:key.value.keyId}));
      const provider=providers.getProvider(selection.providerId);if(!provider.ok)return preparationFailure(attempt.attemptId,provider,operationId);
      const run=provider.value.makeRun({selection,jobKey:key.value.key,job:job??{id:attempt.jobId,selection},receipt,enforcement});
      if(!run.ok)return preparationFailure(attempt.attemptId,run,operationId);
      if(!isDeepStrictEqual(run.value.receipt,receipt)||!isDeepStrictEqual(run.value.enforcement,enforcement))
        return preparationFailure(attempt.attemptId,fail('job_binding_mismatch'),operationId);
      await update(attempt.attemptId,r=>{r.backendPending=true;});
      const sandbox=await backend.prepare({attempt,selection,signal,run:run.value});
      if(!sandbox.ok)return preparationFailure(attempt.attemptId,sandbox,operationId);
      await update(attempt.attemptId,r=>Object.assign(r,{sandboxId:sandbox.value.sandboxId,backendPending:false}));
      const prepared={schemaVersion:1,attemptId:attempt.attemptId,jobId:attempt.jobId,selection,receipt,enforcement,
        reservationId,reservationRevision:reservation.revision,leaseProof:attempt.leaseProof,keyId:key.value.keyId,run:run.value};
      const stopped=await update(attempt.attemptId,r=>{r.preparing=false;if(r.stopping)return true;r.prepared=prepared;r.state='prepared';return false;});
      if(stopped) {await finishRelease(await read(attempt.attemptId),'paused',operationId+'/abort');return fail('invalid_transition');}
      return ok(prepared);
      }finally{owner.release();}
    },
    async startLend({attemptId,operationId,signal}) {
      const r=await read(attemptId);if(!r)return fail('invalid_transition');
      if(r.startOperation && r.startOperation!==operationId)return fail('operation_conflict');
      if(r.dispatched)return r.outcome??ok({kind:'uncertain',atMs:r.dispatchAtMs});
      if(r.state!=='prepared' || r.stopping)return fail('invalid_transition');
      const authority=await coordinator.reconcile({attempt:r.attempt});
      if(!authority.ok || authority.value.kind!=='owned')return fail('lease_fenced');
      const renewed=await broker.renewJobKey({keyId:r.keyId,leaseProof:authority.value.leaseProof??r.attempt.leaseProof,forStart:true});
      if(!renewed.ok){
        if(['model_unavailable','effort_unavailable'].includes(renewed.error?.code))
          await this.releaseBeforeStart({attemptId,reason:'paused',operationId:operationId+'/catalog'});
        return renewed;
      }
      const dispatch=await update(attemptId,async row=>{
        if(row.startOperation && row.startOperation!==operationId)return fail('operation_conflict');
        if(row.dispatched)return row.outcome??ok({kind:'uncertain',atMs:row.dispatchAtMs});
        if(row.stopping || row.state!=='prepared')return fail('invalid_transition');
        // Integration must serialize settings writers on this same journal lock.
        // The frozen settings() reader must not recursively acquire it.
        if((await settings()).revision!==row.receipt.settingsRevision)return fail('settings_conflict');
        Object.assign(row,{dispatched:true,dispatchAtMs:now(),startOperation:operationId,state:'uncertain'});
        return null;
      });
      if(dispatch) {
        if(dispatch.error?.code==='settings_conflict')
          await this.releaseBeforeStart({attemptId,reason:'paused',operationId:operationId+'/settings'});
        return dispatch;
      }
      let result;
      try {result=await backend.start({sandboxId:r.sandboxId,run:r.prepared.run,operationId,signal});}
      catch {result=ok({kind:'uncertain',atMs:now()});}
      if(!result.ok)result=ok({kind:'uncertain',atMs:now()});
      if(result.value.kind==='started') {
        const committed=await ledger.commitStart({accountId:r.selection.accountId,reservationId:r.reservationId,operationId:operationId+'/commit',atMs:result.value.atMs});
        if(!['applied','replay'].includes(committed.kind))result=ok({kind:'uncertain',atMs:now()});
      }
      await update(attemptId,row=>{row.outcome=result;if(!row.stopping)row.state=result.value.kind;});return result;
    },
    async markAgentStarted({attemptId,atMs,operationId}) {
      const r=await read(attemptId);if(!r?.dispatched || r.stopping)return fail('invalid_transition');
      const result=await ledger.commitStart({accountId:r.selection.accountId,reservationId:r.reservationId,operationId,atMs});
      if(!['applied','replay'].includes(result.kind))return fail(result.code);
      await update(attemptId,row=>{row.state='started';});return ok(null);
    },
    async stopLend({attemptId,reason}) {
      const requestedAtMs=now();
      const r=await update(attemptId,row=>{if(!row)return null;row.stopping=true;row.stopRequestedAtMs??=requestedAtMs;return row;});
      if(!r)return {requestedAtMs,ceasedAtMs:null};
      const revoked=r.keyId?await broker.revokeJobKey(r.keyId):{aborted:[],unconfirmed:[]};
      // A preparation claim precedes the backend effect and final handle write.
      // No persisted handle is not evidence that a late create cannot occur.
      const stopped=r.sandboxId?await backend.stop({sandboxId:r.sandboxId,reason})
        :{ceasedAtMs:r.dispatched||r.preparing||r.backendPending?null:now()};
      const ceasedAtMs=Array.isArray(revoked?.aborted)&&Array.isArray(revoked?.unconfirmed)&&revoked.unconfirmed.length===0
        ?stopped.ceasedAtMs:null;
      await update(attemptId,row=>{row.ceasedAtMs=ceasedAtMs;});
      return {requestedAtMs:r.stopRequestedAtMs,ceasedAtMs};
    },
    async releaseBeforeStart({attemptId,reason,operationId}) {
      const r=await update(attemptId,row=>{
        if(!row)return null;
        if(row.releaseOperation && (row.releaseOperation!==operationId || row.releaseReason!==reason))return {error:'operation_conflict'};
        row.releaseOperation=operationId;row.releaseReason=reason;row.releaseAtMs??=now();row.stopping=true;return row;
      });
      if(!r)return fail('invalid_transition');if(r.error)return fail(r.error);
      if(r.state==='released')return ok({claimable:true});
      if(r.preparing){
        const owner=await tryLockAsync(join(journal.directory,hash(attemptId)+'.prepare.lock'));
        if(!owner)return fail('preparation_pending');
        try{
          if(r.prepareOwnerProtocol!==1)return fail('preparation_uncertain');
          const orphan=await update(attemptId,row=>{row.preparing=false;row.backendPending=true;return row;});
          return await finishRelease(orphan,reason,operationId);
        }finally{owner.release();}
      }
      return finishRelease(r,reason,operationId);
    },
    // Discovery calls this after a usable decision; this never shortens the persisted cooldown.
    async reoffer({jobId,decision}) {
      return db.transaction(data=>{
        const offer=data.offers[jobId];if(!offer)return {eligible:true,newConsentRequired:true};
        const usable=decision?.kind==='lend';
        if(usable)offer.needsEvaluation=false;
        return {eligible:usable && now()>=offer.retryAtMs,newConsentRequired:true,retryAtMs:offer.retryAtMs};
      });
    },
  };
}
