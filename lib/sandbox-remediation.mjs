import {sandboxCommandDiagnosticOf,bindSandboxCommandDiagnostic} from './sandbox-command-diagnostic.mjs';
// Display only: these commands never grant automatic legacy removal authority.
// Fixed step and error classes become plain sentences; the identifiers themselves are never shown.
const STEP={github_secret:"the saved GitHub access",network_policy:"the network access rules"};
const WHY={listing_failed:"it could not read the list",value_remains:"the access is still there",removal_refused:"the removal was refused",rule_remains:"one rule is still there"};
function revocationLine(row) {
  const what=STEP[row.step],why=WHY[row.error];
  return `Faravan could not confirm that a finished job's access was removed${what?`: ${what} ${why?`(${why})`:'could not be cleared'}`:''}. That sandbox stays reserved for cleanup; unrelated new jobs need their own protection.`;
}
// One plain sentence for each state a watched sandbox name can wait in, and whether the person can do anything about it.
// A plain removal command may follow the sentence; one with paths or settings is returned as `command` instead. Names the sandbox, never its folder.
const sandboxOf=row=>/^wf-[a-f0-9]{16}$/.test(row?.name??'')?`Sandbox ${row.name}`:'A sandbox';
export const WATCHED_NAME_COPY={
  // Failed or thrown revocation: Faravan retries it on its own.
  credential_revocation_pending:row=>({nothing_to_do:true,
    text:`${sandboxOf(row)} is waiting for its saved access to be removed. Faravan tries again on its own. Nothing to do.`}),
  // A failed create with no sandbox listed: Faravan keeps watching and removes it only if it appears.
  creation_unproven:row=>({nothing_to_do:true,
    text:`${sandboxOf(row)} did not start and is not listed yet. Faravan did not remove it, because there is nothing to remove, and keeps watching in case it appears. Nothing to do.`}),
  // The watcher is alive and holds the name, but it has stopped checking it. A second watcher is never started on top of it.
  watch_stalled:row=>({nothing_to_do:false,
    text:`${sandboxOf(row)} is being watched, but the watcher has stopped checking it. Faravan keeps it reserved and does not start a second watcher. If this stays, restart Faravan.`}),
  // An older cleanup helper for this sandbox is running and Faravan could not tell whether it is safe to stop. It is left running.
  guard_unidentified:row=>({nothing_to_do:false,
    text:`${sandboxOf(row)} has an older cleanup helper that Faravan could not identify, so it left that helper running and keeps the sandbox reserved. Choose Check again.`}),
  // A listed sandbox that Faravan never saw absent first: only the existing removal command can clear it. A command that
  // carries a folder, a program path or an environment setting is never part of the sentence; it is its own field.
  present_without_receipt:row=>{
    const base=`${sandboxOf(row)} is listed, and Faravan did not remove it, because it did not see it absent first.`;
    if(!row.command)return {nothing_to_do:true,text:`${base} Nothing to do.`};
    // An environment field is any shell assignment (NAME=value) or an `env` prefix, not only HOME= and XDG_.
    if(!/[\\/]|(?:^|\s)[A-Za-z_][A-Za-z0-9_]*=|^\s*env\b/.test(row.command))
      return {nothing_to_do:false,text:`${base} If this install created the job, run this command to remove it:\n${row.command}`};
    return {nothing_to_do:false,command:row.command,text:`${base} If this install created the job, its removal command is shown on the Lend screen.`};
  },
};
// Watching names while the sandbox list cannot be read: Faravan checks again on its own.
export function listingUnreadableCopy(count) {
  const names=Number.isSafeInteger(count)&&count>=0?`${count} watched sandbox ${count===1?'name':'names'}`:'watched sandbox names';
  return {nothing_to_do:true,text:`Waiting for Docker to list sandboxes, so ${names} cannot be confirmed gone yet. Faravan checks again on its own. Nothing to do.`};
}
export const watchedNameStatus=row=>WATCHED_NAME_COPY[row?.reason]?.(row)??null;
const cleanupLine=row=>`${sandboxOf(row)}${typeof row.home==='string'?' (sandbox HOME '+JSON.stringify(row.home)+')':''} ${row.compute_may_run===true?'could still be running; its name and one lending slot stay reserved':row.reason==='policy_cleanup_pending'?'still has access rules that could not be cleared':'still has cleanup left that Faravan could not verify'}. Choose Clean up now to retry.`;
const LINE={
  cleanup_deferred:cleanupLine,
  policy_cleanup_pending:cleanupLine,
  credential_revocation_pending:revocationLine,
  unsafe_record:row=>`${sandboxOf(row)} has cleanup notes Faravan could not read, so it kept them unchanged. Choose Clean up now to retry.`,
  inventory_unavailable:()=>"Faravan could not read the list of sandboxes, so it cannot confirm that earlier jobs have stopped. No new jobs start until it can. Check that Docker is running, then choose Check again.",
  cleanup_incomplete:cleanupLine,
  check_interrupted:cleanupLine,
  cleanup_check_failed:cleanupLine,
  journal_unreadable:()=>"Faravan could not read its saved cleanup notes. One slot stays reserved while other accounts can lend. Choose Clean up now to retry.",
};
// The plain words for a hold on an earlier job's sandbox. The app's raw blocker and the status.blockers answer both read these.
export const CESSATION_FIX={human:'Open Setup and choose Check again. The lending details say what Faravan could not clear.'};
export function cessationHoldMessage(remediation=[]) {
  const names=remediation.map(row=>row?.name).filter(name=>typeof name==='string');
  return 'Faravan cannot confirm that '+(names.length?'the sandbox '+names.join(', '):'a sandbox from an earlier job')+' stopped. No new jobs start until it does.';
}
export function sandboxRemediationLines(entries=[]) {
  // Several records can share one reason; the owner reads each sentence once.
  return [...new Set(entries.map(row=>{
    // A name Faravan is still waiting on says what it waits for and whether anything is left to do.
    if(row.reason==='credential_revocation_pending')return `${LINE.credential_revocation_pending(row)} ${watchedNameStatus(row).text}`;
    if(WATCHED_NAME_COPY[row.reason])return watchedNameStatus(row).text;
    if(!row.command&&LINE[row.reason])return LINE[row.reason](row);
    if(!row.name)return 'A cleanup record still needs attention. Choose Clean up now to retry.';
    return row.command?`${row.name}${typeof row.home==='string'?' (sandbox HOME '+JSON.stringify(row.home)+')':''}: ${row.command}
Run it only if this install created the job.`:`${row.name}${typeof row.home==='string'?' (sandbox HOME '+JSON.stringify(row.home)+')':''}: Faravan did not remove it, because it could not prove that this install created it.`;
  }))];
}
// The removal commands that a per-name sentence leaves out because they carry paths or settings. A screen that may show a
// copyable command shows these on their own, never inside the status label.
export const sandboxRemovalCommands=(entries=[])=>[...new Set(entries.map(row=>watchedNameStatus(row)?.command).filter(command=>typeof command==='string'&&command.length>0))];

