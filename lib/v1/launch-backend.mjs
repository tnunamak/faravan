import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

// Adapter-local lifecycle journal. Native handles, jobs, keys and RunSpecs are
// host-memory-only. Callers own a private directory and supply trusted registry
// recovery and RunSpec binding. No provider, broker or usage-reader is created.
const id=x=>typeof x==='string'&&x.length>0&&x.length<=1024;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const ok=value=>({ok:true,value});
const fault=code=>({ok:false,error:{code,retryAtMs:null,nextAction:{id:'reconcile_sandbox',label:'Reconcile sandbox state',target:{}}}});
const safeTime=x=>Number.isSafeInteger(x)&&x>=0;
const clone=x=>structuredClone(x);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function validAmount(value) {
  if(!value||!['window_micro_points','native'].includes(value.unit)||
    (value.unit==='native'&&!id(value.nativeUnit))||!Array.isArray(value.byResource)||!value.byResource.length)return false;
  const seen=new Set();
  return value.byResource.every(c=>{
    const key=JSON.stringify([c?.id,c?.instance]);
    if(!id(c?.id)||!(c.instance===null||id(c.instance))||!Number.isSafeInteger(c.amount)||c.amount<=0||seen.has(key))return false;
    seen.add(key);return true;
  });
}
function validateRun(run,row) {
  const r=run?.receipt,e=run?.enforcement;
  return run?.schemaVersion===1&&id(run.command)&&Array.isArray(run.args)&&run.args.every(x=>typeof x==='string')&&
    run.env&&typeof run.env==='object'&&!Array.isArray(run.env)&&Object.values(run.env).every(x=>typeof x==='string')&&
    run.proxy&&typeof run.proxy==='object'&&r?.schemaVersion===1&&r.accountId===row.accountId&&
    r.jobId===row.jobId&&r.attemptId===row.attemptId&&id(r.policyVersion)&&
    [r.quotedLedgerRevision,r.settingsRevision,r.evaluatedAtMs].every(safeTime)&&
    ['observed','aged','cold_pace'].includes(r.mode)&&validAmount(r.amount)&&same(r.amount,e?.amount)&&
    Number.isSafeInteger(e.wallLimitMs)&&e.wallLimitMs>0&&e.stopOnBudget===true&&
    ['measured','estimated'].includes(e.metering)&&Array.isArray(e.limitations)&&e.limitations.every(x=>typeof x==='string');
}
export function createLaunchBackend({backend,journalDirectory,resolveJob,bindRun,recoverHandle,clock=Date.now}={}) {
  const handles=new Map(),controllers=new Map();
  const configured=backend&&['prepare','start','cancel','destroy','inspect'].every(k=>typeof backend[k]==='function')&&
    [resolveJob,bindRun,recoverHandle,clock].every(x=>typeof x==='function')&&typeof journalDirectory==='string'&&path.isAbsolute(journalDirectory);
  const now=()=>{const value=clock();if(!safeTime(value))throw new Error('clock_invalid');return value;};
  function directory() {
    if(!configured)throw new Error('configuration_missing');
    fs.mkdirSync(journalDirectory,{recursive:true,mode:0o700});
    const info=fs.lstatSync(journalDirectory);
    if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0)throw new Error('journal_not_private');
  }
  const filename=key=>path.join(journalDirectory,key+'.json');
  function read(key) {
    directory();
    try { const record=JSON.parse(fs.readFileSync(filename(key),'utf8'));
      if(record.version!==1||hash(record.attemptId)!==key)throw new Error('journal_invalid');
      return record;
    } catch(error) {if(error.code==='ENOENT')return null;throw error;}
  }
  // Synchronous critical sections never include effects or await a slow read.
  // A stranded lock is a repair condition, never auto-stolen from a live writer.
  function edit(key,mutate) {
    directory();const lock=path.join(journalDirectory,key+'.lock');
    fs.mkdirSync(lock,{mode:0o700});
    let temp;
    try {
      const previous=read(key), next=mutate(previous);
      if(next===undefined)return previous;
      temp=path.join(journalDirectory,key+'.'+randomUUID()+'.tmp');
      const fd=fs.openSync(temp,'wx',0o600);
      try {fs.writeFileSync(fd,JSON.stringify(next));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fs.renameSync(temp,filename(key));temp=null;
      const dir=fs.openSync(journalDirectory,'r');
      try {fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
      return next;
    } finally {if(temp)try{fs.unlinkSync(temp);}catch{}fs.rmdirSync(lock);}
  }
  function find(sandboxId) {
    if(!id(sandboxId))return null;
    directory();
    let found=null;
    for(const file of fs.readdirSync(journalDirectory))if(/^[a-f0-9]{64}\.json$/.test(file)){
      const row=read(file.slice(0,-5));
      if(row.sandboxId===sandboxId){if(found)throw new Error('identity_ambiguous');found=row;}
    }
    return found;
  }
  function matches(h,row) {
    return h&&h.sandbox_id===row.sandboxId&&h.job_id===row.jobId&&id(row.incarnation)&&h._cleanupId===row.incarnation;
  }
  async function handleFor(row) {
    const key=hash(row.attemptId), cached=handles.get(key);
    if(matches(cached,row))return cached;
    // The registry callback must enforce attempt/operation ownership. An absent
    // observation is not proof of never-created or permission to recreate.
    const h=await recoverHandle({sandboxId:row.sandboxId,attemptId:row.attemptId,jobId:row.jobId,generation:row.generation,accountId:row.accountId,providerId:row.providerId,incarnation:row.incarnation,operationId:row.start?.operationId??null});
    if(!matches(h,row))return null;
    handles.set(key,h);return h;
  }
  function update(row,fn) {return edit(hash(row.attemptId),current=>{
    if(!current||current.sandboxId!==row.sandboxId||current.incarnation!==row.incarnation)throw new Error('identity_changed');
    return fn(current);
  });}
  async function cease(row,h) {
    // cancel's acknowledgement is not cessation evidence. Preserve output for
    // the host's handoff and leave destruction to remove (or late-create cleanup).
    try{await backend.cancel(h);}catch{}
    let observation;try{observation=await backend.inspect(h);}catch{return {ceasedAtMs:null};}
    if(observation?.job_id!==row.jobId||observation.status!=='exited'||(read(hash(row.attemptId)).start&&!read(hash(row.attemptId)).start.settled))return {ceasedAtMs:null};
    try {const saved=update(row,current=>({...current,ceasedAtMs:current.ceasedAtMs??now()}));
      return {ceasedAtMs:saved.ceasedAtMs};
    } catch{return {ceasedAtMs:null};}
  }
  async function destroy(row,h) {
    let receipt;try{receipt=await backend.destroy(h,{});}catch{return fault('cleanup_pending');}
    // No omitted flag becomes success. The existing backend keeps its own
    // output handoff and durable cleanup debt; never erase or bypass either.
    if(receipt?.job_id!==row.jobId||receipt?.sandbox_id!==row.sandboxId||
      receipt.removed!==true||receipt.scratch_removed!==true||receipt.policy_removed!==true||receipt.storage_removed!==true)
      return fault('cleanup_pending');
    try {update(row,current=>({...current,removed:true,ceasedAtMs:current.ceasedAtMs??now()}));return ok(undefined);}
    catch{return fault('persistence_failed');}
  }
  return Object.freeze({
    recordRemoval({handle,receipt}) {
      try{
        const row=find(handle?.sandbox_id);
        if(!row||!matches(handle,row)||receipt?.job_id!==row.jobId||receipt.sandbox_id!==row.sandboxId||
          receipt.removed!==true||receipt.scratch_removed!==true||receipt.policy_removed!==true||receipt.storage_removed!==true)
          return fault('cleanup_pending');
        const saved=update(row,current=>({...current,removed:true,ceasedAtMs:current.ceasedAtMs??now(),
          ...(current.start?{start:{...current.start,settled:true}}:{})}));
        return ok({ceasedAtMs:saved.ceasedAtMs});
      }catch{return fault('cleanup_pending');}
    },
    async prepare({attempt,selection,signal,run}={}) {
      let key,row,controller,abort;
      try {
        if(!configured)return fault('configuration_missing');
        if(!id(attempt?.attemptId)||!id(attempt?.jobId)||!safeTime(attempt.generation)||
          attempt.leaseProof?.schemaVersion!==1||!id(attempt.leaseProof?.signedEnvelope)||
          !id(selection?.accountId)||!id(selection.providerId)||!id(selection.modelId)||
          !(selection.effortId===null||id(selection.effortId)))return fault('invalid_prepare');
        signal?.throwIfAborted();
        const boundAttempt=clone(attempt),boundSelection=clone(selection);
        key=hash(boundAttempt.attemptId);
        const identity=hash({attempt:boundAttempt,selection:boundSelection});
        const existing=read(key);
        if(existing) {
          if(existing.identity!==identity)return fault('operation_conflict');
          if(existing.removed)return fault('stopped');
          if(existing.phase==='prepared')return existing.stopRequested?fault('stopped'):ok({sandboxId:existing.sandboxId});
          // Reconnect only an authoritative host registry association for this
          // exact attempt. Unknown/absent retains debt and never recreates.
          const recovered=await recoverHandle({sandboxId:existing.sandboxId,attemptId:existing.attemptId,jobId:existing.jobId,generation:existing.generation,accountId:existing.accountId,providerId:existing.providerId,incarnation:existing.incarnation,operationId:null,signal});
          if(!id(recovered?.sandbox_id)||recovered.job_id!==existing.jobId||!id(recovered._cleanupId))
            return fault('preparation_uncertain');
          const saved=edit(key,current=>{
            if(current.identity!==identity||current.phase!=='intent')throw new Error('recovery_conflict');
            return {...current,sandboxId:recovered.sandbox_id,incarnation:recovered._cleanupId,phase:'prepared'};
          });
          handles.set(key,recovered);
          if(saved.stopRequested){await cease(saved,recovered);await destroy(saved,recovered);return fault('stopped');}
          return ok({sandboxId:saved.sandboxId});
        }
        row=edit(key,current=>{
          if(current)throw new Error('operation_conflict');
          return {version:1,attemptId:boundAttempt.attemptId,jobId:boundAttempt.jobId,generation:boundAttempt.generation,
            accountId:boundSelection.accountId,providerId:boundSelection.providerId,identity,sandboxId:null,incarnation:null,
            phase:'intent',stopRequested:false,ceasedAtMs:null,removed:false};
        });
        controller=new AbortController();controllers.set(key,controller);
        abort=()=>{
          controller.abort();
          try{edit(key,current=>({...current,stopRequested:true}));}catch{/* intent remains unresolved */}
        };
        signal?.addEventListener('abort',abort,{once:true});
        if(signal?.aborted)abort();
        const job=await resolveJob({attempt:boundAttempt,selection:boundSelection,run,signal:controller.signal});
        if(job?.job_id!==row.jobId)return fault('job_binding_mismatch');
        if(controller.signal.aborted||read(key).stopRequested)return fault('stopped');
        // Intent is durable before this call. A rejection may follow creation;
        // the attempt is never implicitly retried.
        const h=await backend.prepare(job,{signal:controller.signal});
        if(!id(h?.sandbox_id)||h.job_id!==row.jobId||!id(h._cleanupId))return fault('prepare_identity_unverified');
        handles.set(key,h);
        try {row=edit(key,current=>({...current,sandboxId:h.sandbox_id,incarnation:h._cleanupId,phase:'prepared'}));}
        catch(error) {
          // Binding persistence can fail after a late create. Cancellation
          // still owns this returned native handle; the prior intent remains
          // for registry reconciliation and backend cleanup retains its debt.
          if(controller.signal.aborted) {
            try{await backend.cancel(h);}catch{}
            try{await backend.destroy(h,{});}catch{}
          }
          throw error;
        }
        if(controller.signal.aborted||row.stopRequested) {
          await cease(row,h);await destroy(row,h);return fault('stopped');
        }
        return ok({sandboxId:row.sandboxId});
      } catch{return fault('preparation_uncertain');}
      finally {signal?.removeEventListener('abort',abort);if(key&&controllers.get(key)===controller)controllers.delete(key);}
    },
    // Recovery never calls prepare again. A registry miss is UNKNOWN, not a
    // never-created receipt. The original intent stays durable until exact cleanup.
    async reconcilePreparation({attempt,operationId}={}) {
      try {
        if(!id(attempt?.attemptId)||!id(operationId))return fault('invalid_prepare');
        const key=hash(attempt.attemptId);
        if(controllers.has(key))return fault('preparation_pending');
        let row=read(key);
        if(!row||row.jobId!==attempt.jobId)return fault('preparation_uncertain');
        if(row.start)return fault('preparation_uncertain');
        if(row.removed)return ok({kind:'removed'});
        let h;
        if(row.phase==='prepared')h=await handleFor(row);
        else {
          h=await recoverHandle({sandboxId:row.sandboxId,attemptId:row.attemptId,jobId:row.jobId,generation:row.generation,accountId:row.accountId,providerId:row.providerId,incarnation:row.incarnation,operationId:null});
          if(!id(h?.sandbox_id)||h.job_id!==row.jobId||!id(h._cleanupId))return fault('preparation_uncertain');
          row=edit(key,current=>{
            if(!current||current.phase!=='intent'||current.identity!==row.identity)throw Error('recovery_conflict');
            return {...current,sandboxId:h.sandbox_id,incarnation:h._cleanupId,phase:'prepared',stopRequested:true};
          });
          handles.set(key,h);
        }
        if(!h)return fault('preparation_uncertain');
        row=update(row,current=>({...current,stopRequested:true}));
        const removed=await destroy(row,h);
        return removed.ok?ok({kind:'removed'}):removed;
      } catch{return fault('preparation_uncertain');}
    },
    async start({sandboxId,run,operationId,signal}={}) {
      try {
        let row=find(sandboxId);
        if(!row||!id(operationId))return fault('sandbox_unknown');
        const bound=clone(run),identity=hash(bound);
        if(row.start) {
          if(row.start.operationId!==operationId||row.start.identity!==identity)return fault('operation_conflict');
          return ok(clone(row.start.result));
        }
        if(row.stopRequested||row.removed||row.phase!=='prepared')return fault('stopped');
        if(!validateRun(bound,row))return fault('run_binding_mismatch');
        signal?.throwIfAborted();
        const h=await handleFor(row);
        if(!h)return fault('sandbox_unknown');
        await bindRun({handle:h,run:bound,signal});
        if(!matches(h,row)||hash(bound)!==identity)return fault('run_binding_mismatch');
        signal?.throwIfAborted();
        row=update(row,current=>{
          if(current.start||current.stopRequested||current.removed)throw new Error('start_conflict');
          return {...current,start:{operationId,identity,settled:false,result:{kind:'uncertain',atMs:now()}}};
        });
        const key=hash(row.attemptId),controller=new AbortController();
        controllers.set(key,controller);
        const abort=()=>controller.abort();
        signal?.addEventListener('abort',abort,{once:true});
        if(signal?.aborted)abort();
        const observe=async()=>{
          // Callback is the backend's actual execution observation, not a
          // successful start() return (which occurs only after execution).
          const current=update(row,current=>({...current,start:{...current.start,result:{kind:'started',atMs:now()}}}));
          if(current.stopRequested)try{await backend.cancel(h);}catch{}
        };
        let running;
        try{running=backend.start(h,{signal:controller.signal,onExecutionStarted:observe});}
        catch{running=Promise.reject(new Error('start_uncertain'));}
        Promise.resolve(running).catch(()=>{}).finally(()=>{
          try{update(row,current=>({...current,start:{...current.start,settled:true}}));}catch{/* retain uncertainty */}
          signal?.removeEventListener('abort',abort);
          if(controllers.get(key)===controller)controllers.delete(key);
        });
        // Never wait for execution/usage completion to acknowledge dispatch.
        return ok(clone(read(key).start.result));
      } catch{return fault('start_unavailable');}
    },
    async stop({sandboxId}={}) {
      try {
        let row=find(sandboxId);if(!row)return {ceasedAtMs:null};
        row=update(row,current=>({...current,stopRequested:true}));
        controllers.get(hash(row.attemptId))?.abort();
        if(row.ceasedAtMs!==null)return {ceasedAtMs:row.ceasedAtMs};
        const h=await handleFor(row);if(!h)return {ceasedAtMs:null};
        if(row.start&&!row.start.settled&&!controllers.has(hash(row.attemptId))){
          const removed=await destroy(row,h);
          if(!removed.ok)return {ceasedAtMs:null};
          row=update(row,current=>({...current,start:{...current.start,settled:true}}));
          return {ceasedAtMs:row.ceasedAtMs};
        }
        return await cease(row,h);
      } catch{return {ceasedAtMs:null};}
    },
    async remove({sandboxId,operationId}={}) {
      try {
        let row=find(sandboxId);
        if(!row||!id(operationId))return fault('sandbox_unknown');
        if(row.removeOperation&&row.removeOperation!==operationId)return fault('operation_conflict');
        if(row.removed)return ok(undefined);
        row=update(row,current=>({...current,stopRequested:true,removeOperation:operationId}));
        controllers.get(hash(row.attemptId))?.abort();
        const h=await handleFor(row);if(!h)return fault('cleanup_pending');
        return await destroy(row,h);
      } catch{return fault('cleanup_pending');}
    },
  });
}
