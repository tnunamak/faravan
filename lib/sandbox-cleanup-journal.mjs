import fs from 'node:fs';
import {durableWrite as durableWriteRaw} from './durable-write.mjs';
import {readAbandonedCreateFence,persistAbandonedCreateFence as persistAbandonedCreateFenceRaw} from './sandbox-create-fence.mjs';
import {adoptSandboxWatch,assertWatchExecAllowed} from './v1/sandbox-shared-watcher.mjs';
import {watchProofStore,watchProofDirectory} from './v1/sandbox-watch-proofs.mjs';
import {ownershipStatus} from './v1/sandbox-record-owner.mjs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {sandboxOwnerScope} from './sandbox-name.mjs';
import {saveJsonFile as saveJsonFileRaw} from './local-state.mjs';
import {acquireProcessLockSync,processLockOwners} from './v1/lock.mjs';
import {canonicalScratchPath} from './sandbox-scratch.mjs';
import {validSandboxDeadline,sandboxDeadlineUnitMatches,sandboxDeadlineClock,sandboxDeadlineRemaining} from './sandbox-deadline.mjs';
// Counts this process's journal writes. A display snapshot taken before a write is no longer valid after it, so the owner sees
// their own Stop, retire or finish at once. Writes by other processes still show up within the display age bound.
let writeGeneration=0;
const durableWrite=(...args)=>{writeGeneration++;try{return durableWriteRaw(...args);}finally{writeGeneration++;}};
const persistAbandonedCreateFence=(...args)=>{writeGeneration++;try{return persistAbandonedCreateFenceRaw(...args);}finally{writeGeneration++;}};
const saveJsonFile=(...args)=>{writeGeneration++;try{return saveJsonFileRaw(...args);}finally{writeGeneration++;}};
export const cleanupJournalWriteGeneration=()=>writeGeneration;

// Compute outcomes that fresh evidence alone cannot settle. The row, its hold
// and an owner-visible report stay until the sandbox is observed and resolved.
// Reason of a remediation row for a record this version cannot act on.
export const OLD_RECORD='old_record';
// A record this version cannot read or trust; it is listed and never acted on.
export const UNSAFE_RECORD='unsafe_record';
// The step that kept a finished job's access from being confirmed removed, and
// a short class of the failure. Both come from fixed lists: nothing from sbx is kept.
const REVOCATION_STEPS=new Set(['github_secret','network_policy']);
const REVOCATION_ERRORS=new Set(['listing_failed','removal_refused','value_remains','rule_remains']);
// Fixed reasons one record stayed unresolved; nothing from sbx is kept.
export const CLEANUP_FAILURE=Object.freeze({BUSY:'busy',HOME_MISMATCH:'home_mismatch',DESTROY_FAILED:'destroy_failed',STORAGE_RELEASE_FAILED:'storage_release_failed',
  RECORD_CHANGED:'record_changed',OLD_RECORD:'old_record',UNSAFE_RECORD:'unsafe_record'});
// What a recovery report may carry about a row. A record names its own sandbox and home, so both are checked here and
// never copied unchecked: an array that prints like a name, or a home with a control character, is simply left out.
export const reportableName=name=>typeof name==='string'&&/^wf-[a-f0-9]{16}$/.test(name);
export const reportableHome=home=>typeof home==='string'&&path.isAbsolute(home)&&!/[\0\r\n]/.test(home);
const REPORTED=new Set(['present_without_receipt','creation_unproven','credential_revocation_pending']);
export const establishedAbsentWatch=row=>row?.create==='dispatched'&&Number.isFinite(row.absent_since)&&
  row.compute_created!==true&&row.create_settled!==true&&row.compute_stopped!==true;

