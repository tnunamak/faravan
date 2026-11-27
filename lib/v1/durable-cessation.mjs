// Whether every sandbox this computer lent is proven gone, read from the durable lender counters.
// After a restart with lending off, paused, or still resuming there is no in-memory lender, and a lender that has not
// loaded its counters yet reports nothing pending. The counters file is the record that survives a crash, so Quit asks it.

/** True when a scoped pending record carries a removal proof bound to its attempt, job and generation. */
export function pendingProven(pending) {
  const proof=pending?.cessationVerified;
  return Boolean(pending?.owner_scope)&&Boolean(pending.sbx_home)&&Boolean(proof)&&proof.sbx_home===pending.sbx_home&&pending.attempt?.attempt_id===pending.attemptId&&proof.attemptId===pending.attemptId&&
    proof.jobDigest===pending.attempt.job_digest&&proof.generation===pending.attempt.generation;
}

/**
 * Every recorded pending attempt: the single-lender `pending`, plus one per account when a lending pool
 * keeps per-account journals (root `pending` then mirrors only the first account that has one).
 */
export function pendingAttempts(counters) {
  const all=[counters?.pending,...Object.values(counters?.accounts??{}).map(account=>account?.pending)].filter(Boolean);
  const seen=new Set();
  return all.filter(pending=>{const key=typeof pending.attemptId==='string'?pending.attemptId:pending;if(seen.has(key))return false;seen.add(key);return true;});
}

/**
 * @param {{store:{get():Promise<object|null>}, backend:object, lender?:object|null, signal?:AbortSignal}} input
 *   lender: a lender (or lending pool) whose loop is still running. It owns recovery and the counters; this only reads them then.
 *   Without one, the backend is asked about each recorded attempt (cleanup only, never a claim), and nothing is written:
 *   the next lender that starts finds the same records and does its own, idempotent, recovery and reporting.
 *   Proven only when every recorded attempt is proven gone.
 * @returns {Promise<{proven:boolean, attemptId:string|null, reason?:string}>}
 */
export async function proveDurableCessation({store,backend,lender=null,signal}) {
  let counters;
  try {counters=await store.get();}catch{return {proven:false,attemptId:null,reason:'counters_unreadable'};}
  const open=pendingAttempts(counters).filter(pending=>!pendingProven(pending)||backend?.isSandboxHomeCurrent?.(pending.sbx_home)===false);
  if(lender) {
    const live=lender.cessation();
    if(!live.proven)return {proven:false,attemptId:live.attemptId??null,reason:'lender_recovering'};
    return open.length?{proven:false,attemptId:open[0].attemptId??null,reason:'lender_recovering'}:{proven:true,attemptId:null};
  }
  if(!open.length)return {proven:true,attemptId:null};
  let first=null;
  for(const pending of open) {
    const attemptId=typeof pending.attemptId==='string'?pending.attemptId:null;
    if(!attemptId||typeof backend?.reconcilePending!=='function')return {proven:false,attemptId,reason:'cessation_unverified'};
    let proof;
    // A throw is an unknown inventory (for example an unreadable sandbox listing): not proof.
    try {proof=await backend.reconcilePending(structuredClone(pending),{signal,sourceDirectory:store.directory});}catch{return {proven:false,attemptId,reason:'inventory_unknown'};}
    if(proof?.removed!==true||proof.attemptId!==attemptId||backend.isSandboxHomeCurrent?.(proof.sbx_home)===false||pending.owner_scope&&typeof backend.isSandboxHomeCurrent==='function'&&proof.sbx_home!==pending.sbx_home)return {proven:false,attemptId,reason:'cessation_unverified'};
    first??=attemptId;
  }
  return {proven:true,attemptId:first};
}