// Recovery diagnostics are a fixed vocabulary. Never copy executor text, paths,
// sandbox names or arbitrary error codes into status, blockers or probe history.
const DEADLINE_ERROR_CODES = new Set([
  'EACCES', 'EPERM', 'ENOENT', 'EIO', 'EROFS', 'ENOSPC', 'EMFILE', 'ENFILE',
  'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ABORT_ERR',
  'cessation_unverified', 'sandbox_start_failed', 'sandbox_deadline_invalid',
  'sandbox_deadline_unavailable', 'sandbox_deadline_expired', 'lock_busy',
  'sbx_daemon_unavailable', 'sbx_daemon_start_failed', 'daemon_owner_repair_required', 'docker_signin_refresh_unavailable',
  'host_not_awake', 'recovery_incomplete', 'recovery_pending', 'inventory_unavailable', 'unknown',
]);
const RECOVERY_HOLDS = new WeakSet();
const HOST_ASLEEP_MAC = 'Your Mac is asleep (lid closed). Open it to lend.';
const HOST_ASLEEP_OTHER = 'This computer is asleep. Wake it to lend.';
const safeField = (value, key) => { try { return value?.[key]; } catch { return undefined; } };
const hostNotAwake = error => [typeof error === 'string' ? error : null, safeField(error, 'message'), safeField(error, 'stderr')]
  .some(text => typeof text === 'string' && text.toLowerCase().includes('the host is not fully awake'));