// One record owns compute, scratch and scoped policies of one create dispatch.
// The record reserves the dispatch's fresh physical name before sbx runs and
// holds that dispatch's own create receipt. Process locks protect live
// prepares; after death a reaper can acquire the same record without age guesses.
export function createSandboxCleanupJournal({directory,scratchRoot,destroy,monotonic=()=>performance.now(),home=()=>null,inspectLegacy=async()=>({names:null}),removalCommand=()=>null,
  inspectPass=async()=>null,disposePass=()=>{},ownerScope=sandboxOwnerScope,runPass=(_summary,work)=>work(),onSummary=()=>{},retryWatchDebts=async()=>({policy_revoked:false}),resolveAdopted=null,reapAbandoned=async()=>{}}) {
  const admissions=new WeakMap(),registrations=new Set(),leases=new Map(),owners=new Map(),retries=new Map(),oldFindings=new Map(),guardFindings=new Map();let running=null,cursor=0,resolving=0,reaping=null;
  const watchEligible=row=>row?.create==='dispatched'&&row.compute_created===false&&row.create_settled!==true&&row.compute_stopped!==true;
  // The saved proof that closes a watched row, bound to its sandbox home, owner, create and generation; otherwise null.
  const goneProof=row=>{try{return watchProofStore({home:row.sbx_home,owner:row.owner_scope}).gone(row);}catch{return null;}};
  // Why a watched name is not proven gone: a listed sandbox never seen absent, or a create that failed with no sandbox.
  const watchedUnknown=row=>{const found=row.watch_debt_retry?.unknown??row.unknown;return found==='present_without_receipt'||found==='creation_unproven'?found:undefined;};
  const policyOnly=row=>row.compute_stopped===true&&row.data_cleanup==='removed'&&row.policy_cleanup!=='removed';
  const file=id=>path.join(directory,id+'.json');
  // Older deadline guards of this store's records are adopted or blocked, never retired by the scan.
  // Unidentified guards show in status. `extra` is a record this caller has just written.
  async function settleGuards(manager,extra) {
    if(!manager?.reconcileGuards)return {blocked:[]};
    const rowFor=id=>{
      if(extra?._cleanupId===id)return extra;
      try{if(fs.lstatSync(file(id)).isSymbolicLink())return null;const row=read(id);return row&&typeof row==='object'?row:null;}catch{return null;}
    };
    const heldElsewhere=id=>{try{return processLockOwners(file(id)+'.lock').some(owner=>owner.pid!==process.pid);}catch{return true;}};
    const upgrade=async row=>{
      const id=row._cleanupId;
      if(leases.has(id)||owners.get(id)?.active||reaping?.row?._cleanupId===id)return false;
      let recordLock,nameLock;
      try {
        recordLock=acquireProcessLockSync(file(id)+'.lock');
        if(fs.lstatSync(file(id)).isSymbolicLink())return false;
        const latest=read(id);
        if(!current(latest,id)||latest.sandbox_id!==row.sandbox_id||latest.sbx_home!==home())return false;
        nameLock=acquireProcessLockSync(scope(latest.sandbox_id));
        const enforcer=await manager.register(latest,{recovery:true});
        write(id,{...latest,deadline_enforcer:enforcer});return true;
      }catch{return false;}finally{nameLock?.();recordLock?.();}
    };
    const report=await manager.reconcileGuards({directory,rowFor,heldElsewhere,upgrade}).catch(()=>({blocked:[],unknown:true}));
    guardFindings.clear();
    for(const {id} of report.blocked??[]) {
      const row=rowFor(id);
      guardFindings.set(id,{...(reportableName(row?.sandbox_id)?{name:row.sandbox_id}:{}),...(reportableHome(row?.sbx_home)?{home:row.sbx_home}:{}),watched:true,reason:'guard_unidentified'});
    }
    return report;
  }
  const scope=id=>path.join(directory,id+'.scope');
  // A retired inert create can still land after the CLI times out. Keep its
  // exact name/home binding in the permanent name reservation, outside the
  // cleanup debt queue. Names are never reused, even after cleanup succeeds.
  function abandon(handle) {
    const id=handle._cleanupId;
    if(!leases.has(id))return false;
    const row=read(id);
    if(!current(row,id)||row.sandbox_id!==handle.sandbox_id||row.create!=='dispatched'||row.compute_created!==false||row.create_settled===true)return false;
    reserveDeadlineName(row,id);
    persistAbandonedCreateFence(directory,row);
    const fence=readAbandonedCreateFence(directory,row);
    if(fence.job_id!==row.job_id)durableWrite(scope(row.sandbox_id)+'.reserved',JSON.stringify({...fence,job_id:row.job_id}));
    write(id,{...row,create_abandoned:true,exec_fenced:true});
    execFences.add(row.sandbox_id);
    return true;
  }
  const abandoned=row=>current(row,row._cleanupId)&&Boolean(readAbandonedCreateFence(directory,row));
  const wasNeverCreated=(jobId,{sandboxId}={})=>abandonedNames().some(row=>row.abandoned_create===true&&row.job_id===jobId&&(!sandboxId||row.sandbox_id===sandboxId));
  function markAbandoned(row,pending,{computeMayRun}={}) {
    let release;
    try {
      release=acquireProcessLockSync(scope(row.sandbox_id));
      const reservation=scope(row.sandbox_id)+'.reserved';
      if(fs.lstatSync(reservation).isSymbolicLink())return false;
      const saved=JSON.parse(fs.readFileSync(reservation,'utf8'));
      if((saved.abandoned_create!==true&&saved.retired_name!==true)||saved.id!==row._cleanupId||saved.sandbox_id!==row.sandbox_id||saved.sbx_home!==home()||saved.owner_scope!==sandboxOwnerScope())return false;
      durableWrite(reservation,JSON.stringify({...saved,cleanup_pending:pending,...(typeof computeMayRun==='boolean'?{compute_may_run:computeMayRun}:{})}));return true;
    }catch{return false;}finally{release?.();}
  }
  function abandonedNames() {
    const rows=[];let names;
    try{if(fs.lstatSync(directory).isSymbolicLink())return rows;names=fs.readdirSync(directory);}catch{return rows;}
    // The owner and the sbx home are read once per scan: the result describes them as they were when the call began,
    // and the next call reads them fresh. Reading them per reservation file made them most of a scan's cost.
    let owner,sbxHome;
    try{owner=ownerScope();sbxHome=home();}catch{return rows;}
    for(const entry of names) {
      if(!/^wf-[a-f0-9]{16}\.scope\.reserved$/.test(entry))continue;
      try {
        const target=path.join(directory,entry);if(fs.lstatSync(target).isSymbolicLink())continue;
        const saved=JSON.parse(fs.readFileSync(target,'utf8'));
        if((saved.abandoned_create!==true&&saved.retired_name!==true)||saved.owner_scope!==owner||saved.sbx_home!==sbxHome||
          saved.sandbox_id!==entry.slice(0,-15)||!/^[a-f0-9-]{36}$/.test(saved.id))continue;
        rows.push({...saved,_cleanupId:saved.id});
      }catch{/* An unreadable reservation authorizes nothing. */}
    }
    return rows;
  }
  function nameReserved(row) {
    try {
      const target=scope(row.sandbox_id)+'.reserved';
      if(fs.lstatSync(target).isSymbolicLink())return false;
      const saved=JSON.parse(fs.readFileSync(target,'utf8'));
      return saved.id===row._cleanupId&&saved.owner_scope===row.owner_scope&&saved.sbx_home===row.sbx_home&&
        (saved.sandbox_id===undefined||saved.sandbox_id===row.sandbox_id);
    }catch{return false;}
  }
  // A completed row still fences its physical name. Ordinary live reservations
  // remain governed by their row and original registration lease.
  function retiredTarget(name,requestedHome=home()) {
    if(!reportableName(name))return null;
    const unsafe={name,home:home(),status:'failed',reason:'unsafe_record'};
    try {
      const target=scope(name)+'.reserved';
      if(fs.lstatSync(target).isSymbolicLink())return unsafe;
      const saved=JSON.parse(fs.readFileSync(target,'utf8'));
      if(saved.retired_name!==true&&saved.abandoned_create!==true)return null;
      if(saved.sandbox_id!==name||saved.owner_scope!==sandboxOwnerScope()||
        !/^[a-f0-9-]{36}$/.test(saved.id??'')||!reportableHome(saved.sbx_home))return unsafe;
      if(saved.sbx_home!==requestedHome)return null;
      return {id:saved.id,name,home:saved.sbx_home,status:'failed',reason:'cleanup_deferred'};
    }catch(error){return error.code==='ENOENT'?null:unsafe;}
  }
  function retireName(row,{computeMayRun=false}={}) {
    if(!leases.has(row._cleanupId)||!nameReserved(row))return false;
    const target=scope(row.sandbox_id)+'.reserved',saved=JSON.parse(fs.readFileSync(target,'utf8'));
    durableWrite(target,JSON.stringify({...saved,sandbox_id:row.sandbox_id,job_id:row.job_id,
      account_key:row.account_key??null,account_slot:row.account_slot??0,retired_name:true,compute_may_run:computeMayRun,
      ...(row.create_refused===true?{create_refused:true}:{})}));
    execFences.add(row.sandbox_id);return true;
  }
  function recordPolicyResidue(row,residue) {
    if(!leases.has(row._cleanupId)||!nameReserved(row))return false;
    const target=scope(row.sandbox_id)+'.reserved',saved=JSON.parse(fs.readFileSync(target,'utf8'));
    durableWrite(target,JSON.stringify({...saved,sandbox_id:row.sandbox_id,retired_name:true,policy_residue:residue}));
    execFences.add(row.sandbox_id);return true;
  }
  // Active preparations are not cleanup debt; cleanup leases remain visible.
  // Unknown ownership shares one fallback slot; stopped compute needs no slot.
  function obligations() { return inScan(obligationsScan); }
  function obligationsScan() {
    const result=[];
    try {
      for(const entry of entries()) {
        const id=entry.slice(0,-5);if(registrations.has(id))continue;
        try {
          if(fs.lstatSync(file(id)).isSymbolicLink())throw Error('Unsafe cleanup record');
          const row=read(id);
          const trusted=current(structuredClone(row),id);let fence;
          try{fence=readAbandonedCreateFence(directory,row);}catch{/* An invalid fence supplies no stop evidence. */}
          result.push({id,name:reportableName(row?.sandbox_id)?row.sandbox_id:null,
            home:reportableHome(row?.sbx_home)?row.sbx_home:null,job_id:row?.job_id,
            account_key:trusted&&typeof row?.account_key==='string'?row.account_key:null,
            account_slot:Number.isSafeInteger(row?.account_slot)&&row.account_slot>=0?row.account_slot:0,
            compute_may_run:!trusted||fence?.compute_may_run===true||
              (row.create==='dispatched'||row.compute_created===true)&&row.compute_stopped!==true&&fence?.compute_may_run!==false,
            reason:row?.policy_cleanup==='blocked'?'policy_cleanup_pending':'cleanup_deferred'});
        }catch{result.push({id,name:null,home:null,account_key:null,account_slot:0,compute_may_run:true,reason:'unsafe_record'});}
      }
    }catch{result.push({id:'journal',name:null,home:null,account_key:null,account_slot:0,compute_may_run:true,reason:'journal_unreadable'});}
    for(const row of abandonedNames()) {
      if(row.cleanup_pending!==true||result.some(item=>item.id===row._cleanupId))continue;
      result.push({id:row._cleanupId,name:row.sandbox_id,home:row.sbx_home,
        account_key:row.account_key??null,account_slot:row.account_slot??0,
        compute_may_run:row.compute_may_run!==false,reason:'cleanup_deferred'});
    }
    return result;
  }
  function stoppedJobs(jobIds,{validateRow=()=>true}={}) {
    const rows=[];
    try {
      for(const entry of entries()) {
        const id=entry.slice(0,-5);if(fs.lstatSync(file(id)).isSymbolicLink())return null;
        const row=read(id);if(!jobIds.includes(row?.job_id))continue;
        if(!current(row,id)||!validateRow(row)||row.compute_stopped!==true)return null;
        rows.push(row.sandbox_id);
      }
    }catch{return null;}
    return rows.length?rows:null;
  }
  const sync=dir=>{const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
  const read=id=>JSON.parse(fs.readFileSync(file(id),'utf8'));
  const write=(id,{scratch_outside,...row})=>{saveJsonFile(file(id),row,{base:directory});sync(file(id));sync(directory);};
  function entries() {
    try {
      if(fs.lstatSync(directory).isSymbolicLink())throw Error('Unsafe cleanup journal');
      return fs.readdirSync(directory).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).sort();
    }catch(error){if(error.code==='ENOENT')return [];throw error;}
  }
  // An unreadable row is debt, not an invented claim on every fresh name.
  // Its exact id (and any readable name) remain fenced by recovery admission.
  const recorded=name=>entries().some(entry=>{try{return read(entry.slice(0,-5))?.sandbox_id===name;}catch{return false;}});
  function reserveDeadlineName(row,id,{fresh=false}={}) {
    const reservation=scope(row.sandbox_id)+'.reserved';
    if(fs.existsSync(reservation)) {
      if(fresh||fs.lstatSync(reservation).isSymbolicLink())throw Error('Sandbox name was already reserved');
      const saved=JSON.parse(fs.readFileSync(reservation,'utf8'));
      if(saved.id!==id||saved.owner_scope!==row.owner_scope||saved.sbx_home!==row.sbx_home)throw Error('Sandbox name was already reserved');
      return;
    }
    const fd=fs.openSync(reservation,'wx',0o600);
    try{fs.writeFileSync(fd,JSON.stringify({version:1,id,owner_scope:row.owner_scope,sbx_home:row.sbx_home}));fs.fsyncSync(fd);}
    finally{fs.closeSync(fd);}
    sync(directory);
  }
  function register(handle,{session}={}) {
    if(handle.deadline_at!==undefined&&!validSandboxDeadline(handle))throw Error('Invalid sandbox deadline.');
    const scratch=canonicalScratchPath(handle.scratch_dir,scratchRoot());
    if(!scratch)throw Error('Unsafe scratch root');
    handle.scratch_dir=scratch;
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    if(fs.lstatSync(directory).isSymbolicLink())throw Error('Unsafe cleanup journal');
    sync(path.dirname(directory));
    const id=randomUUID(),releaseScope=acquireProcessLockSync(scope(handle.sandbox_id));
    let releaseRecord,released=false;
    const release=()=>{if(released)return;registrations.delete(id);releaseRecord?.();releaseScope();released=true;};
    try {
      releaseRecord=acquireProcessLockSync(file(id)+'.lock');
      if(handle.sbx_home&&handle.sbx_home!==home())throw Error('Sandbox HOME changed before cleanup registration');
      // A physical name is never reused while any record can still target it.
      if(recorded(handle.sandbox_id))throw Error('Sandbox name is already reserved by a cleanup record');
      if(fs.existsSync(scope(handle.sandbox_id)+'.reserved'))throw Error('Sandbox name was already reserved');
      if(/^wf-[a-f0-9]{16}$/.test(handle.sandbox_id)) {
        // Never recycle a physical name: a failed cancellation may still fire.
        reserveDeadlineName({...handle,owner_scope:sandboxOwnerScope(),sbx_home:home()},id,{fresh:true});
      }
      const record={version:2,_cleanupId:id,owner_scope:sandboxOwnerScope(),sbx_home:home(),job_id:handle.job_id,sandbox_id:handle.sandbox_id,scratch_dir:handle.scratch_dir,
        ...(session?.accountKey?{account_key:session.accountKey,account_slot:session.slot??0}:{}),
        ...(handle.account_attempt?{account_attempt:structuredClone(handle.account_attempt)}:{}),
        runtime_recorded:true,...(handle.sbx_runtime?{sbx_runtime:handle.sbx_runtime}:{}),
        create:'reserved',compute_created:false,create_settled:false,compute_stopped:false,data_cleanup:'owned',policy_cleanup:'owned',
        ...(Number.isSafeInteger(handle.deadline_at)?{deadline_at:handle.deadline_at,deadline_clock:handle.deadline_clock}:{}),
        ...(handle.scoped_github_secret?{scoped_github_secret:true}:{}),
        ...(handle.scoped_claude_secret?{scoped_claude_secret:handle.scoped_claude_secret}:{})};
      Object.assign(handle,{owner_scope:record.owner_scope,sbx_home:record.sbx_home});
      // The reservation must survive a crash before the first sbx create/run.
      write(id,record);
      leases.set(id,release);registrations.add(id);handle._cleanupId=id;admissions.set(handle,{id,release});
      if(session){owners.set(id,session);session.unproven.add(id);if(!session.active)session.invalidate();}
    }catch(error){release();throw error;}
  }
  // Durable create facts of the record this process holds: `create:'dispatched'`
  // before sbx runs, `compute_created` when the create command succeeded and
  // `create_settled` once the sandbox was observed. Without the lease, nothing.
  function mark(handle,facts) {
    const id=handle._cleanupId;
    if(!id||!leases.has(id))return false;
    const row=read(id);
    if(row.watch_state==='watch_adopted'&&!(Object.keys(facts).length===1&&Number.isFinite(facts.absent_since)&&row.absent_since===undefined))return false;
    if(row.sandbox_id!==handle.sandbox_id)throw Error('Cleanup record changed');
    for(const key of ['deadline_at','deadline_clock']) {
      if(facts[key]!==undefined&&JSON.stringify(facts[key])!==JSON.stringify(row[key]))
        throw Error('Sandbox deadline is immutable');
    }
    write(id,{...row,...facts});
    return true;
  }
  // A compact scratch receipt references the descriptor already durable in this journal.
  // This grants only a runtime identity; compute removal still needs its create receipt.
  function runtimeForScratch({id,sandbox_id=id,owner_scope,sbx_home,runtime_id}={}) {
    if(owner_scope!==sandboxOwnerScope()||sbx_home!==home()||!/^[a-f0-9]{64}$/.test(runtime_id??''))return null;
    try {
      for(const entry of entries()) {
        const key=entry.slice(0,-5);
        if(fs.lstatSync(file(key)).isSymbolicLink())continue;
        const row=read(key);
        if(current(row,key)&&row.sandbox_id===sandbox_id&&row.owner_scope===owner_scope&&row.sbx_home===sbx_home&&row.sbx_runtime?.id===runtime_id)return row.sbx_runtime;
      }
    }catch{/* Missing or unreadable authority retains the scratch receipt. */}
    return null;
  }
  // The exact current record for this handle's sandbox, or null. Only a
  // record of this owner scope can authorize a stop or a removal.
  // Exec authority is narrower than cleanup authority: cleanup must retain access
  // to all outstanding debts after a name has been handed to the shared watcher.
  const execFences=new Set();
  function assertExecAllowed(handle) {
    if(execFences.has(handle?.sandbox_id)||readAbandonedCreateFence(directory,handle))throw Error('This sandbox is reserved for cleanup.');
    assertWatchExecAllowed(authority(handle));
  }
  // Sibling per-row interface: accepts {id,name,status}; never owns traversal.
  // The caller may pass failed for a validated never-observed create whose
  // inventory failed. This function revalidates before doing anything.
  async function adoptWatch(result,manager,watcher,{validateRow=()=>true}={}) {
    if(['in_progress','foreign_locked'].includes(result?.status))return result;
    if(!['watching','failed'].includes(result?.status))return result;
    const id=result.id??result.row?._cleanupId;
    if(!/^[a-f0-9-]{36}$/.test(id??''))return {...result,status:'failed',admission_released:false};
    if(leases.has(id)||owners.get(id)?.active||reaping?.row?._cleanupId===id)return {...result,status:'in_progress',admission_released:false};
    const lockStatus=()=>{try{const row=read(id);if(!/^wf-[a-f0-9]{16}$/.test(row?.sandbox_id??'')||!current(row,id))return 'failed';const holders=[...processLockOwners(file(id)+'.lock'),...processLockOwners(scope(row.sandbox_id))];
      return holders.some(owner=>owner.pid!==process.pid)?'foreign_locked':holders.length?'in_progress':null;}catch{return 'foreign_locked';}};
    const held=lockStatus();if(held)return {...result,status:held,admission_released:false};
    let releaseRecord,releaseName;
    try {
      if(fs.lstatSync(file(id)).isSymbolicLink())throw Error('Unsafe cleanup record.');
      releaseRecord=acquireProcessLockSync(file(id)+'.lock');
      const row=read(id);
      if(!current(row,id)||!validateRow(row)||result.name&&result.name!==row.sandbox_id)throw Error('Cleanup ownership changed.');
      releaseName=acquireProcessLockSync(scope(row.sandbox_id));
      reserveDeadlineName(row,id);
      return await adoptLocked(result,row,manager,watcher);

    }catch(error){return {...result,status:error.code==='lock_busy'?(lockStatus()??'foreign_locked'):'failed',admission_released:false,reason:String(error.message)};}
    finally{releaseName?.();releaseRecord?.();}
  }
  // The caller has validated the current row and owns its record/name locks.
  // Recovery uses this inner sequence rather than nesting adoptWatch's locks.
  function retainMaterialization(row,manager) {
    if(manager.observed?.(row)!==true)return row;
    if(row.compute_created===true&&row.create_settled===true)return row;
    const materialized={...row,compute_created:true,create_settled:true};
    write(row._cleanupId,materialized);
    return materialized;
  }
  // A record that has a deadline guard keeps it as the deadline remover until its removal is proven or its own deadline acts:
  // the guard is never handed to the watcher. A record already handed off by an earlier version is judged by its live guards.
  const keepsGuard=row=>row.watch_state!=='watch_adopted'&&(row.deadline_at!==undefined||row.deadline_clock!==undefined||row.deadline_enforcer!==undefined);
  async function adoptLocked(result,row,manager,watcher) {
    row=retainMaterialization(row,manager);
    if(!watcher||row.create!=='dispatched'||row.compute_created!==false||row.create_settled===true||row.compute_stopped===true)
      return {...result,status:'failed',admission_released:false,reason:'watch_ineligible'};
    // A guard of this record, seen now, is its protector: nothing is handed off over it, and nothing signals it.
    const guards=await settleGuards(manager,row);
    if(keepsGuard(row)||guards.unknown||[...(guards.adopted??[]),...(guards.blocked??[])].some(guard=>guard.id===row._cleanupId))
      return {...result,status:'failed',admission_released:false,reason:'guard_keeps_record'};
    const outcome=await adoptSandboxWatch({...result,status:'watching',row},{
      fence:locked=>execFences.add(locked.sandbox_id),
      persist:locked=>durableWrite(file(locked._cleanupId),JSON.stringify(locked)),
      acknowledge:locked=>watcher.acknowledge(locked),
    });
    const {row:unused,error:ignored,...publicResult}=outcome;
    return {...publicResult,...(outcome.admission_released?{protected:true}:{reason:outcome.reason??'watch_unavailable'})};
  }
  // What a watched name is waiting on, besides its saved debts. `unknown` is a listed sandbox this install never saw absent.
  async function retryAdoptedDebts(row,{signal,unknown}={}) {
    const debt=await retryWatchDebts(row,{signal}).catch(()=>({policy_revoked:false}));
    const revoked=debt?.policy_revoked===true;
    const failure=!revoked&&REVOCATION_STEPS.has(debt?.revocation?.step)&&REVOCATION_ERRORS.has(debt?.revocation?.error)
      ?{step:debt.revocation.step,error:debt.revocation.error}:null;
    const state={policy_revoked:revoked,scratch:'awaiting_compute',storage:'awaiting_compute',name:'reserved',...(failure?{revocation:failure}:{}),...(unknown?{unknown}:{})};
    // The retry above waited, and `finish` may have released this pass's locks meanwhile (a row it keeps has no lease). Another
    // actor can then have closed and deleted the row, or handed the name over again. Write onto the row as it is now, under the
    // record lock, and only if it is still this row and this hand-off. A deleted record stays deleted.
    const id=row._cleanupId;let releaseRecord;
    if(!leases.has(id)) {
      try{releaseRecord=acquireProcessLockSync(file(id)+'.lock');}
      catch{return;} // Another actor owns the record now; it works out its own state.
    }
    try {
      // Under the lock, revalidate the row as it is now: not a link, a readable current record of this owner, still this hand-off.
      // A row that fails any of these is left byte for byte as it is.
      let saved;
      try{if(fs.lstatSync(file(id)).isSymbolicLink())return;saved=read(id);}catch{return;}
      if(!saved||typeof saved!=='object'||!current(structuredClone(saved),id))return;
      if(saved._cleanupId!==id||saved.sandbox_id!==row.sandbox_id||saved.watch_state!=='watch_adopted'||
        saved.watch_generation!==row.watch_generation||saved.watch_challenge!==row.watch_challenge)return;
      if(saved.compute_stopped===true)Object.assign(state,{scratch:saved.data_cleanup==='removed'?'removed':'pending',storage:saved.watch_debt_retry?.storage==='released'?'released':'pending',policy_revoked:saved.policy_cleanup==='removed'||revoked});
      if(JSON.stringify(saved.watch_debt_retry)!==JSON.stringify(state))durableWrite(file(id),JSON.stringify({...saved,watch_debt_retry:state}));
    }finally{releaseRecord?.();}
  }
  // The caller owns this row's record and name locks and its lease. The backend observes the name (and removes it when this
  // install saw it absent first); the row closes only through `finish` on a saved proof. Whatever stays open has its
  // revocation retried and its state kept for the owner. Returns true when the row is closed.
  async function resolveAdoptedRow(row,{signal}={}) {
    let outcome={};
    if(resolveAdopted)outcome=await resolveAdopted(row,{signal}).catch(()=>({}))??{};
    signal?.throwIfAborted();
    if(!fs.existsSync(file(row._cleanupId)))return true;
    const saved=read(row._cleanupId);
    if(saved.create_abandoned!==true)await retryAdoptedDebts(saved,{signal,unknown:outcome.unknown});
    return !fs.existsSync(file(row._cleanupId));
  }
  // The same, for one adopted row found outside the reaper, under the same two locks the reaper takes.
  async function resolveWatched(row,{signal,validateRow=()=>true}={}) {
    if(!resolveAdopted)return false;
    const id=row._cleanupId;
    if(leases.has(id)||owners.get(id)?.active||reaping?.row?._cleanupId===id)return false;
    let releaseRecord,releaseName,released=false;
    const release=()=>{if(released)return;released=true;releaseName?.();releaseRecord?.();};
    try {
      releaseRecord=acquireProcessLockSync(file(id)+'.lock');
      if(!fs.existsSync(file(id)))return true;
      const locked=read(id);
      if(!current(locked,id)||locked.sandbox_id!==row.sandbox_id||locked.watch_state!=='watch_adopted'||!validateRow(locked))return false;
      releaseName=acquireProcessLockSync(scope(locked.sandbox_id));
      leases.set(id,release);
      return await resolveAdoptedRow(locked,{signal});
    }catch{return false;}
    finally{if(leases.get(id)===release)leases.delete(id);release();}
  }
  function authority(handle) {
    try {
      const ids=handle?._cleanupId?[handle._cleanupId]:entries().map(entry=>entry.slice(0,-5));
      for(const id of ids) {
        let row;
        try {if(fs.lstatSync(file(id)).isSymbolicLink())continue;row=read(id);}
        catch(error){if(error.code==='ENOENT')continue;throw error;}
        if(current(row,id)&&row.sandbox_id===handle.sandbox_id&&row.job_id===handle.job_id)return row;
      }
    }catch{/* An unreadable journal authorizes nothing. */}
    return null;
  }
  // Native cleanup identity survives the process that created it. This
  // returns the actual owned record, never execution/admission authority.
  function accountRun({attemptId,jobId,generation,accountId,providerId,sandboxId=null,incarnation=null}) {
    try {
      const matches=[];
      for(const entry of entries()) {
        const id=entry.slice(0,-5);
        if(fs.lstatSync(file(id)).isSymbolicLink())return null;
        const row=read(id),binding=row?.account_attempt;
        if(binding?.attemptId!==attemptId)continue;
        if(!current(row,id)||row.sbx_home!==home()||row.job_id!==jobId||binding.jobId!==jobId||
          binding.generation!==generation||binding.accountId!==accountId||binding.providerId!==providerId||sandboxId&&row.sandbox_id!==sandboxId||incarnation&&row._cleanupId!==incarnation)
          return null;
        if(leases.has(id)||processLockOwners(file(id)+'.lock').length||processLockOwners(scope(row.sandbox_id)).length)return null;
        matches.push(row);
      }
      return matches.length===1?matches[0]:null;
    }catch{return null;}
  }
  // An admission belongs to the original registered handle and its exact
  // still-owned lease, not to a copied cleanup id or a temporary recovery lock.
  function admissionAuthority(handle) {
    const owned=admissions.get(handle);
    if(!owned||handle._cleanupId!==owned.id||leases.get(owned.id)!==owned.release)return null;
    const row=authority(handle);
    return row&&row.sbx_home===handle.sbx_home?row:null;
  }
  // This process closed the handle's own record: its compute, scratch and
  // policies were all proven removed, and the record was deleted.
  function closed(handle) {
    if(!handle?._cleanupId||!/^[a-f0-9-]{36}$/.test(handle._cleanupId))return false;
    try {fs.lstatSync(file(handle._cleanupId));return false;}
    catch(error){return error.code==='ENOENT';}
  }
  function finish(handle,receipt) {
    const id=handle._cleanupId,release=leases.get(id);
    if(!release)return;
    try {
      let record;
      try {record=read(id);}
      catch(error){if(error.code==='ENOENT')return;throw error;}
      // Materialized watches require a bound present-then-absent proof. An inert
      // abandoned create instead requires its durable permanent name fence.
      if(record.watch_state==='watch_adopted'&&!(receipt.removed===true&&(goneProof(record)||abandoned(record))))return;
      if(receipt.removed===true&&record.sbx_home&&receipt.sbx_home!==record.sbx_home)receipt={...receipt,removed:false,scratch_removed:false,policy_removed:false,unknown:undefined};
      if(receipt.removed===true){reserveDeadlineName(record,id);retireName(record);owners.get(id)?.unproven.delete(id);owners.delete(id);}
      if(receipt.removed===true&&receipt.scratch_removed===true&&receipt.policy_removed===true){
        writeGeneration++;try{fs.unlinkSync(file(id));}catch(error){if(error.code!=='ENOENT')throw error;}sync(directory);writeGeneration++;
      }else{
        const stopped=record.compute_stopped===true||receipt.removed===true;
        const revoked=receipt.policy_removed!==true&&receipt.watching!==true&&
          REVOCATION_STEPS.has(receipt.revocation?.step)&&REVOCATION_ERRORS.has(receipt.revocation?.error);
        write(id,{...record,compute_stopped:stopped,
          ...(stopped&&record.watch_state==='watch_adopted'?{watch_debt_retry:{...record.watch_debt_retry,scratch:receipt.scratch_removed?'removed':'pending',storage:receipt.storage_removed?'released':'pending',name:'reserved',policy_revoked:receipt.policy_removed===true}}:{}),
          ...(stopped||receipt.watching===true?{unknown:undefined}:REPORTED.has(receipt.unknown)?{unknown:receipt.unknown}:{}),
          ...(revoked||stopped||receipt.watching===true||REPORTED.has(receipt.unknown)?
            {revocation_step:revoked?receipt.revocation.step:undefined,revocation_error:revoked?receipt.revocation.error:undefined}:{}),
          data_cleanup:receipt.scratch_removed===true?'removed':'pending',
          policy_cleanup:receipt.policy_removed===true?'removed':receipt.removed===true&&receipt.scratch_removed===true&&receipt.policy_blocked===true?'blocked':'pending'});
      }
    }finally{leases.delete(id);release();}
  }
  // A record's shape, ids and deadline fields. Its scratch directory is judged
  // separately by `scratchState`, so one stray directory is not mistaken for a
  // forged record.
  // One synchronous scan (status, remediation, obligations) reads the owner and resolves each scratch directory once, as if all
  // rows were read at one instant. Outside a scan every call reads fresh. A scan whose owner cannot be read keeps the per-row
  // behavior, where each row fails on its own.
  let scan=null;
  // The owner is read on the first row that needs it, never up front: a scan with no rows must not touch the owner file.
  const ownerNow=()=>{
    if(!scan)return sandboxOwnerScope();
    if(scan.owner===undefined)scan.owner=sandboxOwnerScope();
    return scan.owner;
  };
  const inScan=work=>{
    if(scan)return work();
    scan={owner:undefined,resolved:new Map()};
    try{return work();}finally{scan=null;}
  };
  function shapeSafe(row,id) {
    if(![1,2].includes(row?.version)||row._cleanupId!==id||typeof row.job_id!=='string'||
      !reportableName(row.sandbox_id)||typeof row.scratch_dir!=='string')return false;
    if(row.deadline_at!==undefined||row.deadline_clock!==undefined||row.deadline_enforcer!==undefined) {
      if(!validSandboxDeadline(row))return false;
      const action=row.deadline_enforcer;
      if(action!==undefined&&(!action||typeof action.binary!=='string'||!path.isAbsolute(action.binary)||
        !(action.kind==='systemd'&&sandboxDeadlineUnitMatches(row,action.unit)||action.kind==='guard'&&
          Number.isSafeInteger(action.pid)&&action.pid>1&&typeof action.start==='string'&&action.start.length>0)))return false;
    }
    return path.basename(row.scratch_dir).startsWith('wf-job-'+row.sandbox_id+'-');
  }
  // 'inside': a plain directory in the scratch root (or not there any more).
  // 'outside': an absolute path whose parent is not the scratch root, e.g. a
  // temp directory another process chose. 'unsafe': anything else, such as a symlink.
  function scratchState(row) {
    const scratch=canonicalScratchPath(row.scratch_dir,scratchRoot(),scan?.resolved);
    if(!scratch)return path.isAbsolute(row.scratch_dir)?'outside':'unsafe';
    row.scratch_dir=scratch;
    try {return fs.lstatSync(scratch).isDirectory()&&!fs.lstatSync(scratch).isSymbolicLink()?'inside':'unsafe';}
    catch(error){return error.code==='ENOENT'?'inside':'unsafe';}
  }
  function safe(row,id) {
    return shapeSafe(row,id)&&scratchState(row)==='inside';
  }
  // A record this process may act on. A current record of this owner whose
  // scratch lies outside the scratch root is usable too: its sandbox and
  // policies are resolved as usual, and the directory is never touched. The
  // mark is recomputed here and never read from disk.
  function usable(row,id) {
    if(row&&typeof row==='object')delete row.scratch_outside;
    if(!shapeSafe(row,id))return false;
    const state=scratchState(row);
    if(state==='inside')return true;
    if(state==='outside'&&row.version===2&&row.owner_scope===ownerNow()){row.scratch_outside=true;return true;}
    return false;
  }
  const foreignScope=row=>row?.owner_scope && row.owner_scope!==ownerNow();
  // Only a version 2 record of this owner carries a create reservation and receipt.
  const current=(row,id)=>usable(row,id)&&row.version===2&&row.owner_scope===ownerNow();
  // Older records never authorize a stop, a removal or a close. They are read
  // only, and reported with the exact command when a verified listing shows them.
  // With `settle`, a record from before create receipts closes once the same
  // verified evidence that would report it shows its sandbox absent: HOME,
  // a live daemon's listing and the host process scan. It returns true then.
  // Any gap in that evidence keeps the record, the report and the barrier.
  async function reportOld(row,{signal,settle=false}={}) {
    if(row.owner_scope){oldFindings.set(row._cleanupId,{name:row.sandbox_id,home:row.sbx_home??null,reason:OLD_RECORD});return false;}
    const evidence=await inspectLegacy(row,{signal,sourceDirectory:directory,legacyNames:[row.sandbox_id]});
    const present=evidence?.names?.includes(row.sandbox_id);
    if(settle&&evidence?.names&&!present&&await closeAbsentLegacy(row)){oldFindings.delete(row._cleanupId);return true;}
    oldFindings.set(row._cleanupId,{name:row.sandbox_id,home:evidence?.home??null,reason:OLD_RECORD,...(present?{command:evidence.command(row.sandbox_id)}:{})});
  }
  // Closes the record of a sandbox already proven absent: its scratch goes
  // first, so a failed removal keeps the record. The record lock and the
  // name lock make a concurrent register or reap wait, as resolve() does.
  async function closeAbsentLegacy(row) {
    const id=row._cleanupId;
    if(leases.has(id)||owners.get(id)?.active)return false;
    let releaseRecord,releaseScope;
    try {
      releaseRecord=acquireProcessLockSync(file(id)+'.lock');
      releaseScope=acquireProcessLockSync(scope(row.sandbox_id));
      if(fs.lstatSync(file(id)).isSymbolicLink())return false;
      const locked=read(id);
      if(locked.owner_scope||locked.sandbox_id!==row.sandbox_id||!safe(locked,id))return false;
      writeGeneration++;fs.rmSync(locked.scratch_dir,{recursive:true,force:true});writeGeneration++;
      if(fs.existsSync(locked.scratch_dir))return false;
      writeGeneration++;fs.unlinkSync(file(id));sync(directory);writeGeneration++;
      return true;
    }catch{return false;}
    finally {releaseScope?.();releaseRecord?.();}
  }
  async function inspectRemediation({signal}={}) {
    try {
      for(const entry of entries()) {
        if(signal?.aborted)break;
        if(fs.lstatSync(path.join(directory,entry)).isSymbolicLink())continue;
        const id=entry.slice(0,-5),row=read(id);
        if(!foreignScope(row)&&safe(row,id)&&!current(row,id))await reportOld(row,{signal});
      }
    }catch{/* Unreadable records cannot authorize a command. */}
    return [...oldFindings.values()].filter(row=>row.command);
  }
  async function pass({signal}={}) {
    const start=monotonic(),summary={event:'reaper_pass',duration_ms:0,budget_ms:null,budget_exhausted:false,
      rows_total:0,rows_visited:0,rows_attempted:0,rows_settled:0,rows_deferred:0,rows_locked:0,rows_watch:0,
      rows_legacy:0,rows_unknown:0,rows_foreign:0,inventory_calls:0,command_calls:0,outcome:'completed',active:true};
    return runPass(summary,async()=>{
      let snapshot;
      try {
        await reapAbandoned(abandonedNames(),{signal});
        const names=entries(),candidates=new Map();summary.rows_total=names.length;
        for(const id of retries.keys())if(!names.includes(id+'.json'))retries.delete(id);
        // Capture exact contents before observation; revalidate under both locks.
        const count=Math.min(names.length,32);
        // Observation holds no record lock, so it never makes a resolve wait; a resolve that is already running skips it.
        if(!signal?.aborted&&!resolving)for(let k=0;k<count;k++)try {
          const entry=names[(cursor+k)%names.length],id=entry.slice(0,-5);
          if(leases.has(id)||fs.lstatSync(file(id)).isSymbolicLink())continue;
          const content=fs.readFileSync(file(id),'utf8'),row=JSON.parse(content);
          if(!foreignScope(row)&&current(row,id)&&row.watch_state!=='watch_adopted'&&establishedAbsentWatch(row))candidates.set(id,{content,row});
        }catch{/* The normal locked path classifies unreadable rows. */}
        if(candidates.size)try {snapshot=await inspectPass([...candidates.values()].map(item=>item.row),{signal,passId:randomUUID()});}
        catch {summary.outcome='failed';}
        let n=0;
        // A resolve that starts during the pass takes the remaining rows itself, so the pass stops before its next row.
        for(;n<count;n++) {
          if(signal?.aborted||resolving)break;
          const entry=names[(cursor+n)%names.length],id=entry.slice(0,-5);summary.rows_visited++;
          if(leases.has(id)){summary.rows_locked++;continue;}
          let release,before,finishRow;
          try {
            release=acquireProcessLockSync(file(id)+'.lock');
            if(fs.lstatSync(file(id)).isSymbolicLink()){summary.rows_unknown++;continue;}
            const content=fs.readFileSync(file(id),'utf8'),row=JSON.parse(content);
            if(foreignScope(row)){summary.rows_foreign++;continue;}
            if(!usable(row,id)){summary.rows_unknown++;continue;}
            // The pass holds this record's lock across the awaits below; a resolve that selects it waits for done.
            reaping={row,done:new Promise(resolveDone=>{finishRow=resolveDone;})};
            if(!current(row,id)){summary.rows_legacy++;await reportOld(row,{signal});continue;}
            const retry=retries.get(id);
            if(!(policyOnly(row)||row.watch_state==='watch_adopted')||retry?.content!==content)retries.delete(id);
            else if(monotonic()<retry.next){summary.rows_deferred++;continue;}
            const releaseScope=acquireProcessLockSync(scope(row.sandbox_id)),releaseRecord=release;
            let released=false;
            release=()=>{if(released)return;releaseRecord();releaseScope();released=true;};
            leases.set(id,release);before=content;summary.rows_attempted++;
            if(row.watch_state==='watch_adopted') {
              summary.rows_watch++;
              const retry=retries.get(id);
              if(retry?.content===content&&monotonic()<retry.next){summary.rows_deferred++;continue;}
              if(!await resolveAdoptedRow(row,{signal}))retries.set(id,{content:fs.readFileSync(file(id),'utf8'),delay:60000,next:monotonic()+60000});
              continue;
            }
            if(establishedAbsentWatch(row))summary.rows_watch++;
            await destroy(row,{signal,watchInventory:candidates.get(id)?.content===content?snapshot:undefined});
          }catch(error){
            if(error?.code==='lock_busy')summary.rows_locked++;
            else {if(before===undefined)summary.rows_unknown++;summary.outcome='failed';}
          }finally{
            if(before!==undefined)try {
              const content=fs.readFileSync(file(id),'utf8'),row=JSON.parse(content),retry=retries.get(id);
              if(row.watch_state==='watch_adopted'){}
              else if(policyOnly(row)){
                const delay=content===before&&retry?Math.min(retry.delay*2,3600000):15000;
                retries.set(id,{content,delay,next:monotonic()+delay});
              }else retries.delete(id);
            }catch(error){if(error.code==='ENOENT')summary.rows_settled++;retries.delete(id);}
            leases.delete(id);
            // A failed lock release still ends this row for a waiting resolve.
            try{release?.();}finally{if(finishRow){reaping=null;finishRow();}}
          }
        }
        cursor=names.length?(cursor+n)%names.length:0;
      }catch(error){summary.outcome='failed';throw error;}
      finally {
        try{disposePass(snapshot);}catch{/* Observation disposal must not hide the summary. */}summary.active=false;
        summary.rows_deferred+=summary.rows_total-summary.rows_visited;
        summary.duration_ms=Math.max(0,monotonic()-start);
        if(signal?.aborted)summary.outcome='aborted';
        const {active,...record}=summary;
        // A successful empty pass is routine idle work, not a diagnostic.
        // Preserve failures, aborts, held rows and any commands even without rows.
        if(record.rows_total>0||record.command_calls>0||record.inventory_calls>0||record.outcome!=='completed')
          try {Promise.resolve(onSummary(Object.freeze(record))).catch(()=>{});}catch{/* Logging cannot fail cleanup. */}
      }
    });
  }

  // Resolve each current record that `select` picks, under its record and name
  // locks, through its own create receipt. A record held by live work in this
  // process, or by another live process, is unresolved; so is any older record.
  // The reaper holds a record's locks while it works on it. A caller that met
  // those locks would report the record as unresolved, and the next call would
  // meet them again. So a resolve waits while the reaper works on a record it
  // selects, and no new reaper row starts until the resolve is done. A record
  // the resolve does not select never makes it wait. A caller that is already
  // cancelled does not wait: resolveRows answers it at once.
  async function resolve(select,options={}) {
    resolving++;
    try {
      const inflight=reaping;
      if(inflight&&!options.signal?.aborted&&select(inflight.row)) {
        let abort;
        const aborted=new Promise(resolveAbort=>{abort=resolveAbort;options.signal?.addEventListener('abort',abort,{once:true});});
        try{await Promise.race([inflight.done,aborted]);}finally{options.signal?.removeEventListener('abort',abort);}
      }
      return await resolveRows(select,options);
    }finally{resolving--;}
  }
  async function resolveRows(select,{signal,validateRow=()=>true,allowWatching=false,entryIds}={}) {
    const result={resolved:true,rows:0,watching:0,scratch_removed:true,policy_removed:true,policy_blocked:true};
    // Why each unresolved record stayed: its sandbox name and a fixed reason.
    const failures=[];
    const fail=()=>({...result,failures,resolved:false,scratch_removed:false,policy_removed:false,policy_blocked:false});
    const keep=(row,reason)=>{unresolved=true;if(reportableName(row?.sandbox_id))failures.push({name:row.sandbox_id,failure:reason});};
    // One unresolved record never stops the others: each record is resolved, or
    // kept, on its own receipt.
    let unresolved=false;
    for(const entry of entries()) {
      if(signal?.aborted)return fail();
      const id=entry.slice(0,-5);
      if(entryIds&&!entryIds.has(id))continue;
      if(fs.lstatSync(file(id)).isSymbolicLink()){unresolved=true;continue;}
      let row;
      try{row=read(id);}catch(error){if(error.code!=='ENOENT')unresolved=true;continue;}
      // A record that is not an object cannot be selected, trusted or resolved; the others still are.
      if(!row||typeof row!=='object'){unresolved=true;continue;}
      if(foreignScope(row)||!select(row))continue;
      result.rows++;
      if(!usable(row,id)||!current(row,id)){if(usable(row,id)&&await reportOld(row,{signal,settle:true}))continue;keep(row,usable(row,id)?CLEANUP_FAILURE.OLD_RECORD:CLEANUP_FAILURE.UNSAFE_RECORD);continue;}
      if(!validateRow(row)){keep(row,CLEANUP_FAILURE.HOME_MISMATCH);continue;}
      if(leases.has(id)||owners.get(id)?.active){keep(row,CLEANUP_FAILURE.BUSY);continue;}
      let releaseRecord,releaseScope,release;
      try {
        releaseRecord=acquireProcessLockSync(file(id)+'.lock');
        if(!fs.existsSync(file(id)))continue;
        const locked=read(id);
        if(!current(locked,id)||locked.sandbox_id!==row.sandbox_id){keep(row,CLEANUP_FAILURE.RECORD_CHANGED);continue;}
        releaseScope=acquireProcessLockSync(scope(locked.sandbox_id));
        let released=false;
        release=()=>{if(released)return;released=true;releaseRecord();releaseScope();};
        leases.set(id,release);
        if(locked.watch_state==='watch_adopted') {
          if(await resolveAdoptedRow(locked,{signal}))continue;
          if(allowWatching){result.watching++;continue;}
          keep(row,CLEANUP_FAILURE.DESTROY_FAILED);continue;
        }
        const receipt=await destroy(locked,{signal});
        // A watched create keeps its record. Only the startup admission hold may pass it: any other caller (a pending attempt's
        // recovery) is asking for cessation and cleanup facts, and a watch is neither, so it stays unresolved.
        if(receipt?.removed!==true&&receipt?.watching===true&&allowWatching){result.watching++;continue;}
        if(receipt?.removed!==true){keep(row,CLEANUP_FAILURE.DESTROY_FAILED);continue;}
        result.scratch_removed&&=receipt.scratch_removed===true;
        result.policy_removed&&=receipt.policy_removed===true;
        result.policy_blocked&&=receipt.policy_removed===true||receipt.policy_blocked===true;
      }catch(error){keep(row,error?.cleanup_failure??(error?.code==='lock_busy'?CLEANUP_FAILURE.BUSY:CLEANUP_FAILURE.DESTROY_FAILED));}
      finally {
        if(leases.get(id)===release)leases.delete(id);
        if(release)release();else {releaseScope?.();releaseRecord?.();}
      }
    }
    return unresolved?fail():result;
  }
  // Owned-compute reconciliation is independent of lending admission. Current
  // records resolve through their receipts; older records retain their own debt.
  // Registrations of live sessions on this backend are exempt from cleanup.
  async function reconcileOwned({inventory,signal,validateRow=()=>true,deferredIds=new Set()}={}) {
    const unknown={removed:false,foreign:[]};
    // A hold always names its cause: a record, or else the step that failed.
    const hold=(reason,foreign=[],failures=[])=>{
      const debts=obligations().map(row=>({...row,reason:row.reason??reason}));
      const listed=remediation().remediation??[],named=failures.map(({name,failure})=>({reason,name,failure}));
      const all=[...listed,...named,...debts.filter(d=>![...listed,...named].some(r=>r.name===d.name))];
      return {...unknown,foreign,remediation:all.length?all:[{reason}]};
    };
    try {
      if(signal?.aborted)return hold('check_interrupted');
      if((await reapAbandoned(abandonedNames(),{signal}))?.removed===false)return hold('cleanup_incomplete');
      const rows=[],old=[],foreign=[],watched=[];
      // A record this version cannot trust is listed and keeps the hold, but
      // never stops the other records from being resolved.
      let unsafe=false;
      for(const entry of entries()) {
        const id=entry.slice(0,-5);
        if(deferredIds.has(id)){unsafe=true;continue;}
        let row;
        try {
          if(fs.lstatSync(file(id)).isSymbolicLink()){unsafe=true;continue;}
          row=read(id);
        }catch(error){if(error.code!=='ENOENT')unsafe=true;continue;}
        if(foreignScope(row)){foreign.push(row.sandbox_id);continue;}
        if(!usable(row,id)){unsafe=true;continue;}
        if(current(row,id)&&row.watch_state==='watch_adopted'){watched.push(row);continue;}
        if(current(row,id))rows.push(row);else old.push(row);
      }
      const unsettled=[];
      for(const row of old)if(!await reportOld(row,{signal,settle:true}))unsettled.push(row);
      old.length=0;old.push(...unsettled);
      // A watched name is looked at on every check: one that appeared is removed, and one gone for good closes on its proof.
      for(const row of [...watched])if(await resolveWatched(row,{signal,validateRow}))watched.splice(watched.indexOf(row),1);
      // Adopted/deferred names are obligations, never inventory-based cessation proof.
      // With no other targets, admission reconciliation needs no sandbox listing.
      if(!rows.length&&!old.length&&(unsafe||watched.length))return unsafe?{...hold('cleanup_deferred',foreign),watching:watched.length}:watched.length?{removed:false,foreign,watching:watched.length,...remediation()}:{removed:true,foreign};
      const names=await inventory([...rows,...old]).catch(()=>null);
      // A reservation is durable before create/run. With no records there is
      // no compute to stop, even when Docker cannot list sandboxes.
      if(!names)return rows.length||old.length||unsafe?hold('inventory_unavailable',foreign):{removed:true,foreign:[]};
      const owned=new Set([...rows,...old,...watched].map(row=>row.sandbox_id));
      const seen=[...new Set([...foreign,...names.filter(name=>/^wf-[a-f0-9]{16}$/.test(name)&&!owned.has(name))])];
      const live=new Set(rows.filter(row=>owners.get(row._cleanupId)?.active).map(row=>row._cleanupId));
      const outcome=await resolve(row=>rows.some(own=>own._cleanupId===row._cleanupId)&&!live.has(row._cleanupId),{signal,validateRow,allowWatching:true,entryIds:new Set(rows.map(row=>row._cleanupId))});
      const after=await inventory([...rows,...old]).catch(()=>null);
      const required=new Set(rows.filter(row=>!live.has(row._cleanupId)).map(row=>row.sandbox_id));
      if(!outcome.resolved||old.length||unsafe||!after||signal?.aborted||after.some(name=>required.has(name)))
        return hold(!after?'inventory_unavailable':signal?.aborted?'check_interrupted':'cleanup_incomplete',seen,outcome.failures);
      return {removed:watched.length===0&&outcome.watching===0,foreign:seen,...remediation(),...(outcome.watching||watched.length?{watching:outcome.watching+watched.length}:{})};
    }catch{return {...hold('cleanup_check_failed'),fatal:'cleanup_check_failed'};}
  }
  // Pending attempt recovery: the exact records of these jobs, each resolved
  // through its own receipt. Absent records mean nothing was ever dispatched.
  function resolveJobs(jobIds,options={}) {
    const wanted=new Set(jobIds);
    return resolve(row=>wanted.has(row?.job_id),options).then(result=>({...result,...remediation()}));
  }
  // Recovery is a set of independent obligations, not a host-wide cessation
  // proof. A busy row is never waited on or adopted. New targets still require
  // their own deadline proof at the backend's dispatch/exec boundaries.
  async function recoverDeadlines(manager,{clock=sandboxDeadlineClock,signal,validateRow=()=>true,watcher}={}) {
    // Cache ordering keys, but re-read time at action boundaries. An unreadable
    // clock is due for recovery, never permission to launch new compute.
    const remaining=row=>{try{return {left:sandboxDeadlineRemaining(row,clock()),unreadable:false};}
      catch{return {left:0,unreadable:true};}};
    const result={complete:true,rows:[]},pending=[];
    const outcome=(row,status,extra={})=>({id:row._cleanupId,...(reportableName(row.sandbox_id)?{name:row.sandbox_id}:{}),
      ...(reportableHome(row.sbx_home)?{home:row.sbx_home}:{}),status,...extra});
    const record=(row,status,extra)=>result.rows.push(outcome(row,status,extra));
    const held=row=>{
      try {
        // processLockOwners validates host/namespace and live process creation
        // identity. PID equality alone, unvalidated JSON or lock age is not proof.
        const holders=[...processLockOwners(file(row._cleanupId)+'.lock'),...processLockOwners(scope(row.sandbox_id))];
        if(holders.some(owner=>owner.pid!==process.pid))return 'foreign_locked';
        if(holders.length||leases.has(row._cleanupId)||owners.get(row._cleanupId)?.active||reaping?.row?._cleanupId===row._cleanupId)return 'in_progress';
        return null;
      }catch{return 'foreign_locked';}
    };
    const deadlineHeld=row=>{
      try{return processLockOwners(file(row._cleanupId)+'.deadline.lock').length>0;}
      catch{return true;}
    };
    const protectedByGuard=async row=>{
      if(await manager.active(row,{recovery:true}))return 'saved';
      // A guard can publish its bound state before the app saves its enforcer.
      // Ask the same live-identity/binding verifier, without adopting or writing it.
      return row.deadline_enforcer?.kind!=='guard'&&await manager.active({...row,
        deadline_enforcer:{...row.deadline_enforcer,kind:'guard'}},{recovery:true})?'published_guard':false;
    };
    let listed;
    try{listed=entries();}catch{return {...result,complete:false,fatal:'journal_unavailable'};}
    // Older guards left by earlier versions are settled before any record is recovered. A record with a guard that cannot be
    // identified stays fenced and is reported; nothing else about the recovery changes.
    const settled=await settleGuards(manager),blockedGuards=new Set((settled.blocked??[]).map(guard=>guard.id));
    // Every record with a live guard keeps it; none of them is handed to the watcher.
    const guardedIds=new Set([...(settled.adopted??[]),...(settled.blocked??[])].map(guard=>guard.id));
    for(const entry of listed) {
      signal?.throwIfAborted();
      const id=entry.slice(0,-5);let row={_cleanupId:id};
      try {
        if(fs.lstatSync(file(id)).isSymbolicLink())throw Error('Unsafe record');
        row=read(id);
        if(!row||typeof row!=='object')throw Error('Invalid record');
        if(foreignScope(row))continue;
        if(!usable(row,id))throw Error('Invalid record');
        if(row.deadline_at===undefined&&row.deadline_clock===undefined&&row.deadline_enforcer===undefined&&!(watcher&&watchEligible(row)))continue;
        if(!current(row,id)||!validSandboxDeadline(row)&&!(watcher&&watchEligible(row)&&row.deadline_at===undefined&&row.deadline_clock===undefined&&row.deadline_enforcer===undefined))throw Error('Invalid deadline record');
        if(!validateRow(row)){record(row,'failed',{reason:CLEANUP_FAILURE.HOME_MISMATCH});continue;}
        if(blockedGuards.has(id)){record(row,'foreign_locked',{reason:'guard_unidentified'});continue;}
        const busy=held(row);
        if(busy){
          // A verified live enforcer can protect a leased row without taking
          // its locks or rewriting it. Lock ownership alone is never proof.
          record(row,busy,row.deadline_enforcer&&await manager.active(row,{recovery:true})?{protected:true}:{});
          continue;
        }
        pending.push(row);
      }catch(error){if(error.code!=='ENOENT')record({_cleanupId:id,sandbox_id:row?.sandbox_id,sbx_home:row?.sbx_home},'failed',{reason:CLEANUP_FAILURE.UNSAFE_RECORD});}
    }
    const protect=async(row,{adoptOnly=false}={})=>{
      const busy=held(row);if(busy)return outcome(row,busy);
      let releaseRecord,releaseScope;
      try {
        releaseRecord=acquireProcessLockSync(file(row._cleanupId)+'.lock');
        releaseScope=acquireProcessLockSync(scope(row.sandbox_id));
        let locked=read(row._cleanupId);
        if(!current(locked,row._cleanupId)||locked.sandbox_id!==row.sandbox_id||!validateRow(locked))
          return outcome(row,'failed',{reason:CLEANUP_FAILURE.RECORD_CHANGED});
        const active=validSandboxDeadline(locked)?await protectedByGuard(locked):false;
        // A supervisor legitimately owns this lock for its lifetime. Its exact
        // payload and live identity, not merely a busy lock, prove protection.
        if(!active&&deadlineHeld(locked))return outcome(row,'foreign_locked',{reason:'deadline_lock_unverified'});
        reserveDeadlineName(locked,row._cleanupId);
        if(active==='published_guard') {
          const enforcer=await manager.register(locked,{recovery:true});
          locked={...locked,deadline_enforcer:enforcer};write(row._cleanupId,locked);
        }
        locked=retainMaterialization(locked,manager);
        // A row an earlier version handed off, whose guard is no longer running, gets a guard: its deadline is still its own, and
        // nothing else is bound to remove a sandbox that appears late. A guard that runs, or cannot be told from the row's own, is
        // kept as it is; the row's acknowledgment is not rewritten.
        let live=Boolean(active)||guardedIds.has(row._cleanupId);
        if(!live&&locked.watch_state==='watch_adopted'&&validSandboxDeadline(locked)&&locked.compute_stopped!==true) {
          const enforcer=await manager.register(locked,{recovery:true});
          locked={...locked,deadline_enforcer:enforcer};write(row._cleanupId,locked);live=true;
        }
        // A record with a guard keeps it: it is protected by that guard, not handed to the watcher.
        const guarded=keepsGuard(locked)||locked.watch_state==='watch_adopted'&&live;
        if(watcher&&watchEligible(locked)&&!guarded)
          return await adoptLocked(outcome(locked,'watching'),locked,manager,watcher);
        if(locked.watch_state==='watch_adopted'&&!guarded)return outcome(locked,'failed',{admission_released:false,reason:'watch_unavailable'});
        // A row whose sandbox may still appear is kept by its guard, which removes it at its own deadline. Recovery makes sure a
        // guard runs and leaves the removal to it; it neither hands the row to the watcher nor destroys what it cannot see.
        if(adoptOnly&&guarded&&watchEligible(locked)) {
          if(!live){const enforcer=await manager.register(locked,{recovery:true});locked={...locked,deadline_enforcer:enforcer};write(row._cleanupId,locked);}
          return outcome(locked,'watching',{protected:true});
        }
        if(adoptOnly)return null;
        if(!active) {
          // register() revalidates a published guard and returns its exact
          // enforcer, so observed()/cancel() keep the same guard binding.
          const enforcer=await manager.register(locked,{recovery:true});
          write(row._cleanupId,{...locked,deadline_enforcer:enforcer});
        }
        return outcome(row,'protected',{protected:true});
      }catch(error){
        return outcome(row,error.code==='lock_busy'?(held(row)??'foreign_locked'):'failed',{reason:'deadline_protection_failed'});
      }finally{releaseScope?.();releaseRecord?.();}
    };
    const recover=async row=>{
      const busy=held(row);if(busy)return outcome(row,busy);
      if(watcher&&watchEligible(row)&&!establishedAbsentWatch(row)) {
        const adopted=await protect(row,{adoptOnly:true});
        if(adopted)return adopted;
      }
      // Never mistake an unknown deadline owner for a live, matching guard.
      if(deadlineHeld(row)) {
        const proof=await protectedByGuard(row);
        if(!proof)return outcome(row,'foreign_locked',{reason:'deadline_lock_unverified'});
        if(proof==='published_guard') {
          // Preserve the guard binding before destroy consults observed().
          const protection=await protect(row);
          if(protection.status!=='protected')return protection;
        }
      }
      const deadline=remaining(row);
      if(deadline.unreadable) {
        const protection=await protect(row);
        if(protection.status!=='protected')return protection;
      }
      if(deadline.left>0&&row.compute_stopped!==true) {
        const protectedRow=await protect(row);
        if(protectedRow.status!=='protected')return protectedRow;
        if(remaining(row).left>0&&(row.create==='reserved'||row.compute_created===true))return protectedRow;
      }
      const nowBusy=held(row);if(nowBusy)return outcome(row,nowBusy);
      // Do not use resolve(): it waits for a same-process reaper. Filter entry
      // IDs before any I/O so a malformed sibling cannot poison this result.
      let resolved;
      resolving++;
      try {resolved=await resolveRows(candidate=>candidate._cleanupId===row._cleanupId,
        {signal,validateRow,allowWatching:true,entryIds:new Set([row._cleanupId])});}
      finally{resolving--;}

      if(!resolved.resolved) {
        const failure=resolved.failures?.[0]?.failure;
        return outcome(row,failure===CLEANUP_FAILURE.BUSY?(held(row)??'foreign_locked'):'failed',{reason:failure??CLEANUP_FAILURE.DESTROY_FAILED});
      }
      if(!resolved.rows&&fs.existsSync(file(row._cleanupId)))return outcome(row,'failed',{reason:CLEANUP_FAILURE.RECORD_CHANGED});
      if(!resolved.watching)return outcome(row,'resolved');
      const protection=await protect(row);
      return protection.status==='protected'?outcome(row,'watching',{protected:true}):protection;
    };
    const ordered=pending.map(row=>({row,left:remaining(row).left})).sort((a,b)=>a.left-b.left);
    for(const {row} of ordered) {
      signal?.throwIfAborted();
      try {result.rows.push(await recover(row));}
      catch {signal?.throwIfAborted();record(row,'failed',{reason:'deadline_recovery_failed'});}
    }
    result.complete=result.rows.every(row=>['resolved','watching','protected'].includes(row.status));
    return result;
  }
  // Read-only owner recovery check. Empty inventory cannot discharge a create
  // receipt. Unknown bindings cannot be attributed safely, so keep the hold.
  function jobsStopped(jobIds,{validateRow=()=>true}={}) {
    const wanted=new Set(jobIds);
    try {
      for(const entry of entries()) {
        const id=entry.slice(0,-5);
        if(fs.lstatSync(file(id)).isSymbolicLink())return false;
        const row=read(id);
        if(!current(row,id)||row.owner_scope!==sandboxOwnerScope()||!wanted.has(row.job_id)||!validateRow(row))return false;
        if(leases.has(id)||owners.get(id)?.active)return false;
        if(row.unknown==='creation_unproven'||row.unknown==='credential_revocation_pending')return false;
        if(row.create!=='reserved'&&row.create!=='dispatched')return false;
        if(row.create==='dispatched'&&(row.create_settled!==true||row.compute_stopped!==true))return false;
        if(row.data_cleanup!=='removed'||row.policy_cleanup!=='removed')return false;
      }
      return true;
    }catch{return false;}
  }
  // Every record the owner must see: current records with an unresolved
  // create outcome, and older records (with a command once a verified listing
  // showed the sandbox).
  function remediation() {
    const found=new Map();
    try {
      for(const entry of entries()) {
        const id=entry.slice(0,-5);
        try {
          if(fs.lstatSync(file(id)).isSymbolicLink()){found.set(id,{reason:UNSAFE_RECORD});continue;}
          const row=read(id);
          if(foreignScope(row))continue;
          if(!usable(row,id)){
            found.set(id,{reason:UNSAFE_RECORD,...(reportableName(row?.sandbox_id)?{name:row.sandbox_id}:{})});
            continue;
          }
          if(!current(row,id))found.set(id,oldFindings.get(id)??{name:row.sandbox_id,home:row.sbx_home??null,reason:OLD_RECORD});
          else if(row.watch_state==='watch_adopted') {
            // A watched name stays visible by name with its own reason: a failed revocation, a listed sandbox this install never
            // saw absent, or a create that failed with no sandbox. None of them is proven gone.
            const failure=row.watch_debt_retry?.revocation,unknown=watchedUnknown(row);
            if(row.watch_debt_retry?.policy_revoked!==true&&REVOCATION_STEPS.has(failure?.step)&&REVOCATION_ERRORS.has(failure?.error))
              found.set(id,{name:row.sandbox_id,home:row.sbx_home,reason:'credential_revocation_pending',step:failure.step,error:failure.error});
            else if(unknown)found.set(id,{name:row.sandbox_id,home:row.sbx_home,watched:true,reason:unknown,...(unknown==='present_without_receipt'?{command:removalCommand(row)}:{})});
            // A watcher whose last action on the name has stopped advancing is reported and keeps the name fenced. It is never replaced.
            else if(reportableHome(row.sbx_home)&&!goneProof(row)&&ownershipStatus(watchProofDirectory(row.sbx_home),row.sandbox_id)?.stalled===true)
              found.set(id,{name:row.sandbox_id,home:row.sbx_home,watched:true,reason:'watch_stalled'});
            continue;
          }
          else if(row.compute_stopped===true&&row.policy_cleanup!=='removed'&&REVOCATION_STEPS.has(row.revocation_step)&&REVOCATION_ERRORS.has(row.revocation_error))found.set(id,{name:row.sandbox_id,home:row.sbx_home,reason:'credential_revocation_pending',step:row.revocation_step,error:row.revocation_error});
          else if(REPORTED.has(row.unknown)&&row.compute_stopped!==true)found.set(id,{name:row.sandbox_id,home:row.sbx_home,reason:row.unknown,
            ...(row.unknown==='present_without_receipt'?{command:removalCommand(row)}:{}),
            ...(row.unknown==='credential_revocation_pending'&&REVOCATION_STEPS.has(row.revocation_step)&&REVOCATION_ERRORS.has(row.revocation_error)?
              {step:row.revocation_step,error:row.revocation_error}:{})});
        }catch(error){if(error.code!=='ENOENT')found.set(id,{reason:UNSAFE_RECORD});}
      }
    }catch{found.set('journal',{reason:'journal_unreadable'});}
    for(const [id,finding] of guardFindings)if(!found.has(id))found.set(id,finding);
    return found.size?{remediation:[...found.values()]}:{};
  }
  function status(options) { return inScan(()=>statusScan(options)); }
  function statusScan({onBlocked}={}) {
    const result={state:'clear',data_cleanup_pending:0,policy_cleanup_pending:0,policy_cleanup_blocked:0,compute_cleanup_pending:0,unknown:0,unreadable_records:0,records:0};
    let reported=0;
    try {
      for(const entry of entries()) {
        const id=entry.slice(0,-5);result.records++;
        if(registrations.has(id))continue;
        try {
          // Do not follow untrusted links or interpret malformed rows as cleanup work.
          // Count them without changing their bytes or closing unrelated admission.
          if(fs.lstatSync(file(id)).isSymbolicLink())throw Error('Unsafe cleanup record');
          const row=read(id);
          if(foreignScope(row)){(result.foreign??=[]).push(row.sandbox_id);continue;}
          if(!usable(row,id)){result.unknown++;result.unreadable_records++;continue;}
          if(!current(row,id)||(row.watch_state==='watch_adopted'?Boolean(watchedUnknown(row)):REPORTED.has(row.unknown))&&row.compute_stopped!==true)reported++;
          if(row.data_cleanup!=='removed')result.data_cleanup_pending++;
          if(row.policy_cleanup!=='removed')result.policy_cleanup_pending++;
          if(row.policy_cleanup==='blocked'){result.policy_cleanup_blocked++;onBlocked?.(row);}
          if(!row.compute_stopped)result.compute_cleanup_pending++;
          if(row.watch_state==='watch_adopted'||row.create==='dispatched'&&row.create_settled!==true&&row.compute_stopped!==true&&Number.isFinite(row.absent_since))result.create_watch=(result.create_watch??0)+1;
        }catch(error){if(error.code!=='ENOENT'){result.unknown++;result.unreadable_records++;}}
      }
    }catch{result.unknown++;}
    result.unknown+=reported;
    if(result.unknown)result.state='unknown';
    else if(result.data_cleanup_pending||result.policy_cleanup_pending>result.policy_cleanup_blocked||result.compute_cleanup_pending)result.state='pending';
    else if(result.policy_cleanup_blocked)result.state='blocked';
    const {remediation:rows}=remediation();
    if(rows)result.remediation=rows;
    return result;
  }
  // Retained deadlines can keep a guard alive even on stopped rows with cleanup debt.
  const retainedGuards=()=>{
    let count=0;
    for(const entry of entries()) {
      try{const row=read(entry.slice(0,-5));if(!foreignScope(row)&&row.deadline_at!==undefined)count++;}catch{/* An unreadable row is its own debt. */}
    }
    return count;
  };
  // Kept for callers that expose the old cap; row counts carry no global hold.
  // Changes whenever a record is added, replaced or removed (every write renames into the directory). One stat, not one read per row.
  const directoryFingerprint=()=>{try{const s=fs.statSync(directory,{bigint:true});return `${s.ino}:${s.mtimeNs}:${s.ctimeNs}`;}catch{return null;}};
  const backlogHold=()=>null; // Row count never closes machine admission.
  return {accountRun,directoryFingerprint,retiredTarget,runtimeForScratch,nameReserved,retireName,stoppedJobs,recordPolicyResidue,obligations,retainedGuards,backlogHold,writeGeneration:cleanupJournalWriteGeneration,register,mark,abandon,abandoned,wasNeverCreated,markAbandoned,authority,admissionAuthority,assertExecAllowed,adoptWatch,closed,recorded,finish,status,reconcileOwned,resolveJobs,recoverDeadlines,jobsStopped,inspectRemediation,reap(options){if(resolving&&!running)return Promise.resolve();return running??=Promise.resolve().then(()=>pass(options)).finally(()=>{running=null;});}};
}
