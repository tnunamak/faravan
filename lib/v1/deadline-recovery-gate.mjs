import {deadlineRecoveryHold,deadlineRecoveryError,deadlineRecoveryStatus,deadlineRecoveryPendingHold} from '../sandbox-remediation.mjs';

const ROW_STATES=new Set(['resolved','watching','protected','in_progress','foreign_locked','failed']);
const validReport=report=>report&&typeof report==='object'&&!report.fatal&&typeof report.complete==='boolean'&&
  Array.isArray(report.rows)&&report.rows.every(row=>row&&typeof row.id==='string'&&ROW_STATES.has(row.status))&&
  report.complete===report.rows.every(row=>row.status==='resolved'||['watching','protected'].includes(row.status)&&row.protected===true);

// App lifecycle only. This never changes a cleanup record or supplies cessation
// evidence. The backend is the authority for whether recovery succeeded.
export function createDeadlineRecoveryGate({backend,signal,platformName=process.platform,onChange=()=>{}}) {
  let held=null,pending=null,report=null,starting=false,admissionStart=null;
  function current() {
    // Admission waits for global availability, independently of per-row recovery.
    if(starting)return deadlineRecoveryPendingHold();
    try{return backend.deadlineRecoveryHold?.()??held;}
    catch(error){return capture(error);}
  }
  function capture(error) {
    if(error?.recovery_scope==='target')return current();
    let backendHold;try{backendHold=backend.deadlineRecoveryHold?.();}catch{}
    let rowCount=backendHold?.row_count??error?.recovery_hold?.row_count;
    if(rowCount==null)try {rowCount=backend.cleanupStatus?.().compute_cleanup_pending??rowCount;}catch{}
    const next=backendHold??deadlineRecoveryHold(error,{rowCount,platformName});
    if(!['sbx_daemon_unavailable','daemon_owner_repair_required'].includes(next.error_code)){held=null;return null;}
    const changed=JSON.stringify(held)!==JSON.stringify(next);
    held=next;
    if(changed)try{Promise.resolve(onChange(next)).catch(()=>{});}catch{}
    return next;
  }
  function status() {
    try{report=(backend.cleanupDisplayField?backend.cleanupDisplayField('deadline_recovery'):(backend.cleanupStatusForDisplay?.()??backend.cleanupStatus?.())?.deadline_recovery)??report;}catch(error){capture(error);}
    return deadlineRecoveryStatus(report,current());
  }
  function assertReady() {
    const hold=current();
    if(hold)throw deadlineRecoveryError(hold);
  }
  // Close admission before listening, then release it after the availability
  // check. Keep the full recovery promise under the app lifecycle.
  function begin() {
    starting=true;
    if(typeof backend.ensureSandboxAdmission==='function'){
      admissionStart=admit();
      return admissionStart.then(ready=>ready?retry():false);
    }
    return admissionStart=retry();
  }
  function waitForAdmission() { return admissionStart??Promise.resolve(true); }
  async function admit({force=false}={}) {
    if(typeof backend.ensureSandboxAdmission!=='function')return retry({force});
    try {
      signal?.throwIfAborted();await backend.ensureSandboxAdmission({signal,force});
      const hold=backend.deadlineRecoveryHold?.();if(hold)throw deadlineRecoveryError(hold);
      const changed=starting||held!==null;starting=false;held=null;
      if(changed)try{Promise.resolve(onChange(null)).catch(()=>{});}catch{}
      return true;
    }catch(error){starting=false;if(signal?.aborted)throw error;capture(error);return false;}
  }
  function retry({force=false}={}) {
    if(pending)return pending;
    pending=Promise.resolve().then(async()=>{
      signal?.throwIfAborted();
      const result=typeof backend.recoverSandboxDeadlines==='function'?await backend.recoverSandboxDeadlines({signal,force}):true;
      if(result!==true&&!validReport(result))throw Object.assign(new Error('Deadline recovery could not run.'),{code:'recovery_incomplete'});
      // A partial per-row report is a completed recovery pass, not permission
      // to reuse its blocked targets and not proof those sandboxes stopped.
      const nextReport=result&&typeof result==='object'?result:null;
      const backendHold=backend.deadlineRecoveryHold?.();
      if(backendHold)throw deadlineRecoveryError(backendHold);
      signal?.throwIfAborted();
      const changed=starting||held!==null||JSON.stringify(deadlineRecoveryStatus(report))!==JSON.stringify(deadlineRecoveryStatus(nextReport));
      report=nextReport;
      held=null;starting=false;
      if(changed)try{Promise.resolve(onChange(null)).catch(()=>{});}catch{}
      return true;
    }).catch(error=>{
      starting=false;
      if(signal?.aborted)throw error;
      capture(error);return false;
    }).finally(()=>{pending=null;});
    return pending;
  }
  function wrapProbe(runner) {
    const wrapped=async(...args)=>{
      assertReady();
      try{return await runner(...args);}catch(error){
        if(error?.recovery_scope==='target')throw error;
        if(error?.code==='cessation_unverified'||error?.probe_failure==='cessation_unverified')
          throw Object.assign(deadlineRecoveryError(capture(error)??deadlineRecoveryHold(error),{cause:error}),{recovery_scope:backend.deadlineRecoveryHold?.()?'global':'target'});
        throw error;
      }
    };
    if(typeof runner.isQueued==='function')wrapped.isQueued=(...args)=>runner.isQueued(...args);
    return wrapped;
  }
  return {begin,retry,admit,waitForAdmission,current,status,assertReady,capture,wrapProbe};
}