// Status serves while the initial global availability check holds admission.
const PENDING_CAUSE = 'deadline_recovery_pending';
const PENDING_HOLD = Object.freeze({cause_code: PENDING_CAUSE, error_code: 'recovery_pending', row_count: null,
  message: 'Checking for sandboxes left from last time. Lending starts when this finishes.',
  fix: Object.freeze({human: 'Nothing to do. This finishes by itself.'})});
RECOVERY_HOLDS.add(PENDING_HOLD);
export const deadlineRecoveryPendingHold = () => PENDING_HOLD;

// Compatibility metadata for older readers; this count never closes admission.
export const GUARD_CAP = 16;
const BACKLOG_CAUSE = 'cleanup_backlog';
export function cleanupBacklogHold(count) {
  const rows = Number.isSafeInteger(count) && count >= 0 ? count : null;
  const hold = Object.freeze({cause_code: BACKLOG_CAUSE, error_code: 'recovery_incomplete', row_count: rows,
    message: `Faravan is still cleaning up ${rows ?? 'several'} sandboxes. Their names stay reserved; unrelated accounts can keep lending.`,
    fix: Object.freeze({op:'cleanup.retry',input:{},human:'Clean up now'})});
  RECOVERY_HOLDS.add(hold);
  return hold;
}

/** Trusted host management output only; callers never pass guest streams. */
export function daemonRestartNeeded(result, {source}={}) {
  const text = (typeof result === 'string' ? result : [safeField(result,'stdout'),safeField(result,'stderr')].filter(v=>typeof v==='string').join('\n')).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  if(['policy','ls'].includes(source)&&/^warning: Docker Sandboxes has been updated and needs to restart; all running sandboxes will be stopped\s*$/m.test(text))return true;
  const versions = /^\s*Client Version:\s*v?(\d+\.\d+\.\d+)[^\r\n]*\r?\n[ \t]*Server Version:\s*v?(\d+\.\d+\.\d+)/im.exec(text)
    ?? /^[ \t]*(?:[!✗]\s+)?Version match\s*[—:-]\s*CLI\s+v?(\d+\.\d+\.\d+)\s*(?:≠|!=)\s*daemon\s+v?(\d+\.\d+\.\d+)/im.exec(text);
  return !!versions && versions[1] !== versions[2];
}

