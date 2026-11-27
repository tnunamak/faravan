// Private to this home. No coordinator client or borrower projection belongs here.
import { RUNTIME_HELP } from './lending-status-copy.mjs';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { classify, FAILURE_CODES } from './failures.mjs';
import { createJobMetaStore, cleanTitle } from './job-meta.mjs';

const MAX_BYTES=1024*1024;
const codes=new Set(FAILURE_CODES);
const phases=new Set(['before_claim','before_start','prepare','start','run','result']);
// Plain-language sentence for each code: written here, never taken from the error's own text.
const CODE_COPY=Object.freeze({
  guard_runtime_unavailable:RUNTIME_HELP,
  isolation_check_failed:'The sandbox could reach a forbidden network or read an agent sign-in. Lending is paused. Check Docker Sandboxes, then resume lending.',
  isolation_check_inconclusive:'The sandbox isolation check could not finish. This job is open for other computers.',

  internal_error:'Something went wrong on this computer.',
  no_current_job:'No job was running when the action arrived.',
  agent_signed_out:'The agent is signed out. Sign in again on the Lend page.',
  agent_not_ready:'The agent is not ready on this computer.',
  not_signed_in:'The agent is not signed in.',
  sandbox_not_ready:'The protected workspace (Docker Sandboxes) was not ready.',
  sandbox_start_failed:'The protected workspace could not start.',
  sandbox_credential_store_failed:'Docker Sandboxes could not read its saved Docker sign-in.',
  sandbox_ready_timeout:'The protected workspace took too long to get ready.',
  prepare_failed:'This computer could not set up the job before it started.',
  agent_exit_nonzero:'The agent ended with an error.',
  agent_group_not_ceased:'The agent exited, but a process it started was still running.',
  agent_run_failed:'The agent stopped before the run could finish.',
  entrypoint_start_failed:'The agent could not be started.',
  readiness_changed:'The agent stopped being ready after the job was accepted.',
  protection_not_ready:'The sandbox protections could not be confirmed.',
  policy_unenforceable:'The job asked for limits this computer cannot enforce.',
  limits_unenforceable:'The job asked for limits this computer cannot enforce.',
  stopped_by_lender:'You stopped this job.',
  paused:'Lending was paused.',
  approval_denied:'You said no to this job.',
  approval_skipped:'You left this job for later.',
  approval_timeout:'Nobody answered in time, so the job was left for someone else.',
  approval_expired:'The approval ran out before the job started.',
  daily_limit:'Your daily limit was reached.',
  requester_limit:'This person reached the limit you set for them.',
  quota_reserve:'Lending stopped to keep your own allowance in reserve.',
  model_not_lendable:'This job asked for a model this computer cannot lend.',
  quota_unknown:'Your remaining allowance could not be read.',
  outside_hours:'It was outside your lending hours.',
  user_active:'You were using the agent, so lending stepped aside.',
  native_attempt_in_flight:"Waiting for your last job's usage to show up in your allowance.",
  window_not_open:"Your allowance window hasn't started yet.",
  lending_window_invalid:'This account reported an invalid limit window; lending is paused until a valid reply arrives.',
  lending_window_missing:'This account stopped reporting its five-hour limit; lending resumes after one full five-hour window.',
  lending_window_memory_unreadable:'Could not read which limits this account reports; lending is paused until the file is readable.',
  lending_busy:'This computer was already running another job.',
  wall_timeout:'The job ran past its time limit and was stopped.',
  execution_failed:'The agent stopped with an error.',
  agent_error:'The agent stopped with an error.',
  output_too_large:'The result was larger than the job allowed.',
  tests_failed:'The job finished but its checks failed.',
  lease_expired:'Contact with the server was lost, so this computer stopped working on the job.',
  lease_expired_unproven:'Contact with the server was lost. Faravan could not confirm that the job stopped on this computer. Check Docker Sandboxes.',
  lease_uncertain:'Contact with the server was lost; it is not known whether the job finished.',
  network_error:'The network failed while this computer was talking to the server.',
  rate_limited:'The circle server is limiting requests from this computer. Faravan will try again.',
  sandbox_crash:'The protected workspace stopped unexpectedly.',
  restart_interrupted:'Faravan restarted while the job was running.',
  cessation_unverified:'Faravan could not confirm that the job stopped. Check Docker Sandboxes.',
  sandbox_cleanup_unverified:'Sandbox cleanup records are incomplete or do not match this job. The hold stays open.',
  cleanup_check_failed:'Faravan could not verify sandbox cleanup. Choose Clean up now to retry.',
  cleanup_snapshot_misuse:'Faravan could not check sandbox cleanup because of an internal error. Check lending details.',
  sandbox_inventory_incomplete:'Docker returned an incomplete list of sandboxes. Faravan cannot confirm that earlier jobs stopped.',
  resume_pending:'Lending is still preparing to resume.',
  candidate_missing:'The agent produced no result files.',
  candidate_invalid:'The agent produced a result Faravan could not read.',
  result_not_delivered:'The result could not be delivered to the server.',
  completion_unknown:'It is not known whether the server received the result.',
  execution_observation_failed:'The agent started, but the server did not confirm it. Check the job status before you retry.',
  history_write_failed:'Faravan could not save a usage history note for an account. Lending is not affected.',
});
const KEY_COPY=Object.freeze({
  lender_setup:'Something on this computer needs setup before it can lend.',
  lender_stop:'Lending stopped this job because of a limit or a choice you made.',
  platform:'The job was interrupted by something outside the agent. Faravan handed it back.',
  job:'The job failed while the agent was running.',
  request:'The request could not be run on this computer.',
  result_delivery:'The job ran, but its result could not be delivered.',
});
const GENERIC_COPY='The job failed. The exact cause is not shown here because it can contain private details.';
/** The sentence shown for a code. Never built from raw error text. */
export function messageForCode(code,phase) {
  if(typeof code==='string'&&Object.hasOwn(CODE_COPY,code))return CODE_COPY[code];
  const key=classify(code,phase).lender_key?.split('.')[1];
  return key&&Object.hasOwn(KEY_COPY,key)&&codes.has(code)?KEY_COPY[key]:GENERIC_COPY;
}
const digest=/^sha256:[0-9a-f]{64}$/;