export const SANDBOX_SERVICE_FIX=Object.freeze({human:'Open Setup and choose Check again.'});
// Executor output is untrusted. Preserve only a bounded prefix made entirely
// from ordinary service-diagnostic words; stop before tokens, URLs or paths.
const SERVICE_WORDS=new Set('503 service unavailable docker login signed in to the host is not fully awake session sandbox listing failed error cannot connect connection refused timed out timeout daemon desktop response http unexpected eof'.split(' '));
export function safeSandboxListingDetail(value) {
  if(typeof value!=='string')return '';
  const first=value.split(/[\r\n]/,1)[0];
  if(first.length>4096)return '';
  const kept=[];
  for(const word of first.trim().split(/\s+/)) {
    if(!/^[A-Za-z0-9:,.()-]+$/.test(word)||!SERVICE_WORDS.has(word.replace(/[:,.()-]/g,'').toLowerCase()))break;
    kept.push(word);
  }
  return kept.join(' ').slice(0,240);
}
export function sandboxServiceUnavailableHold(result,{rowCount,retryAt}={}) {
  const restart=daemonRestartNeeded(result,{source:'ls'});
  const detail=safeSandboxListingDetail(typeof result==='string'?result:safeField(result,'stderr')||safeField(result,'message')||safeField(result,'stdout'));
  const count=Number.isSafeInteger(rowCount)&&rowCount>=0?rowCount:null;
  const retrying=!restart&&Number.isSafeInteger(retryAt)&&
    (safeField(result,'timedOut')===true||sandboxCommandDiagnosticOf(result)?.timedOut===true);
  const fix=retrying?Object.freeze({human:'Faravan will check again'}):restart?Object.freeze({human:'Restart Docker Sandboxes'}):/\bnot signed in\b/i.test(detail)?Object.freeze({op:'signin.start',input:Object.freeze({target:'docker'}),human:'Sign in to Docker'}):SANDBOX_SERVICE_FIX;
  const hold=Object.freeze({cause_code:'deadline_recovery_failed',error_code:'sbx_daemon_unavailable',row_count:count,
    ...(restart?{cause:'daemon_restart_required'}:{}),
    ...(retrying?{retry_at_ms:retryAt}:{}),
    message:(retrying?'The sandbox listing did not respond in time. ':restart?'Docker Sandboxes needs to restart to finish its update. Cleanup waits for a complete sandbox listing. ':'The sandbox service is unavailable. Cleanup waits for a complete sandbox listing. ')+fix.human+(fix.human.endsWith('.')?'':'.')+(detail?' Detail: '+detail:''),
    ...(detail?{detail}:{}),fix});
  RECOVERY_HOLDS.add(hold);return bindSandboxCommandDiagnostic(hold,sandboxCommandDiagnosticOf(result));
}

export function deadlineRecoveryHold(error, {rowCount, platformName} = {}) {
  const nested = safeField(error, 'recovery_hold');
  if(safeField(nested??error,'error_code')==='sbx_daemon_unavailable') {
    const known=nested??error;
    return RECOVERY_HOLDS.has(known)?known:sandboxServiceUnavailableHold(safeField(known,'detail'),{rowCount:rowCount??safeField(known,'row_count')});
  }
  // A backlog hold keeps its own words, rebuilt from its validated count.
  if (safeField(error, 'cause_code') === BACKLOG_CAUSE || safeField(nested, 'cause_code') === BACKLOG_CAUSE)
    return cleanupBacklogHold(safeField(nested ?? error, 'row_count'));
  // A pending hold keeps its own words when a probe error or a saved copy carries it.
  if (safeField(error, 'cause_code') === PENDING_CAUSE || safeField(nested, 'cause_code') === PENDING_CAUSE) return PENDING_HOLD;
  const asleep = hostNotAwake(error) || safeField(error, 'cause_code') === 'host_not_awake'
    || safeField(nested, 'cause_code') === 'host_not_awake' || safeField(error, 'code') === 'host_not_awake';
  const supplied = safeField(error, 'error_code') ?? safeField(nested, 'error_code') ?? safeField(error, 'status') ?? safeField(error, 'errorCode') ?? safeField(error, 'code');
  const errorCode = asleep ? 'host_not_awake' : error === false ? 'recovery_incomplete'
    : DEADLINE_ERROR_CODES.has(supplied) ? supplied : 'unknown';
  const count = Number.isSafeInteger(rowCount) && rowCount >= 0 ? rowCount : null;
  const countMessage = count === null ? '' : ` Saved cleanup records still awaiting confirmation: ${count}.`;
  const previousMessage = safeField(nested ?? error, 'message');
  const platform = platformName ?? (typeof previousMessage === 'string' && previousMessage.startsWith(HOST_ASLEEP_MAC) ? 'darwin'
    : typeof previousMessage === 'string' && previousMessage.startsWith(HOST_ASLEEP_OTHER) ? 'other' : process.platform);
  const message = (asleep ? (platform === 'darwin' ? HOST_ASLEEP_MAC : HOST_ASLEEP_OTHER) + ' ' : '')
    + 'Faravan could not restore sandbox deadlines. No new jobs start until recovery succeeds.' + countMessage;
  const hold = Object.freeze({cause_code: asleep ? 'host_not_awake' : 'deadline_recovery_failed',
    error_code: errorCode, row_count: count, message, fix: Object.freeze({...CESSATION_FIX})});
  RECOVERY_HOLDS.add(hold);
  return hold;
}