/** Read only a bounded tail, ignoring a partial first line and malformed records.
 * Unstructured exception text can contain arbitrary credentials. Do not attempt
 * a blacklist: the copyable details allow-list never includes raw message text,
 * only the fixed sentence for the code (messageForCode).
 * Reading never rewrites the log or changes its private 0600 permissions.
 */
export async function readLendingLog(directory) {
  let handle;
  try {handle=await open(join(directory,'lending-errors.jsonl'),constants.O_RDONLY|constants.O_NOFOLLOW);}
  catch(error){if(error.code==='ENOENT')return [];throw error;}
  let text;
  try {
    const info=await handle.stat();
    if(!info.isFile())return [];
    const start=Math.max(0,info.size-MAX_BYTES),bytes=Buffer.alloc(Math.min(info.size,MAX_BYTES));
    const {bytesRead}=await handle.read(bytes,0,bytes.length,start);
    text=bytes.subarray(0,bytesRead).toString('utf8');
    if(start)text=text.slice(text.indexOf('\n')+1);
  } finally {await handle.close();}
  const rows=[];
  for(const line of text.split('\n')) {
    let row;try {row=JSON.parse(line);}catch{continue;}
    if(!row||typeof row!=='object'||Array.isArray(row)||
       typeof row.at!=='string'||!Number.isFinite(Date.parse(row.at)))continue;
    rows.push(row);
  }
  const meta=createJobMetaStore(directory);
  return Promise.all(rows.slice(-50).reverse().map(async row=>{
    const job=typeof row.job==='string'&&digest.test(row.job)?row.job:null;
    const code=codes.has(row.code)?row.code:null;
    const phase=phases.has(row.phase)?row.phase:null;
    let title=null;
    if(job) {
      try {title=cleanTitle((await meta.get(job))?.title)||null;}catch{/* A damaged title file must not hide diagnostics. */}
    }
    const message=row.code==='hold_release_requested'
      ? 'You requested full-charge hold recovery for '+String(row.attemptId??'an unknown run')+'. Reset protection still applies.'
      : messageForCode(code,phase);
    // error_id is the short display form; correlation_id is the full `<job>-<ref>` ID, null on rows written before refs.
    const ref=typeof row.ref==='string'&&/^[A-Z2-7]{6}$/.test(row.ref)?row.ref:null;
    return {at:new Date(row.at).toISOString(),job,title,code,phase,message,
      error_id:classify(code,phase,job).error_id,correlation_id:job&&ref?job+'-'+ref:null,
      lender_key:classify(code,phase).lender_key,
      details:JSON.stringify({code,phase,message})};
  }));
}