export function deadlineRecoveryError(hold, {cause} = {}) {
  // Preserve only helper-created messages. Reconstitute untrusted/copied holds
  // from their fixed classes and validated count instead of echoing their text.
  const safe = hold && RECOVERY_HOLDS.has(hold) ? hold : deadlineRecoveryHold(hold, {
    rowCount: safeField(hold, 'row_count'),
    platformName: typeof safeField(hold, 'message') === 'string' && safeField(hold, 'message').startsWith(HOST_ASLEEP_MAC) ? 'darwin' : process.platform,
  });
  return Object.assign(new Error(safe.message, cause === undefined ? undefined : {cause}), {
    code: 'cessation_unverified', probe_failure: 'cessation_unverified', retryable: true,
    recovery_hold: safe, fix: safe.fix,
  });
}

const DEADLINE_ROW_STATES=new Set(['resolved','watching','protected','in_progress','foreign_locked','failed']);
const DEADLINE_ROW_REASONS=new Set(['busy','home_mismatch','destroy_failed','storage_release_failed','record_changed',
  'old_record','unsafe_record','deadline_lock_unverified','deadline_protection_failed','deadline_recovery_failed']);
// Per-target recovery debt is not a global admission hold or a cessation proof.
// Only fixed reasons and validated record/name identifiers reach app status.
export function deadlineRecoveryStatus(report,hold=null) {
  const reported=Array.isArray(report?.rows)?report.rows:[];
  // Older records without a deadline are tracked by owned reconciliation.
  // They remain visible debt even when deadline recovery has no matching row.
  const combined=[...reported];
  for(const row of Array.isArray(report?.debt)?report.debt:[]) {
    if(!combined.some(known=>row?.id&&row.id===known?.id||row?.name&&row.name===known?.name&&row.home===known?.home))combined.push(row);
  }
  const rows=combined.map(row=>{
    const status=DEADLINE_ROW_STATES.has(row?.status)?row.status:'failed';
    return {...(typeof row?.id==='string'&&/^[a-f0-9-]{36}$/.test(row.id)?{id:row.id}:{}),
      ...(typeof row?.name==='string'&&/^wf-[a-f0-9]{16}$/.test(row.name)?{name:row.name}:{}),status,
      protected:['protected','watching'].includes(status)&&row?.protected===true,
      ...(row?.reason!==undefined?{reason:DEADLINE_ROW_REASONS.has(row.reason)?row.reason:'deadline_recovery_failed'}:{})};
  });
  const debt=rows.filter(row=>!(row.status==='resolved'||['protected','watching'].includes(row.status)&&row.protected));
  const count=debt.length,unreadable=debt.filter(row=>row.reason==='unsafe_record').length;
  return {state:hold?'held':count?'partial':'clear',complete:!hold&&report?.complete!==false&&count===0,
    rows,debt,debt_count:count,unreadable_records:unreadable,
    ...(unreadable?{unreadable_message:unreadable===1?'1 cleanup record could not be read':`${unreadable} cleanup records could not be read`}:{}),
    ...(count?{message:`Deadline recovery is still unresolved for ${count} earlier sandbox record${count===1?'':'s'}. Unrelated new jobs require their own deadline protection.`}:{}),
    ...(hold?{recovery_hold:hold}:{})};
}
